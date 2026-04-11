/**
 * Typed event bus that mediates between the workflow engine and the UI.
 */

// ── Public Types ─────────────────────────────────────────────────────────

export interface UIMessage {
  readonly id: string;
  readonly agent: "coder" | "reviewer" | "system" | "diff";
  readonly text: string;
  readonly timestamp: string;
  readonly iteration: number;
}

export interface UIStreamingActivity {
  readonly kind: string;
  readonly message: string;
}

export interface UIStreamingMessage {
  readonly id: string;
  readonly agent: "coder" | "reviewer";
  readonly text: string;
  readonly timestamp: string;
  readonly iteration: number;
  readonly activities: readonly UIStreamingActivity[];
}

export interface UIStatus {
  readonly running: boolean;
  readonly connected: boolean;
  readonly phase:
    | "idle"
    | "starting"
    | "coding"
    | "reviewing"
    | "fetching-diff"
    | "completed"
    | "error"
    | "interrupted";
  readonly iteration: number;
  readonly maxIterations: number;
  readonly startedAt: string | null;
  readonly error: string | null;
}

export interface UIProject {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
}

export interface UIProviderModels {
  readonly provider: string;
  readonly models: readonly { slug: string; name: string }[];
}

export interface UIConfigSummary {
  readonly workflow: string;
  readonly coderModel: string;
  readonly reviewerModel: string;
  readonly maxIterations: number;
  readonly task: string;
}

export interface UIHistoryEntry {
  readonly id: string;
  readonly task: string;
  readonly startedAt: string;
  readonly status: "running" | "completed" | "error" | "interrupted";
  readonly iterations: number;
  readonly messageCount: number;
}

// ── T3 Chat Thread Types ────────────────────────────────────────────────

export interface T3ThreadMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly streaming: boolean;
}

export interface T3ThreadActivity {
  readonly kind: string;
  readonly message: string;
  readonly occurredAt: string;
}

export interface T3ThreadSummary {
  readonly id: string;
  readonly projectId: string;
  readonly projectTitle: string;
  readonly title: string;
  readonly messageCount: number;
  readonly lastActivity: string | null;
  readonly sessionStatus: string | null;
  readonly turnState: string | null;
  readonly messages: readonly T3ThreadMessage[];
  readonly activities: readonly T3ThreadActivity[];
}

export type BridgeUIEvent =
  | {
      readonly type: "state";
      readonly messages: UIMessage[];
      readonly status: UIStatus;
      readonly config: UIConfigSummary | null;
      readonly projects: UIProject[];
      readonly providerModels: UIProviderModels[];
      readonly history: UIHistoryEntry[];
      readonly activeHistoryId: string | null;
      readonly streamingMessage: UIStreamingMessage | null;
    }
  | { readonly type: "message"; readonly message: UIMessage }
  | { readonly type: "status"; readonly status: UIStatus }
  | { readonly type: "config"; readonly config: UIConfigSummary | null }
  | { readonly type: "projects"; readonly projects: UIProject[] }
  | { readonly type: "providerModels"; readonly providerModels: UIProviderModels[] }
  | {
      readonly type: "history";
      readonly history: UIHistoryEntry[];
      readonly activeHistoryId: string | null;
    }
  | { readonly type: "reset"; readonly messages: UIMessage[] }
  | { readonly type: "t3Threads"; readonly threads: T3ThreadSummary[] }
  | { readonly type: "streaming"; readonly message: UIStreamingMessage | null };

export interface UIStartCommand {
  readonly type: "start";
  readonly task: string;
  readonly projectId: string;
  readonly coderProvider: string;
  readonly coderModel: string;
  readonly reviewerProvider: string;
  readonly reviewerModel: string;
  readonly maxIterations: number;
}

export type UICommand =
  | UIStartCommand
  | { readonly type: "stop" }
  | { readonly type: "load-history"; readonly id: string }
  | { readonly type: "delete-history"; readonly id: string }
  | { readonly type: "new-session" }
  | { readonly type: "refresh-threads" };

// ── EventBus Interface ───────────────────────────────────────────────────

export interface EventBus {
  emitMessage(msg: UIMessage): void;
  emitStatus(status: UIStatus): void;
  setConfig(config: UIConfigSummary | null): void;
  setProjects(projects: UIProject[]): void;
  setProviderModels(models: UIProviderModels[]): void;
  setHistory(history: UIHistoryEntry[], activeId: string | null): void;
  setT3Threads(threads: T3ThreadSummary[]): void;

