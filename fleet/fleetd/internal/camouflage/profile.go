// Package camouflage detects the operator's own machine/browser identity and
// turns it into a fingerprint profile that thesun-generated MCP servers use
// to shape their outbound HTTP traffic. The goal: a generated server's API
// calls should be wire-indistinguishable from the operator's own browser,
// not a bare Go/Python HTTP client.
//
// Two runtime consumers read the persisted profile:
//   - Python/FastMCP servers use the `impersonate` field with curl_cffi.
//   - Go servers use the `tls_profile` field with uTLS (github.com/
//     refraction-networking/utls) for TLS ClientHello parroting.
//
// Both also send `user_agent` verbatim. Detection is best-effort: it never
// fails hard, and always falls back to a profile whose UA OS token matches
// the host OS even when the specific browser/version can't be determined.
package camouflage

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Profile is the on-disk fingerprint contract shared by fleetd (writer) and
// every generated MCP server (reader, via its own minimal JSON decode — no
// generated server imports this package directly, since each is an
// independently compilable module).
type Profile struct {
	// OS is one of "macos", "linux", "windows" — always set, never empty.
	OS string `json:"os"`
	// Browser is "chrome", "edge", "safari", or "unknown" when no supported
	// browser could be detected.
	Browser string `json:"browser"`
	// BrowserVersion is the detected version string (e.g. "131.0.6778.109"),
	// empty when undetectable.
	BrowserVersion string `json:"browser_version,omitempty"`
	// Impersonate is a curl_cffi impersonate target (e.g. "chrome131") for
	// the Python/curl_cffi runtime path.
	Impersonate string `json:"impersonate"`
	// UserAgent is a real UA string whose OS token always matches Host OS,
	// and whose browser/version token matches Browser/BrowserVersion when
	// those were detected.
	UserAgent string `json:"user_agent"`
	// TLSProfile is a uTLS ClientHelloID name (e.g. "HelloChrome_131") for
	// the Go/uTLS runtime path.
	TLSProfile string `json:"tls_profile"`
	// GeneratedAt is an RFC3339 UTC timestamp set by Detect(). Informational
	// only — used by `thesun doctor` to show profile freshness.
	GeneratedAt string `json:"generated_at,omitempty"`
}

// Fallback identity used whenever the detected (or undetected) browser has no
// better mapping. Chosen to match the already wire-verified Python default
// (see generator/src/templates/python/http_client.py — Stage 0, 2026-07-02)
// so the Python and Go paths agree on the safe default.
const (
	defaultImpersonate = "chrome131"
	defaultTLSProfile  = "HelloChrome_131"
)

// chromeImpersonateAnchors are the curl_cffi 0.15.0 impersonate targets for
// Chrome, ascending. [VERIFIED: empirical — curl_cffi.requests.impersonate,
// installed 0.15.0, 2026-07-06]
var chromeImpersonateAnchors = []int{99, 100, 101, 104, 107, 110, 116, 119, 120, 123, 124, 131, 136, 142, 145, 146}

// chromeTLSAnchors are the utls v1.8.2 HelloChrome_<N> ClientHelloIDs whose
// name is EXACTLY "HelloChrome_<N>" with no suffix, ascending. utls v1.8.2
// also ships 106, 112, 114, and 115 variants, but those constants carry a
// disambiguating suffix (HelloChrome_106_Shuffle, HelloChrome_112_PSK_Shuf,
// HelloChrome_114_Padding_PSK_Shuf, HelloChrome_115_PQ) — deliberately
// excluded here so `fmt.Sprintf("HelloChrome_%d", n)` below always produces
// a string that is a real, exact utls.ClientHelloID constant name; the Go
// server template looks this string up verbatim (see go-generator.ts). Do
// not add an anchor here without adding the matching entry in
// go-generator.ts's camouflageTLSProfiles map. [VERIFIED: empirical —
// u_common.go, refraction-networking/utls v1.8.2, 2026-07-06]
var chromeTLSAnchors = []int{58, 62, 70, 72, 83, 87, 96, 100, 102, 120, 131, 133}

// nearestFloor returns the largest anchor <= major, or the smallest anchor if
// major is below every anchor. major<=0 (undetected) returns the newest
// (last) anchor per the "default to a recent target when unknown" rule.
func nearestFloor(anchors []int, major int) int {
	if major <= 0 {
		return anchors[len(anchors)-1]
	}
	best := anchors[0]
	for _, a := range anchors {
		if a <= major {
			best = a
			continue
		}
		break
	}
	return best
}

