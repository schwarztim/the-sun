package cli

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// sampleGatewayConfig mirrors the real file's shape closely enough to catch the
// mistakes that matter: comments that must survive, a backend with no `enabled:`
// key at all, and adjacent blocks whose flags must not be touched.
const sampleGatewayConfig = `# thesun gateway config.
#
# Do NOT delete the fleet block below: every field in it defaults to ON when
# absent, so removing it silently re-enables container ingestion.
fleet:
  enabled: false

backends:
  servicenow-go:
    transport: http
    url: "http://127.0.0.1:42018/mcp"
    # Disabled until a credential exists.
    enabled: false
    max_restarts: 3

  no-flag-server:
    transport: http
    url: "http://127.0.0.1:42019/mcp"

  atlassian-go:
    transport: http
    url: "http://127.0.0.1:42020/mcp"
    enabled: false
`

func writeSampleConfig(t *testing.T) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "config.fleet.yaml")
	if err := os.WriteFile(p, []byte(sampleGatewayConfig), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

// TestEnableFlipsOnlyTheNamedBackend is the test the block-boundary logic exists
// for. Scanning forward for the next `enabled:` without checking indentation
// would, for a backend that has no flag of its own, silently flip the NEXT
// backend's flag instead: a server the operator never asked for starts, and the
// one they did ask for stays off.
func TestEnableFlipsOnlyTheNamedBackend(t *testing.T) {
	p := writeSampleConfig(t)

	changed, err := setBackendEnabled(p, "servicenow-go", true)
	if err != nil {
		t.Fatalf("enable servicenow-go: %v", err)
	}
	if !changed {
		t.Fatal("reported no change when the flag was false")
	}

	got, _ := os.ReadFile(p)
	text := string(got)

	snBlock := blockFor(t, text, "servicenow-go")
	if !strings.Contains(snBlock, "enabled: true") {
		t.Errorf("servicenow-go was not enabled:\n%s", snBlock)
	}
	atBlock := blockFor(t, text, "atlassian-go")
	if !strings.Contains(atBlock, "enabled: false") {
		t.Errorf("atlassian-go's flag was changed; only the named backend may move:\n%s", atBlock)
	}
	// The fleet block's own flag is a different setting entirely and turning it
	// on would re-enable container ingestion.
	if !strings.Contains(text, "fleet:\n  enabled: false") {
		t.Error("the fleet block's enabled flag was modified")
	}
}

// TestEnablePreservesComments pins the reason this is a line edit rather than a
// YAML round-trip. The warning above the fleet block is the kind of comment a
// re-encode would drop, and losing it would eventually cost someone a day.
func TestEnablePreservesComments(t *testing.T) {
	p := writeSampleConfig(t)
	if _, err := setBackendEnabled(p, "atlassian-go", true); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(p)
	text := string(got)

	for _, comment := range []string{
		"# Do NOT delete the fleet block below",
		"# absent, so removing it silently re-enables container ingestion.",
		"# Disabled until a credential exists.",
	} {
		if !strings.Contains(text, comment) {
			t.Errorf("comment lost from the config: %q", comment)
		}
	}
	// Unrelated keys must survive too.
	if !strings.Contains(text, "max_restarts: 3") {
		t.Error("unrelated key max_restarts was lost")
	}
}

// TestEnableIsIdempotent proves a second run is a no-op rather than a rewrite,
// so re-running onboarding never churns the file.
func TestEnableIsIdempotent(t *testing.T) {
	p := writeSampleConfig(t)
	if _, err := setBackendEnabled(p, "servicenow-go", true); err != nil {
		t.Fatal(err)
	}
	first, _ := os.ReadFile(p)

	changed, err := setBackendEnabled(p, "servicenow-go", true)
	if err != nil {
		t.Fatal(err)
	}
	if changed {
		t.Error("reported a change when the backend was already enabled")
	}
	second, _ := os.ReadFile(p)
	if string(first) != string(second) {
		t.Error("the file changed on a no-op enable")
	}
}

// TestEnableReportsAMissingFlagRatherThanGuessing: a backend with no `enabled:`
// key must produce an error the operator can act on. Silently doing nothing, or
// worse editing a neighbour, is how "I enabled it and nothing happened" starts.
func TestEnableReportsAMissingFlagRatherThanGuessing(t *testing.T) {
	p := writeSampleConfig(t)
	before, _ := os.ReadFile(p)

	_, err := setBackendEnabled(p, "no-flag-server", true)
	if err == nil {
		t.Fatal("expected an error for a backend with no enabled: key")
	}
	if !strings.Contains(err.Error(), "no `enabled:` key") {
		t.Errorf("error should name the cause: %v", err)
	}
	after, _ := os.ReadFile(p)
	if string(before) != string(after) {
		t.Error("the config was modified despite the failure")
	}
}

// TestEnableRejectsAnUnknownBackend guards against a typo enabling nothing while
// reporting success.
func TestEnableRejectsAnUnknownBackend(t *testing.T) {
	p := writeSampleConfig(t)
	if _, err := setBackendEnabled(p, "not-a-real-backend", true); err == nil {
		t.Fatal("expected an error for an unknown backend")
	}
}

// TestEnableIgnoresNameMentionsOutsideTheKey proves the key match is anchored.
// The backend name also appears inside URLs and comments, and matching it
// loosely would edit whatever happened to follow one of those.
func TestEnableIgnoresNameMentionsOutsideTheKey(t *testing.T) {
	p := filepath.Join(t.TempDir(), "config.fleet.yaml")
	cfg := `backends:
  # servicenow-go is documented here but declared below.
  other-server:
    url: "http://127.0.0.1:1/servicenow-go/mcp"
    enabled: false

  servicenow-go:
    url: "http://127.0.0.1:2/mcp"
    enabled: false
`
	if err := os.WriteFile(p, []byte(cfg), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := setBackendEnabled(p, "servicenow-go", true); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(p)
	if !strings.Contains(blockFor(t, string(got), "other-server"), "enabled: false") {
		t.Error("a comment/URL mention was treated as the backend declaration")
	}
	if !strings.Contains(blockFor(t, string(got), "servicenow-go"), "enabled: true") {
		t.Error("the real declaration was not enabled")
	}
}

// blockFor returns the lines belonging to one backend, for assertions that must
// not accidentally read a neighbour's flag.
func blockFor(t *testing.T, text, backend string) string {
	t.Helper()
	lines := strings.Split(text, "\n")
	start := -1
	var indent string
	for i, ln := range lines {
		trimmed := strings.TrimSpace(ln)
		if trimmed == backend+":" && !strings.HasPrefix(trimmed, "#") {
			start = i
			indent = ln[:len(ln)-len(strings.TrimLeft(ln, " \t"))]
			break
		}
	}
	if start < 0 {
		t.Fatalf("backend %q not found in config", backend)
	}
	var out []string
	for i := start; i < len(lines); i++ {
		if i > start && strings.TrimSpace(lines[i]) != "" {
			lead := lines[i][:len(lines[i])-len(strings.TrimLeft(lines[i], " \t"))]
			if len(lead) <= len(indent) {
				break
			}
		}
		out = append(out, lines[i])
	}
	return strings.Join(out, "\n")
}

// TestBundledBackendsAreDescribedForSomeoneWhoDoesNotKnowThem is a content check
// on the onboarding copy. A catalogue entry that just repeats the server's name
// gives the reader nothing to decide on, which defeats the point of asking.
func TestBundledBackendsAreDescribedForSomeoneWhoDoesNotKnowThem(t *testing.T) {
	if len(bundledBackends) == 0 {
		t.Fatal("no bundled backends to offer")
	}
	for _, b := range bundledBackends {
		if b.Description == "" {
			t.Errorf("%s has no description", b.Name)
		}
		if b.Auth == "" {
			t.Errorf("%s does not say how it is authenticated", b.Name)
		}
		if strings.Contains(strings.ToLower(b.Description), strings.ToLower(b.Name)) {
			t.Errorf("%s's description just restates its name: %q", b.Name, b.Description)
		}
		if b.hermesService() == "" {
			t.Errorf("%s resolves to an empty Hermes service name", b.Name)
		}
	}
}

// TestEveryDependencyCanRenderAnInstallHint: a missing dependency whose message
// is "see its own installation instructions" leaves the reader stuck, which is
// exactly the moment onboarding is supposed to help.
func TestEveryDependencyCanRenderAnInstallHint(t *testing.T) {
	all := append(append([]toolDependency{}, runtimeDependencies...), optionalDependencies...)
	for _, d := range all {
		if d.Why == "" {
			t.Errorf("%s does not explain why it is needed", d.Name)
		}
		hint := installHint(d)
		if hint == "" || strings.HasPrefix(hint, "see ") {
			t.Errorf("%s has no actionable install command on %s: %q", d.Name, "this platform", hint)
		}
	}
}

// TestOptionalDependenciesNameWhoNeedsThem: an optional dependency is only
// justified by a server that fails without it. Without that attribution the
// prompt is "install this thing", which is the "just in case" install the
// catalogue exists to avoid.
func TestOptionalDependenciesNameWhoNeedsThem(t *testing.T) {
	for _, d := range optionalDependencies {
		if d.ForBackend == "" {
			t.Errorf("%s does not name the backend that needs it", d.Name)
		}
		if d.Present == nil && d.Probe == "" {
			t.Errorf("%s has no way to detect whether it is present", d.Name)
		}
	}
}

// TestChromiumHeadlessShellIsNotAChromium is the subtle half of the patchright
// check. The Playwright browser cache carries "chromium_headless_shell-<rev>"
// alongside "chromium-<rev>", and the shell cannot render the visible sign-in
// window an SSO flow needs. A prefix match on "chromium" alone would report a
// shell-only cache as ready, and the failure would surface as a broken login
// rather than a missing browser.
func TestChromiumHeadlessShellIsNotAChromium(t *testing.T) {
	cache := t.TempDir()
	t.Setenv("PLAYWRIGHT_BROWSERS_PATH", cache)

	if err := os.MkdirAll(filepath.Join(cache, "chromium_headless_shell-1234"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(cache, "firefox-1509"), 0o755); err != nil {
		t.Fatal(err)
	}
	if browserCacheHasChromium() {
		t.Error("a headless-shell-only cache was reported as having chromium; SSO needs a real browser window")
	}

	if err := os.MkdirAll(filepath.Join(cache, "chromium-1234"), 0o755); err != nil {
		t.Fatal(err)
	}
	if !browserCacheHasChromium() {
		t.Error("a real chromium build was not detected")
	}
}

// TestMissingBrowserCacheIsNotReadyguards the empty-machine case: no cache
// directory at all must read as "not installed", never as an error that
// accidentally passes.
func TestMissingBrowserCacheIsNotReady(t *testing.T) {
	t.Setenv("PLAYWRIGHT_BROWSERS_PATH", filepath.Join(t.TempDir(), "does-not-exist"))
	if browserCacheHasChromium() {
		t.Error("a nonexistent browser cache was reported as ready")
	}
	if patchrightReady() {
		t.Error("patchright cannot be ready when its browser is absent")
	}
}