  /**
   * Set or clear the ephemeral streaming message shown during an active turn.
   * Pass `null` when the turn completes to clear it from the UI.
   */
  setStreamingMessage(msg: UIStreamingMessage | null): void;

  /**
   * Replace ALL messages atomically — used for session switches and resets.
   * Broadcasts a "reset" event so connected clients replace their message list.
   */
  replaceMessages(messages: UIMessage[]): void;

  onEvent(cb: (event: BridgeUIEvent) => void): () => void;

  getState(): {
    messages: UIMessage[];
    status: UIStatus;
    config: UIConfigSummary | null;
    projects: UIProject[];
    providerModels: UIProviderModels[];
    history: UIHistoryEntry[];
    activeHistoryId: string | null;
    t3Threads: T3ThreadSummary[];
    streamingMessage: UIStreamingMessage | null;
  };

  emitCommand(cmd: UICommand): void;
  onCommand(cb: (cmd: UICommand) => void): () => void;
}

// ── Factory ──────────────────────────────────────────────────────────────

const DEFAULT_STATUS: UIStatus = {
  running: false,
  connected: false,
  phase: "idle",
  iteration: 0,
  maxIterations: 0,
  startedAt: null,
  error: null,
};

export function createEventBus(): EventBus {
  const eventListeners: Array<(event: BridgeUIEvent) => void> = [];
  const commandListeners: Array<(cmd: UICommand) => void> = [];

  // The canonical message list. Only mutated via push() or replaceMessages().
  let messages: UIMessage[] = [];
  let currentStatus: UIStatus = DEFAULT_STATUS;
  let currentConfig: UIConfigSummary | null = null;
  let currentProjects: UIProject[] = [];
  let currentProviderModels: UIProviderModels[] = [];
  let currentHistory: UIHistoryEntry[] = [];
  let currentActiveHistoryId: string | null = null;
  let currentT3Threads: T3ThreadSummary[] = [];
  let currentStreamingMessage: UIStreamingMessage | null = null;

  function broadcast(event: BridgeUIEvent): void {
    for (const cb of eventListeners) {
      try {
        cb(event);
      } catch {
        // no-op
      }
    }
  }

  return {
    emitMessage(msg) {
      messages.push(msg);
      broadcast({ type: "message", message: msg });
    },

    emitStatus(status) {
      currentStatus = status;
      broadcast({ type: "status", status });
    },

    setConfig(config) {
      currentConfig = config;
      broadcast({ type: "config", config });
    },

    setProjects(projects) {
      currentProjects = projects;
      broadcast({ type: "projects", projects });
    },

    setProviderModels(models) {
      currentProviderModels = models;
      broadcast({ type: "providerModels", providerModels: models });
    },

    setHistory(history, activeId) {
      currentHistory = history;
      currentActiveHistoryId = activeId;
      broadcast({ type: "history", history, activeHistoryId: activeId });
    },

    setT3Threads(threads) {
      currentT3Threads = threads;
      broadcast({ type: "t3Threads", threads });
    },

    setStreamingMessage(msg) {
      currentStreamingMessage = msg;
      broadcast({ type: "streaming", message: msg });
    },

    replaceMessages(newMessages) {
      // Replace the canonical array entirely
      messages = [...newMessages];
      broadcast({ type: "reset", messages });
    },

    onEvent(cb) {
      eventListeners.push(cb);
      return () => {
        const idx = eventListeners.indexOf(cb);
        if (idx >= 0) eventListeners.splice(idx, 1);
      };
    },

    getState() {
      return {
        messages: [...messages],
        status: currentStatus,
        config: currentConfig,
        projects: currentProjects,
        providerModels: currentProviderModels,
        history: currentHistory,
        activeHistoryId: currentActiveHistoryId,
        t3Threads: currentT3Threads,
        streamingMessage: currentStreamingMessage,
      };
    },

    emitCommand(cmd) {
      for (const cb of commandListeners) {
        try {
          cb(cmd);
        } catch {
          // no-op
        }
      }
    },

    onCommand(cb) {
      commandListeners.push(cb);
      return () => {
        const idx = commandListeners.indexOf(cb);
        if (idx >= 0) commandListeners.splice(idx, 1);
      };
    },
  };
}
