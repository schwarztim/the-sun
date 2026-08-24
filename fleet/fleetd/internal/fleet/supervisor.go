// Package fleet is the fleetd supervisor: it spawns MCP server processes on
// static loopback ports, health-checks and auto-restarts them with a circuit
// breaker, injects Hermes secrets into child env only, publishes an MCPU-schema
// gateway config, and survives its own death by detaching and re-adopting
// still-healthy children.
//
// Initial bring-up is ordered and health-gated (system infra first, in
// priority order, then MCP servers one at a time with a short stagger) and
// gateway-config publishing is debounced — see the Run() and publishConfig()
// doc comments. This is the structural fix for the parallel-start →
// reload-cascade → circuit-breaker-retrip failure proven in production on
// 2026-07-06 (3x manual serial recovery was required before this fix).
package fleet

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"os"
	"os/exec"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"mcp-fleet/fleetd/internal/hermes"
	"mcp-fleet/fleetd/internal/manifest"
)

// Server lifecycle states.
const (
	StateStarting = "starting"
	StateRunning  = "running"
	StateDegraded = "degraded" // circuit breaker tripped — no more restarts
	StateStopped  = "stopped"  // stopped by operator
)

// Log rotation defaults (§7 "1GB incident" mitigation).
const (
	logMaxBytes = 50 * 1024 * 1024 // 50MB per file
	logKeep     = 3                // keep 3 rotated files
)

// Ordered-startup tuning. startupHealthWait bounds how long the initial
// bring-up sequence waits for one entry to become healthy before moving on to
// the next — generous enough for a cold start, but bounded so one wedged
// server cannot stall bringing up the rest of the fleet (its own supervise
// loop keeps retrying with backoff in the background regardless of this
// wait). startupStagger is the pause between launching consecutive MCP
// servers so their health-driven publishConfig triggers don't all land in the
// same instant.
const (
	startupHealthWait = 15 * time.Second
	startupStagger    = 500 * time.Millisecond
)

type server struct {
	spec manifest.Server

	mu       sync.Mutex
	state    string
	pid      int
	restarts int    // consecutive failures since last healthy
	detail   string // human-readable reason (e.g. degraded cause)

	// auto-recovery bookkeeping (see autorecover.go): recoverAttempts counts the
	// auto-recovery sweeps that have failed for this server since it last became
	// healthy, and lastRecover is when the sweep last re-attempted it. Together
	// they drive the per-server exponential backoff. Distinct from `restarts`,
	// which is the supervise loop's own consecutive-failure breaker counter.
	recoverAttempts int
	lastRecover     time.Time

	cmd    *exec.Cmd       // nil when adopted (not our child)
	logw   *rotatingWriter // combined stdout/stderr sink
	stopCh chan struct{}   // closed to request stop of this server's supervise loop
	done   chan struct{}   // closed when supervise loop exits
	detach bool            // true => leave child running on stop (shutdown re-adopt)

	// owned records whether fleetd can PROVE this process belongs to it: true
	// when we spawned it, and true when we adopted it via a pid we ourselves
	// wrote to its pidfile. It is false when a process was adopted purely
	// because the port answered healthy (pidfile stale or missing), which means
	// the process may belong to something else entirely. Only an owned process
	// may be terminated; see killChild.
	owned bool

	// degradeCause classifies WHY a server is degraded, which decides whether
	// retrying can ever help. See the CauseRetryable/CauseUnrecoverable docs.
	degradeCause string
}

// Degrade causes. The supervisor retries a degraded server either way (an
// unrecoverable cause can still clear if a human fixes the underlying problem,
// which is exactly what happened when a duplicate supervisor was removed), but
// the classification is what lets `thesun doctor` and an operator tell "this
// will heal itself" apart from "this needs a human". Without it, a fleet that
// can never recover looks identical to one that is mid-restart, and the system
// silently absorbed a 27 hour gateway outage on exactly that ambiguity.
const (
	// CauseRetryable: a crash, a failed health check, or a transient dependency
	// outage. Time and a restart plausibly fix it.
	CauseRetryable = "retryable"
	// CauseUnrecoverable: no amount of restarting fixes it without a human.
	// A port held by a process fleetd does not own, a missing or unexecutable
	// binary, or a credential the broker will not issue.
	CauseUnrecoverable = "unrecoverable"
)

// persistentDegradeAttempts is how many consecutive FAILED auto-recovery sweeps
// mark a server persistently degraded. At the exponential sweep backoff this is
// roughly seven minutes of failed recovery, which is well past any transient
// blip, so crossing it means an operator needs to know.
const persistentDegradeAttempts = 3

