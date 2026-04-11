/**
 * HTTP + WebSocket server that exposes the bridge UI.
 *
 * - HTTP: serves the built Vite UI from `ui/dist/`
 * - WebSocket (path `/bridge-ws`): pushes live events to the UI,
 *   receives start/stop commands back
 *
 * New clients receive the full accumulated state on connect so they
 * can render the conversation history immediately.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import type { EventBus, UICommand } from "./eventBus.ts";
import type { Logger } from "./types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_DIST = join(__dirname, "..", "ui", "dist");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export interface BridgeServer {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createBridgeServer(port: number, eventBus: EventBus, log: Logger): BridgeServer {
  const clients = new Set<WebSocket>();

  // ── HTTP: static file server ────────────────────────────────────────
  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;

    // Try serving the exact file
    const filePath = join(UI_DIST, pathname === "/" ? "index.html" : pathname);
    if (existsSync(filePath) && statSync(filePath).isFile()) {
      const ext = extname(filePath);
      res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
      res.end(readFileSync(filePath));
      return;
    }

    // SPA fallback — serve index.html for any unknown route
    const indexPath = join(UI_DIST, "index.html");
    if (existsSync(indexPath)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(readFileSync(indexPath));
      return;
    }

    // No built UI — tell the user how to build it
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!DOCTYPE html>
<html><head><title>Project Mythos</title></head>
<body style="background:#ffffff;color:#374151;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center">
<h2 style="color:#111827">Project Mythos</h2>
<p>UI not built yet. Run:</p>
<pre style="background:#f3f4f6;padding:12px 20px;border-radius:8px;color:#2563eb;border:1px solid #e5e7eb">cd apps/bridge && bun run build:ui</pre>
<p style="font-size:0.85em;margin-top:24px">Or start the Vite dev server:<br>
<code style="color:#059669">cd apps/bridge && bun run dev:ui</code></p>
</div></body></html>`);
  });

  // ── WebSocket: live event stream ────────────────────────────────────
  const wss = new WebSocketServer({ server: httpServer, path: "/bridge-ws" });

  wss.on("connection", (ws) => {
    clients.add(ws);
    log.debug("[BridgeServer] UI client connected");

    // Send accumulated state so the client can render history
    const state = eventBus.getState();
    ws.send(JSON.stringify({ type: "state", ...state }));

    ws.on("message", (raw) => {
      try {
        const cmd = JSON.parse(raw.toString()) as UICommand;
        eventBus.emitCommand(cmd);
      } catch {
        // Ignore malformed commands
      }
    });

    ws.on("close", () => {
      clients.delete(ws);
      log.debug("[BridgeServer] UI client disconnected");
    });
  });

  // Forward all bus events to connected UI clients
  eventBus.onEvent((event) => {
    const data = JSON.stringify(event);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  });

  return {
    start: () =>
      new Promise<void>((resolve) => {
        httpServer.listen(port, () => {
          log.info(`[Mythos] UI available at http://localhost:${port}`);
          resolve();
        });
      }),

    stop: () =>
      new Promise<void>((resolve) => {
        for (const client of clients) client.close();
        httpServer.close(() => resolve());
      }),
  };
}
