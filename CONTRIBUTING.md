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

### Tart base image setup

envd-lite must be pre-installed in the `sandbox-base` VM for the Tart backend to work.
One-time setup after cloning the base image:

```bash
# Boot the base VM
tart run sandbox-base --no-graphics &

# Wait for IP and install envd-lite
IP=$(tart ip --wait 30 sandbox-base)
SSH_AUTH_SOCK="" sshpass -p admin ssh -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null -o PreferredAuthentications=password \
  admin@$IP 'sudo mkdir -p /usr/local/bin'
cat envd-lite/envd-lite | SSH_AUTH_SOCK="" sshpass -p admin ssh \
  -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -o PreferredAuthentications=password admin@$IP \
  'cat > /tmp/envd-lite && sudo mv /tmp/envd-lite /usr/local/bin/envd-lite && sudo chmod +x /usr/local/bin/envd-lite'

# Create LaunchAgent for auto-start on boot
SSH_AUTH_SOCK="" sshpass -p admin ssh -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null -o PreferredAuthentications=password \
  admin@$IP 'mkdir -p ~/Library/LaunchAgents && printf "%s\n" \
  "<?xml version=\"1.0\" encoding=\"UTF-8\"?>" \
  "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">" \
  "<plist version=\"1.0\"><dict>" \
  "<key>Label</key><string>com.circlesac.envd-lite</string>" \
  "<key>ProgramArguments</key><array><string>/usr/local/bin/envd-lite</string><string>-port</string><string>49983</string></array>" \
  "<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>" \
  "<key>StandardOutPath</key><string>/tmp/envd-lite.log</string>" \
  "<key>StandardErrorPath</key><string>/tmp/envd-lite.log</string>" \
  "</dict></plist>" > ~/Library/LaunchAgents/com.circlesac.envd-lite.plist'

# Stop VM (saves the changes to disk)
tart stop sandbox-base
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
