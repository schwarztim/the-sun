package main

// store_test.go covers the pure store logic: trust badges must reflect real
// index state (tier, lab_report.passed, signature presence) and never claim
// more than the data proves; grouping, fuzzy filtering, and safety labels are
// exercised over synthetic entries.

import (
	"fmt"
	"os"
	"strings"
	"testing"

	"mcp-fleet/fleetd/internal/registry"
)

func curatedEntry(name string, passed bool, sig string) *registry.Entry {
	return &registry.Entry{
		Name: name,
		Tier: "curated",
		Versions: []registry.Version{{
			Version:    "1.0.0",
			Ed25519Sig: sig,
			LabReport:  registry.LabReport{Passed: passed, ToolCount: 5},
		}},
	}
}

func TestBadgeForCuratedVerified(t *testing.T) {
	e := curatedEntry("shodan", true, "c2ln")
	b := badgeFor(e, e.Latest())
	if b.Level != badgeGood {
		t.Fatalf("want badgeGood, got %v (%s)", b.Level, b.Label)
	}
	if !strings.Contains(b.Label, "lab-verified") || !strings.Contains(b.Label, "signed") {
		t.Fatalf("curated verified badge missing claims: %q", b.Label)
	}
}

func TestBadgeForCuratedLabFailedIsNeverVerified(t *testing.T) {
	e := curatedEntry("badlab", false, "c2ln")
	b := badgeFor(e, e.Latest())
	if b.Level != badgeBad {
		t.Fatalf("lab-failed curated entry must be badgeBad, got %v", b.Level)
	}
	if strings.Contains(b.Label, "lab-verified") {
		t.Fatalf("lab-failed entry must not show verified: %q", b.Label)
	}
	if !strings.Contains(b.Label, "LAB FAILED") {
		t.Fatalf("want LAB FAILED in label, got %q", b.Label)
	}
}

func TestBadgeForCuratedUnsigned(t *testing.T) {
	e := curatedEntry("nosig", true, "")
	b := badgeFor(e, e.Latest())
	if b.Level != badgeBad || !strings.Contains(b.Label, "UNSIGNED") {
		t.Fatalf("unsigned curated entry must warn it will be refused: %v %q", b.Level, b.Label)
	}
}

func TestBadgeForCommunityIsCaution(t *testing.T) {
	e := &registry.Entry{Name: "hobby", Tier: "community",
		Versions: []registry.Version{{Version: "0.1.0"}}}
	b := badgeFor(e, e.Latest())
	if b.Level != badgeCaution {
		t.Fatalf("community must be badgeCaution, got %v", b.Level)
	}
	if !strings.Contains(b.Label, "self-attested") || !strings.Contains(b.Label, "unverified") {
		t.Fatalf("community badge must state self-attested + unverified: %q", b.Label)
	}
	if strings.Contains(strings.ToLower(b.Label), "lab-verified") {
		t.Fatalf("community badge must never say verified: %q", b.Label)
	}
}

func TestBadgeForRevokedAndVersionless(t *testing.T) {
	rev := &registry.Entry{Name: "gone", Tier: "curated", Revoked: true}
	if b := badgeFor(rev, nil); b.Level != badgeBad || !strings.Contains(b.Label, "REVOKED") {
		t.Fatalf("revoked badge wrong: %v %q", b.Level, b.Label)
	}
	empty := &registry.Entry{Name: "empty", Tier: "curated"}
	if b := badgeFor(empty, empty.Latest()); b.Level != badgeBad {
		t.Fatalf("versionless entry must be badgeBad, got %v (%s)", b.Level, b.Label)
	}
}

func TestSafetyLabel(t *testing.T) {
	if got := safetyLabel(nil); got != "unknown" {
		t.Fatalf("nil version: want unknown, got %q", got)
	}
	ro := &registry.Version{GatewayManifest: registry.GatewayManifest{ReadCount: 4}}
	if got := safetyLabel(ro); got != "read-only" {
		t.Fatalf("read-only: got %q", got)
	}
	rw := &registry.Version{GatewayManifest: registry.GatewayManifest{ReadCount: 3, WriteCount: 2, HasWrite: true}}
	got := safetyLabel(rw)
	if !strings.Contains(got, "approval-gated") || !strings.Contains(got, "3r/2w") {
		t.Fatalf("writer label must state gating + counts, got %q", got)
	}
}

