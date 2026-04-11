# Project Mythos

## What This Is

Project Mythos is a standalone orchestrator that hooks into a running T3 Code server to enable autonomous, overnight multi-agent workflows. It is a separate process — a bridge — that connects as a WebSocket client to T3 Code's existing RPC API, the same one the web UI uses. It does not modify the T3 Code server, web app, or any shared packages.

This is critical because T3 Code is a fork that receives upstream updates. Any change to the core app risks merge conflicts and maintenance burden. Mythos lives entirely in `apps/bridge/` and can be deleted without affecting anything else.

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  T3 Code Server (apps/server)                                        │
│  - Manages provider sessions (Claude Agent, Codex)                   │
│  - Runs agents, captures checkpoints, streams events                 │
│  - Exposes WebSocket RPC at ws://localhost:3773                      │
│  - WE DO NOT MODIFY THIS                                             │
└──────────────┬───────────────────────────────────────────────────────┘
               │ WebSocket (same protocol the web UI uses)
               │
┌──────────────▼───────────────────────────────────────────────────────┐
│  Mythos Bridge (apps/bridge)                                         │
│                                                                      │
│  src/client.ts      → Resilient WS client with auto-reconnect       │
│  src/main.ts        → Entry point, wires everything together         │
│  src/eventBus.ts    → Mediates between workflow engine and UI        │
│  src/bridgeServer.ts→ HTTP server (serves UI) + WS (live events)    │
│  src/history.ts     → Persists chat sessions to disk as JSON         │
│  src/workflows/     → Pluggable workflow implementations             │
│  ui/                → React + Vite dashboard                         │
│                                                                      │
│  Serves its own UI at http://localhost:3100                           │
└──────────────────────────────────────────────────────────────────────┘
```

## How We Hook Into T3 Code

The bridge uses exactly three RPC methods and one event stream, all part of T3 Code's existing public WebSocket API:

### Methods We Call

| RPC Method                        | What We Use It For                                                  |
| --------------------------------- | ------------------------------------------------------------------- |
| `orchestration.getSnapshot`       | Read projects, threads, turn state, assistant messages              |
| `orchestration.dispatchCommand`   | Create threads (`thread.create`), start turns (`thread.turn.start`) |
| `orchestration.getFullThreadDiff` | Fetch the git diff after the coder agent finishes a turn            |
| `server.getConfig`                | Fetch available providers and models for the UI dropdowns           |

### Events We Listen To

| Push Channel                | Event                                   | Why                                                                                                |
| --------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `orchestration.domainEvent` | `thread.session-set` (status=`ready`)   | Primary completion signal — session transitioned from running with no active turn                  |
| `orchestration.domainEvent` | `thread.session-set` (status=`running`) | Track `sawRunning` flag — must see running before accepting ready (prevents stale false positives) |
| `orchestration.domainEvent` | `thread.session-set` (status=`error`)   | Detect session-level crashes                                                                       |
| `orchestration.domainEvent` | `thread.turn-diff-completed`            | Secondary completion signal — git checkpoint captured after turn finishes                          |
| `orchestration.domainEvent` | Any event for our thread                | Trigger streaming content refresh + reset inactivity timeout                                       |

### What We Do NOT Touch

- **No server code changes.** We connect as a regular WebSocket client.
- **No contracts changes.** We consume the existing schemas as-is.
- **No shared package changes.** We only import `@t3tools/contracts` as a dev dependency for types.
- **No web app changes.** The T3 Code UI is unaffected and runs independently.

If a feature cannot be built with the existing RPC API, we do not build it. The only exception would be if a missing API method is truly essential and can be contributed upstream without breaking changes — but this has not been necessary so far.

## The Coder-Reviewer Workflow

The primary workflow creates two T3 Code threads — one for a "Coder" agent, one for a "Reviewer" agent — and runs them in a loop:

```
1. Send task to Coder thread  →  Coder writes code
2. Fetch git diff from Coder's session
3. Send diff + coder output to Reviewer thread  →  Reviewer evaluates
4. If Reviewer says LGTM  →  done
5. Otherwise, send feedback back to Coder  →  goto 1
```

Each agent keeps full conversation history across iterations (same thread, multiple turns). The coder remembers everything it tried; the reviewer remembers everything it flagged.

## Key Design Decisions and Gotchas

### Turn Completion Detection

This was the hardest problem. `latestTurn.state === "completed"` in the snapshot is **not reliable** as a completion signal because the T3 server captures git checkpoints mid-turn — each checkpoint flips the state to `"completed"` while the agent is still executing tool calls.

The bridge uses the same approach as the web UI:

1. **Domain event signals:** Listen for `thread.session-set` where `status` transitions from `"running"` to `"ready"` (success) or `"error"` (failure) with `activeTurnId === null`. This is the primary completion signal. `thread.turn-diff-completed` is used as a secondary signal (fires after the git checkpoint is captured).
2. **Snapshot verification (mirrors `isLatestTurnSettled`):** After the event fires, verify via snapshot that `latestTurn.startedAt` and `latestTurn.completedAt` are both set, `session.status !== "running"`, and the assistant message has `streaming === false`.
3. **Stale turn guard:** The bridge tracks `sawRunning` — it must see the session in `"running"` state before accepting `"ready"` as completion. This prevents false positives from a stale session state left over from a previous turn.
4. **User message ID check:** Verify our user message (by `messageId`) exists in the thread's messages before reading results, confirming the server accepted our turn.
5. **Fallback polling:** Every 5 seconds, the bridge syncs the snapshot and checks the settled conditions even if domain events were missed (e.g., during a WebSocket reconnection window).

### Real-time Streaming

During a turn, the bridge streams the agent's output to the UI in real-time:

1. On every domain event for the active thread, the bridge fetches a fresh snapshot (throttled to 400ms).
2. The latest assistant message text and thread activities are pushed to the UI as a `UIStreamingMessage`.
3. The UI renders this as a live-updating bubble with an activity log (tool calls, file changes, etc.).
4. When the turn completes, the streaming message is cleared and the final response is emitted as a permanent `UIMessage`.

### Inactivity Timeout (Not Wall-Clock)

Agent turns can run for hours during complex tasks (reading hundreds of files, writing dozens). A fixed 10-minute wall-clock timeout kills legitimate long runs. Instead, the timeout resets every time any event arrives for the thread. It only fires after 10 minutes of total silence — meaning the agent has truly stopped producing output.

### Session State

An earlier design used a `workflow-state.json` file for crash recovery (resume from the last iteration). This caused a persistent bug: every new "Start" from the UI would resume the old crashed session, including its stale thread IDs and iteration count. The fix was to always start fresh — `state.clear()` at the top of every run. The UI's own history system (JSON files in `.bridge-state/history/`) handles session persistence instead.

### Message Bus Ownership

The EventBus owns the canonical message array. `getState()` returns a copy (for safety), which means external code cannot clear or replace messages by mutating the returned array. All mutations go through `emitMessage()` (append) or `replaceMessages()` (atomic swap + broadcast). The `replaceMessages` method was added specifically to fix a bug where session switching and "new session" appeared to do nothing — they were clearing a copy, not the real array.

## File Layout

```
apps/bridge/
├── src/
│   ├── main.ts                # Entry point — connects to T3, starts UI server
│   ├── client.ts              # WebSocket client → T3 server (auto-reconnect)
│   ├── eventBus.ts            # Message bus between workflow ↔ UI
│   ├── bridgeServer.ts        # HTTP + WS server for the dashboard
│   ├── history.ts             # Session persistence (JSON files on disk)
│   ├── config.ts              # Env-based configuration
│   ├── logger.ts              # Structured console + file logging
│   ├── state.ts               # Legacy workflow state (cleared on every run)
│   ├── types.ts               # Core interfaces
│   ├── prompts.ts             # Agent prompt templates
│   └── workflows/
│       ├── index.ts           # Workflow registry
│       ├── coderReviewer.ts   # Coder ↔ Reviewer loop
│       └── taskQueue.ts       # Sequential task execution
├── ui/
│   ├── src/
│   │   ├── App.tsx            # React dashboard (history, config, chat)
│   │   ├── index.css          # Dark theme
│   │   └── main.tsx           # React entry
│   ├── vite.config.ts
│   └── index.html
├── package.json
├── tsconfig.json
└── .env.example
```

## Running

```bash
# Start T3 Code server first (default port 3773)
# Then:
bun run apps/bridge/src/main.ts

# Open http://localhost:3100
# Pick project, select models, write task, hit Start
```

## Adding New Workflows

Implement the `Workflow` interface and register in `src/workflows/index.ts`:

```typescript
import type { Workflow, WorkflowContext, WorkflowResult } from "../types.ts";

export class MyWorkflow implements Workflow {
  readonly name = "my-workflow";
  async run(ctx: WorkflowContext): Promise<WorkflowResult> {
    // ctx.client  — T3 RPC client
    // ctx.eventBus — emit messages/status to the UI
    // ctx.signal  — AbortSignal for graceful stop
    // ctx.log     — structured logger
  }
}
```

## Rules

1. **Do not modify `apps/server/`, `apps/web/`, `packages/contracts/`, or `packages/shared/`.** If you need something from T3 Code, consume it through the existing WebSocket API.
2. **All bridge code lives in `apps/bridge/`.** It is self-contained and deletable.
3. **The bridge is a client, not a plugin.** It has zero hooks into the server's internals. It sees exactly what the web UI sees.
4. `bun fmt`, `bun lint`, and `bun typecheck` must all pass before considering work done.
