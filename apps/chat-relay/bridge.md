# THE RELAY — Technical Documentation

## Overview

THE RELAY is an external service that connects to a running T3 Code server and orchestrates **chat pairs** — two AI agent threads that ping-pong messages to each other. It's built for workflows where one agent implements and another reviews, or any scenario where two agents collaborating produces better results than one working alone.

## Quick Start

### 1. Start T3 Code

```bash
cd /path/to/t3code
bun run build:contracts
bun apps/server/src/bin.ts serve --port 3773
```

### 2. Get an owner token

```bash
bun apps/server/src/bin.ts auth session issue --role owner --ttl 30d --token-only
```

Copy the token.

### 3. Start THE RELAY

```bash
bun run relay          # from repo root
# or: cd apps/chat-relay && bun run dev
```

### 4. Connect

Open **http://localhost:4401**, enter the T3 server URL and paste the token.

---

## Architecture

```
 Browser                    THE RELAY                   T3 Code
┌──────────┐              ┌──────────────┐            ┌──────────────┐
│ React UI │◄────ws────►  │  Bun Server  │◄───http───►│  Orchestr.   │
│ :4401    │              │  :4400       │            │  Engine      │
│          │              │              │            │  :3773       │
│ pair     │              │ relay engine │            │              │
│ view     │              │ templates    │            │ threads      │
│ threads  │              │ persistence  │            │ providers    │
└──────────┘              └──────────────┘            └──────────────┘
```

- **Bun Server** — HTTP for static files + WebSocket for real-time UI updates
- **Relay Engine** — creates T3 threads, dispatches turns, polls for completion, relays responses
- **React UI** — dual-pane chat view, pair management, template system
- **Persistence** — connection, pairs, and templates survive restarts (JSON on disk)

### Communication with T3

THE RELAY uses T3's HTTP REST API exclusively (no Effect RPC):

| Endpoint | Purpose |
|----------|---------|
| `POST /api/auth/bootstrap/bearer` | Exchange pairing token for bearer session |
| `GET /api/auth/session` | Validate a bearer token |
| `GET /api/orchestration/snapshot` | Read all projects, threads, messages, turn state |
| `POST /api/orchestration/dispatch` | Send commands (create thread, start turn, interrupt) |

Authentication requires an **owner-role** bearer token. Generate one with:
```bash
bun apps/server/src/bin.ts auth session issue --role owner --ttl 30d --token-only
```

The credential field in the UI accepts both bearer tokens and one-time pairing tokens.

---

## Relay Flow

### Basic ping-pong

```
 You type: "Implement a rate limiter"
                │
                ▼
     ┌──── Thread A (Implementer) ────┐
     │  receives message              │
     │  agent works (tool calls, etc) │
     │  produces response             │
     └───────────┬────────────────────┘
                 │
                 │  apply initialMessageB template (first time)
                 │  apply A→B modifications (every time)
                 ▼
     ┌──── Thread B (Reviewer) ───────┐
     │  receives modified response    │
     │  agent reviews, gives feedback │
     │  produces response             │
     └───────────┬────────────────────┘
                 │
                 │  apply B→A modifications
                 │  check stop signal
                 │  increment turn count
                 ▼
     ┌──── Thread A again ────────────┐
     │  receives review feedback      │
     │  implements changes            │
     │  ...                           │
     └────────────────────────────────┘

     Repeats until: stop signal | max turns | manual stop
```

### Turn completion detection

THE RELAY uses a three-layer gate to ensure it only picks up the **final** response from an agent turn, not intermediate text between tool calls:

1. **`seenRunning` gate** — after dispatching `startTurn`, the relay refuses to accept any terminal state until it first sees the turn in `"running"` state. This prevents picking up a stale "completed" left over from the previous turn.

2. **`activeTurnId` tracking** — once "running" is seen, the relay locks onto that specific turn ID and ignores completions from different turns.

3. **`sessionBusy` check** — even when `latestTurn.state === "completed"`, if `session.status` is still `"running"`, the agent is still executing tool calls. The relay waits until the session settles.

