/**
 * Relay Engine
 *
 * Manages chat pairs that ping-pong messages between two T3 threads.
 * Persists connection info and pair metadata to disk so they survive restarts.
 * Hydrates message histories from T3 snapshots on reconnect.
 */

import { T3Client } from "./t3-client";
import { loadState, saveState, loadTemplates, saveTemplates, type PersistedPair, type PersistedState } from "./store";
import type {
  ChatPair,
  ModelSelection,
  Modification,
  PairConfig,
  RelayMessage,
  RelayTemplate,
  ServerMessage,
  T3Message,
  T3Project,
  T3Thread,
  ThreadSummary,
} from "./types";

type BroadcastFn = (msg: ServerMessage) => void;
type PairSide = "A" | "B";

interface PendingTurnState {
  pairId: string;
  side: PairSide;
  text: string;
  /**
   * Has the T3 turn actually entered "running" state since we dispatched?
   * We must see this transition before accepting a "completed" state,
   * otherwise we'd pick up the stale completion from the PREVIOUS turn.
   */
  seenRunning: boolean;
  /**
   * The turn ID we've confirmed as ours (set when we first see "running").
   * Used to avoid processing a different turn's completion.
   */
  activeTurnId: string | null;
}

interface ParsedUsageLimit {
  message: string;
  resumeAt: string | null;
}

export class RelayEngine {
  private pairs: Map<string, ChatPair> = new Map();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;
  private t3Client: T3Client | null = null;
  private broadcast: BroadcastFn;
  private cachedProjects: T3Project[] = [];
  private cachedThreads: ThreadSummary[] = [];
  private templates: RelayTemplate[] = [];
  private tickInFlight = false;
  private lastSnapshotSequence = -1;

  /** Tracks which turn we're waiting on, per thread */
  private pendingTurns: Map<string, PendingTurnState> = new Map();

  private pollDegraded = false;
  private successesSinceLastFailure = 0;
  private static readonly RECOVERY_THRESHOLD = 3;
  private static readonly MAX_CONSECUTIVE_FAILURES = 15;
  private static readonly POLL_INTERVAL_MS = 2_000;
  /** Background refresh for projects/threads when no pairs are actively running. */
  private static readonly REFRESH_INTERVAL_MS = 10_000;
  private static readonly DEFAULT_USAGE_LIMIT_RETRY_MS = 5 * 60 * 1000;
  private static readonly MAX_TIMER_DELAY_MS = 2_147_483_647;

  constructor(broadcast: BroadcastFn) {
    this.broadcast = broadcast;
    this.templates = loadTemplates();
  }

  // ─── Boot: restore persisted state ───

