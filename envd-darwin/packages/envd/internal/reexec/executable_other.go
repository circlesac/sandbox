//go:build !linux

package reexec

import "os"

func currentExecutable() string {
	// Darwin has no /proc/self/exe. os.Executable resolves the path of the
	// running Mach-O binary and is stable for the lifetime of this process.
	path, err := os.Executable()
	if err != nil {
		return os.Args[0]
	}
	return path
}
