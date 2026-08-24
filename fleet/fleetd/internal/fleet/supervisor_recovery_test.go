package fleet

import (
	"context"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"testing"

	"mcp-fleet/fleetd/internal/manifest"
)

// mixedManifest returns a manifest whose entries are deliberately out of
// recovery order: MCP servers listed before system infra, and "gateway" before
// "hermes" alphabetically. A correct bring-up must still schedule hermes, then
// gateway, then the MCP servers alphabetically.
func mixedManifest() *manifest.Manifest {
	return &manifest.Manifest{Servers: []manifest.Server{
		{Name: "zzz-mcp", Kind: manifest.KindMCP, Bin: "/bin/true", Port: 42210, Health: "/healthz", MaxRestarts: 5},
		{Name: "aaa-mcp", Kind: manifest.KindMCP, Bin: "/bin/true", Port: 42211, Health: "/healthz", MaxRestarts: 5},
		{Name: "gateway", Kind: manifest.KindSystem, Bin: "/bin/true", Port: 3100, Health: "/healthz", MaxRestarts: 5},
		{Name: "hermes", Kind: manifest.KindSystem, Bin: "/bin/true", Port: 9876, Health: "/healthz", MaxRestarts: 5},
	}}
}

// withLaunchHook installs a launchHook that records the exact bring-up order and
// a live context, so bringUpServers exercises its ordering/serialization path
// without spawning processes or binding ports. Returns the supervisor and a
// pointer to the recorded-order slice. bringUpServers drives the hook
// synchronously on the caller's goroutine (no fan-out), so appending without a
// lock is race-free here.
func withLaunchHook(m *manifest.Manifest) (*Supervisor, *[]string) {
	sup := New(m, log.New(io.Discard, "", 0))
	sup.ctx, sup.cancel = context.WithCancel(context.Background())
	var order []string
	sup.launchHook = func(name string, isSystem bool) {
		order = append(order, name)
	}
	return sup, &order
}

// TestBringUpServersRecoveryOrder proves the shared serial bring-up path orders
// system infra first (hermes -> gateway), then MCP servers alphabetically,
// regardless of the caller's input order — the STAB-4 recovery invariant that
// must hold for boot, start-all/restart-all, and reload alike.
func TestBringUpServersRecoveryOrder(t *testing.T) {
	sup, order := withLaunchHook(mixedManifest())

	// Feed names in a scrambled order to prove ordering does not depend on input.
	sup.bringUpServers([]string{"zzz-mcp", "gateway", "aaa-mcp", "hermes"})

	want := []string{"hermes", "gateway", "aaa-mcp", "zzz-mcp"}
	if got := *order; len(got) != len(want) {
		t.Fatalf("bring-up order = %v, want %v", got, want)
	}
	for i := range want {
		if (*order)[i] != want[i] {
			t.Fatalf("bring-up order = %v, want %v (system infra first: hermes, gateway; then mcp alphabetical)", *order, want)
		}
	}
}

// TestBringUpServersEmptyIsNoop guards the degenerate case: an empty target set
// (e.g. reload with nothing added/changed) must not launch anything.
func TestBringUpServersEmptyIsNoop(t *testing.T) {
	sup, order := withLaunchHook(mixedManifest())
	sup.bringUpServers(nil)
	if len(*order) != 0 {
		t.Fatalf("bring-up order = %v, want empty for a nil target set", *order)
	}
}

// TestStartAllRoutesThroughBringUp proves operator `start`/`start all` no longer
// fans out N supervise loops in parallel: applyToTargets routes the prepared set
// through bringUpServers, so the launch order is the same serial, system-first
// recovery order as boot. Before the STAB-4 fix, start-all launched every
// supervise goroutine back-to-back with no ordering or stagger, reproducing the
// 2026-07-06 reload cascade.
func TestStartAllRoutesThroughBringUp(t *testing.T) {
	sup, order := withLaunchHook(mixedManifest())

	// prepStart refuses servers that are already running/starting; New() marks
	// them StateStarting, so move them to Stopped (the realistic pre-start state).
	sup.mu.Lock()
	for _, srv := range sup.servers {
		srv.setState(StateStopped, 0, "test: stopped")
	}
	sup.mu.Unlock()

	resp := sup.dispatch(Request{Cmd: "start", Server: ""})
	if !resp.OK {
		t.Fatalf("start-all dispatch failed: %s", resp.Error)
	}

	want := []string{"hermes", "gateway", "aaa-mcp", "zzz-mcp"}
	if got := *order; len(got) != len(want) {
		t.Fatalf("start-all launch order = %v, want %v (must route through bringUpServers)", got, want)
	}
	for i := range want {
		if (*order)[i] != want[i] {
			t.Fatalf("start-all launch order = %v, want %v", *order, want)
		}
	}
}

