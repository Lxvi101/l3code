# T3 Code

T3 Code is a minimal web GUI for coding agents (currently Codex and Claude, more coming soon).

## Installation

> [!WARNING]
> T3 Code currently supports Codex, Claude, and OpenCode.
> Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`

### Run without installing

```bash
npx t3
```

### Desktop app

Install the latest version of the desktop app from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), or from your favorite package registry:

#### Windows (`winget`)

```bash
winget install T3Tools.T3Code
```

#### macOS (Homebrew)

```bash
brew install --cask t3-code
```

#### Arch Linux (AUR)

```bash
yay -S t3code-bin
```

## THE RELAY — Agent-to-Agent Chat

THE RELAY lets you pair two AI agents together: one implements, one reviews, and they keep talking to each other until the work is done.

```bash
# Quick start (from repo root):
bun run relay
```

Or deploy alongside T3 Code as a systemd service:

```bash
./deploy/install-service.sh --with-relay
```

See [apps/chat-relay/README.md](./apps/chat-relay/README.md) for full docs, and [apps/chat-relay/bridge.md](./apps/chat-relay/bridge.md) for the technical deep dive.

## Deploy (server / Raspberry Pi)

The `deploy/` directory has a one-command installer for systemd:

```bash
# T3 Code only:
./deploy/install-service.sh

# T3 Code + THE RELAY:
./deploy/install-service.sh --with-relay

# Upgrade (pull + rebuild + restart):
git pull && ./deploy/install-service.sh --yes
```

Run `./deploy/install-service.sh --help` for all options. Works as both system and user services.

## Some notes

We are very very early in this project. Expect bugs.

We are not accepting contributions yet.

Observability guide: [docs/observability.md](./docs/observability.md)

## If you REALLY want to contribute still.... read this first

Before local development, prepare the environment and install dependencies:

```bash
# Optional: only needed if you use mise for dev tool management.
mise install
bun install .
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening an issue or PR.

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
