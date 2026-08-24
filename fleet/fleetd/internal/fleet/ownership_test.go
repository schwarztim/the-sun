package fleet

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"sync"
	"testing"
	"time"

	"mcp-fleet/fleetd/internal/manifest"
)

// startSleeper launches a harmless long-lived child and returns its pid plus a
// channel closed when it exits. It stands in for "some process holding a port"
// without needing a real MCP server.
func startSleeper(t *testing.T) (int, <-chan struct{}) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("uses a POSIX sleep child; the ownership rule itself is platform-independent")
	}
	cmd := exec.Command("sleep", "30")
	if err := cmd.Start(); err != nil {
		t.Fatalf("start sleeper: %v", err)
	}
	died := make(chan struct{})
	go func() { _ = cmd.Wait(); close(died) }()
	t.Cleanup(func() {
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
	})
	return cmd.Process.Pid, died
}

// TestKillChildRefusesToSignalUnownedProcess is the regression test for the
// destructive half of the duplicate-supervisor outage: fleetd adopted a healthy
// process it had not spawned, judged it unhealthy, and terminated it to free the
// port. A supervisor must never signal a process it cannot prove it owns.
func TestKillChildRefusesToSignalUnownedProcess(t *testing.T) {
	shortRoot(t, "fleetd-unowned-kill-test")
	pid, died := startSleeper(t)

	const name = "foreign-mcp"
	if err := writePidFile(name, pid); err != nil {
		t.Fatalf("seed pidfile: %v", err)
	}
	srv := &server{spec: manifest.Server{Name: name, Port: 0, Health: "/healthz"}}
	srv.mu.Lock()
	srv.pid = pid
	srv.owned = false // adopted by health only: ownership unproven
	srv.mu.Unlock()

	srv.killChild()

	select {
	case <-died:
		t.Fatal("killChild terminated a process fleetd does not own; a supervisor must never signal a process it did not spawn and cannot prove it owns")
	case <-time.After(500 * time.Millisecond):
		// still alive, as required
	}
}

// TestKillChildTerminatesOwnedProcess preserves the legitimate case: a stale
// child fleetd itself started (or adopted through its own pidfile) may be
// reclaimed so the port frees for a respawn.
func TestKillChildTerminatesOwnedProcess(t *testing.T) {
	shortRoot(t, "fleetd-owned-kill-test")
	pid, died := startSleeper(t)

	const name = "own-mcp"
	if err := writePidFile(name, pid); err != nil {
		t.Fatalf("seed pidfile: %v", err)
	}
	srv := &server{spec: manifest.Server{Name: name, Port: 0, Health: "/healthz"}}
	srv.mu.Lock()
	srv.pid = pid
	srv.owned = true // fleetd's own child
	srv.mu.Unlock()

	srv.killChild()

	select {
	case <-died:
		// terminated, as required
	case <-time.After(5 * time.Second):
		t.Fatal("killChild did not terminate a process fleetd owns; stale-child reclaim must keep working")
	}
}

// TestTryAdoptByHealthMarksUnowned proves the ownership classification at its
// source: a port that answers healthy with no usable pidfile is adopted (so
// fleetd does not double-spawn onto it) but is explicitly NOT owned, which is
// what makes the later terminate path refuse to signal it.
func TestTryAdoptByHealthMarksUnowned(t *testing.T) {
	shortRoot(t, "fleetd-adopt-unowned-test")

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()
	port := ln.Addr().(*net.TCPAddr).Port
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	srvHTTP := &http.Server{Handler: mux}
	go func() { _ = srvHTTP.Serve(ln) }()
	defer srvHTTP.Close()

	sup := New(&manifest.Manifest{}, log.New(io.Discard, "", 0))
	sup.ctx, sup.cancel = context.WithCancel(context.Background())
	defer sup.cancel()

	// No pidfile is written, so ownership cannot be proven.
	srv := &server{spec: manifest.Server{Name: "adopted-mcp", Port: port, Health: "/healthz"}}
	gotPID, ok := sup.tryAdopt(srv)
	if !ok {
		t.Fatal("a healthy port must still be adopted so fleetd never double-spawns onto it")
	}
	if gotPID != 0 {
		t.Errorf("pid = %d, want 0 (no pidfile means no known pid)", gotPID)
	}
	if srv.isOwned() {
		t.Fatal("a process adopted purely because its port answered healthy must NOT be marked owned; marking it owned is what allowed fleetd to terminate a foreign process")
	}
}

