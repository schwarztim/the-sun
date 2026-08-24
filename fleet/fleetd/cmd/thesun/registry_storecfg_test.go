package main

// registry_storecfg_test.go proves the store index/host/cred resolution honors
// the machine-local THESUN_HOME/store.toml as a fallback, with env taking
// precedence, and a missing file falling through to the compiled default.

import (
	"os"
	"path/filepath"
	"testing"
)

func writeStoreToml(t *testing.T, home, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(home, "store.toml"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestStoreConfigFallbackAndEnvPrecedence(t *testing.T) {
	home := t.TempDir()
	t.Setenv("THESUN_HOME", home)
	// Ensure no ambient env leaks into the test.
	t.Setenv("THESUN_REGISTRY_INDEX", "")
	t.Setenv("THESUN_STASH_HOST", "")
	t.Setenv("THESUN_STASH_CRED", "")

	// No file yet: index falls through to the compiled default; host/cred are
	// their defaults.
	if got := registryIndexRef(""); got != defaultRegistryIndex {
		t.Fatalf("no store.toml: want default index, got %q", got)
	}
	if got := stashHost(); got != "" {
		t.Fatalf("no store.toml: want empty stash host, got %q", got)
	}

	// store.toml provides all three when env is unset.
	writeStoreToml(t, home, `
index = "https://internal.example.com/rest/api/1.0/projects/EXAMPLE-ORG/repos/thesun-registry/raw/index.toml?at=refs/heads/master"
stash_host = "internal.example.com"
stash_cred = "hermescred://stash/pat"
`)
	if got := registryIndexRef(""); got == defaultRegistryIndex || got == "" {
		t.Fatalf("store.toml index not used: got %q", got)
	}
	if got := stashHost(); got != "internal.example.com" {
		t.Fatalf("store.toml stash_host not used: got %q", got)
	}
	if got := stashCredRef(); got != "hermescred://stash/pat" {
		t.Fatalf("store.toml stash_cred not used: got %q", got)
	}

	// The --index flag and env override the file.
	if got := registryIndexRef("./local.toml"); got != "./local.toml" {
		t.Fatalf("flag must win over store.toml: got %q", got)
	}
	t.Setenv("THESUN_REGISTRY_INDEX", "https://env.example.com/index.toml")
	if got := registryIndexRef(""); got != "https://env.example.com/index.toml" {
		t.Fatalf("env must win over store.toml: got %q", got)
	}
	t.Setenv("THESUN_STASH_HOST", "env.example.com")
	if got := stashHost(); got != "env.example.com" {
		t.Fatalf("env must win over store.toml host: got %q", got)
	}
}
