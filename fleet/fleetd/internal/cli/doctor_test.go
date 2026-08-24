package cli

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"mcp-fleet/fleetd/internal/paths"
)

func TestWorse(t *testing.T) {
	cases := []struct{ a, b, want string }{
		{statusPass, statusPass, statusPass},
		{statusPass, statusWarn, statusWarn},
		{statusWarn, statusPass, statusWarn},
		{statusWarn, statusFail, statusFail},
		{statusFail, statusWarn, statusFail},
		{statusPass, statusFail, statusFail},
	}
	for _, c := range cases {
		if got := worse(c.a, c.b); got != c.want {
			t.Errorf("worse(%q,%q) = %q, want %q", c.a, c.b, got, c.want)
		}
	}
}

func TestFirstLine(t *testing.T) {
	if got := firstLine("go version go1.26\nextra"); got != "go version go1.26" {
		t.Errorf("firstLine = %q", got)
	}
	if got := firstLine("single"); got != "single" {
		t.Errorf("firstLine single = %q", got)
	}
}

// collect runs a check func and returns its emitted results.
func collect(fn func(add func(name, status, detail string))) []checkResult {
	var out []checkResult
	fn(func(name, status, detail string) {
		out = append(out, checkResult{name, status, detail})
	})
	return out
}

func findCheck(rs []checkResult, name string) (checkResult, bool) {
	for _, r := range rs {
		if r.Name == name {
			return r, true
		}
	}
	return checkResult{}, false
}

// A THESUN_HOME with no config: writable home PASS, config WARN, nil manifest.
func TestCheckHomeAndConfig_NoConfig(t *testing.T) {
	home := filepath.Join(t.TempDir(), "thesun")
	t.Setenv(paths.EnvHome, home)
	// Isolate from any FLEETD_* overrides that could redirect the manifest path.
	t.Setenv("FLEETD_ROOT", "")
	t.Setenv("FLEETD_MANIFEST", "")
	if err := os.MkdirAll(home, 0o700); err != nil {
		t.Fatal(err)
	}

	rs := collect(func(add func(name, status, detail string)) { _ = checkHomeAndConfig(add) })

	if r, ok := findCheck(rs, "home: THESUN_HOME"); !ok || r.Status != statusPass {
		t.Errorf("home check = %+v (want PASS)", r)
	}
	if r, ok := findCheck(rs, "config: thesun.toml"); !ok || r.Status != statusWarn {
		t.Errorf("config check = %+v (want WARN)", r)
	}
}

// A valid config parses: config PASS.
func TestCheckHomeAndConfig_ValidConfig(t *testing.T) {
	home := filepath.Join(t.TempDir(), "thesun")
	t.Setenv(paths.EnvHome, home)
	t.Setenv("FLEETD_ROOT", "")
	t.Setenv("FLEETD_MANIFEST", "")
	if err := os.MkdirAll(home, 0o700); err != nil {
		t.Fatal(err)
	}
	cfg := filepath.Join(home, "thesun.toml")
	valid := `
[[server]]
name = "shodan"
bin  = "shodan-server"
port = 42101
`
	if err := os.WriteFile(cfg, []byte(valid), 0o600); err != nil {
		t.Fatal(err)
	}
	rs := collect(func(add func(name, status, detail string)) { _ = checkHomeAndConfig(add) })
	if r, _ := findCheck(rs, "config: thesun.toml"); r.Status != statusPass {
		t.Errorf("config check = %+v (want PASS)", r)
	}
}

// An invalid config fails closed: config FAIL.
func TestCheckHomeAndConfig_InvalidConfig(t *testing.T) {
	home := filepath.Join(t.TempDir(), "thesun")
	t.Setenv(paths.EnvHome, home)
	t.Setenv("FLEETD_ROOT", "")
	t.Setenv("FLEETD_MANIFEST", "")
	if err := os.MkdirAll(home, 0o700); err != nil {
		t.Fatal(err)
	}
	cfg := filepath.Join(home, "thesun.toml")
	// Out-of-window MCP port → manifest.validate() fails closed.
	bad := `
[[server]]
name = "shodan"
bin  = "shodan-server"
port = 100
`
	if err := os.WriteFile(cfg, []byte(bad), 0o600); err != nil {
		t.Fatal(err)
	}
	rs := collect(func(add func(name, status, detail string)) { _ = checkHomeAndConfig(add) })
	if r, _ := findCheck(rs, "config: thesun.toml"); r.Status != statusFail {
		t.Errorf("config check = %+v (want FAIL)", r)
	}
}

func TestProbeWritable(t *testing.T) {
	dir := t.TempDir()
	if err := probeWritable(dir); err != nil {
		t.Errorf("probeWritable(%q) = %v, want nil", dir, err)
	}
	if err := probeWritable(filepath.Join(dir, "does-not-exist")); err == nil {
		t.Errorf("probeWritable on missing dir: want error, got nil")
	}
}

// TestLingerEnabled proves the pure parse logic behind the Linux headless-
// autostart drift check without depending on a real systemd host.
func TestLingerEnabled(t *testing.T) {
	cases := []struct {
		in   string
		want bool
	}{
		{"Linger=yes\n", true},
		{"Linger=yes", true},
		{"Linger=no\n", false},
		{"Linger=no", false},
		{"", false},
		{"garbage", false},
	}
	for _, c := range cases {
		if got := lingerEnabled(c.in); got != c.want {
			t.Errorf("lingerEnabled(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}

// TestCheckServiceRegistration_AlwaysReportsRegistration is a platform-neutral
// smoke test: whatever this host's actual service-registration state is, the
// check must always emit a "service: registered" row (the drift detector for
// the reboot/login auto-start guarantee), and on darwin/linux/windows it must
// pair a registered service with the matching platform-specific note.
func TestCheckServiceRegistration_AlwaysReportsRegistration(t *testing.T) {
	rs := collect(func(add func(name, status, detail string)) { checkServiceRegistration(add) })

	reg, ok := findCheck(rs, "service: registered")
	if !ok {
		t.Fatal("expected a 'service: registered' check to always be emitted")
	}
	if reg.Status != statusPass && reg.Status != statusWarn && reg.Status != statusFail {
		t.Fatalf("service: registered status = %q, want PASS/WARN/FAIL", reg.Status)
	}
	if reg.Status != statusPass {
		return // not registered on this test host — no platform-specific row expected
	}

	var platformCheck string
	switch runtime.GOOS {
	case "linux":
		platformCheck = "service: linux linger"
	case "windows":
		platformCheck = "service: windows persistence"
	case "darwin":
		platformCheck = "service: macOS persistence"
	default:
		return
	}
	if _, ok := findCheck(rs, platformCheck); !ok {
		t.Errorf("registered service on GOOS=%s: expected a %q check", runtime.GOOS, platformCheck)
	}
}

func TestReadPublishedServers(t *testing.T) {
	dir := t.TempDir()
	pub := filepath.Join(dir, "gateway-config.json")
	t.Setenv("FLEETD_PUBLISH_PATH", pub)
	body := `{"mcpServers":{"shodan":{"url":"http://127.0.0.1:42101/mcp"},"github":{"url":"http://127.0.0.1:42102/mcp"}}}`
	if err := os.WriteFile(pub, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := readPublishedServers()
	if err != nil {
		t.Fatalf("readPublishedServers: %v", err)
	}
	if !got["shodan"] || !got["github"] || len(got) != 2 {
		t.Errorf("published set = %v", got)
	}
}
