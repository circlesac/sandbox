# Stage 1: Build envd from e2b-dev/runtime source (formerly e2b-dev/infra)
FROM golang:latest AS envd-builder
RUN git clone --depth 1 https://github.com/e2b-dev/runtime.git /src
WORKDIR /src/packages/envd
RUN make build

# Stage 2: Sandbox image
FROM ubuntu:latest

COPY --from=envd-builder /src/packages/envd/bin/envd /usr/bin/envd
RUN chmod +x /usr/bin/envd

# Install base development tools
# python-is-python3 provides `python`, as E2B's base template does; socat and
# iproute2 (ss) are for sandbox-portf below.
RUN apt-get update && apt-get install -y \
    git curl wget sudo ca-certificates \
    python3 python3-pip python-is-python3 \
    build-essential socat iproute2 \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js LTS
RUN curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Create default user with passwordless sudo
RUN useradd -m -s /bin/bash -G sudo user \
    && echo 'user ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers

# envd runs as root and reopens files the default user owns. With
# fs.protected_regular enabled on the host (the Ubuntu default), the kernel
# refuses that in sticky world-writable directories, so the second write to a
# /tmp file fails with "permission denied". The sysctl is host-wide, so drop
# the sticky bit in the image instead.
RUN chmod 0777 /tmp /var/tmp

WORKDIR /home/user

EXPOSE 49983

COPY sandbox-portf /usr/local/bin/sandbox-portf

# envd runs as PID 1 in non-Firecracker mode; sandbox-portf forwards ports that
# listen only on loopback, which envd does itself only inside Firecracker.
CMD ["/bin/sh", "-c", "if [ -x /usr/local/bin/sandbox-portf ]; then /usr/local/bin/sandbox-portf & fi; exec /usr/bin/envd -isnotfc"]
