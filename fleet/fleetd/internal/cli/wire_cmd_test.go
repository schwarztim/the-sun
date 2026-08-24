package cli

import (
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// listenOnEphemeral starts a real listener so a "live" registration in these
// tests is genuinely live. Probing a hardcoded port would make the result depend
// on whatever happens to be running on the machine.
func listenOnEphemeral(t *testing.T) (addr string, close func()) {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	return "http://" + l.Addr().String() + "/mcp", func() { _ = l.Close() }
}

// deadURL returns a loopback URL that nothing is listening on, by binding a port
// and immediately releasing it. Picking an arbitrary number risks colliding with
// a real service and inverting the assertion.
func deadURL(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	addr := l.Addr().String()
	_ = l.Close()
	return "http://" + addr + "/mcp"
}

func writeJSON(t *testing.T, path string, v any) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, b, 0o600); err != nil {
		t.Fatal(err)
	}
}

// TestPruneRemovesOnlyTheProhibitedAndDead is the load-bearing test for
// `wire --prune`. The command edits the developer's own config files, so the
// risk is not that it prunes too little but that it prunes something they meant
// to keep. Assert all four classes in one config: the gateway survives, a live
// non-gateway server survives, and only stdio and dead entries go.
func TestPruneRemovesOnlyTheProhibitedAndDead(t *testing.T) {
	home := t.TempDir()
	cwd := t.TempDir()

	liveURL, closeLive := listenOnEphemeral(t)
	defer closeLive()

	claude := filepath.Join(home, ".claude.json")
	writeJSON(t, claude, map[string]any{
		"numStartups": 3,
		"mcpServers": map[string]any{
			GatewayEntryName: map[string]any{"type": "http", "url": "http://127.0.0.1:3100/mcp"},
			"deliberate":     map[string]any{"type": "http", "url": liveURL},
			"abandoned":      map[string]any{"type": "http", "url": deadURL(t)},
			"legacy-stdio":   map[string]any{"command": "node", "args": []any{"server.js"}},
		},
	})

	regs := CollectClientMCPRegistrations(home, cwd)
	if len(regs) != 4 {
		t.Fatalf("expected 4 registrations, got %d: %+v", len(regs), regs)
	}

	// Prove the classification before pruning on it, so a wrong verdict cannot
	// hide behind a correct-looking removal.
	verdicts := map[string]string{}
	for _, r := range regs {
		verdicts[r.Name] = mcpVerdict(r)
	}
	for name, want := range map[string]string{
		GatewayEntryName: "gateway",
		"deliberate":     "live",
		"abandoned":      "dead",
		"legacy-stdio":   "stdio",
	} {
		if verdicts[name] != want {
			t.Errorf("%s classified as %q, want %q", name, verdicts[name], want)
		}
	}

	if code := wirePrune(home, cwd, true); code != 0 {
		t.Fatalf("wirePrune returned %d", code)
	}

	raw, err := os.ReadFile(claude)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("config is no longer valid JSON: %v", err)
	}
	servers, _ := doc["mcpServers"].(map[string]any)

	if _, ok := servers[GatewayEntryName]; !ok {
		t.Error("pruned the gateway entry, which is the one that must always survive")
	}
	if _, ok := servers["deliberate"]; !ok {
		t.Error("pruned a LIVE non-gateway server; a reachable server may be a deliberate wiring")
	}
	if _, ok := servers["abandoned"]; ok {
		t.Error("kept a dead-port registration")
	}
	if _, ok := servers["legacy-stdio"]; ok {
		t.Error("kept a stdio registration, which is prohibited outright")
	}

	// Unrelated top-level settings must survive; this file holds far more than
	// MCP wiring.
	if doc["numStartups"] == nil {
		t.Error("clobbered unrelated top-level settings")
	}
}