// Supervisor owns the whole fleet.
type Supervisor struct {
	mu               sync.Mutex // guards servers map + shared fields (short holds only)
	ctrlMu           sync.Mutex // serializes lifecycle-mutating control ops (start/stop/restart/reload)
	servers          map[string]*server
	resolver         *hermes.Resolver
	gatewayReloadURL string
	logger           *log.Logger

	// publishMu/publishCooldown/publishPending implement the debounced
	// gateway-config publish — see publishConfig() in publish.go.
	publishMu       sync.Mutex
	publishCooldown bool
	publishPending  bool
	publishCount    int64 // atomic: total actual publish writes (observability + tests)

	ctrlLn   net.Listener
	ctrlAddr string // human-readable control endpoint (unix socket path or 127.0.0.1:port)
	ctx      context.Context
	cancel   context.CancelFunc
	wg       sync.WaitGroup

	// launchHook, when non-nil, replaces the real per-server launch step inside
	// bringUpServers so tests can assert bring-up ordering and serialization
	// without spawning real processes or binding real ports. Production leaves it
	// nil (the real health-gated launch runs). It is called once per server, in
	// bring-up order, on the single goroutine driving bringUpServers.
	launchHook func(name string, isSystem bool)
}

// New builds a supervisor from a parsed manifest.
func New(m *manifest.Manifest, logger *log.Logger) *Supervisor {
	if logger == nil {
		logger = log.New(os.Stderr, "", log.LstdFlags|log.Lmsgprefix)
	}
	// Resolve the reload endpoint from the [gateway] section (falling back to the
	// legacy override and then the built-in default) — single source of truth.
	reload := m.GatewayReloadURL()
	s := &Supervisor{
		servers:          map[string]*server{},
		resolver:         hermes.NewResolver(),
		gatewayReloadURL: reload,
		logger:           logger,
	}
	for i := range m.Servers {
		spec := m.Servers[i]
		s.servers[spec.Name] = &server{spec: spec, state: StateStarting}
	}
	return s
}

func (s *Supervisor) logf(format string, a ...any) { s.logger.Printf(format, a...) }

// Run starts the control socket and every server's supervise loop, then blocks
// until the context is cancelled (SIGTERM/SIGINT). On exit it deliberately does
// NOT kill children — supervisor death ≠ fleet death; a fresh fleetd re-adopts
// them. Children are killed only by an explicit `stop`.
func (s *Supervisor) Run(ctx context.Context) error {
	s.ctx, s.cancel = context.WithCancel(ctx)
	defer s.cancel()

	// Refuse to become a second supervisor on this THESUN_HOME. This runs
	// BEFORE serveControl so a refusal never disturbs the running supervisor's
	// control endpoint (see singleton.go for the failure this prevents).
	if err := checkSingleInstance(); err != nil {
		return err
	}

	if err := s.serveControl(); err != nil {
		return err
	}
	if err := writeSupervisorPid(); err != nil {
		s.logf("warning: could not write supervisor pidfile: %v", err)
	}
	defer func() {
		if s.ctrlLn != nil {
			s.ctrlLn.Close()
		}
		s.cleanupControl()
		removeSupervisorPid()
	}()

	s.mu.Lock()
	names := make([]string, 0, len(s.servers))
	for n := range s.servers {
		names = append(names, n)
	}
	s.mu.Unlock()

	// Initial boot brings the whole fleet up through the shared serial, ordered,
	// health-gated path (see bringUpServers). Operator start-all / restart-all
	// and reload's added/changed servers route through the same helper so the
	// serial-recovery invariant holds everywhere, not just at boot.
	s.bringUpServers(names)

	s.logf("fleetd up: supervising %d server(s); control endpoint %s", len(names), s.ctrlAddr)

	// Background sweep that re-attempts servers whose circuit breaker latched
	// DEGRADED (see autorecover.go), so a transient dependency outage no longer
	// requires a manual `fleetd start` to recover. Exits on ctx cancel.
	go s.autoRecoverLoop()

	<-s.ctx.Done()
	s.logf("fleetd shutting down (children left running for re-adopt)")

	// Stop supervise loops WITHOUT killing children.
	s.mu.Lock()
	for _, srv := range s.servers {
		srv.requestDetach()
	}
	s.mu.Unlock()
	s.wg.Wait()
	return nil
}

// startSupervise launches the per-server goroutine. The stop/done channels are
// created here and passed to the goroutine by value so the loop never reads the
// srv.stopCh/srv.done FIELDS (which a later start/restart may reassign) — all
// field access stays under srv.mu.
func (s *Supervisor) startSupervise(srv *server) {
	stopCh := make(chan struct{})
	done := make(chan struct{})
	srv.mu.Lock()
	srv.stopCh = stopCh
	srv.done = done
	srv.detach = false
	srv.mu.Unlock()
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		defer close(done)
		s.supervise(srv, stopCh)
	}()
}

