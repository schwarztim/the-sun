package cli

// wire_test.go proves the multi-client merge logic against COPIES of the
// operator's real client configs — never the real files. Every fixture lives
// under t.TempDir(), which is unique per test and auto-cleaned; the real
// ~/.copilot, ~/.config/opencode, and ~/.claude.json are read (if present) to
// seed a realistic fixture, but WireClients is always invoked with homeDir/cwd
// pointing at the temp copy, never the operator's actual home.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/BurntSushi/toml"
)

const testGatewayURL = "http://127.0.0.1:3100/mcp"

// seedFromRealOrFallback copies the real file at realPath into dst if it
// exists (proving the merge logic against actual operator data); otherwise it
// writes a minimal synthetic fixture matching the client's known schema so the
// test still exercises the merge path on a fresh machine / CI.
func seedFromRealOrFallback(t *testing.T, realPath, dst string, fallback []byte) {
	t.Helper()
	if raw, err := os.ReadFile(realPath); err == nil {
		mustWrite(t, dst, raw)
		return
	}
	mustWrite(t, dst, fallback)
}

func mustWrite(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir for %s: %v", path, err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func readJSON(t *testing.T, path string) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	return doc
}

// TestWireClients_CopilotOpenCodeGlobalClaude exercises all three clients in
// one pass: merge, verify shape, run again, verify idempotency (byte-identical
// second write), and confirm the real operator files were never touched.
func TestWireClients_CopilotOpenCodeGlobalClaude(t *testing.T) {
	home := t.TempDir()
	realHome, _ := os.UserHomeDir()

	copilotDst := filepath.Join(home, ".copilot", "mcp-config.json")
	opencodeDst := filepath.Join(home, ".config", "opencode", "opencode.json")
	claudeDst := filepath.Join(home, ".claude.json")
	codexDst := filepath.Join(home, ".codex", "config.toml")
	geminiDst := filepath.Join(home, ".gemini", "settings.json")

	// Make VS Code look installed on this fake home so its wire target is
	// detected (its user dir is per-platform; reuse vscodeUserDir so this is
	// correct on macOS/Linux/Windows alike). The workspace file it writes lives
	// under cwd (set below) at .vscode/mcp.json.
	if err := os.MkdirAll(vscodeUserDir(home), 0o755); err != nil {
		t.Fatalf("mkdir vscode user dir: %v", err)
	}

	seedFromRealOrFallback(t, filepath.Join(realHome, ".copilot", "mcp-config.json"), copilotDst,
		[]byte(`{"mcpServers":{"other-server":{"type":"http","url":"http://127.0.0.1:9999/mcp"}}}`))
	seedFromRealOrFallback(t, filepath.Join(realHome, ".config", "opencode", "opencode.json"), opencodeDst,
		[]byte(`{"$schema":"https://opencode.ai/config.json","mcp":{"other-server":{"type":"remote","url":"http://127.0.0.1:3737/mcp"}}}`))
	seedFromRealOrFallback(t, filepath.Join(realHome, ".claude.json"), claudeDst,
		[]byte(`{"numStartups":1,"mcpServers":{"isaac-mcp":{"command":"python3","args":["isaac-mcp.py"]}}}`))
	seedFromRealOrFallback(t, filepath.Join(realHome, ".codex", "config.toml"), codexDst,
		[]byte("model = 'gpt-5.5'\n\n[mcp_servers]\n[mcp_servers.other-server]\nurl = 'http://127.0.0.1:9999/mcp'\n"))
	seedFromRealOrFallback(t, filepath.Join(realHome, ".gemini", "settings.json"), geminiDst,
		[]byte(`{"ui":{"theme":"Default"},"mcpServers":{"other-server":{"type":"http","url":"http://127.0.0.1:9999/mcp"}}}`))

	// Hash the real files (if present) before running, so we can prove after
	// the test that they were never opened for write.
	realCopilotBefore := readOrEmpty(realHome + "/.copilot/mcp-config.json")
	realOpenCodeBefore := readOrEmpty(realHome + "/.config/opencode/opencode.json")
	realClaudeBefore := readOrEmpty(realHome + "/.claude.json")
	realCodexBefore := readOrEmpty(realHome + "/.codex/config.toml")
	realGeminiBefore := readOrEmpty(realHome + "/.gemini/settings.json")

	cwd := filepath.Join(home, "project") // no .mcp.json here -> Claude Code falls back to ~/.claude.json
	if err := os.MkdirAll(cwd, 0o755); err != nil {
		t.Fatalf("mkdir cwd: %v", err)
	}
	vscodeDst := filepath.Join(cwd, ".vscode", "mcp.json") // workspace-scoped VS Code MCP config

	// Snapshot pre-existing container keys (whatever the seed happened to be —
	// the real fixture's own entries, or the synthetic fallback's) so we can
	// prove afterward that nothing else was clobbered, without hardcoding
	// names that only exist in one of the two seed paths.
	preCopilot := containerKeys(t, copilotDst, "mcpServers")
	preOpenCode := containerKeys(t, opencodeDst, "mcp")
	preClaude := containerKeys(t, claudeDst, "mcpServers")
	preClaudeTop := topLevelKeys(t, claudeDst)
	preCodexServers := codexServerNames(t, codexDst)
	preGemini := containerKeys(t, geminiDst, "mcpServers")
	preGeminiTop := topLevelKeys(t, geminiDst)

	results := WireClients(home, cwd, testGatewayURL)
	// The real fixtures (when present on this machine) may already carry a
	// matching "mcp-gateway" entry from prior manual wiring — that legitimately
	// yields "already-wired" on the very first run. Either outcome proves the
	// merge succeeded; "not-detected"/"error" would not.
	assertAllMerged(t, results)

	// ---- shape checks ----
	copilotDoc := readJSON(t, copilotDst)
	cServers := copilotDoc["mcpServers"].(map[string]any)
	assertSubset(t, "copilot mcpServers", preCopilot, cServers)
	gw := cServers[GatewayEntryName].(map[string]any)
	if gw["type"] != "http" || gw["url"] != testGatewayURL {
		t.Fatalf("copilot: gateway entry wrong shape: %+v", gw)
	}
	tools, ok := gw["tools"].([]any)
	if !ok || len(tools) != 1 || tools[0] != "*" {
		t.Fatalf("copilot: expected tools:[\"*\"], got %+v", gw["tools"])
	}

	ocDoc := readJSON(t, opencodeDst)
	ocMCP := ocDoc["mcp"].(map[string]any)
	assertSubset(t, "opencode mcp", preOpenCode, ocMCP)
	ocGW := ocMCP[GatewayEntryName].(map[string]any)
	if ocGW["type"] != "remote" || ocGW["url"] != testGatewayURL {
		t.Fatalf("opencode: gateway entry wrong shape: %+v", ocGW)
	}

	claudeDoc := readJSON(t, claudeDst)
	clServers := claudeDoc["mcpServers"].(map[string]any)
	assertSubset(t, "claude mcpServers", preClaude, clServers)
	clGW := clServers[GatewayEntryName].(map[string]any)
	if clGW["type"] != "http" || clGW["url"] != testGatewayURL {
		t.Fatalf("claude: gateway entry wrong shape: %+v", clGW)
	}
	assertSubset(t, "claude top-level", preClaudeTop, claudeDoc)

	// ---- Codex (TOML): verify the merged file still parses, the
	// [mcp_servers.mcp-gateway] table carries our url, and every pre-existing
	// [mcp_servers.X] table (and other top-level content) survived untouched.
	codexText := readOrEmpty(codexDst)
	var codexDoc map[string]any
	if _, err := toml.Decode(string(codexText), &codexDoc); err != nil {
		t.Fatalf("codex: merged config.toml failed to parse: %v\n---\n%s", err, codexText)
	}
	postCodexServers := codexServerNames(t, codexDst)
	for name := range preCodexServers {
		if !postCodexServers[name] {
			t.Fatalf("codex: pre-existing [mcp_servers.%s] table was lost after merge", name)
		}
	}
	mcpServers, _ := codexDoc["mcp_servers"].(map[string]any)
	if mcpServers == nil {
		t.Fatalf("codex: mcp_servers table missing after merge")
	}
	gwTable, _ := mcpServers[GatewayEntryName].(map[string]any)
	if gwTable == nil || gwTable["url"] != testGatewayURL {
		t.Fatalf("codex: [mcp_servers.%s] wrong shape: %+v", GatewayEntryName, gwTable)
	}

	// ---- Gemini CLI (~/.gemini/settings.json): "mcpServers" map, url+type
	// "http". This file also holds the user's theme and auth selection, so a
	// merge that clobbers unrelated top-level keys would break their CLI.
	geminiDoc := readJSON(t, geminiDst)
	assertSubset(t, "gemini top-level", preGeminiTop, geminiDoc)
	gServers, ok := geminiDoc["mcpServers"].(map[string]any)
	if !ok {
		t.Fatalf("gemini: mcpServers map missing after merge: %+v", geminiDoc)
	}
	assertSubset(t, "gemini mcpServers", preGemini, gServers)
	gGw, _ := gServers[GatewayEntryName].(map[string]any)
	if gGw == nil || gGw["type"] != "http" || gGw["url"] != testGatewayURL {
		t.Fatalf("gemini: %s entry wrong shape: %+v", GatewayEntryName, gGw)
	}

	// ---- VS Code (.vscode/mcp.json): top-level "servers" map, http+url entry.
	vscodeDoc := readJSON(t, vscodeDst)
	vsServers, ok := vscodeDoc["servers"].(map[string]any)
	if !ok {
		t.Fatalf("vscode: expected a top-level \"servers\" map, got %+v", vscodeDoc)
	}
	vsGW, ok := vsServers[GatewayEntryName].(map[string]any)
	if !ok {
		t.Fatalf("vscode: gateway entry missing under servers: %+v", vsServers)
	}
	if vsGW["type"] != "http" || vsGW["url"] != testGatewayURL {
		t.Fatalf("vscode: gateway entry wrong shape (want type=http streamable-HTTP + url): %+v", vsGW)
	}

	// ---- idempotency: second run must report already-wired, and file bytes
	// must be identical (not just semantically equal) ----
	before := map[string][]byte{
		copilotDst:  readOrEmpty(copilotDst),
		opencodeDst: readOrEmpty(opencodeDst),
		claudeDst:   readOrEmpty(claudeDst),
		codexDst:    readOrEmpty(codexDst),
		vscodeDst:   readOrEmpty(vscodeDst),
	}
	results2 := WireClients(home, cwd, testGatewayURL)
	for _, r := range results2 {
		if r.Status != "already-wired" {
			t.Fatalf("second run: expected already-wired for %s, got %s (%s)", r.Client, r.Status, r.Detail)
		}
	}
	for path, want := range before {
		got := readOrEmpty(path)
		if string(got) != string(want) {
			t.Fatalf("idempotency violated: %s changed on second run", path)
		}
	}

	// ---- prove the real operator files were never modified ----
	if got := readOrEmpty(realHome + "/.copilot/mcp-config.json"); string(got) != string(realCopilotBefore) {
		t.Fatalf("REAL ~/.copilot/mcp-config.json was modified — guardrail violation")
	}
	if got := readOrEmpty(realHome + "/.config/opencode/opencode.json"); string(got) != string(realOpenCodeBefore) {
		t.Fatalf("REAL ~/.config/opencode/opencode.json was modified — guardrail violation")
	}
	if got := readOrEmpty(realHome + "/.claude.json"); string(got) != string(realClaudeBefore) {
		t.Fatalf("REAL ~/.claude.json was modified — guardrail violation")
	}
	if got := readOrEmpty(realHome + "/.codex/config.toml"); string(got) != string(realCodexBefore) {
		t.Fatalf("REAL ~/.codex/config.toml was modified — guardrail violation")
	}
	if got := readOrEmpty(realHome + "/.gemini/settings.json"); string(got) != string(realGeminiBefore) {
		t.Fatalf("REAL ~/.gemini/settings.json was modified: guardrail violation")
	}
}