### Polling

| Timer | Interval | Purpose |
|-------|----------|---------|
| **Active poll** | 2 seconds | Checks turn state while a pair is running |
| **Background refresh** | 10 seconds | Keeps projects/threads in sync when idle |

The active poll only runs when there are pending turns. The background refresh skips when active polling is already running (no double-fetching).

---

## Configuration Reference

### Pair Settings

| Field | Description |
|-------|-------------|
| **Pair Name** | Human-readable label |
| **Project** | T3 project to create threads under |
| **Agent A Model** | Provider + model for the implementer |
| **Agent B Model** | Optional override — e.g. a cheaper model for the reviewer |
| **Runtime Mode** | `Full Access` / `Auto-Accept Edits` / `Approval Required` |
| **Agent A Label** | Display name for Thread A |
| **Agent B Label** | Display name for Thread B |
| **Agent A Starting Prompt** | First message sent to Thread A |
| **Agent B Starting Prompt** | Template for B's first message. Use `{{response}}` for A's response |
| **Stop Signal** | Regex — if either agent's response matches, the relay stops |
| **Max Turns** | Auto-stop after N full round-trips (0 = unlimited) |

### Starting Prompts

**Agent A** receives `initialMessage` directly as the first user message.

**Agent B** receives `initialMessageB` with `{{response}}` replaced by Agent A's actual response. This only applies to the **first** A→B relay. Example:

```
You are a senior code reviewer. Review the following implementation
and provide thorough, actionable feedback:

{{response}}
```

If `initialMessageB` is empty, Agent A's raw response is sent to B directly.

### Per-Turn Modifications

Applied on **every** relay (including after `initialMessageB` on the first turn). Four types:

| Type | Behavior |
|------|----------|
| **Prefix** | Prepends text before the message |
| **Suffix** | Appends text after the message |
| **Replace** | Regex find-and-replace on the message text |
| **Wrap** | Template with `{{message}}` placeholder |

Configured per-direction: A→B and B→A independently.

**Example**: To remind Agent B on every turn that it's a reviewer:
- Direction: A→B
- Type: Prefix
- Value: `Remember: you are reviewing code, not implementing it. Focus on bugs, edge cases, and code quality.\n\n`

### Available Models

**Claude Agent** (`claudeAgent`):

| Model ID | Name |
|----------|------|
| `claude-opus-4-6` | Claude Opus 4.6 |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 |
| `claude-haiku-4-5` | Claude Haiku 4.5 |

**Codex** (`codex`):

| Model ID | Name |
|----------|------|
| `gpt-5.4` | GPT-5.4 |
| `gpt-5.4-mini` | GPT-5.4 Mini |
| `gpt-5.3-codex` | GPT-5.3 Codex |

---

## Templates

Templates save all pair settings (except name and project) so you can quickly create new pairs with pre-configured roles.

### Built-in workflow: Code Review

- **Agent A** = Implementer (Opus 4.6)
- **Agent B** = Reviewer (Haiku 4.5)
- **B starting prompt** = `Review this implementation:\n\n{{response}}`
- **A→B mod** = Prefix: `You are reviewing, not implementing.\n\n`

### Save / Load

- **Save**: click "Save as Template" in the create dialog
- **Load**: click any template chip to pre-fill the form, then customize
- **Delete**: hover a template chip and click X

### Export / Import

- **Export**: downloads all templates as `relay-templates.json`
- **Import**: upload a JSON file to merge templates (duplicates are updated by ID)

Templates are stored at `apps/chat-relay/.chat-relay-templates.json`.

---

## Resumability

### Completed pairs can be continued

When a pair finishes (completed, stopped, or errored), a text input appears at the bottom. Type new instructions and they're sent to Agent A, restarting the ping-pong loop. Turn count continues from where it left off.

### Server restarts

