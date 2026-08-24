package main

// trust.go implements `thesun trust <backend> [--ttl 30d]` — a backend-wide
// Tier-B standing grant (identity × backend × "*") created via the gateway's
// loopback-only /trust endpoint (Phase 2, SECURITY-ROADMAP §2.3 item 2).
//
// Deliberately CLI-only and explicit: the parked JSON the model sees never
// mentions this command (the model's suggested remedy stays per-tool
// `thesun approve`). Only a human at the console reaches this path, and the
// command warns loudly that the grant covers ALL current AND FUTURE tools of
// the backend before reporting success.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
)

// parseTTL converts a human TTL spec into whole minutes. Accepted forms:
// plain integer = minutes ("90"), or an integer with a single unit suffix:
// "45m" (minutes), "12h" (hours), "30d" (days). Returns an error for zero,
// negative, or unparseable values.
func parseTTL(s string) (int, error) {
	s = strings.TrimSpace(strings.ToLower(s))
	if s == "" {
		return 0, fmt.Errorf("empty ttl")
	}
	mult := 1
	switch s[len(s)-1] {
	case 'm':
		mult, s = 1, s[:len(s)-1]
	case 'h':
		mult, s = 60, s[:len(s)-1]
	case 'd':
		mult, s = 24*60, s[:len(s)-1]
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return 0, fmt.Errorf("invalid ttl %q (use minutes, or a number with m/h/d suffix, e.g. 30d)", s)
	}
	if n <= 0 {
		return 0, fmt.Errorf("ttl must be positive, got %d", n)
	}
	return n * mult, nil
}

// parseTrustArgs parses `trust <backend> [--ttl 30d | --ttl=30d]`.
// Split out from trustCmd so the flag grammar is unit-testable without HTTP.
func parseTrustArgs(args []string) (backend string, ttlMinutes int, err error) {
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--ttl":
			if i+1 >= len(args) {
				return "", 0, fmt.Errorf("--ttl requires a value (e.g. --ttl 30d)")
			}
			i++
			ttlMinutes, err = parseTTL(args[i])
			if err != nil {
				return "", 0, err
			}
		case strings.HasPrefix(a, "--ttl="):
			ttlMinutes, err = parseTTL(strings.TrimPrefix(a, "--ttl="))
			if err != nil {
				return "", 0, err
			}
		case strings.HasPrefix(a, "--"):
			return "", 0, fmt.Errorf("unknown flag %q", a)
		case backend == "":
			backend = a
		default:
			return "", 0, fmt.Errorf("unexpected argument %q", a)
		}
	}
	if backend == "" {
		return "", 0, fmt.Errorf("missing <backend>")
	}
	return backend, ttlMinutes, nil
}

func trustCmd(args []string) int {
	if len(args) > 0 && (args[0] == "-h" || args[0] == "--help") {
		trustUsage()
		return 0
	}
	backend, ttlMinutes, err := parseTrustArgs(args)
	if err != nil {
		fmt.Fprintf(os.Stderr, "thesun trust: %v\n", err)
		trustUsage()
		return 2
	}

	base := gatewayURL()
	body := map[string]any{"backend": backend}
	if ttlMinutes > 0 {
		body["ttlMinutes"] = ttlMinutes
	}
	code, respBody, err := httpJSON(http.MethodPost, base+"/trust", body)
	if err != nil {
		fmt.Fprintf(os.Stderr, "thesun: gateway not reachable at %s (%v)\n", base, err)
		return 1
	}
	if code == http.StatusNotFound {
		var nf struct {
			Error         string   `json:"error"`
			KnownBackends []string `json:"knownBackends"`
		}
		if json.Unmarshal(respBody, &nf) == nil && nf.Error == "unknown_backend" {
			fmt.Fprintf(os.Stderr, "thesun: unknown backend %q — known backends: %s\n", backend, strings.Join(nf.KnownBackends, ", "))
			return 1
		}
		fmt.Fprintf(os.Stderr, "thesun: trust failed (%d): %s\n", code, string(respBody))
		return 1
	}
	if code >= 300 {
		fmt.Fprintf(os.Stderr, "thesun: trust failed (%d): %s\n", code, string(respBody))
		return 1
	}

	var out struct {
		Status  string        `json:"status"`
		Grant   standingGrant `json:"grant"`
		Warning string        `json:"warning"`
	}
	if err := json.Unmarshal(respBody, &out); err != nil {
		fmt.Println(string(respBody))
		return 0
	}
	expires := out.Grant.ExpiresAt
	if expires == "" {
		expires = "never (until revoked)"
	}
	fmt.Printf("trusted backend %q — standing grant %s (expires: %s)\n", backend, out.Grant.ID, expires)
	fmt.Fprintf(os.Stderr, "\n⚠ WARNING: this grant authorizes EVERY Tier-B tool of backend %q — including\n", backend)
	fmt.Fprintf(os.Stderr, "  tools the backend adds in the FUTURE. No further human approval will be asked\n")
	fmt.Fprintf(os.Stderr, "  for this identity on this backend. Revoke with: thesun grants rm %s\n", out.Grant.ID)
	if out.Warning != "" {
		fmt.Fprintf(os.Stderr, "  gateway: %s\n", out.Warning)
	}
	return 0
}

func trustUsage() {
	fmt.Fprint(os.Stderr, `thesun trust — backend-wide Tier-B standing grant (identity × backend × ALL tools)

  thesun trust <backend>            trust every Tier-B tool of <backend>, forever (until revoked)
  thesun trust <backend> --ttl 30d  same, expiring after 30 days (m/h/d suffix, or plain minutes)

⚠ This is the widest grant thesun can create: it covers all CURRENT and all
FUTURE tools of the backend for this install identity — the gateway will stop
parking that backend's Tier-B calls entirely. Prefer per-tool
'thesun approve <id> --always' unless you genuinely trust the whole backend.
Review with 'thesun grants', revoke with 'thesun grants rm <id>'.
Talks to the gateway's loopback-only /trust endpoint; no MCP tool can reach it.
`)
}
