//go:build windows

package main

import (
	"syscall"

	"golang.org/x/sys/windows"
)

// daemonSysProcAttr detaches a spawned `thesun run` from the CLI's console so it
// keeps running after the CLI exits, in its own process group.
func daemonSysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{
		CreationFlags: windows.CREATE_NEW_PROCESS_GROUP | windows.DETACHED_PROCESS,
	}
}