// safariImpersonateFor maps a detected Safari major version to the nearest
// curl_cffi safari impersonate target. curl_cffi 0.15.0's safari anchors are
// sparse (15.3, 15.5, 17.0, 18.0, 18.4, 26.0/26.01) rather than a dense
// per-major sequence, so this is a small explicit ladder instead of
// nearestFloor. [VERIFIED: empirical — curl_cffi.requests.impersonate,
// installed 0.15.0, 2026-07-06]
func safariImpersonateFor(major int) string {
	switch {
	case major <= 0:
		return "safari180" // recent, stable default when version is unknown
	case major >= 26:
		return "safari2601"
	case major >= 18:
		return "safari180"
	case major >= 16: // covers 16.x and 17.x — no dedicated 16.x anchor exists upstream
		return "safari170"
	case major >= 15:
		return "safari155"
	default:
		return "safari155"
	}
}

// majorVersion extracts the leading integer component of a dotted version
// string ("131.0.6778.109" -> 131). Returns 0 (undetected) on any parse
// failure — callers treat 0 as "unknown, use the recent default".
func majorVersion(version string) int {
	version = strings.TrimSpace(version)
	if version == "" {
		return 0
	}
	head, _, _ := strings.Cut(version, ".")
	n, err := strconv.Atoi(head)
	if err != nil {
		return 0
	}
	return n
}

// mapBrowser resolves (impersonate, tlsProfile) for a detected browser +
// version. Unknown/unsupported browsers fall back to the Chrome default —
// this is the "OS-match at minimum" guarantee: even when the browser itself
// can't be impersonated, the TLS/HTTP layer still presents a normal,
// consistent modern-browser fingerprint rather than a bare Go/Python client.
func mapBrowser(browser, version string) (impersonate, tlsProfile string) {
	major := majorVersion(version)
	switch browser {
	case "chrome":
		return fmt.Sprintf("chrome%d", nearestFloor(chromeImpersonateAnchors, major)),
			fmt.Sprintf("HelloChrome_%d", nearestFloor(chromeTLSAnchors, major))
	case "edge":
		// curl_cffi and utls both ship sparse Edge support (edge99/101;
		// HelloEdge_85/106) — always use the newest available rather than
		// trying to floor-map a version that has no anchor to land on.
		return "edge101", "HelloEdge_106"
	case "safari":
		// utls v1.8.2 ships exactly one Safari ClientHello parrot
		// (HelloSafari_16_0); used regardless of the detected Safari
		// version until upstream adds more.
		return safariImpersonateFor(major), "HelloSafari_16_0"
	default:
		return defaultImpersonate, defaultTLSProfile
	}
}

// osToken returns the browser User-Agent platform token for osName. This is
// the MINIMUM guarantee of the whole package: whatever else detection fails
// to determine, the UA's OS token always matches the host the profile was
// built for.
func osToken(osName string) string {
	switch osName {
	case "macos":
		return "Macintosh; Intel Mac OS X 10_15_7"
	case "windows":
		return "Windows NT 10.0; Win64; x64"
	default: // "linux" and any other/unrecognized value
		return "X11; Linux x86_64"
	}
}

// buildUserAgent renders a real, plausible UA string for (osName, browser,
// version) with the OS token always matching osName.
func buildUserAgent(osName, browser, version string) string {
	tok := osToken(osName)
	switch browser {
	case "edge":
		v := version
		if v == "" {
			v = "120.0.0.0"
		}
		return fmt.Sprintf(
			"Mozilla/5.0 (%s) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Safari/537.36 Edg/%s",
			tok, v, v,
		)
	case "safari":
		v := version
		if v == "" {
			v = "17.0"
		}
		return fmt.Sprintf(
			"Mozilla/5.0 (%s) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/%s Safari/605.1.15",
			tok, v,
		)
	default: // "chrome" and "unknown" (unknown still presents as a modern Chrome)
		v := version
		if v == "" {
			v = "131.0.0.0"
		}
		return fmt.Sprintf(
			"Mozilla/5.0 (%s) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Safari/537.36",
			tok, v,
		)
	}
}

// buildProfile assembles a Profile for (osName, browser, version). browser
// may be "" (nothing detected) — normalized to "unknown". This function is
// pure and OS-independent (osName is a parameter, not runtime.GOOS), which is
// what makes it unit-testable for all three target platforms from any host.
func buildProfile(osName, browser, version string) Profile {
	if browser == "" {
		browser = "unknown"
	}
	impersonate, tlsProfile := mapBrowser(browser, version)
	return Profile{
		OS:             osName,
		Browser:        browser,
		BrowserVersion: version,
		Impersonate:    impersonate,
		UserAgent:      buildUserAgent(osName, browser, version),
		TLSProfile:     tlsProfile,
		GeneratedAt:    time.Now().UTC().Format(time.RFC3339),
	}
}
