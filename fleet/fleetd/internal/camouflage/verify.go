package camouflage

import (
	"fmt"
	"strings"
)

// Verify checks that dir/camouflage.json exists, parses, and — critically —
// that its User-Agent OS token is consistent with the profile's own OS field
// (an inconsistent UA is worse than no camouflage at all: it's an
// active anti-fingerprint signal). It does NOT compare against the current
// runtime.GOOS — a profile generated on one machine and copied to another
// intentionally targets the machine it was generated for, and cross-host use
// is a deployment decision, not a defect. Intended for wiring into
// `thesun doctor` (deferred to cmd/thesun).
func Verify(dir string) (ok bool, detail string) {
	p, err := LoadConfig(dir)
	if err != nil {
		return false, fmt.Sprintf("camouflage profile unreadable at %s: %v", Path(dir), err)
	}
	if p.OS == "" {
		return false, fmt.Sprintf("camouflage profile at %s has no OS field", Path(dir))
	}
	if p.UserAgent == "" {
		return false, fmt.Sprintf("camouflage profile at %s has no user_agent", Path(dir))
	}
	wantToken := osToken(p.OS)
	if !strings.Contains(p.UserAgent, wantToken) {
		return false, fmt.Sprintf(
			"camouflage profile OS/user_agent mismatch at %s: OS=%q but user_agent %q does not contain the expected token %q",
			Path(dir), p.OS, p.UserAgent, wantToken,
		)
	}
	if p.Impersonate == "" || p.TLSProfile == "" {
		return false, fmt.Sprintf("camouflage profile at %s is missing impersonate/tls_profile", Path(dir))
	}
	return true, fmt.Sprintf(
		"camouflage profile OK at %s: os=%s browser=%s/%s impersonate=%s tls_profile=%s generated=%s",
		Path(dir), p.OS, p.Browser, p.BrowserVersion, p.Impersonate, p.TLSProfile, p.GeneratedAt,
	)
}
