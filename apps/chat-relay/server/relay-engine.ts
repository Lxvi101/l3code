/**
 * Relay Engine
 *
 * Manages chat pairs that ping-pong messages between two T3 threads.
 *
 * Flow:
 * 1. Create Thread A and Thread B in T3
 * 2. Send initial message to Thread A
 * 3. Poll T3 snapshot for turn completion
 * 4. When Thread A completes → apply A→B modifications → send to Thread B
 * 5. When Thread B completes → apply B→A modifications → send to Thread A
 * 6. Repeat until stop signal detected, max turns reached, or manual stop
 */

import { T3Client } from "./t3-client";
import type {
  ChatPair,
  ClientMessage,
  Modification,
  PairConfig,
  PairStatus,
  RelayMessage,
  ServerMessage,
  T3Message,
  T3Project,
  T3Thread,
} from "./types";

type BroadcastFn = (msg: ServerMessage) => void;

export class RelayEngine {
  private pairs: Map<string, ChatPair> = new Map();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private t3Client: T3Client | null = null;
  private broadcast: BroadcastFn;
  private cachedProjects: T3Project[] = [];

  /** Tracks which turn we're waiting on, per thread */
  private pendingTurns: Map<string, { pairId: string; side: "A" | "B" }> =
    new Map();

  /**
   * true once we've notified the UI about a connection problem.
   * Stays true until we see sustained recovery (not a single lucky poll).
   */
  private pollDegraded = false;

  /** Consecutive successes needed after failure before we say "restored". */
  private successesSinceLastFailure = 0;
  private static readonly RECOVERY_THRESHOLD = 3;

  /**
   * Consecutive T3 fetch failures (tracked by T3Client) before we give up
   * and fully disconnect. At 2s polling, 15 failures ≈ 30 seconds.
   */
  private static readonly MAX_CONSECUTIVE_FAILURES = 15;

  /** Polling interval in ms. Deliberately slow — turns take 10-120+ seconds. */
  private static readonly POLL_INTERVAL_MS = 2_000;

  constructor(broadcast: BroadcastFn) {
    this.broadcast = broadcast;
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

    // Initial snapshot to populate projects
    const snapshot = await client.getSnapshot();
    this.cachedProjects = snapshot.projects.map((p) => ({
      id: p.id,
      title: p.title,
      workspaceRoot: p.workspaceRoot,
    }));

    this.broadcast({
      type: "connection-status",
      t3Connected: true,
      t3Url: url,
    });
    this.broadcast({
      type: "snapshot",
      pairs: Array.from(this.pairs.values()),
      projects: this.cachedProjects,
    });

    console.log(
      `[relay] Connected to T3 at ${url}, ${this.cachedProjects.length} projects found`,
    );
  }

