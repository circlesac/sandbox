FROM debian:bookworm-slim

ARG TARGETARCH

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && ARCH=$(case "${TARGETARCH}" in arm64) echo arm64;; *) echo amd64;; esac) \
    && VERSION=$(curl -fsSL https://api.github.com/repos/circlesac/sandbox/releases/latest | grep '"tag_name"' | cut -d'"' -f4 | sed 's/^v//') \
    && curl -fsSL "https://github.com/circlesac/sandbox/releases/download/v${VERSION}/sandbox-linux-${ARCH}.tar.gz" \
       | tar xz -C /usr/local/bin \
    && chmod +x /usr/local/bin/sandbox \
    && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

ENTRYPOINT ["/usr/local/bin/sandbox"]
CMD ["serve"]
