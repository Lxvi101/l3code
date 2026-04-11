/**
 * Chat history persistence — saves completed workflow sessions to disk
 * so they can be browsed and resumed from the UI.
 *
 * Each session is a JSON file in the state directory: `history/<id>.json`
 *
 * Robust against:
 *   - Corrupt JSON files (skipped with warning)
 *   - Missing fields (validated with defaults)
 *   - Manually deleted files (load returns null, list re-scans)
 *   - Directory not existing (re-created on every operation)
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { UIHistoryEntry, UIMessage } from "./eventBus.ts";

export interface HistorySession {
  readonly id: string;
  readonly task: string;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly status: "running" | "completed" | "error" | "interrupted";
  readonly iterations: number;
  readonly config: {
    readonly projectId: string;
    readonly coderProvider: string;
    readonly coderModel: string;
    readonly reviewerProvider: string;
    readonly reviewerModel: string;
    readonly maxIterations: number;
  };
  readonly messages: UIMessage[];
}

export interface HistoryStore {
  list(): UIHistoryEntry[];
  load(id: string): HistorySession | null;
  save(session: HistorySession): void;
  remove(id: string): boolean;
  create(task: string, config: HistorySession["config"]): HistorySession;
}

export function createHistoryStore(stateDir: string): HistoryStore {
  const dir = join(stateDir, "history");

  function ensureDir(): void {
    mkdirSync(dir, { recursive: true });
  }

  function filePath(id: string): string {
    // Sanitize id to prevent path traversal
    const safe = id.replace(/[^a-zA-Z0-9\-_]/g, "");
    return join(dir, `${safe}.json`);
  }

  function validateSession(raw: unknown): HistorySession | null {
    if (!raw || typeof raw !== "object") return null;
    const obj = raw as Record<string, unknown>;

    // Require at minimum: id, task, startedAt
    if (typeof obj["id"] !== "string" || !obj["id"]) return null;
    if (typeof obj["task"] !== "string") return null;
    if (typeof obj["startedAt"] !== "string") return null;

    const validStatuses = ["running", "completed", "error", "interrupted"];
    const status = validStatuses.includes(obj["status"] as string)
      ? (obj["status"] as HistorySession["status"])
      : "error";

    return {
      id: obj["id"] as string,
      task: (obj["task"] as string) || "(no task)",
      startedAt: obj["startedAt"] as string,
      updatedAt: (obj["updatedAt"] as string) || (obj["startedAt"] as string),
      status,
      iterations: typeof obj["iterations"] === "number" ? obj["iterations"] : 0,
      config: validateConfig(obj["config"]),
      messages: Array.isArray(obj["messages"]) ? (obj["messages"] as UIMessage[]) : [],
    };
  }

  function validateConfig(raw: unknown): HistorySession["config"] {
    const defaults: HistorySession["config"] = {
      projectId: "",
      coderProvider: "claudeAgent",
      coderModel: "claude-sonnet-4-6",
      reviewerProvider: "claudeAgent",
      reviewerModel: "claude-sonnet-4-6",
      maxIterations: 20,
    };
    if (!raw || typeof raw !== "object") return defaults;
    const obj = raw as Record<string, unknown>;
    return {
      projectId: (obj["projectId"] as string) || defaults.projectId,
      coderProvider: (obj["coderProvider"] as string) || defaults.coderProvider,
      coderModel: (obj["coderModel"] as string) || defaults.coderModel,
      reviewerProvider: (obj["reviewerProvider"] as string) || defaults.reviewerProvider,
      reviewerModel: (obj["reviewerModel"] as string) || defaults.reviewerModel,
      maxIterations:
        typeof obj["maxIterations"] === "number" ? obj["maxIterations"] : defaults.maxIterations,
    };
  }

  ensureDir();

  return {
    list(): UIHistoryEntry[] {
      ensureDir();
      let files: string[];
      try {
        files = readdirSync(dir).filter((f) => f.endsWith(".json"));
      } catch {
        return [];
      }

      const entries: UIHistoryEntry[] = [];
      for (const file of files) {
        try {
          const raw = readFileSync(join(dir, file), "utf-8");
          const parsed = JSON.parse(raw) as unknown;
          const session = validateSession(parsed);
          if (!session) continue;
          entries.push({
            id: session.id,
            task: session.task,
            startedAt: session.startedAt,
            status: session.status,
            iterations: session.iterations,
            messageCount: session.messages.length,
          });
        } catch {
          // Corrupt file — skip silently
        }
      }

      entries.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      return entries;
    },

    load(id: string): HistorySession | null {
      const path = filePath(id);
      if (!existsSync(path)) return null;
      try {
        const raw = readFileSync(path, "utf-8");
        const parsed = JSON.parse(raw) as unknown;
        return validateSession(parsed);
      } catch {
        return null;
      }
    },

    save(session: HistorySession): void {
      ensureDir();
      try {
        writeFileSync(filePath(session.id), JSON.stringify(session, null, 2), "utf-8");
      } catch {
        // Swallow write errors — don't crash the bridge over history
      }
    },

    remove(id: string): boolean {
      const path = filePath(id);
      if (!existsSync(path)) return false;
      try {
        unlinkSync(path);
        return true;
      } catch {
        return false;
      }
    },

    create(task: string, config: HistorySession["config"]): HistorySession {
      return {
        id: crypto.randomUUID(),
        task,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: "running",
        iterations: 0,
        config,
        messages: [],
      };
    },
  };
}
