package main

// uninstall_test.go proves removeHome's confirm/dry-run decision without
// touching the OS service manager or the running stack. Each case points
// THESUN_HOME at a fresh temp dir (via t.Setenv, honored by paths.Home) and
// asserts exactly whether that dir survives.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// seedHome makes a temp dir look like a populated THESUN_HOME (a vault file to
// stand in for the encrypted credential store) and points paths.Home at it.
func seedHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("THESUN_HOME", home)
	if err := os.MkdirAll(filepath.Join(home, "vault"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "vault", "vault.json"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	return home
}

func TestRemoveHome_DryRunDeletesNothing(t *testing.T) {
	home := seedHome(t)
	var out strings.Builder

	rc := removeHome(home, false, true, strings.NewReader(""), &out)
	if rc != 0 {
		t.Errorf("dry-run rc = %d, want 0", rc)
	}
	if _, err := os.Stat(home); err != nil {
		t.Errorf("dry-run must not remove THESUN_HOME: %v", err)
	}
	if !strings.Contains(out.String(), "--dry-run: nothing was removed.") {
		t.Errorf("dry-run output missing the no-op notice; got:\n%s", out.String())
	}
}

func TestRemoveHome_NoConfirmationKeepsHome(t *testing.T) {
	home := seedHome(t)
	var out strings.Builder

	// Operator answers "no" — nothing is deleted.
	rc := removeHome(home, false, false, strings.NewReader("no\n"), &out)
	if rc != 0 {
		t.Errorf("declined rc = %d, want 0", rc)
	}
	if _, err := os.Stat(home); err != nil {
		t.Errorf("a declined confirmation must keep THESUN_HOME: %v", err)
	}
	if !strings.Contains(out.String(), "left in place") {
		t.Errorf("declined output missing the cancel notice; got:\n%s", out.String())
	}
}

func TestRemoveHome_EmptyStdinIsFailSafeCancel(t *testing.T) {
	home := seedHome(t)
	var out strings.Builder

	// Non-interactive/closed stdin reads as empty -> must CANCEL, never delete.
	rc := removeHome(home, false, false, strings.NewReader(""), &out)
	if rc != 0 {
		t.Errorf("empty-stdin rc = %d, want 0", rc)
	}
	if _, err := os.Stat(home); err != nil {
		t.Errorf("empty stdin must be a fail-safe cancel, not a delete: %v", err)
	}
}

func TestRemoveHome_TypedYesRemoves(t *testing.T) {
	home := seedHome(t)
	var out strings.Builder

	rc := removeHome(home, false, false, strings.NewReader("yes\n"), &out)
	if rc != 0 {
		t.Errorf("confirmed rc = %d, want 0", rc)
	}
	if _, err := os.Stat(home); !os.IsNotExist(err) {
		t.Errorf("a typed 'yes' must remove THESUN_HOME; stat err = %v", err)
	}
	if !strings.Contains(out.String(), "removed "+home) {
		t.Errorf("confirmed output missing the removed notice; got:\n%s", out.String())
	}
}

func TestRemoveHome_AssumeYesSkipsPromptAndRemoves(t *testing.T) {
	home := seedHome(t)
	var out strings.Builder

	// assumeYes true, empty stdin: --yes must not depend on the prompt.
	rc := removeHome(home, true, false, strings.NewReader(""), &out)
	if rc != 0 {
		t.Errorf("--yes rc = %d, want 0", rc)
	}
	if _, err := os.Stat(home); !os.IsNotExist(err) {
		t.Errorf("--yes must remove THESUN_HOME without a prompt; stat err = %v", err)
	}
}

func TestRemoveHome_MissingHomeIsClean(t *testing.T) {
	home := t.TempDir()
	t.Setenv("THESUN_HOME", home)
	missing := filepath.Join(home, "does-not-exist")
	var out strings.Builder

	rc := removeHome(missing, true, false, strings.NewReader(""), &out)
	if rc != 0 {
		t.Errorf("missing-home rc = %d, want 0", rc)
	}
	if !strings.Contains(out.String(), "nothing to remove") {
		t.Errorf("missing-home output missing the nothing-to-remove notice; got:\n%s", out.String())
	}
}
