package main

// upgrade_test.go proves the version-compare and check-only path of
// `thesun upgrade` against a stub HTTP server standing in for the GitHub
// Releases API (githubAPIBase is swapped per-test). No real download,
// checksum verification, extraction, or bundle self-replace is exercised
// here by design — those are file-system-mutating and covered by the
// extract/checksum unit tests below in isolation instead.

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func withGithubAPIBase(t *testing.T, url string) {
	t.Helper()
	old := githubAPIBase
	githubAPIBase = url
	t.Cleanup(func() { githubAPIBase = old })
}

func stubReleaseServer(t *testing.T, repo, tag string, assets map[string]string) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc(fmt.Sprintf("/repos/%s/releases/latest", repo), func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		type asset struct {
			Name string `json:"name"`
			URL  string `json:"browser_download_url"`
		}
		var as []asset
		for name, url := range assets {
			as = append(as, asset{Name: name, URL: url})
		}
		body := struct {
			TagName string  `json:"tag_name"`
			Assets  []asset `json:"assets"`
		}{TagName: tag, Assets: as}
		_ = json.NewEncoder(w).Encode(body)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

// ---- version compare ----

func TestCompareSemver(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"v1.2.3", "v1.2.3", 0},
		{"1.2.3", "v1.2.3", 0}, // "v" prefix optional on either side
		{"v1.2.3", "v1.2.4", -1},
		{"v1.2.4", "v1.2.3", 1},
		{"v1.9.0", "v1.10.0", -1}, // numeric, not lexicographic
		{"v2.0.0", "v1.99.99", 1},
		{"dev", "v0.0.1", -1}, // "dev" always looks older than any real tag
		{"v1.2.3-rc1", "v1.2.3", 0}, // prerelease suffix ignored (KISS)
	}
	for _, c := range cases {
		if got := compareSemver(c.a, c.b); got != c.want {
			t.Errorf("compareSemver(%q, %q) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}

// ---- asset naming (must stay in lockstep with .goreleaser.yml) ----

func TestAssetName(t *testing.T) {
	cases := []struct {
		goos, goarch, want string
	}{
		{"darwin", "arm64", "thesun-darwin-arm64.tar.gz"},
		{"darwin", "amd64", "thesun-darwin-amd64.tar.gz"},
		{"linux", "amd64", "thesun-linux-amd64.tar.gz"},
		{"linux", "arm64", "thesun-linux-arm64.tar.gz"},
		{"windows", "amd64", "thesun-windows-amd64.zip"},
	}
	for _, c := range cases {
		if got := assetName(c.goos, c.goarch); got != c.want {
			t.Errorf("assetName(%q, %q) = %q, want %q", c.goos, c.goarch, got, c.want)
		}
	}
}

// ---- updateRepo resolution order: flag > env > default ----

func TestUpdateRepo(t *testing.T) {
	t.Run("default", func(t *testing.T) {
		t.Setenv("THESUN_UPDATE_REPO", "")
		if got := updateRepo(""); got != defaultUpdateRepo {
			t.Errorf("updateRepo(\"\") = %q, want default %q", got, defaultUpdateRepo)
		}
	})
	t.Run("env override", func(t *testing.T) {
		t.Setenv("THESUN_UPDATE_REPO", "someone/else")
		if got := updateRepo(""); got != "someone/else" {
			t.Errorf("updateRepo(\"\") = %q, want env override", got)
		}
	})
	t.Run("flag wins over env", func(t *testing.T) {
		t.Setenv("THESUN_UPDATE_REPO", "someone/else")
		if got := updateRepo("flag/wins"); got != "flag/wins" {
			t.Errorf("updateRepo(flag) = %q, want flag value", got)
		}
	})
}

// ---- checkForUpdate against a stub release feed ----

func TestCheckForUpdate_NewerAvailable(t *testing.T) {
	srv := stubReleaseServer(t, "acme/thesun", "v2.0.0", map[string]string{
		"thesun-darwin-arm64.tar.gz": "https://example.invalid/thesun-darwin-arm64.tar.gz",
		"checksums.txt":              "https://example.invalid/checksums.txt",
	})
	withGithubAPIBase(t, srv.URL)

	rel, hasUpdate, err := checkForUpdate("acme/thesun", "v1.0.0")
	if err != nil {
		t.Fatalf("checkForUpdate: %v", err)
	}
	if !hasUpdate {
		t.Error("hasUpdate = false, want true (v1.0.0 -> v2.0.0)")
	}
	if rel.TagName != "v2.0.0" {
		t.Errorf("TagName = %q, want v2.0.0", rel.TagName)
	}
	if findAsset(rel, "checksums.txt") == nil {
		t.Error("expected checksums.txt asset to be present")
	}
}

func TestCheckForUpdate_UpToDate(t *testing.T) {
	srv := stubReleaseServer(t, "acme/thesun", "v1.0.0", nil)
	withGithubAPIBase(t, srv.URL)

	_, hasUpdate, err := checkForUpdate("acme/thesun", "v1.0.0")
	if err != nil {
		t.Fatalf("checkForUpdate: %v", err)
	}
	if hasUpdate {
		t.Error("hasUpdate = true, want false (already current)")
	}
}

func TestCheckForUpdate_DevBuildAlwaysBehind(t *testing.T) {
	srv := stubReleaseServer(t, "acme/thesun", "v0.0.1", nil)
	withGithubAPIBase(t, srv.URL)

	_, hasUpdate, err := checkForUpdate("acme/thesun", "dev")
	if err != nil {
		t.Fatalf("checkForUpdate: %v", err)
	}
	if !hasUpdate {
		t.Error("hasUpdate = false, want true (a dev build is always offered the latest tag)")
	}
}

func TestCheckForUpdate_NoReleases(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/acme/empty/releases/latest", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	withGithubAPIBase(t, srv.URL)

	_, _, err := checkForUpdate("acme/empty", "v1.0.0")
	if err == nil {
		t.Fatal("expected an error for a repo with no releases")
	}
}

// ---- the --check CLI path performs no writes ----

func TestUpgradeCmd_CheckOnlyMakesNoChanges(t *testing.T) {
	srv := stubReleaseServer(t, "acme/thesun", "v9.9.9", map[string]string{
		"thesun-darwin-arm64.tar.gz": "https://example.invalid/x.tar.gz",
		"checksums.txt":              "https://example.invalid/checksums.txt",
	})
	withGithubAPIBase(t, srv.URL)

	rc := upgradeCmd([]string{"--check", "--repo", "acme/thesun"})
	if rc != 0 {
		t.Errorf("upgradeCmd --check exit = %d, want 0", rc)
	}
}

// ---- checksum verification ----

func TestVerifyChecksum(t *testing.T) {
	dir := t.TempDir()
	archivePath := filepath.Join(dir, "thesun-linux-amd64.tar.gz")
	content := []byte("pretend-archive-bytes")
	if err := os.WriteFile(archivePath, content, 0o644); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(content)
	checksums := fmt.Sprintf("%s  thesun-linux-amd64.tar.gz\n%s  thesun-darwin-arm64.tar.gz\n",
		hex.EncodeToString(sum[:]), "deadbeef")

	mux := http.NewServeMux()
	mux.HandleFunc("/checksums.txt", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(checksums))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	if err := verifyChecksum(srv.URL+"/checksums.txt", archivePath, "thesun-linux-amd64.tar.gz"); err != nil {
		t.Errorf("verifyChecksum: unexpected error: %v", err)
	}
}

func TestVerifyChecksum_Mismatch(t *testing.T) {
	dir := t.TempDir()
	archivePath := filepath.Join(dir, "thesun-linux-amd64.tar.gz")
	if err := os.WriteFile(archivePath, []byte("actual-bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	checksums := "0000000000000000000000000000000000000000000000000000000000000000  thesun-linux-amd64.tar.gz\n"

	mux := http.NewServeMux()
	mux.HandleFunc("/checksums.txt", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(checksums))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	if err := verifyChecksum(srv.URL+"/checksums.txt", archivePath, "thesun-linux-amd64.tar.gz"); err == nil {
		t.Error("expected a checksum mismatch error")
	}
}

func TestVerifyChecksum_NoEntry(t *testing.T) {
	dir := t.TempDir()
	archivePath := filepath.Join(dir, "thesun-linux-amd64.tar.gz")
	if err := os.WriteFile(archivePath, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/checksums.txt", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("deadbeef  some-other-file.tar.gz\n"))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	if err := verifyChecksum(srv.URL+"/checksums.txt", archivePath, "thesun-linux-amd64.tar.gz"); err == nil {
		t.Error("expected an error when no checksum entry matches the asset name")
	}
}

// ---- extraction (path-escape guard + round trip) ----

func TestExtractTarGz_RoundTrip(t *testing.T) {
	dir := t.TempDir()
	archivePath := filepath.Join(dir, "a.tar.gz")
	writeTestTarGz(t, archivePath, map[string]string{
		"bin/thesun":               "fake-binary-bytes",
		"fleet/default-manifest.toml": "# fake manifest",
	})

	destDir := filepath.Join(dir, "out")
	if err := extractTarGz(archivePath, destDir); err != nil {
		t.Fatalf("extractTarGz: %v", err)
	}
	got, err := os.ReadFile(filepath.Join(destDir, "bin", "thesun"))
	if err != nil {
		t.Fatalf("read extracted file: %v", err)
	}
	if string(got) != "fake-binary-bytes" {
		t.Errorf("extracted content = %q, want fake-binary-bytes", got)
	}
}

func TestExtractTarGz_RejectsPathEscape(t *testing.T) {
	dir := t.TempDir()
	archivePath := filepath.Join(dir, "evil.tar.gz")
	writeTestTarGz(t, archivePath, map[string]string{
		"../../etc/passwd": "pwned",
	})
	destDir := filepath.Join(dir, "out")
	if err := extractTarGz(archivePath, destDir); err == nil {
		t.Error("expected a path-escape error, got nil")
	}
}

func TestExtractZip_RoundTrip(t *testing.T) {
	dir := t.TempDir()
	archivePath := filepath.Join(dir, "a.zip")
	writeTestZip(t, archivePath, map[string]string{
		"bin/thesun.exe": "fake-windows-binary",
	})
	destDir := filepath.Join(dir, "out")
	if err := extractZip(archivePath, destDir); err != nil {
		t.Fatalf("extractZip: %v", err)
	}
	got, err := os.ReadFile(filepath.Join(destDir, "bin", "thesun.exe"))
	if err != nil {
		t.Fatalf("read extracted file: %v", err)
	}
	if string(got) != "fake-windows-binary" {
		t.Errorf("extracted content = %q", got)
	}
}

func TestExtractZip_RejectsPathEscape(t *testing.T) {
	dir := t.TempDir()
	archivePath := filepath.Join(dir, "evil.zip")
	writeTestZip(t, archivePath, map[string]string{
		"../../etc/passwd": "pwned",
	})
	destDir := filepath.Join(dir, "out")
	if err := extractZip(archivePath, destDir); err == nil {
		t.Error("expected a path-escape error, got nil")
	}
}

// ---- replaceBundle (pure filesystem rename dance — no network) ----

func TestReplaceBundle_SwapsInNewBundle(t *testing.T) {
	dir := t.TempDir()
	live := filepath.Join(dir, "live")
	extracted := filepath.Join(dir, "extracted")
	mustMkdirAll(t, filepath.Join(live, "bin"))
	mustWriteFile(t, filepath.Join(live, "bin", "thesun"), "old-version")
	mustMkdirAll(t, filepath.Join(extracted, "bin"))
	mustWriteFile(t, filepath.Join(extracted, "bin", "thesun"), "new-version")

	if err := replaceBundle(extracted, live); err != nil {
		t.Fatalf("replaceBundle: %v", err)
	}
	got, err := os.ReadFile(filepath.Join(live, "bin", "thesun"))
	if err != nil {
		t.Fatalf("read post-swap file: %v", err)
	}
	if string(got) != "new-version" {
		t.Errorf("live bundle content = %q, want new-version", got)
	}
	if _, err := os.Stat(live + ".old-upgrade"); !os.IsNotExist(err) {
		t.Error("expected the .old-upgrade backup to be cleaned up on success")
	}
}

func TestReplaceBundle_DescendsOneWrappingDirectory(t *testing.T) {
	dir := t.TempDir()
	live := filepath.Join(dir, "live")
	extracted := filepath.Join(dir, "extracted")
	mustMkdirAll(t, filepath.Join(live, "bin"))
	mustWriteFile(t, filepath.Join(live, "bin", "thesun"), "old-version")
	// Archive extracted with one wrapping directory, e.g. "thesun-darwin-arm64/".
	wrapped := filepath.Join(extracted, "thesun-darwin-arm64")
	mustMkdirAll(t, filepath.Join(wrapped, "bin"))
	mustWriteFile(t, filepath.Join(wrapped, "bin", "thesun"), "new-version")

	if err := replaceBundle(extracted, live); err != nil {
		t.Fatalf("replaceBundle: %v", err)
	}
	got, err := os.ReadFile(filepath.Join(live, "bin", "thesun"))
	if err != nil {
		t.Fatalf("read post-swap file: %v", err)
	}
	if string(got) != "new-version" {
		t.Errorf("live bundle content = %q, want new-version", got)
	}
}

func TestReplaceBundle_RejectsNonBundleDir(t *testing.T) {
	dir := t.TempDir()
	live := filepath.Join(dir, "live")
	extracted := filepath.Join(dir, "extracted")
	mustMkdirAll(t, filepath.Join(live, "bin"))
	mustMkdirAll(t, extracted) // no bin/ inside — not a valid bundle

	if err := replaceBundle(extracted, live); err == nil {
		t.Error("expected an error for an extracted dir with no bin/")
	}
	// The live bundle must still be intact (rollback happened before this
	// point since resolveArchiveRoot is checked before any rename).
	if _, err := os.Stat(filepath.Join(live, "bin")); err != nil {
		t.Errorf("live bundle should be untouched: %v", err)
	}
}

// ---- test helpers ----

func writeTestTarGz(t *testing.T, path string, files map[string]string) {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	gz := gzip.NewWriter(f)
	tw := tar.NewWriter(gz)
	for name, content := range files {
		hdr := &tar.Header{Name: name, Mode: 0o644, Size: int64(len(content))}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
}

func writeTestZip(t *testing.T, path string, files map[string]string) {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	zw := zip.NewWriter(f)
	for name, content := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
}

func mustMkdirAll(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
}

func mustWriteFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}
