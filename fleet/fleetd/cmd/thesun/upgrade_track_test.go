package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// newRepo builds a throwaway origin+clone pair so the tracking logic is tested
// against real git behaviour rather than a mock. The failure modes that matter
// here (divergence, dirty tree, non-fast-forward) are all git's own semantics,
// so faking git would test the fake.
func newRepo(t *testing.T) (origin, clone string) {
	t.Helper()
	base := t.TempDir()
	origin = filepath.Join(base, "origin")
	clone = filepath.Join(base, "clone")

	run := func(dir string, args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@example.com",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@example.com",
		)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
		}
	}

	if err := os.MkdirAll(origin, 0o755); err != nil {
		t.Fatal(err)
	}
	run(origin, "init", "--quiet", "--initial-branch=master")
	if err := os.WriteFile(filepath.Join(origin, "f.txt"), []byte("one\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run(origin, "add", "f.txt")
	run(origin, "commit", "--quiet", "-m", "one")
	run(base, "clone", "--quiet", origin, clone)
	return origin, clone
}

func commitTo(t *testing.T, dir, content, msg string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, "f.txt"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"add", "f.txt"}, {"commit", "--quiet", "-m", msg}} {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@example.com",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@example.com",
		)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
		}
	}
}

// TestUpstreamAndDivergenceAreReadFromTheCheckout proves the updater tracks the
// clone's OWN configured upstream. Hardcoding a remote would silently repoint a
// machine at a host its operator never chose, which for the component that
// enforces policy is not a small thing.
func TestUpstreamAndDivergenceAreReadFromTheCheckout(t *testing.T) {
	origin, clone := newRepo(t)

	up, err := upstreamRef(clone)
	if err != nil {
		t.Fatalf("upstreamRef: %v", err)
	}
	if !strings.HasSuffix(up, "/master") {
		t.Errorf("upstream %q does not name the tracked branch", up)
	}

	commitTo(t, origin, "two\n", "two")
	r, err := checkTrack(clone)
	if err != nil {
		t.Fatalf("checkTrack: %v", err)
	}
	if r.Behind != 1 || r.Ahead != 0 {
		t.Errorf("expected 1 behind / 0 ahead, got %d/%d", r.Behind, r.Ahead)
	}
}

