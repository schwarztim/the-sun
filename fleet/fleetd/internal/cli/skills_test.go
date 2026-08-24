package cli

import (
	"os"
	"path/filepath"
	"testing"

	"mcp-fleet/fleetd/internal/paths"
)

// TestSkillTargets_DetectionAndResolution mirrors TestHookTargets: an empty home
// detects nothing; creating each client's marker dir turns detection on. It also
// asserts each client's destination path is the Agent-Skills-standard
// <skills-root>/thesun/SKILL.md.
func TestSkillTargets_DetectionAndResolution(t *testing.T) {
	home := t.TempDir()
	// Nothing present yet — every client not-detected.
	for _, tg := range skillTargets(home) {
		if tg.detected() {
			t.Errorf("%s should NOT be detected on an empty home", tg.client)
		}
	}

	// Create each client's marker dir (Codex is detected by ~/.codex even though
	// it reads skills from ~/.agents/skills).
	mustMkdir(t, filepath.Join(home, ".claude"))
	mustMkdir(t, filepath.Join(home, ".copilot"))
	mustMkdir(t, filepath.Join(home, ".codex"))
	mustMkdir(t, filepath.Join(home, ".config", "opencode"))

	wantPath := map[string]string{
		"Claude Code":        filepath.Join(home, ".claude", "skills", "thesun", "SKILL.md"),
		"OpenAI Codex CLI":   filepath.Join(home, ".agents", "skills", "thesun", "SKILL.md"),
		"GitHub Copilot CLI": filepath.Join(home, ".copilot", "skills", "thesun", "SKILL.md"),
		"OpenCode":           filepath.Join(home, ".config", "opencode", "skills", "thesun", "SKILL.md"),
	}
	detected := map[string]bool{}
	for _, tg := range skillTargets(home) {
		detected[tg.client] = tg.detected()
		if want := wantPath[tg.client]; want != "" && tg.path != want {
			t.Errorf("%s path = %q, want %q", tg.client, tg.path, want)
		}
	}
	for want := range wantPath {
		if !detected[want] {
			t.Errorf("%s should be detected after its dir was created", want)
		}
	}
}

// TestClaudeDetectedByGlobalJSON confirms Claude Code is detected via the
// ~/.claude.json fallback even when the ~/.claude dir is absent.
func TestClaudeDetectedByGlobalJSON(t *testing.T) {
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, ".claude.json"), []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, tg := range skillTargets(home) {
		if tg.client == "Claude Code" && !tg.detected() {
			t.Error("Claude Code should be detected when ~/.claude.json exists")
		}
	}
}

// TestCopySkillFile_CreatesAndIsIdempotent: first copy writes, second is a no-op.
func TestCopySkillFile_CreatesAndIsIdempotent(t *testing.T) {
	src := writePackagedSkill(t, "---\nname: thesun\n---\nbody v1\n")
	dst := filepath.Join(t.TempDir(), "skills", "thesun", "SKILL.md")

	changed, err := copySkillFile(src, dst)
	if err != nil {
		t.Fatalf("install: %v", err)
	}
	if !changed {
		t.Fatal("first install should report changed=true")
	}
	got, err := os.ReadFile(dst)
	if err != nil {
		t.Fatalf("read dst: %v", err)
	}
	srcBytes, _ := os.ReadFile(src)
	if string(got) != string(srcBytes) {
		t.Fatal("copied file bytes differ from packaged source (must be verbatim)")
	}
	if st, _ := skillFileStatus(dst, src); st != "installed" {
		t.Fatalf("status after install = %q, want installed", st)
	}

	// Idempotent: second run makes no change.
	changed, err = copySkillFile(src, dst)
	if err != nil {
		t.Fatalf("second install: %v", err)
	}
	if changed {
		t.Fatal("second install should be a no-op (changed=false)")
	}
}

// TestCopySkillFile_BaksOnForeignOccupant: a pre-existing different file at the
// destination is backed up to .bak before being overwritten.
func TestCopySkillFile_BaksOnForeignOccupant(t *testing.T) {
	src := writePackagedSkill(t, "---\nname: thesun\n---\npackaged\n")
	dstDir := filepath.Join(t.TempDir(), "skills", "thesun")
	mustMkdir(t, dstDir)
	dst := filepath.Join(dstDir, "SKILL.md")

	foreign := []byte("operator's own skill\n")
	if err := os.WriteFile(dst, foreign, 0o644); err != nil {
		t.Fatal(err)
	}

	changed, err := copySkillFile(src, dst)
	if err != nil || !changed {
		t.Fatalf("install over foreign file: changed=%v err=%v", changed, err)
	}
	// The .bak must hold the ORIGINAL foreign content.
	bak, err := os.ReadFile(dst + ".bak")
	if err != nil {
		t.Fatalf("expected %s.bak backup, got: %v", dst, err)
	}
	if string(bak) != string(foreign) {
		t.Errorf(".bak content = %q, want the original foreign file", string(bak))
	}
	// The destination now holds the packaged content.
	srcBytes, _ := os.ReadFile(src)
	got, _ := os.ReadFile(dst)
	if string(got) != string(srcBytes) {
		t.Error("destination was not overwritten with the packaged skill")
	}
}

// TestSkillFileStatus_DriftAndNotInstalled covers not-installed and drift.
func TestSkillFileStatus_DriftAndNotInstalled(t *testing.T) {
	src := writePackagedSkill(t, "---\nname: thesun\n---\nv2\n")
	dst := filepath.Join(t.TempDir(), "skills", "thesun", "SKILL.md")

	if st, _ := skillFileStatus(dst, src); st != "not-installed" {
		t.Fatalf("status on missing dst = %q, want not-installed", st)
	}
	// Install an OLDER body, then compare against the current (v2) source → drift.
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dst, []byte("---\nname: thesun\n---\nv1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if st, _ := skillFileStatus(dst, src); st != "drift" {
		t.Fatalf("status with stale dst = %q, want drift", st)
	}
	// Re-copy clears drift.
	if _, err := copySkillFile(src, dst); err != nil {
		t.Fatal(err)
	}
	if st, _ := skillFileStatus(dst, src); st != "installed" {
		t.Fatalf("status after re-copy = %q, want installed", st)
	}
}

// TestBundleSkillFile_Resolution asserts the packaged skill is resolved under
// <bundle>/packaging/skills/thesun/SKILL.md, honoring THESUN_BUNDLE (the same
// bundle-root logic hooks.go uses for packaging/hooks).
func TestBundleSkillFile_Resolution(t *testing.T) {
	bundle := t.TempDir()
	t.Setenv(paths.EnvBundle, bundle)
	got := bundleSkillFile()
	want := filepath.Join(bundle, "packaging", "skills", "thesun", "SKILL.md")
	if got != want {
		t.Fatalf("bundleSkillFile() = %q, want %q", got, want)
	}
}

// writePackagedSkill writes body to a temp file and returns its path (a stand-in
// for the packaged packaging/skills/thesun/SKILL.md).
func writePackagedSkill(t *testing.T, body string) string {
	t.Helper()
	dir := t.TempDir()
	p := filepath.Join(dir, "SKILL.md")
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}
