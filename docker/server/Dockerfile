FROM oven/bun:1 AS builder

ARG TARGETARCH

WORKDIR /src
COPY cli/package.json cli/bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY cli/ ./
RUN BUN_TARGET=$(case "${TARGETARCH}" in arm64) echo bun-linux-arm64;; *) echo bun-linux-x64;; esac) \
    && bun build --compile --target="${BUN_TARGET}" --external cpu-features src/index.ts --outfile /sandbox

FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /sandbox /usr/local/bin/sandbox

ENTRYPOINT ["/usr/local/bin/sandbox"]
CMD ["serve"]
