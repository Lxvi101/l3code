# THE RELAY

**Agent-to-agent chat relay for T3 Code.**

THE RELAY connects to a running [T3 Code](../../README.md) server and lets you create **chat pairs** — two AI agents that automatically talk to each other. Agent A implements, Agent B reviews, and they keep going back and forth until the work is done (or a stop signal is reached).

## Install

```bash
cd apps/chat-relay
bun install
```

## Run (development)

```bash
# From the repo root — one command:
bun run relay

# Or from apps/chat-relay:
bun run dev
```

Opens on **http://localhost:4401** (Vite dev server). The Bun backend runs on `:4400`.

## Run (production / server)

```bash
cd apps/chat-relay
bun run build
bun run start
```

Everything served from **http://0.0.0.0:4400**.

## Deploy as a systemd service

```bash
# T3 Code + THE RELAY together:
./deploy/install-service.sh --with-relay

# THE RELAY only (T3 already deployed):
./deploy/install-service.sh --relay-only

# Dry run (preview the unit files without installing):
./deploy/install-service.sh --with-relay --dry-run
```

See `./deploy/install-service.sh --help` for all options.

## Upgrade

```bash
cd ~/your-repo
git pull
cd apps/chat-relay
bun install
bun run build
sudo systemctl restart t3code-relay
```

Or re-run the installer to rebuild everything in one go:

```bash
./deploy/install-service.sh --relay-only --yes
```

## Connect to T3

THE RELAY needs an **owner-level bearer token** from T3:

```bash
bun apps/server/src/bin.ts auth session issue --role owner --ttl 30d --token-only
```

Paste it into the credential field in the UI. The token is saved on disk and survives restarts.

## Documentation

- **[How it works](./bridge.md)** — architecture, relay flow, configuration reference, templates, troubleshooting
- **[Deploy guide](../../deploy/)** — systemd installer, service examples

## Quick example: Code Review Loop

1. Open THE RELAY UI
2. Click **Create Chat Pair**
3. Load the "Code Review" template (or configure manually):
   - **Agent A** (Implementer): Claude Opus 4.6
   - **Agent B** (Reviewer): Claude Haiku 4.5
   - **A starting prompt**: `Implement a rate limiter for our API endpoints`
   - **B starting prompt**: `You are a senior code reviewer. Review the implementation and provide actionable feedback:\n\n{{response}}`
   - **A→B per-turn mod** (prefix): `Remember: review only, don't implement.\n\n`
4. Click **Start** — watch them collaborate in real-time
5. When done, type new instructions in the input box to continue the conversation
