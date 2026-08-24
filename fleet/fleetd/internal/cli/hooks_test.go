package cli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// readJSON is a tiny helper for assertions.
func readJSONDoc2(t *testing.T, path string) map[string]any {
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

func TestMergeEnvelopeHook_CreatesAndIsIdempotent(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "settings.json")
	script := "/opt/thesun/packaging/hooks/thesun-hook.mjs"
	cmd := nodeCommand(script)

	changed, err := mergeEnvelopeHook(path, "PreToolUse", `mcp__mcp-gateway__.*`, cmd)
	if err != nil {
		t.Fatalf("install: %v", err)
	}
	if !changed {
		t.Fatal("first install should report changed=true")
	}

	// Structure: hooks.PreToolUse[0].hooks[0].command references the script.
	doc := readJSONDoc2(t, path)
	hooks := doc["hooks"].(map[string]any)
	pre := hooks["PreToolUse"].([]any)
	if len(pre) != 1 {
		t.Fatalf("want 1 PreToolUse group, got %d", len(pre))
	}
	if st, _ := envelopeHookStatus(path, "PreToolUse", script); st != "installed" {
		t.Fatalf("status after install = %q, want installed", st)
	}

	// Idempotent: second run makes no change.
	changed, err = mergeEnvelopeHook(path, "PreToolUse", `mcp__mcp-gateway__.*`, cmd)
	if err != nil {
		t.Fatalf("second install: %v", err)
	}
	if changed {
		t.Fatal("second install should be a no-op (changed=false)")
	}
}

func TestMergeEnvelopeHook_PreservesUnrelatedGroupsAndBaksOnChange(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "settings.json")

	// Seed a config with an unrelated user hook + an unrelated top-level key.
	seed := map[string]any{
		"model": "sonnet",
		"hooks": map[string]any{
			"PreToolUse": []any{
				map[string]any{
					"matcher": "Bash",
					"hooks":   []any{map[string]any{"type": "command", "command": "/usr/bin/user-guard"}},
				},
			},
		},
	}
	raw, _ := json.MarshalIndent(seed, "", "  ")
	if err := os.WriteFile(path, append(raw, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}

	script := "/opt/thesun/packaging/hooks/thesun-hook.mjs"
	changed, err := mergeEnvelopeHook(path, "PreToolUse", `mcp__mcp-gateway__.*`, nodeCommand(script))
	if err != nil || !changed {
		t.Fatalf("install: changed=%v err=%v", changed, err)
	}

	doc := readJSONDoc2(t, path)
	if doc["model"] != "sonnet" {
		t.Errorf("unrelated top-level key 'model' was lost")
	}
	pre := doc["hooks"].(map[string]any)["PreToolUse"].([]any)
	if len(pre) != 2 {
		t.Fatalf("want 2 groups (user + thesun), got %d", len(pre))
	}
	// The user's Bash guard must still be there.
	foundUser := false
	for _, g := range pre {
		gm := g.(map[string]any)
		if gm["matcher"] == "Bash" {
			foundUser = true
		}
	}
	if !foundUser {
		t.Error("unrelated user PreToolUse group was clobbered")
	}
	// A .bak of the pre-existing file must exist.
	if _, err := os.Stat(path + ".bak"); err != nil {
		t.Errorf("expected %s.bak backup, got: %v", path, err)
	}
}

func TestMergeEnvelopeHook_DriftDetection(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "settings.json")
	oldScript := "/old/loc/thesun-hook.mjs"
	if _, err := mergeEnvelopeHook(path, "PreToolUse", `mcp__mcp-gateway__.*`, nodeCommand(oldScript)); err != nil {
		t.Fatal(err)
	}
	// Status queried against a DIFFERENT (current) script path → drift.
	newScript := "/new/loc/thesun-hook.mjs"
	if st, _ := envelopeHookStatus(path, "PreToolUse", newScript); st != "drift" {
		t.Fatalf("expected drift when script path moved, got %q", st)
	}
	// Re-installing with the new path clears drift.
	if _, err := mergeEnvelopeHook(path, "PreToolUse", `mcp__mcp-gateway__.*`, nodeCommand(newScript)); err != nil {
		t.Fatal(err)
	}
	if st, _ := envelopeHookStatus(path, "PreToolUse", newScript); st != "installed" {
		t.Fatalf("expected installed after re-install, got %q", st)
	}
}