// bringUpServers launches the supervise loops for the named servers in the
// canonical fleet recovery order: system infra first (hermes -> gateway ->
// other system), each health-gated, then MCP servers one at a time with a short
// stagger between them. This is the single serial bring-up path shared by the
// initial boot (Run), operator start-all / restart-all (applyToTargets), and
// reload's added/changed servers.
//
// Serializing every bring-up (not just boot) is the structural fix for the
// parallel-start -> reload-cascade -> circuit-breaker-retrip failure proven in
// production (2026-07-06): launching N supervise goroutines at once meant each
// independently triggered a gateway reload the instant it turned healthy, and
// the reload burst re-tripped healthy servers. `thesun start` after a
// multi-server degrade previously reproduced exactly that. Combined with the
// debounced publishConfig (see publish.go), a serial bring-up bounds the burst
// to one reload instead of N. A single-element list skips the stagger but still
// travels this one code path for consistency; per-server restart/backoff/
// circuit-breaker behavior inside supervise() is untouched.
func (s *Supervisor) bringUpServers(names []string) {
	if len(names) == 0 {
		return
	}
	// splitStartupOrder sorts internally via the priority comparator, but sort
	// the incoming names first so the MCP tail is deterministic (alphabetical)
	// regardless of the caller's iteration order (e.g. reload's map range).
	sorted := append([]string(nil), names...)
	sort.Strings(sorted)
	sysNames, mcpNames := s.splitStartupOrder(sorted)
	s.logf("bring-up: %d system + %d mcp server(s) in recovery order (serial, health-gated)", len(sysNames), len(mcpNames))

	// System infra first, strictly in order and health-gated (hermes -> wait
	// healthy -> gateway -> wait healthy): MCP servers and the gateway itself may
	// need hermes for secrets, and the gateway should be reachable before MCP
	// backends start publishing into it.
	for _, n := range sysNames {
		if s.ctx != nil && s.ctx.Err() != nil {
			return
		}
		if s.launchHook != nil {
			s.launchHook(n, true)
			continue
		}
		s.startAndAwaitHealthy(n, startupHealthWait)
	}

	// MCP servers one at a time with a short stagger between consecutive starts
	// so their health-driven publishConfig triggers do not all land at once.
	for i, n := range mcpNames {
		if s.ctx != nil && s.ctx.Err() != nil {
			return
		}
		if s.launchHook != nil {
			s.launchHook(n, false)
			continue // hooked tests skip the real (wall-clock) stagger
		}
		s.startAndAwaitHealthy(n, startupHealthWait)
		if i < len(mcpNames)-1 {
			select {
			case <-s.ctx.Done():
				return
			case <-time.After(startupStagger):
			}
		}
	}
}

// splitStartupOrder partitions sorted server names into system infra (ordered
// hermes-then-gateway-then-other via systemStartupPriority) and MCP servers
// (kept in the incoming, already-alphabetical order) — the sequence
// bringUpServers brings the fleet up in.
func (s *Supervisor) splitStartupOrder(names []string) (sys, mcp []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, n := range names {
		if srv, ok := s.servers[n]; ok && srv.spec.IsSystem() {
			sys = append(sys, n)
		} else {
			mcp = append(mcp, n)
		}
	}
	sort.SliceStable(sys, func(i, j int) bool {
		return systemStartupPriority(sys[i]) < systemStartupPriority(sys[j])
	})
	return sys, mcp
}

// systemStartupPriority orders kind="system" entries during bring-up: hermes
// (secrets/auth broker) before the gateway (which MCP servers reload into)
// before any other system entry.
func systemStartupPriority(name string) int {
	switch name {
	case manifest.SystemHermes:
		return 0
	case manifest.SystemGateway:
		return 1
	default:
		return 2
	}
}

// startAndAwaitHealthy launches one server's supervise loop and blocks until
// it reports healthy or `wait` elapses — the health gate used by ordered
// startup. A timeout here is NOT a failure: the server's own supervise loop
// (started just above) keeps retrying with backoff after this call returns;
// it only means the rest of the ordered bring-up stops waiting on it.
func (s *Supervisor) startAndAwaitHealthy(name string, wait time.Duration) {
	s.mu.Lock()
	srv := s.servers[name]
	s.mu.Unlock()
	if srv == nil {
		return
	}
	s.startSupervise(srv)

	deadline := time.Now().Add(wait)
	ticker := time.NewTicker(150 * time.Millisecond)
	defer ticker.Stop()
	for {
		if probeHealth(srv.spec.Port, srv.spec.Health) {
			s.logf("[%s] healthy — continuing ordered startup", srv.spec.Name)
			return
		}
		select {
		case <-s.ctx.Done():
			return
		case <-ticker.C:
			if time.Now().After(deadline) {
				s.logf("[%s] not healthy within %s of ordered startup — continuing; its own supervise loop keeps retrying", srv.spec.Name, wait)
				return
			}
		}
	}
}

