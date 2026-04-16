import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ChatPair,
  ClientMessage,
  PairConfig,
  ServerMessage,
  T3Project,
  ThreadSummary,
} from "../types";

interface RelayState {
  connected: boolean;
  t3Connected: boolean;
  t3Url: string | null;
  pairs: ChatPair[];
  projects: T3Project[];
  threads: ThreadSummary[];
  error: string | null;
}

interface RelayActions {
  connectToT3: (url: string, credential: string) => void;
  disconnectFromT3: () => void;
  createPair: (config: PairConfig) => void;
  startPair: (pairId: string) => void;
  stopPair: (pairId: string) => void;
  deletePair: (pairId: string) => void;
  sendMessage: (pairId: string, text: string) => void;
  clearError: () => void;
}

export function useRelay(): RelayState & RelayActions {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const [connected, setConnected] = useState(false);
  const [t3Connected, setT3Connected] = useState(false);
  const [t3Url, setT3Url] = useState<string | null>(null);
  const [pairs, setPairs] = useState<ChatPair[]>([]);
  const [projects, setProjects] = useState<T3Project[]>([]);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  const send = useCallback((msg: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const handleMessage = useCallback((event: MessageEvent) => {
    try {
      const msg: ServerMessage = JSON.parse(event.data);

      switch (msg.type) {
        case "connection-status":
          setT3Connected(msg.t3Connected);
          setT3Url(msg.t3Url);
          break;

        case "snapshot":
          setPairs(msg.pairs);
          setProjects(msg.projects);
          setThreads(msg.threads);
          break;

        case "pair-created":
          setPairs((prev) => [...prev, msg.pair]);
          break;

        case "pair-updated":
          setPairs((prev) => prev.map((p) => (p.id === msg.pair.id ? msg.pair : p)));
          break;

        case "pair-removed":
          setPairs((prev) => prev.filter((p) => p.id !== msg.pairId));
          break;

        case "new-message":
          setPairs((prev) =>
            prev.map((p) =>
              p.id === msg.pairId ? { ...p, messages: [...p.messages, msg.message] } : p,
            ),
          );
          break;

        case "threads-updated":
          setThreads(msg.threads);
          break;

        case "error":
          setError(msg.message);
          break;
      }
    } catch {
      // Ignore malformed messages
    }
  }, []);

  const connect = useCallback(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/relay-ws`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      setError(null);
    };

    ws.onmessage = handleMessage;

    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;
      reconnectTimer.current = setTimeout(connect, 2000);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [handleMessage]);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return {
    connected,
    t3Connected,
    t3Url,
    pairs,
    projects,
    threads,
    error,

    connectToT3: useCallback(
      (url: string, credential: string) => send({ type: "connect-t3", url, credential }),
      [send],
    ),
    disconnectFromT3: useCallback(() => send({ type: "disconnect-t3" }), [send]),
    createPair: useCallback((config: PairConfig) => send({ type: "create-pair", config }), [send]),
    startPair: useCallback((pairId: string) => send({ type: "start-pair", pairId }), [send]),
    stopPair: useCallback((pairId: string) => send({ type: "stop-pair", pairId }), [send]),
    deletePair: useCallback((pairId: string) => send({ type: "delete-pair", pairId }), [send]),
    sendMessage: useCallback(
      (pairId: string, text: string) => send({ type: "send-message", pairId, text }),
      [send],
    ),
    clearError: useCallback(() => setError(null), []),
  };
}