// TestWireClients_GeminiTransportKeys pins the one detail that decides whether
// the Gemini wiring works at all. Gemini's createUrlTransport accepts three
// spellings and they do not mean the same thing: `httpUrl` is streamable-http
// but deprecated, `url`+type "http" is streamable-http, and `url`+type "sse"
// is SSE. SSE 405-fails against a streamable-http server and exposes zero
// tools, which is a silent failure: wiring "succeeds" and the client sees
// nothing. Assert the exact keys, not merely that an entry exists.
func TestWireClients_GeminiTransportKeys(t *testing.T) {
	home := t.TempDir()
	cwd := t.TempDir()
	dst := filepath.Join(home, ".gemini", "settings.json")
	mustWrite(t, dst, []byte(`{"ui":{"theme":"Default"}}`))

	results := WireClients(home, cwd, testGatewayURL)

	var got *WireResult
	for i := range results {
		if results[i].Client == "Gemini CLI" {
			got = &results[i]
		}
	}
	if got == nil {
		t.Fatal("Gemini CLI is not among the wire targets")
	}
	if got.Status != "wired" && got.Status != "already-wired" {
		t.Fatalf("Gemini: status %q (%s)", got.Status, got.Detail)
	}

	doc := readJSON(t, dst)
	servers, ok := doc["mcpServers"].(map[string]any)
	if !ok {
		t.Fatalf("Gemini: no mcpServers map: %+v", doc)
	}
	entry, ok := servers[GatewayEntryName].(map[string]any)
	if !ok {
		t.Fatalf("Gemini: no %s entry: %+v", GatewayEntryName, servers)
	}
	if entry["type"] != "http" {
		t.Errorf(`Gemini: type = %v, want "http" (streamable-http)`, entry["type"])
	}
	if entry["url"] != testGatewayURL {
		t.Errorf("Gemini: url = %v, want %s", entry["url"], testGatewayURL)
	}
	if _, bad := entry["httpUrl"]; bad {
		t.Error("Gemini: wrote the deprecated httpUrl key instead of url+type")
	}
	if entry["type"] == "sse" {
		t.Error("Gemini: SSE transport is prohibited and would expose zero tools")
	}

	// Unrelated settings must survive: this file holds the user's theme and
	// auth choice, not just MCP wiring.
	if _, ok := doc["ui"]; !ok {
		t.Error("Gemini: clobbered unrelated settings (ui block is gone)")
	}
}