  async boot(): Promise<void> {
    const state = loadState();
    if (!state.connection) {
      console.log("[relay] No saved connection found");
      return;
    }

    console.log(`[relay] Restoring saved connection to ${state.connection.url}...`);

    try {
      const client = new T3Client(state.connection.url);
      await client.restoreToken(state.connection.bearerToken);
      this.t3Client = client;

      const snapshot = await client.getSnapshot();
      this.cachedProjects = snapshot.projects.map((p) => ({
        id: p.id,
        title: p.title,
        workspaceRoot: p.workspaceRoot,
      }));

      this.hydrateFromPersisted(state.pairs, snapshot.threads);
      this.cachedThreads = this.buildThreadSummaries(snapshot.threads);
      this.lastSnapshotSequence = snapshot.snapshotSequence;
      await this.restoreRuntimeState(snapshot.threads);
      this.startBackgroundRefresh();

      this.broadcast({
        type: "connection-status",
        t3Connected: true,
        t3Url: client.url,
      });
      this.broadcastFullSnapshot();

      console.log(
        `[relay] Restored: ${this.pairs.size} pairs, ${this.cachedProjects.length} projects, ${this.cachedThreads.length} threads`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[relay] Could not restore saved session: ${msg}`);
      this.persist();
    }
  }

  // ─── T3 Connection ───

  get isConnected(): boolean {
    return this.t3Client?.connected ?? false;
  }

  get t3Url(): string | null {
    return this.t3Client?.url ?? null;
  }

  async connectToT3(url: string, credential: string): Promise<void> {
    const client = new T3Client(url);
    await client.authenticate(credential);
    this.t3Client = client;

    const snapshot = await client.getSnapshot();
    this.cachedProjects = snapshot.projects.map((p) => ({
      id: p.id,
      title: p.title,
      workspaceRoot: p.workspaceRoot,
    }));

    const state = loadState();
    if (state.pairs.length > 0) {
      this.hydrateFromPersisted(state.pairs, snapshot.threads);
    }

    this.cachedThreads = this.buildThreadSummaries(snapshot.threads);
    this.lastSnapshotSequence = snapshot.snapshotSequence;
    await this.restoreRuntimeState(snapshot.threads);
    this.persist();
    this.startBackgroundRefresh();

    this.broadcast({
      type: "connection-status",
      t3Connected: true,
      t3Url: url,
    });
    this.broadcastFullSnapshot();

    console.log(
      `[relay] Connected to T3 at ${url}, ${this.cachedProjects.length} projects, ${this.cachedThreads.length} threads`,
    );
  }

  disconnectFromT3(options?: { preserveRuntime?: boolean }): void {
    if (!options?.preserveRuntime) {
      for (const pair of this.pairs.values()) {
        if (pair.status === "running") {
          pair.status = "stopped";
          pair.waitingFor = null;
          pair.pendingDispatch = null;
          pair.resumeAt = null;
          delete pair.error;
          this.broadcastPairUpdate(pair);
        }
      }
    }

    this.pendingTurns.clear();
    this.stopPolling();
    this.stopBackgroundRefresh();
    this.stopResumeTimer();
    this.t3Client?.disconnect();
    this.t3Client = null;
    this.cachedThreads = [];
    this.tickInFlight = false;
    this.lastSnapshotSequence = -1;

    this.persist();

    this.broadcast({
      type: "connection-status",
      t3Connected: false,
      t3Url: null,
    });
  }

  // ─── Pair Management ───

  async createPair(config: PairConfig): Promise<ChatPair> {
    if (!this.t3Client) throw new Error("Not connected to T3");

    const pairId = crypto.randomUUID();
    const threadAId = `relay-a-${pairId.slice(0, 8)}`;
    const threadBId = `relay-b-${pairId.slice(0, 8)}`;

    await this.t3Client.createThread({
      threadId: threadAId,
      projectId: config.projectId,
      title: `[Relay] ${config.name} - ${config.labelA}`,
      modelSelection: this.modelForSide(config, "A"),
      runtimeMode: config.runtimeMode,
    });

    await this.t3Client.createThread({
      threadId: threadBId,
      projectId: config.projectId,
      title: `[Relay] ${config.name} - ${config.labelB}`,
      modelSelection: this.modelForSide(config, "B"),
      runtimeMode: config.runtimeMode,
    });

    const pair: ChatPair = {
      id: pairId,
      name: config.name,
      status: "idle",
      threadA: { id: threadAId, label: config.labelA },
      threadB: { id: threadBId, label: config.labelB },
      config,
      messages: [],
      turnCount: 0,
      waitingFor: null,
      pendingDispatch: null,
      resumeAt: null,
      createdAt: new Date().toISOString(),
    };

    this.pairs.set(pairId, pair);
    this.persist();
    this.broadcast({ type: "pair-created", pair });

    console.log(`[relay] Created pair "${config.name}" (${pairId}): ${threadAId} <-> ${threadBId}`);
    return pair;
  }

  async startPair(pairId: string): Promise<void> {
    const pair = this.pairs.get(pairId);
    if (!pair) throw new Error(`Pair ${pairId} not found`);
    if (!this.t3Client) throw new Error("Not connected to T3");
    if (pair.status === "running") return;

    if (!pair.pendingDispatch) {
      const initialMsg: RelayMessage = {
        id: crypto.randomUUID(),
        source: "system",
        role: "user",
        originalText: pair.config.initialMessage,
        timestamp: new Date().toISOString(),
        turnNumber: pair.turnCount,
      };
      pair.messages.push(initialMsg);
      this.broadcast({ type: "new-message", pairId, message: initialMsg });

      pair.pendingDispatch = {
        side: "A",
        threadId: pair.threadA.id,
        text: pair.config.initialMessage,
        reason: "initial",
        sourceSide: null,
        dispatchedAt: null,
        retryCount: 0,
      };
    }

    pair.status = "running";
    pair.waitingFor = pair.pendingDispatch.side;
    pair.resumeAt = null;
    delete pair.error;
    this.broadcastPairUpdate(pair);

    await this.dispatchPendingTurn(pair);
  }

  async sendMessage(pairId: string, text: string): Promise<void> {
    const pair = this.pairs.get(pairId);
    if (!pair) throw new Error(`Pair ${pairId} not found`);
    if (!this.t3Client) throw new Error("Not connected to T3");
    if (pair.status === "running") throw new Error("Pair is already running");

    // Record the user's message in the chat
    const userMsg: RelayMessage = {
      id: crypto.randomUUID(),
      source: "system",
      role: "user",
      originalText: text,
      timestamp: new Date().toISOString(),
      turnNumber: pair.turnCount,
    };
    pair.messages.push(userMsg);
    this.broadcast({ type: "new-message", pairId, message: userMsg });

    // Set up dispatch to Thread A
    pair.pendingDispatch = {
      side: "A",
      threadId: pair.threadA.id,
      text,
      reason: "relay",
      sourceSide: null,
      dispatchedAt: null,
      retryCount: 0,
    };

    pair.status = "running";
    pair.waitingFor = "A";
    pair.resumeAt = null;
    delete pair.error;
    this.broadcastPairUpdate(pair);

    await this.dispatchPendingTurn(pair);

    console.log(`[relay] User injected message into pair "${pair.name}" → Thread A`);
  }

  async stopPair(pairId: string): Promise<void> {
    const pair = this.pairs.get(pairId);
    if (!pair) return;

    if (pair.waitingFor && this.t3Client) {
      const threadId = pair.waitingFor === "A" ? pair.threadA.id : pair.threadB.id;
      try {
        await this.t3Client.interruptTurn(threadId);
      } catch {
        // best-effort
      }
    }

    this.pendingTurns.delete(pair.threadA.id);
    this.pendingTurns.delete(pair.threadB.id);
    pair.status = "stopped";
    pair.waitingFor = null;
    pair.pendingDispatch = null;
    pair.resumeAt = null;
    delete pair.error;
    this.broadcastPairUpdate(pair);

    const stopMsg: RelayMessage = {
      id: crypto.randomUUID(),
      source: "system",
      role: "system",
      originalText: "Relay stopped by user.",
      timestamp: new Date().toISOString(),
      turnNumber: pair.turnCount,
    };
    pair.messages.push(stopMsg);
    this.broadcast({ type: "new-message", pairId, message: stopMsg });

    if (this.pendingTurns.size === 0) this.stopPolling();
    this.scheduleNextResumeCheck();
    console.log(`[relay] Stopped pair "${pair.name}"`);
  }

  async deletePair(pairId: string): Promise<void> {
    await this.stopPair(pairId);

    const pair = this.pairs.get(pairId);
    if (pair && this.t3Client) {
      try {
        await this.t3Client.deleteThread(pair.threadA.id);
      } catch {
        // best-effort
      }
      try {
        await this.t3Client.deleteThread(pair.threadB.id);
      } catch {
        // best-effort
      }
    }

    this.pairs.delete(pairId);
    this.persist();
    this.broadcast({ type: "pair-removed", pairId });
    console.log(`[relay] Deleted pair ${pairId}`);
  }

  getSnapshot(): { pairs: ChatPair[]; projects: T3Project[]; threads: ThreadSummary[]; templates: RelayTemplate[] } {
    return {
      pairs: Array.from(this.pairs.values()),
      projects: this.cachedProjects,
      threads: this.cachedThreads,
      templates: this.templates,
    };
  }

  // ─── Templates ───

  saveTemplate(template: RelayTemplate): void {
    const idx = this.templates.findIndex((t) => t.id === template.id);
    if (idx >= 0) {
      this.templates[idx] = template;
    } else {
      this.templates.push(template);
    }
    saveTemplates(this.templates);
    this.broadcast({ type: "templates-updated", templates: this.templates });
  }

  deleteTemplate(templateId: string): void {
    this.templates = this.templates.filter((t) => t.id !== templateId);
    saveTemplates(this.templates);
    this.broadcast({ type: "templates-updated", templates: this.templates });
  }

  importTemplates(incoming: RelayTemplate[]): void {
    for (const t of incoming) {
      const idx = this.templates.findIndex((existing) => existing.id === t.id);
      if (idx >= 0) {
        this.templates[idx] = t;
      } else {
        this.templates.push(t);
      }
    }
    saveTemplates(this.templates);
    this.broadcast({ type: "templates-updated", templates: this.templates });
  }

  // ─── Polling Loop ───

  private ensurePolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => void this.tick(), RelayEngine.POLL_INTERVAL_MS);
    this.pollDegraded = false;
    this.successesSinceLastFailure = 0;
    console.log(`[relay] Started polling T3 snapshot every ${RelayEngine.POLL_INTERVAL_MS}ms`);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
      console.log("[relay] Stopped polling");
    }
  }

  // ─── Background Refresh (projects/threads stay in sync while idle) ───

  private startBackgroundRefresh(): void {
    this.stopBackgroundRefresh();
    this.refreshTimer = setInterval(
      () => void this.refreshSnapshot(),
      RelayEngine.REFRESH_INTERVAL_MS,
    );
  }

  private stopBackgroundRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private async refreshSnapshot(): Promise<void> {
    if (!this.t3Client) return;
    // Skip if the fast poll loop is active — it already refreshes the snapshot.
    if (this.pollTimer) return;

    try {
      const snapshot = await this.t3Client.getSnapshot();

      // Only broadcast if something actually changed
      if (snapshot.snapshotSequence === this.lastSnapshotSequence) return;
      this.lastSnapshotSequence = snapshot.snapshotSequence;

      this.cachedProjects = snapshot.projects.map((p) => ({
        id: p.id,
        title: p.title,
        workspaceRoot: p.workspaceRoot,
      }));
      this.cachedThreads = this.buildThreadSummaries(snapshot.threads);

      this.broadcastFullSnapshot();
    } catch {
      // Silent — background refresh is best-effort
    }
  }

  // ─── Active Turn Polling ───

  private async tick(): Promise<void> {
    if (this.tickInFlight || !this.t3Client || this.pendingTurns.size === 0) return;
    this.tickInFlight = true;

    try {
      let snapshot;
      try {
        snapshot = await this.t3Client.getSnapshot();
      } catch (err) {
        const failures = this.t3Client.consecutiveFailures;
        this.successesSinceLastFailure = 0;

        if (!this.pollDegraded) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[relay] T3 poll failed (will retry): ${msg}`);
          this.pollDegraded = true;
        }

        if (failures >= RelayEngine.MAX_CONSECUTIVE_FAILURES) {
          console.error(`[relay] ${failures} consecutive poll failures — disconnecting`);
          this.broadcast({
            type: "error",
            message:
              "Lost connection to T3 server. Relay state was preserved and will resume after reconnect.",
          });
          this.disconnectFromT3({ preserveRuntime: true });
        }
        return;
      }

