//go:build !windows

package main

import "syscall"

// daemonSysProcAttr detaches a spawned `thesun run` into its own process group
// so it survives the CLI exiting and is not hit by a Ctrl-C to the CLI's group.
func daemonSysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true}
}
