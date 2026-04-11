import { Fragment, useEffect, useReducer, useRef, useState } from "react";

// ── Protocol Types ───────────────────────────────────────────────────────

interface UIMessage {
  id: string;
  agent: "coder" | "reviewer" | "system" | "diff";
  text: string;
  timestamp: string;
  iteration: number;
}

interface UIStatus {
  running: boolean;
  connected: boolean;
  phase: string;
  iteration: number;
  maxIterations: number;
  startedAt: string | null;
  error: string | null;
}

interface UIProject {
  id: string;
  title: string;
  workspaceRoot: string;
}

interface UIProviderModels {
  provider: string;
  models: { slug: string; name: string }[];
}

interface ConfigSummary {
  workflow: string;
  coderModel: string;
  reviewerModel: string;
  maxIterations: number;
  task: string;
}

interface HistoryEntry {
  id: string;
  task: string;
  startedAt: string;
  status: string;
  iterations: number;
  messageCount: number;
}

// ── State ────────────────────────────────────────────────────────────────

interface UIStreamingActivity {
  kind: string;
  message: string;
}

interface UIStreamingMessage {
  id: string;
  agent: "coder" | "reviewer";
  text: string;
  timestamp: string;
  iteration: number;
  activities: UIStreamingActivity[];
}

interface AppState {
  wsConnected: boolean;
  status: UIStatus;
  messages: UIMessage[];
  streamingMessage: UIStreamingMessage | null;
  config: ConfigSummary | null;
  projects: UIProject[];
  providerModels: UIProviderModels[];
  history: HistoryEntry[];
  activeHistoryId: string | null;

  task: string;
  projectId: string;
  coderProvider: string;
  coderModel: string;
  reviewerProvider: string;
  reviewerModel: string;
  maxIterations: number;
}

type Action =
  | { type: "ws_connected" }
  | { type: "ws_disconnected" }
  | { type: "full_state"; data: Partial<AppState> }
  | { type: "new_message"; message: UIMessage }
  | { type: "status_update"; status: UIStatus }
  | { type: "config_update"; config: ConfigSummary }
  | { type: "projects_update"; projects: UIProject[] }
  | { type: "models_update"; providerModels: UIProviderModels[] }
  | { type: "history_update"; history: HistoryEntry[]; activeHistoryId: string | null }
  | { type: "set_field"; field: string; value: string | number }
  | { type: "reset_messages"; messages: UIMessage[] }
  | { type: "streaming_update"; message: UIStreamingMessage | null };

const INITIAL_STATUS: UIStatus = {
  running: false,
  connected: false,
  phase: "idle",
  iteration: 0,
  maxIterations: 0,
  startedAt: null,
  error: null,
};

const INITIAL: AppState = {
  wsConnected: false,
  status: INITIAL_STATUS,
  messages: [],
  streamingMessage: null,
  config: null,
  projects: [],
  providerModels: [],
  history: [],
  activeHistoryId: null,
  task: "",
  projectId: "",
  coderProvider: "claudeAgent",
  coderModel: "claude-sonnet-4-6",
  reviewerProvider: "claudeAgent",
  reviewerModel: "claude-sonnet-4-6",
  maxIterations: 20,
};

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "ws_connected":
      return { ...state, wsConnected: true };
    case "ws_disconnected":
      return { ...state, wsConnected: false };
    case "full_state": {
      const d = action.data;
      return {
        ...state,
        messages: d.messages ?? state.messages,
        streamingMessage:
          d.streamingMessage !== undefined ? d.streamingMessage : state.streamingMessage,
        status: d.status ?? state.status,
        config: d.config !== undefined ? d.config : state.config,
        projects: d.projects ?? state.projects,
        providerModels: d.providerModels ?? state.providerModels,
        history: d.history ?? state.history,
        activeHistoryId:
          d.activeHistoryId !== undefined ? d.activeHistoryId : state.activeHistoryId,
        projectId: state.projectId || (d.projects ?? [])[0]?.id || "",
        coderModel:
          state.coderModel || firstModelSlug(d.providerModels, "claudeAgent") || state.coderModel,
        reviewerModel:
          state.reviewerModel ||
          firstModelSlug(d.providerModels, "claudeAgent") ||
          state.reviewerModel,
      };
    }
    case "new_message":
      return { ...state, messages: [...state.messages, action.message] };
    case "status_update":
      return { ...state, status: action.status };
    case "config_update":
      return { ...state, config: action.config };
    case "projects_update":
      return {
        ...state,
        projects: action.projects,
        projectId: state.projectId || action.projects[0]?.id || "",
      };
    case "models_update":
      return { ...state, providerModels: action.providerModels };
    case "history_update":
      return { ...state, history: action.history, activeHistoryId: action.activeHistoryId };
    case "set_field":
      return { ...state, [action.field]: action.value };
    case "reset_messages":
      return { ...state, messages: action.messages };
    case "streaming_update":
      return { ...state, streamingMessage: action.message };
    default:
      return state;
  }
}

