/**
 * Relay Engine
 *
 * Manages chat pairs that ping-pong messages between two T3 threads.
 * Persists connection info and pair metadata to disk so they survive restarts.
 * Hydrates message histories from T3 snapshots on reconnect.
 */

import { T3Client } from "./t3-client";
import {
  loadState,
  saveState,
  type PersistedPair,
  type PersistedState,
} from "./store";
import type {
  ChatPair,
  Modification,
  PairConfig,
  PairStatus,
  RelayMessage,
  ServerMessage,
  T3Message,
  T3Project,
  T3Thread,
  ThreadSummary,
} from "./types";

type BroadcastFn = (msg: ServerMessage) => void;

export class RelayEngine {
  private pairs: Map<string, ChatPair> = new Map();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private t3Client: T3Client | null = null;
  private broadcast: BroadcastFn;
  private cachedProjects: T3Project[] = [];
  private cachedThreads: ThreadSummary[] = [];

  /** Tracks which turn we're waiting on, per thread */
  private pendingTurns: Map<string, { pairId: string; side: "A" | "B" }> =
    new Map();

  private pollDegraded = false;
  private successesSinceLastFailure = 0;
  private static readonly RECOVERY_THRESHOLD = 3;
  private static readonly MAX_CONSECUTIVE_FAILURES = 15;
  private static readonly POLL_INTERVAL_MS = 2_000;

  constructor(broadcast: BroadcastFn) {
    this.broadcast = broadcast;
  }

  // ─── Boot: restore persisted state ───

