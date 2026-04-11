import type { Logger } from "./types.ts";

interface WsTokenResponse {
  readonly token?: unknown;
}

function isWebSocketProtocol(protocol: string): protocol is "ws:" | "wss:" {
  return protocol === "ws:" || protocol === "wss:";
}

function redactUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  for (const key of ["token", "wsToken"]) {
    if (url.searchParams.has(key)) {
      url.searchParams.set(key, "redacted");
    }
  }
  return url.toString();
}

function toHttpAuthUrl(wsUrl: string): string {
  const url = new URL(wsUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/api/auth/ws-token";
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function exchangeSessionTokenForWsToken(
  credential: string,
  wsUrl: string,
): Promise<string | null> {
  const response = await fetch(toHttpAuthUrl(wsUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential}`,
    },
  });

  if (!response.ok) {
    return null;
  }

  const body = (await response.json()) as WsTokenResponse;
  return typeof body.token === "string" && body.token.length > 0 ? body.token : null;
}

export function normalizeT3WsUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  if (!isWebSocketProtocol(url.protocol)) {
    throw new Error(`Unsupported T3 websocket URL protocol: ${url.protocol}`);
  }

  url.pathname = "/ws";
  return url.toString();
}

export async function resolveT3WsUrl(rawUrl: string, authToken: string | undefined, log: Logger) {
  const url = new URL(normalizeT3WsUrl(rawUrl));
  const legacyQueryToken = url.searchParams.get("token");
  if (legacyQueryToken) {
    url.searchParams.delete("token");
  }

  if (url.searchParams.has("wsToken")) {
    return url.toString();
  }

  const credential = authToken ?? legacyQueryToken ?? undefined;
  if (!credential) {
    return url.toString();
  }

  const issuedWsToken = await exchangeSessionTokenForWsToken(credential, url.toString());
  if (issuedWsToken) {
    url.searchParams.set("wsToken", issuedWsToken);
    return url.toString();
  }

  log.warn(
    `Could not exchange bridge auth credential for a dedicated wsToken; assuming the configured token is already a websocket token (${redactUrl(url.toString())})`,
  );
  url.searchParams.set("wsToken", credential);
  return url.toString();
}