function firstModelSlug(pm: UIProviderModels[] | undefined, provider: string): string {
  if (!pm) return "";
  const p = pm.find((x) => x.provider === provider);
  return p?.models[0]?.slug ?? "";
}

// ── App ──────────────────────────────────────────────────────────────────

export function App() {
  const [s, dispatch] = useReducer(reducer, INITIAL);
  const wsRef = useRef<WebSocket | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let dead = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      if (dead) return;
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${protocol}//${location.host}/bridge-ws`);
      ws.addEventListener("open", () => {
        wsRef.current = ws;
        dispatch({ type: "ws_connected" });
      });
      ws.addEventListener("close", () => {
        wsRef.current = null;
        dispatch({ type: "ws_disconnected" });
        if (!dead) reconnectTimer = setTimeout(connect, 2000);
      });
      ws.addEventListener("message", (e) => {
        try {
          const ev = JSON.parse(e.data as string);
          if (ev.type === "state") dispatch({ type: "full_state", data: ev });
          else if (ev.type === "message") dispatch({ type: "new_message", message: ev.message });
          else if (ev.type === "status") dispatch({ type: "status_update", status: ev.status });
          else if (ev.type === "config") dispatch({ type: "config_update", config: ev.config });
          else if (ev.type === "projects")
            dispatch({ type: "projects_update", projects: ev.projects });
          else if (ev.type === "providerModels")
            dispatch({ type: "models_update", providerModels: ev.providerModels });
          else if (ev.type === "history")
            dispatch({
              type: "history_update",
              history: ev.history,
              activeHistoryId: ev.activeHistoryId,
            });
          else if (ev.type === "reset") dispatch({ type: "reset_messages", messages: ev.messages });
          else if (ev.type === "streaming")
            dispatch({ type: "streaming_update", message: ev.message });
        } catch {
          /* ignore */
        }
      });
    }

    connect();
    return () => {
      dead = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [s.messages.length, s.status.phase, s.streamingMessage?.text?.length]);

  const send = (cmd: Record<string, unknown>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify(cmd));
  };

  const handleStart = () => {
    if (!s.task.trim() || !s.projectId) return;
    send({
      type: "start",
      task: s.task.trim(),
      projectId: s.projectId,
      coderProvider: s.coderProvider,
      coderModel: s.coderModel,
      reviewerProvider: s.reviewerProvider,
      reviewerModel: s.reviewerModel,
      maxIterations: s.maxIterations,
    });
  };

  const setField = (field: string, value: string | number) =>
    dispatch({ type: "set_field", field, value });

  return (
    <div className="app">
      <Header status={s.status} wsConnected={s.wsConnected} />
      <div className="app-body">
        {/* History panel */}
        <aside className="history-panel">
          <div className="history-header">
            <span className="sidebar-label">Sessions</span>
            <button
              className="btn-icon"
              title="New session"
              onClick={() => send({ type: "new-session" })}
              disabled={s.status.running}
            >
              +
            </button>
          </div>
          <div className="history-list">
            {s.history.map((h) => (
              <div
                key={h.id}
                className={`history-item ${h.id === s.activeHistoryId ? "history-item--active" : ""}`}
              >
                <button
                  className="history-item-body"
                  onClick={() => send({ type: "load-history", id: h.id })}
                  disabled={s.status.running}
                >
                  <div className="history-task">
                    {h.task.slice(0, 60)}
                    {h.task.length > 60 ? "..." : ""}
                  </div>
                  <div className="history-meta">
                    <StatusBadge status={h.status} />
                    <span>{h.iterations} iter</span>
                    <span>{formatDate(h.startedAt)}</span>
                  </div>
                </button>
                <button
                  className="history-delete"
                  title="Delete session"
                  onClick={(e) => {
                    e.stopPropagation();
                    send({ type: "delete-history", id: h.id });
                  }}
                  disabled={s.status.running}
                >
                  {"\u00D7"}
                </button>
              </div>
            ))}
            {s.history.length === 0 && (
              <div className="hint" style={{ padding: "12px" }}>
                No sessions yet
              </div>
            )}
          </div>
        </aside>

        {/* Config sidebar */}
        <aside className="sidebar">
          <div className="sidebar-section">
            <label className="sidebar-label">Project</label>
            {s.projects.length > 0 ? (
              <select
                className="select-input"
                value={s.projectId}
                onChange={(e) => setField("projectId", e.target.value)}
                disabled={s.status.running}
              >
                {s.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
              </select>
            ) : (
              <div className="hint">{s.status.connected ? "No projects" : "Waiting for T3..."}</div>
            )}
          </div>

          <div className="sidebar-section">
            <label className="sidebar-label">Task</label>
            <textarea
              className="task-input"
              placeholder="Describe what you want to build..."
              value={s.task}
              onChange={(e) => setField("task", e.target.value)}
              disabled={s.status.running}
              rows={4}
            />
          </div>

          <ModelPicker
            label="Coder"
            provider={s.coderProvider}
            model={s.coderModel}
            providerModels={s.providerModels}
            disabled={s.status.running}
            onProviderChange={(v) => {
              setField("coderProvider", v);
              setField("coderModel", firstModelSlug(s.providerModels, v) || "");
            }}
            onModelChange={(v) => setField("coderModel", v)}
          />

          <ModelPicker
            label="Reviewer"
            provider={s.reviewerProvider}
            model={s.reviewerModel}
            providerModels={s.providerModels}
            disabled={s.status.running}
            onProviderChange={(v) => {
              setField("reviewerProvider", v);
              setField("reviewerModel", firstModelSlug(s.providerModels, v) || "");
            }}
            onModelChange={(v) => setField("reviewerModel", v)}
          />

          <div className="sidebar-section">
            <label className="sidebar-label">Max iterations</label>
            <input
              className="text-input"
              type="number"
              min={1}
              max={100}
              value={s.maxIterations}
              onChange={(e) => setField("maxIterations", Number(e.target.value) || 1)}
              disabled={s.status.running}
            />
          </div>

          <div className="sidebar-section">
            <div className="btn-group">
              <button
                className="btn btn-start"
                onClick={handleStart}
                disabled={s.status.running || !s.status.connected || !s.task.trim() || !s.projectId}
              >
                {s.status.running ? "Running..." : "Start"}
              </button>
              <button
                className="btn btn-stop"
                onClick={() => send({ type: "stop" })}
                disabled={!s.status.running}
              >
                Stop
              </button>
            </div>
          </div>

          {(s.status.running || s.config) && (
            <div className="sidebar-section">
              <label className="sidebar-label">Progress</label>
              <div className="stat-grid">
                <StatItem
                  label="Iteration"
                  value={`${s.status.iteration}/${s.status.maxIterations || s.maxIterations}`}
                />
                <StatItem label="Elapsed" value={elapsed(s.status.startedAt)} />
              </div>
            </div>
          )}
        </aside>

        {/* Chat */}
        <div className="chat-container">
          {s.status.running && s.status.maxIterations > 0 && (
            <div className="progress-track">
              <div
                className="progress-fill"
                style={{ width: `${(s.status.iteration / s.status.maxIterations) * 100}%` }}
              />
            </div>
          )}
          <ChatView
            messages={s.messages}
            status={s.status}
            streamingMessage={s.streamingMessage}
            chatEndRef={chatEndRef}
          />
        </div>
      </div>
    </div>
  );
}