      if (this.pollDegraded) {
        this.successesSinceLastFailure++;
        if (this.successesSinceLastFailure >= RelayEngine.RECOVERY_THRESHOLD) {
          console.log("[relay] T3 connection stable again");
          this.pollDegraded = false;
          this.successesSinceLastFailure = 0;
        }
      }

      this.cachedProjects = snapshot.projects.map((p) => ({
        id: p.id,
        title: p.title,
        workspaceRoot: p.workspaceRoot,
      }));
      this.cachedThreads = this.buildThreadSummaries(snapshot.threads);
      this.lastSnapshotSequence = snapshot.snapshotSequence;

      for (const [threadId, pending] of Array.from(this.pendingTurns.entries())) {
        const thread = snapshot.threads.find((entry: T3Thread) => entry.id === threadId);

        const pair = this.pairs.get(pending.pairId);
        if (!pair || pair.status !== "running") {
          this.pendingTurns.delete(threadId);
          continue;
        }

        if (!thread?.latestTurn) {
          continue;
        }

        const turnState = thread.latestTurn.state;
        const turnId = thread.latestTurn.turnId;

        // ── Gate: we must see the turn enter "running" before accepting
        // any terminal state. This prevents us from picking up a stale
        // "completed" left over from the PREVIOUS turn before T3 has
        // registered our new dispatch.
        if (!pending.seenRunning) {
          if (turnState === "running") {
            pending.seenRunning = true;
            pending.activeTurnId = turnId;
          }
          // Haven't seen our turn start yet — skip this cycle
          continue;
        }

        // ── Safety: if the turnId changed since we saw "running",
        // something unexpected happened. Re-lock onto the new turn.
        if (pending.activeTurnId && turnId !== pending.activeTurnId) {
          if (turnState === "running") {
            pending.activeTurnId = turnId;
            continue;
          }
          // Different turn, not running — might be stale; skip
          continue;
        }

        // ── Also verify the session is no longer actively processing.
        // The turn state may flip to "completed" on the last assistant
        // message, but tool calls can still be in flight. The session
        // goes to "ready"/"idle"/"stopped" only when truly done.
        const sessionBusy =
          thread.session?.status === "running" ||
          thread.session?.status === "starting";

        if (turnState === "completed") {
          if (sessionBusy) {
            // Turn text is done but session still processing (tool calls).
            // Wait for the session to settle.
            continue;
          }

          this.pendingTurns.delete(threadId);
          const assistantMsg = this.getLastAssistantMessage(thread);
          if (!assistantMsg) {
            this.failPendingTurn(
              pair,
              pending,
              `No assistant message was found for completed turn on ${this.labelForSide(pair, pending.side)}.`,
            );
            continue;
          }
          await this.handleTurnCompletion(pair, pending.side, assistantMsg);
          continue;
        }

        if (turnState === "error") {
          this.pendingTurns.delete(threadId);
          const errorText = thread.session?.lastError ?? "Turn completed with error";

          if (this.pauseForUsageLimit(pair, pending, errorText)) {
            continue;
          }

          this.failPendingTurn(pair, pending, errorText);
          continue;
        }

        if (turnState === "interrupted") {
          this.pendingTurns.delete(threadId);
          this.failPendingTurn(pair, pending, "Turn was interrupted.");
        }
      }
    } finally {
      this.tickInFlight = false;
      if (this.pendingTurns.size === 0) {
        this.stopPolling();
      }
    }
  }

  private async handleTurnCompletion(
    pair: ChatPair,
    side: PairSide,
    assistantMsg: T3Message,
  ): Promise<void> {
    pair.pendingDispatch = null;
    pair.waitingFor = null;
    pair.resumeAt = null;
    delete pair.error;
    this.broadcastPairUpdate(pair);

    const responseText = assistantMsg.text;
    const responseMessage: RelayMessage = {
      id: crypto.randomUUID(),
      source: side,
      role: "assistant",
      originalText: responseText,
      timestamp: new Date().toISOString(),
      turnNumber: pair.turnCount,
    };
    pair.messages.push(responseMessage);
    this.broadcast({ type: "new-message", pairId: pair.id, message: responseMessage });

    if (pair.config.stopSignal) {
      try {
        const stopRegex = new RegExp(pair.config.stopSignal, "i");
        if (stopRegex.test(responseText)) {
          const stopMsg: RelayMessage = {
            id: crypto.randomUUID(),
            source: "system",
            role: "system",
            originalText: `Stop signal detected in ${this.labelForSide(pair, side)}'s response. Relay complete.`,
            timestamp: new Date().toISOString(),
            turnNumber: pair.turnCount,
          };
          pair.messages.push(stopMsg);
          this.broadcast({ type: "new-message", pairId: pair.id, message: stopMsg });
          pair.status = "completed";
          this.broadcastPairUpdate(pair);
          return;
        }
      } catch {
        // invalid regex
      }
    }

    if (side === "B") {
      pair.turnCount++;
    }

    if (pair.config.maxTurns > 0 && pair.turnCount >= pair.config.maxTurns) {
      const maxMsg: RelayMessage = {
        id: crypto.randomUUID(),
        source: "system",
        role: "system",
        originalText: `Maximum turns (${pair.config.maxTurns}) reached. Relay complete.`,
        timestamp: new Date().toISOString(),
        turnNumber: pair.turnCount,
      };
      pair.messages.push(maxMsg);
      this.broadcast({ type: "new-message", pairId: pair.id, message: maxMsg });
      pair.status = "completed";
      this.broadcastPairUpdate(pair);
      return;
    }

    const nextSide: PairSide = side === "A" ? "B" : "A";
    const nextThreadId = nextSide === "A" ? pair.threadA.id : pair.threadB.id;
    const modifications =
      side === "A" ? pair.config.modificationsAtoB : pair.config.modificationsBtoA;

    // On the first A→B relay, apply initialMessageB template if configured
    let textForRelay = responseText;
    const isFirstAtoBRelay =
      side === "A" && pair.turnCount === 0 && pair.config.initialMessageB;
    if (isFirstAtoBRelay) {
      textForRelay = pair.config.initialMessageB.replace(
        /\{\{response\}\}/g,
        responseText,
      );
    }

    const modifiedText = applyModifications(textForRelay, modifications);
    if (modifiedText !== responseText) {
      const relayedMessage: RelayMessage = {
        id: crypto.randomUUID(),
        source: side,
        role: "user",
        originalText: responseText,
        relayedText: modifiedText,
        timestamp: new Date().toISOString(),
        turnNumber: side === "A" ? pair.turnCount : pair.turnCount + 1,
      };
      pair.messages.push(relayedMessage);
      this.broadcast({ type: "new-message", pairId: pair.id, message: relayedMessage });
    }

    pair.pendingDispatch = {
      side: nextSide,
      threadId: nextThreadId,
      text: modifiedText,
      reason: "relay",
      sourceSide: side,
      dispatchedAt: null,
      retryCount: 0,
    };
    pair.status = "running";
    pair.waitingFor = nextSide;
    delete pair.error;
    this.broadcastPairUpdate(pair);

    await this.dispatchPendingTurn(pair);
  }

  // ─── Hydration: rebuild pair messages from T3 thread history ───

  private hydrateFromPersisted(persisted: PersistedPair[], threads: T3Thread[]): void {
    for (const pp of persisted) {
      if (this.pairs.has(pp.id)) continue;

      const threadA = threads.find((t) => t.id === pp.threadAId);
      const threadB = threads.find((t) => t.id === pp.threadBId);

      const messages: RelayMessage[] = [];
      let inferredTurnCount = 0;

      if (threadA && threadB) {
        const allT3Msgs: { msg: T3Message; side: PairSide }[] = [
          ...threadA.messages.map((msg) => ({ msg, side: "A" as const })),
          ...threadB.messages.map((msg) => ({ msg, side: "B" as const })),
        ].sort((a, b) => new Date(a.msg.createdAt).getTime() - new Date(b.msg.createdAt).getTime());

        for (const { msg, side } of allT3Msgs) {
          if (msg.streaming) continue;
          messages.push({
            id: msg.id,
            source: side,
            role: msg.role,
            originalText: msg.text,
            timestamp: msg.createdAt,
            turnNumber: inferredTurnCount,
          });
          if (msg.role === "assistant" && side === "B") {
            inferredTurnCount++;
          }
        }
      }

      const status =
        pp.pendingDispatch !== null ? pp.status : messages.length > 0 ? "stopped" : "idle";
      const turnCount = Math.max(pp.turnCount, inferredTurnCount);

      const pair: ChatPair = {
        id: pp.id,
        name: pp.name,
        status,
        threadA: { id: pp.threadAId, label: pp.threadALabel },
        threadB: { id: pp.threadBId, label: pp.threadBLabel },
        config: pp.config,
        messages,
        turnCount,
        waitingFor: pp.pendingDispatch ? pp.waitingFor : null,
        pendingDispatch: pp.pendingDispatch,
        resumeAt: pp.pendingDispatch ? pp.resumeAt : null,
        ...(pp.error ? { error: pp.error } : {}),
        createdAt: pp.createdAt,
      };

      this.pairs.set(pp.id, pair);
    }
  }

  // ─── Thread summaries for the UI ───

  private buildThreadSummaries(threads: T3Thread[]): ThreadSummary[] {
    const pairLookup = new Map<string, { pairId: string; side: PairSide }>();
    for (const pair of this.pairs.values()) {
      pairLookup.set(pair.threadA.id, { pairId: pair.id, side: "A" });
      pairLookup.set(pair.threadB.id, { pairId: pair.id, side: "B" });
    }

    return threads.map((thread): ThreadSummary => {
      const lastMsg = thread.messages[thread.messages.length - 1];
      const pairInfo = pairLookup.get(thread.id);

      return {
        id: thread.id,
        projectId: thread.projectId,
        title: thread.title,
        messageCount: thread.messages.length,
        lastMessagePreview: lastMsg ? lastMsg.text.slice(0, 80) : "",
        lastActivityAt: lastMsg?.updatedAt ?? "",
        turnState: thread.latestTurn?.state ?? null,
        pairId: pairInfo?.pairId ?? null,
        pairSide: pairInfo?.side ?? null,
      };
    });
  }

  // ─── Persistence ───

  private persist(): void {
    const state: PersistedState = {
      version: 2,
      connection:
        this.t3Client?.connected && this.t3Client.token
          ? { url: this.t3Client.url, bearerToken: this.t3Client.token }
          : null,
      pairs: Array.from(this.pairs.values()).map(
        (pair): PersistedPair => ({
          id: pair.id,
          name: pair.name,
          threadAId: pair.threadA.id,
          threadALabel: pair.threadA.label,
          threadBId: pair.threadB.id,
          threadBLabel: pair.threadB.label,
          config: pair.config,
          status: pair.status,
          turnCount: pair.turnCount,
          waitingFor: pair.waitingFor,
          pendingDispatch: pair.pendingDispatch,
          resumeAt: pair.resumeAt,
          error: pair.error ?? null,
          createdAt: pair.createdAt,
        }),
      ),
    };
    saveState(state);
  }

  // ─── Recovery Helpers ───

  private async restoreRuntimeState(threads: T3Thread[]): Promise<void> {
    for (const pair of this.pairs.values()) {
      if (!pair.pendingDispatch || !pair.waitingFor) {
        continue;
      }

      const threadId = pair.waitingFor === "A" ? pair.threadA.id : pair.threadB.id;
      const thread = threads.find((entry) => entry.id === threadId);

      if (pair.status === "running") {
        if (!thread?.latestTurn || pair.pendingDispatch.dispatchedAt === null) {
          await this.dispatchPendingTurn(pair);
          continue;
        }

        // Restoring a turn that was already dispatched — check if it's running
        const isRunning = thread.latestTurn.state === "running";
        this.pendingTurns.set(threadId, {
          pairId: pair.id,
          side: pair.waitingFor,
          text: pair.pendingDispatch.text,
          seenRunning: isRunning,
          activeTurnId: isRunning ? thread.latestTurn.turnId : null,
        });
        this.ensurePolling();
        continue;
      }

      if (pair.status === "paused" || pair.status === "error") {
        if (
          thread?.session?.lastError &&
          this.pauseForUsageLimit(
            pair,
            {
              pairId: pair.id,
              side: pair.waitingFor,
              text: pair.pendingDispatch.text,
              seenRunning: false,
              activeTurnId: null,
            },
            thread.session.lastError,
          )
        ) {
          continue;
        }
      }
    }

    this.scheduleNextResumeCheck();
    await this.resumeDuePairs();
  }

  private async dispatchPendingTurn(pair: ChatPair): Promise<void> {
    if (!this.t3Client) throw new Error("Not connected to T3");
    if (!pair.pendingDispatch) throw new Error("No pending dispatch to send");

    const pending = pair.pendingDispatch;
    pending.dispatchedAt = new Date().toISOString();
    pair.status = "running";
    pair.waitingFor = pending.side;
    pair.resumeAt = null;
    delete pair.error;
    this.broadcastPairUpdate(pair);

    try {
      await this.t3Client.startTurn({
        threadId: pending.threadId,
        text: pending.text,
        runtimeMode: pair.config.runtimeMode,
        modelSelection: this.modelForSide(pair.config, pending.side),
      });

      this.pendingTurns.set(pending.threadId, {
        pairId: pair.id,
        side: pending.side,
        text: pending.text,
        seenRunning: false,  // must see "running" before accepting "completed"
        activeTurnId: null,
      });
      this.ensurePolling();
      this.broadcastPairUpdate(pair);

      console.log(
        `[relay] Waiting on ${this.labelForSide(pair, pending.side)} for pair "${pair.name}"`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const failState: PendingTurnState = {
        pairId: pair.id,
        side: pending.side,
        text: pending.text,
        seenRunning: false,
        activeTurnId: null,
      };
      if (this.pauseForUsageLimit(pair, failState, msg)) {
        return;
      }
      this.failPendingTurn(pair, failState, msg);
    }
  }

  private failPendingTurn(pair: ChatPair, pending: PendingTurnState, errorText: string): void {
    pair.status = "error";
    pair.waitingFor = pending.side;
    pair.resumeAt = null;
    if (pair.pendingDispatch) {
      pair.pendingDispatch.dispatchedAt = null;
    }
    pair.error = errorText;
    this.broadcastPairUpdate(pair);

    const errMsg: RelayMessage = {
      id: crypto.randomUUID(),
      source: "system",
      role: "system",
      originalText: `Error from ${this.labelForSide(pair, pending.side)}: ${errorText}`,
      timestamp: new Date().toISOString(),
      turnNumber: pair.turnCount,
    };
    pair.messages.push(errMsg);
    this.broadcast({ type: "new-message", pairId: pair.id, message: errMsg });
  }

  private pauseForUsageLimit(
    pair: ChatPair,
    pending: PendingTurnState,
    errorText: string,
  ): boolean {
    const parsed = parseUsageLimit(errorText);
    if (!parsed) {
      return false;
    }

    const existingPending = pair.pendingDispatch ?? {
      side: pending.side,
      threadId: pending.side === "A" ? pair.threadA.id : pair.threadB.id,
      text: pending.text,
      reason: "relay" as const,
      sourceSide: null,
      dispatchedAt: null,
      retryCount: 0,
    };

    existingPending.dispatchedAt = null;
    existingPending.retryCount += 1;
    pair.pendingDispatch = existingPending;
    pair.status = "paused";
    pair.waitingFor = pending.side;
    pair.resumeAt =
      parsed.resumeAt ??
      new Date(Date.now() + RelayEngine.DEFAULT_USAGE_LIMIT_RETRY_MS).toISOString();
    pair.error = parsed.message;
    this.broadcastPairUpdate(pair);

    const pauseMsg: RelayMessage = {
      id: crypto.randomUUID(),
      source: "system",
      role: "system",
      originalText: this.formatUsagePauseMessage(pair, pending.side, pair.resumeAt, parsed.message),
      timestamp: new Date().toISOString(),
      turnNumber: pair.turnCount,
    };
    pair.messages.push(pauseMsg);
    this.broadcast({ type: "new-message", pairId: pair.id, message: pauseMsg });

    this.scheduleNextResumeCheck();
    console.log(
      `[relay] Usage limit paused pair "${pair.name}" until ${pair.resumeAt ?? "manual retry"}`,
    );
    return true;
  }

  private async resumeDuePairs(): Promise<void> {
    if (!this.t3Client) return;

    const now = Date.now();
    const duePairs = Array.from(this.pairs.values()).filter((pair) => {
      if (pair.status !== "paused") return false;
      if (!pair.pendingDispatch || !pair.resumeAt) return false;
      const resumeAtMs = Date.parse(pair.resumeAt);
      return Number.isFinite(resumeAtMs) && resumeAtMs <= now;
    });

    for (const pair of duePairs) {
      const pending = pair.pendingDispatch;
      if (!pending) continue;

      const resumeMsg: RelayMessage = {
        id: crypto.randomUUID(),
        source: "system",
        role: "system",
        originalText: `Usage window reached. Retrying ${this.labelForSide(pair, pending.side)}.`,
        timestamp: new Date().toISOString(),
        turnNumber: pair.turnCount,
      };
      pair.messages.push(resumeMsg);
      this.broadcast({ type: "new-message", pairId: pair.id, message: resumeMsg });

      pair.status = "running";
      pair.resumeAt = null;
      delete pair.error;
      this.broadcastPairUpdate(pair);

      await this.dispatchPendingTurn(pair);
    }

    this.scheduleNextResumeCheck();
  }

  private scheduleNextResumeCheck(): void {
    this.stopResumeTimer();
    if (!this.t3Client) return;

    const nextResumeAt = Array.from(this.pairs.values())
      .filter((pair) => pair.status === "paused" && pair.pendingDispatch && pair.resumeAt)
      .map((pair) => Date.parse(pair.resumeAt!))
      .filter((timestamp) => Number.isFinite(timestamp))
      .sort((a, b) => a - b)[0];

    if (nextResumeAt === undefined) return;

    const delay = Math.max(0, Math.min(nextResumeAt - Date.now(), RelayEngine.MAX_TIMER_DELAY_MS));
    this.resumeTimer = setTimeout(() => {
      void this.resumeDuePairs();
    }, delay);
  }

  private stopResumeTimer(): void {
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }
  }

  // ─── UI / Message Helpers ───

  private broadcastFullSnapshot(): void {
    this.broadcast({
      type: "snapshot",
      pairs: Array.from(this.pairs.values()),
      projects: this.cachedProjects,
      threads: this.cachedThreads,
      templates: this.templates,
    });
  }

  private broadcastPairUpdate(pair: ChatPair): void {
    this.persist();
    this.broadcast({ type: "pair-updated", pair });
  }

  private getLastAssistantMessage(thread: T3Thread): T3Message | null {
    if (thread.latestTurn?.assistantMessageId) {
      const msg = thread.messages.find(
        (entry) => entry.id === thread.latestTurn!.assistantMessageId,
      );
      if (msg) return msg;
    }
    for (let i = thread.messages.length - 1; i >= 0; i--) {
      if (thread.messages[i].role === "assistant" && !thread.messages[i].streaming) {
        return thread.messages[i];
      }
    }
    return null;
  }

  private labelForSide(pair: ChatPair, side: PairSide): string {
    return side === "A" ? pair.threadA.label : pair.threadB.label;
  }

  private modelForSide(config: PairConfig, side: PairSide): ModelSelection {
    if (side === "B" && config.modelSelectionB) return config.modelSelectionB;
    return config.modelSelection;
  }

  private formatUsagePauseMessage(
    pair: ChatPair,
    side: PairSide,
    resumeAt: string | null,
    errorText: string,
  ): string {
    if (!resumeAt) {
      return `Usage limit hit for ${this.labelForSide(pair, side)}. Relay paused for retry. ${errorText}`;
    }

    return `Usage limit hit for ${this.labelForSide(pair, side)}. Relay paused until ${resumeAt}. ${errorText}`;
  }
}