// TestPortOwnerPIDsGuard covers the pure decision logic of the STAB-6 port-owner
// lookup that does NOT require a real process or bound port: a non-positive port
// resolves to no owner (the guard that also short-circuits the Windows path).
func TestPortOwnerPIDsGuard(t *testing.T) {
	if got := portOwnerPIDs(0); got != nil {
		t.Fatalf("portOwnerPIDs(0) = %v, want nil (guard)", got)
	}
	if got := portOwnerPIDs(-1); got != nil {
		t.Fatalf("portOwnerPIDs(-1) = %v, want nil (guard)", got)
	}
}

// TestPortOwnerPIDsUnownedPort exercises the real lookup branch (lsof on unix)
// against a port with no owner: bind an ephemeral port to discover a free one,
// close it immediately, then assert the lookup reports no owner. This runs the
// exec + non-zero-exit path without binding a port during the assertion and
// without killing anything. The positive "found the owner and killed it" path is
// covered only by integration (a real wedged adopted process on a live port).
func TestPortOwnerPIDsUnownedPort(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Skipf("cannot allocate a probe port: %v", err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close() // free it: nothing should own `port` now

	if got := portOwnerPIDs(port); len(got) != 0 {
		t.Fatalf("portOwnerPIDs(%d) = %v, want empty for an unowned port", port, got)
	}
}

// TestParseNetstatOwners covers the CLN-3 Windows port-owner parsing without a
// real process or netstat run: it feeds representative `netstat -ano -p tcp`
// output and asserts the owning PID(s) for a listening port are extracted
// exactly. Runs on any OS because parseNetstatOwners is pure string parsing.
func TestParseNetstatOwners(t *testing.T) {
	const sample = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:3100           0.0.0.0:0              LISTENING       5678
  TCP    [::]:3100              [::]:0                 LISTENING       5678
  TCP    127.0.0.1:42210        0.0.0.0:0              LISTENING       1234
  TCP    127.0.0.1:42210        127.0.0.1:55123        ESTABLISHED     9999
  TCP    0.0.0.0:13100          0.0.0.0:0              LISTENING       4444
`
	// Exact match + IPv4/IPv6 dedupe: port 3100 is owned by pid 5678 (two rows,
	// one pid).
	if got := parseNetstatOwners(sample, 3100); len(got) != 1 || got[0] != 5678 {
		t.Fatalf("parseNetstatOwners(3100) = %v, want [5678] (dedup IPv4+IPv6)", got)
	}
	// Only the LISTENING owner (1234), not the ESTABLISHED client (9999); and
	// ":42210" must not be confused with any other port.
	if got := parseNetstatOwners(sample, 42210); len(got) != 1 || got[0] != 1234 {
		t.Fatalf("parseNetstatOwners(42210) = %v, want [1234] (listening owner only, not established client)", got)
	}
	// Exact-port match: 3100 must not match the 13100 suffix.
	for _, pid := range parseNetstatOwners(sample, 3100) {
		if pid == 4444 {
			t.Fatalf("parseNetstatOwners(3100) matched port 13100 (pid 4444) — suffix, not exact port")
		}
	}
	// A port nobody owns yields nothing; malformed/empty input never panics.
	if got := parseNetstatOwners(sample, 40000); len(got) != 0 {
		t.Fatalf("parseNetstatOwners(40000) = %v, want empty (no owner)", got)
	}
	if got := parseNetstatOwners("", 3100); len(got) != 0 {
		t.Fatalf("parseNetstatOwners(empty) = %v, want empty", got)
	}
	if got := parseNetstatOwners("garbage line with no columns\nTCP only\n", 3100); len(got) != 0 {
		t.Fatalf("parseNetstatOwners(malformed) = %v, want empty (skip, not panic)", got)
	}
}

// TestKillChildPidlessFallbackIsSafe proves the STAB-6 fix path: a server adopted
// by health with no usable pid (pid=0) no longer early-returns from killChild.
// With no resolvable port owner the port-owner termination is a safe no-op, and
// killChild still clears the stale pidfile so the next supervise iteration is
// not misled. (Port 0 keeps the lookup a guaranteed no-op — this test never
// signals any process.)
func TestKillChildPidlessFallbackIsSafe(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("FLEETD_ROOT", dir)

	const name = "wedged-mcp"
	if err := writePidFile(name, 4242); err != nil {
		t.Fatalf("seed pidfile: %v", err)
	}
	if _, err := os.Stat(filepath.Join(RunDir(), name+".pid")); err != nil {
		t.Fatalf("pidfile not written: %v", err)
	}

	srv := &server{spec: manifest.Server{Name: name, Port: 0, Health: "/healthz"}}
	srv.setState(StateRunning, 0, "adopted by health, pid unknown") // pid stays 0

	srv.killChild() // pid<=0 branch: signals nothing, just clears the stale pidfile

	if _, err := os.Stat(filepath.Join(RunDir(), name+".pid")); !os.IsNotExist(err) {
		t.Fatalf("killChild did not remove the stale pidfile for a pidless adopted server (err=%v)", err)
	}
}
