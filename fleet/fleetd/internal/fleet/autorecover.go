package fleet

import (
	"os"
	"sort"
	"time"

	"mcp-fleet/fleetd/internal/manifest"
)

// Auto-recovery of latched circuit breakers.
//
// A server that fails max_restarts consecutive health checks latches DEGRADED
// and its supervise loop exits (see tripped()); it never restarts on its own.
// That anti-thrash floor is deliberate, but it means a transient dependency
// outage (for example a brief Hermes blip while the fleet is spawning) silently
// takes servers down until an operator runs `fleetd start`. This loop closes
// that gap: it periodically re-attempts DEGRADED servers through the SAME
// serial, ordered, health-gated bring-up path an operator `start` uses
// (prepStart resets the breaker, then bringUpServers spawns), with a per-server
// exponential backoff so a genuinely broken server is retried gently rather than
// hammered.
//
// Recovery is never parallel: the sweep holds ctrlMu (serializing with operator
// lifecycle ops and with itself) and bringUpServers is itself serial and
// health-gated, so this cannot reproduce the 2026-07-06 parallel-start reload
// cascade. It only ever touches servers in StateDegraded; a server StateStopped
// by an operator is left alone.

const (
	// autoRecoverTick is how often the sweep runs. Per-server backoff, not this
	// cadence, governs how often any single server is actually retried.
	autoRecoverTick = 60 * time.Second
	// autoRecoverBaseBackoff is the first per-server retry delay; it doubles on
	// each failed attempt up to autoRecoverMaxBackoff. A server latched by a
	// transient outage recovers on the first sweep after the dependency heals; a
	// persistently broken one backs off to a quiet 30 minute cadence.
	autoRecoverBaseBackoff = 1 * time.Minute
	autoRecoverMaxBackoff  = 30 * time.Minute
)

// autoRecoverEnabled reports whether the sweep should run. It is on by default;
// set THESUN_AUTORECOVER to off/0/false/no to disable it (an escape hatch if the
// sweep ever needs to be turned off in production without a redeploy).
func autoRecoverEnabled() bool {
	switch os.Getenv("THESUN_AUTORECOVER") {
	case "off", "0", "false", "no", "OFF", "FALSE", "NO", "Off", "False", "No":
		return false
	}
	return true
}

// recoverBackoff is the minimum delay before retrying a server that has failed
// `attempts` prior auto-recoveries: exponential from the base, capped. attempts
// == 0 (never yet auto-recovered, or just healed) yields the base delay.
func recoverBackoff(attempts int) time.Duration {
	d := autoRecoverBaseBackoff
	for i := 0; i < attempts && d < autoRecoverMaxBackoff; i++ {
		d *= 2
	}
	if d > autoRecoverMaxBackoff {
		d = autoRecoverMaxBackoff
	}
	return d
}

// autoRecoverLoop periodically re-attempts DEGRADED servers until the context is
// cancelled. Started once from Run(). Exits immediately when disabled.
func (s *Supervisor) autoRecoverLoop() {
	if !autoRecoverEnabled() {
		s.logf("auto-recovery: disabled via THESUN_AUTORECOVER")
		return
	}
	ticker := time.NewTicker(autoRecoverTick)
	defer ticker.Stop()
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-ticker.C:
			s.autoRecoverOnce(time.Now())
		}
	}
}