// ── ModelPicker ──────────────────────────────────────────────────────────

function ModelPicker({
  label,
  provider,
  model,
  providerModels,
  disabled,
  onProviderChange,
  onModelChange,
}: {
  label: string;
  provider: string;
  model: string;
  providerModels: UIProviderModels[];
  disabled: boolean;
  onProviderChange: (v: string) => void;
  onModelChange: (v: string) => void;
}) {
  const providers =
    providerModels.length > 0
      ? providerModels
      : [
          { provider: "claudeAgent", models: [] },
          { provider: "codex", models: [] },
        ];
  const models = providerModels.find((p) => p.provider === provider)?.models ?? [];

  return (
    <div className="sidebar-section">
      <label className="sidebar-label">{label}</label>
      <div className="model-row">
        <select
          className="select-input select-sm"
          value={provider}
          onChange={(e) => onProviderChange(e.target.value)}
          disabled={disabled}
        >
          {providers.map((p) => (
            <option key={p.provider} value={p.provider}>
              {p.provider === "claudeAgent" ? "Claude" : "Codex"}
            </option>
          ))}
        </select>
        {models.length > 0 ? (
          <select
            className="select-input"
            value={model}
            onChange={(e) => onModelChange(e.target.value)}
            disabled={disabled}
          >
            {models.map((m) => (
              <option key={m.slug} value={m.slug}>
                {m.name}
              </option>
            ))}
          </select>
        ) : (
          <input
            className="text-input"
            value={model}
            onChange={(e) => onModelChange(e.target.value)}
            disabled={disabled}
            placeholder="model slug"
          />
        )}
      </div>
    </div>
  );
}