// supervise is the lifecycle loop for one server: adopt-or-spawn, wait healthy,
// monitor, and on death apply exponential backoff up to the circuit breaker.
func (s *Supervisor) supervise(srv *server, stopCh <-chan struct{}) {
	firstIter := true
	for {
		select {
		case <-stopCh:
			return
		case <-s.ctx.Done():
			return
		default:
		}

		// --- Adopt (first iteration only) ---
		if firstIter {
			firstIter = false
			if pid, ok := s.tryAdopt(srv); ok {
				srv.setState(StateRunning, pid, fmt.Sprintf("re-adopted existing pid %d on port %d", pid, srv.spec.Port))
				s.logf("[%s] re-adopted running process pid=%d port=%d (no respawn)", srv.spec.Name, pid, srv.spec.Port)
				s.publishConfig()
				if s.monitorAdopted(srv, stopCh) == exitStop {
					return
				}
				// adopted process died — fall through to spawn path
				srv.recordFailure()
				if s.tripped(srv) {
					return
				}
				s.sleepBackoff(srv, stopCh)
				continue
			}
		}

		// --- Refuse to double-spawn: something already serving the port ---
		if portListening(srv.spec.Port) {
			// Non-destructive by construction: report who holds the port and stop,
			// never evict them. A foreign owner here is the signature of a second
			// supervisor or an unrelated program, and neither is ours to kill.
			owners := portOwnerPIDs(srv.spec.Port)
			s.logf("[%s] port %d already in use by a process fleetd does not own (owner pid(s) %v) — not spawning (avoids EADDRINUSE double-spawn)", srv.spec.Name, srv.spec.Port, owners)
			srv.setDegraded(CauseUnrecoverable, fmt.Sprintf("port %d already in use by pid(s) %v fleetd does not own; refusing to spawn", srv.spec.Port, owners))
			s.publishConfig()
			return
		}

		// --- Spawn ---
		diedCh, err := s.spawn(srv)
		if err != nil {
			// A binary that is missing or not executable will fail identically on
			// every retry, so burning the restart budget on it only delays the
			// operator learning the truth. Degrade immediately and say why.
			if unrecoverableSpawnErr(err) {
				s.logf("[%s] SPAWN IMPOSSIBLE: %v — no retry can fix this; marking degraded for operator action", srv.spec.Name, err)
				srv.setDegraded(CauseUnrecoverable, "cannot execute "+srv.spec.Bin+": "+err.Error())
				removePidFile(srv.spec.Name)
				s.publishConfig()
				return
			}
			s.logf("[%s] spawn failed: %v", srv.spec.Name, err)
			srv.setState(StateStarting, 0, "spawn error: "+err.Error())
			srv.recordFailure()
			if s.tripped(srv) {
				return
			}
			s.sleepBackoff(srv, stopCh)
			continue
		}

		// --- Wait for health (or early exit) ---
		if s.waitHealthy(srv, diedCh, stopCh) {
			srv.setState(StateRunning, srv.getPID(), "healthy")
			srv.resetFailures()
			s.logf("[%s] running pid=%d port=%d (healthz 200)", srv.spec.Name, srv.getPID(), srv.spec.Port)
			s.publishConfig()

			if s.monitorSpawned(srv, diedCh, stopCh) == exitStop {
				return
			}
			// died after being healthy
			s.logf("[%s] process exited; will restart", srv.spec.Name)
			s.publishConfig() // drop from published config while down
			srv.recordFailure()
		} else {
			// never became healthy within the startup deadline (or exited early)
			s.logf("[%s] did not become healthy; killing and restarting", srv.spec.Name)
			srv.killChild()
			srv.recordFailure()
		}

		if s.tripped(srv) {
			return
		}
		s.sleepBackoff(srv, stopCh)
	}
}

type exitReason int

const (
	exitDied exitReason = iota
	exitStop
)

