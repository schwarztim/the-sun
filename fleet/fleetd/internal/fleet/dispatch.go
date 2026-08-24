package fleet

import (
	"fmt"
	"sort"

	"mcp-fleet/fleetd/internal/manifest"
)

// dispatch handles one control request. It runs on a control-connection
// goroutine, so it must take s.mu only briefly and never hold it while blocking
// on a supervise loop's `done`.
func (s *Supervisor) dispatch(req Request) Response {
	// Lifecycle-mutating commands are serialized so concurrent control clients
	// cannot race the same server's supervise-loop lifecycle (double-spawn, or a
	// stop/start interleave). `status` is read-only and stays lock-free.
	switch req.Cmd {
	case "stop", "start", "restart", "reload":
		s.ctrlMu.Lock()
		defer s.ctrlMu.Unlock()
	}

	switch req.Cmd {
	case "status":
		return Response{OK: true, Servers: s.snapshot()}
	case "stop":
		return s.applyToTargets(req.Server, "stop", s.stopServer, false)
	case "start":
		return s.applyToTargets(req.Server, "start", s.prepStart, true)
	case "restart":
		return s.applyToTargets(req.Server, "restart", s.prepRestart, true)
	case "reload":
		return s.reload()
	case "shutdown":
		s.logf("control: shutdown requested — daemon exiting, children detach for re-adopt")
		s.cancel()
		return Response{OK: true, Message: "fleetd shutting down; children left running"}
	default:
		return Response{OK: false, Error: "unknown command: " + req.Cmd}
	}
}

func (s *Supervisor) snapshot() []ServerStatus {
	s.mu.Lock()
	names := make([]string, 0, len(s.servers))
	for n := range s.servers {
		names = append(names, n)
	}
	srvs := make(map[string]*server, len(s.servers))
	for n, v := range s.servers {
		srvs[n] = v
	}
	s.mu.Unlock()

	sort.Strings(names)
	out := make([]ServerStatus, 0, len(names))
	for _, n := range names {
		srv := srvs[n]
		srv.mu.Lock()
		st := ServerStatus{
			Name:     srv.spec.Name,
			Kind:     srv.spec.Kind,
			State:    srv.state,
			Port:     srv.spec.Port,
			PID:      srv.pid,
			Restarts: srv.restarts,
			Health:   srv.spec.Health,
			Detail:   srv.detail,

			DegradeCause:    srv.degradeCause,
			RecoverAttempts: srv.recoverAttempts,
		}
		srv.mu.Unlock()

		// Ground the report in reality for anything not believed running: probe
		// the port instead of trusting supervisor state or a pidfile. This is
		// what keeps `thesun status` and `thesun doctor` honest when the two
		// disagree, for example a server reported degraded with no pid whose port
		// is in fact serving (another supervisor's child, or a process fleetd
		// adopted but does not own). The probe runs outside srv.mu, and only for
		// non-running servers, so the common case costs nothing: on loopback a
		// closed port refuses immediately rather than waiting out the timeout.
		if st.State == StateRunning {
			st.Serving = true
		} else {
			st.Serving = probeHealth(st.Port, st.Health)
		}
		out = append(out, st)
	}
	return out
}

// applyToTargets resolves a target name ("" or "all" => every server) and runs
// fn against each, collecting a combined result. When bringUp is true (start /
// restart), fn is a prepare step (validate + reset, no launch) and the servers
// it prepares successfully are launched together through bringUpServers — the
// single serial, ordered, health-gated recovery path (STAB-4). stop passes
// bringUp=false: it never launches anything.
func (s *Supervisor) applyToTargets(name, verb string, fn func(*server) error, bringUp bool) Response {
	targets, err := s.resolveTargets(name)
	if err != nil {
		return Response{OK: false, Error: err.Error()}
	}
	var failed []string
	var ready []string
	for _, srv := range targets {
		if err := fn(srv); err != nil {
			failed = append(failed, fmt.Sprintf("%s: %v", srv.spec.Name, err))
			continue
		}
		ready = append(ready, srv.spec.Name)
	}
	if bringUp {
		s.bringUpServers(ready)
	}
	if len(failed) > 0 {
		return Response{OK: false, Error: fmt.Sprintf("%s failed: %v", verb, failed), Servers: s.snapshot()}
	}
	return Response{OK: true, Message: fmt.Sprintf("%s applied to %d server(s)", verb, len(targets)), Servers: s.snapshot()}
}

func (s *Supervisor) resolveTargets(name string) ([]*server, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if name == "" || name == "all" {
		out := make([]*server, 0, len(s.servers))
		for _, srv := range s.servers {
			out = append(out, srv)
		}
		return out, nil
	}
	srv, ok := s.servers[name]
	if !ok {
		return nil, fmt.Errorf("no such server %q", name)
	}
	return []*server{srv}, nil
}

// stopServer kills the child and halts its supervise loop. State -> stopped.
func (s *Supervisor) stopServer(srv *server) error {
	srv.requestStop()
	srv.waitDone()
	srv.setState(StateStopped, 0, "stopped by operator")
	removePidFile(srv.spec.Name)
	s.publishConfig()
	return nil
}

