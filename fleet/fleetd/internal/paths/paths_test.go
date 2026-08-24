package paths

import (
	"os"
	"path/filepath"
	"testing"
)

// TestHomeOverride: THESUN_HOME is honoured verbatim and every derived path
// hangs off it.
func TestHomeOverride(t *testing.T) {
	root := filepath.Join(t.TempDir(), "thesun-home")
	t.Setenv(EnvHome, root)

	if Home() != root {
		t.Fatalf("Home() = %q, want %q", Home(), root)
	}
	cases := map[string]string{
		Config():              filepath.Join(root, "thesun.toml"),
		LogDir():              filepath.Join(root, "logs"),
		RunDir():              filepath.Join(root, "run"),
		ServersDir():          filepath.Join(root, "servers"),
		VaultDir():            filepath.Join(root, "vault"),
		SocketPath():          filepath.Join(root, "run", "fleetd.sock"),
		PublishedConfigPath(): filepath.Join(root, "run", "gateway-config.json"),
		PidFile("x"):          filepath.Join(root, "run", "x.pid"),
		LogFile("x"):          filepath.Join(root, "logs", "x.log"),
	}
	for got, want := range cases {
		if got != want {
			t.Errorf("path = %q, want %q", got, want)
		}
	}
}

// TestDefaultRootUnderUserConfig: with no override, Home() sits under the OS
// user-config dir and ends in /thesun (cross-platform via filepath).
func TestDefaultRootUnderUserConfig(t *testing.T) {
	t.Setenv(EnvHome, "")
	cfg, err := os.UserConfigDir()
	if err != nil {
		t.Skip("no user config dir on this platform")
	}
	want := filepath.Join(cfg, "thesun")
	if Home() != want {
		t.Fatalf("Home() = %q, want %q", Home(), want)
	}
}

// TestBundleRoot: default is the parent of the binary's dir; env overrides.
func TestBundleRoot(t *testing.T) {
	t.Setenv(EnvBundle, "")
	exe := filepath.Join("/opt", "thesun", "bin", "thesun")
	if got := BundleRoot(exe); got != filepath.Join("/opt", "thesun") {
		t.Fatalf("BundleRoot(%q) = %q", exe, got)
	}
	t.Setenv(EnvBundle, "/custom/bundle")
	if got := BundleRoot(exe); got != "/custom/bundle" {
		t.Fatalf("BundleRoot override = %q", got)
	}
}

// TestEnsureDirs creates the whole tree idempotently.
func TestEnsureDirs(t *testing.T) {
	root := filepath.Join(t.TempDir(), "h")
	t.Setenv(EnvHome, root)
	if err := EnsureDirs(); err != nil {
		t.Fatalf("EnsureDirs: %v", err)
	}
	for _, d := range []string{Home(), LogDir(), RunDir(), ServersDir(), VaultDir()} {
		if fi, err := os.Stat(d); err != nil || !fi.IsDir() {
			t.Errorf("dir %q not created: %v", d, err)
		}
	}
	if err := EnsureDirs(); err != nil {
		t.Fatalf("EnsureDirs second call: %v", err)
	}
}

// TestBundleRootResolvesThroughASymlink is the regression test for a failure
// that reached a real machine.
//
// thesun is normally invoked through a link on PATH
// (~/.local/bin/thesun -> <bundle>/bin/thesun), and os.Executable() returns the
// LINK. Walking up two directories from the link lands on the link's
// grandparent, so the bundle root resolved to ~/.local: install.sh was
// "missing", the checkout was "not a git checkout, so there is no branch to
// track", and the built subsystems were invisible. Every message named a
// plausible-looking path, which is what made it confusing rather than obvious.
func TestBundleRootResolvesThroughASymlink(t *testing.T) {
	base := t.TempDir()
	bundle := filepath.Join(base, "bundle")
	realBin := filepath.Join(bundle, "bin", "thesun")
	if err := os.MkdirAll(filepath.Dir(realBin), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(realBin, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	linkDir := filepath.Join(base, "dotlocal", "bin")
	if err := os.MkdirAll(linkDir, 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(linkDir, "thesun")
	if err := os.Symlink(realBin, link); err != nil {
		t.Skipf("symlinks unavailable on this platform: %v", err)
	}

	// The env override must still win, or an operator cannot point a run at a
	// different bundle.
	t.Setenv(EnvBundle, "")

	got := BundleRoot(link)
	want, err := filepath.EvalSymlinks(bundle)
	if err != nil {
		want = bundle
	}
	if got != want {
		t.Errorf("BundleRoot(<symlink>) = %q, want the real bundle %q; every bundle-relative path would point at the wrong tree", got, want)
	}
	if filepath.Base(got) == "dotlocal" {
		t.Error("resolved to the symlink's grandparent, which is the exact bug this guards")
	}
}

// TestBundleRootStillHonoursTheEnvOverride: resolution must not override an
// explicit THESUN_BUNDLE, which is how a run is pointed at a non-default tree.
func TestBundleRootStillHonoursTheEnvOverride(t *testing.T) {
	t.Setenv(EnvBundle, "/explicit/bundle")
	if got := BundleRoot("/anywhere/bin/thesun"); got != "/explicit/bundle" {
		t.Errorf("env override ignored: got %q", got)
	}
}
