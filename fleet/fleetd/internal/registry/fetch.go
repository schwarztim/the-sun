package registry

// fetch.go retrieves an index from an https URL, a local filesystem path, or a
// file:// URL, then parses it. Keeping all three shapes in one entry point lets
// the whole add/search/publish loop run fully offline against a local index in
// tests (and lets an operator point --index at a checked-out file). It mirrors
// the defensive posture of generator/src/generator/resolve-go-spec.ts: a short
// client timeout, read the body verbatim, never panic, and return
// (nil, warnings, err) on any failure rather than surfacing a partial index.

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// fetchTimeout bounds a remote index fetch. The index is a small text file; a
// slow or hung endpoint should fail fast rather than stall `thesun add`.
const fetchTimeout = 15 * time.Second

// maxIndexBytes caps how much we will read from a remote index (defense against
// a hostile or misconfigured endpoint streaming an unbounded body).
const maxIndexBytes = 8 << 20 // 8 MiB

// FetchIndex loads and parses the index at ref. ref may be an http(s) URL, a
// file:// URL, or a local filesystem path. The returned warnings come from
// Parse (schema mismatch, malformed entries); a non-nil error means the index
// could not be retrieved or is unparseable TOML.
func FetchIndex(ctx context.Context, ref string) (*Index, []string, error) {
	return FetchIndexAuth(ctx, ref, "")
}

// FetchIndexAuth is FetchIndex with an optional bearer token. When bearer is
// non-empty it is sent as "Authorization: Bearer <bearer>" on http(s) requests,
// which lets `thesun add` pull an index hosted behind an authenticated endpoint
// (for example a Stash raw-file URL) using a PAT resolved from Hermes. An empty
// bearer sends no auth header, so public and file:// references are unaffected.
func FetchIndexAuth(ctx context.Context, ref, bearer string) (*Index, []string, error) {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return nil, nil, fmt.Errorf("registry: empty index reference")
	}

	// Plaintext http is refused for remote hosts: the index carries the sha256
	// values that are the only integrity check on an unsigned community entry, so
	// serving it over a channel an attacker can rewrite defeats the whole
	// verification chain. Loopback is exempt (nothing sits between a process and
	// itself), which keeps a local index and local testing working.
	if !PlaintextHTTPAllowed(ref) {
		return nil, nil, fmt.Errorf("registry: refusing plaintext http index %q: use https (plaintext is allowed only for loopback)", ref)
	}

	var raw []byte
	var err error
	switch {
	case strings.HasPrefix(ref, "https://"), strings.HasPrefix(ref, "http://"):
		raw, err = fetchHTTP(ctx, ref, bearer)
	case strings.HasPrefix(ref, "file://"):
		raw, err = os.ReadFile(strings.TrimPrefix(ref, "file://"))
	default:
		raw, err = os.ReadFile(ref)
	}
	if err != nil {
		return nil, nil, fmt.Errorf("registry: fetch index %q: %w", ref, err)
	}
	return Parse(raw)
}

func fetchHTTP(ctx context.Context, url, bearer string) ([]byte, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	ctx, cancel := context.WithTimeout(ctx, fetchTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("accept", "text/plain, application/toml, */*")
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}

	client := &http.Client{Timeout: fetchTimeout}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, maxIndexBytes))
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("index fetch returned HTTP %d", resp.StatusCode)
	}
	return body, nil
}