// ── Header ───────────────────────────────────────────────────────────────

function Header({ status, wsConnected }: { status: UIStatus; wsConnected: boolean }) {
  const isConnected = wsConnected && status.connected;

  return (
    <header className="header">
      <div className="header-brand">
        <div className="header-logo">M</div>
        <span className="header-title">Project Mythos</span>
      </div>

      <div className="header-center">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {status.running && (
            <>
              <span className={`status-dot status-dot--${status.phase}`} />
              <span className="header-phase">{phaseLabel(status.phase)}</span>
              {status.iteration > 0 && (
                <span className="header-iter">
                  {status.iteration}/{status.maxIterations}
                </span>
              )}
            </>
          )}
          {!status.running && status.phase === "completed" && (
            <span className="header-done">Complete</span>
          )}
          {!status.running && status.phase === "error" && (
            <span className="header-error">Error</span>
          )}
          {!status.running &&
            status.phase !== "completed" &&
            status.phase !== "error" &&
            status.connected && <span className="header-idle">Ready</span>}
        </div>
      </div>

      <div className="header-right">
        <div
          className={`header-connection ${isConnected ? "header-connection--ok" : "header-connection--err"}`}
        >
          <span className={`conn-dot ${isConnected ? "conn-dot--ok" : "conn-dot--err"}`} />
          <span>{!wsConnected ? "Offline" : !status.connected ? "T3 offline" : "Connected"}</span>
        </div>
      </div>
    </header>
  );
}

