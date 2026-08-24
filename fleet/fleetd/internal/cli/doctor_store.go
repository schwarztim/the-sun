package cli

// doctor_store.go adds the MCP Store index reachability check to `thesun doctor`.
// It turns an otherwise indirect failure (a bare "HTTP 401" surfacing only when
// someone runs `thesun search`) into a named, actionable diagnostic. It reuses
// the exact store-client resolution from internal/registry, so it can never drift
// from what the CLI actually fetches.

import (
	"context"
	"fmt"
	"strings"
	"time"

	"mcp-fleet/fleetd/internal/registry"
)

// StoreIndexDoctorCheck probes the configured registry index and reports a named
// status. It is ADVISORY: it never emits FAIL, so a stale PAT or a transient
// network blip cannot block `thesun install` (which keys off FAIL). A clean fetch
// is PASS; every problem is a WARN carrying the specific, actionable reason.
func StoreIndexDoctorCheck(add func(name, status, detail string)) {
	ref := registry.IndexRef("")

	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()

	bearer, berr := registry.BearerForURL(ctx, ref)
	if berr != nil {
		add("store index", statusWarn,
			"Stash credential unresolved for "+ref+" ("+berr.Error()+"); enroll it: thesun secrets set stash pat")
		return
	}
	authed := registry.StashAuthApplies(ref, registry.StashHost())

	idx, _, err := registry.FetchIndexAuth(ctx, ref, bearer)
	switch {
	case err == nil:
		n := 0
		if idx != nil {
			n = len(idx.Entries)
		}
		add("store index", statusPass, fmt.Sprintf("reachable (%d entries) at %s", n, ref))
	case strings.Contains(err.Error(), "HTTP 401"), strings.Contains(err.Error(), "HTTP 403"):
		hint := ""
		if authed {
			hint = "; Stash PAT missing or stale in Hermes, enroll it: thesun secrets set stash pat"
		}
		add("store index", statusWarn, "auth failed (HTTP 401/403) for "+ref+hint)
	case strings.Contains(err.Error(), "HTTP 404"):
		add("store index", statusWarn,
			"not found (HTTP 404) at "+ref+"; check the index URL/branch in THESUN_HOME/store.toml")
	default:
		add("store index", statusWarn, "unreachable ("+err.Error()+", VPN/network?) at "+ref)
	}
}