  async boot(): Promise<void> {
    const state = loadState();
    if (!state.connection) {
      console.log("[relay] No saved connection found");
      return;
    }

    console.log(
      `[relay] Restoring saved connection to ${state.connection.url}...`,
    );

    try {
      const client = new T3Client(state.connection.url);
      await client.restoreToken(state.connection.bearerToken);
      this.t3Client = client;

      // Fetch snapshot and hydrate
      const snapshot = await client.getSnapshot();
      this.cachedProjects = snapshot.projects.map((p) => ({
        id: p.id,
        title: p.title,
        workspaceRoot: p.workspaceRoot,
      }));

      // Restore pairs from persisted state, hydrating messages from T3
      this.hydrateFromPersisted(state.pairs, snapshot.threads);
      this.cachedThreads = this.buildThreadSummaries(snapshot.threads);

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
      // Clear the bad saved connection
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

    // If we already have persisted pairs for this server, hydrate them
    const state = loadState();
    if (state.pairs.length > 0) {
      this.hydrateFromPersisted(state.pairs, snapshot.threads);
    }

    this.cachedThreads = this.buildThreadSummaries(snapshot.threads);

    this.persist();

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

  disconnectFromT3(): void {
    for (const [id, pair] of this.pairs) {
      if (pair.status === "running") {
        this.updatePairStatus(id, "stopped");
      }
    }
    this.stopPolling();
    this.t3Client?.disconnect();
    this.t3Client = null;
    this.cachedThreads = [];

    // Clear persisted connection but keep pairs
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
      modelSelection: config.modelSelection,
      runtimeMode: config.runtimeMode,
    });

    await this.t3Client.createThread({
      threadId: threadBId,
      projectId: config.projectId,
      title: `[Relay] ${config.name} - ${config.labelB}`,
      modelSelection: config.modelSelection,
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
      createdAt: new Date().toISOString(),
    };

    this.pairs.set(pairId, pair);
    this.persist();
    this.broadcast({ type: "pair-created", pair });

    console.log(
      `[relay] Created pair "${config.name}" (${pairId}): ${threadAId} <-> ${threadBId}`,
    );
    return pair;
  }

  async startPair(pairId: string): Promise<void> {
    const pair = this.pairs.get(pairId);
    if (!pair) throw new Error(`Pair ${pairId} not found`);
    if (!this.t3Client) throw new Error("Not connected to T3");
    if (pair.status === "running") return;

    this.updatePairStatus(pairId, "running");
    pair.waitingFor = "A";

    const initialMsg: RelayMessage = {
      id: crypto.randomUUID(),
      source: "system",
      role: "user",
      originalText: pair.config.initialMessage,
      timestamp: new Date().toISOString(),
      turnNumber: 0,
    };
    pair.messages.push(initialMsg);
    this.broadcast({ type: "new-message", pairId, message: initialMsg });

    try {
      await this.t3Client.startTurn({
        threadId: pair.threadA.id,
        text: pair.config.initialMessage,
        runtimeMode: pair.config.runtimeMode,
        modelSelection: pair.config.modelSelection,
      });

      this.pendingTurns.set(pair.threadA.id, { pairId, side: "A" });
      this.ensurePolling();

      console.log(
        `[relay] Started pair "${pair.name}" — initial message sent to Thread A`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.updatePairStatus(pairId, "error", msg);
    }
  }

  async stopPair(pairId: string): Promise<void> {
    const pair = this.pairs.get(pairId);
    if (!pair) return;

    if (pair.waitingFor && this.t3Client) {
      const threadId =
        pair.waitingFor === "A" ? pair.threadA.id : pair.threadB.id;
      try {
        await this.t3Client.interruptTurn(threadId);
      } catch { /* best-effort */ }
    }

    this.pendingTurns.delete(pair.threadA.id);
    this.pendingTurns.delete(pair.threadB.id);
    this.updatePairStatus(pairId, "stopped");
    pair.waitingFor = null;

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
    console.log(`[relay] Stopped pair "${pair.name}"`);
  }

  async deletePair(pairId: string): Promise<void> {
    await this.stopPair(pairId);

    const pair = this.pairs.get(pairId);
    if (pair && this.t3Client) {
      try { await this.t3Client.deleteThread(pair.threadA.id); } catch { /* */ }
      try { await this.t3Client.deleteThread(pair.threadB.id); } catch { /* */ }
    }

    this.pairs.delete(pairId);
    this.persist();
    this.broadcast({ type: "pair-removed", pairId });
    console.log(`[relay] Deleted pair ${pairId}`);
  }

  getSnapshot(): { pairs: ChatPair[]; projects: T3Project[]; threads: ThreadSummary[] } {
    return {
      pairs: Array.from(this.pairs.values()),
      projects: this.cachedProjects,
      threads: this.cachedThreads,
    };
  }

  // ─── Polling Loop ───

  private ensurePolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(
      () => this.tick(),
      RelayEngine.POLL_INTERVAL_MS,
    );
    this.pollDegraded = false;
    this.successesSinceLastFailure = 0;
    console.log(
      `[relay] Started polling T3 snapshot every ${RelayEngine.POLL_INTERVAL_MS}ms`,
    );
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
      console.log("[relay] Stopped polling");
    }
  }

  private async tick(): Promise<void> {
    if (!this.t3Client || this.pendingTurns.size === 0) return;

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
        console.error(
          `[relay] ${failures} consecutive poll failures — disconnecting`,
        );
        this.broadcast({
          type: "error",
          message: "Lost connection to T3 server. Please reconnect.",
        });
        this.disconnectFromT3();
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

    // Update thread list on every successful poll
    this.cachedThreads = this.buildThreadSummaries(snapshot.threads);

    for (const [threadId, pending] of Array.from(this.pendingTurns.entries())) {
      const thread = snapshot.threads.find(
        (t: T3Thread) => t.id === threadId,
      );
      if (!thread?.latestTurn) continue;

      const pair = this.pairs.get(pending.pairId);
      if (!pair || pair.status !== "running") {
        this.pendingTurns.delete(threadId);
        continue;
      }

      const turnState = thread.latestTurn.state;

      if (turnState === "completed") {
        const assistantMsg = this.getLastAssistantMessage(thread);
        if (assistantMsg) {
          await this.handleTurnCompletion(pair, pending.side, assistantMsg, thread);
        }
        this.pendingTurns.delete(threadId);
      } else if (turnState === "error") {
        const errorText =
          thread.session?.lastError ?? "Turn completed with error";
        this.updatePairStatus(pending.pairId, "error", errorText);
        this.pendingTurns.delete(threadId);

        const errMsg: RelayMessage = {
          id: crypto.randomUUID(),
          source: "system",
          role: "system",
          originalText: `Error from ${pending.side === "A" ? pair.threadA.label : pair.threadB.label}: ${errorText}`,
          timestamp: new Date().toISOString(),
          turnNumber: pair.turnCount,
        };
        pair.messages.push(errMsg);
        this.broadcast({ type: "new-message", pairId: pending.pairId, message: errMsg });
      }
    }

    if (this.pendingTurns.size === 0) this.stopPolling();
  }