function phaseLabel(phase: string): string {
  switch (phase) {
    case "starting":
      return "Starting...";
    case "coding":
      return "Coder is working";
    case "reviewing":
      return "Reviewer is analyzing";
    case "fetching-diff":
      return "Fetching diff";
    case "completed":
      return "Complete";
    case "error":
      return "Error";
    case "interrupted":
      return "Interrupted";
    default:
      return "Idle";
  }
}

// ── Shared Components ────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === "completed" || status === "ready"
      ? "badge-ok"
      : status === "error"
        ? "badge-err"
        : status === "running"
          ? "badge-run"
          : "badge-muted";
  return <span className={`badge ${cls}`}>{status}</span>;
}

function StatItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat-item">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

function elapsed(startedAt: string | null): string {
  if (!startedAt) return "--";
  const secs = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
  const mins = Math.floor(secs / 60);
  return mins < 1 ? `${secs}s` : `${mins}m ${secs % 60}s`;
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

// ── Chat ─────────────────────────────────────────────────────────────────

function ChatView({
  messages,
  status,
  streamingMessage,
  chatEndRef,
}: {
  messages: UIMessage[];
  status: UIStatus;
  streamingMessage: UIStreamingMessage | null;
  chatEndRef: React.RefObject<HTMLDivElement | null>;
}) {
  if (messages.length === 0 && !status.running && !streamingMessage) {
    return (
      <div className="chat-view">
        <div className="chat-empty">
          {status.error ? (
            <>
              <div className="chat-empty-icon chat-empty-icon--error">{"\u26A0"}</div>
              <div className="chat-empty-title">Connection Error</div>
              <div className="chat-empty-text">{status.error}</div>
            </>
          ) : (
            <>
              <div className="chat-empty-icon">{"\u26A1"}</div>
              <div className="chat-empty-title">Ready to go</div>
              <div className="chat-empty-text">
                Pick a project, configure your agents, describe the task, and hit Start.
              </div>
            </>
          )}
        </div>
        <div ref={chatEndRef} />
      </div>
    );
  }

  let lastIter = 0;
  return (
    <div className="chat-view">
      {messages.map((msg) => {
        const showDiv = msg.iteration > lastIter && msg.iteration > 0;
        if (msg.iteration > 0) lastIter = msg.iteration;
        return (
          <Fragment key={msg.id}>
            {showDiv && (
              <div className="iter-divider">
                <span className="iter-line" />
                <span className="iter-badge">
                  Iteration {msg.iteration} of {status.maxIterations}
                </span>
                <span className="iter-line" />
              </div>
            )}
            <MessageBubble message={msg} />
          </Fragment>
        );
      })}
      {streamingMessage && <StreamingBubble msg={streamingMessage} />}
      {status.running &&
        !streamingMessage &&
        (status.phase === "coding" || status.phase === "reviewing") && (
          <div
            className={`thinking ${status.phase === "coding" ? "thinking--coder" : "thinking--reviewer"}`}
          >
            <span className="thinking-label">
              {status.phase === "coding" ? "Coder" : "Reviewer"}
            </span>
            <span className="thinking-dots">
              <span />
              <span />
              <span />
            </span>
          </div>
        )}
      <div ref={chatEndRef} />
    </div>
  );
}

function StreamingBubble({ msg }: { msg: UIStreamingMessage }) {
  const isCoder = msg.agent === "coder";
  const [showActivities, setShowActivities] = useState(false);
  const visibleActivities = msg.activities.filter(
    (a) => a.kind !== "context-window.updated" && a.kind !== "turn.plan.updated",
  );

  return (
    <div className={`msg ${isCoder ? "msg-coder" : "msg-reviewer"} msg-streaming`}>
      <div className="msg-head">
        <span className="msg-agent">{isCoder ? "Coder" : "Reviewer"}</span>
        <span className="streaming-indicator">
          <span className="streaming-dot" />
          streaming
        </span>
      </div>
      {visibleActivities.length > 0 && (
        <div className="streaming-activities">
          <button
            className="streaming-activities-toggle"
            onClick={() => setShowActivities(!showActivities)}
          >
            {visibleActivities.length} activit{visibleActivities.length === 1 ? "y" : "ies"}
            <span className="diff-chevron">{showActivities ? "\u25BE" : "\u25B8"}</span>
          </button>
          {showActivities && (
            <div className="streaming-activities-list">
              {visibleActivities.map((a, i) => (
                <div key={`act-${i}-${a.kind}`} className="streaming-activity-item">
                  <span className="activity-kind">{formatActivityKind(a.kind)}</span>
                  <span className="activity-msg">{a.message}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {msg.text ? (
        <div className="msg-body">
          <MessageContent text={msg.text} />
        </div>
      ) : (
        <div className="msg-body msg-body--empty">
          <span className="thinking-dots">
            <span />
            <span />
            <span />
          </span>
        </div>
      )}
    </div>
  );
}

function formatActivityKind(kind: string): string {
  return kind
    .replace(/\./g, " ")
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function MessageBubble({ message }: { message: UIMessage }) {
  if (message.agent === "diff") return <DiffBlock diff={message.text} />;
  if (message.agent === "system") return <div className="msg msg-system">{message.text}</div>;
  const isCoder = message.agent === "coder";
  return (
    <div className={`msg ${isCoder ? "msg-coder" : "msg-reviewer"}`}>
      <div className="msg-head">
        <span className="msg-agent">{isCoder ? "Coder" : "Reviewer"}</span>
        <span className="msg-time">{formatTime(message.timestamp)}</span>
      </div>
      <div className="msg-body">
        <MessageContent text={message.text} />
      </div>
    </div>
  );
}

function MessageContent({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const LIMIT = 600;
  const isLong = text.length > LIMIT;
  const display = expanded || !isLong ? text : text.slice(0, LIMIT);
  const segments = display.split(/(```[\s\S]*?```)/g);

  return (
    <>
      {segments.map((seg, i) => {
        const key = `seg-${i}-${seg.length}`;
        if (seg.startsWith("```")) {
          const code = seg.replace(/^```\w*\n?/, "").replace(/\n?```$/, "");
          return (
            <pre key={key} className="code-block">
              {code}
            </pre>
          );
        }
        return (
          <span key={key}>
            {seg.split("\n").map((line, j) => (
              <Fragment key={`ln-${j}-${line.length}`}>
                {j > 0 && <br />}
                {line}
              </Fragment>
            ))}
          </span>
        );
      })}
      {isLong && (
        <button className="expand-btn" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show less" : `Show more (${text.length - LIMIT} chars)`}
        </button>
      )}
    </>
  );
}

function DiffBlock({ diff }: { diff: string }) {
  const [expanded, setExpanded] = useState(false);
  const lines = diff.split("\n");
  const addCount = lines.filter((l) => l.startsWith("+")).length;
  const delCount = lines.filter((l) => l.startsWith("-")).length;

  return (
    <div className="diff-block">
      <button className="diff-header" onClick={() => setExpanded(!expanded)}>
        <span className="diff-title">Code Changes</span>
        <span className="diff-stats">
          <span className="diff-stat-add">+{addCount}</span>
          <span className="diff-stat-del">-{delCount}</span>
        </span>
        <span className="diff-chevron">{expanded ? "\u25BE" : "\u25B8"}</span>
      </button>
      {expanded && (
        <pre className="diff-content">
          {lines.map((line, i) => (
            <div key={`d-${i}-${line.length}`} className={diffLineClass(line)}>
              {line}
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}

function diffLineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "diff-line diff-meta";
  if (line.startsWith("+")) return "diff-line diff-add";
  if (line.startsWith("-")) return "diff-line diff-del";
  if (line.startsWith("@@")) return "diff-line diff-hunk";
  return "diff-line";
}
