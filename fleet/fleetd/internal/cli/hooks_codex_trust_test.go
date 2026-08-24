package cli

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeCfg(t *testing.T, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "config.toml")
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

// TestUntrustedCodexHookIsNotReportedAsWorking is the point of this whole file.
//
// Codex skips an untrusted hook silently: no stdout, no stderr, nothing from
// `codex doctor`, and the tool call proceeds. Reporting "installed" in that
// state tells an operator a guard exists while every call goes unguarded, which
// is the exact fail-open-that-reads-as-success the hook layer exists to prevent.
func TestUntrustedCodexHookIsNotReportedAsWorking(t *testing.T) {
	cfg := writeCfg(t, "[features]\nhooks = true\n\n[[hooks.PreToolUse]]\nmatcher = \".*\"\n")
	state, why := codexHookTrust(cfg)
	if state != codexTrustMissing {
		t.Fatalf("a config with hooks but no [hooks.state] should read as untrusted, got %v (%s)", state, why)
	}
	detail := codexTrustDetail(state, why)
	if !strings.Contains(detail, "INERT") {
		t.Errorf("the detail must say the hook does not run; got %q", detail)
	}
	// The remedy has to be named: the activation flow appears only in the
	// interactive TUI and never on the `codex exec` path, so an operator cannot
	// discover it from the failure.
	if !strings.Contains(detail, "codex") || !strings.Contains(detail, "Trust all") {
		t.Errorf("the detail must tell the operator how to activate the hook; got %q", detail)
	}
}

// TestTrustedRecordIsRecognised: once trust is granted, status must go quiet, or
// the warning becomes noise an operator learns to ignore.
func TestTrustedRecordIsRecognised(t *testing.T) {
	dir := t.TempDir()
	cfg := filepath.Join(dir, "config.toml")
	body := "[features]\nhooks = true\n\n[[hooks.PreToolUse]]\nmatcher = \".*\"\n\n" +
		"[hooks.state]\n[hooks.state.\"" + cfg + ":pre_tool_use:0:0\"]\n" +
		"trusted_hash = \"sha256:0000000000000000000000000000000000000000000000000000000000000000\"\n"
	if err := os.WriteFile(cfg, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	state, why := codexHookTrust(cfg)
	if state != codexTrustGranted {
		t.Fatalf("a matching [hooks.state] record was not recognised: %v (%s)", state, why)
	}
	if d := codexTrustDetail(state, why); d != "" {
		t.Errorf("a trusted hook should produce no warning, got %q", d)
	}
}

// TestTrustKeyComparesResolvedPaths. Codex records the REAL path, and on macOS
// anything under /tmp or /var is reachable by two spellings of the same file. A
// textual compare would report a genuinely trusted hook as inert, and an
// operator who has already granted trust would be told to do it again.
func TestTrustKeyComparesResolvedPaths(t *testing.T) {
	dir := t.TempDir()
	cfg := filepath.Join(dir, "config.toml")
	real, err := filepath.EvalSymlinks(cfg[:len(cfg)-len("/config.toml")])
	if err != nil {
		t.Skip("cannot resolve temp dir")
	}
	resolved := filepath.Join(real, "config.toml")
	if resolved == cfg {
		t.Skip("temp dir is not symlinked on this platform; nothing to prove")
	}
	body := "[hooks.state]\n[hooks.state.\"" + resolved + ":pre_tool_use:0:0\"]\n" +
		"trusted_hash = \"sha256:00\"\n"
	if err := os.WriteFile(cfg, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	if state, why := codexHookTrust(cfg); state != codexTrustGranted {
		t.Errorf("a record written under the resolved path was not matched against the symlinked one: %v (%s)", state, why)
	}
}

// TestRecordForADifferentConfigDoesNotCount: trust is per declaring file, so a
// record naming some other config must not be read as covering this one.
func TestRecordForADifferentConfigDoesNotCount(t *testing.T) {
	cfg := writeCfg(t, "[hooks.state]\n[hooks.state.\"/somewhere/else/config.toml:pre_tool_use:0:0\"]\ntrusted_hash = \"sha256:00\"\n")
	if state, _ := codexHookTrust(cfg); state != codexTrustMissing {
		t.Errorf("a record for a different config was treated as trust for this one: %v", state)
	}
}

// TestBypassIsNamedRatherThanTreatedAsTrust. bypass_hook_trust makes hooks run,
// but it is not the same as being trusted: it disables the check for EVERY hook
// including one a project supplies. An operator should see that distinction.
func TestBypassIsNamedRatherThanTreatedAsTrust(t *testing.T) {
	cfg := writeCfg(t, "bypass_hook_trust = true\n[features]\nhooks = true\n")
	state, why := codexHookTrust(cfg)
	if state != codexTrustBypassed {
		t.Fatalf("bypass_hook_trust was not detected: %v", state)
	}
	if !strings.Contains(codexTrustDetail(state, why), "EVERY hook") {
		t.Error("the bypass warning must say it applies to every hook, not just ours")
	}
}

// TestUnreadableConfigIsUnknownNotTrusted. Failing open here would restore the
// exact lie this file removes.
func TestUnreadableConfigIsUnknownNotTrusted(t *testing.T) {
	cfg := writeCfg(t, "this is not valid toml {{{\n")
	state, _ := codexHookTrust(cfg)
	if state == codexTrustGranted {
		t.Error("an unparseable config was reported as trusted")
	}
	if state != codexTrustUnknown {
		t.Errorf("expected unknown for an unparseable config, got %v", state)
	}
}
