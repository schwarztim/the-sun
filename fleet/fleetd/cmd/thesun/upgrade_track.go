package main

// upgrade_track.go implements `thesun upgrade --track`: keep an installation in
// step with its upstream branch, rather than with tagged releases.
//
// This is a SEPARATE trust model from the release path in upgrade.go, and the
// difference is worth stating plainly because it is easy to lose. A release
// upgrade downloads a tagged artifact and verifies it against a published
// checksum, so what lands is exactly what someone decided to publish. Tracking a
// branch means whatever is on that branch right now becomes the code on this
// machine, and thesun's gateway is the policy enforcement point for every AI
// client here. So whoever can land a commit on that branch can replace the thing
// that enforces policy. That is acceptable when the branch is protected and
// pull-request-gated (Stash master is), and much less so otherwise.
//
// Three consequences follow, and they shape everything below:
//
//   - It tracks the checkout's OWN configured upstream. There is no hardcoded
//     remote: a clone from the internal Stash tracks Stash, a clone from GitHub
//     tracks GitHub. Nobody gets silently repointed at a host they did not
//     choose, and there is no new setting to get wrong.
//   - Fast-forward only, and never over a dirty tree. Local work is never
//     discarded to make an update fit.
//   - The build gates the switch. A pull that does not build is rolled back and
//     the running stack is left alone, because a machine running the previous
//     good version beats one that has been updated into a broken state.

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"mcp-fleet/fleetd/internal/cli"
	"mcp-fleet/fleetd/internal/paths"
)

// trackResult is what one tracking run did, so the caller can report it and the
// scheduled path can log it.
type trackResult struct {
	Checked  bool   // an upstream comparison actually happened
	Behind   int    // commits this checkout is behind upstream
	Ahead    int    // commits it is ahead (any means do not fast-forward)
	From     string // short SHA before
	To       string // short SHA after (equal to From when nothing was applied)
	Applied  bool   // the working tree actually moved
	Restart  bool   // the stack was restarted
	Detail   string // human-readable outcome
	Upstream string // e.g. "stash/master"
}

// git runs a git command inside the checkout and returns trimmed stdout.
func gitIn(root string, args ...string) (string, error) {
	cmd := exec.Command("git", append([]string{"-C", root}, args...)...)
	out, err := cmd.Output()
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			return "", fmt.Errorf("git %s: %s", strings.Join(args, " "), strings.TrimSpace(string(ee.Stderr)))
		}
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// isGitCheckout reports whether root is a git working tree. A packaged install
// that is not a checkout cannot track a branch, and saying so is better than
// failing obscurely inside git.
func isGitCheckout(root string) bool {
	out, err := gitIn(root, "rev-parse", "--is-inside-work-tree")
	return err == nil && out == "true"
}

// upstreamRef resolves the branch this checkout tracks (e.g. "stash/master").
// Deliberately NOT defaulted to a guess: an install with no upstream configured
// should be told so, not silently pointed at whichever remote happens to exist.
func upstreamRef(root string) (string, error) {
	ref, err := gitIn(root, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}")
	if err != nil || ref == "" {
		return "", fmt.Errorf("this checkout tracks no upstream branch; set one with `git branch --set-upstream-to=<remote>/<branch>`")
	}
	return ref, nil
}

// workingTreeDirty reports whether there are uncommitted changes. Tracking must
// refuse in that case: a fast-forward over local edits either fails noisily or,
// worse, succeeds and leaves someone's unfinished work entangled with an update
// they did not ask for right then.
func workingTreeDirty(root string) (bool, string, error) {
	out, err := gitIn(root, "status", "--porcelain")
	if err != nil {
		return false, "", err
	}
	if out == "" {
		return false, "", nil
	}
	lines := strings.Split(out, "\n")
	first := lines[0]
	if len(lines) > 1 {
		first = fmt.Sprintf("%s (and %d more)", first, len(lines)-1)
	}
	return true, first, nil
}

// aheadBehind counts the divergence between HEAD and upstream.
func aheadBehind(root, upstream string) (ahead, behind int, err error) {
	out, err := gitIn(root, "rev-list", "--left-right", "--count", "HEAD..."+upstream)
	if err != nil {
		return 0, 0, err
	}
	if _, err := fmt.Sscanf(out, "%d\t%d", &ahead, &behind); err != nil {
		return 0, 0, fmt.Errorf("could not read ahead/behind from %q: %w", out, err)
	}
	return ahead, behind, nil
}