  disconnectFromT3(): void {
    // Stop all running pairs
    for (const [id, pair] of this.pairs) {
      if (pair.status === "running") {
        this.updatePairStatus(id, "stopped");
      }
    }
    this.stopPolling();
    this.t3Client?.disconnect();
    this.t3Client = null;
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

    // Create both threads in T3
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

    // Send initial message to Thread A
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
      console.error(`[relay] Failed to start pair: ${msg}`);
    }
  }

  async stopPair(pairId: string): Promise<void> {
    const pair = this.pairs.get(pairId);
    if (!pair) return;

    // Interrupt any running turn
    if (pair.waitingFor && this.t3Client) {
      const threadId =
        pair.waitingFor === "A" ? pair.threadA.id : pair.threadB.id;
      try {
        await this.t3Client.interruptTurn(threadId);
      } catch {
        // Best-effort interrupt
      }
    }

    // Remove pending turn tracking
    this.pendingTurns.delete(pair.threadA.id);
    this.pendingTurns.delete(pair.threadB.id);

    this.updatePairStatus(pairId, "stopped");
    pair.waitingFor = null;

    // Add system message
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

    if (this.pendingTurns.size === 0) {
      this.stopPolling();
    }

    console.log(`[relay] Stopped pair "${pair.name}"`);
  }

  async deletePair(pairId: string): Promise<void> {
    await this.stopPair(pairId);

    const pair = this.pairs.get(pairId);
    if (pair && this.t3Client) {
      // Clean up threads in T3
      try {
        await this.t3Client.deleteThread(pair.threadA.id);
      } catch { /* best-effort */ }
      try {
        await this.t3Client.deleteThread(pair.threadB.id);
      } catch { /* best-effort */ }
    }

    this.pairs.delete(pairId);
    this.broadcast({ type: "pair-removed", pairId });
    console.log(`[relay] Deleted pair ${pairId}`);
  }

  getSnapshot(): { pairs: ChatPair[]; projects: T3Project[] } {
    return {
      pairs: Array.from(this.pairs.values()),
      projects: this.cachedProjects,
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

      // Log once on first failure, then stay quiet
      if (!this.pollDegraded) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[relay] T3 poll failed (will retry): ${msg}`);
        this.pollDegraded = true;
      }

      // After sustained failures, give up entirely
      if (failures >= RelayEngine.MAX_CONSECUTIVE_FAILURES) {
        console.error(
          `[relay] ${failures} consecutive poll failures (~${Math.round((failures * RelayEngine.POLL_INTERVAL_MS) / 1000)}s) — disconnecting from T3`,
        );
        // Notify UI before disconnecting
        this.broadcast({
          type: "error",
          message: "Lost connection to T3 server. Please reconnect.",
        });
        this.disconnectFromT3();
      }
      return;
    }

    // Success — track recovery
    if (this.pollDegraded) {
      this.successesSinceLastFailure++;
      // Require several consecutive successes before declaring recovery,
      // so a single lucky poll between timeouts doesn't flip-flop the UI.
      if (this.successesSinceLastFailure >= RelayEngine.RECOVERY_THRESHOLD) {
        console.log("[relay] T3 connection stable again");
        this.pollDegraded = false;
        this.successesSinceLastFailure = 0;
      }
    }

    // Update cached projects
    this.cachedProjects = snapshot.projects.map((p) => ({
      id: p.id,
      title: p.title,
      workspaceRoot: p.workspaceRoot,
    }));

    // Check each pending turn
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
        // Turn is done — get the assistant's response
        const assistantMsg = this.getLastAssistantMessage(thread);
        if (assistantMsg) {
          await this.handleTurnCompletion(
            pair,
            pending.side,
            assistantMsg,
            thread,
          );
        }
        this.pendingTurns.delete(threadId);
      } else if (turnState === "error") {
        // Turn errored
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
        this.broadcast({
          type: "new-message",
          pairId: pending.pairId,
          message: errMsg,
        });
      }
      // If still "running", we just wait for next tick
    }

    // If no more pending turns, stop polling
    if (this.pendingTurns.size === 0) {
      this.stopPolling();
    }
  }

  private async handleTurnCompletion(
    pair: ChatPair,
    side: "A" | "B",
    assistantMsg: T3Message,
    _thread: T3Thread,
  ): Promise<void> {
    const responseText = assistantMsg.text;

    // Record the assistant's response
    const responseMessage: RelayMessage = {
      id: crypto.randomUUID(),
      source: side,
      role: "assistant",
      originalText: responseText,
      timestamp: new Date().toISOString(),
      turnNumber: pair.turnCount,
    };
    pair.messages.push(responseMessage);
    this.broadcast({
      type: "new-message",
      pairId: pair.id,
      message: responseMessage,
    });

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
          this.broadcast({
            type: "new-message",
            pairId: pair.id,
            message: stopMsg,
          });
          this.updatePairStatus(pair.id, "completed");
          pair.waitingFor = null;
          console.log(
            `[relay] Stop signal detected in pair "${pair.name}" from side ${side}`,
          );
          return;
        }
      } catch {
        // Invalid regex — ignore
      }
    }

    // Increment turn count on full round-trip (B just responded)
    if (side === "B") {
      pair.turnCount++;
    }

    // Check max turns
    if (
      pair.config.maxTurns > 0 &&
      pair.turnCount >= pair.config.maxTurns
    ) {
      const maxMsg: RelayMessage = {
        id: crypto.randomUUID(),
        source: "system",
        role: "system",
        originalText: `Maximum turns (${pair.config.maxTurns}) reached. Relay complete.`,
        timestamp: new Date().toISOString(),
        turnNumber: pair.turnCount,
      };
      pair.messages.push(maxMsg);
      this.broadcast({
        type: "new-message",
        pairId: pair.id,
        message: maxMsg,
      });
      this.updatePairStatus(pair.id, "completed");
      pair.waitingFor = null;
      console.log(
        `[relay] Max turns reached for pair "${pair.name}"`,
      );
      return;
    }

    // Determine next target
    const nextSide: "A" | "B" = side === "A" ? "B" : "A";
    const nextThreadId =
      nextSide === "A" ? pair.threadA.id : pair.threadB.id;
    const modifications =
      side === "A"
        ? pair.config.modificationsAtoB
        : pair.config.modificationsBtoA;

    // Apply modifications
    const modifiedText = applyModifications(responseText, modifications);

    // Record the relayed message
    const relayedMessage: RelayMessage = {
      id: crypto.randomUUID(),
      source: side,
      role: "user",
      originalText: responseText,
      relayedText: modifiedText !== responseText ? modifiedText : undefined,
      timestamp: new Date().toISOString(),
      turnNumber: side === "A" ? pair.turnCount : pair.turnCount + 1,
    };
    pair.messages.push(relayedMessage);
    this.broadcast({
      type: "new-message",
      pairId: pair.id,
      message: relayedMessage,
    });

    // Send to the other thread
    try {
      await this.t3Client!.startTurn({
        threadId: nextThreadId,
        text: modifiedText,
        runtimeMode: pair.config.runtimeMode,
        modelSelection: pair.config.modelSelection,
      });

      pair.waitingFor = nextSide;
      this.pendingTurns.set(nextThreadId, {
        pairId: pair.id,
        side: nextSide,
      });
      this.ensurePolling();

      this.broadcast({ type: "pair-updated", pair });

      console.log(
        `[relay] Relayed ${side} → ${nextSide} for pair "${pair.name}" (turn ${pair.turnCount})`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.updatePairStatus(pair.id, "error", msg);
      console.error(`[relay] Failed to relay message: ${msg}`);
    }
  }

  // ─── Helpers ───

  private getLastAssistantMessage(
    thread: T3Thread,
  ): T3Message | null {
    // Find the message matching the latest turn's assistant message,
    // or fall back to the last assistant message in the thread
    if (thread.latestTurn?.assistantMessageId) {
      const msg = thread.messages.find(
        (m) => m.id === thread.latestTurn!.assistantMessageId,
      );
      if (msg) return msg;
    }

    // Fallback: last assistant message
    for (let i = thread.messages.length - 1; i >= 0; i--) {
      if (thread.messages[i].role === "assistant" && !thread.messages[i].streaming) {
        return thread.messages[i];
      }
    }

    return null;
  }

  private updatePairStatus(
    pairId: string,
    status: PairStatus,
    error?: string,
  ): void {
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
            const regex = new RegExp(mod.pattern, "g");
            result = result.replace(regex, mod.value);
          } catch {
            // Invalid regex — skip
          }
        }
        break;
      case "wrap":
        // The value is a template with {{message}} placeholder
        result = mod.value.replace(/\{\{message\}\}/g, result);
        break;
    }
  }

  return result;
}