func TestWriteCopilotHook_FlatSchemaAndIdempotent(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "thesun.json")
	script := "/opt/thesun/packaging/hooks/thesun-hook.mjs"

	changed, err := writeCopilotHook(path, "mcp-gateway", script)
	if err != nil || !changed {
		t.Fatalf("install: changed=%v err=%v", changed, err)
	}
	doc := readJSONDoc2(t, path)
	hooks := doc["hooks"].(map[string]any)
	pre := hooks["preToolUse"].([]any) // FLAT schema uses lowercase preToolUse
	if len(pre) != 1 {
		t.Fatalf("want 1 preToolUse entry, got %d", len(pre))
	}
	entry := pre[0].(map[string]any)
	if !strings.Contains(entry["bash"].(string), script) {
		t.Errorf("bash command missing script path: %v", entry["bash"])
	}
	if _, ok := entry["powershell"]; !ok {
		t.Error("expected a powershell command for Windows")
	}
	if st, _ := copilotHookStatus(path, script); st != "installed" {
		t.Fatalf("copilot status = %q, want installed", st)
	}

	changed, err = writeCopilotHook(path, "mcp-gateway", script)
	if err != nil {
		t.Fatal(err)
	}
	if changed {
		t.Fatal("second copilot install should be a no-op")
	}
}

