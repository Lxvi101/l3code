/**
 * Structured logger with console + optional file output.
 * Designed for overnight runs where you need a clear audit trail.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Logger, LogLevel } from "./types.ts";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: "\x1b[90m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};

const RESET = "\x1b[0m";

export function createLogger(minLevel: LogLevel, filePath?: string): Logger {
  const minPriority = LEVEL_PRIORITY[minLevel];

  if (filePath) {
    mkdirSync(dirname(filePath), { recursive: true });
  }

  function write(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
    if (LEVEL_PRIORITY[level] < minPriority) return;

    const ts = new Date().toISOString();
    const tag = level.toUpperCase().padEnd(5);

    // Console output (colored)
    const color = LEVEL_COLORS[level];
    const consoleLine = `${"\x1b[90m"}${ts}${RESET} ${color}${tag}${RESET} ${msg}`;
    if (level === "error") {
      console.error(consoleLine);
    } else {
      console.log(consoleLine);
    }

    if (data) {
      const dataStr = JSON.stringify(data, null, 2);
      for (const line of dataStr.split("\n")) {
        console.log(`${"  "}${"\x1b[90m"}${line}${RESET}`);
      }
    }

    // File output (plain text)
    if (filePath) {
      let fileLine = `${ts} ${tag} ${msg}\n`;
      if (data) fileLine += `${JSON.stringify(data)}\n`;
      try {
        appendFileSync(filePath, fileLine);
      } catch {
        // Swallow file write errors — don't crash the bridge over logging
      }
    }
  }

  return {
    debug: (msg, data) => write("debug", msg, data),
    info: (msg, data) => write("info", msg, data),
    warn: (msg, data) => write("warn", msg, data),
    error: (msg, data) => write("error", msg, data),
    close: () => {
      // No-op for now — could flush buffers if we switch to async writes
    },
  };
}
