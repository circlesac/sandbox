//go:build darwin

package host

// E2BRunDir is writable from a user LaunchAgent on macOS. The macOS system
// volume is sealed, so the Linux /run path does not exist or accept writes.
const E2BRunDir = "/tmp/e2b"
