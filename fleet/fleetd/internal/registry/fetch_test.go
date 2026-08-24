package registry

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFetchIndexLocalPath(t *testing.T) {
	idx, warnings, err := FetchIndex(context.Background(), filepath.Join("testdata", "index.toml"))
	if err != nil {
		t.Fatalf("FetchIndex(local path): %v", err)
	}
	if len(warnings) != 0 {
		t.Fatalf("unexpected warnings: %v", warnings)
	}
	if len(idx.Entries) != 11 {
		t.Fatalf("entries = %d, want 11", len(idx.Entries))
	}
}

func TestFetchIndexFileURL(t *testing.T) {
	abs, err := filepath.Abs(filepath.Join("testdata", "index.toml"))
	if err != nil {
		t.Fatalf("abs: %v", err)
	}
	idx, _, err := FetchIndex(context.Background(), "file://"+abs)
	if err != nil {
		t.Fatalf("FetchIndex(file url): %v", err)
	}
	if idx.Find("shodan") == nil {
		t.Fatal("expected shodan in file:// fetched index")
	}
}

func TestFetchIndexMalformedIsFatal(t *testing.T) {
	dir := t.TempDir()
	bad := filepath.Join(dir, "bad.toml")
	if err := os.WriteFile(bad, []byte("this = = not valid toml ["), 0o644); err != nil {
		t.Fatalf("write bad: %v", err)
	}
	if _, _, err := FetchIndex(context.Background(), bad); err == nil {
		t.Fatal("FetchIndex should return a fatal error on unparseable TOML")
	}
}

func TestFetchIndexSchemaMismatchWarns(t *testing.T) {
	dir := t.TempDir()
	f := filepath.Join(dir, "index.toml")
	body := "schema = \"thesun-registry/v999\"\n\n[[entry]]\nname = \"x\"\ntier = \"community\"\n\n  [[entry.version]]\n  version = \"0.1.0\"\n"
	if err := os.WriteFile(f, []byte(body), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	idx, warnings, err := FetchIndex(context.Background(), f)
	if err != nil {
		t.Fatalf("FetchIndex: %v", err)
	}
	if idx.Find("x") == nil {
		t.Fatal("entry x should still parse despite schema mismatch")
	}
	found := false
	for _, w := range warnings {
		if strings.Contains(w, "schema") {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected a schema-mismatch warning, got %v", warnings)
	}
}

func TestFetchIndexEmptyRef(t *testing.T) {
	if _, _, err := FetchIndex(context.Background(), "  "); err == nil {
		t.Fatal("empty ref should error")
	}
}