// tryAdopt returns (pid, true) if an existing healthy process is already serving
// this server's port — in which case fleetd resumes supervising it instead of
// spawning. This is what makes supervisor restart non-disruptive.
func (s *Supervisor) tryAdopt(srv *server) (int, bool) {
	if !probeHealth(srv.spec.Port, srv.spec.Health) {
		return 0, false
	}
	// Port is serving healthy — must NOT spawn (would collide). Adopt it.
	pid := readPidFile(srv.spec.Name)
	if pid > 0 && pidAlive(pid) {
		// Owned: the pid came from the pidfile fleetd itself wrote at spawn, so
		// this is our own child from a previous supervisor lifetime. Reclaiming
		// it (including terminating it if it wedges) is legitimate.
		srv.mu.Lock()
		srv.cmd = nil // adopted: not our child process handle, cannot Wait()
		srv.pid = pid
		srv.owned = true
		srv.mu.Unlock()
		return pid, true
	}
	// Serving but pid unknown/stale — still adopt (by health) to avoid a
	// double-spawn; pid 0 means "monitor by health/port only". This process is
	// explicitly NOT owned: nothing proves it is ours rather than an unrelated
	// program (or another supervisor's child) holding the port, so it must
	// never be terminated. See killChild and monitorAdopted.
	s.logf("[%s] port %d healthy but pidfile stale/missing — adopting by health, treating as UNOWNED (will never be terminated by fleetd)", srv.spec.Name, srv.spec.Port)
	srv.mu.Lock()
	srv.cmd = nil
	srv.pid = pid
	srv.owned = false
	srv.mu.Unlock()
	return pid, true
}

// spawn starts the child with resolved env, detached into its own process group,
// with combined stdout/stderr going to the rotating log. Returns a channel that
// closes when the child exits (reaped by a goroutine).
func (s *Supervisor) spawn(srv *server) (<-chan struct{}, error) {
	env, err := s.resolveEnv(srv)
	if err != nil {
		return nil, err
	}

	// Combined stdout/stderr → rotating per-server log. Secrets are never
	// written here by fleetd; only whatever the child itself emits.
	if srv.logw == nil {
		lw, lerr := newRotatingWriter(logFile(srv.spec.Name), logMaxBytes, logKeep)
		if lerr != nil {
			return nil, fmt.Errorf("open log: %w", lerr)
		}
		srv.logw = lw
	}

	cmd := exec.Command(srv.spec.Bin, srv.spec.Args...)
	cmd.Env = env
	cmd.Stdout = srv.logw
	cmd.Stderr = srv.logw
	// Detach: own process group so a signal to fleetd's group (e.g. Ctrl-C in a
	// foreground run) does not propagate to children, and children survive
	// fleetd's death cleanly for re-adopt. procAttr is OS-specific (build-tagged).
	cmd.SysProcAttr = procAttr()

	if err := cmd.Start(); err != nil {
		return nil, err
	}
	pid := cmd.Process.Pid
	srv.mu.Lock()
	srv.cmd = cmd
	srv.pid = pid
	srv.owned = true // we started it, so we may stop it
	srv.state = StateStarting
	srv.mu.Unlock()

	if err := writePidFile(srv.spec.Name, pid); err != nil {
		s.logf("[%s] warning: could not write pidfile: %v", srv.spec.Name, err)
	}
	s.logf("[%s] spawned pid=%d port=%d bin=%s", srv.spec.Name, pid, srv.spec.Port, srv.spec.Bin)

	died := make(chan struct{})
	go func() {
		_ = cmd.Wait() // reap; releases the zombie
		close(died)
	}()
	return died, nil
}

// resolveEnv builds the child env: process env passthrough is intentionally NOT
// inherited wholesale — only the manifest-declared env is injected (minimal
// per-proc env, loopback-only). hermes:// refs are resolved to plaintext and
// placed in the child env ONLY. Literal values pass through unchanged.
func (s *Supervisor) resolveEnv(srv *server) ([]string, error) {
	// Base: a minimal, non-secret environment the child likely needs.
	base := map[string]string{
		"PATH":     os.Getenv("PATH"),
		"HOME":     os.Getenv("HOME"),
		"MCP_HOST": "127.0.0.1",
		"MCP_PORT": fmt.Sprintf("%d", srv.spec.Port),
	}
	// Manifest env overrides base; hermes refs resolved here.
	keys := make([]string, 0, len(srv.spec.Env))
	for k := range srv.spec.Env {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		v := srv.spec.Env[k]
		if hermes.IsRef(v) {
			ctx, cancel := context.WithTimeout(s.ctx, 12*time.Second)
			secret, err := s.resolver.Resolve(ctx, v)
			cancel()
			if err != nil {
				// Mark degraded with a clear reason; do NOT crash the fleet and
				// do NOT fall back to any insecure default.
				return nil, fmt.Errorf("hermes resolution for env %s failed: %w", k, err)
			}
			base[k] = secret
			continue
		}
		base[k] = v
	}
	out := make([]string, 0, len(base))
	for k, v := range base {
		out = append(out, k+"="+v)
	}
	sort.Strings(out)
	return out, nil
}

