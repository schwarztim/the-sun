package camouflage

import (
	"path/filepath"
	"testing"
)

func TestWriteConfigLoadConfig_RoundTrip(t *testing.T) {
	dir := t.TempDir()
	want := buildProfile("linux", "chrome", "124.0.6367.91")

	if err := WriteConfig(dir, want); err != nil {
		t.Fatalf("WriteConfig: %v", err)
	}
	got, err := LoadConfig(dir)
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if got != want {
		t.Fatalf("round-trip mismatch:\n got  %+v\n want %+v", got, want)
	}
}

func TestWriteConfig_CreatesDirAndIsAtomic(t *testing.T) {
	base := t.TempDir()
	dir := filepath.Join(base, "nested", "thesun-home")
	p := buildProfile("macos", "safari", "17.0")

	if err := WriteConfig(dir, p); err != nil {
		t.Fatalf("WriteConfig into nonexistent dir: %v", err)
	}
	if _, err := LoadConfig(dir); err != nil {
		t.Fatalf("LoadConfig after WriteConfig: %v", err)
	}

	// No leftover temp files after a successful write.
	entries, err := filepath.Glob(filepath.Join(dir, ".camouflage.json.tmp-*"))
	if err != nil {
		t.Fatalf("glob: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("leftover temp files after WriteConfig: %v", entries)
	}
}

func TestLoadConfig_MissingFile(t *testing.T) {
	dir := t.TempDir()
	if _, err := LoadConfig(dir); err == nil {
		t.Fatal("LoadConfig on empty dir: want error, got nil")
	}
}

func TestPath(t *testing.T) {
	if got, want := Path("/tmp/thesun"), "/tmp/thesun/camouflage.json"; got != want {
		t.Fatalf("Path = %q, want %q", got, want)
	}
}
