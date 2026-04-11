/**
 * Core type definitions for the bridge.
 *
 * Workflows implement the `Workflow` interface and receive a `WorkflowContext`
 * with all the capabilities they need (client, logging, state, abort signal).
 */

// ── Workflow Abstraction ──────────────────────────────────────────────────

export interface Workflow {
  readonly name: string;
  run(ctx: WorkflowContext): Promise<WorkflowResult>;
}

export interface WorkflowContext {
  readonly client: T3Client;
  readonly config: BridgeConfig;
  readonly state: StateManager;
  readonly log: Logger;
  readonly signal: AbortSignal;
  readonly eventBus: import("./eventBus.ts").EventBus;
}

export interface WorkflowResult {
  readonly success: boolean;
  readonly iterations: number;
  readonly summary: string;
  readonly threadIds: readonly string[];
}

// ── T3 Client Interface ──────────────────────────────────────────────────

export type DomainEvent = Record<string, unknown>;
export type EventCallback = (event: DomainEvent) => void;
export type Unsubscribe = () => void;

export interface T3Client {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  readonly connected: boolean;

  getSnapshot(): Promise<Snapshot>;
  getServerConfig(): Promise<ServerConfig>;
  dispatchCommand(command: Record<string, unknown>): Promise<Record<string, unknown>>;
  getFullThreadDiff(threadId: string, toTurnCount: number): Promise<DiffResult>;

  onDomainEvent(cb: EventCallback): Unsubscribe;
}

// ── Server Config Types ──────────────────────────────────────────────────

export interface ServerConfig {
  readonly providers: readonly ServerProvider[];
}

export interface ServerProvider {
  readonly provider: string;
  readonly enabled: boolean;
  readonly status: string;
  readonly models: readonly ServerProviderModel[];
}

export interface ServerProviderModel {
  readonly slug: string;
  readonly name: string;
}

// ── Snapshot Types ────────────────────────────────────────────────────────

export interface Snapshot {
  readonly snapshotSequence: number;
  readonly projects: readonly Project[];
  readonly threads: readonly Thread[];
  readonly updatedAt: string;
}

export interface Project {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly deletedAt: string | null;
}

export interface Thread {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly latestTurn: LatestTurn | null;
  readonly messages: readonly ThreadMessage[];
  readonly activities: readonly ThreadActivity[];
  readonly session: ThreadSession | null;
}

export interface LatestTurn {
  readonly turnId: string;
  readonly state: "running" | "completed" | "error" | "interrupted";
  readonly requestedAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly assistantMessageId: string | null;
}

export interface ThreadMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly streaming: boolean;
  readonly turnId: string | null;
}

export interface ThreadActivity {
  readonly kind: string;
  readonly message: string;
  readonly occurredAt: string;
}

export interface ThreadSession {
  readonly status: "idle" | "starting" | "running" | "ready" | "interrupted" | "stopped" | "error";
  readonly activeTurnId: string | null;
  readonly lastError?: string;
}

export interface DiffResult {
  readonly threadId: string;
  readonly diff: string;
}

// ── Configuration ─────────────────────────────────────────────────────────

export interface CodexModelOptions {
  readonly reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  readonly fastMode?: boolean;
}

export interface ClaudeModelOptions {
  readonly thinking?: boolean;
  readonly effort?: "low" | "medium" | "high" | "max" | "ultrathink";
  readonly fastMode?: boolean;
}

export interface ModelSelection {
  readonly provider: string;
  readonly model: string;
  readonly options?: CodexModelOptions | ClaudeModelOptions;
}

export interface BridgeConfig {
  readonly wsUrl: string;
  readonly authToken: string | undefined;
  readonly projectId: string | undefined;
  readonly workflow: "coder-reviewer" | "task-queue";

  readonly coderModel: ModelSelection;
  readonly reviewerModel: ModelSelection;

  readonly maxIterations: number;
  readonly turnTimeoutMs: number;
  readonly runtimeMode: "full-access" | "approval-required";
  readonly interactionMode: "default" | "plan";

  readonly lgtmPattern: string;
  readonly logLevel: LogLevel;
  readonly logFile: string | undefined;
  readonly stateDir: string;
  readonly webhookUrl: string | undefined;

  readonly taskFile: string;
  readonly bridgePort: number;
}

// ── Logger ────────────────────────────────────────────────────────────────

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  close(): void;
}

// ── State Manager ─────────────────────────────────────────────────────────

export interface WorkflowState {
  workflowName: string;
  projectId: string;
  threadIds: string[];
  iteration: number;
  maxIterations: number;
  status: "running" | "completed" | "failed" | "interrupted";
  startedAt: string;
  updatedAt: string;
  lastError?: string;
  meta: Record<string, unknown>;
}

export interface StateManager {
  load(): WorkflowState | null;
  save(state: WorkflowState): void;
  clear(): void;
}
