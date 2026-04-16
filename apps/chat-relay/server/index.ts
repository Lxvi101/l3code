/**
 * Chat Relay Server
 *
 * A Bun HTTP + WebSocket server that:
 * 1. Connects to a running T3 Code server as an authenticated client
 * 2. Manages "chat pairs" — two threads that ping-pong messages
 * 3. Serves a React UI for configuring and monitoring relay pairs
 *
 * In development, Vite handles the UI and proxies WebSocket/API calls here.
 * In production, this server serves the static build from dist-client/.
 */

import { join, dirname } from "node:path";
import type { ServerWebSocket } from "bun";
import { RelayEngine } from "./relay-engine";
import type { ClientMessage, ServerMessage } from "./types";

const PORT = Number(process.env.RELAY_SERVER_PORT ?? 4400);
const HOST = process.env.RELAY_SERVER_HOST ?? "0.0.0.0";

// Resolve dist-client relative to this file, not CWD.
// systemd sets WorkingDirectory to repo root but --cwd only affects bun's
// package.json lookup, not the process CWD — so "./dist-client" would miss.
const STATIC_DIR = join(dirname(new URL(import.meta.url).pathname), "..", "dist-client");

// ─── WebSocket Client Tracking ───
// Bun's ServerWebSocket objects must not have arbitrary properties set on them
// (it causes stack overflows). We track clients with a standalone Set instead.

type WsData = { id: string };
const activeSockets = new Set<ServerWebSocket<WsData>>();

function broadcast(msg: ServerMessage): void {
  const data = JSON.stringify(msg);
  for (const ws of activeSockets) {
    try {
      ws.send(data);
    } catch {
      activeSockets.delete(ws);
    }
  }
}

// ─── Relay Engine ───

const engine = new RelayEngine(broadcast);

// ─── Client Message Handler ───

async function handleClientMessage(msg: ClientMessage, ws: ServerWebSocket<WsData>): Promise<void> {
  try {
    switch (msg.type) {
      case "connect-t3": {
        await engine.connectToT3(msg.url, msg.credential);
        break;
      }
      case "disconnect-t3": {
        engine.disconnectFromT3();
        break;
      }
      case "create-pair": {
        await engine.createPair(msg.config);
        break;
      }
      case "start-pair": {
        await engine.startPair(msg.pairId);
        break;
      }
      case "stop-pair": {
        await engine.stopPair(msg.pairId);
        break;
      }
      case "delete-pair": {
        await engine.deletePair(msg.pairId);
        break;
      }
      case "send-message": {
        await engine.sendMessage(msg.pairId, msg.text);
        break;
      }
      default: {
        ws.send(
          JSON.stringify({
            type: "error",
            message: `Unknown message type: ${(msg as any).type}`,
          } satisfies ServerMessage),
        );
      }
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    ws.send(
      JSON.stringify({
        type: "error",
        message: errorMsg,
      } satisfies ServerMessage),
    );
  }
}

// ─── Bun Server ───

const server = Bun.serve<WsData>({
  port: PORT,
  hostname: HOST,

  // fetch must be synchronous for WebSocket upgrades to work in Bun.
  // All async work happens inside the websocket handlers instead.
  fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade — must be handled synchronously
    if (url.pathname === "/relay-ws") {
      const ok = server.upgrade(req, {
        data: { id: crypto.randomUUID() },
      });
      if (ok) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // REST API health / status endpoint
    if (url.pathname === "/api/relay/status") {
      const { pairs, projects } = engine.getSnapshot();
      return Response.json({
        t3Connected: engine.isConnected,
        t3Url: engine.t3Url,
        pairs,
        projects,
      });
    }

    // Serve static files from the Vite build (dist-client/).
    // In dev mode Vite handles this via its proxy, so these will only
    // be hit in production or when accessing the Bun port directly.
    const filePath = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(join(STATIC_DIR, filePath));
    return file.exists().then((exists) => {
      if (exists) return new Response(file);
      // SPA fallback — serve index.html for client-side routes
      const index = Bun.file(join(STATIC_DIR, "index.html"));
      return index.exists().then((indexExists) => {
        if (indexExists) return new Response(index);
        return new Response("Not found", { status: 404 });
      });
    });
  },

  websocket: {
    open(ws) {
      activeSockets.add(ws);
      console.log(
        `[server] WebSocket client ${ws.data.id.slice(0, 8)} connected (${activeSockets.size} total)`,
      );

      // Send initial state to the newly connected client
      const { pairs, projects, threads } = engine.getSnapshot();
      ws.send(
        JSON.stringify({
          type: "connection-status",
          t3Connected: engine.isConnected,
          t3Url: engine.t3Url,
        } satisfies ServerMessage),
      );
      ws.send(
        JSON.stringify({
          type: "snapshot",
          pairs,
          projects,
          threads,
        } satisfies ServerMessage),
      );
    },

    message(ws, message) {
      try {
        const raw = typeof message === "string" ? message : Buffer.from(message).toString("utf-8");
        const msg: ClientMessage = JSON.parse(raw);
        handleClientMessage(msg, ws);
      } catch (err) {
        ws.send(
          JSON.stringify({
            type: "error",
            message: `Invalid message: ${err instanceof Error ? err.message : String(err)}`,
          } satisfies ServerMessage),
        );
      }
    },

    close(ws) {
      activeSockets.delete(ws);
      console.log(
        `[server] WebSocket client ${ws.data.id.slice(0, 8)} disconnected (${activeSockets.size} total)`,
      );
    },
  },
});

console.log(`
  ╔══════════════════════════════════════════════╗
  ║         THE RELAY — Chat Relay Server        ║
  ╠══════════════════════════════════════════════╣
  ║  http://${HOST}:${PORT}                        ║
  ╚══════════════════════════════════════════════╝
`);

// Restore saved connection + pairs from disk
engine.boot().catch((err) => {
  console.error("[server] Boot failed:", err);
});

// Note: do NOT `export default server` — Bun's entrypoint auto-serve
// feature would re-invoke Bun.serve() on the export, causing a recursive
// WebSocket upgrade loop (RangeError: Maximum call stack size exceeded).
