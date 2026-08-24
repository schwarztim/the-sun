package cli

import (
	"testing"
	"time"
)

func TestParseTimeLayouts(t *testing.T) {
	for _, s := range []string{
		"2026-07-05T02:12:45.355Z",
		"2026-07-05T02:12:45Z",
		"2026-07-05T02:12:45.355000000Z",
	} {
		if _, err := parseTime(s); err != nil {
			t.Errorf("parseTime(%q) failed: %v", s, err)
		}
	}
	if _, err := parseTime("not-a-time"); err == nil {
		t.Error("parseTime should reject garbage")
	}
}

func TestExpiryState(t *testing.T) {
	now := time.Now()
	future := now.Add(2 * time.Hour).UTC().Format(time.RFC3339Nano)
	soon := now.Add(10 * time.Minute).UTC().Format(time.RFC3339Nano)
	past := now.Add(-5 * time.Minute).UTC().Format(time.RFC3339Nano)

	cases := map[string]string{
		future: "valid",
		soon:   "expiring",
		past:   "expired",
		"":     "none",
	}
	for in, want := range cases {
		if got := expiryState(in); got != want {
			t.Errorf("expiryState(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestHumanExpiry(t *testing.T) {
	if humanExpiry("") != "-" {
		t.Error("empty expiry should be -")
	}
	future := time.Now().Add(90 * time.Minute).UTC().Format(time.RFC3339Nano)
	if got := humanExpiry(future); got == "-" || got[:3] != "in " {
		t.Errorf("future expiry should read 'in …', got %q", got)
	}
	past := time.Now().Add(-90 * time.Minute).UTC().Format(time.RFC3339Nano)
	if got := humanExpiry(past); got[:7] != "expired" {
		t.Errorf("past expiry should read 'expired …', got %q", got)
	}
}

func TestHermesServiceForServer(t *testing.T) {
	cases := map[string]string{
		"venafi-go":    "venafi",
		"servicenow-go": "servicenow",
		"shodan":       "shodan", // no -go suffix
		"go":           "go",     // too short to strip
	}
	for in, want := range cases {
		if got := hermesServiceForServer(in); got != want {
			t.Errorf("hermesServiceForServer(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestTokenExpiryExtraction(t *testing.T) {
	s := hermesService{
		Service: "venafi", Scheme: "session", Status: "healthy",
		Evidence: []hermesEvidence{
			{Kind: "proof", Status: "valid"},
			{Kind: "token", Status: "healthy"},
		},
	}
	s.Evidence[1].Details.AccessTokenExpiresAt = "2026-07-05T02:12:45.355Z"
	if got := s.tokenExpiry(); got != "2026-07-05T02:12:45.355Z" {
		t.Errorf("tokenExpiry = %q", got)
	}

	none := hermesService{Evidence: []hermesEvidence{{Kind: "proof"}}}
	if got := none.tokenExpiry(); got != "" {
		t.Errorf("tokenExpiry with no token evidence should be empty, got %q", got)
	}
}
