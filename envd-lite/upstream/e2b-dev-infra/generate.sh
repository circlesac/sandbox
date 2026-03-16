#!/bin/bash
# Generate Go code from .proto files.
# Requires: protoc, protoc-gen-go, protoc-gen-connect-go
#
#   go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
#   go install connectrpc.com/connect/cmd/protoc-gen-connect-go@latest
#   brew install protobuf  # for protoc
#
# Source: https://github.com/e2b-dev/infra/tree/main/packages/envd/spec

set -euo pipefail
cd "$(dirname "$0")"

GEN="github.com/circlesac/sandbox/envd-lite/upstream/e2b-dev-infra/gen"

rm -rf gen
mkdir -p gen

protoc \
  --proto_path=proto \
  --go_out=gen --go_opt=module="$GEN" \
  --go_opt=Mprocess.proto="$GEN/process" \
  --go_opt=Mfilesystem.proto="$GEN/filesystem" \
  --connect-go_out=gen --connect-go_opt=module="$GEN" \
  --connect-go_opt=Mprocess.proto="$GEN/process" \
  --connect-go_opt=Mfilesystem.proto="$GEN/filesystem" \
  proto/process.proto proto/filesystem.proto

echo "Generated Go code in gen/"
