/**
 * Coder-Reviewer workflow — continuous code review cycle.
 *
 * Flow:
 *   1. Coder agent implements the task
 *   2. Bridge captures the code diff
 *   3. Reviewer agent reviews the diff
 *   4. If LGTM → done. Otherwise, feedback is sent back to the Coder.
 *   5. Repeat until LGTM or max iterations reached.
 *
 * Each iteration's state is persisted so the bridge can resume after crashes.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { newCommandId, newMessageId, newThreadId } from "../client.ts";
import {
  buildCoderInitialPrompt,
  buildCoderRevisionPrompt,
  buildReviewerPrompt,
} from "../prompts.ts";
import type {
  DomainEvent,
  ModelSelection,
  Thread,
  Workflow,
  WorkflowContext,
  WorkflowResult,
  WorkflowState,
} from "../types.ts";

const isoNow = (): string => new Date().toISOString();

export class CoderReviewerWorkflow implements Workflow {
  readonly name = "coder-reviewer";

  async run(ctx: WorkflowContext): Promise<WorkflowResult> {
    const { client, config, state, log, signal, eventBus } = ctx;
    const sysMsg = (text: string, iteration: number) =>
      eventBus.emitMessage({
        id: crypto.randomUUID(),
        agent: "system",
        text,
        timestamp: isoNow(),
        iteration,
      });

    // ── Resolve project ───────────────────────────────────────────
    const projectId = await resolveProjectId(ctx);
    log.info(`Using project: ${projectId}`);

    // ── Always start fresh ──────────────────────────────────────
    // Clear any stale workflow state from previous runs. Each "Start"
    // from the UI is a fresh intent — never auto-resume.
    state.clear();

    const coderThreadId = await createThread(
      ctx,
      projectId,
      `Coder: ${config.taskFile}`,
      config.coderModel,
    );
    const reviewerThreadId = await createThread(
      ctx,
      projectId,
      `Reviewer: ${config.taskFile}`,
      config.reviewerModel,
    );

    log.info("Created threads", {
      coder: coderThreadId,
      reviewer: reviewerThreadId,
    });

    // ── Read task ─────────────────────────────────────────────────
    const task =
      ((config as unknown as Record<string, unknown>)["_taskText"] as string | undefined) ??
      readTaskFile(config.taskFile);

    // ── Persist initial state ─────────────────────────────────────
    const workflowState: WorkflowState = {
      workflowName: this.name,
      projectId,
      threadIds: [coderThreadId, reviewerThreadId],
      iteration: 0,
      maxIterations: config.maxIterations,
      status: "running",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      meta: { task: task.slice(0, 200) },
    };
    state.save(workflowState);

    // ── Main loop ─────────────────────────────────────────────────
    const lgtmRe = new RegExp(config.lgtmPattern, "im");
    let coderTurnCount = 0;
    let reviewerTurnCount = 0;
    let approved = false;
    let iteration = 0;

    for (iteration = 1; iteration <= config.maxIterations; iteration++) {
      if (signal.aborted) {
        log.warn("Abort signal received — stopping gracefully");
        workflowState.status = "interrupted";
        workflowState.updatedAt = new Date().toISOString();
        state.save(workflowState);
        break;
      }

      log.info(`${"─".repeat(50)}`);
      log.info(`Iteration ${iteration}/${config.maxIterations}`);
      sysMsg(`Iteration ${iteration} of ${config.maxIterations}`, iteration);

      // ── Step 1: Coder turn ──────────────────────────────────
      eventBus.emitStatus({
        running: true,
        connected: true,
        phase: "coding",
        iteration,
        maxIterations: config.maxIterations,
        startedAt: workflowState.startedAt,
        error: null,
      });

      const coderPrompt =
        iteration === 1
          ? buildCoderInitialPrompt(task)
          : buildCoderRevisionPrompt(
              workflowState.meta["lastReviewerFeedback"] as string,
              (workflowState.meta["lastDiff"] as string) ?? "",
              iteration,
            );

      log.info(`[Coder] Sending turn (${coderPrompt.length} chars)...`);
      const coderResponse = await sendTurnAndWait(
        ctx,
        coderThreadId,
        coderPrompt,
        config.coderModel,
        "coder",
        iteration,
      );
      coderTurnCount++;
      log.info(`[Coder] Response: ${coderResponse.length} chars`);
      log.debug(`[Coder] Preview: ${coderResponse.slice(0, 300)}`);

      eventBus.emitMessage({
        id: crypto.randomUUID(),
        agent: "coder",
        text: coderResponse,
        timestamp: isoNow(),
        iteration,
      });

      // ── Step 2: Get the diff ────────────────────────────────
      eventBus.emitStatus({
        running: true,
        connected: true,
        phase: "fetching-diff",
        iteration,
        maxIterations: config.maxIterations,
        startedAt: workflowState.startedAt,
        error: null,
      });

      let diff = "";
      try {
        const diffResult = await client.getFullThreadDiff(coderThreadId, coderTurnCount);
        diff = diffResult.diff ?? "";
        log.info(diff ? `[Diff] ${diff.length} chars of code changes` : "[Diff] No file changes");
      } catch (e) {
        log.warn(`[Diff] Could not fetch: ${e}`);
      }

      if (diff) {
        eventBus.emitMessage({
          id: crypto.randomUUID(),
          agent: "diff",
          text: diff,
          timestamp: isoNow(),
          iteration,
        });
      }

      // ── Step 3: Reviewer turn ───────────────────────────────
      eventBus.emitStatus({
        running: true,
        connected: true,
        phase: "reviewing",
        iteration,
        maxIterations: config.maxIterations,
        startedAt: workflowState.startedAt,
        error: null,
      });

      const reviewerPrompt = buildReviewerPrompt(diff, coderResponse, task, iteration);
      log.info(`[Reviewer] Sending turn (${reviewerPrompt.length} chars)...`);
      const reviewerResponse = await sendTurnAndWait(
        ctx,
        reviewerThreadId,
        reviewerPrompt,
        config.reviewerModel,
        "reviewer",
        iteration,
      );
      reviewerTurnCount++;
      log.info(`[Reviewer] Response: ${reviewerResponse.length} chars`);
      log.debug(`[Reviewer] Preview: ${reviewerResponse.slice(0, 300)}`);

      eventBus.emitMessage({
        id: crypto.randomUUID(),
        agent: "reviewer",
        text: reviewerResponse,
        timestamp: isoNow(),
        iteration,
      });

      // ── Step 4: Check for LGTM ─────────────────────────────
      approved = lgtmRe.test(reviewerResponse);

      // ── Persist progress ────────────────────────────────────
      workflowState.iteration = iteration;
      workflowState.updatedAt = new Date().toISOString();
      workflowState.meta["lastDiff"] = diff.slice(0, 10_000);
      workflowState.meta["lastReviewerFeedback"] = reviewerResponse;
      workflowState.meta["coderTurnCount"] = coderTurnCount;
      workflowState.meta["reviewerTurnCount"] = reviewerTurnCount;
      state.save(workflowState);

      if (approved) {
        log.info("Reviewer approved the changes (LGTM)!");
        sysMsg("Reviewer approved! LGTM", iteration);
        break;
      }

      log.info("Reviewer requested changes — continuing loop...");
      sysMsg("Reviewer requested changes — continuing...", iteration);
    }

    // ── Finalize ──────────────────────────────────────────────────
    const finalStatus = approved ? "completed" : signal.aborted ? "interrupted" : "completed";
    workflowState.status = finalStatus;
    workflowState.updatedAt = new Date().toISOString();
    state.save(workflowState);

    return {
      success: approved,
      iterations: iteration,
      summary: approved
        ? `Reviewer approved after ${iteration} iteration(s).`
        : `Reached max iterations (${config.maxIterations}) without approval.`,
      threadIds: [coderThreadId, reviewerThreadId],
    };
  }
}

// ── Shared Helpers ────────────────────────────────────────────────────────

export async function resolveProjectId(ctx: WorkflowContext): Promise<string> {
  if (ctx.config.projectId) return ctx.config.projectId;

  const snapshot = await ctx.client.getSnapshot();
  const active = snapshot.projects.filter((p) => !p.deletedAt);
  if (active.length === 0) {
    throw new Error("No projects found. Set T3_PROJECT_ID or create a project in the UI.");
  }
  const project = active[0]!;
  ctx.log.info(`Auto-selected project: "${project.title}" (${project.id})`);
  return project.id;
}

export async function createThread(
  ctx: WorkflowContext,
  projectId: string,
  title: string,
  modelSelection: ModelSelection,
): Promise<string> {
  const threadId = newThreadId();
  await ctx.client.dispatchCommand({
    type: "thread.create",
    commandId: newCommandId(),
    threadId,
    projectId,
    title,
    modelSelection,
    runtimeMode: ctx.config.runtimeMode,
    interactionMode: ctx.config.interactionMode,
    branch: null,
    worktreePath: null,
    createdAt: new Date().toISOString(),
  });
  return threadId;
}

/**
 * Send a turn and wait for the agent to fully complete.
 *
 * The optional `agent` and `iteration` parameters enable real-time streaming
 * of the agent's output to the bridge UI (text deltas and activity log).
 */
