//go:build !windows

package main

import (
	"fmt"
	"os"
	"syscall"
)

func execute(node string, args, env []string) int {
	// Replacing this process preserves the PID, signals, stdio and exit status.
	if err := syscall.Exec(node, args, env); err != nil {
		fmt.Fprintln(os.Stderr, "codegraph:", err)
		return 1
	}
	return 0
}
