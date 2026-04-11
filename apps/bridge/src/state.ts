/**
 * Crash-safe state persistence.
 *
 * State is written atomically (write to temp file, then rename) so the bridge
 * can resume where it left off after a crash or restart.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { StateManager, WorkflowState } from "./types.ts";

const STATE_FILENAME = "workflow-state.json";
const TEMP_SUFFIX = ".tmp";

export function createStateManager(stateDir: string): StateManager {
  mkdirSync(stateDir, { recursive: true });

  const statePath = join(stateDir, STATE_FILENAME);
  const tempPath = statePath + TEMP_SUFFIX;

  return {
    load(): WorkflowState | null {
      if (!existsSync(statePath)) return null;
      try {
        const raw = readFileSync(statePath, "utf-8");
        return JSON.parse(raw) as WorkflowState;
      } catch {
        return null;
      }
    },

    save(state: WorkflowState): void {
      const json = JSON.stringify(state, null, 2);
      // Atomic write: write temp file, then rename
      writeFileSync(tempPath, json, "utf-8");
      renameSync(tempPath, statePath);
    },

    clear(): void {
      try {
        unlinkSync(statePath);
      } catch {
        // Already gone — fine
      }
      try {
        unlinkSync(tempPath);
      } catch {
        // Already gone — fine
      }
    },
  };
}
