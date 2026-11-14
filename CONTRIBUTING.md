# Contributing

## Development

```bash
cd cli
bun install
bun run dev serve        # run server in dev mode
bun run test             # format check, lint, type check, unit + integration tests
bun run test:local       # format, lint, types, unit tests, every local provider, SDK matrix, envd-lite fallback
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

`test:docker`, `test:tart`, and `test:shuru` fail with the missing prerequisite when the provider is not set up, instead of skipping. `test:local` runs what this machine can, including the envd-lite compatibility fallback when Go and protoc are installed, and lists what it could not run and why.

The Tart memory-resume test explicitly reports a skip if macOS cannot save VM memory or rejects restoring it with `VZErrorDomain: permission denied`. Before skipping a rejected restore, it verifies that the API reports the failure and the VM remains suspended. Other resume errors fail the suite; a skip does not establish working memory restore on that host.

`test:upstream` checks out a pinned commit of [e2b-dev/runtime](https://github.com/e2b-dev/runtime) under `~/.cache/sandbox`, starts a control plane, and runs upstream's `tests/integration` API and envd suites against it. It prints a pass/fail table (`--out <file>` saves it) and exits with a non-zero status if any test listed in `cli/scripts/upstream-baseline.txt` did not pass (regression); newly passing tests outside the baseline are reported as improvements and do not fail the run. Pass `--run <regex>` to run a subset (only baseline tests that ran are compared). After fixing conformance or adding coverage, refresh the baseline with `bun run test:upstream --update-baseline`.

`test:coverage` counts only code that runs inside the vitest process. The integration suites drive a server started as a separate process, so the routes, proxy, and envd client they exercise appear uncovered there.

The Docker integration tests need a running Docker daemon and a local `sandbox-base:latest` image. Build it with `docker build -t sandbox-base:latest ../docker/sandbox`, or pull `ghcr.io/circlesac/sandbox-base:latest` and tag it as `sandbox-base:latest`. Without a local tag, every sandbox creation pulls from GHCR, which can outlast the SDK's 60-second request timeout. Locally the suite is skipped when Docker is unavailable; in CI that is a failure. Docker suites receive their server address through Vitest's per-run context, and each run prints its private server log path; concurrent invocations do not share a server-info file. Cleanup removes only the sandboxes each suite created.

`test:sdk-matrix` installs each E2B SDK version into a temporary directory and runs `test/integration/e2b-smoke.spec.ts` with the `e2b` import pointed at it. The lowest supported version is the floor of the `e2b` range in `cli/package.json`. Pass versions as arguments to test others, for example `bun run test:sdk-matrix 2.40.0`.

Pull requests run the same `test` and `test:sdk-matrix` scripts in `.github/workflows/test.yml`, against a base image built from the pull request.

### Tooling

| Package | Version | Registry date | Reason |
| --- | --- | --- | --- |
| `@biomejs/biome` | 2.6.3 | 2026-10-24 | One natively compiled tool for formatting and linting, configured from `biome init` plus one override: `noExplicitAny` is raised from warning to error. |

### Darwin envd (Tart backend)

```bash
cd envd-darwin
GOARCH=arm64 ./test.sh
GOARCH=arm64 ./build.sh
```

The release workflow publishes the resulting Darwin binaries as versioned
`envd-darwin-arm64` and `envd-darwin-amd64` GitHub Release assets with SHA-256
files. The Tart base image should install a pinned release asset when preparing
the VM.

### Tart base image setup

The Darwin envd must be pre-installed in the `sandbox-base` VM for the Tart backend to work.
One-time setup after cloning the base image:

Use Tart 2.41.1 or newer. Older Tart releases can stop polling when the bridged
ARP cache is empty while a guest is still booting.

```bash
# Boot the base VM
tart run sandbox-base --no-graphics &

# Download, verify, install, and bootstrap the pinned Darwin envd release.
TART_IP_RESOLVER=arp ./envd-darwin/install-release.sh <release-tag> sandbox-base

# Stop VM (saves the changes to disk)
tart stop sandbox-base
```

The Tart backend can use bridged networking with `TART_NET_BRIDGED=en0` and
`TART_IP_RESOLVER=arp`. ARP resolution depends on guest network traffic. The
default NAT network uses DHCP resolution instead. If the host creates many VMs,
reduce the macOS DHCP lease time before running the suite:

```bash
sudo defaults write /Library/Preferences/SystemConfiguration/com.apple.InternetSharing.default.plist \
  bootpd -dict DHCPLeaseTimeSecs -int 600
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
envd-darwin/           # Pinned upstream envd source and Darwin release tooling
envd-lite/             # Compatibility fallback for older Tart base images
docker/sandbox/       # Docker base image
docs/                 # Backend comparison docs
```
