//go:build windows

package fleet

import (
	"bufio"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Windows control transport: Windows has no dependable unix-domain socket
// support in Go's net package, so the control channel is a 127.0.0.1 TCP
// listener on an ephemeral port. Loopback TCP is reachable by any local
// process, so — unlike the unix socket where 0600 file permissions are the
// gate — access is authenticated by a per-boot random token. The port and
// token are written to an endpoint file (fleetd.control) at mode 0600 inside
// the 0700 run dir, so only a process that can read the owner-only run dir can
// learn how to connect. A client must present the token as its first line or
// the connection is refused.

// controlEndpointFile is the on-disk descriptor the client reads to find the
// running daemon's control port and token.
func controlEndpointFile() string { return filepath.Join(RunDir(), "fleetd.control") }

// serveControl runs the loopback TCP control server until ctx-driven shutdown.
func (s *Supervisor) serveControl() error {
	if err := os.MkdirAll(RunDir(), 0o700); err != nil {
		return err
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("listen on control endpoint: %w", err)
	}
	addr, ok := ln.Addr().(*net.TCPAddr)
	if !ok {
		ln.Close()
		return fmt.Errorf("control endpoint: unexpected listener address %T", ln.Addr())
	}

	tokBytes := make([]byte, 32)
	if _, err := rand.Read(tokBytes); err != nil {
		ln.Close()
		return fmt.Errorf("control endpoint: generate token: %w", err)
	}
	token := hex.EncodeToString(tokBytes)

	// Descriptor: "<port>\n<token>\n". Written 0600 so only the owner can read
	// the token — the loopback equivalent of the unix socket's 0600 mode.
	desc := []byte(strconv.Itoa(addr.Port) + "\n" + token + "\n")
	if err := os.WriteFile(controlEndpointFile(), desc, 0o600); err != nil {
		ln.Close()
		return fmt.Errorf("write control endpoint file: %w", err)
	}

	s.ctrlLn = ln
	s.ctrlAddr = addr.String()
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return // listener closed on shutdown
			}
			go s.handleAuthedConn(conn, token)
		}
	}()
	return nil
}

// handleAuthedConn validates the token line before serving the request. A
// missing or wrong token yields a single error Response and closes.
func (s *Supervisor) handleAuthedConn(conn net.Conn, token string) {
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
	r := bufio.NewReader(conn)
	line, err := r.ReadString('\n')
	if err != nil || subtle.ConstantTimeCompare([]byte(strings.TrimSpace(line)), []byte(token)) != 1 {
		writeResp(conn, Response{OK: false, Error: "unauthorized"})
		return
	}
	s.serveRequest(conn, r)
}

// cleanupControl removes the endpoint descriptor on shutdown so a stale port
// is never dialed by a later client.
func (s *Supervisor) cleanupControl() { _ = os.Remove(controlEndpointFile()) }

// controlEndpointDesc names this platform's control endpoint for diagnostics
// (see the single-instance guard in singleton.go).
func controlEndpointDesc() string { return controlEndpointFile() }

// SendControl is the client side: read the endpoint descriptor, dial the
// loopback port, authenticate with the token, send req, return the reply.
func SendControl(req Request) (*Response, error) {
	raw, err := os.ReadFile(controlEndpointFile())
	if err != nil {
		return nil, fmt.Errorf("fleetd not running (control endpoint %s unreachable): %w", controlEndpointFile(), err)
	}
	parts := strings.SplitN(strings.TrimRight(string(raw), "\r\n"), "\n", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return nil, fmt.Errorf("fleetd control endpoint file %s is malformed", controlEndpointFile())
	}
	port, token := strings.TrimSpace(parts[0]), strings.TrimSpace(parts[1])

	conn, err := net.DialTimeout("tcp", "127.0.0.1:"+port, 3*time.Second)
	if err != nil {
		return nil, fmt.Errorf("fleetd not running (control endpoint 127.0.0.1:%s unreachable): %w", port, err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
	return sendRequest(conn, token, req)
}