// TestPreviewChangesNothing pins the default. `--prune` without `--yes` must be
// read-only: a command that edits configs on the strength of a typo is worse
// than one that does nothing.
func TestPreviewChangesNothing(t *testing.T) {
	home := t.TempDir()
	cwd := t.TempDir()
	claude := filepath.Join(home, ".claude.json")
	writeJSON(t, claude, map[string]any{
		"mcpServers": map[string]any{
			"legacy-stdio": map[string]any{"command": "node"},
			"abandoned":    map[string]any{"type": "http", "url": deadURL(t)},
		},
	})
	before, _ := os.ReadFile(claude)

	if code := wirePrune(home, cwd, false); code != 0 {
		t.Fatalf("preview returned %d", code)
	}

	after, _ := os.ReadFile(claude)
	if string(before) != string(after) {
		t.Error("preview modified the config; --prune without --yes must be read-only")
	}
	entries, _ := filepath.Glob(claude + ".thesun-bak-*")
	if len(entries) != 0 {
		t.Error("preview wrote a backup; it should not have touched anything")
	}
}

// TestPruneBacksUpBeforeWriting proves the recovery path exists. The prune is
// the only command here that destroys information the operator cannot regenerate
// (a hand-maintained server list), so the backup is not a nicety.
func TestPruneBacksUpBeforeWriting(t *testing.T) {
	home := t.TempDir()
	cwd := t.TempDir()
	claude := filepath.Join(home, ".claude.json")
	writeJSON(t, claude, map[string]any{
		"mcpServers": map[string]any{"legacy-stdio": map[string]any{"command": "node"}},
	})
	original, _ := os.ReadFile(claude)

	if code := wirePrune(home, cwd, true); code != 0 {
		t.Fatalf("prune returned %d", code)
	}

	backups, _ := filepath.Glob(claude + ".thesun-bak-*")
	if len(backups) != 1 {
		t.Fatalf("expected exactly 1 backup, got %d", len(backups))
	}
	restored, _ := os.ReadFile(backups[0])
	if string(restored) != string(original) {
		t.Error("the backup does not match what the file held before the prune")
	}
}

// TestPruneRefusesAMalformedConfig proves the failure mode is safe. Rewriting a
// file we could not fully parse would silently discard whatever we failed to
// understand, which is a far worse outcome than refusing.
func TestPruneRefusesAMalformedConfig(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, ".claude.json")
	if err := os.WriteFile(path, []byte(`{"mcpServers": {"a": `), 0o600); err != nil {
		t.Fatal(err)
	}
	err := pruneJSONConfig(path, []mcpRegistration{
		{Name: "a", File: path, Container: "mcpServers"},
	})
	if err == nil {
		t.Fatal("rewrote a config that does not parse")
	}
	if !strings.Contains(err.Error(), "refusing to rewrite") {
		t.Errorf("error should say it refused: %v", err)
	}
	after, _ := os.ReadFile(path)
	if string(after) != `{"mcpServers": {"a": ` {
		t.Error("the malformed file was modified anyway")
	}
}

// TestGatewayEntryIsNeverPrunable is a belt-and-braces guard on the one
// invariant that would break routing for every client at once.
func TestGatewayEntryIsNeverPrunable(t *testing.T) {
	for _, transport := range []string{"http", "stdio"} {
		r := mcpRegistration{Name: GatewayEntryName, Transport: transport, Live: false}
		if prunable(r) {
			t.Errorf("gateway entry marked prunable with transport %q", transport)
		}
	}
}

