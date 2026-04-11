/**
 * Workflow registry — maps workflow names to implementations.
 *
 * To add a new workflow:
 *   1. Create a file in this directory implementing the `Workflow` interface
 *   2. Register it in the `WORKFLOWS` map below
 */

import type { BridgeConfig, Workflow } from "../types.ts";
import { CoderReviewerWorkflow } from "./coderReviewer.ts";
import { TaskQueueWorkflow } from "./taskQueue.ts";

const WORKFLOWS: Record<string, () => Workflow> = {
  "coder-reviewer": () => new CoderReviewerWorkflow(),
  "task-queue": () => new TaskQueueWorkflow(),
};

export function getWorkflow(config: BridgeConfig): Workflow {
  const factory = WORKFLOWS[config.workflow];
  if (!factory) {
    const available = Object.keys(WORKFLOWS).join(", ");
    throw new Error(`Unknown workflow "${config.workflow}". Available: ${available}`);
  }
  return factory();
}
