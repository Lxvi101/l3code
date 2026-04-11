/**
 * Task Queue workflow — sequential overnight task execution.
 *
 * Reads a task file containing multiple tasks separated by `---` delimiters.
 * Each task is run as a single-agent turn in its own thread.
 *
 * Example task.md:
 *   Implement the login page
 *   ---
 *   Add unit tests for the auth module
 *   ---
 *   Refactor the database connection pool
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildTaskPrompt } from "../prompts.ts";
import type { Workflow, WorkflowContext, WorkflowResult, WorkflowState } from "../types.ts";
import { createThread, resolveProjectId, sendTurnAndWait } from "./coderReviewer.ts";

const TASK_DELIMITER = /\n---+\n/;

export class TaskQueueWorkflow implements Workflow {
  readonly name = "task-queue";

  async run(ctx: WorkflowContext): Promise<WorkflowResult> {
    const { config, state, log, signal } = ctx;

    const projectId = await resolveProjectId(ctx);
    log.info(`Using project: ${projectId}`);

    // Parse tasks from file
    const raw = readTaskFileRaw(config.taskFile);
    const tasks = raw
      .split(TASK_DELIMITER)
      .map((t) => t.trim())
      .filter(Boolean);

    if (tasks.length === 0) {
      throw new Error(`No tasks found in ${config.taskFile}`);
    }
    log.info(`Loaded ${tasks.length} task(s) from ${config.taskFile}`);

    // Check for resumable state
    const existing = state.load();
    let startIndex = 0;
    const threadIds: string[] = [];

    if (existing && existing.workflowName === this.name && existing.status === "running") {
      startIndex = existing.iteration;
      threadIds.push(...existing.threadIds);
      log.info(`Resuming from task ${startIndex + 1}/${tasks.length}`);
    }

    const workflowState: WorkflowState = {
      workflowName: this.name,
      projectId,
      threadIds,
      iteration: startIndex,
      maxIterations: tasks.length,
      status: "running",
      startedAt: existing?.startedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      meta: { totalTasks: tasks.length },
    };
    state.save(workflowState);

    let completedCount = startIndex;

    for (let i = startIndex; i < tasks.length; i++) {
      if (signal.aborted) {
        log.warn("Abort signal received — stopping task queue");
        workflowState.status = "interrupted";
        workflowState.updatedAt = new Date().toISOString();
        state.save(workflowState);
        break;
      }

      const task = tasks[i]!;
      log.info(`${"─".repeat(50)}`);
      log.info(
        `Task ${i + 1}/${tasks.length}: ${task.slice(0, 80)}${task.length > 80 ? "..." : ""}`,
      );

      // Each task gets its own thread
      const threadId = await createThread(
        ctx,
        projectId,
        `Task ${i + 1}: ${task.slice(0, 40)}`,
        config.coderModel,
      );
      threadIds.push(threadId);
      log.info(`[Task ${i + 1}] Thread: ${threadId}`);

      const prompt = buildTaskPrompt(task, i, tasks.length);
      const response = await sendTurnAndWait(ctx, threadId, prompt, config.coderModel);
      log.info(`[Task ${i + 1}] Completed (${response.length} chars)`);
      log.debug(`[Task ${i + 1}] Preview: ${response.slice(0, 300)}`);

      completedCount++;
      workflowState.iteration = completedCount;
      workflowState.threadIds = threadIds;
      workflowState.updatedAt = new Date().toISOString();
      state.save(workflowState);
    }

    workflowState.status = signal.aborted ? "interrupted" : "completed";
    workflowState.updatedAt = new Date().toISOString();
    state.save(workflowState);

    return {
      success: completedCount === tasks.length,
      iterations: completedCount,
      summary: `Completed ${completedCount}/${tasks.length} task(s).`,
      threadIds,
    };
  }
}

function readTaskFileRaw(taskFile: string): string {
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
