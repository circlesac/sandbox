---
name: sandbox-guide
description: Guide for using the E2B-compatible local sandbox with Docker or Shuru microVMs
user-invocable: true
argument-hint: "<question-about-sandbox>"
---

# Sandbox

E2B-compatible sandbox that runs locally using Docker or Shuru microVMs. Use the standard E2B SDK — when ready for production, switch to real E2B by changing one config value.

## Quick Start

```bash
# Install
npm install -g @circlesac/sandbox

# Start (auto-generates API key on first run)
sandbox serve    # starts the control plane on :49982
```

## Architecture

```
E2B SDK → Control Plane (Hono on :49982) → Backend → Sandboxes (envd)
```

Backends:
- **Docker** (default): Linux containers via Docker Engine
- **Shuru** (macOS): Linux microVMs via Apple Virtualization.framework

The control plane proxies E2B SDK requests to sandbox instances running envd. Three routing layers:
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
| `sandbox serve` | Start the control plane server (auto-generates API key on first run) |
| `sandbox status` | Show health, backend, and running sandbox count |

## Backend Configuration

Edit `~/.sandbox/config.json` to set the backend:

```json
{
  "apiKey": "sk-sandbox-...",
  "backend": "shuru"
}
```

Omit `backend` or set to `"docker"` for Docker (default).

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/sandboxes` | Create a sandbox |
| GET | `/sandboxes` | List sandboxes |
| GET | `/sandboxes/:id` | Get sandbox info |
| DELETE | `/sandboxes/:id` | Kill a sandbox |
| POST | `/sandboxes/:id/timeout` | Update timeout |
| POST | `/sandboxes/:id/pause` | Pause a sandbox (Docker only) |
| POST | `/sandboxes/:id/resume` | Resume a paused sandbox (Docker only) |
| GET | `/health` | Health check (no auth) |

All endpoints except `/health` require `X-API-Key` header.

## Template Images

### Docker

Templates map to Docker images. Resolution order:
1. Local image: `sandbox-{templateId}:latest` (e.g., `sandbox-base:latest`)
2. GHCR fallback: `ghcr.io/circlesac/sandbox-{templateId}:latest`

Build the base image: `docker build -t sandbox-base:latest docker/sandbox`

### Shuru

Templates map to shuru checkpoints named `sandbox-{templateId}` (e.g., `sandbox-base`).

Create a checkpoint:
```bash
shuru checkpoint create sandbox-base --allow-net -- sh -c \
  'apk add --no-cache bash sudo curl wget && ...'
```

If no `sandbox-base` checkpoint exists, shuru runs a plain Alpine VM.
