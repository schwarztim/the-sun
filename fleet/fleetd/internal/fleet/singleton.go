package fleet

// Single-instance guard.
//
// Two supervisors sharing one THESUN_HOME is destructive, not merely
// redundant. Each spawns the manifest's servers on the same static ports, so
// every port collides (EADDRINUSE), and each treats the other's children as
// foreign processes to adopt, judge unhealthy, and terminate. A runtime audit
// of exactly that state (two OS service jobs both running `thesun run`)
// recorded 1059 restart events, 391 EADDRINUSE failures, and 355 unhealthy
// verdicts, with the gateway killed and respawned every 3 to 4 minutes.
//
// It stayed silent because the control transport made the SECOND process win:
// serveControl unlinked and rebound the existing unix socket (and overwrote the
// Windows endpoint descriptor), so the newcomer stole the control channel while
// the original supervisor kept running, invisible to the CLI. The guard below
// inverts that. The newcomer probes the existing control endpoint first and
// refuses to start when a live supervisor answers.
//
// It is deliberately built on SendControl, so it works unchanged on both
// transports (unix socket on darwin and linux, token-authenticated loopback TCP
// on Windows) with no new platform-specific code. A stale socket or descriptor
// with no listener fails the probe, which correctly reads as "nobody home" and
// lets serveControl's existing stale-artifact cleanup proceed.

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// supervisorPidFile records the pid of the supervisor process itself, distinct
// from the per-server pidfiles. It exists only so the guard can name the
// conflicting process in its diagnostic. The control probe, not this file, is
// what decides whether another supervisor is live, so a stale or missing
// fleetd.pid degrades the message but never the correctness of the guard.
func supervisorPidFile() string { return filepath.Join(RunDir(), "fleetd.pid") }

func writeSupervisorPid() error {
	if err := os.MkdirAll(RunDir(), 0o700); err != nil {
		return err
	}
	return os.WriteFile(supervisorPidFile(), []byte(strconv.Itoa(os.Getpid())+"\n"), 0o600)
}

func readSupervisorPid() int {
	b, err := os.ReadFile(supervisorPidFile())
	if err != nil {
		return 0
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil {
		return 0
	}
	return pid
}

func removeSupervisorPid() { _ = os.Remove(supervisorPidFile()) }

// checkSingleInstance returns a non-nil error when another supervisor is
// already answering on the control endpoint, and nil when this process is clear
// to start. It is called by Run before serveControl binds anything, so a
// refusal leaves the running supervisor's control channel untouched.
func checkSingleInstance() error {
	if _, err := SendControl(Request{Cmd: "status"}); err != nil {
		return nil // nothing answered: no live supervisor, safe to start
	}
	who := "another fleetd supervisor"
	if pid := readSupervisorPid(); pid > 0 {
		who = fmt.Sprintf("another fleetd supervisor (pid %d)", pid)
	}
	return fmt.Errorf(
		"%s is already running and answering on %s; refusing to start a second one. "+
			"Two supervisors on one THESUN_HOME fight over every fleet port and terminate each other's servers. "+
			"Stop the running one first (`thesun shutdown`), or look for a duplicate OS service registration",
		who, controlEndpointDesc())
}
