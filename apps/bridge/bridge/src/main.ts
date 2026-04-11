/**
 * Project Mythos — standalone orchestrator with a live web UI.
 *
 * Starts an HTTP + WebSocket server that serves the dashboard.
 * The UI controls everything: pick a project, select models from
 * dropdowns, write the task, hit Start. Browse and resume old sessions.
 * Also fetches and displays live T3 Chat conversations.
 */

import { createBridgeServer } from "./bridgeServer.ts";
import { ResilientT3Client } from "./client.ts";
import { loadConfig } from "./config.ts";
import {
  createEventBus,
  type T3ThreadSummary,
  type UIMessage,
  type UIStartCommand,
} from "./eventBus.ts";
import { createHistoryStore, type HistorySession } from "./history.ts";
import { createLogger } from "./logger.ts";
import { createStateManager } from "./state.ts";
import type { BridgeConfig, ModelSelection, WorkflowContext } from "./types.ts";
import { getWorkflow } from "./workflows/index.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config.logLevel, config.logFile);
  const state = createStateManager(config.stateDir);
  const eventBus = createEventBus();
  const history = createHistoryStore(config.stateDir);

  // ── Start bridge UI server ────────────────────────────────────
  const bridgeServer = createBridgeServer(config.bridgePort, eventBus, log);
  await bridgeServer.start();

  // Publish history immediately so the UI shows it before T3 connects
  eventBus.setHistory(history.list(), null);

  // ── Connect to T3 server ──────────────────────────────────────
  const wsUrl = buildWsUrl(config);
  log.info(`Project Mythos started — UI at http://localhost:${config.bridgePort}`);
  log.info(`Connecting to T3 server at ${config.wsUrl}...`);

  const client = new ResilientT3Client(wsUrl, log);

  try {
    await client.connect();
    log.info("Connected to T3 server");

    eventBus.emitStatus({
      running: false,
      connected: true,
      phase: "idle",
      iteration: 0,
      maxIterations: 0,
      startedAt: null,
      error: null,
    });

    await refreshProjects(client, eventBus, log);
    await refreshModels(client, eventBus, log);
    await refreshT3Threads(client, eventBus, log);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Failed to connect: ${msg}`);
    eventBus.emitStatus({
      running: false,
      connected: false,
      phase: "error",
      iteration: 0,
      maxIterations: 0,
      startedAt: null,
      error: `Cannot connect to T3 server at ${config.wsUrl}. Is it running?`,
    });
  }

  // ── Active session tracking ───────────────────────────────────
  let activeSession: HistorySession | null = null;

  // ── Workflow runner ───────────────────────────────────────────
  const wf = { ac: null as AbortController | null, running: false };

  const runWorkflow = async (cmd: UIStartCommand): Promise<void> => {
    if (wf.running) {
      eventBus.emitMessage(sysMsg("A workflow is already running. Stop it first."));
      return;
    }
    if (!client.connected) {
      eventBus.emitMessage(sysMsg("Not connected to T3 server. Check your connection."));
      return;
    }

    wf.running = true;
    wf.ac = new AbortController();

    const coderModel: ModelSelection = { provider: cmd.coderProvider, model: cmd.coderModel };
    const reviewerModel: ModelSelection = {
      provider: cmd.reviewerProvider,
      model: cmd.reviewerModel,
    };

    const runConfig: BridgeConfig = {
      ...config,
      coderModel,
      reviewerModel,
      maxIterations: cmd.maxIterations,
      projectId: cmd.projectId,
    };

    // Start fresh — clear any old messages from the chat
    eventBus.replaceMessages([]);

    eventBus.setConfig({
      workflow: runConfig.workflow,
      coderModel: formatModel(coderModel),
      reviewerModel: formatModel(reviewerModel),
      maxIterations: cmd.maxIterations,
      task: cmd.task,
    });

    // Create history session
    activeSession = history.create(cmd.task, {
      projectId: cmd.projectId,
      coderProvider: cmd.coderProvider,
      coderModel: cmd.coderModel,
      reviewerProvider: cmd.reviewerProvider,
      reviewerModel: cmd.reviewerModel,
      maxIterations: cmd.maxIterations,
    });
    history.save(activeSession);
    eventBus.setHistory(history.list(), activeSession.id);

    const workflow = getWorkflow(runConfig);
    log.info(`Starting workflow: ${workflow.name}`);

    // Collect messages for history persistence
    const sessionMessages: UIMessage[] = [];
    const unsubMessages = eventBus.onEvent((event) => {
      if (event.type === "message") {
        sessionMessages.push(event.message);
        if (activeSession) {
          activeSession = {
            ...activeSession,
            messages: [...sessionMessages],
            updatedAt: new Date().toISOString(),
          };
          history.save(activeSession);
        }
      }
    });

    const configWithTask = { ...runConfig, _taskText: cmd.task };
    const ctx: WorkflowContext = {
      client,
      config: configWithTask,
      state,
      log,
      signal: wf.ac.signal,
      eventBus,
    };

    try {
      eventBus.emitStatus({
        running: true,
        connected: true,
        phase: "starting",
        iteration: 0,
        maxIterations: cmd.maxIterations,
        startedAt: new Date().toISOString(),
        error: null,
      });

      const result = await workflow.run(ctx);

      log.info("\u2550".repeat(50));
      log.info(`Workflow complete — ${result.summary}`);
      log.info("\u2550".repeat(50));

      eventBus.emitStatus({
        running: false,
        connected: client.connected,
        phase: "completed",
        iteration: result.iterations,
        maxIterations: cmd.maxIterations,
        startedAt: null,
        error: null,
      });
      eventBus.emitMessage(sysMsg(result.summary, result.iterations));

      if (activeSession) {
        activeSession = {
          ...activeSession,
          status: "completed",
          iterations: result.iterations,
          messages: [...sessionMessages, sysMsg(result.summary, result.iterations)],
          updatedAt: new Date().toISOString(),
        };
        history.save(activeSession);
        eventBus.setHistory(history.list(), activeSession.id);
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      log.error(`Workflow failed: ${detail}`);
      eventBus.emitStatus({
        running: false,
        connected: client.connected,
        phase: "error",
        iteration: 0,
        maxIterations: cmd.maxIterations,
        startedAt: null,
        error: detail,
      });
      eventBus.emitMessage(sysMsg(`Error: ${detail}`));

      if (activeSession) {
        activeSession = {
          ...activeSession,
          status: "error",
          messages: [...sessionMessages, sysMsg(`Error: ${detail}`)],
          updatedAt: new Date().toISOString(),
        };
        history.save(activeSession);
        eventBus.setHistory(history.list(), activeSession.id);
      }
    } finally {
      unsubMessages();
      wf.running = false;
      wf.ac = null;
    }
  };

  // ── UI command handling ───────────────────────────────────────
  eventBus.onCommand((cmd) => {
    if (cmd.type === "start") {
      void runWorkflow(cmd);
    } else if (cmd.type === "stop" && wf.ac) {
      log.info("Stop requested from UI");
      wf.ac.abort();
    } else if (cmd.type === "load-history") {
      if (wf.running) {
        eventBus.emitMessage(sysMsg("Stop the running workflow first."));
        return;
      }
      const session = history.load(cmd.id);
      if (!session) {
        log.warn(`Session ${cmd.id} not found on disk — refreshing history list`);
        eventBus.setHistory(history.list(), null);
        eventBus.replaceMessages([]);
        return;
      }
      activeSession = session;

      // Replace the chat with the loaded session's messages
      eventBus.replaceMessages(session.messages);
      eventBus.setConfig({
        workflow: "coder-reviewer",
        coderModel: `${session.config.coderProvider}/${session.config.coderModel}`,
        reviewerModel: `${session.config.reviewerProvider}/${session.config.reviewerModel}`,
        maxIterations: session.config.maxIterations,
        task: session.task,
      });
      eventBus.emitStatus({
        running: false,
        connected: client.connected,
        phase:
          session.status === "completed"
            ? "completed"
            : session.status === "error"
              ? "error"
              : "idle",
        iteration: session.iterations,
        maxIterations: session.config.maxIterations,
        startedAt: null,
        error: null,
      });
      eventBus.setHistory(history.list(), session.id);
      log.info(`Loaded session ${session.id} (${session.messages.length} messages)`);
    } else if (cmd.type === "delete-history") {
      if (wf.running) {
        eventBus.emitMessage(sysMsg("Stop the running workflow first."));
        return;
      }
      const removed = history.remove(cmd.id);
      if (removed) {
        log.info(`Deleted session ${cmd.id}`);
      } else {
        log.warn(`Session ${cmd.id} not found for deletion`);
      }
      // If the deleted session was the active one, clear the chat
      if (activeSession?.id === cmd.id) {
        activeSession = null;
        eventBus.replaceMessages([]);
        eventBus.setConfig(null);
        eventBus.emitStatus({
          running: false,
          connected: client.connected,
          phase: "idle",
          iteration: 0,
          maxIterations: 0,
          startedAt: null,
          error: null,
        });
      }
      eventBus.setHistory(history.list(), activeSession?.id ?? null);
    } else if (cmd.type === "refresh-threads") {
      if (client.connected) {
        void refreshT3Threads(client, eventBus, log);
      }
    } else if (cmd.type === "new-session") {
      if (wf.running) {
        eventBus.emitMessage(sysMsg("Stop the running workflow first."));
        return;
      }
      activeSession = null;
      // Wipe the chat and reset to idle
      eventBus.replaceMessages([]);
      eventBus.setConfig(null);
      eventBus.emitStatus({
        running: false,
        connected: client.connected,
        phase: "idle",
        iteration: 0,
        maxIterations: 0,
        startedAt: null,
        error: null,
      });
      eventBus.setHistory(history.list(), null);
      log.info("New session started");
    }
  });

  // ── Periodic T3 thread polling ─────────────────────────────────
  const T3_POLL_INTERVAL_MS = 15_000;
  const threadPollTimer = setInterval(() => {
    if (client.connected) {
      void refreshT3Threads(client, eventBus, log);
    }
  }, T3_POLL_INTERVAL_MS);

  // ── Keep alive ────────────────────────────────────────────────
  await waitForShutdown(log);
  clearInterval(threadPollTimer);
  wf.ac?.abort();
  await bridgeServer.stop();
  await client.disconnect();
  log.close();
}

// ── Helpers ───────────────────────────────────────────────────────────────

function sysMsg(text: string, iteration = 0): UIMessage {
  return {
    id: crypto.randomUUID(),
    agent: "system",
    text,
    timestamp: new Date().toISOString(),
    iteration,
  };
}

function buildWsUrl(config: BridgeConfig): string {
  const base = config.wsUrl.replace(/\/+$/, "");
  if (config.authToken) {
    return `${base}?token=${encodeURIComponent(config.authToken)}`;
  }
  return base;
}

function formatModel(sel: ModelSelection): string {
  const base = `${sel.provider}/${sel.model}`;
  const opts = sel.options;
  if (!opts) return base;
  const parts: string[] = [];
  if ("effort" in opts && opts.effort) parts.push(`effort=${opts.effort}`);
  if ("reasoningEffort" in opts && opts.reasoningEffort)
    parts.push(`effort=${opts.reasoningEffort}`);
  if ("thinking" in opts && opts.thinking !== undefined) parts.push(`thinking=${opts.thinking}`);
  if ("fastMode" in opts && opts.fastMode !== undefined) parts.push(`fast=${opts.fastMode}`);
  return parts.length > 0 ? `${base} (${parts.join(", ")})` : base;
}

async function refreshProjects(
  client: import("./types.ts").T3Client,
  eventBus: import("./eventBus.ts").EventBus,
  log: import("./types.ts").Logger,
): Promise<void> {
  try {
    const snapshot = await client.getSnapshot();
    const projects = snapshot.projects
      .filter((p) => !p.deletedAt)
      .map((p) => ({ id: p.id, title: p.title, workspaceRoot: p.workspaceRoot }));
    eventBus.setProjects(projects);
    log.info(`Found ${projects.length} project(s)`);
  } catch (err) {
    log.warn(`Could not fetch projects: ${err}`);
  }
}

async function refreshModels(
  client: import("./types.ts").T3Client,
  eventBus: import("./eventBus.ts").EventBus,
  log: import("./types.ts").Logger,
): Promise<void> {
  try {
    const serverConfig = await client.getServerConfig();
    const providerModels = serverConfig.providers
      .filter((p) => p.enabled && p.status === "ready")
      .map((p) => ({
        provider: p.provider,
        models: p.models.map((m) => ({ slug: m.slug, name: m.name })),
      }));
    eventBus.setProviderModels(providerModels);
    const total = providerModels.reduce((sum, p) => sum + p.models.length, 0);
    log.info(`Found ${total} model(s) across ${providerModels.length} provider(s)`);
  } catch (err) {
    log.warn(`Could not fetch models: ${err}`);
  }
}

async function refreshT3Threads(
  client: import("./types.ts").T3Client,
  eventBus: import("./eventBus.ts").EventBus,
  log: import("./types.ts").Logger,
): Promise<void> {
  try {
    const snapshot = await client.getSnapshot();
    const projectMap = new Map(
      snapshot.projects.filter((p) => !p.deletedAt).map((p) => [p.id, p.title]),
    );

    const threads: T3ThreadSummary[] = snapshot.threads.map((t) => {
      const lastAct =
        t.activities.length > 0 ? t.activities[t.activities.length - 1]!.occurredAt : null;
      return {
        id: t.id,
        projectId: t.projectId,
        projectTitle: projectMap.get(t.projectId) ?? "Unknown",
        title: t.title || `Thread ${t.id.slice(0, 8)}`,
        messageCount: t.messages.length,
        lastActivity: lastAct,
        sessionStatus: t.session?.status ?? null,
        turnState: t.latestTurn?.state ?? null,
        messages: t.messages.map((m) => ({
          id: m.id,
          role: m.role,
          text: m.text,
          streaming: m.streaming,
          turnId: m.turnId ?? null,
        })),
        activities: t.activities.map((a) => ({
          kind: a.kind,
          message: a.message,
          occurredAt: a.occurredAt,
        })),
      };
    });

    eventBus.setT3Threads(threads);
    log.debug(`Refreshed ${threads.length} T3 thread(s)`);
  } catch (err) {
    log.warn(`Could not fetch T3 threads: ${err}`);
  }
}

function waitForShutdown(log: import("./types.ts").Logger): Promise<void> {
  return new Promise((resolve) => {
    let requested = false;
    const handle = (sig: string) => {
      if (requested) {
        log.warn(`Second ${sig} — forcing exit`);
        process.exit(1);
      }
      requested = true;
      log.info(`${sig} received — shutting down...`);
      resolve();
    };
    process.on("SIGINT", () => handle("SIGINT"));
    process.on("SIGTERM", () => handle("SIGTERM"));
  });
}

main().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