THE RELAY persists to disk:
- **Connection** — T3 URL + bearer token (auto-reconnects on boot)
- **Pairs** — thread IDs, config, status, pending dispatch
- **Templates** — saved separately

On restart, pairs are rehydrated with their full message history from T3's snapshot.

### Usage-limit recovery

If a provider returns a rate-limit error (e.g. "You've hit your limit, resets 8pm"), the relay:
1. Parses the reset time (supports timezone-aware formats like "8pm (Europe/Zurich)")
2. Sets the pair to **paused** (amber in UI, not red)
3. Schedules automatic retry at the parsed reset time
4. If unparseable, defaults to a 5-minute retry

Paused pairs can also be manually resumed.

---

## Deployment

### systemd (recommended for servers)

```bash
# Install T3 + THE RELAY as systemd services:
./deploy/install-service.sh --with-relay

# Or THE RELAY only:
./deploy/install-service.sh --relay-only

# Non-interactive:
./deploy/install-service.sh --with-relay --yes

# Preview without installing:
./deploy/install-service.sh --with-relay --dry-run
```

### Upgrade

```bash
git pull
cd apps/chat-relay && bun install && bun run build
sudo systemctl restart t3code-relay
```

Or re-run the full installer:

```bash
./deploy/install-service.sh --relay-only --yes
```

### Service management

```bash
# Status
systemctl status t3code-relay

# Logs (live)
journalctl -u t3code-relay -f

# Stop
systemctl stop t3code-relay

# Restart
systemctl restart t3code-relay
```

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `RELAY_SERVER_PORT` | `4400` | Bun server port |
| `RELAY_SERVER_HOST` | `0.0.0.0` | Bind address |
| `RELAY_CLIENT_PORT` | `4401` | Vite dev server port (dev mode only) |

---

## Troubleshooting

### "T3 authentication failed"

The pairing token is one-time-use. If already consumed, generate a bearer token instead:
```bash
bun apps/server/src/bin.ts auth session issue --role owner --ttl 30d --token-only
```

### "Only owner sessions can manage projects"

You're using a client-role token. The orchestration API requires owner role. Re-issue with `--role owner`.

### No projects in the dropdown

T3 needs at least one project. Open the T3 web UI and add a folder as a project.

### Can't reach THE RELAY over the network

The server binds to `0.0.0.0` by default. Check:
- Firewall: `sudo iptables -L ts-input -n` (Tailscale), `sudo ufw status`
- Port: `ss -tlnp | grep 4400`
- Correct IP: `tailscale ip` (not the remote machine's IP)

### "T3 connection lost" / ECONNRESET

T3's server has an idle timeout. THE RELAY polls every 2 seconds and uses 8-second fetch timeouts to stay under T3's 10-second limit. If you see persistent failures:
- Verify T3 is still running: `systemctl status t3code`
- Check T3 logs: `journalctl -u t3code -f`

### Port already in use

```bash
lsof -ti :4400 | xargs kill -9
```

---

## Files

```
apps/chat-relay/
├── server/
│   ├── index.ts           # Bun HTTP + WebSocket server
│   ├── relay-engine.ts    # Core relay logic, polling, turn detection
│   ├── t3-client.ts       # T3 Code HTTP API client
│   ├── store.ts           # JSON persistence (state + templates)
│   └── types.ts           # Shared types (server ↔ client protocol)
├── src/
│   ├── App.tsx            # Root component
│   ├── hooks/useRelay.ts  # WebSocket hook
│   └── components/
│       ├── ChatPairView.tsx      # Message view + controls + input
│       ├── CreatePairDialog.tsx  # Create pair form + templates
│       ├── MessageBubble.tsx     # Individual message display
│       ├── PairSidebar.tsx       # Pair + thread list sidebar
│       └── ThreadView.tsx        # Standalone thread viewer
├── .chat-relay-state.json       # Persisted connection + pairs (auto-generated)
├── .chat-relay-templates.json   # Saved templates (auto-generated)
├── bridge.md                    # This file
├── README.md                    # Quick start
└── package.json
```