// waitHealthy polls until the server reports healthy, the child exits early, or
// the startup deadline elapses.
func (s *Supervisor) waitHealthy(srv *server, diedCh, stopCh <-chan struct{}) bool {
	deadline := time.Now().Add(15 * time.Second)
	ticker := time.NewTicker(300 * time.Millisecond)
	defer ticker.Stop()
	for {
		if probeHealth(srv.spec.Port, srv.spec.Health) {
			return true
		}
		select {
		case <-diedCh:
			return false // child exited before becoming healthy
		case <-stopCh:
			return false
		case <-s.ctx.Done():
			return false
		case <-ticker.C:
			if time.Now().After(deadline) {
				return false
			}
		}
	}
}

// monitorSpawned watches a child we started: it returns exitStop on operator
// stop / shutdown-detach, or exitDied when the child process exits or becomes
// unhealthy. Health is the authoritative signal — a wedged-but-alive process
// (deadlock, /healthz returning 500) must be killed and restarted.
func (s *Supervisor) monitorSpawned(srv *server, diedCh, stopCh <-chan struct{}) exitReason {
	timer := time.NewTimer(jittered(monitorInterval))
	defer timer.Stop()
	var consecutiveUnhealthy int
	for {
		select {
		case <-diedCh:
			return exitDied
		case <-stopCh:
			if srv.detachOnly() {
				return exitStop
			}
			srv.killChild()
			return exitStop
		case <-s.ctx.Done():
			return exitStop
		case <-timer.C:
			timer.Reset(jittered(monitorInterval))
			v := probeHealthVerdict(srv.spec.Port, srv.spec.Health)
			if v == probeHealthy {
				consecutiveUnhealthy = 0
				continue
			}
			consecutiveUnhealthy++
			// A slow or hung answer gets a far wider window than a refused
			// connection: the process is demonstrably alive, so killing it for
			// latency converts a slow server into a down one.
			if consecutiveUnhealthy >= strikeBudget(v) {
				s.logf("[%s] %s for %d consecutive checks — killing for restart", srv.spec.Name, verdictName(v), consecutiveUnhealthy)
				srv.killChild()
				return exitDied
			}
		}
	}
}

// monitorAdopted watches a process we did NOT spawn (no Wait): death is detected
// by health probe failure (authoritative) or pid death. A wedged-but-alive
// adopted process is killed after 3 consecutive unhealthy checks.
func (s *Supervisor) monitorAdopted(srv *server, stopCh <-chan struct{}) exitReason {
	timer := time.NewTimer(jittered(monitorInterval))
	defer timer.Stop()
	var consecutiveUnhealthy int
	for {
		select {
		case <-stopCh:
			if srv.detachOnly() {
				return exitStop
			}
			srv.killChild()
			return exitStop
		case <-s.ctx.Done():
			return exitStop
		case <-timer.C:
			timer.Reset(jittered(monitorInterval))
			v := probeHealthVerdict(srv.spec.Port, srv.spec.Health)
			healthy := v == probeHealthy
			pid := srv.getPID()
			alive := (pid > 0 && pidAlive(pid))
			if !healthy {
				consecutiveUnhealthy++
				// Same tolerance rule as monitorSpawned: react fast to a refused
				// connection, but give a slow or hung answer a wide window.
				if !alive || consecutiveUnhealthy >= strikeBudget(v) {
					// Unhealthy and either dead or wedged. What fleetd may do about
					// it depends entirely on whether it can prove it owns the
					// process.
					if !srv.isOwned() {
						// Adopted purely because the port answered healthy: this
						// process may belong to anything, including another
						// supervisor. Report it and stop supervising; never signal
						// it. Terminating here is what made a duplicate supervisor
						// destructive rather than merely redundant.
						owners := portOwnerPIDs(srv.spec.Port)
						s.logf("[%s] unhealthy process on port %d is NOT owned by this fleetd (owner pid(s) %v) — refusing to terminate a process it did not spawn; marking degraded for operator action", srv.spec.Name, srv.spec.Port, owners)
						srv.setDegraded(CauseUnrecoverable, fmt.Sprintf("port %d served by an unhealthy process fleetd does not own (pid(s) %v); refusing to terminate it", srv.spec.Port, owners))
						s.publishConfig()
						return exitStop
					}
					// Owned (adopted via fleetd's own pidfile): reclaiming a stale
					// child of ours is legitimate, so terminate it and let the
					// supervise loop respawn on the freed port.
					s.logf("[%s] adopted OWN process unhealthy (pid=%d alive=%v) after %d check(s) — terminating to free port %d for restart", srv.spec.Name, pid, alive, consecutiveUnhealthy, srv.spec.Port)
					srv.killChild()
					return exitDied
				}
			} else {
				consecutiveUnhealthy = 0
			}
		}
	}
}

