# Contributing

## Development

```bash
cd cli
bun install
bun run dev serve     # run server in dev mode
npx vitest run        # unit + integration tests
bun run typecheck
```

### envd-lite (Tart backend)

```bash
cd envd-lite
go generate ./...     # regenerate protobuf code from upstream .proto files
go build -o envd-lite .
```

## Project Structure

```
cli/                  # Control plane server + CLI
  src/server/         # Hono API server, sandbox service, proxy
  src/server/services/
    docker.ts         # Docker backend
    shuru.ts          # Shuru backend
    tart.ts           # Tart backend
  test/               # Unit + integration tests
envd-lite/            # Minimal envd for macOS VMs (Go, connectrpc)
  service/            # Our code: process, filesystem, REST handlers
  upstream/           # Code from e2b-dev/infra (proto files + generate.sh)
docker/sandbox/       # Docker base image
docs/                 # Backend comparison docs
```
