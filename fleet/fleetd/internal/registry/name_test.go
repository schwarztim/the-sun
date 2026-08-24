package registry

import "testing"

// TestValidNameRejectsTraversal locks the security boundary: a name used as a
// filesystem path component must never contain traversal or separator bytes.
func TestValidNameRejectsTraversal(t *testing.T) {
	good := []string{"shodan", "servicenow", "ms365-mcp", "atlassian", "a", "x_y-1"}
	for _, n := range good {
		if !ValidName(n) {
			t.Errorf("ValidName(%q) = false, want true", n)
		}
	}
	bad := []string{
		"", "..", "../x", "a/b", "a\\b", "/etc/passwd", ".hidden",
		"..%2f", "a/../b", "UPPER", "name with space", "toolong-" + string(make([]byte, 70)),
	}
	for _, n := range bad {
		if ValidName(n) {
			t.Errorf("ValidName(%q) = true, want false (unsafe path component)", n)
		}
	}
}

// TestFindRejectsHostileEntryName proves a hostile index entry whose name is a
// traversal string is never resolvable, even by an exact-match query.
func TestFindRejectsHostileEntryName(t *testing.T) {
	ix := &Index{
		Schema: SchemaVersion,
		Entries: []Entry{
			{Name: "../../evil", Versions: []Version{{Version: "1.0.0"}}},
			{Name: "shodan", Versions: []Version{{Version: "1.0.0"}}},
		},
	}
	if ix.Find("../../evil") != nil {
		t.Error("Find resolved a hostile traversal entry name; must be nil (fail closed)")
	}
	if ix.Find("shodan") == nil {
		t.Error("Find failed to resolve a valid entry name")
	}
}

// TestParseWarnsOnUnsafeName proves Parse flags a hostile entry name as a
// non-fatal warning (surfaced to the operator) rather than silently accepting it.
func TestParseWarnsOnUnsafeName(t *testing.T) {
	raw := []byte(`schema = "thesun-registry/v1"

[[entry]]
name = "../escape"
description = "hostile"
tier = "community"
  [[entry.version]]
  version = "0.1.0"
`)
	_, warnings, err := Parse(raw)
	if err != nil {
		t.Fatalf("Parse returned fatal error: %v", err)
	}
	found := false
	for _, w := range warnings {
		if contains(w, "unsafe name") {
			found = true
		}
	}
	if !found {
		t.Errorf("Parse did not warn on an unsafe entry name; warnings=%v", warnings)
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || indexOf(s, sub) >= 0)
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
