# Sandbox

E2B-compatible sandbox that runs locally using Docker or Shuru microVMs. Use the standard [E2B SDK](https://github.com/e2b-dev/e2b) — when ready for production, switch to real E2B by changing one URL.

See [docs/container-runtimes.md](docs/container-runtimes.md) for backend comparison.

## Quick Start

### Docker (default)

```bash
# Build the base image
docker build -t sandbox-base:latest docker/sandbox

# Install
brew install circlesac/tap/sandbox
# or: npx @circlesac/sandbox

# Start (auto-generates API key on first run)
sandbox serve    # starts the control plane on :49982
```

### Shuru (macOS, Apple Virtualization)

```bash
# Install shuru
brew install shuru

# Create sandbox checkpoint (see docs/container-runtimes.md)
shuru checkpoint create sandbox-base --allow-net -- sh -c '...'

# Set backend in ~/.sandbox/config.json
# { "apiKey": "...", "backend": "shuru" }

# Start
sandbox serve
```

## Development

```bash
cd cli
bun install
bun run dev serve     # run server in dev mode
bun run test          # unit + integration tests (starts server automatically)
bun run typecheck
```

## Skills

| Skill | Description |
|-------|-------------|
| **sandbox-guide** | Usage guide — SDK examples, API endpoints, template images |

### Claude Code

```bash
/plugin marketplace add circlesac/sandbox
/plugin install sandbox
```

### Pi

```bash
pi install git:circlesac/sandbox
```
