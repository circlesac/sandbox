#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 4 ]; then
  printf "usage: %s BINARY VERSION ARCH OUTPUT_DIR\n" "$0" >&2
  exit 2
fi

binary="$1"
version="$2"
arch="$3"
output_dir="$4"

case "$arch" in
  amd64|arm64) ;;
  *)
    printf "unsupported Debian architecture: %s\n" "$arch" >&2
    exit 1
    ;;
esac

if [ ! -x "$binary" ]; then
  printf "binary is not executable: %s\n" "$binary" >&2
  exit 1
fi

command -v dpkg-deb >/dev/null 2>&1 || {
  printf "dpkg-deb is required\n" >&2
  exit 1
}

package_root="$(mktemp -d "${TMPDIR:-/tmp}/sandbox-deb.XXXXXX")"
trap 'rm -rf "$package_root"' EXIT
chmod 0755 "$package_root"

install -d -m 0755 "$package_root/DEBIAN" "$package_root/usr/bin"
install -m 0755 "$binary" "$package_root/usr/bin/sandbox"

cat > "$package_root/DEBIAN/control" <<CONTROL
Package: sandbox
Version: $version
Section: utils
Priority: optional
Architecture: $arch
Maintainer: Circles <packages@circles.ac>
Homepage: https://github.com/circlesac/sandbox
Description: E2B-compatible sandbox control plane
CONTROL

install -d -m 0755 "$output_dir"
dpkg-deb --build --root-owner-group \
  "$package_root" \
  "$output_dir/sandbox_${version}_${arch}.deb"
