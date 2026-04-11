import { describe, expect, it, vi } from "vitest";

import { normalizeT3WsUrl, resolveT3WsUrl } from "./wsUrl.ts";

const log = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  close: vi.fn(),
};

describe("normalizeT3WsUrl", () => {
  it("normalizes root websocket URLs to /ws", () => {
    expect(normalizeT3WsUrl("ws://localhost:3773")).toBe("ws://localhost:3773/ws");
    expect(normalizeT3WsUrl("wss://example.com/?foo=bar")).toBe("wss://example.com/ws?foo=bar");
  });
});

describe("resolveT3WsUrl", () => {
  it("returns the normalized URL when no auth is configured", async () => {
    await expect(resolveT3WsUrl("ws://localhost:3773", undefined, log)).resolves.toBe(
      "ws://localhost:3773/ws",
    );
  });

  it("exchanges a bearer token for a websocket token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ token: "issued-ws-token" }),
      }),
    );

    await expect(resolveT3WsUrl("ws://localhost:3773", "bearer-token", log)).resolves.toBe(
      "ws://localhost:3773/ws?wsToken=issued-ws-token",
    );
  });

  it("falls back to treating legacy query tokens as websocket tokens", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
      }),
    );

    await expect(
      resolveT3WsUrl("ws://localhost:3773/?token=legacy-token", undefined, log),
    ).resolves.toBe("ws://localhost:3773/ws?wsToken=legacy-token");
  });
});
