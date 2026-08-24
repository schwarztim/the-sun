package main

// init_test.go proves the two `thesun init` behaviors added on top of the
// existing scaffold-thesun.toml flow:
//
//  1. mergeShippedDefaults folds fleet/default-manifest.toml's genuinely-easy-
//     auth servers (Atlassian, ServiceNow, M365) into the generated thesun.toml,
//     with placeholder paths rewritten onto this bundle's real root, and
//     GitHub (deliberately absent from that file) never appears.
//  2. Both initHome and mergeShippedDefaults are idempotent: running either
//     twice never duplicates a server or rewrites an already-correct file.
//
// Every test here uses a throwaway THESUN_HOME (t.TempDir()) and a throwaway
// THESUN_BUNDLE seeded with a copy of the real fleet/default-manifest.toml —
// never the operator's real ~/.mcp-fleet or repo checkout paths. No live
// process is started; this only exercises the manifest file on disk.

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"mcp-fleet/fleetd/internal/manifest"
	"mcp-fleet/fleetd/internal/paths"
)

// realDefaultManifestPath locates this repo's fleet/default-manifest.toml
// relative to this test file's own path (not the working directory), so it
// resolves correctly regardless of how `go test` is invoked.
func realDefaultManifestPath(t *testing.T) string {
	t.Helper()
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed to resolve this test file's path")
	}
	// this file: fleet/fleetd/cmd/thesun/init_test.go -> fleet/default-manifest.toml
	p := filepath.Join(filepath.Dir(thisFile), "..", "..", "..", "default-manifest.toml")
	if _, err := os.Stat(p); err != nil {
		t.Fatalf("real fleet/default-manifest.toml not found at %s: %v", p, err)
	}
	return p
}

// seedBundle creates a throwaway bundle dir containing a copy of the real
// fleet/default-manifest.toml at fleet/default-manifest.toml (mirroring the
// real bundle layout bundleRoot() expects), and points THESUN_BUNDLE /
// THESUN_HOME at fresh temp dirs for the duration of the calling test.
func seedBundle(t *testing.T) (bundle, home string) {
	t.Helper()
	bundle = t.TempDir()
	home = t.TempDir()

	real := realDefaultManifestPath(t)
	raw, err := os.ReadFile(real)
	if err != nil {
		t.Fatalf("read real default-manifest.toml: %v", err)
	}
	dst := filepath.Join(bundle, "fleet", "default-manifest.toml")
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(dst, raw, 0o644); err != nil {
		t.Fatalf("write seeded default-manifest.toml: %v", err)
	}

	t.Setenv(paths.EnvBundle, bundle)
	t.Setenv(paths.EnvHome, home)
	// FLEETD_ROOT/FLEETD_MANIFEST are legacy overrides checked before
	// THESUN_HOME by internal/fleet.ManifestPath — make sure a real
	// deployment's env (if this test happens to run on a machine with one set)
	// can never leak in and redirect us at a real config file.
	t.Setenv("FLEETD_ROOT", "")
	t.Setenv("FLEETD_MANIFEST", "")

	return bundle, home
}

// TestInitHome_MergesShippedDefaults proves `thesun init` (via initHome) ends
// up with hermes + gateway (the pre-existing system entries) PLUS the three
// shipped defaults, with GitHub absent, and with placeholder paths rewritten
// onto the real (temp) bundle root.
func TestInitHome_MergesShippedDefaults(t *testing.T) {
	bundle, _ := seedBundle(t)

	if rc := initHome(nil); rc != 0 {
		t.Fatalf("initHome() = %d, want 0", rc)
	}

	cfg := paths.Config()
	m, err := manifest.Load(cfg)
	if err != nil {
		t.Fatalf("load generated thesun.toml: %v", err)
	}

	names := map[string]bool{}
	for _, s := range m.Servers {
		names[s.Name] = true
	}
	for _, want := range []string{"hermes", "gateway", "ms365-mcp", "atlassian-mcp", "servicenow-mcp"} {
		if !names[want] {
			t.Errorf("generated thesun.toml missing server %q; got servers: %v", want, m.Names())
		}
	}
	if names["github-mcp"] || names["github"] {
		t.Errorf("github must stay opt-in — it must not be auto-merged; got servers: %v", m.Names())
	}
	if len(m.Servers) != 5 {
		t.Errorf("got %d servers, want exactly 5 (hermes, gateway, ms365-mcp, atlassian-mcp, servicenow-mcp): %v",
			len(m.Servers), m.Names())
	}

	// Placeholder-path rewrite: no merged server should still carry the
	// shipped-manifest's placeholder checkout root, and the ones that had it
	// should now point under the temp bundle instead.
	for _, s := range m.Servers {
		if strings.Contains(s.Bin, shippedManifestPlaceholderRoot) {
			t.Errorf("server %q bin still has placeholder root: %s", s.Name, s.Bin)
		}
		for _, a := range s.Args {
			if strings.Contains(a, shippedManifestPlaceholderRoot) {
				t.Errorf("server %q arg still has placeholder root: %s", s.Name, a)
			}
		}
	}
	atlassian := findServer(m, "atlassian-mcp")
	if atlassian == nil {
		t.Fatal("atlassian-mcp not found after merge")
	}
	wantBin := filepath.Join(bundle, "fleet", "servers", "generated", "atlassian", "bin", "atlassian-mcp")
	if atlassian.Bin != wantBin {
		t.Errorf("atlassian-mcp bin = %q, want %q", atlassian.Bin, wantBin)
	}
}

