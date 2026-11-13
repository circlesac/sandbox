#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
OS=${GOOS:-darwin}
ARCH=${GOARCH:-arm64}
OUTPUT=${OUTPUT:-"$ROOT/dist/envd-$OS-$ARCH"}

mkdir -p "$(dirname -- "$OUTPUT")"
cd "$ROOT/packages/envd"

CGO_ENABLED=0 GOOS="$OS" GOARCH="$ARCH" go build \
  -trimpath \
  -buildvcs=false \
  -ldflags "-s -w" \
  -o "$OUTPUT" .

chmod 0755 "$OUTPUT"
printf '%s\n' "$OUTPUT"