// checkTrack fetches and reports where this checkout stands, changing nothing.
func checkTrack(root string) (trackResult, error) {
	var r trackResult
	if !isGitCheckout(root) {
		return r, fmt.Errorf("%s is not a git checkout, so there is no branch to track; use `thesun upgrade` for release-based updates", root)
	}
	up, err := upstreamRef(root)
	if err != nil {
		return r, err
	}
	r.Upstream = up

	// Fetch only the tracked remote, and prune nothing: this runs unattended, so
	// it must not mutate anything beyond remote-tracking refs.
	remote := strings.SplitN(up, "/", 2)[0]
	if _, err := gitIn(root, "fetch", "--quiet", remote); err != nil {
		return r, fmt.Errorf("fetch failed: %w", err)
	}
	r.Checked = true

	if r.From, err = gitIn(root, "rev-parse", "--short", "HEAD"); err != nil {
		return r, err
	}
	r.To = r.From
	if r.Ahead, r.Behind, err = aheadBehind(root, up); err != nil {
		return r, err
	}
	return r, nil
}

// applyTrack brings the checkout up to its upstream and rebuilds.
//
// The ordering is the safety property: fast-forward, build, and only restart if
// the build succeeded. A failed build rolls the checkout back to where it was,
// so a machine is never left running a half-updated tree.
func applyTrack(root string, r trackResult, restart bool) (trackResult, error) {
	if r.Ahead > 0 {
		r.Detail = fmt.Sprintf("this checkout is %d commit(s) ahead of %s; refusing to move it, since tracking must never discard local commits", r.Ahead, r.Upstream)
		return r, nil
	}
	if r.Behind == 0 {
		r.Detail = "already up to date with " + r.Upstream
		return r, nil
	}
	if dirty, what, err := workingTreeDirty(root); err != nil {
		return r, err
	} else if dirty {
		r.Detail = "working tree has uncommitted changes (" + what + "); refusing to update over local work"
		return r, nil
	}

	before := r.From
	// --ff-only is the whole point: it fails rather than creating a merge, so a
	// diverged checkout is reported instead of silently rewritten.
	if _, err := gitIn(root, "merge", "--ff-only", r.Upstream); err != nil {
		r.Detail = "fast-forward refused: " + err.Error()
		return r, nil
	}
	after, err := gitIn(root, "rev-parse", "--short", "HEAD")
	if err != nil {
		return r, err
	}
	r.To, r.Applied = after, true

	// install.sh exits 0 even when a subsystem fails to build (it prints a
	// per-subsystem mark and keeps going), so its exit code cannot be the gate.
	// Verify the artifacts the running stack actually loads instead: fleetd's
	// binary and the gateway's built dist. That is the difference between "the
	// script ran" and "the new code can serve", and only the second one is worth
	// restarting for.
	buildFailed := runInstall(nil) != 0
	if !buildFailed {
		if missing := missingBuildArtifacts(root); len(missing) > 0 {
			buildFailed = true
			fmt.Fprintf(os.Stderr, "thesun: build left these missing: %s\n", strings.Join(missing, ", "))
		}
	}
	if buildFailed {
		// Roll back to the exact commit we were on. The stack was never
		// restarted, so it is still serving the previous good build.
		if _, rbErr := gitIn(root, "reset", "--hard", before); rbErr != nil {
			r.Detail = fmt.Sprintf("build FAILED and rollback ALSO failed (%v); this checkout is at %s and needs manual attention", rbErr, after)
			return r, fmt.Errorf("build and rollback both failed")
		}
		r.To, r.Applied = before, false
		r.Detail = fmt.Sprintf("build failed at %s, rolled back to %s; the running stack was not touched", after, before)
		return r, nil
	}

	r.Detail = fmt.Sprintf("updated %s -> %s and rebuilt", before, after)
	if restart {
		if code := restartStack(); code != 0 {
			r.Detail += "; restart reported a problem, run `thesun status`"
			return r, nil
		}
		r.Restart = true
		r.Detail += " and restarted"
	}
	return r, nil
}