// TestWireClients_ProjectMCPJSON proves the Claude Code project-file path:
// when cwd already has a .mcp.json, that file is preferred over the global
// ~/.claude.json, and merging is idempotent there too.
func TestWireClients_ProjectMCPJSON(t *testing.T) {
	home := t.TempDir()
	cwd := t.TempDir()
	projectFile := filepath.Join(cwd, ".mcp.json")
	mustWrite(t, projectFile, []byte(`{"mcpServers":{"thesun":{"type":"http","url":"http://localhost:52361/mcp"}}}`))

	results := WireClients(home, cwd, testGatewayURL)
	var claudeResult *WireResult
	for i := range results {
		if results[i].Path == projectFile {
			claudeResult = &results[i]
		}
	}
	if claudeResult == nil {
		t.Fatalf("expected a result targeting the project .mcp.json, got %+v", results)
	}
	if claudeResult.Status != "wired" {
		t.Fatalf("expected wired, got %s (%s)", claudeResult.Status, claudeResult.Detail)
	}

	doc := readJSON(t, projectFile)
	servers := doc["mcpServers"].(map[string]any)
	if _, ok := servers["thesun"]; !ok {
		t.Fatalf("pre-existing project server entry was clobbered")
	}
	if _, ok := servers[GatewayEntryName]; !ok {
		t.Fatalf("gateway entry missing from project .mcp.json")
	}

	// ~/.claude.json must NOT have been created — project file took priority.
	if fileExists(filepath.Join(home, ".claude.json")) {
		t.Fatalf("global ~/.claude.json should not exist when a project .mcp.json was preferred")
	}

	// Idempotent second run.
	before := readOrEmpty(projectFile)
	results2 := WireClients(home, cwd, testGatewayURL)
	for _, r := range results2 {
		if r.Path == projectFile && r.Status != "already-wired" {
			t.Fatalf("second run: expected already-wired, got %s", r.Status)
		}
	}
	if got := readOrEmpty(projectFile); string(got) != string(before) {
		t.Fatalf("idempotency violated for project .mcp.json")
	}
}