// tripped checks the circuit breaker: after max_restarts consecutive failures,
// mark degraded and STOP restarting (no infinite thrash).
func (s *Supervisor) tripped(srv *server) bool {
	srv.mu.Lock()
	over := srv.restarts >= srv.spec.MaxRestarts
	srv.mu.Unlock()
	if over {
		srv.setDegraded(CauseRetryable, fmt.Sprintf("circuit breaker: %d consecutive failures ≥ max_restarts %d — restarts stopped", srv.restarts, srv.spec.MaxRestarts))
		s.logf("[%s] DEGRADED — %d consecutive failures ≥ max_restarts %d; restarts stopped", srv.spec.Name, srv.restarts, srv.spec.MaxRestarts)
		removePidFile(srv.spec.Name)
		s.publishConfig()
		return true
	}
	return false
}

func (s *Supervisor) sleepBackoff(srv *server, stopCh <-chan struct{}) {
	srv.mu.Lock()
	attempt := srv.restarts
	srv.mu.Unlock()
	d := backoff(attempt)
	s.logf("[%s] restart backoff %s (attempt %d/%d)", srv.spec.Name, d, attempt, srv.spec.MaxRestarts)
	select {
	case <-time.After(d):
	case <-stopCh:
	case <-s.ctx.Done():
	}
}

// --- server helpers ---

func (srv *server) setState(state string, pid int, detail string) {
	srv.mu.Lock()
	srv.state = state
	if pid != 0 || state != StateRunning {
		srv.pid = pid
	}
	srv.detail = detail
	if state != StateDegraded {
		srv.degradeCause = "" // a cause only describes the degraded state
	}
	srv.mu.Unlock()
}

// setDegraded marks a server degraded together with WHY, so callers of status
// and doctor can tell a self-healing fault from one that needs a human. Every
// path that degrades a server must use this rather than setState, so a cause is
// never silently missing.
func (srv *server) setDegraded(cause, detail string) {
	srv.mu.Lock()
	srv.state = StateDegraded
	srv.pid = 0
	srv.detail = detail
	srv.degradeCause = cause
	srv.mu.Unlock()
}

// degradeInfo returns the current cause and the count of consecutive failed
// auto-recovery sweeps, the two inputs to the persistent-degrade signal.
func (srv *server) degradeInfo() (cause string, attempts int) {
	srv.mu.Lock()
	defer srv.mu.Unlock()
	return srv.degradeCause, srv.recoverAttempts
}

func (srv *server) getPID() int {
	srv.mu.Lock()
	defer srv.mu.Unlock()
	return srv.pid
}

func (srv *server) recordFailure() {
	srv.mu.Lock()
	srv.restarts++
	srv.mu.Unlock()
}

func (srv *server) resetFailures() {
	srv.mu.Lock()
	srv.restarts = 0
	srv.mu.Unlock()
}

// killChild terminates the child process group (SIGTERM, escalating to SIGKILL),
// but ONLY when fleetd can prove the process is its own: either it spawned it, or
// it adopted it via a pid fleetd itself wrote to the pidfile. It does NOT call
// Wait — the per-child reaper goroutine (spawn) owns cmd.Wait(); killChild only
// signals and polls liveness, avoiding a double-Wait race.
//
// The ownership gate is the fix for the destructive adopt-then-terminate
// behavior: a supervisor that adopted a port purely because it answered healthy
// used to resolve the port's owner from the OS and kill it. When a second
// supervisor (or any unrelated program) held that port, that killed a process
// fleetd never started. A supervisor must never signal a process it cannot prove
// it owns, so the unowned case now returns without signalling anything and the
// caller reports the condition instead (see monitorAdopted).
func (srv *server) killChild() {
	srv.mu.Lock()
	pid := srv.pid
	owned := srv.owned
	name := srv.spec.Name
	srv.mu.Unlock()
	if pid <= 0 || !owned {
		// Unowned, or adopted by health with no usable pid. Do not signal
		// anything. Clear the stale pidfile so a later adopt does not trust it.
		removePidFile(name)
		return
	}
	// killTree is OS-specific (build-tagged): Unix signals the process group,
	// Windows tears down the tree with taskkill /T. Grace before force-kill.
	killTree(pid, time.Now().Add(3*time.Second))
	removePidFile(name)
}

// unrecoverableSpawnErr reports whether a spawn failure is permanent: the
// binary does not exist, is not executable, or is not a runnable image. These
// fail identically on every retry. A Hermes resolution failure is deliberately
// NOT in this set: the broker coming back fixes it, so it stays retryable.
func unrecoverableSpawnErr(err error) bool {
	return errors.Is(err, exec.ErrNotFound) ||
		errors.Is(err, os.ErrNotExist) ||
		errors.Is(err, os.ErrPermission) ||
		errors.Is(err, syscall.ENOEXEC)
}

