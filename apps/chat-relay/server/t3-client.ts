/**
 * T3 Code HTTP API Client
 *
 * Connects to a running T3 Code server and provides methods for:
 * - Authentication (bootstrap with pairing credential)
 * - Reading orchestration state (snapshot)
 * - Dispatching orchestration commands (create threads, send messages, etc.)
 */

import type { T3Snapshot } from "./types";

export class T3Client {
  private baseUrl: string;
  private bearerToken: string | null = null;
  private _connected = false;
  private _consecutiveFailures = 0;

  /** Number of sequential fetch failures (resets on success). */
  get consecutiveFailures(): number {
    return this._consecutiveFailures;
  }

  constructor(baseUrl: string) {
    // Normalize: strip trailing slash
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  get connected(): boolean {
    return this._connected;
  }

  get url(): string {
    return this.baseUrl;
  }

  /** The current bearer token (for persistence). */
  get token(): string | null {
    return this.bearerToken;
  }

  /**
   * Authenticate with T3 Code using a pairing credential.
   * Obtains a bearer token for subsequent API calls.
   */
  async authenticate(credential: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/auth/bootstrap/bearer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`T3 authentication failed (${res.status}): ${text}`);
    }

    const data = await res.json();
    this.bearerToken = data.sessionToken;
    this._connected = true;
    console.log(
      `[t3-client] Authenticated with T3 at ${this.baseUrl} (expires: ${data.expiresAt})`,
    );
  }

  /**
   * Restore a previously saved bearer token.
   * Validates it with a lightweight session check.
   */
  async restoreToken(token: string): Promise<void> {
    this.bearerToken = token;
    // Verify the token still works
    const res = await fetch(`${this.baseUrl}/api/auth/session`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      this.bearerToken = null;
      throw new Error(`Saved session expired or invalid (${res.status})`);
    }
    const data = await res.json();
    if (!data.authenticated) {
      this.bearerToken = null;
      throw new Error("Saved session is no longer authenticated");
    }
    this._connected = true;
    console.log("[t3-client] Restored saved session");
  }

  /**
   * Fetch the current orchestration read-model snapshot.
   */
  async getSnapshot(): Promise<T3Snapshot> {
    let res: Response;
    try {
      res = await this.authedFetch(`${this.baseUrl}/api/orchestration/snapshot`);
    } catch (err) {
      this._consecutiveFailures++;
      throw err;
    }
    if (!res.ok) {
      this._consecutiveFailures++;
      const text = await res.text();
      throw new Error(`Failed to get snapshot (${res.status}): ${text}`);
    }
    this._consecutiveFailures = 0;
    return res.json();
  }

  /**
   * Dispatch an orchestration command to T3.
   * Returns the event sequence number.
   */
  async dispatch(command: Record<string, unknown>): Promise<{ sequence: number }> {
    let res: Response;
    try {
      res = await this.authedFetch(`${this.baseUrl}/api/orchestration/dispatch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(command),
      });
    } catch (err) {
      this._consecutiveFailures++;
      throw err;
    }

    if (!res.ok) {
      this._consecutiveFailures++;
      const text = await res.text();
      throw new Error(`Dispatch failed (${res.status}): ${text}`);
    }

    this._consecutiveFailures = 0;
    return res.json();
  }

  // ─── Convenience command builders ───

  /**
   * Create a new thread in T3.
   */
  async createThread(params: {
    threadId: string;
    projectId: string;
    title: string;
    modelSelection: { provider: string; model: string };
    runtimeMode: string;
  }): Promise<{ sequence: number }> {
    return this.dispatch({
      type: "thread.create",
      commandId: crypto.randomUUID(),
      threadId: params.threadId,
      projectId: params.projectId,
      title: params.title,
      modelSelection: params.modelSelection,
      runtimeMode: params.runtimeMode,
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: new Date().toISOString(),
    });
  }

  /**
   * Send a user message and start a turn in a thread.
   */
  async startTurn(params: {
    threadId: string;
    text: string;
    runtimeMode?: string;
    modelSelection?: { provider: string; model: string };
  }): Promise<{ sequence: number }> {
    return this.dispatch({
      type: "thread.turn.start",
      commandId: crypto.randomUUID(),
      threadId: params.threadId,
      message: {
        messageId: crypto.randomUUID(),
        role: "user",
        text: params.text,
        attachments: [],
      },
      runtimeMode: params.runtimeMode ?? "full-access",
      interactionMode: "default",
      ...(params.modelSelection ? { modelSelection: params.modelSelection } : {}),
      createdAt: new Date().toISOString(),
    });
  }

  /**
   * Interrupt a running turn.
   */
  async interruptTurn(threadId: string, turnId?: string): Promise<{ sequence: number }> {
    return this.dispatch({
      type: "thread.turn.interrupt",
      commandId: crypto.randomUUID(),
      threadId,
      ...(turnId ? { turnId } : {}),
      createdAt: new Date().toISOString(),
    });
  }

  /**
   * Stop a thread's provider session.
   */
  async stopSession(threadId: string): Promise<{ sequence: number }> {
    return this.dispatch({
      type: "thread.session.stop",
      commandId: crypto.randomUUID(),
      threadId,
      createdAt: new Date().toISOString(),
    });
  }

  /**
   * Delete a thread.
   */
  async deleteThread(threadId: string): Promise<{ sequence: number }> {
    return this.dispatch({
      type: "thread.delete",
      commandId: crypto.randomUUID(),
      threadId,
    });
  }

  disconnect(): void {
    this.bearerToken = null;
    this._connected = false;
    console.log("[t3-client] Disconnected from T3");
  }

  // ─── Internal helpers ───

  private static readonly FETCH_TIMEOUT_MS = 8_000;

  private async authedFetch(url: string, init?: RequestInit): Promise<Response> {
    if (!this.bearerToken) {
      throw new Error("Not authenticated with T3. Call authenticate() first.");
    }

    return fetch(url, {
      ...init,
      signal: AbortSignal.timeout(T3Client.FETCH_TIMEOUT_MS),
      headers: {
        ...((init?.headers as Record<string, string>) ?? {}),
        Authorization: `Bearer ${this.bearerToken}`,
      },
    });
  }
}