// TestCollectFindsEveryClient proves the report covers all six wired clients.
// A client missing from collection is invisible to both the doctor check and the
// prune, which is the same silent gap this whole feature exists to close.
func TestCollectFindsEveryClient(t *testing.T) {
	home := t.TempDir()
	cwd := t.TempDir()
	dead := deadURL(t)
	entry := map[string]any{"type": "http", "url": dead}

	writeJSON(t, filepath.Join(home, ".claude.json"), map[string]any{"mcpServers": map[string]any{"a": entry}})
	writeJSON(t, filepath.Join(home, ".copilot", "mcp-config.json"), map[string]any{"mcpServers": map[string]any{"b": entry}})
	writeJSON(t, filepath.Join(home, ".gemini", "settings.json"), map[string]any{"mcpServers": map[string]any{"c": entry}})
	writeJSON(t, filepath.Join(home, ".config", "opencode", "opencode.json"), map[string]any{"mcp": map[string]any{"d": entry}})
	writeJSON(t, filepath.Join(cwd, ".vscode", "mcp.json"), map[string]any{"servers": map[string]any{"e": entry}})
	codex := filepath.Join(home, ".codex", "config.toml")
	if err := os.MkdirAll(filepath.Dir(codex), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(codex, []byte("[mcp_servers]\n[mcp_servers.f]\nurl = '"+dead+"'\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	found := map[string]bool{}
	for _, r := range CollectClientMCPRegistrations(home, cwd) {
		found[r.Client] = true
	}
	for _, want := range []string{
		"Claude Code", "GitHub Copilot CLI", "Gemini CLI",
		"OpenCode", "VS Code", "OpenAI Codex CLI",
	} {
		if !found[want] {
			t.Errorf("%s registrations are not collected; they are invisible to doctor and prune", want)
		}
	}
}

// TestPruneDoesNotTakeASameNamedEntryFromAnotherContainer is the regression test
// for the bug that made the preview a lie.
//
// ~/.claude.json holds a global `mcpServers` map AND a `projects.<path>.mcpServers`
// map per project, and the same server name can legitimately appear in both. Here
// the project-scoped `shared` is dead (so it is doomed) while the global `shared`
// is live (so the preview explicitly promises to LEAVE IT ALONE). Deleting by
// name across the whole file removed both: the operator was told one thing and a
// working server disappeared.
func TestPruneDoesNotTakeASameNamedEntryFromAnotherContainer(t *testing.T) {
	home := t.TempDir()
	cwd := t.TempDir()

	liveURL, closeLive := listenOnEphemeral(t)
	defer closeLive()

	claude := filepath.Join(home, ".claude.json")
	writeJSON(t, claude, map[string]any{
		"mcpServers": map[string]any{
			"shared": map[string]any{"type": "http", "url": liveURL},
		},
		"projects": map[string]any{
			"/Users/someone/work/thing": map[string]any{
				"mcpServers": map[string]any{
					"shared": map[string]any{"type": "http", "url": deadURL(t)},
				},
			},
		},
	})

	// Precondition: the two entries really do share a name and differ in liveness.
	regs := CollectClientMCPRegistrations(home, cwd)
	var liveSeen, deadSeen bool
	for _, r := range regs {
		if r.Name != "shared" {
			continue
		}
		if mcpVerdict(r) == "live" {
			liveSeen = true
		}
		if mcpVerdict(r) == "dead" {
			deadSeen = true
		}
	}
	if !liveSeen || !deadSeen {
		t.Fatalf("test setup did not produce one live and one dead %q: %+v", "shared", regs)
	}

	if code := wirePrune(home, cwd, true); code != 0 {
		t.Fatalf("wirePrune returned %d", code)
	}

	raw, _ := os.ReadFile(claude)
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("config is no longer valid JSON: %v", err)
	}
	global, _ := doc["mcpServers"].(map[string]any)
	if _, ok := global["shared"]; !ok {
		t.Error("the LIVE global entry was deleted because a dead project entry shared its name; the preview said it would be left alone")
	}
	projects, _ := doc["projects"].(map[string]any)
	pc, _ := projects["/Users/someone/work/thing"].(map[string]any)
	scoped, _ := pc["mcpServers"].(map[string]any)
	if _, ok := scoped["shared"]; ok {
		t.Error("the dead project-scoped entry was not removed")
	}
}

// TestProjectKeysWithSlashesResolve pins the container-path parsing. Claude's
// project keys ARE filesystem paths, so a naive split on every "/" would fail to
// find the map and silently prune nothing while reporting success.
func TestProjectKeysWithSlashesResolve(t *testing.T) {
	doc := map[string]any{
		"projects": map[string]any{
			"/a/b/c": map[string]any{
				"mcpServers": map[string]any{"x": map[string]any{}},
			},
		},
	}
	got := resolveContainer(doc, "projects//a/b/c/mcpServers")
	if got == nil {
		t.Fatal("a project key containing slashes did not resolve")
	}
	if _, ok := got["x"]; !ok {
		t.Error("resolved to the wrong map")
	}
	if resolveContainer(doc, "projects//nope/mcpServers") != nil {
		t.Error("a container path that does not exist should resolve to nil, not to some other map")
	}
}
