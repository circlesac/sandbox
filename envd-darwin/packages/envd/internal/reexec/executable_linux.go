//go:build linux

package reexec

func currentExecutable() string {
	// /proc/self/exe continues to name the running binary after a live upgrade
	// unlinks the original path.
	return "/proc/self/exe"
}