func TestInstallOpencodePlugin_CopiesPluginAndCore(t *testing.T) {
	src := t.TempDir()
	srcPlugin := filepath.Join(src, "opencode-plugin.ts")
	srcCore := filepath.Join(src, "core.mjs")
	if err := os.WriteFile(srcPlugin, []byte("// plugin v1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(srcCore, []byte("// core v1\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	pluginDir := filepath.Join(t.TempDir(), "plugin")
	changed, err := installOpencodePlugin(pluginDir, srcPlugin, srcCore)
	if err != nil || !changed {
		t.Fatalf("install: changed=%v err=%v", changed, err)
	}
	if _, err := os.Stat(filepath.Join(pluginDir, "thesun-opencode-plugin.ts")); err != nil {
		t.Errorf("plugin not copied: %v", err)
	}
	if _, err := os.Stat(filepath.Join(pluginDir, "core.mjs")); err != nil {
		t.Errorf("core.mjs not copied: %v", err)
	}
	if st, _ := opencodePluginStatus(pluginDir, srcPlugin); st != "installed" {
		t.Fatalf("opencode status = %q, want installed", st)
	}

	// Idempotent.
	changed, err = installOpencodePlugin(pluginDir, srcPlugin, srcCore)
	if err != nil {
		t.Fatal(err)
	}
	if changed {
		t.Fatal("second opencode install should be a no-op")
	}

	// Drift when the packaged source changes.
	if err := os.WriteFile(srcPlugin, []byte("// plugin v2\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if st, _ := opencodePluginStatus(pluginDir, srcPlugin); st != "drift" {
		t.Fatalf("expected drift after source change, got %q", st)
	}
}

func TestHookTargets_DetectionAndResolution(t *testing.T) {
	home := t.TempDir()
	// Nothing present yet — every client not-detected.
	for _, tg := range hookTargets(home, home, "/s/thesun-hook.mjs", "/s/opencode-plugin.ts", "/s/core.mjs") {
		if tg.detected() {
			t.Errorf("%s should NOT be detected on an empty home", tg.client)
		}
	}
	// Create client markers.
	mustMkdir(t, filepath.Join(home, ".claude"))
	mustMkdir(t, filepath.Join(home, ".copilot"))
	mustMkdir(t, filepath.Join(home, ".codex"))
	mustMkdir(t, filepath.Join(home, ".config", "opencode"))

	detected := map[string]bool{}
	for _, tg := range hookTargets(home, home, "/s/thesun-hook.mjs", "/s/opencode-plugin.ts", "/s/core.mjs") {
		detected[tg.client] = tg.detected()
	}
	for _, want := range []string{"Claude Code", "GitHub Copilot CLI", "OpenAI Codex CLI", "OpenCode"} {
		if !detected[want] {
			t.Errorf("%s should be detected after its dir was created", want)
		}
	}
}

func TestRegexEscape(t *testing.T) {
	got := regexEscape("mcp-gateway")
	// hyphen is not a regex metachar here; dot/plus would be escaped.
	if got != "mcp-gateway" {
		t.Errorf("regexEscape(mcp-gateway) = %q", got)
	}
	if regexEscape("a.b+c") != `a\.b\+c` {
		t.Errorf("regexEscape did not escape . or +: %q", regexEscape("a.b+c"))
	}
}

func mustMkdir(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
}

// TestMatchersCoverWriteTools locks in the tool names every client matcher must
// carry. A matcher decides whether the hook runs AT ALL, so a name missing here
// disables every guard inside the hook for that tool, silently and with no error
// anywhere. Two real gaps motivated this test: no matcher listed a write tool,
// so a backend config could be written without the transport guard ever seeing
// it, and Copilot CLI reaches files through str_replace_editor, which no matcher
// entry matched, leaving that client's file access entirely ungated.
func TestMatchersCoverWriteTools(t *testing.T) {
	cases := []struct {
		name    string
		matcher string
		want    []string
	}{
		{"claude", claudeStyleMatcher(), []string{"Read", "Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"}},
		{"codex", codexMatcher(), []string{"shell", "read", "apply_patch"}},
		{"copilot", copilotMatcher(), []string{"bash", "str_replace_editor"}},
		// Gemini CLI's names share nothing with the others. Verified against the
		// 0.46.0 bundle; run_shell_command in particular is the ONLY shell tool
		// it has, so missing it would leave every command ungated.
		{"gemini", geminiMatcher(), []string{
			"run_shell_command", "write_file", "replace", "read_file",
			"read_many_files", "search_file_content", "list_directory",
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			for _, tool := range tc.want {
				re, err := regexp.Compile("^(?:" + tc.matcher + ")$")
				if err != nil {
					t.Fatalf("matcher does not compile: %v", err)
				}
				if !re.MatchString(tool) {
					t.Errorf("%s matcher does not match %q; the hook would never run for it.\nmatcher: %s",
						tc.name, tool, tc.matcher)
				}
			}
		})
	}
}

// TestGeminiHookUsesItsOwnEventName pins the two things that decide whether the
// Gemini hook does anything at all. The event must be "BeforeTool": Gemini
// validates event names and skips an unrecognised one with a warning, so
// writing "PreToolUse" there installs a hook that never fires. And the merge
// must leave the rest of settings.json alone, because unlike every other client
// Gemini keeps its MCP wiring, theme, and auth selection in the SAME file.
func TestGeminiHookUsesItsOwnEventName(t *testing.T) {
	home := t.TempDir()
	geminiDir := filepath.Join(home, ".gemini")
	if err := os.MkdirAll(geminiDir, 0o755); err != nil {
		t.Fatal(err)
	}
	settings := filepath.Join(geminiDir, "settings.json")
	mustWrite(t, settings, []byte(`{"ui":{"theme":"Default"},"mcpServers":{"mcp-gateway":{"type":"http","url":"http://127.0.0.1:3100/mcp"}}}`))

	script := filepath.Join(home, "thesun-hook.mjs")
	mustWrite(t, script, []byte("// hook\n"))

	var target *hookTarget
	for _, tg := range hookTargets(home, home, script, "", "") {
		if tg.client == "Gemini CLI" {
			t := tg
			target = &t
		}
	}
	if target == nil {
		t.Fatal("Gemini CLI is not among the hook targets")
	}
	if !target.detected() {
		t.Fatal("Gemini CLI not detected despite ~/.gemini existing")
	}
	if _, err := target.install(); err != nil {
		t.Fatalf("install: %v", err)
	}

	raw, err := os.ReadFile(settings)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("settings.json is no longer valid JSON: %v", err)
	}

	hooks, ok := doc["hooks"].(map[string]any)
	if !ok {
		t.Fatalf("no hooks block written: %s", raw)
	}
	if _, wrong := hooks["PreToolUse"]; wrong {
		t.Error(`wrote a "PreToolUse" hook; Gemini would skip it as an invalid event name`)
	}
	groups, ok := hooks["BeforeTool"].([]any)
	if !ok || len(groups) == 0 {
		t.Fatalf(`no "BeforeTool" hook group: %+v`, hooks)
	}

	// The user's own settings must survive a hook install.
	if _, ok := doc["ui"]; !ok {
		t.Error("clobbered the ui block")
	}
	servers, ok := doc["mcpServers"].(map[string]any)
	if !ok || servers["mcp-gateway"] == nil {
		t.Error("clobbered the MCP wiring that lives in the same file")
	}

	// Installing twice must not stack duplicate groups.
	if _, err := target.install(); err != nil {
		t.Fatalf("second install: %v", err)
	}
	raw2, _ := os.ReadFile(settings)
	var doc2 map[string]any
	_ = json.Unmarshal(raw2, &doc2)
	h2, _ := doc2["hooks"].(map[string]any)
	g2, _ := h2["BeforeTool"].([]any)
	if len(g2) != len(groups) {
		t.Errorf("hook install is not idempotent: %d groups then %d", len(groups), len(g2))
	}
	if st, _ := target.status(); st != "installed" {
		t.Errorf("status = %q, want installed", st)
	}
}