// TestAutoRecoverIsSerialAndOrdered locks the non-negotiable constraint on
// breaker recovery: exactly one server is recovered per sweep, in the canonical
// recovery order. Parallel restarts trigger a gateway reload cascade that
// re-trips healthy servers (proven in production 2026-07-06), so overlapping
// bring-ups are a correctness failure, not a performance detail. One per sweep
// also bounds how long the sweep holds ctrlMu, which operator commands need.
func TestAutoRecoverIsSerialAndOrdered(t *testing.T) {
	sup := New(mixedManifest(), log.New(io.Discard, "", 0))
	sup.ctx, sup.cancel = context.WithCancel(context.Background())
	defer sup.cancel()

	var mu sync.Mutex
	var inFlight, maxInFlight int
	var order []string
	sup.launchHook = func(name string, isSystem bool) {
		mu.Lock()
		inFlight++
		if inFlight > maxInFlight {
			maxInFlight = inFlight
		}
		order = append(order, name)
		mu.Unlock()

		time.Sleep(5 * time.Millisecond) // widen any overlap window

		mu.Lock()
		inFlight--
		mu.Unlock()
		// Recovering successfully takes this server out of the degraded set, so
		// the next sweep moves on to the next one.
		sup.servers[name].setState(StateRunning, 4242, "test: recovered")
	}

	// Latch every server's breaker so the sweep has a full fleet to recover.
	for _, n := range []string{"aaa-mcp", "zzz-mcp", "gateway", "hermes"} {
		sup.servers[n].setDegraded(CauseRetryable, "test: breaker latched")
	}

	// Four sweeps, one server each. Time advances well past any backoff so
	// eligibility is never the thing under test here.
	now := time.Now()
	for i := 0; i < 4; i++ {
		before := len(order)
		sup.autoRecoverOnce(now)
		mu.Lock()
		got := len(order) - before
		mu.Unlock()
		if got > 1 {
			t.Fatalf("sweep %d recovered %d servers; recovery must take exactly one server per sweep", i+1, got)
		}
		now = now.Add(autoRecoverMaxBackoff + time.Minute)
	}

	mu.Lock()
	defer mu.Unlock()
	if maxInFlight != 1 {
		t.Fatalf("breaker recovery must be SERIAL, observed %d concurrent bring-ups; parallel restarts re-trip healthy servers via the reload cascade", maxInFlight)
	}
	want := []string{"hermes", "gateway", "aaa-mcp", "zzz-mcp"}
	if len(order) != len(want) {
		t.Fatalf("recovery order = %v, want %v", order, want)
	}
	for i := range want {
		if order[i] != want[i] {
			t.Fatalf("recovery order = %v, want %v (system infra first: hermes, gateway; then mcp alphabetical)", order, want)
		}
	}
}