  private async handleTurnCompletion(
    pair: ChatPair,
    side: "A" | "B",
    assistantMsg: T3Message,
    _thread: T3Thread,
  ): Promise<void> {
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

    // Check stop signal
    if (pair.config.stopSignal) {
      try {
        const stopRegex = new RegExp(pair.config.stopSignal, "i");
        if (stopRegex.test(responseText)) {
          const stopMsg: RelayMessage = {
            id: crypto.randomUUID(),
            source: "system",
            role: "system",
            originalText: `Stop signal detected in ${side === "A" ? pair.threadA.label : pair.threadB.label}'s response. Relay complete.`,
            timestamp: new Date().toISOString(),
            turnNumber: pair.turnCount,
          };
          pair.messages.push(stopMsg);
          this.broadcast({ type: "new-message", pairId: pair.id, message: stopMsg });
          this.updatePairStatus(pair.id, "completed");
          pair.waitingFor = null;
          return;
        }
      } catch { /* invalid regex */ }
    }

    if (side === "B") pair.turnCount++;

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
      this.updatePairStatus(pair.id, "completed");
      pair.waitingFor = null;
      return;
    }

    const nextSide: "A" | "B" = side === "A" ? "B" : "A";
    const nextThreadId = nextSide === "A" ? pair.threadA.id : pair.threadB.id;
    const modifications =
      side === "A" ? pair.config.modificationsAtoB : pair.config.modificationsBtoA;

    const modifiedText = applyModifications(responseText, modifications);
    const wasModified = modifiedText !== responseText;

