# Stage 1: Build envd from e2b-dev/infra source
FROM golang:latest AS envd-builder
RUN git clone --depth 1 https://github.com/e2b-dev/infra.git /src
WORKDIR /src/packages/envd
RUN make build

# Stage 2: Sandbox image
FROM ubuntu:latest

COPY --from=envd-builder /src/packages/envd/bin/envd /usr/bin/envd
RUN chmod +x /usr/bin/envd

# Install base development tools
RUN apt-get update && apt-get install -y \
    git curl wget sudo ca-certificates \
    python3 python3-pip \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js LTS
RUN curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Create default user with passwordless sudo
RUN useradd -m -s /bin/bash -G sudo user \
    && echo 'user ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers

WORKDIR /home/user

EXPOSE 49983

# envd is PID 1 — runs in non-Firecracker mode
CMD ["/usr/bin/envd", "-isnotfc"]