// autoRecoverOnce runs one recovery sweep: it collects DEGRADED servers whose
// per-server backoff has elapsed and brings them up through the serial path. It
// takes ctrlMu with TryLock so it never overlaps an operator lifecycle op or
// another sweep; if the lock is held it skips this tick and retries on the next.
// now is injected for tests.
func (s *Supervisor) autoRecoverOnce(now time.Time) {
	if !s.ctrlMu.TryLock() {
		return // an operator op or a prior sweep holds the lifecycle lock
	}
	defer s.ctrlMu.Unlock()

	// Snapshot the eligible degraded set (only servers past their backoff).
	type cand struct {
		srv  *server
		name string
	}
	var cands []cand
	s.mu.Lock()
	for name, srv := range s.servers {
		srv.mu.Lock()
		eligible := srv.state == StateDegraded && now.Sub(srv.lastRecover) >= recoverBackoff(srv.recoverAttempts)
		srv.mu.Unlock()
		if eligible {
			cands = append(cands, cand{srv, name})
		}
	}
	s.mu.Unlock()
	if len(cands) == 0 {
		return
	}
	// Canonical recovery order, so the one server this sweep recovers is the most
	// important eligible one: system infra (hermes, then gateway) ahead of MCP
	// servers, alphabetical within a tier.
	sort.Slice(cands, func(i, j int) bool {
		pi, pj := candPriority(cands[i].srv, cands[i].name), candPriority(cands[j].srv, cands[j].name)
		if pi != pj {
			return pi < pj
		}
		return cands[i].name < cands[j].name
	})

	// Recover exactly ONE server per sweep. Two reasons, both load-bearing:
	//
	//  1. Serialization. Breaker recovery must never run restarts in parallel;
	//     the resulting gateway reload cascade re-trips healthy servers (proven
	//     in production 2026-07-06). One per sweep makes that structural rather
	//     than a property of a loop a future reader could "optimize".
	//  2. Lock hold time. This sweep holds ctrlMu, which operator lifecycle
	//     commands (start/stop/restart/reload) also need. Recovering the whole
	//     degraded set in one sweep could hold it for len(set) * startupHealthWait
	//     (about four minutes on a fifteen server fleet), so `thesun restart`
	//     would block and look wedged at exactly the moment a human is trying to
	//     intervene. One server bounds the hold to a single health wait.
	//
	// The remaining eligible servers are simply picked up by subsequent sweeps.
	c := cands[0]
	skipped := len(cands) - 1

	// Stamp the attempt time and count up front so a bring-up that fails again
	// backs off on the next sweep instead of retrying every tick.
	c.srv.mu.Lock()
	c.srv.lastRecover = now
	c.srv.recoverAttempts++
	attempts := c.srv.recoverAttempts
	cause := c.srv.degradeCause
	c.srv.mu.Unlock()
	if err := s.prepStart(c.srv); err != nil {
		return
	}
	if skipped > 0 {
		s.logf("auto-recovery: re-attempting %q (attempt %d, cause=%s); %d other eligible server(s) deferred to later sweeps to keep recovery serial", c.name, attempts, cause, skipped)
	} else {
		s.logf("auto-recovery: re-attempting %q (attempt %d, cause=%s)", c.name, attempts, cause)
	}

	// Serial, health-gated bring-up: the exact path an operator `start` uses.
	s.bringUpServers([]string{c.name})

	// Half-open outcome: success CLOSES the breaker (clear the attempt counter so
	// a later unrelated degrade starts from a fresh short backoff); failure leaves
	// it open with the incremented counter, so the next retry waits longer.
	c.srv.mu.Lock()
	recovered := c.srv.state == StateRunning
	if recovered {
		c.srv.recoverAttempts = 0
	}
	c.srv.mu.Unlock()
	if recovered {
		s.logf("auto-recovery: %q recovered (running)", c.name)
		return
	}
	s.warnPersistentDegrade(c.name, c.srv, attempts, cause)
}

// candPriority orders recovery candidates: hermes first, then the gateway, then
// any other system entry, then MCP servers. It mirrors systemStartupPriority so
// a recovery sweep and a boot bring the fleet up in the same order.
func candPriority(srv *server, name string) int {
	if srv.spec.IsSystem() {
		return systemStartupPriority(name)
	}
	return 3
}

// warnPersistentDegrade emits the escalation signal for a server that auto
// recovery cannot fix. Retrying quietly forever is how a gateway outage went
// unnoticed for 27 hours: the sweep kept trying, nothing ever said "this is not
// getting better". System infra is called out explicitly because the gateway is
// the security policy enforcement point, so its absence is a security event and
// not merely a degraded server.
func (s *Supervisor) warnPersistentDegrade(name string, srv *server, attempts int, cause string) {
	if cause != CauseUnrecoverable && attempts < persistentDegradeAttempts {
		return // still plausibly a transient fault; the next sweep retries quietly
	}
	what := "server"
	if srv.spec.IsSystem() {
		what = "SYSTEM component"
	}
	s.logf("auto-recovery: PERSISTENT DEGRADE — %s %q has failed %d consecutive recovery attempts (cause=%s); it will keep being retried but an operator needs to fix the underlying problem. Detail: %s",
		what, name, attempts, cause, srv.degradeDetail())
	if srv.spec.IsSystem() && name == manifest.SystemGateway {
		s.logf("auto-recovery: the gateway is the security policy enforcement point; while it is down, tool calls are NOT being mediated by it")
	}
}

// degradeDetail returns the human-readable reason recorded with the degrade.
func (srv *server) degradeDetail() string {
	srv.mu.Lock()
	defer srv.mu.Unlock()
	return srv.detail
}