// TestDirtyTreeIsRefused is the guard that protects unfinished work. An
// unattended updater that fast-forwards over local edits either fails noisily or
// entangles someone's work with an update they did not ask for right then.
func TestDirtyTreeIsRefused(t *testing.T) {
	origin, clone := newRepo(t)
	commitTo(t, origin, "two\n", "two")

	if err := os.WriteFile(filepath.Join(clone, "f.txt"), []byte("local edit\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	r, err := checkTrack(clone)
	if err != nil {
		t.Fatal(err)
	}
	before, _ := gitIn(clone, "rev-parse", "HEAD")

	r, err = applyTrack(clone, r, false)
	if err != nil {
		t.Fatalf("applyTrack: %v", err)
	}
	if r.Applied {
		t.Error("updated over a dirty working tree")
	}
	if !strings.Contains(r.Detail, "uncommitted") {
		t.Errorf("the reason must name the dirty tree, got %q", r.Detail)
	}
	after, _ := gitIn(clone, "rev-parse", "HEAD")
	if before != after {
		t.Error("HEAD moved despite the refusal")
	}
	if got, _ := os.ReadFile(filepath.Join(clone, "f.txt")); string(got) != "local edit\n" {
		t.Error("local edit was destroyed")
	}
}

// TestLocalCommitsAreNeverDiscarded: a checkout ahead of upstream has work that
// exists nowhere else. Tracking must decline rather than reset.
func TestLocalCommitsAreNeverDiscarded(t *testing.T) {
	origin, clone := newRepo(t)
	commitTo(t, origin, "upstream\n", "upstream change")
	commitTo(t, clone, "mine\n", "my local commit")

	r, err := checkTrack(clone)
	if err != nil {
		t.Fatal(err)
	}
	if r.Ahead == 0 {
		t.Fatal("test setup produced no local commit")
	}
	head, _ := gitIn(clone, "rev-parse", "HEAD")

	r, err = applyTrack(clone, r, false)
	if err != nil {
		t.Fatal(err)
	}
	if r.Applied {
		t.Error("moved a checkout that had local commits")
	}
	if !strings.Contains(r.Detail, "ahead") {
		t.Errorf("the reason must name the divergence, got %q", r.Detail)
	}
	if now, _ := gitIn(clone, "rev-parse", "HEAD"); now != head {
		t.Error("a local commit was discarded")
	}
}

// TestUpToDateIsANoOp keeps a scheduled run from churning: no fetch result
// should produce a rebuild or a restart when nothing changed.
func TestUpToDateIsANoOp(t *testing.T) {
	_, clone := newRepo(t)
	r, err := checkTrack(clone)
	if err != nil {
		t.Fatal(err)
	}
	if r.Behind != 0 {
		t.Fatalf("fresh clone reported %d behind", r.Behind)
	}
	r, err = applyTrack(clone, r, true)
	if err != nil {
		t.Fatal(err)
	}
	if r.Applied || r.Restart {
		t.Error("an up-to-date checkout was rebuilt or restarted")
	}
}

// TestNonCheckoutIsRejected: a packaged install has no branch, and saying so
// beats failing obscurely inside git or registering a job that can only fail.
func TestNonCheckoutIsRejected(t *testing.T) {
	dir := t.TempDir()
	if _, err := checkTrack(dir); err == nil {
		t.Fatal("a non-git directory was accepted as trackable")
	}
	if isGitCheckout(dir) {
		t.Error("isGitCheckout was true for a plain directory")
	}
}

// TestNoUpstreamIsReportedNotGuessed. A clone with no tracking branch must be
// told, never pointed at whichever remote happens to exist.
func TestNoUpstreamIsReportedNotGuessed(t *testing.T) {
	_, clone := newRepo(t)
	if out, err := exec.Command("git", "-C", clone, "branch", "--unset-upstream").CombinedOutput(); err != nil {
		t.Skipf("cannot unset upstream: %s", out)
	}
	_, err := upstreamRef(clone)
	if err == nil {
		t.Fatal("a checkout with no upstream was accepted")
	}
	if !strings.Contains(err.Error(), "set-upstream") {
		t.Errorf("the error should tell the operator how to fix it: %v", err)
	}
}

// TestBuildGateChecksArtifactsNotExitCode is the regression test for a defect
// found by running the real thing: install.sh prints a per-subsystem failure
// mark and still exits 0, so gating on its exit code meant a broken build was
// accepted and the stack restarted onto it. The gate has to verify the outputs
// the running stack actually loads.
func TestBuildGateChecksArtifactsNotExitCode(t *testing.T) {
	root := t.TempDir()

	// Nothing built yet: both load-bearing artifacts must be reported.
	missing := missingBuildArtifacts(root)
	if len(missing) < 2 {
		t.Fatalf("an empty tree should report the missing binary and gateway dist, got %v", missing)
	}

	mk := func(rel string) {
		t.Helper()
		p := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	mk(filepath.Join("bin", "thesun"))
	mk(filepath.Join("gateway", "dist", "index.js"))
	if got := missingBuildArtifacts(root); len(got) != 0 {
		t.Errorf("a tree with both artifacts should be clean, got %v", got)
	}

	// A checkout that SHIPS the generator but did not build it is also a failed
	// update, and must not read as clean.
	mk(filepath.Join("generator", "package.json"))
	got := missingBuildArtifacts(root)
	if len(got) != 1 || !strings.Contains(got[0], "generator") {
		t.Errorf("an unbuilt generator should be reported, got %v", got)
	}
}

// TestFailedBuildRollsBackAndDoesNotRestart is the property that keeps a bad
// upstream commit from taking a machine down. Verified by pointing the gate at a
// tree whose artifacts are absent, which is exactly the state a failed build
// leaves behind.
//
// The ordering is the safety guarantee: fast-forward, build, verify, and only
// then restart. A machine running the previous good version beats one updated
// into a broken state, so a build that produces nothing must leave the checkout
// where it started and the stack untouched.
func TestFailedBuildRollsBackAndDoesNotRestart(t *testing.T) {
	origin, clone := newRepo(t)
	commitTo(t, origin, "upstream\n", "upstream change")

	r, err := checkTrack(clone)
	if err != nil {
		t.Fatal(err)
	}
	before, _ := gitIn(clone, "rev-parse", "HEAD")

	// The clone has no install.sh, so the build step cannot succeed: this is the
	// same path a real failed build takes.
	r, err = applyTrack(clone, r, true)
	if err != nil {
		t.Fatalf("applyTrack returned a hard error rather than reporting the failure: %v", err)
	}
	if r.Applied {
		t.Error("reported the update as applied despite the build failing")
	}
	if r.Restart {
		t.Error("restarted the stack onto a build that failed")
	}
	if !strings.Contains(r.Detail, "rolled back") {
		t.Errorf("the outcome must say it rolled back, got %q", r.Detail)
	}
	after, _ := gitIn(clone, "rev-parse", "HEAD")
	if after != before {
		t.Errorf("checkout was left at %s instead of rolling back to %s", after, before)
	}
}
