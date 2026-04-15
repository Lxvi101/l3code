/**
 * Persistent Store
 *
 * Saves relay state to a JSON file so connections and pairs survive restarts.
 * Stored at `.chat-relay-state.json` next to the server entry point.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { PairConfig } from "./types";

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
  createdAt: string;
}

export interface PersistedState {
  version: 1;
  connection: PersistedConnection | null;
  pairs: PersistedPair[];
}

const STATE_FILE = join(
  dirname(new URL(import.meta.url).pathname),
  "..",
  ".chat-relay-state.json",
);

const EMPTY_STATE: PersistedState = {
  version: 1,
  connection: null,
  pairs: [],
};

export function loadState(): PersistedState {
  try {
    if (!existsSync(STATE_FILE)) return { ...EMPTY_STATE, pairs: [] };
    const raw = readFileSync(STATE_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed?.version !== 1) return { ...EMPTY_STATE, pairs: [] };
    return parsed as PersistedState;
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
