#!/bin/sh
set -e

REPO="circlesac/sandbox"
INSTALL_DIR="${INSTALL_DIR:-/usr/local/bin}"

OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case "$ARCH" in
  x86_64)  ARCH="amd64" ;;
  aarch64) ARCH="arm64" ;;
esac

case "$OS-$ARCH" in
  darwin-arm64|darwin-amd64|linux-amd64|linux-arm64) ;;
  *) echo "Unsupported platform: $OS-$ARCH"; exit 1 ;;
esac

VERSION=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | grep '"tag_name"' | cut -d'"' -f4)
URL="https://github.com/$REPO/releases/download/$VERSION/sandbox-$OS-$ARCH.tar.gz"

echo "Installing sandbox $VERSION..."
curl -fsSL "$URL" | tar xz -C "$INSTALL_DIR"
chmod +x "$INSTALL_DIR/sandbox"
echo "Installed to $INSTALL_DIR/sandbox"