// TestAutoRecoverHalfOpenTransition proves the breaker's half-open behavior: a
// probe that succeeds CLOSES the breaker (the attempt counter resets, so a later
// unrelated degrade starts from the short backoff), while a probe that fails
// leaves it open with an incremented counter, lengthening the next backoff.
func TestAutoRecoverHalfOpenTransition(t *testing.T) {
	sup := New(mixedManifest(), log.New(io.Discard, "", 0))
	sup.ctx, sup.cancel = context.WithCancel(context.Background())
	defer sup.cancel()

	// aaa-mcp comes back on the probe; zzz-mcp stays broken.
	sup.launchHook = func(name string, isSystem bool) {
		if name == "aaa-mcp" {
			sup.servers[name].setState(StateRunning, 4242, "test: recovered")
		}
	}
	for _, n := range []string{"aaa-mcp", "zzz-mcp"} {
		sup.servers[n].setDegraded(CauseRetryable, "test: breaker latched")
	}

	// One server per sweep: aaa-mcp (alphabetically first) then zzz-mcp.
	now := time.Now()
	sup.autoRecoverOnce(now)
	sup.autoRecoverOnce(now.Add(autoRecoverMaxBackoff + time.Minute))

	recovered := sup.servers["aaa-mcp"]
	recovered.mu.Lock()
	gotAttempts, gotState := recovered.recoverAttempts, recovered.state
	recovered.mu.Unlock()
	if gotState != StateRunning {
		t.Fatalf("recovered server state = %q, want %q", gotState, StateRunning)
	}
	if gotAttempts != 0 {
		t.Errorf("a successful half-open probe must CLOSE the breaker (recoverAttempts reset to 0), got %d", gotAttempts)
	}

	stillBroken := sup.servers["zzz-mcp"]
	stillBroken.mu.Lock()
	brokenAttempts, brokenState := stillBroken.recoverAttempts, stillBroken.state
	stillBroken.mu.Unlock()
	if brokenState != StateDegraded {
		t.Fatalf("still-broken server state = %q, want %q", brokenState, StateDegraded)
	}
	if brokenAttempts != 1 {
		t.Errorf("a failed half-open probe must re-open the breaker with an incremented counter (longer next backoff), got %d", brokenAttempts)
	}
	if recoverBackoff(brokenAttempts) <= recoverBackoff(0) {
		t.Errorf("backoff must increase after a failed recovery: got %s, base %s", recoverBackoff(brokenAttempts), recoverBackoff(0))
	}
}

// TestDegradeCauseClassification proves each degrade path records WHY, and that
// the persistent-degrade signal fires for causes no retry can fix. Without the
// classification, a fleet that can never recover looks exactly like one that is
// mid-restart, which is how a gateway outage went unnoticed for 27 hours.
func TestDegradeCauseClassification(t *testing.T) {
	srv := &server{spec: manifest.Server{Name: "x-mcp", Port: 1, Health: "/healthz"}}

	srv.setDegraded(CauseUnrecoverable, "port held by a process fleetd does not own")
	cause, attempts := srv.degradeInfo()
	if cause != CauseUnrecoverable {
		t.Errorf("cause = %q, want %q", cause, CauseUnrecoverable)
	}
	st := ServerStatus{State: StateDegraded, DegradeCause: cause, RecoverAttempts: attempts}
	if !st.PersistentlyDegraded() {
		t.Error("an unrecoverable cause must report as persistently degraded immediately; retrying cannot fix it")
	}

	// A retryable cause is NOT persistent until recovery has repeatedly failed.
	srv.setDegraded(CauseRetryable, "crash loop")
	st = ServerStatus{State: StateDegraded, DegradeCause: CauseRetryable, RecoverAttempts: 1}
	if st.PersistentlyDegraded() {
		t.Error("one failed recovery of a retryable fault must not escalate; it is still plausibly transient")
	}
	st.RecoverAttempts = persistentDegradeAttempts
	if !st.PersistentlyDegraded() {
		t.Errorf("%d consecutive failed recoveries must escalate to persistently degraded", persistentDegradeAttempts)
	}

	// Leaving the degraded state clears the cause.
	srv.setState(StateRunning, 7, "healthy")
	if cause, _ := srv.degradeInfo(); cause != "" {
		t.Errorf("cause must clear when a server leaves degraded, got %q", cause)
	}
	if (ServerStatus{State: StateRunning, DegradeCause: CauseUnrecoverable}).PersistentlyDegraded() {
		t.Error("a running server is never persistently degraded")
	}
}

// TestUnrecoverableSpawnErr pins which spawn failures are permanent. A Hermes
// resolution failure must stay retryable: the broker coming back fixes it.
func TestUnrecoverableSpawnErr(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"missing binary", os.ErrNotExist, true},
		{"not executable", os.ErrPermission, true},
		{"not found on PATH", exec.ErrNotFound, true},
		{"wrapped missing binary", fmt.Errorf("spawn: %w", os.ErrNotExist), true},
		{"hermes resolution failed", errors.New("hermes resolution for env API_KEY failed: broker unreachable"), false},
	}
	for _, c := range cases {
		if got := unrecoverableSpawnErr(c.err); got != c.want {
			t.Errorf("%s: unrecoverableSpawnErr = %v, want %v", c.name, got, c.want)
		}
	}
}
