# Upstream: e2b-dev/runtime

Proto definitions copied as-is from [e2b-dev/runtime](https://github.com/e2b-dev/runtime/tree/main/packages/envd/spec) (`packages/envd/spec/process` and `packages/envd/spec/filesystem`), last synced from commit `518278060a154124a80d98f37253f8af77baf478`. The repository was previously named `e2b-dev/infra`.

## Structure

```
proto/              .proto files (copied as-is from upstream)
gen/                Generated Go code (gitignored, regenerate with generate.sh)
generate.sh         protoc command to regenerate gen/ from proto/
```

## Sync and regenerate

Copy `process.proto` and `filesystem.proto` from the upstream paths above into `proto/`, record the commit here, then regenerate:

```bash
# Install dependencies (one-time)
go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
go install connectrpc.com/connect/cmd/protoc-gen-connect-go@latest
brew install protobuf

# Generate
go generate ./...
# or: bash upstream/e2b-dev-runtime/generate.sh
```