// ─── Usage Limit Parsing ───

function parseUsageLimit(message: string): ParsedUsageLimit | null {
  const normalized = message.trim();
  if (normalized.length === 0) {
    return null;
  }

  const looksLikeUsageLimit =
    /\b(hit your limit|usage limit|rate limit|quota)\b/i.test(normalized) &&
    /\breset/i.test(normalized);
  if (!looksLikeUsageLimit) {
    return null;
  }

  const resumeAt = parseResetTimestamp(normalized);
  return {
    message: normalized,
    resumeAt,
  };
}

function parseResetTimestamp(message: string): string | null {
  const match = message.match(/\bresets?\s+([^.!\n]+)/i);
  if (!match) {
    return null;
  }

  const rawReset = match[1].trim().replace(/^at\s+/i, "");
  const timezoneMatch = rawReset.match(/\(([^)]+)\)\s*$/);
  const timezone = timezoneMatch?.[1]?.trim() ?? "UTC";
  const timePart = rawReset.replace(/\s*\([^)]+\)\s*$/, "").trim();
  const parsedTime = parseClockTime(timePart);
  if (!parsedTime) {
    return null;
  }

  const nowParts = getZonedDateParts(new Date(), timezone);
  if (!nowParts) {
    return null;
  }

  let candidate = zonedTimeToDate(
    {
      year: nowParts.year,
      month: nowParts.month,
      day: nowParts.day,
      hour: parsedTime.hour,
      minute: parsedTime.minute,
    },
    timezone,
  );

  if (!candidate) {
    return null;
  }

  if (candidate.getTime() <= Date.now()) {
    const tomorrow = new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day + 1));
    const tomorrowParts = getZonedDateParts(tomorrow, timezone);
    if (!tomorrowParts) {
      return null;
    }

    candidate = zonedTimeToDate(
      {
        year: tomorrowParts.year,
        month: tomorrowParts.month,
        day: tomorrowParts.day,
        hour: parsedTime.hour,
        minute: parsedTime.minute,
      },
      timezone,
    );
  }

  return candidate?.toISOString() ?? null;
}