// isOwned reports whether fleetd can prove this process is its own (spawned by
// this fleetd, or adopted via fleetd's own pidfile). Only an owned process may
// be terminated.
func (srv *server) isOwned() bool {
	srv.mu.Lock()
	defer srv.mu.Unlock()
	return srv.owned
}

// portOwnerPIDs returns the PIDs owning 127.0.0.1:<port>. Cross-platform guarded
// by runtime.GOOS: on unix it uses lsof (present on macOS and Linux); on Windows
// it uses netstat (see netstatPortOwners). Both feed killTree, whose per-OS
// build-tagged impl signals the process group (unix) or runs taskkill /F /T
// (windows). netstat/lsof are invoked via exec only inside their matching OS
// branch, so this one function compiles on every platform.
func portOwnerPIDs(port int) []int {
	if port <= 0 {
		return nil
	}
	if runtime.GOOS == "windows" {
		return netstatPortOwners(port)
	}
	out, err := exec.Command("lsof", "-ti", "tcp:"+strconv.Itoa(port)).Output()
	if err != nil {
		return nil // no owner (lsof exits non-zero when nothing matches) or lsof absent
	}
	var pids []int
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if pid, err := strconv.Atoi(line); err == nil && pid > 0 {
			pids = append(pids, pid)
		}
	}
	return pids
}

// netstatPortOwners resolves the PID(s) LISTENING on the given loopback TCP port
// on Windows via `netstat -ano -p tcp`, deferring termination to killTree
// (taskkill /F /T on Windows). The output parsing is isolated in
// parseNetstatOwners so it is unit-testable on any OS. Returns no PIDs on an
// exec error (netstat missing/failed); never panics on unexpected output.
func netstatPortOwners(port int) []int {
	out, err := exec.Command("netstat", "-ano", "-p", "tcp").Output()
	if err != nil {
		return nil
	}
	return parseNetstatOwners(string(out), port)
}

// parseNetstatOwners extracts the owning PID(s) from `netstat -ano -p tcp` output
// for sockets LISTENING on the target port. It is pure string parsing (no OS
// calls) so it runs and is tested on any platform. A `netstat -ano -p tcp` row
// is: Proto  Local-Address  Foreign-Address  State  PID, e.g.
//
//	TCP    0.0.0.0:3100      0.0.0.0:0        LISTENING  5678
//	TCP    [::]:42210        [::]:0           LISTENING  5678
//
// The local port is matched exactly (parsed after the final colon, so ":8080"
// never matches ":18080"), only LISTENING rows are considered (the port owner,
// not a client connected to it), and PIDs are de-duplicated (IPv4 + IPv6 rows
// for one listener share a PID). Malformed rows are skipped, not fatal.
func parseNetstatOwners(out string, port int) []int {
	var pids []int
	seen := map[int]bool{}
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(line)
		if len(f) < 5 {
			continue
		}
		if !strings.EqualFold(f[0], "TCP") {
			continue
		}
		if !strings.EqualFold(f[3], "LISTENING") {
			continue
		}
		local := f[1]
		colon := strings.LastIndex(local, ":")
		if colon < 0 {
			continue
		}
		lp, err := strconv.Atoi(local[colon+1:])
		if err != nil || lp != port {
			continue
		}
		pid, err := strconv.Atoi(f[len(f)-1])
		if err != nil || pid <= 0 || seen[pid] {
			continue
		}
		seen[pid] = true
		pids = append(pids, pid)
	}
	return pids
}

// requestStop closes the current stop channel with kill semantics (child dies).
func (srv *server) requestStop() { srv.setDetachAndClose(false) }

// requestDetach closes the current stop channel with detach semantics (child is
// left running for a future fleetd to re-adopt).
func (srv *server) requestDetach() { srv.setDetachAndClose(true) }

// setDetachAndClose sets the detach flag and idempotently closes stopCh — all
// under srv.mu so it never races startSupervise's reassignment of the field.
func (srv *server) setDetachAndClose(detach bool) {
	srv.mu.Lock()
	defer srv.mu.Unlock()
	srv.detach = detach
	if srv.stopCh == nil {
		return
	}
	select {
	case <-srv.stopCh:
		// already closed
	default:
		close(srv.stopCh)
	}
}

// waitDone blocks until the current supervise goroutine has exited.
func (srv *server) waitDone() {
	srv.mu.Lock()
	done := srv.done
	srv.mu.Unlock()
	if done != nil {
		<-done
	}
}

func (srv *server) detachOnly() bool {
	srv.mu.Lock()
	defer srv.mu.Unlock()
	return srv.detach
}
