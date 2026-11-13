//go:build unix && !darwin

package host

// E2BRunDir holds the sandbox metadata files. /run is tmpfs on Linux, so
// nothing written here reaches the rootfs diff.
const E2BRunDir = "/run/e2b"
