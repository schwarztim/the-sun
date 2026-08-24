// Package hermesauth ports thesun's dual-mode ("Hermes-authoritative, legacy
// fallback") auth SEMANTIC to Go, for a fleet server's OUTBOUND API calls.
//
// Trust boundary (important): this package resolves credentials ONLY from the
// process environment. It never reads disk and never contacts Hermes directly.
// The supervisor (fleetd) is responsible for resolving hermes:// references at
// spawn time and injecting the resolved secret into the child process's
// environment; this package simply reads that environment. Keeping the network/
// disk boundary out of the server process is the whole point — the server holds
// a value, not a broker connection.
//
// Dual-mode gate: for a server identified as <SERVER> (e.g. "SHODAN"), the env
// flag <SERVER>_LEGACY_AUTH selects provenance:
//
//	unset / false  -> Hermes mode (default, authoritative): prefer the brokered
//	                  variable HERMES_<SERVER>_<KEY>, falling back to <SERVER>_<KEY>.
//	truthy         -> Legacy mode: use <SERVER>_<KEY> directly, ignoring any
//	                  brokered variable. Escape hatch for machines where Hermes
//	                  is not yet wired, so the fleet never hard-blocks on Hermes.
//
// Either way the value arrives via env (fleetd injected it); the gate documents,
// and lets an operator force, which provenance is authoritative. This mirrors the
// thesun generator's default without adding a broker dependency to the server.
package hermesauth

import (
	"os"
	"strings"
)

// Mode is the resolved auth provenance for a server.
type Mode string

const (
	// ModeHermes is the default: credentials are Hermes-brokered (fleetd resolves
	// hermes:// and injects the value; the brokered HERMES_<SERVER>_<KEY> wins).
	ModeHermes Mode = "hermes"
	// ModeLegacy is the fallback engaged by <SERVER>_LEGACY_AUTH: use the raw
	// <SERVER>_<KEY> env var directly.
	ModeLegacy Mode = "legacy"
)

// Resolver reads credentials for one logical server from the environment.
type Resolver struct {
	server string                      // upper-cased server id, e.g. "SHODAN"
	lookup func(string) (string, bool) // injectable for testing; defaults to os.LookupEnv
}

// New returns a Resolver for the given server name (case-insensitive).
func New(server string) *Resolver {
	return &Resolver{
		server: strings.ToUpper(strings.TrimSpace(server)),
		lookup: os.LookupEnv,
	}
}

// Mode reports whether legacy fallback is engaged for this server, i.e. whether
// <SERVER>_LEGACY_AUTH is set to a truthy value.
func (r *Resolver) Mode() Mode {
	if v, ok := r.lookup(r.server + "_LEGACY_AUTH"); ok && truthy(v) {
		return ModeLegacy
	}
	return ModeHermes
}

// Resolve returns the credential value for a logical key (e.g. "API_KEY") plus
// the provenance it came from. ok is false when no value is present in the
// environment — callers MUST handle that gracefully (never panic, never assume a
// value exists).
//
// The returned string is a SECRET: never log it, never echo it, and never place
// it in a tool response or error message.
func (r *Resolver) Resolve(key string) (value string, mode Mode, ok bool) {
	key = strings.ToUpper(strings.TrimSpace(key))
	base := r.server + "_" + key // e.g. SHODAN_API_KEY
	mode = r.Mode()

	if mode == ModeHermes {
		// Hermes-authoritative: the brokered variable wins; base var is fallback.
		if v, found := r.lookup("HERMES_" + base); found && v != "" {
			return v, ModeHermes, true
		}
	}
	if v, found := r.lookup(base); found && v != "" {
		return v, mode, true
	}
	return "", mode, false
}

// truthy reports whether v is an affirmative flag value.
func truthy(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}