// TestWireClients_VSCodeWorkspaceFile proves the VS Code path: an existing
// workspace .vscode/mcp.json is detected (even with no VS Code user dir on this
// fake home), the gateway is merged under the "servers" key preserving any
// other server, the entry is streamable-HTTP (type=http + url), and a second
// run is a byte-identical no-op.
func TestWireClients_VSCodeWorkspaceFile(t *testing.T) {
	home := t.TempDir() // deliberately no VS Code user dir seeded
	cwd := t.TempDir()
	vscodeFile := filepath.Join(cwd, ".vscode", "mcp.json")
	// Pre-existing workspace config with an unrelated server that must survive.
	mustWrite(t, vscodeFile, []byte(`{"servers":{"other":{"type":"http","url":"http://127.0.0.1:9999/mcp"}}}`))

	results := WireClients(home, cwd, testGatewayURL)
	var vscodeResult *WireResult
	for i := range results {
		if results[i].Path == vscodeFile {
			vscodeResult = &results[i]
		}
	}
	if vscodeResult == nil {
		t.Fatalf("expected a result targeting %s, got %+v", vscodeFile, results)
	}
	if vscodeResult.Status != "wired" {
		t.Fatalf("expected wired for the VS Code workspace file, got %s (%s)", vscodeResult.Status, vscodeResult.Detail)
	}

	doc := readJSON(t, vscodeFile)
	servers := doc["servers"].(map[string]any)
	if _, ok := servers["other"]; !ok {
		t.Fatalf("pre-existing VS Code server entry was clobbered")
	}
	gw, ok := servers[GatewayEntryName].(map[string]any)
	if !ok || gw["type"] != "http" || gw["url"] != testGatewayURL {
		t.Fatalf("VS Code gateway entry missing or wrong shape: %+v", servers[GatewayEntryName])
	}

	before := readOrEmpty(vscodeFile)
	results2 := WireClients(home, cwd, testGatewayURL)
	for _, r := range results2 {
		if r.Path == vscodeFile && r.Status != "already-wired" {
			t.Fatalf("second run: expected already-wired for VS Code, got %s", r.Status)
		}
	}
	if got := readOrEmpty(vscodeFile); string(got) != string(before) {
		t.Fatalf("idempotency violated for .vscode/mcp.json")
	}
}

