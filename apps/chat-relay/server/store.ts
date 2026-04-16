/**
 * Persistent Store
 *
 * Saves relay state to a JSON file so connections and pairs survive restarts.
 * Stored at `.chat-relay-state.json` next to the server entry point.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { PairConfig, PairStatus, PendingDispatch, RelayTemplate } from "./types";

// ─── Persisted shapes (minimal — no runtime state like messages) ───

export interface PersistedConnection {
  url: string;
  bearerToken: string;
}

export interface PersistedPair {
  id: string;
  name: string;
  threadAId: string;
  threadALabel: string;
  threadBId: string;
  threadBLabel: string;
  config: PairConfig;
  status: PairStatus;
  turnCount: number;
  waitingFor: "A" | "B" | null;
  pendingDispatch: PendingDispatch | null;
  resumeAt: string | null;
  error: string | null;
  createdAt: string;
}

export interface PersistedState {
  version: 2;
  connection: PersistedConnection | null;
  pairs: PersistedPair[];
}

const STATE_FILE = join(dirname(new URL(import.meta.url).pathname), "..", ".chat-relay-state.json");

const EMPTY_STATE: PersistedState = {
  version: 2,
  connection: null,
  pairs: [],
};

export function loadState(): PersistedState {
  try {
    if (!existsSync(STATE_FILE)) return { ...EMPTY_STATE, pairs: [] };
    const raw = readFileSync(STATE_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed?.version === 2) {
      return parsed as PersistedState;
    }
    if (parsed?.version === 1) {
      return {
        version: 2,
        connection: parsed.connection ?? null,
        pairs: Array.isArray(parsed.pairs)
          ? parsed.pairs.map(
              (
                pair: Omit<
                  PersistedPair,
                  "status" | "turnCount" | "waitingFor" | "pendingDispatch" | "resumeAt" | "error"
                >,
              ) => ({
                ...pair,
                status: "idle",
                turnCount: 0,
                waitingFor: null,
                pendingDispatch: null,
                resumeAt: null,
                error: null,
              }),
            )
          : [],
      };
    }
    return { ...EMPTY_STATE, pairs: [] };
  } catch {
    return { ...EMPTY_STATE, pairs: [] };
  }
}

export function saveState(state: PersistedState): void {
  try {
    const dir = dirname(STATE_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
  } catch (err) {
    console.error("[store] Failed to save state:", err);
  }
}

// ─── Templates ───

const TEMPLATES_FILE = join(dirname(new URL(import.meta.url).pathname), "..", ".chat-relay-templates.json");

export function loadTemplates(): RelayTemplate[] {
  try {
    if (!existsSync(TEMPLATES_FILE)) return [];
    const raw = readFileSync(TEMPLATES_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveTemplates(templates: RelayTemplate[]): void {
  try {
    const dir = dirname(TEMPLATES_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(TEMPLATES_FILE, JSON.stringify(templates, null, 2), "utf-8");
  } catch (err) {
    console.error("[store] Failed to save templates:", err);
  }
}
