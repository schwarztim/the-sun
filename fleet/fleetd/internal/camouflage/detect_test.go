package camouflage

import (
	"os"
	"path/filepath"
	"testing"
)

func TestParseDefaultHTTPHandler(t *testing.T) {
	doc := []byte(`{
		"LSHandlers": [
			{"LSHandlerURLScheme": "companyportal", "LSHandlerRoleAll": "com.microsoft.companyportalmac"},
			{"LSHandlerURLScheme": "http", "LSHandlerRoleAll": "com.google.Chrome"},
			{"LSHandlerURLScheme": "https", "LSHandlerRoleAll": "com.google.Chrome"}
		]
	}`)
	if got, want := parseDefaultHTTPHandler(doc), "com.google.Chrome"; got != want {
		t.Fatalf("parseDefaultHTTPHandler = %q, want %q", got, want)
	}
}

func TestParseDefaultHTTPHandler_NoHTTPEntry(t *testing.T) {
	doc := []byte(`{"LSHandlers": [{"LSHandlerURLScheme": "companyportal", "LSHandlerRoleAll": "com.microsoft.companyportalmac"}]}`)
	if got := parseDefaultHTTPHandler(doc); got != "" {
		t.Fatalf("parseDefaultHTTPHandler = %q, want empty", got)
	}
}

func TestParseDefaultHTTPHandler_MalformedJSON(t *testing.T) {
	if got := parseDefaultHTTPHandler([]byte("not json")); got != "" {
		t.Fatalf("parseDefaultHTTPHandler(malformed) = %q, want empty", got)
	}
}

func TestIsVersionLike(t *testing.T) {
	cases := map[string]bool{
		"131.0.6778.109": true,
		"120":            true,
		"Application":    false,
		"1.2.3-beta":     false,
		"":               false,
	}
	for in, want := range cases {
		if got := isVersionLike(in); got != want {
			t.Errorf("isVersionLike(%q) = %v, want %v", in, got, want)
		}
	}
}

func TestLatestVersionDir(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"118.0.5993.88", "131.0.6778.109", "not-a-version", "124.0.6367.91"} {
		if err := os.Mkdir(filepath.Join(dir, name), 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", name, err)
		}
	}
	// A stray file (not a dir) with a version-like name must be ignored.
	if err := os.WriteFile(filepath.Join(dir, "999.0.0.0"), []byte("x"), 0o644); err != nil {
		t.Fatalf("write file: %v", err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	if got, want := latestVersionDir(entries), "131.0.6778.109"; got != want {
		t.Fatalf("latestVersionDir = %q, want %q", got, want)
	}
}

func TestLatestVersionDir_Empty(t *testing.T) {
	if got := latestVersionDir(nil); got != "" {
		t.Fatalf("latestVersionDir(nil) = %q, want empty", got)
	}
}

// TestDetect_NeverFails is a smoke test: on whatever OS this actually runs
// on, Detect() must always return a usable, self-consistent profile (never
// an error, and its own OS/UA token must agree — i.e. it always passes the
// same check Verify() enforces).
func TestDetect_NeverFails(t *testing.T) {
	p, err := Detect()
	if err != nil {
		t.Fatalf("Detect: %v", err)
	}
	if p.OS == "" {
		t.Fatal("Detect: empty OS")
	}
	if p.Impersonate == "" || p.TLSProfile == "" || p.UserAgent == "" {
		t.Fatalf("Detect: incomplete profile: %+v", p)
	}
	dir := t.TempDir()
	if err := WriteConfig(dir, p); err != nil {
		t.Fatalf("WriteConfig(Detect() output): %v", err)
	}
	if ok, detail := Verify(dir); !ok {
		t.Fatalf("Verify(Detect() output) = false: %s", detail)
	}
}
