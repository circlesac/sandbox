---
name: sandbox-guide
description: Guide for using the E2B-compatible local sandbox with Docker
user-invocable: true
argument-hint: "<question-about-sandbox>"
---

# Sandbox

E2B-compatible sandbox that runs locally using Docker. Use the standard E2B SDK — when ready for production, switch to real E2B by changing one config value.

## Quick Start

```bash
# Install and initialize
npm install -g @circlesac/sandbox
sandbox init     # checks Docker, generates API key
sandbox serve    # starts the control plane on :49982
```

## Architecture

```
E2B SDK → Control Plane (Hono on :49982) → Docker → Containers (envd)
```

The control plane proxies E2B SDK requests to Docker containers running envd. Three routing layers:
1. **Host header** — `{port}-{sandboxId}.{domain}` for domain-based routing
2. **E2b-Sandbox-Id header** — gRPC transport (commands, process)
3. **X-Access-Token header** — envd REST API (files, health)

## Using with E2B SDK

```typescript
import { Sandbox } from "e2b";

const sandbox = await Sandbox.create("base", {
  apiUrl: "http://localhost:49982",
  apiKey: "your-api-key",        // from ~/.sandbox/config.json
  sandboxUrl: "http://localhost:49982",
});

// Run commands
const result = await sandbox.commands.run("echo hello");
console.log(result.stdout); // "hello\n"

// File operations
await sandbox.files.write("/tmp/test.txt", "content");
const content = await sandbox.files.read("/tmp/test.txt");

// List directory
const entries = await sandbox.files.list("/tmp");

// Cleanup
await sandbox.kill();
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `sandbox init` | Check Docker, generate API key, write `~/.sandbox/config.json` |
| `sandbox serve` | Start the control plane server |
| `sandbox status` | Show health and running sandbox count |

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/sandboxes` | Create a sandbox |
| GET | `/sandboxes` | List sandboxes |
| GET | `/sandboxes/:id` | Get sandbox info |
| DELETE | `/sandboxes/:id` | Kill a sandbox |
| POST | `/sandboxes/:id/timeout` | Update timeout |
| POST | `/sandboxes/:id/pause` | Pause a sandbox |
| POST | `/sandboxes/:id/resume` | Resume a paused sandbox |
| GET | `/health` | Health check (no auth) |

All endpoints except `/health` require `X-API-Key` header.

## Template Images

Templates map to Docker images. Resolution order:
1. Local image: `sandbox-{templateId}:latest` (e.g., `sandbox-base:latest`)
2. GHCR fallback: `ghcr.io/circlesac/sandbox-{templateId}:latest`

The default template is `base` which uses the envd-based sandbox image.