// prepStart validates that a stopped/degraded server may be (re)started and
// resets its circuit-breaker budget. It does NOT launch the supervise loop — the
// caller (applyToTargets / reload) brings prepared servers up through
// bringUpServers so every start path is serial, ordered, and health-gated
// (STAB-4). Returns an error (leaving the server untouched) if it is already
// supervised.
func (s *Supervisor) prepStart(srv *server) error {
	srv.mu.Lock()
	if srv.state == StateRunning || srv.state == StateStarting {
		st := srv.state
		srv.mu.Unlock()
		return fmt.Errorf("already %s", st)
	}
	srv.restarts = 0
	srv.detach = false
	srv.mu.Unlock()
	return nil
}

// prepRestart stops a live server (so its spec/loop is quiescent) then prepares
// it for bring-up. Like prepStart it does NOT launch — the caller brings it up
// through the shared serial path.
func (s *Supervisor) prepRestart(srv *server) error {
	// Stop only if it's currently supervised (loop alive); ignore "already stopped".
	srv.mu.Lock()
	alive := srv.state == StateRunning || srv.state == StateStarting
	srv.mu.Unlock()
	if alive {
		if err := s.stopServer(srv); err != nil {
			return err
		}
	}
	return s.prepStart(srv)
}

// reload re-reads the manifest, reconciles the running set (add new, remove
// gone, restart changed), and republishes. A malformed new manifest fails closed
// — the running fleet is left untouched.
func (s *Supervisor) reload() Response {
	m, err := manifest.Load(ManifestPath())
	if err != nil {
		return Response{OK: false, Error: "reload rejected (manifest invalid): " + err.Error()}
	}

	newSpecs := map[string]manifest.Server{}
	for _, sp := range m.Servers {
		newSpecs[sp.Name] = sp
	}

	s.mu.Lock()
	current := make(map[string]*server, len(s.servers))
	for n, v := range s.servers {
		current[n] = v
	}
	s.gatewayReloadURL = m.GatewayReloadURL()
	s.mu.Unlock()

	var added, removed, changed []string

	// Removed: in current, not in new.
	for name, srv := range current {
		if _, keep := newSpecs[name]; !keep {
			_ = s.stopServer(srv)
			s.mu.Lock()
			delete(s.servers, name)
			s.mu.Unlock()
			removed = append(removed, name)
		}
	}
	// Added / changed. Iterate newSpecs in a stable sorted order so the prep
	// step is deterministic (map range order is random); the actual bring-up is
	// ordered + serialized by bringUpServers below. toBringUp collects the
	// servers to launch so reload never fans out N supervise loops in parallel
	// (STAB-4).
	newNames := make([]string, 0, len(newSpecs))
	for name := range newSpecs {
		newNames = append(newNames, name)
	}
	sort.Strings(newNames)

	var toBringUp []string
	for _, name := range newNames {
		spec := newSpecs[name]
		srv, exists := current[name]
		if !exists {
			ns := &server{spec: spec, state: StateStopped}
			s.mu.Lock()
			s.servers[name] = ns
			s.mu.Unlock()
			added = append(added, name)
			toBringUp = append(toBringUp, name)
			continue
		}
		srv.mu.Lock()
		unchanged := specEqual(srv.spec, spec)
		srv.mu.Unlock()
		if unchanged {
			continue
		}
		// Stop the supervise goroutine FIRST so no one reads srv.spec while we
		// rewrite it, then rewrite the spec + reset the breaker budget. The
		// relaunch happens through bringUpServers below.
		srv.mu.Lock()
		alive := srv.state == StateRunning || srv.state == StateStarting
		srv.mu.Unlock()
		if alive {
			_ = s.stopServer(srv)
		}
		srv.mu.Lock()
		srv.spec = spec
		srv.restarts = 0
		srv.detach = false
		srv.mu.Unlock()
		changed = append(changed, name)
		toBringUp = append(toBringUp, name)
	}

	// Serial, ordered, health-gated bring-up of everything added/changed.
	s.bringUpServers(toBringUp)

	s.publishConfig()
	msg := fmt.Sprintf("reload: +%d added, -%d removed, ~%d changed", len(added), len(removed), len(changed))
	s.logf("control: %s", msg)
	return Response{OK: true, Message: msg, Servers: s.snapshot()}
}

func specEqual(a, b manifest.Server) bool {
	if a.Bin != b.Bin || a.Port != b.Port || a.Health != b.Health || a.MaxRestarts != b.MaxRestarts || a.Kind != b.Kind {
		return false
	}
	if len(a.Args) != len(b.Args) {
		return false
	}
	for i := range a.Args {
		if a.Args[i] != b.Args[i] {
			return false
		}
	}
	if len(a.Env) != len(b.Env) {
		return false
	}
	for k, v := range a.Env {
		if b.Env[k] != v {
			return false
		}
	}
	return true
}