function parseClockTime(value: string): { hour: number; minute: number } | null {
  const trimmed = value.trim().toLowerCase();
  const match = trimmed.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!match) {
    return null;
  }

  let hour = Number(match[1]);
  const minute = Number(match[2] ?? "0");
  const meridiem = match[3]?.toLowerCase();
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    return null;
  }

  if (meridiem) {
    if (hour < 1 || hour > 12) {
      return null;
    }
    if (meridiem === "am") {
      hour = hour === 12 ? 0 : hour;
    } else {
      hour = hour === 12 ? 12 : hour + 12;
    }
  } else if (hour > 23) {
    return null;
  }

  return { hour, minute };
}

function getZonedDateParts(
  date: Date,
  timezone: string,
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} | null {
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    const parts = Object.fromEntries(
      formatter
        .formatToParts(date)
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value]),
    );

    return {
      year: Number(parts.year),
      month: Number(parts.month),
      day: Number(parts.day),
      hour: Number(parts.hour),
      minute: Number(parts.minute),
      second: Number(parts.second),
    };
  } catch {
    return null;
  }
}

function zonedTimeToDate(
  input: {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
  },
  timezone: string,
): Date | null {
  let guess = Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, 0);

  for (let attempts = 0; attempts < 3; attempts++) {
    const zoned = getZonedDateParts(new Date(guess), timezone);
    if (!zoned) {
      return null;
    }

    const desiredUtc = Date.UTC(
      input.year,
      input.month - 1,
      input.day,
      input.hour,
      input.minute,
      0,
    );
    const actualUtc = Date.UTC(
      zoned.year,
      zoned.month - 1,
      zoned.day,
      zoned.hour,
      zoned.minute,
      zoned.second,
    );
    const diff = desiredUtc - actualUtc;
    if (diff === 0) {
      return new Date(guess);
    }
    guess += diff;
  }

  return new Date(guess);
}

// ─── Modification Application ───

export function applyModifications(text: string, modifications: Modification[]): string {
  let result = text;
  for (const mod of modifications) {
    switch (mod.type) {
      case "prefix":
        result = mod.value + result;
        break;
      case "suffix":
        result = result + mod.value;
        break;
      case "replace":
        if (mod.pattern) {
          try {
            result = result.replace(new RegExp(mod.pattern, "g"), mod.value);
          } catch {
            // invalid regex
          }
        }
        break;
      case "wrap":
        result = mod.value.replace(/\{\{message\}\}/g, result);
        break;
    }
  }
  return result;
}
