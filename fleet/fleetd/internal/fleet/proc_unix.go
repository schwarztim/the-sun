//go:build !windows

package fleet

import (
	"syscall"
	"time"
)

// procAttr returns the child process attributes used at spawn time. On Unix the
// child is placed in its own process group (Setpgid) so a signal to fleetd's
// group does not propagate to children, and the whole group can be torn down at
// once via a negative-pid kill.
func procAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true}
}

// pidAlive reports whether pid refers to a live process (signal 0 probe).
//
//	nil  => alive
//	ESRCH => gone
//	EPERM => alive but not ours (still alive)
func pidAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	if err == nil {
		return true
	}
	return err == syscall.EPERM
}

// killTree terminates the child's whole process group: SIGTERM (group then pid),
// wait until grace, then SIGKILL any survivor. Signalling the negative pid hits
// the group so grandchildren die too.
func killTree(pid int, grace time.Time) {
	if pid <= 0 {
		return
	}
	_ = syscall.Kill(-pid, syscall.SIGTERM)
	_ = syscall.Kill(pid, syscall.SIGTERM)

	for pidAlive(pid) && time.Now().Before(grace) {
		time.Sleep(50 * time.Millisecond)
	}
	if pidAlive(pid) {
		_ = syscall.Kill(-pid, syscall.SIGKILL)
		_ = syscall.Kill(pid, syscall.SIGKILL)
	}
}