func TestGroupByCategorySortsAndParksUncategorizedLast(t *testing.T) {
	entries := []*registry.Entry{
		{Name: "zeta", Category: ""},
		{Name: "alpha", Category: "security"},
		{Name: "beta", Category: "Security"},
		{Name: "misc", Category: "uncategorized"},
		{Name: "cal", Category: "calendar"},
	}
	cats := groupByCategory(entries)
	want := []string{"calendar", "security", "uncategorized"}
	if len(cats) != len(want) {
		t.Fatalf("want %d categories, got %d", len(want), len(cats))
	}
	for i, c := range cats {
		if c.Name != want[i] {
			t.Fatalf("category %d: want %q, got %q", i, want[i], c.Name)
		}
	}
	sec := cats[1]
	if sec.Entries[0].Name != "alpha" || sec.Entries[1].Name != "beta" {
		t.Fatalf("entries not sorted by name in category: %+v", sec.Entries)
	}
	unc := cats[2]
	if len(unc.Entries) != 2 {
		t.Fatalf("empty and explicit uncategorized must merge, got %d entries", len(unc.Entries))
	}
}

func TestFuzzySubseq(t *testing.T) {
	cases := []struct {
		s, q string
		want bool
	}{
		{"shodan", "shdn", true},
		{"shodan", "SHODAN", true},
		{"shodan", "", true},
		{"shodan", "dns", false},
		{"tessie", "tse", true},
		{"abc", "abcd", false},
	}
	for _, c := range cases {
		if got := fuzzySubseq(c.s, c.q); got != c.want {
			t.Errorf("fuzzySubseq(%q, %q) = %v, want %v", c.s, c.q, got, c.want)
		}
	}
}

func TestEntryMatchesFuzzy(t *testing.T) {
	e := &registry.Entry{
		Name:        "shodan",
		Description: "Internet-wide scan data",
		Category:    "security",
		Tags:        []string{"scanning", "osint"},
	}
	for _, q := range []string{"", "shdn", "scan data", "security", "osint", "SHO"} {
		if !entryMatchesFuzzy(e, q) {
			t.Errorf("query %q should match", q)
		}
	}
	if entryMatchesFuzzy(e, "calendar") {
		t.Error("query calendar should not match")
	}
}

func TestFilterStoreEntriesDelistsRevokedAndFiltersTier(t *testing.T) {
	idx := &registry.Index{Entries: []registry.Entry{
		{Name: "good", Tier: "curated"},
		{Name: "gone", Tier: "curated", Revoked: true},
		{Name: "hobby", Tier: "community"},
	}}
	all := filterStoreEntries(idx, "", "")
	if len(all) != 2 {
		t.Fatalf("revoked must be delisted: want 2, got %d", len(all))
	}
	for _, e := range all {
		if e.Revoked {
			t.Fatalf("revoked entry %q leaked into the store", e.Name)
		}
	}
	cur := filterStoreEntries(idx, "", "curated")
	if len(cur) != 1 || cur[0].Name != "good" {
		t.Fatalf("tier filter wrong: %+v", cur)
	}
	none := filterStoreEntries(idx, "nomatch", "")
	if len(none) != 0 {
		t.Fatalf("query nomatch: want 0, got %d", len(none))
	}
}

func TestInstalledServersResolvesGoSuffixAndSkipsSystem(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/thesun.toml"
	// A legacy "-go" fleet server, a store-installed bare server, and a system
	// entry that must be excluded from store install-state.
	manifestTOML := `
[[server]]
name = "shodan-go"
kind = "mcp"
bin = "/bin/true"
port = 42011

[[server]]
name = "netskope"
kind = "mcp"
bin = "/bin/true"
port = 42016

[[server]]
name = "gateway"
kind = "system"
bin = "/bin/true"
port = 3100
`
	if err := os.WriteFile(path, []byte(manifestTOML), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FLEETD_MANIFEST", path)

	got, err := installedServers()
	if err != nil {
		t.Fatalf("installedServers: %v", err)
	}
	// Index entry "shodan" must resolve to the real manifest name "shodan-go".
	if real, ok := got["shodan"]; !ok || real != "shodan-go" {
		t.Fatalf("bare index name %q must resolve to %q; got %q ok=%v", "shodan", "shodan-go", real, ok)
	}
	// The exact manifest name must also resolve to itself (remove-by-real-name).
	if real, ok := got["shodan-go"]; !ok || real != "shodan-go" {
		t.Fatalf("exact name %q must resolve to itself; got %q ok=%v", "shodan-go", real, ok)
	}
	// A store-installed bare server resolves to itself.
	if real, ok := got["netskope"]; !ok || real != "netskope" {
		t.Fatalf("bare server %q must resolve to itself; got %q ok=%v", "netskope", real, ok)
	}
	// System entries are never store servers.
	if _, ok := got["gateway"]; ok {
		t.Fatalf("system server %q must be excluded from store install-state", "gateway")
	}
}

func TestCaptureOutput(t *testing.T) {
	code, out := captureOutput(func() int {
		fmt.Println("to stdout")
		fmt.Fprintln(os.Stderr, "to stderr")
		return 7
	})
	if code != 7 {
		t.Fatalf("want exit 7, got %d", code)
	}
	if !strings.Contains(out, "to stdout") || !strings.Contains(out, "to stderr") {
		t.Fatalf("captured output missing streams: %q", out)
	}
}
