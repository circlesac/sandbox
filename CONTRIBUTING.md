# Contributing

## Development

```bash
cd cli
bun install
bun run dev serve        # run server in dev mode
bun run test             # format check, lint, type check, unit + integration tests
bun run test:local       # unit tests, every provider set up on this machine, SDK matrix
bun run test:unit        # unit tests only
bun run test:docker      # E2B smoke suite on the Docker backend
bun run test:tart        # E2B smoke suite on Tart macOS VMs
bun run test:shuru       # E2B smoke suite on Shuru microVMs
bun run test:sdk-matrix  # Docker integration suites on the lowest supported and the latest SDK
bun run test:envd-lite   # envd-lite: go generate, gofmt, go vet, go test
bun run test:upstream    # e2b-dev/runtime API/envd tests; fails on baseline regressions
bun run test:coverage    # all tests with a coverage report for src/
bun run format           # apply formatting
```

`test:docker`, `test:tart`, and `test:shuru` fail with the missing prerequisite when the provider is not set up, instead of skipping. `test:local` runs what this machine can, including envd-lite when Go and protoc are installed, and lists what it could not run and why.

`test:upstream` checks out a pinned commit of [e2b-dev/runtime](https://github.com/e2b-dev/runtime) under `~/.cache/sandbox`, starts a control plane, and runs upstream's `tests/integration` API and envd suites against it. It prints a pass/fail table (`--out <file>` saves it) and exits with a non-zero status if any test listed in `cli/scripts/upstream-baseline.txt` did not pass (regression); newly passing tests outside the baseline are reported as improvements and do not fail the run. Pass `--run <regex>` to run a subset (only baseline tests that ran are compared). After fixing conformance or adding coverage, refresh the baseline with `bun run test:upstream --update-baseline`.

`test:coverage` counts only code that runs inside the vitest process. The integration suites drive a server started as a separate process, so the routes, proxy, and envd client they exercise appear uncovered there.

The Docker integration tests need a running Docker daemon and a local `sandbox-base:latest` image. Build it with `docker build -t sandbox-base:latest docker/sandbox`, or pull `ghcr.io/circlesac/sandbox-base:latest` and tag it as `sandbox-base:latest`. Without a local tag, every sandbox creation pulls from GHCR, which can outlast the SDK's 60-second request timeout. Locally the suite is skipped when Docker is unavailable; in CI that is a failure.

`test:sdk-matrix` installs each E2B SDK version into a temporary directory and runs `test/integration/e2b-smoke.spec.ts` with the `e2b` import pointed at it. The lowest supported version is the floor of the `e2b` range in `cli/package.json`. Pass versions as arguments to test others, for example `bun run test:sdk-matrix 2.40.0`.

Pull requests run the same `test` and `test:sdk-matrix` scripts in `.github/workflows/test.yml`, against a base image built from the pull request.

### Tooling

| Package | Version | Registry date | Reason |
| --- | --- | --- | --- |
| `@biomejs/biome` | 2.6.3 | 2026-10-24 | One natively compiled tool for formatting and linting, configured from `biome init` plus one override: `noExplicitAny` is raised from warning to error. |

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
  upstream/           # Code from e2b-dev/runtime (proto files + generate.sh)
docker/sandbox/       # Docker base image
docs/                 # Backend comparison docs
```
