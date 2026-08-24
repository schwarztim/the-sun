package fleet

import (
	"testing"
	"time"
)

func contains(xs []string, want string) bool {
	for _, x := range xs {
		if x == want {
			return true
		}
	}
	return false
}

// TestRecoverBackoff locks the exponential-with-cap schedule.
func TestRecoverBackoff(t *testing.T) {
	cases := []struct {
		attempts int
		want     time.Duration
	}{
		{0, 1 * time.Minute},
		{1, 2 * time.Minute},
		{2, 4 * time.Minute},
		{3, 8 * time.Minute},
		{4, 16 * time.Minute},
		{5, 30 * time.Minute},  // 32m capped
		{6, 30 * time.Minute},  // stays capped
		{50, 30 * time.Minute}, // no overflow, still capped
	}
	for _, c := range cases {
		if got := recoverBackoff(c.attempts); got != c.want {
			t.Errorf("recoverBackoff(%d) = %s, want %s", c.attempts, got, c.want)
		}
	}
}

// TestAutoRecoverOnceBringsUpOnlyDegraded proves the sweep re-attempts a DEGRADED
// server and leaves stopped/starting/running ones alone, and that it stamps the
// per-server attempt bookkeeping.
func TestAutoRecoverOnceBringsUpOnlyDegraded(t *testing.T) {
	sup, order := withLaunchHook(mixedManifest())
	// aaa-mcp latched degraded; zzz-mcp intentionally stopped by an operator.
	sup.servers["aaa-mcp"].setState(StateDegraded, 0, "test: breaker latched")
	sup.servers["zzz-mcp"].setState(StateStopped, 0, "test: operator stop")

	now := time.Now()
	sup.autoRecoverOnce(now)

	if !contains(*order, "aaa-mcp") {
		t.Errorf("degraded aaa-mcp was not re-attempted; bring-up order=%v", *order)
	}
	if contains(*order, "zzz-mcp") {
		t.Errorf("operator-stopped zzz-mcp must NOT be auto-recovered; order=%v", *order)
	}
	// starting/system servers are not degraded, so must be untouched.
	for _, n := range []string{"hermes", "gateway"} {
		if contains(*order, n) {
			t.Errorf("non-degraded %q must NOT be auto-recovered; order=%v", n, *order)
		}
	}
	// bookkeeping stamped so the next sweep backs off.
	srv := sup.servers["aaa-mcp"]
	srv.mu.Lock()
	attempts, last := srv.recoverAttempts, srv.lastRecover
	srv.mu.Unlock()
	if attempts != 1 {
		t.Errorf("recoverAttempts = %d, want 1", attempts)
	}
	if !last.Equal(now) {
		t.Errorf("lastRecover = %v, want %v", last, now)
	}
}

// TestAutoRecoverOnceRespectsBackoff proves a server retried recently is skipped
// until its per-server backoff elapses.
func TestAutoRecoverOnceRespectsBackoff(t *testing.T) {
	sup, order := withLaunchHook(mixedManifest())
	srv := sup.servers["aaa-mcp"]
	srv.setState(StateDegraded, 0, "test")
	now := time.Now()
	// One prior attempt at `now` => backoff is 2 minutes.
	srv.mu.Lock()
	srv.recoverAttempts = 1
	srv.lastRecover = now
	srv.mu.Unlock()

	sup.autoRecoverOnce(now.Add(1 * time.Minute)) // inside the 2m backoff
	if contains(*order, "aaa-mcp") {
		t.Fatalf("aaa-mcp retried inside its backoff window; order=%v", *order)
	}

	sup.autoRecoverOnce(now.Add(3 * time.Minute)) // past the 2m backoff
	if !contains(*order, "aaa-mcp") {
		t.Fatalf("aaa-mcp not retried after backoff elapsed; order=%v", *order)
	}
}

// TestAutoRecoverOnceSkipsWhenLifecycleLocked proves the sweep never overlaps an
// operator lifecycle op (or another sweep): if ctrlMu is held, it is a no-op.
func TestAutoRecoverOnceSkipsWhenLifecycleLocked(t *testing.T) {
	sup, order := withLaunchHook(mixedManifest())
	sup.servers["aaa-mcp"].setState(StateDegraded, 0, "test")

	sup.ctrlMu.Lock() // simulate an in-flight operator start/stop/reload
	sup.autoRecoverOnce(time.Now())
	sup.ctrlMu.Unlock()

	if len(*order) != 0 {
		t.Errorf("sweep ran while ctrlMu was held; order=%v", *order)
	}
}