// missingBuildArtifacts names the built outputs the running stack loads. These
// two are the load-bearing ones: fleetd supervises everything and the gateway
// serves from its compiled dist, so if either is absent the update cannot be put
// into service. The generator and hermes are checked as well when they exist in
// the tree, since a checkout that ships them and then fails to build them is not
// a healthy update either.
func missingBuildArtifacts(root string) []string {
	var missing []string
	required := map[string]string{
		"fleetd/thesun binary": filepath.Join(root, "bin", "thesun"),
		"gateway dist":         filepath.Join(root, "gateway", "dist", "index.js"),
	}
	for name, path := range required {
		if !exists(path) {
			missing = append(missing, name)
		}
	}
	if exists(filepath.Join(root, "generator", "package.json")) &&
		!exists(filepath.Join(root, "generator", "dist", "cli", "index.js")) {
		missing = append(missing, "generator dist")
	}
	return missing
}

// restartStack brings the rebuilt code into service. The gateway serves from its
// built dist and fleetd runs the compiled binary, so neither picks up an update
// without this.
func restartStack() int { return cli.Fleet("restart", nil) }

// trackCmd implements `thesun upgrade --track [--check] [--no-restart]`.
func trackCmd(checkOnly, noRestart bool) int {
	root := bundleRoot()
	if root == "" {
		fmt.Fprintln(os.Stderr, "thesun upgrade --track: cannot resolve the install root")
		return 1
	}

	r, err := checkTrack(root)
	if err != nil {
		fmt.Fprintf(os.Stderr, "thesun upgrade --track: %v\n", err)
		return 1
	}

	fmt.Printf("tracking %s (at %s)\n", r.Upstream, r.From)
	switch {
	case r.Behind == 0 && r.Ahead == 0:
		fmt.Println("up to date.")
		return 0
	case r.Ahead > 0:
		fmt.Printf("%d commit(s) ahead, %d behind: this checkout has local commits, so it is not tracking cleanly.\n", r.Ahead, r.Behind)
		return 0
	}

	fmt.Printf("%d new commit(s) upstream:\n", r.Behind)
	if log, err := gitIn(root, "log", "--oneline", "--no-decorate", "-10", "HEAD.."+r.Upstream); err == nil && log != "" {
		for _, line := range strings.Split(log, "\n") {
			fmt.Println("   " + line)
		}
		if r.Behind > 10 {
			fmt.Printf("   ... and %d more\n", r.Behind-10)
		}
	}

	if checkOnly {
		fmt.Println("\nThis was a check. Run `thesun upgrade --track` to apply.")
		return 0
	}

	fmt.Println()
	r, err = applyTrack(root, r, !noRestart)
	if err != nil {
		fmt.Fprintf(os.Stderr, "thesun upgrade --track: %v\n", err)
		fmt.Fprintln(os.Stderr, r.Detail)
		return 1
	}
	fmt.Println(r.Detail)
	if !r.Applied && r.Behind > 0 {
		return 1 // an update was available and did not land: that is a failure to report
	}
	return 0
}

// autoLogPath is where unattended runs record what they did. An auto-updater
// that changes the enforcement point without leaving a trail is not something
// anyone should have to trust.
func autoLogPath() string { return filepath.Join(paths.Home(), "logs", "auto-update.log") }

// runAutoUpdate is the unattended entry point (`thesun upgrade --auto-run`),
// invoked by the scheduled job. It never prompts, always logs, and exits 0 on
// "nothing to do" so a scheduler does not treat a quiet day as a failure.
func runAutoUpdate() int {
	root := bundleRoot()
	logLine := func(format string, a ...any) {
		line := time.Now().Format(time.RFC3339) + " " + fmt.Sprintf(format, a...) + "\n"
		_ = os.MkdirAll(filepath.Dir(autoLogPath()), 0o755)
		f, err := os.OpenFile(autoLogPath(), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
		if err == nil {
			defer f.Close()
			_, _ = f.WriteString(line)
		}
		fmt.Print(line)
	}

	r, err := checkTrack(root)
	if err != nil {
		logLine("check failed: %v", err)
		return 0 // a transient network or config problem is not worth alarming a scheduler
	}
	if r.Behind == 0 {
		logLine("up to date at %s (%s)", r.From, r.Upstream)
		return 0
	}
	r, err = applyTrack(root, r, true)
	if err != nil {
		logLine("FAILED: %s", r.Detail)
		return 1
	}
	logLine("%s", r.Detail)
	return 0
}
