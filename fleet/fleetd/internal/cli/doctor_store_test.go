package cli

// doctor_store_test.go proves the store-index check classifies outcomes and,
// critically, is ADVISORY (never FAIL) so it cannot block `thesun install`, and
// that a bad index URL/branch is named rather than surfaced as a bare error.

import (
	"strings"
	"testing"
)

func TestStoreIndexDoctorCheckIsAdvisoryAndNamed(t *testing.T) {
	// Point the index at a local path that does not exist: no network, and the
	// fetch fails, so the check must WARN (never FAIL) and name the ref.
	home := t.TempDir()
	t.Setenv("THESUN_HOME", home)
	t.Setenv("THESUN_REGISTRY_INDEX", home+"/nonexistent-index.toml")
	t.Setenv("THESUN_STASH_HOST", "")
	t.Setenv("THESUN_STASH_CRED", "")

	var gotStatus, gotDetail string
	seen := 0
	StoreIndexDoctorCheck(func(name, status, detail string) {
		if name == "store index" {
			seen++
			gotStatus, gotDetail = status, detail
		}
	})
	if seen != 1 {
		t.Fatalf("expected exactly one 'store index' check, got %d", seen)
	}
	if gotStatus == statusFail {
		t.Fatalf("store index check must be advisory (never FAIL), got FAIL: %q", gotDetail)
	}
	if gotStatus != statusWarn {
		t.Fatalf("a missing local index should WARN, got %q (%q)", gotStatus, gotDetail)
	}
	if !strings.Contains(gotDetail, "nonexistent-index.toml") {
		t.Fatalf("detail should name the unreachable ref, got %q", gotDetail)
	}
}