export async function sendTurnAndWait(
  ctx: WorkflowContext,
  threadId: string,
  message: string,
  modelSelection: ModelSelection,
  agent: "coder" | "reviewer" = "coder",
  iteration = 0,
): Promise<string> {
  const userMessageId = newMessageId();

  await ctx.client.dispatchCommand({
    type: "thread.turn.start",
    commandId: newCommandId(),
    threadId,
    message: {
      messageId: userMessageId,
      role: "user",
      text: message,
      attachments: [],
    },
    modelSelection,
    runtimeMode: ctx.config.runtimeMode,
    interactionMode: ctx.config.interactionMode,
    createdAt: new Date().toISOString(),
  });

  return waitForTurnCompletion(ctx, threadId, userMessageId, agent, iteration);
}

/**
 * Wait for a turn to FULLY complete — meaning the agent has finished ALL
 * tool execution, file writes, and the final checkpoint is captured.
 *
 * How this works (matching the web UI's approach):
 *
 * 1. **Completion signals from domain events:**
 *    - `thread.session-set` with `status === "ready"` and `activeTurnId === null`
 *      is the primary signal (the server sets this after `turn.completed`).
 *    - `thread.turn-diff-completed` is a secondary signal (fires after
 *      the git checkpoint is captured).
 *    - We track `sawRunning` to avoid false positives from a session that
 *      was already "ready" before our turn started.
 *
 * 2. **Snapshot-based verification (mirroring web UI `isLatestTurnSettled`):**
 *    - `latestTurn.startedAt` is not null
 *    - `latestTurn.completedAt` is not null
 *    - `session.status !== "running"`
 *    - The assistant message exists and `streaming === false`
 *
 * 3. **Real-time streaming:**
 *    On any domain event for our thread, fetch a snapshot and push the
 *    latest assistant text + activities to the bridge UI.
 *
 * 4. **Stale turn detection:**
 *    We verify our user message (by `messageId`) exists in the thread,
 *    confirming the server accepted our turn before reading results.
 */
