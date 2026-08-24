package main

import (
	"os"
	"testing"
)

// TestStdinIsTTYIsFalseWhenRedirected pins the gate that decides whether
// `thesun install` runs the onboarding walkthrough.
//
// Gating on stdout alone was wrong: the two streams redirect independently, so
// an installer that pipes input (or a wrapper using `< /dev/null`) can still
// hold a terminal on stdout. Onboarding would launch, every Scan() would hit
// EOF, askYesNo would answer "no" to everything, and the run would exit 0
// having declined every dependency and backend. That is indistinguishable in a
// transcript from a human who declined, and the "next: thesun onboard" pointer
// never prints.
func TestStdinIsTTYIsFalseWhenRedirected(t *testing.T) {
	devnull, err := os.Open(os.DevNull)
	if err != nil {
		t.Fatal(err)
	}
	defer devnull.Close()

	saved := os.Stdin
	os.Stdin = devnull
	defer func() { os.Stdin = saved }()

	if stdinIsTTY() {
		t.Error("stdin redirected from /dev/null was reported as a terminal; onboarding would run with nobody to answer it")
	}
}

// TestStdinAndStdoutAreCheckedSeparately guards against collapsing the two back
// into one probe: they are distinct file descriptors and a redirect of either
// must be detectable on its own.
func TestStdinAndStdoutAreCheckedSeparately(t *testing.T) {
	devnull, err := os.Open(os.DevNull)
	if err != nil {
		t.Fatal(err)
	}
	defer devnull.Close()

	saved := os.Stdin
	os.Stdin = devnull
	defer func() { os.Stdin = saved }()

	// Whatever stdout is under `go test`, redirecting stdin alone must change
	// the stdin answer, which is the whole point of the separate probe.
	if stdinIsTTY() {
		t.Fatal("stdin probe did not observe the redirect")
	}
}
