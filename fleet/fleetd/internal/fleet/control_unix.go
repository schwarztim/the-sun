//go:build !windows

package fleet

import (
	"fmt"
	"net"
	"os"
	"time"
)

// Unix control transport: a loopback unix-domain socket at SocketPath(),
// restricted to the owner via directory (0700) and socket (0600) permissions —
// the filesystem is the access control, so no in-band token is needed.

// serveControl runs the unix-socket control server until ctx-driven shutdown.
func (s *Supervisor) serveControl() error {
	_ = os.Remove(SocketPath()) // clear a stale socket from a prior run
	if err := os.MkdirAll(Root(), 0o700); err != nil {
		return err
	}
	ln, err := net.Listen("unix", SocketPath())
	if err != nil {
		return fmt.Errorf("listen on control socket: %w", err)
	}
	if err := os.Chmod(SocketPath(), 0o600); err != nil {
		ln.Close()
		return fmt.Errorf("chmod control socket: %w", err)
	}
	s.ctrlLn = ln
	s.ctrlAddr = SocketPath()
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return // listener closed on shutdown
			}
			go s.handleConn(conn)
		}
	}()
	return nil
}

// cleanupControl removes the on-disk control artifact on shutdown.
func (s *Supervisor) cleanupControl() { _ = os.Remove(SocketPath()) }

// controlEndpointDesc names this platform's control endpoint for diagnostics
// (see the single-instance guard in singleton.go).
func controlEndpointDesc() string { return SocketPath() }

// SendControl is the client side: dial the socket, send req, return the reply.
func SendControl(req Request) (*Response, error) {
	conn, err := net.DialTimeout("unix", SocketPath(), 3*time.Second)
	if err != nil {
		return nil, fmt.Errorf("fleetd not running (control socket %s unreachable): %w", SocketPath(), err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
	return sendRequest(conn, "", req)
}