function waitForTurnCompletion(
  ctx: WorkflowContext,
  threadId: string,
  userMessageId: string,
  agent: "coder" | "reviewer",
  iteration: number,
): Promise<string> {
  const { client, config, signal, eventBus, log } = ctx;
  const INACTIVITY_MS = config.turnTimeoutMs;
  // Minimum interval between snapshot fetches for streaming (ms)
  const SYNC_THROTTLE_MS = 400;

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    // Track session lifecycle: must see "running" before accepting "ready"
    // to avoid a stale "ready" from a prior turn.
    let sawRunning = false;
    let lastActivityAt = Date.now();
    let lastSyncAt = 0;
    let syncQueued = false;
    let syncInProgress = false;

    const cleanup = (): void => {
      settled = true;
      unsub();
      if (pollTimer) clearInterval(pollTimer);
      if (inactivityTimer) clearInterval(inactivityTimer);
      signal.removeEventListener("abort", onAbort);
      eventBus.setStreamingMessage(null);
    };

    const settle = (fn: () => void): void => {
      if (settled) return;
      cleanup();
      fn();
    };

    const onAbort = (): void => settle(() => reject(new Error("Aborted")));
    signal.addEventListener("abort", onAbort, { once: true });

    // ── Inactivity timeout ────────────────────────────────────────
    // Only fires after total silence — resets on any event.
    const inactivityTimer = setInterval(() => {
      if (settled) return;
      const silentMs = Date.now() - lastActivityAt;
      if (silentMs >= INACTIVITY_MS) {
        const mins = Math.round(INACTIVITY_MS / 60_000);
        settle(() =>
          reject(
            new Error(
              `Turn on ${threadId} timed out after ${mins}m of inactivity. ` +
                `The agent may be stuck. Last activity was ${Math.round(silentMs / 1000)}s ago.`,
            ),
          ),
        );
      }
    }, 10_000);

    // ── Sync snapshot: streams content + checks completion ────────
    const syncSnapshot = async (): Promise<void> => {
      if (settled) return;
      // Prevent overlapping calls — if a previous sync is in-flight
      // (e.g. hanging on a dead connection), skip this one. The poll
      // timer or next event will retry.
      if (syncInProgress) return;
      syncInProgress = true;

      try {
        const snapshot = await client.getSnapshot();
        const thread = snapshot.threads.find((t: { id: string }) => t.id === threadId) as
          | Thread
          | undefined;
        if (!thread) return;

        // ── Stream content to UI ──────────────────────────────
        const assistantMsgs = thread.messages.filter(
          (m: { role: string }) => m.role === "assistant",
        );
        const latestAssistant = assistantMsgs[assistantMsgs.length - 1];
        const activities = thread.activities.slice(-20);

        if (latestAssistant?.text) {
          eventBus.setStreamingMessage({
            id: `streaming-${threadId}`,
            agent,
            text: latestAssistant.text,
            timestamp: isoNow(),
            iteration,
            activities: activities.map((a: { kind: string; message: string }) => ({
              kind: a.kind,
              message: a.message,
            })),
          });
        }

        // ── Check completion ─────────────────────────────────────
        // First verify our user message was accepted by the server
        const ourMsg = thread.messages.find((m: { id: string }) => m.id === userMessageId);
        if (!ourMsg) return; // Turn not yet registered

        const turn = thread.latestTurn;
        const session = thread.session;

        if (turn?.state === "error") {
          settle(() => reject(new Error(`Turn ${turn.turnId} ended in error`)));
          return;
        }

        // Primary check (turn-diff-completed has fired — full settlement):
        //   startedAt must be set, completedAt must be set,
        //   and session must NOT be "running".
        const isFullySettled =
          turn !== null &&
          turn.startedAt !== null &&
          turn.completedAt !== null &&
          (!session || session.status !== "running");

        // Secondary check (session-set "ready" has fired, but the
        // CheckpointReactor hasn't produced turn-diff-completed yet).
        // The projector does NOT update latestTurn.completedAt until
        // that event fires, so there's a gap where completedAt is null
        // even though the turn is done. For long-running turns with
        // large diffs, this gap can be significant.
        // Use session.activeTurnId === null as the signal instead.
        const isSessionDone =
          session !== null &&
          session.activeTurnId === null &&
          session.status !== "running" &&
          session.status !== "starting";

        if (!isFullySettled && !isSessionDone) return;

        // Find the assistant message. When fully settled, use the
        // turn's assistantMessageId. Otherwise fall back to the latest
        // non-streaming assistant message.
        let assistantMsg: { text: string; streaming: boolean } | undefined;

        if (isFullySettled && turn?.assistantMessageId) {
          assistantMsg = thread.messages.find(
            (m: { id: string }) => m.id === turn.assistantMessageId,
          );
        }

        if (!assistantMsg) {
          // Fallback: find the most recent non-streaming assistant message.
          // This is safe because the bridge owns this thread exclusively —
          // no other client is sending turns to it.
          const candidates = thread.messages.filter(
            (m: { role: string; streaming: boolean }) => m.role === "assistant" && !m.streaming,
          );
          assistantMsg = candidates[candidates.length - 1];
        }

        if (!assistantMsg) return;
        if (assistantMsg.streaming) return; // Still streaming

        settle(() => resolve(assistantMsg!.text ?? ""));
      } catch {
        // Ignore transient snapshot errors — the poll timer will retry.
      } finally {
        syncInProgress = false;
      }
    };

    // Throttled sync: fire immediately if enough time has passed,
    // otherwise queue a single trailing call.
    const throttledSync = (): void => {
      if (settled) return;
      const now = Date.now();
      const elapsed = now - lastSyncAt;
      if (elapsed >= SYNC_THROTTLE_MS) {
        lastSyncAt = now;
        void syncSnapshot();
      } else if (!syncQueued) {
        syncQueued = true;
        setTimeout(() => {
          syncQueued = false;
          lastSyncAt = Date.now();
          void syncSnapshot();
        }, SYNC_THROTTLE_MS - elapsed);
      }
    };

    // ── Domain event listener ─────────────────────────────────────
    const unsub = client.onDomainEvent((event: DomainEvent) => {
      if (settled) return;
      const eventAggId = event["aggregateId"] as string | undefined;
      if (eventAggId !== threadId) return;

      // Any event = agent is alive → reset inactivity clock
      lastActivityAt = Date.now();

      const type = event["type"] as string;
      const payload = event["payload"] as Record<string, unknown> | undefined;

      // ── Session lifecycle tracking ──────────────────────────
      if (type === "thread.session-set") {
        const sess = payload?.["session"] as Record<string, unknown> | undefined;
        const status = sess?.["status"] as string | undefined;

        if (status === "running") {
          sawRunning = true;
        }

        if (status === "error") {
          const lastError = sess?.["lastError"] as string | undefined;
          settle(() =>
            reject(new Error(`Session error on ${threadId}: ${lastError ?? "unknown"}`)),
          );
          return;
        }

        // Primary completion signal: session went from running → ready
        // with no active turn
        if (sawRunning && (status === "ready" || status === "idle") && !sess?.["activeTurnId"]) {
          log.debug(`[TurnWait] Session ready on ${threadId} — syncing snapshot`);
          // Small delay so the read model has the final state
          setTimeout(() => void syncSnapshot(), 300);
        }
      }

      // ── Secondary completion signal ─────────────────────────
      if (type === "thread.turn-diff-completed") {
        log.debug(`[TurnWait] Turn diff completed on ${threadId} — syncing snapshot`);
        setTimeout(() => void syncSnapshot(), 300);
      }

      // ── Always sync for streaming content ───────────────────
      throttledSync();
    });

    // ── Fallback polling ──────────────────────────────────────────
    // Catches completion if domain events were missed (e.g. during
    // a WebSocket reconnection window).
    const pollTimer = setInterval(() => {
      if (settled) return;
      void syncSnapshot();
    }, 5_000);
  });
}

function readTaskFile(taskFile: string): string {
  const path = resolve(taskFile);
  try {
    const content = readFileSync(path, "utf-8").trim();
    if (!content) throw new Error(`Task file is empty: ${path}`);
    return content;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Task file not found: ${path}\nCreate it with your task description.`, {
        cause: e,
      });
    }
    throw e;
  }
}
