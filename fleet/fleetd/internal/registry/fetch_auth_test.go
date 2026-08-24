package registry

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

const minimalIndex = `schema = "thesun-registry/v1"

[[entry]]
name = "shodan"
tier = "curated"
  [[entry.version]]
  version = "0.1.0"
`

// TestFetchIndexAuthSendsBearer proves that a non-empty bearer is sent as an
// Authorization header (the Stash PAT path) and that an empty bearer sends none
// (the public path is unchanged).
func TestFetchIndexAuthSendsBearer(t *testing.T) {
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(minimalIndex))
	}))
	defer srv.Close()

	// With a bearer: header present and exact.
	idx, _, err := FetchIndexAuth(context.Background(), srv.URL, "PAT-"+"value")
	if err != nil {
		t.Fatalf("FetchIndexAuth with bearer: %v", err)
	}
	if idx.Find("shodan") == nil {
		t.Fatal("index did not parse")
	}
	if want := "Bearer PAT-value"; gotAuth != want {
		t.Errorf("Authorization = %q, want %q", gotAuth, want)
	}

	// Without a bearer: no Authorization header (public/file path unchanged).
	gotAuth = "sentinel"
	if _, _, err := FetchIndexAuth(context.Background(), srv.URL, ""); err != nil {
		t.Fatalf("FetchIndexAuth no bearer: %v", err)
	}
	if gotAuth != "" {
		t.Errorf("Authorization = %q, want empty (no auth on public path)", gotAuth)
	}

	// FetchIndex is the no-auth alias.
	gotAuth = "sentinel"
	if _, _, err := FetchIndex(context.Background(), srv.URL); err != nil {
		t.Fatalf("FetchIndex: %v", err)
	}
	if gotAuth != "" {
		t.Errorf("FetchIndex sent an Authorization header %q, want none", gotAuth)
	}
}
