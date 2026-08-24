package fleet

import (
	"bufio"
	"encoding/json"
	"net"
	"time"
)

// Control protocol: newline-delimited JSON over a loopback control channel.
// The CLI (`fleetd status|start|stop|restart|reload`) sends one Request and
// reads one Response.
//
// The transport is platform-split so the whole stack runs identically on every
// OS: a unix-domain socket on macOS/Linux (control_unix.go) and a 127.0.0.1
// TCP loopback endpoint, gated by a per-boot token, on Windows
// (control_windows.go) — Windows has no dependable unix-socket support in the
// net package. Both transports share the wire types and request handling
// below; only the listen/dial and on-disk endpoint artifact differ.

type Request struct {
	Cmd    string `json:"cmd"`    // status | start | stop | restart | reload | shutdown
	Server string `json:"server"` // optional; empty = all servers
}

type ServerStatus struct {
	Name     string `json:"name"`
	Kind     string `json:"kind"` // "mcp" or "system" (hermes/gateway infra)
	State    string `json:"state"`
	Port     int    `json:"port"`
	PID      int    `json:"pid"`
	Restarts int    `json:"restarts"`
	Health   string `json:"health"` // health PATH (e.g. "/healthz"), not a verdict
	Detail   string `json:"detail,omitempty"`

	// Serving is a live probe result, filled in by snapshot() for any server the
	// supervisor does not believe is running. It answers "is the port actually
	// serving right now" independently of supervisor state and of pidfiles, so a
	// server reported degraded with no pid can still be shown as reachable. A
	// false degraded reading makes real outages indistinguishable from noise,
	// and anything gating on doctor's exit code would be gating on that noise.
	Serving bool `json:"serving"`

	// DegradeCause is CauseRetryable or CauseUnrecoverable when State is
	// degraded, and empty otherwise. RecoverAttempts is how many consecutive
	// auto-recovery sweeps have failed for this server. Together they are the
	// persistent-degrade signal: "retrying will fix this" versus "a human must".
	DegradeCause    string `json:"degrade_cause,omitempty"`
	RecoverAttempts int    `json:"recover_attempts,omitempty"`
}

// PersistentlyDegraded reports whether a server is stuck in a way that will not
// clear on its own: either the cause is unrecoverable by construction, or
// repeated recovery attempts have all failed. This is the signal doctor and the
// operator need, since a fleet that can never recover otherwise looks exactly
// like one that is merely mid-restart.
func (s ServerStatus) PersistentlyDegraded() bool {
	if s.State != StateDegraded {
		return false
	}
	return s.DegradeCause == CauseUnrecoverable || s.RecoverAttempts >= persistentDegradeAttempts
}

type Response struct {
	OK      bool           `json:"ok"`
	Error   string         `json:"error,omitempty"`
	Message string         `json:"message,omitempty"`
	Servers []ServerStatus `json:"servers,omitempty"`
}

// handleConn serves one connection: decode a single Request, dispatch, reply.
// It owns the connection deadline and close. The unix transport calls this
// directly on accept; the Windows transport reads+validates its auth token
// first, then hands the already-buffered reader to serveRequest.
func (s *Supervisor) handleConn(conn net.Conn) {
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
	s.serveRequest(conn, bufio.NewReader(conn))
}

// serveRequest decodes one Request from r and writes one Response to conn. The
// caller owns conn's lifetime and deadline. Split out from handleConn so the
// Windows transport can consume the token line from the same reader before the
// JSON request without losing buffered bytes.
func (s *Supervisor) serveRequest(conn net.Conn, r *bufio.Reader) {
	var req Request
	if err := json.NewDecoder(r).Decode(&req); err != nil {
		writeResp(conn, Response{OK: false, Error: "bad request: " + err.Error()})
		return
	}
	writeResp(conn, s.dispatch(req))
}

func writeResp(conn net.Conn, r Response) {
	b, _ := json.Marshal(r)
	b = append(b, '\n')
	_, _ = conn.Write(b)
}

// sendRequest is the shared client write/read: optionally send an auth token
// line (Windows loopback), then one newline-delimited Request, then read one
// Response. An empty token writes no token line (unix socket).
func sendRequest(conn net.Conn, token string, req Request) (*Response, error) {
	if token != "" {
		if _, err := conn.Write([]byte(token + "\n")); err != nil {
			return nil, err
		}
	}
	b, _ := json.Marshal(req)
	b = append(b, '\n')
	if _, err := conn.Write(b); err != nil {
		return nil, err
	}
	var resp Response
	if err := json.NewDecoder(bufio.NewReader(conn)).Decode(&resp); err != nil {
		return nil, err
	}
	return &resp, nil
}
