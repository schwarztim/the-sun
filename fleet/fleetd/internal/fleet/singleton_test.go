package fleet

import (
	"context"
	"io"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"mcp-fleet/fleetd/internal/manifest"
)

// shortRoot returns a short-lived state root under /tmp. The unix control
// socket path must fit macOS's 104-char sun_path limit, so t.TempDir() (deep
// under /var/folders) is unusable for anything that binds the control endpoint.
func shortRoot(t *testing.T, name string) string {
	t.Helper()
	dir := filepath.Join("/tmp", name)
	_ = os.RemoveAll(dir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	t.Setenv("FLEETD_ROOT", dir)
	return dir
}

// TestCheckSingleInstanceRefusesSecondSupervisor is the regression test for the
// duplicate-supervisor outage: two OS service jobs both ran `thesun run`, the
// second silently rebound the first one's control socket, and the two then
// fought over every fleet port and terminated each other's servers. The guard
// must refuse the second start and name the conflicting pid.
func TestCheckSingleInstanceRefusesSecondSupervisor(t *testing.T) {
	shortRoot(t, "fleetd-singleton-test")

	// Nothing is listening yet, so a first supervisor is free to start.
	if err := checkSingleInstance(); err != nil {
		t.Fatalf("guard blocked the FIRST supervisor with no endpoint live: %v", err)
	}

	// Bring up a control endpoint exactly as Run does.
	sup := New(&manifest.Manifest{}, log.New(io.Discard, "", 0))
	sup.ctx, sup.cancel = context.WithCancel(context.Background())
	if err := sup.serveControl(); err != nil {
		t.Fatalf("serveControl: %v", err)
	}
	if err := writeSupervisorPid(); err != nil {
		t.Fatalf("writeSupervisorPid: %v", err)
	}
	t.Cleanup(func() {
		if sup.ctrlLn != nil {
			sup.ctrlLn.Close()
		}
		sup.cleanupControl()
		removeSupervisorPid()
		sup.cancel()
	})

	err := checkSingleInstance()
	if err == nil {
		t.Fatal("a SECOND supervisor was allowed to start while one was live; this is the duplicate-supervisor failure the guard exists to prevent")
	}
	if !strings.Contains(err.Error(), strconv.Itoa(os.Getpid())) {
		t.Errorf("diagnostic must name the conflicting pid %d, got: %v", os.Getpid(), err)
	}
	if !strings.Contains(err.Error(), controlEndpointDesc()) {
		t.Errorf("diagnostic must name the control endpoint %q, got: %v", controlEndpointDesc(), err)
	}
}

// TestCheckSingleInstanceTrustsProbeNotPidfile proves the guard keys off a live
// control probe rather than the on-disk pidfile. A crashed daemon leaves a stale
// fleetd.pid behind; treating that as proof of life would permanently wedge
// startup, so a stale pidfile with nothing answering must still allow a start.
func TestCheckSingleInstanceTrustsProbeNotPidfile(t *testing.T) {
	shortRoot(t, "fleetd-singleton-stale-test")

	if err := os.MkdirAll(RunDir(), 0o700); err != nil {
		t.Fatal(err)
	}
	// A pid that is not a live supervisor (0 is never a real process pid here).
	if err := os.WriteFile(supervisorPidFile(), []byte("999999\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := checkSingleInstance(); err != nil {
		t.Fatalf("a stale pidfile with no live control endpoint must not block startup, got: %v", err)
	}
}