// TestWireClients_NotDetected confirms a client whose config directory does
// not exist at all is reported as not-detected, not as an error, and no file
// is created for it.
func TestWireClients_NotDetected(t *testing.T) {
	home := t.TempDir() // nothing seeded — no client dirs exist
	cwd := t.TempDir()
	// On Windows, VS Code detection resolves its user dir from %APPDATA% and
	// ignores the home passed here, so on a runner with VS Code installed the
	// lookup escaped this sandbox and reported the real machine's install:
	// "not-detected" became "wired". Point APPDATA at the sandbox so the
	// Windows branch is as isolated as the darwin and linux ones.
	t.Setenv("APPDATA", filepath.Join(home, "AppData", "Roaming"))

	results := WireClients(home, cwd, testGatewayURL)
	for _, r := range results {
		if r.Status != "not-detected" {
			t.Fatalf("expected not-detected for %s on a bare home, got %s (%s)", r.Client, r.Status, r.Detail)
		}
	}
}

func readOrEmpty(path string) []byte {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	return b
}

// containerKeys reads the key set of the named nested container in the JSON
// document at path (empty set if the file or container doesn't exist yet).
func containerKeys(t *testing.T, path, containerKey string) map[string]bool {
	t.Helper()
	keys := map[string]bool{}
	raw, err := os.ReadFile(path)
	if err != nil {
		return keys
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	container, _ := doc[containerKey].(map[string]any)
	for k := range container {
		keys[k] = true
	}
	return keys
}

// topLevelKeys reads the top-level key set of the JSON document at path.
func topLevelKeys(t *testing.T, path string) map[string]bool {
	t.Helper()
	keys := map[string]bool{}
	raw, err := os.ReadFile(path)
	if err != nil {
		return keys
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	for k := range doc {
		keys[k] = true
	}
	return keys
}

var codexServerHeaderRe = regexp.MustCompile(`(?m)^\[mcp_servers\.([^\]]+)\]\s*$`)

// codexServerNames extracts every [mcp_servers.<name>] table name declared in
// the Codex config.toml at path (empty set if the file doesn't exist yet).
func codexServerNames(t *testing.T, path string) map[string]bool {
	t.Helper()
	names := map[string]bool{}
	raw, err := os.ReadFile(path)
	if err != nil {
		return names
	}
	for _, m := range codexServerHeaderRe.FindAllStringSubmatch(string(raw), -1) {
		names[m[1]] = true
	}
	return names
}

// assertSubset fails if any key in "want" is missing from "got" — proves the
// merge preserved every pre-existing key instead of clobbering the document.
func assertSubset(t *testing.T, label string, want map[string]bool, got map[string]any) {
	t.Helper()
	for k := range want {
		if _, ok := got[k]; !ok {
			t.Fatalf("%s: pre-existing key %q was lost after merge", label, k)
		}
	}
}

func assertAllMerged(t *testing.T, results []WireResult) {
	t.Helper()
	for _, r := range results {
		if r.Status != "wired" && r.Status != "already-wired" {
			t.Fatalf("expected wired/already-wired for %s (%s), got %s: %s", r.Client, r.Path, r.Status, r.Detail)
		}
	}
}

// TestCodexMergeFindsAnIndentedGatewayTable is the regression test for a
// duplicate-key write refusal seen on a real machine.
//
// TOML permits leading whitespace before a table header, and a TOML encoder is
// entitled to indent nested tables (BurntSushi's does, so any config that has
// been round-tripped comes back indented). The header pattern was anchored at
// column zero, so a perfectly valid indented [mcp_servers.mcp-gateway] read as
// absent: the merge appended a second one, and the fail-closed TOML validation
// then refused the write for a duplicate key. The client silently stopped being
// re-wirable while still looking correctly configured.
func TestCodexMergeFindsAnIndentedGatewayTable(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")

	// Exactly the shape a BurntSushi round-trip produces: nested tables indented
	// under their parent.
	indented := "[mcp_servers]\n" +
		"  [mcp_servers.bambu]\n" +
		"    url = 'http://10.0.0.1:18000/mcp'\n" +
		"  [mcp_servers." + GatewayEntryName + "]\n" +
		"    url = 'http://127.0.0.1:3100/mcp'\n"
	mustWrite(t, path, []byte(indented))

	// The entry is already present and already correct. The merge may rewrite it
	// once to normalise the indentation of its own block, but it must CONVERGE:
	// a second run has to be a no-op, or every `thesun wire` would churn the
	// operator's config forever.
	if _, err := mergeCodexEntry(path, "http://127.0.0.1:3100/mcp"); err != nil {
		t.Fatalf("merge refused an indented but valid config: %v", err)
	}
	changed, err := mergeCodexEntry(path, "http://127.0.0.1:3100/mcp")
	if err != nil {
		t.Fatalf("second merge failed: %v", err)
	}
	if changed {
		t.Error("the merge does not converge: it rewrites an already-correct config every run")
	}

	// Now a DIFFERENT URL: it must replace the existing block, not append a
	// second one.
	changed, err = mergeCodexEntry(path, "http://127.0.0.1:3199/mcp")
	if err != nil {
		t.Fatalf("merge failed against an indented config: %v", err)
	}
	if !changed {
		t.Fatal("reported no change when the gateway URL moved")
	}

	got, _ := os.ReadFile(path)
	text := string(got)
	if n := strings.Count(text, "[mcp_servers."+GatewayEntryName+"]"); n != 1 {
		t.Errorf("config now holds %d gateway tables, want exactly 1:\n%s", n, text)
	}
	if !strings.Contains(text, "3199") {
		t.Errorf("the gateway URL was not updated:\n%s", text)
	}
	// The unrelated neighbour must survive untouched.
	if !strings.Contains(text, "[mcp_servers.bambu]") {
		t.Errorf("an unrelated server was lost:\n%s", text)
	}
	if err := validateTOML(text); err != nil {
		t.Errorf("the result is not valid TOML: %v", err)
	}
}
