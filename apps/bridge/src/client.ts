/**
 * Resilient WebSocket client for the T3 Code server.
 *
 * Improvements over the base orchestrator-v2 client:
 *   - Auto-reconnect with exponential backoff
 *   - Connection state tracking
 *   - Typed event subscriptions
 *   - Graceful shutdown via AbortSignal
 *
 * Protocol (matches apps/server/src/wsServer.ts):
 *   Request:  { id, body: { _tag: "<method>", ...params } }
 *   Response: { id, result?, error? }
 *   Push:     { type: "push", sequence, channel, data }
 */

import WebSocket from "ws";
import type {
  DiffResult,
  DomainEvent,
  EventCallback,
  Logger,
  ServerConfig,
  Snapshot,
  T3Client,
  Unsubscribe,
} from "./types.ts";

const DOMAIN_EVENT_CHANNEL = "orchestration.domainEvent";
const RPC_TIMEOUT_MS = 60_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_JITTER = 0.3;
/** How often to send WebSocket pings to detect dead connections. */
const PING_INTERVAL_MS = 30_000;
/** If no pong arrives within this window after a ping, consider the connection dead. */
const PONG_TIMEOUT_MS = 10_000;

interface PendingRequest {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ResilientT3Client implements T3Client {
  private ws: WebSocket | null = null;
  private counter = 0;
  private pending = new Map<string, PendingRequest>();
  private listeners: EventCallback[] = [];
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;
  private _connected = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly url: string,
    private readonly log: Logger,
    private readonly signal?: AbortSignal,
  ) {}

  get connected(): boolean {
    return this._connected;
  }

  // ── Connection ────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    this.intentionalClose = false;
    return this.doConnect();
  }

  async disconnect(): Promise<void> {
    this.intentionalClose = true;
    this.cancelReconnect();
    this.stopPing();
    this.rejectAll(new Error("Disconnecting"));
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this._connected = false;
    this.log.info("[Client] Disconnected");
  }

  // ── Orchestration API ─────────────────────────────────────────────────

  async getSnapshot(): Promise<Snapshot> {
    return this.rpc<Snapshot>("orchestration.getSnapshot");
  }

  async getServerConfig(): Promise<ServerConfig> {
    return this.rpc<ServerConfig>("server.getConfig");
  }

  async dispatchCommand(command: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.rpc("orchestration.dispatchCommand", { command });
  }

  async getFullThreadDiff(threadId: string, toTurnCount: number): Promise<DiffResult> {
    return this.rpc<DiffResult>("orchestration.getFullThreadDiff", { threadId, toTurnCount });
  }

  // ── Event Subscription ────────────────────────────────────────────────

  onDomainEvent(cb: EventCallback): Unsubscribe {
    this.listeners.push(cb);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb);
    };
  }

  // ── Internal: Connection ──────────────────────────────────────────────

  private doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.signal?.aborted) {
        reject(new Error("Aborted"));
        return;
      }

      // URL is fully constructed by main.ts (including /ws path and wsToken query)
      const ws = new WebSocket(this.url);

      ws.on("open", () => {
        this.ws = ws;
        this._connected = true;
        this.reconnectAttempt = 0;
        this.log.info(`[Client] Connected to ${this.url}`);
        this.startPing(ws);
        resolve();
      });

      ws.on("message", (raw) => this.handleMessage(raw));

      ws.on("pong", () => {
        // Connection is alive — cancel the pong deadline
        if (this.pongTimer) {
          clearTimeout(this.pongTimer);
          this.pongTimer = null;
        }
      });

      ws.on("close", (code, reason) => {
        const wasConnected = this._connected;
        this._connected = false;
        this.ws = null;
        this.stopPing();

        if (this.intentionalClose) return;

        if (wasConnected) {
          this.log.warn(`[Client] Connection lost (code=${code})`, {
            reason: reason.toString(),
          });
        }

        this.scheduleReconnect();
      });

      ws.on("error", (err: Error & { code?: string }) => {
        // Extract a useful message — ws ErrorEvent stringifies to "[object ErrorEvent]"
        const detail = err.message || err.code || "unknown error";
        if (!this._connected) {
          this.log.error(`[Client] Connection failed: ${detail}`);
          reject(new Error(`WebSocket connection to ${this.url} failed: ${detail}`));
        }
        // For established connections, the 'close' handler will fire next
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.intentionalClose || this.signal?.aborted) return;

    this.reconnectAttempt++;
    const base = Math.min(RECONNECT_BASE_MS * 2 ** (this.reconnectAttempt - 1), RECONNECT_MAX_MS);
    const jitter = base * RECONNECT_JITTER * (Math.random() * 2 - 1);
    const delay = Math.round(base + jitter);

    this.log.info(`[Client] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})...`);

    this.reconnectTimer = setTimeout(() => {
      this.doConnect().catch(() => {
        // doConnect failure will trigger another close → scheduleReconnect
      });
    }, delay);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ── Internal: Ping/Pong ───────────────────────────────────────────────
  // Detects silently-dead TCP connections that never fire a `close` event.
  // Without this, the bridge can sit "connected" for minutes without
  // realizing the socket is dead — fatal for long-running agent turns.

  private startPing(ws: WebSocket): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.ping();
      // If no pong comes back within PONG_TIMEOUT_MS, force-close the
      // socket so the `close` handler triggers a reconnect.
      this.pongTimer = setTimeout(() => {
        this.log.warn("[Client] Pong timeout — connection is dead, forcing reconnect");
        ws.terminate();
      }, PONG_TIMEOUT_MS);
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  // ── Internal: RPC ─────────────────────────────────────────────────────

  private rpc<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error(`Not connected (method=${method})`));
        return;
      }
      const id = String(++this.counter);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout (${RPC_TIMEOUT_MS}ms): ${method}`));
      }, RPC_TIMEOUT_MS);

      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      const body = params ? { ...params, _tag: method } : { _tag: method };
      this.ws.send(JSON.stringify({ id, body }));
    });
  }

  // ── Internal: Message Handling ────────────────────────────────────────

  private handleMessage(raw: WebSocket.RawData): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString()) as Record<string, unknown>;
    } catch {
      return;
    }

    // Push event
    if (msg["type"] === "push" && typeof msg["channel"] === "string") {
      if (msg["channel"] === DOMAIN_EVENT_CHANNEL) {
        const data = msg["data"] as DomainEvent;
        for (const cb of this.listeners) {
          try {
            cb(data);
          } catch {
            // Don't let a bad listener crash the bridge
          }
        }
      }
      return;
    }

    // RPC response
    if (typeof msg["id"] === "string") {
      const p = this.pending.get(msg["id"]);
      if (!p) return;
      this.pending.delete(msg["id"]);
      clearTimeout(p.timer);
      if (msg["error"]) {
        p.reject(new Error((msg["error"] as { message?: string }).message ?? "RPC error"));
      } else {
        p.resolve(msg["result"]);
      }
    }
  }

  private rejectAll(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }
}

// ── ID Helpers ────────────────────────────────────────────────────────────

export const newCommandId = (): string => `cmd-${crypto.randomUUID()}`;
export const newMessageId = (): string => `msg-${crypto.randomUUID()}`;
export const newThreadId = (): string => `thread-${crypto.randomUUID()}`;
