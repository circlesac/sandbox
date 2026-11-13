#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$ROOT/packages/envd"

# Cross-compilation verifies every Darwin package. The resulting test binaries
# cannot run on a Linux host, so behavior tests run on the matching macOS CI
# runner or inside the Tart guest.
GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 go test -exec /bin/true -run '^$' ./...