// TestInitHome_Idempotent proves re-running initHome on an already-initialized
// home is a true no-op: same file, byte-for-byte, and the same server set.
func TestInitHome_Idempotent(t *testing.T) {
	seedBundle(t)

	if rc := initHome(nil); rc != 0 {
		t.Fatalf("first initHome() = %d, want 0", rc)
	}
	cfg := paths.Config()
	before, err := os.ReadFile(cfg)
	if err != nil {
		t.Fatalf("read generated thesun.toml: %v", err)
	}

	if rc := initHome(nil); rc != 0 {
		t.Fatalf("second initHome() = %d, want 0", rc)
	}
	after, err := os.ReadFile(cfg)
	if err != nil {
		t.Fatalf("read thesun.toml after second init: %v", err)
	}
	if string(before) != string(after) {
		t.Fatalf("re-running initHome changed thesun.toml — not idempotent\nbefore:\n%s\nafter:\n%s", before, after)
	}
}

// TestMergeShippedDefaults_IdempotentDirectCall exercises mergeShippedDefaults
// directly (bypassing initHome's early "already initialized" short-circuit)
// to prove the merge itself — not just the init wrapper — never duplicates a
// server when invoked twice against the same file.
func TestMergeShippedDefaults_IdempotentDirectCall(t *testing.T) {
	seedBundle(t)

	cfg := paths.Config()
	if err := os.MkdirAll(filepath.Dir(cfg), 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(cfg, []byte(defaultManifest()), 0o600); err != nil {
		t.Fatalf("seed base manifest: %v", err)
	}

	added1, warn1 := mergeShippedDefaults(cfg)
	if warn1 != "" {
		t.Fatalf("first merge warned: %s", warn1)
	}
	if len(added1) != 3 {
		t.Fatalf("first merge added %v, want 3 servers", added1)
	}

	afterFirst, err := os.ReadFile(cfg)
	if err != nil {
		t.Fatalf("read after first merge: %v", err)
	}

	added2, warn2 := mergeShippedDefaults(cfg)
	if warn2 != "" {
		t.Fatalf("second merge warned: %s", warn2)
	}
	if len(added2) != 0 {
		t.Fatalf("second merge added %v, want none (already present)", added2)
	}

	afterSecond, err := os.ReadFile(cfg)
	if err != nil {
		t.Fatalf("read after second merge: %v", err)
	}
	if string(afterFirst) != string(afterSecond) {
		t.Fatal("second merge rewrote the manifest even though nothing was added — not a true no-op")
	}

	m, err := manifest.Load(cfg)
	if err != nil {
		t.Fatalf("load after both merges: %v", err)
	}
	seen := map[string]int{}
	for _, s := range m.Servers {
		seen[s.Name]++
	}
	for name, n := range seen {
		if n != 1 {
			t.Errorf("server %q appears %d times, want 1", name, n)
		}
	}
}

func findServer(m *manifest.Manifest, name string) *manifest.Server {
	for i := range m.Servers {
		if m.Servers[i].Name == name {
			return &m.Servers[i]
		}
	}
	return nil
}

// TestDefaultManifestParsesAndPinsGatewayConfig proves the generated thesun.toml
// is always valid TOML the manifest validator accepts, and that the supervised
// gateway block pins MCP_GATEWAY_CONFIG so a fleetd-driven restart keeps the
// explicit fleet namespaces instead of falling back to the config.yaml sample.
func TestDefaultManifestParsesAndPinsGatewayConfig(t *testing.T) {
	p := filepath.Join(t.TempDir(), "thesun.toml")
	if err := os.WriteFile(p, []byte(defaultManifest()), 0o600); err != nil {
		t.Fatal(err)
	}
	m, err := manifest.Load(p)
	if err != nil {
		t.Fatalf("defaultManifest() must parse: %v", err)
	}
	var gw *manifest.Server
	for i := range m.Servers {
		if m.Servers[i].Name == "gateway" {
			gw = &m.Servers[i]
		}
	}
	if gw == nil {
		t.Fatal("generated manifest has no gateway server")
	}
	cfg := gw.Env["MCP_GATEWAY_CONFIG"]
	if !strings.HasSuffix(cfg, filepath.Join("gateway", "config.fleet.yaml")) {
		t.Fatalf("gateway must pin config.fleet.yaml, got %q", cfg)
	}
	if !filepath.IsAbs(cfg) {
		t.Fatalf("MCP_GATEWAY_CONFIG must be absolute (resolve()-safe), got %q", cfg)
	}
}
