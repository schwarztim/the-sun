//go:build windows

package fleet

import (
	"os/exec"
	"strconv"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
)

// procAttr returns the child process attributes used at spawn time. On Windows
// there is no process-group signalling; the child is placed in a new process
// group so a console Ctrl-C to fleetd does not propagate, and the tree is torn
// down explicitly via taskkill /T in killTree.
func procAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP}
}

// pidAlive reports whether pid refers to a live process. Windows has no signal-0
// probe, so we open the process and ask the OS whether its handle is signalled.
//
// STAB-5b: the previous implementation relied on GetExitCodeProcess == 259
// (STILL_ACTIVE) alone. That is a false positive: a child that legitimately
// exits with code 259 is indistinguishable from a still-running process, so
// death detection never fired and killTree looped the full grace window.
// WaitForSingleObject is the authoritative liveness check: WAIT_OBJECT_0 means
// the process object is signalled (it has actually exited); WAIT_TIMEOUT means
// it is still running. The exit code is only consulted as a fallback for the
// rare non-signalled, non-timeout wait result.
func pidAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	// SYNCHRONIZE is required for WaitForSingleObject; the query right lets us
	// read the exit code as a secondary signal.
	h, err := windows.OpenProcess(windows.SYNCHRONIZE|windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		// Not found or not accessible: treat as dead.
		return false
	}
	defer windows.CloseHandle(h)
	switch event, _ := windows.WaitForSingleObject(h, 0); event {
	case uint32(windows.WAIT_OBJECT_0):
		return false // handle signalled: process has exited
	case uint32(windows.WAIT_TIMEOUT):
		return true // wait timed out: process still running
	}
	// Any other (rare) wait result: fall back to the exit code.
	var code uint32
	if err := windows.GetExitCodeProcess(h, &code); err != nil {
		return false
	}
	const stillActive = 259
	return code == stillActive
}

// killTree terminates the child and every descendant, matching the unix path's
// graceful-then-force shape.
//
// STAB-5a: the previous implementation sent no termination signal at all. It
// waited the full fixed grace window while the child kept running, then always
// ran taskkill /F /T. The child never got a chance to flush or clean up, and
// every stop, restart, or unhealthy-kill blocked for the whole grace period.
// Windows has no SIGTERM to a process group, so the graceful equivalent is a
// CTRL_BREAK_EVENT delivered to the child's process group. The child is spawned
// with CREATE_NEW_PROCESS_GROUP (see procAttr), so its process-group id equals
// its pid. We send that signal first, wait only until the child actually exits
// (pidAlive now uses WaitForSingleObject, so this returns as soon as it dies),
// and escalate to taskkill /F /T (force, tree; the portable negative-pid
// SIGKILL equivalent) only if it is still alive after the grace window.
//
// GenerateConsoleCtrlEvent is best-effort: it fails when fleetd has no attached
// console (for example when running as a Windows service). The error is
// intentionally ignored because the taskkill fallback below is authoritative.
func killTree(pid int, grace time.Time) {
	if pid <= 0 {
		return
	}
	_ = windows.GenerateConsoleCtrlEvent(windows.CTRL_BREAK_EVENT, uint32(pid))
	for pidAlive(pid) && time.Now().Before(grace) {
		time.Sleep(50 * time.Millisecond)
	}
	if pidAlive(pid) {
		_ = exec.Command("taskkill", "/F", "/T", "/PID", strconv.Itoa(pid)).Run()
	}
}
