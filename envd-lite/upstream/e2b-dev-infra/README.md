# Upstream: e2b-dev/infra

Proto definitions copied from [e2b-dev/infra](https://github.com/e2b-dev/infra/tree/main/packages/envd/spec).

## Structure

```
proto/              .proto files (copied as-is from upstream)
gen/                Generated Go code (gitignored, regenerate with generate.sh)
generate.sh         protoc command to regenerate gen/ from proto/
```

## Regenerate

```bash
# Install dependencies (one-time)
go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
go install connectrpc.com/connect/cmd/protoc-gen-connect-go@latest
brew install protobuf

# Generate
go generate ./...
# or: bash upstream/e2b-dev-infra/generate.sh
```
