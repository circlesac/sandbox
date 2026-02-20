# Sandbox

E2B-compatible sandbox that runs locally using Docker. Use the standard [E2B SDK](https://github.com/e2b-dev/e2b) — when ready for production, switch to real E2B by changing one URL.

See [PLAN.md](PLAN.md) for architecture and [docs/container-runtimes.md](docs/container-runtimes.md) for container runtime comparison.

## Quick Start

```bash
# Build the base image
docker build -t sandbox-base:latest docker/sandbox

# Install
brew install circlesac/tap/sandbox
# or: npx @circlesac/sandbox

# Initialize and run
sandbox init     # checks Docker, generates API key
sandbox serve    # starts the control plane on :49982
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
