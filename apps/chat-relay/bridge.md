# Chat Relay — Bridge Setup Guide

The Chat Relay is an external service that connects to a running T3 Code server and creates **chat pairs** — two AI threads that automatically ping-pong messages to each other until a stop signal or turn limit is reached.

## Quick Start

You need **two terminals**:

### Terminal 1 — Start T3 Code Server

```bash
cd /path/to/t3code-main

# Build the contracts package (required dependency)
bun run build:contracts

# Start T3 in headless "serve" mode
bun apps/server/src/bin.ts serve --port 3773
```

The `serve` command prints a one-time **pairing token** on startup:

```
T3 Code server is ready.
Connection string: http://127.0.0.1:3773
Token: abc123-xxxx-yyyy-zzzz          <── copy this
```

> **Note:** You need at least one project in T3 for the relay to work.
> If T3 is fresh, open `http://127.0.0.1:3773` in a browser, pair with
> the token, and add a project (folder) first.

### Terminal 2 — Start Chat Relay

```bash
cd apps/chat-relay
bun install   # first time only
bun run dev
```

This starts:
- **Bun backend** on `http://localhost:4400`
- **Vite dev server** on `http://localhost:4401`

Open **http://localhost:4401** in your browser.

### Connect

1. **T3 Server URL:** `http://localhost:3773`
2. **Pairing Credential:** paste the token from Terminal 1
3. Click **Connect**

You're in. Create a chat pair and hit Start.

---

## How It Works

```
┌──────────────┐         ┌──────────────┐         ┌──────────────┐
│  React UI    │◄──ws──► │  Bun Server  │◄──http──►│  T3 Code     │
│  :4401       │         │  :4400       │         │  :3773       │
│              │         │              │         │              │
│  dual-pane   │         │  relay       │         │  orchestr.   │
│  chat view   │         │  engine      │         │  engine      │
└──────────────┘         └──────────────┘         └──────────────┘
```

1. The Bun server authenticates with T3 via `POST /api/auth/bootstrap/bearer`
2. It creates two threads in T3 (Thread A and Thread B)
3. Sends the initial message to Thread A via `POST /api/orchestration/dispatch`
4. Polls `GET /api/orchestration/snapshot` every 500ms to detect turn completion
5. When Thread A's assistant response is complete:
   - Checks for stop signal (regex match)
   - Applies configured modifications (prefix / suffix / replace / wrap)
   - Sends the modified text to Thread B as a new turn
6. Same in reverse when Thread B completes
7. Repeats until: stop signal detected, max turns reached, or manual stop

---

## Configuration Reference

### Pair Settings

| Field | Description |
|-------|-------------|
| **Pair Name** | Human-readable label for this pair |
| **Project** | T3 project to create threads under |
| **Provider** | `Claude Agent` or `Codex` |
| **Model** | Which model to use (e.g. `claude-sonnet-4-6`) |
| **Runtime Mode** | `Full Access` / `Auto-Accept Edits` / `Approval Required` |
| **Thread A / B Label** | Display names for each side |
| **Initial Message** | First message sent to Thread A to kick things off |
| **Stop Signal** | Regex — if an assistant response matches, the relay stops |
| **Max Turns** | Auto-stop after N full round-trips (0 = unlimited) |

### Modifications

Applied to the assistant's output before relaying it to the other thread:

| Type | Behavior |
|------|----------|
| **Prefix** | Prepends text before the message |
| **Suffix** | Appends text after the message |
| **Replace** | Regex find-and-replace on the message text |
| **Wrap** | Template with `{{message}}` placeholder |

Modifications are configured per-direction: A→B and B→A independently.

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

## T3 Server Options

```bash
# Headless mode (recommended for relay)
bun apps/server/src/bin.ts serve --port 3773

# Custom host (e.g. for remote access)
bun apps/server/src/bin.ts serve --host 0.0.0.0 --port 3773

# With full T3 web UI as well
bun run dev                         # starts server + web UI
bun apps/server/src/bin.ts auth pairing create --token-only   # get a token
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `RELAY_SERVER_PORT` | `4400` | Bun backend port |
| `RELAY_CLIENT_PORT` | `4401` | Vite dev server port |

---

## Production Build

```bash
cd apps/chat-relay
bun run build          # builds Vite frontend + Bun server
bun run start          # serves everything from :4400
```

---

## Troubleshooting

**"T3 authentication failed"**
- The pairing token is one-time-use. If it was already used (e.g. by a browser),
  generate a new one: `bun apps/server/src/bin.ts auth pairing create --token-only`

**"Not connected to T3"**
- Make sure the T3 server is running on the URL you entered
- Check that the port matches (`--port 3773`)

**No projects in the dropdown**
- T3 needs at least one project. Open the T3 web UI and add a folder as a project first.

**Port already in use**
- Kill stale processes: `lsof -ti :4400 -ti :4401 | xargs kill -9`
