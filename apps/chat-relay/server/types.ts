// ─── Shared types between server and client ───

export interface Modification {
  type: "prefix" | "suffix" | "replace" | "wrap";
  /** The text to add (prefix/suffix/wrap) or the replacement string (replace) */
  value: string;
  /** Regex pattern for "replace" type */
  pattern?: string;
}

export interface PairConfig {
  name: string;
  /** T3 project ID to create threads under */
  projectId: string;
  /** Model selection for both threads (e.g. { provider: "claudeAgent", model: "..." }) */
  modelSelection: {
    provider: "claudeAgent" | "codex";
    model: string;
  };
  runtimeMode: "approval-required" | "auto-accept-edits" | "full-access";
  /** The first message sent to Thread A to kick things off */
  initialMessage: string;
  /** Label for Thread A (shown in UI) */
  labelA: string;
  /** Label for Thread B (shown in UI) */
  labelB: string;
  /**
   * A regex pattern — if the assistant response matches, the relay stops.
   * e.g. "\\[STOP\\]" or "CONVERSATION_COMPLETE"
   */
  stopSignal: string;
  /** Max full round-trips before auto-stopping (0 = unlimited) */
  maxTurns: number;
  /** Modifications applied to Thread A's output before sending to Thread B */
  modificationsAtoB: Modification[];
  /** Modifications applied to Thread B's output before sending to Thread A */
  modificationsBtoA: Modification[];
}

export interface ThreadInfo {
  id: string;
  label: string;
}

export type PairStatus = "idle" | "running" | "paused" | "completed" | "stopped" | "error";

export interface RelayMessage {
  id: string;
  /** Which side produced this message */
  source: "A" | "B" | "system";
  role: "user" | "assistant" | "system";
  /** Original text from the assistant (or user for the initial message) */
  originalText: string;
  /** Text after modifications were applied (only for relayed messages) */
  relayedText?: string;
  timestamp: string;
  turnNumber: number;
}

export interface PendingDispatch {
  side: "A" | "B";
  threadId: string;
  text: string;
  reason: "initial" | "relay";
  sourceSide: "A" | "B" | null;
  dispatchedAt: string | null;
  retryCount: number;
}

export interface ChatPair {
  id: string;
  name: string;
  status: PairStatus;
  threadA: ThreadInfo;
  threadB: ThreadInfo;
  config: PairConfig;
  messages: RelayMessage[];
  turnCount: number;
  /** Which thread we're currently waiting on */
  waitingFor: "A" | "B" | null;
  pendingDispatch: PendingDispatch | null;
  resumeAt: string | null;
  error?: string;
  createdAt: string;
}

// ─── Thread summary (for the sidebar thread list) ───

export interface ThreadSummary {
  id: string;
  projectId: string;
  title: string;
  messageCount: number;
  lastMessagePreview: string;
  lastActivityAt: string;
  turnState: string | null;
  /** If this thread belongs to a relay pair, the pair ID */
  pairId: string | null;
  pairSide: "A" | "B" | null;
}

// ─── WebSocket protocol: server → client ───

export type ServerMessage =
  | { type: "connection-status"; t3Connected: boolean; t3Url: string | null }
  | { type: "snapshot"; pairs: ChatPair[]; projects: T3Project[]; threads: ThreadSummary[] }
  | { type: "pair-created"; pair: ChatPair }
  | { type: "pair-updated"; pair: ChatPair }
  | { type: "pair-removed"; pairId: string }
  | { type: "new-message"; pairId: string; message: RelayMessage }
  | { type: "threads-updated"; threads: ThreadSummary[] }
  | { type: "error"; message: string };

// ─── WebSocket protocol: client → server ───

export type ClientMessage =
  | { type: "connect-t3"; url: string; credential: string }
  | { type: "disconnect-t3" }
  | { type: "create-pair"; config: PairConfig }
  | { type: "start-pair"; pairId: string }
  | { type: "stop-pair"; pairId: string }
  | { type: "delete-pair"; pairId: string }
  | { type: "send-message"; pairId: string; text: string };

// ─── T3 snapshot types (minimal subset we need) ───

export interface T3Project {
  id: string;
  title: string;
  workspaceRoot: string;
}

export interface T3Thread {
  id: string;
  projectId: string;
  title: string;
  messages: T3Message[];
  latestTurn: T3LatestTurn | null;
  session: T3Session | null;
}

export interface T3Message {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  turnId: string | null;
  streaming: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface T3LatestTurn {
  turnId: string;
  state: "running" | "interrupted" | "completed" | "error";
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  assistantMessageId: string | null;
}

export interface T3Session {
  threadId: string;
  status: "idle" | "starting" | "running" | "ready" | "interrupted" | "stopped" | "error";
  providerName: string;
  lastError: string | null;
}

export interface T3Snapshot {
  snapshotSequence: number;
  projects: T3Project[];
  threads: T3Thread[];
  updatedAt: string;
}
