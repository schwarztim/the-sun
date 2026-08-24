package registry

// plaintext.go holds the transport policy for remote references: an index or a
// binary may be fetched over plaintext http ONLY when the host is loopback.
//
// The reason is the integrity chain, not privacy. For an unsigned community
// entry, the sha256 recorded in the index is the only thing binding the bytes
// to the catalog, and the index is served over the same channel as the binary.
// An attacker who can rewrite one in flight can rewrite the other, so plaintext
// http over a real network reduces the whole fail-closed chain to nothing.
// Loopback has no such exposure, and forbidding it would break a local index
// and offline testing for no security gain.

import (
	"net"
	"net/url"
	"strings"
)

// PlaintextHTTPAllowed reports whether ref may be fetched as given. Anything
// that is not an http:// URL (https, file://, a bare path) is unaffected and
// returns true; an http:// URL returns true only for a loopback host.
func PlaintextHTTPAllowed(ref string) bool {
	ref = strings.TrimSpace(ref)
	if !strings.HasPrefix(ref, "http://") {
		return true
	}
	u, err := url.Parse(ref)
	if err != nil {
		return false // unparseable plaintext URL: fail closed
	}
	host := u.Hostname()
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
