/**
 * Configuration loader — reads from environment variables.
 * Every setting has a sensible default so the bridge can start
 * with nothing more than a running T3 server on localhost.
 */

import type {
  BridgeConfig,
  ClaudeModelOptions,
  CodexModelOptions,
  LogLevel,
  ModelSelection,
} from "./types.ts";

function env(key: string, fallback = ""): string {
  return process.env[key] ?? fallback;
}

export function loadConfig(): BridgeConfig {
  return {
    wsUrl: env("T3_WS_URL", "ws://localhost:3773"),
    authToken: env("T3_AUTH_TOKEN") || undefined,
    projectId: env("T3_PROJECT_ID") || undefined,
    workflow: parseWorkflow(env("WORKFLOW", "coder-reviewer")),

    coderModel: buildModelSelection(
      env("CODER_PROVIDER", "claudeAgent"),
      env("CODER_MODEL", "claude-sonnet-4-6"),
      env("CODER_EFFORT"),
      env("CODER_FAST_MODE"),
      env("CODER_THINKING"),
    ),
    reviewerModel: buildModelSelection(
      env("REVIEWER_PROVIDER", "claudeAgent"),
      env("REVIEWER_MODEL", "claude-sonnet-4-6"),
      env("REVIEWER_EFFORT"),
      env("REVIEWER_FAST_MODE"),
      env("REVIEWER_THINKING"),
    ),

    maxIterations: Number(env("MAX_ITERATIONS", "20")),
    turnTimeoutMs: Number(env("TURN_TIMEOUT_MS", "600000")),
    runtimeMode: parseRuntimeMode(env("RUNTIME_MODE", "full-access")),
    interactionMode: env("INTERACTION_MODE", "default") === "plan" ? "plan" : "default",

    lgtmPattern: env("LGTM_PATTERN", "^\\s*\\*{0,2}LGTM\\*{0,2}"),
    logLevel: parseLogLevel(env("LOG_LEVEL", "info")),
    logFile: env("LOG_FILE") || undefined,
    stateDir: env("STATE_DIR", ".bridge-state"),
    webhookUrl: env("WEBHOOK_URL") || undefined,

    taskFile: env("TASK_FILE", "task.md"),
    bridgePort: Number(env("BRIDGE_PORT", "3100")),
  };
}

// ── Model Selection Builder ──────────────────────────────────────────────

function buildModelSelection(
  provider: string,
  model: string,
  effort: string,
  fastMode: string,
  thinking: string,
): ModelSelection {
  const normalizedProvider = provider === "codex" ? "codex" : "claudeAgent";

  if (normalizedProvider === "codex") {
    const options = buildCodexOptions(effort, fastMode);
    return options
      ? { provider: normalizedProvider, model, options }
      : { provider: normalizedProvider, model };
  }

  const options = buildClaudeOptions(effort, fastMode, thinking);
  return options
    ? { provider: normalizedProvider, model, options }
    : { provider: normalizedProvider, model };
}

function buildCodexOptions(effort: string, fastMode: string): CodexModelOptions | undefined {
  const codexEfforts = ["low", "medium", "high", "xhigh"] as const;
  type CodexEffort = (typeof codexEfforts)[number];

  const parsedEffort =
    effort && codexEfforts.includes(effort as CodexEffort) ? (effort as CodexEffort) : undefined;
  const parsedFastMode = fastMode ? fastMode === "true" : undefined;

  if (parsedEffort === undefined && parsedFastMode === undefined) return undefined;

  return {
    ...(parsedEffort !== undefined ? { reasoningEffort: parsedEffort } : {}),
    ...(parsedFastMode !== undefined ? { fastMode: parsedFastMode } : {}),
  };
}

function buildClaudeOptions(
  effort: string,
  fastMode: string,
  thinking: string,
): ClaudeModelOptions | undefined {
  const claudeEfforts = ["low", "medium", "high", "max", "ultrathink"] as const;
  type ClaudeEffort = (typeof claudeEfforts)[number];

  const parsedEffort =
    effort && claudeEfforts.includes(effort as ClaudeEffort) ? (effort as ClaudeEffort) : undefined;
  const parsedFastMode = fastMode ? fastMode === "true" : undefined;
  const parsedThinking = thinking ? thinking === "true" : undefined;

  if (parsedEffort === undefined && parsedFastMode === undefined && parsedThinking === undefined) {
    return undefined;
  }

  return {
    ...(parsedEffort !== undefined ? { effort: parsedEffort } : {}),
    ...(parsedFastMode !== undefined ? { fastMode: parsedFastMode } : {}),
    ...(parsedThinking !== undefined ? { thinking: parsedThinking } : {}),
  };
}

// ── Other Parsers ────────────────────────────────────────────────────────

function parseWorkflow(value: string): BridgeConfig["workflow"] {
  if (value === "task-queue") return "task-queue";
  return "coder-reviewer";
}

function parseRuntimeMode(value: string): BridgeConfig["runtimeMode"] {
  if (value === "approval-required") return "approval-required";
  return "full-access";
}

function parseLogLevel(value: string): LogLevel {
  const levels: readonly LogLevel[] = ["debug", "info", "warn", "error"] as const;
  return levels.includes(value as LogLevel) ? (value as LogLevel) : "info";
}
