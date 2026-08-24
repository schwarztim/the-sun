package registry

import (
	"os"
	"path/filepath"
	"testing"
)

func loadFixture(t *testing.T) *Index {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "index.toml"))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	idx, warnings, err := Parse(raw)
	if err != nil {
		t.Fatalf("Parse fixture: %v", err)
	}
	// The seeded fixture is schema-correct, so it should parse without warnings.
	if len(warnings) != 0 {
		t.Fatalf("unexpected warnings on the seeded fixture: %v", warnings)
	}
	return idx
}

func TestParseFixtureCounts(t *testing.T) {
	idx := loadFixture(t)
	if idx.Schema != SchemaVersion {
		t.Fatalf("schema = %q, want %q", idx.Schema, SchemaVersion)
	}
	if len(idx.Entries) != 11 {
		t.Fatalf("entries = %d, want 11", len(idx.Entries))
	}
	curated := 0
	for i := range idx.Entries {
		if idx.Entries[i].Curated() {
			curated++
		}
	}
	if curated != 4 {
		t.Fatalf("curated entries = %d, want 4", curated)
	}
}

func TestFindAndLatest(t *testing.T) {
	idx := loadFixture(t)

	if e := idx.Find("does-not-exist"); e != nil {
		t.Fatalf("Find(does-not-exist) = %v, want nil", e)
	}

	shodan := idx.Find("shodan")
	if shodan == nil {
		t.Fatal("Find(shodan) = nil")
	}
	if !shodan.Curated() {
		t.Fatalf("shodan tier = %q, want curated", shodan.Tier)
	}
	v := shodan.Latest()
	if v == nil {
		t.Fatal("shodan.Latest() = nil")
	}
	if v.Version != "0.1.0" {
		t.Fatalf("shodan latest version = %q, want 0.1.0", v.Version)
	}
	if !v.LabReport.Passed {
		t.Fatal("shodan (curated) lab_report.passed = false, want true")
	}
	if v.Auth.HermesService != "shodan" || v.Auth.HermesScheme != "api_key" {
		t.Fatalf("shodan auth = %+v, want service=shodan scheme=api_key", v.Auth)
	}

	// Version("") == Latest(); an explicit-but-missing semver returns nil.
	if shodan.Version("") == nil {
		t.Fatal(`shodan.Version("") = nil, want latest`)
	}
	if shodan.Version("9.9.9") != nil {
		t.Fatal("shodan.Version(9.9.9) != nil, want nil for a missing version")
	}
	if shodan.Version("v0.1.0") == nil {
		t.Fatal("shodan.Version(v0.1.0) = nil, want the v-prefixed match")
	}

	// A community entry is correctly classified.
	gh := idx.Find("github")
	if gh == nil || gh.Curated() {
		t.Fatalf("github should be a community entry, got %+v", gh)
	}
}

func TestLatestPicksHighestSemver(t *testing.T) {
	e := &Entry{
		Name: "multi",
		Versions: []Version{
			{Version: "0.1.0"},
			{Version: "1.2.0"},
			{Version: "0.9.5"},
		},
	}
	if got := e.Latest().Version; got != "1.2.0" {
		t.Fatalf("Latest() = %q, want 1.2.0", got)
	}
}
