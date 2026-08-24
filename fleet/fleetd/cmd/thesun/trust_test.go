package main

// trust_test.go proves the `thesun trust` flag grammar (parseTrustArgs /
// parseTTL) and the /trust HTTP client path against a stub server — same
// pattern as approve_test.go, no real gateway.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestParseTTL(t *testing.T) {
	cases := []struct {
		in      string
		want    int
		wantErr bool
	}{
		{"90", 90, false},       // plain integer = minutes
		{"45m", 45, false},      // explicit minutes
		{"12h", 720, false},     // hours
		{"30d", 43200, false},   // days — the roadmap's canonical example
		{"1d", 1440, false},     //
		{" 30D ", 43200, false}, // trims + case-insensitive
		{"", 0, true},           // empty
		{"0", 0, true},          // zero
		{"-5", 0, true},         // negative
		{"-5d", 0, true},        // negative with suffix
		{"abc", 0, true},        // garbage
		{"30w", 0, true},        // unsupported unit
		{"d", 0, true},          // suffix only
	}
	for _, c := range cases {
		got, err := parseTTL(c.in)
		if c.wantErr {
			if err == nil {
				t.Errorf("parseTTL(%q) = %d, want error", c.in, got)
			}
			continue
		}
		if err != nil {
			t.Errorf("parseTTL(%q): unexpected error %v", c.in, err)
			continue
		}
		if got != c.want {
			t.Errorf("parseTTL(%q) = %d, want %d", c.in, got, c.want)
		}
	}
}

func TestParseTrustArgs(t *testing.T) {
	cases := []struct {
		name        string
		args        []string
		wantBackend string
		wantTTL     int
		wantErr     bool
	}{
		{"backend only", []string{"github"}, "github", 0, false},
		{"ttl separate arg", []string{"github", "--ttl", "30d"}, "github", 43200, false},
		{"ttl equals form", []string{"github", "--ttl=12h"}, "github", 720, false},
		{"ttl before backend", []string{"--ttl", "45m", "github"}, "github", 45, false},
		{"missing backend", []string{}, "", 0, true},
		{"missing backend with ttl", []string{"--ttl", "30d"}, "", 0, true},
		{"ttl without value", []string{"github", "--ttl"}, "", 0, true},
		{"bad ttl", []string{"github", "--ttl", "soon"}, "", 0, true},
		{"bad ttl equals", []string{"github", "--ttl=never"}, "", 0, true},
		{"unknown flag", []string{"github", "--force"}, "", 0, true},
		{"two backends", []string{"github", "stash"}, "", 0, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			backend, ttl, err := parseTrustArgs(c.args)
			if c.wantErr {
				if err == nil {
					t.Fatalf("parseTrustArgs(%v) = (%q, %d), want error", c.args, backend, ttl)
				}
				return
			}
			if err != nil {
				t.Fatalf("parseTrustArgs(%v): unexpected error %v", c.args, err)
			}
			if backend != c.wantBackend || ttl != c.wantTTL {
				t.Errorf("parseTrustArgs(%v) = (%q, %d), want (%q, %d)", c.args, backend, ttl, c.wantBackend, c.wantTTL)
			}
		})
	}
}

func TestTrustCmd_PostsBackendAndTTL(t *testing.T) {
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/trust" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"status":"trusted","grant":{"id":"g1","identity":"i","backend":"github","tool":"*","createdAt":"now"},"warning":"w"}`))
	}))
	defer srv.Close()
	t.Setenv("THESUN_GATEWAY_URL", srv.URL)

	if code := trustCmd([]string{"github", "--ttl", "30d"}); code != 0 {
		t.Fatalf("trustCmd exit = %d, want 0", code)
	}
	if gotBody["backend"] != "github" {
		t.Errorf("posted backend = %v, want github", gotBody["backend"])
	}
	if ttl, ok := gotBody["ttlMinutes"].(float64); !ok || int(ttl) != 43200 {
		t.Errorf("posted ttlMinutes = %v, want 43200", gotBody["ttlMinutes"])
	}
}

func TestTrustCmd_UnknownBackend(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":"unknown_backend","backend":"nope","knownBackends":["github"]}`))
	}))
	defer srv.Close()
	t.Setenv("THESUN_GATEWAY_URL", srv.URL)

	if code := trustCmd([]string{"nope"}); code != 1 {
		t.Fatalf("trustCmd exit = %d, want 1 for unknown backend", code)
	}
}
