package main

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"mcp-fleet/fleetd/internal/registry"
)

// writeFakeBinary drops a file that stands in for a released server binary and
// returns its path plus its real sha256. Synthetic content only.
func writeFakeBinary(t *testing.T) (path, sum string) {
	t.Helper()
	dir := t.TempDir()
	path = filepath.Join(dir, "demo-mcp")
	content := []byte("#!/bin/sh\necho synthetic test binary\n")
	if err := os.WriteFile(path, content, 0o755); err != nil {
		t.Fatal(err)
	}
	h := sha256.Sum256(content)
	return path, hex.EncodeToString(h[:])
}

// TestVerifiedDownloadRefusesSha256Mismatch proves the preflight gate that makes
// `thesun update` non-destructive. update used to remove the installed server
// from the manifest and only then run this chain, so a mismatch, a bad
// signature, or a network error dropped the server from the fleet entirely. The
// chain must refuse and install nothing, which is what lets update verify first
// and swap second.
func TestVerifiedDownloadRefusesSha256Mismatch(t *testing.T) {
	path, _ := writeFakeBinary(t)

	entry := &registry.Entry{Name: "demo", Tier: "community"}
	v := &registry.Version{Version: "1.0.0"}
	plat := &registry.Platform{
		OS:     runtime.GOOS,
		Arch:   runtime.GOARCH,
		URL:    "file://" + path,
		SHA256: strings.Repeat("ab", 32), // deliberately not the real digest
	}

	got, cleanup, err := verifiedDownload(entry, v, plat, "demo")
	defer cleanup()
	if err == nil {
		t.Fatal("verifiedDownload accepted a binary whose sha256 does not match the index; the fail-closed chain must refuse it")
	}
	if !strings.Contains(err.Error(), "sha256 mismatch") {
		t.Errorf("error must name the sha256 mismatch, got: %v", err)
	}
	if got != "" {
		t.Errorf("a refused download must return no path, got %q", got)
	}
}

// TestVerifiedDownloadAcceptsMatchingSha256 is the other half: a community
// entry whose digest matches installs (with the unsigned warning), so the
// preflight does not simply refuse everything.
func TestVerifiedDownloadAcceptsMatchingSha256(t *testing.T) {
	path, sum := writeFakeBinary(t)

	entry := &registry.Entry{Name: "demo", Tier: "community"}
	v := &registry.Version{Version: "1.0.0"}
	plat := &registry.Platform{OS: runtime.GOOS, Arch: runtime.GOARCH, URL: "file://" + path, SHA256: sum}

	got, cleanup, err := verifiedDownload(entry, v, plat, "demo")
	defer cleanup()
	if err != nil {
		t.Fatalf("verifiedDownload rejected a matching binary: %v", err)
	}
	if _, statErr := os.Stat(got); statErr != nil {
		t.Fatalf("verified binary missing at %q: %v", got, statErr)
	}
}

// TestVerifiedDownloadRefusesCuratedWithoutSignature pins the curated rule: no
// verifying signature, no install, regardless of a matching digest.
func TestVerifiedDownloadRefusesCuratedWithoutSignature(t *testing.T) {
	path, sum := writeFakeBinary(t)

	entry := &registry.Entry{Name: "demo", Tier: "curated"}
	v := &registry.Version{Version: "1.0.0"} // no Ed25519Sig
	plat := &registry.Platform{OS: runtime.GOOS, Arch: runtime.GOARCH, URL: "file://" + path, SHA256: sum}

	_, cleanup, err := verifiedDownload(entry, v, plat, "demo")
	defer cleanup()
	if err == nil {
		t.Fatal("a curated entry with no verifying signature must be refused even when the sha256 matches")
	}
	if !strings.Contains(err.Error(), "signature") {
		t.Errorf("error must name the signature failure, got: %v", err)
	}
}