    if (wasModified) {
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

    try {
      await this.t3Client!.startTurn({
        threadId: nextThreadId,
        text: modifiedText,
        runtimeMode: pair.config.runtimeMode,
        modelSelection: pair.config.modelSelection,
      });

      pair.waitingFor = nextSide;
      this.pendingTurns.set(nextThreadId, { pairId: pair.id, side: nextSide });
      this.ensurePolling();
      this.broadcast({ type: "pair-updated", pair });

      console.log(
        `[relay] Relayed ${side} -> ${nextSide} for pair "${pair.name}" (turn ${pair.turnCount})`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.updatePairStatus(pair.id, "error", msg);
    }
  }

  // ─── Hydration: rebuild pair messages from T3 thread history ───

  private hydrateFromPersisted(
    persisted: PersistedPair[],
    threads: T3Thread[],
  ): void {
    for (const pp of persisted) {
      // Skip if we already have this pair loaded (e.g. from a previous boot)
      if (this.pairs.has(pp.id)) continue;

      const threadA = threads.find((t) => t.id === pp.threadAId);
      const threadB = threads.find((t) => t.id === pp.threadBId);

      // Rebuild messages from both threads
      const messages: RelayMessage[] = [];
      let turnNumber = 0;

      if (threadA && threadB) {
        // Interleave messages chronologically from both threads
        const allT3Msgs: { msg: T3Message; side: "A" | "B" }[] = [
          ...threadA.messages.map((m) => ({ msg: m, side: "A" as const })),
          ...threadB.messages.map((m) => ({ msg: m, side: "B" as const })),
        ].sort(
          (a, b) =>
            new Date(a.msg.createdAt).getTime() -
            new Date(b.msg.createdAt).getTime(),
        );

        for (const { msg, side } of allT3Msgs) {
          if (msg.streaming) continue; // skip incomplete streaming messages
          messages.push({
            id: msg.id,
            source: side,
            role: msg.role,
            originalText: msg.text,
            timestamp: msg.createdAt,
            turnNumber,
          });
          // Count round-trips: after B's assistant response
          if (msg.role === "assistant" && side === "B") turnNumber++;
        }
      }

      const pair: ChatPair = {
        id: pp.id,
        name: pp.name,
        status: messages.length > 0 ? "stopped" : "idle",
        threadA: { id: pp.threadAId, label: pp.threadALabel },
        threadB: { id: pp.threadBId, label: pp.threadBLabel },
        config: pp.config,
        messages,
        turnCount: turnNumber,
        waitingFor: null,
        createdAt: pp.createdAt,
      };

      this.pairs.set(pp.id, pair);
    }
  }

  // ─── Thread summaries for the UI ───

  private buildThreadSummaries(threads: T3Thread[]): ThreadSummary[] {
    // Build a lookup: threadId -> { pairId, side }
    const pairLookup = new Map<string, { pairId: string; side: "A" | "B" }>();
    for (const pair of this.pairs.values()) {
      pairLookup.set(pair.threadA.id, { pairId: pair.id, side: "A" });
      pairLookup.set(pair.threadB.id, { pairId: pair.id, side: "B" });
    }

    return threads.map((t): ThreadSummary => {
      const lastMsg = t.messages[t.messages.length - 1];
      const pairInfo = pairLookup.get(t.id);

      return {
        id: t.id,
        projectId: t.projectId,
        title: t.title,
        messageCount: t.messages.length,
        lastMessagePreview: lastMsg
          ? lastMsg.text.slice(0, 80)
          : "",
        lastActivityAt: lastMsg?.updatedAt ?? "",
        turnState: t.latestTurn?.state ?? null,
        pairId: pairInfo?.pairId ?? null,
        pairSide: pairInfo?.side ?? null,
      };
    });
  }

  // ─── Persistence ───

  private persist(): void {
    const state: PersistedState = {
      version: 1,
      connection:
        this.t3Client?.connected && this.t3Client.token
          ? { url: this.t3Client.url, bearerToken: this.t3Client.token }
          : null,
      pairs: Array.from(this.pairs.values()).map(
        (p): PersistedPair => ({
          id: p.id,
          name: p.name,
          threadAId: p.threadA.id,
          threadALabel: p.threadA.label,
          threadBId: p.threadB.id,
          threadBLabel: p.threadB.label,
          config: p.config,
          createdAt: p.createdAt,
        }),
      ),
    };
    saveState(state);
  }

  // ─── Helpers ───

  private broadcastFullSnapshot(): void {
    this.broadcast({
      type: "snapshot",
      pairs: Array.from(this.pairs.values()),
      projects: this.cachedProjects,
      threads: this.cachedThreads,
    });
  }

  private getLastAssistantMessage(thread: T3Thread): T3Message | null {
    if (thread.latestTurn?.assistantMessageId) {
      const msg = thread.messages.find(
        (m) => m.id === thread.latestTurn!.assistantMessageId,
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

  private updatePairStatus(pairId: string, status: PairStatus, error?: string): void {
    const pair = this.pairs.get(pairId);
    if (!pair) return;
    pair.status = status;
    if (error) pair.error = error;
    this.broadcast({ type: "pair-updated", pair });
  }
}

// ─── Modification Application ───

export function applyModifications(
  text: string,
  modifications: Modification[],
): string {
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
          } catch { /* invalid regex */ }
        }
        break;
      case "wrap":
        result = mod.value.replace(/\{\{message\}\}/g, result);
        break;
    }
  }
  return result;
}
