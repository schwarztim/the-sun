package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// TestHTTPPutFile proves the publish upload PUTs the file body with the bearer
// header, and surfaces a non-2xx as an error (fail closed on a rejected deploy).
func TestHTTPPutFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "shodan-darwin-arm64")
	want := []byte("BINARY-CONTENT-" + "0123456789")
	if err := os.WriteFile(path, want, 0o644); err != nil {
		t.Fatal(err)
	}

	var gotMethod, gotAuth string
	var gotBody []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotAuth = r.Header.Get("Authorization")
		gotBody, _ = io.ReadAll(r.Body)
		w.WriteHeader(http.StatusCreated) // Artifactory returns 201 on deploy
	}))
	defer srv.Close()

	if err := httpPutFile(srv.URL+"/repo/shodan-darwin-arm64", path, "TOK-"+"value"); err != nil {
		t.Fatalf("httpPutFile: %v", err)
	}
	if gotMethod != http.MethodPut {
		t.Errorf("method = %q, want PUT", gotMethod)
	}
	if gotAuth != "Bearer TOK-value" {
		t.Errorf("auth = %q, want Bearer TOK-value", gotAuth)
	}
	if string(gotBody) != string(want) {
		t.Errorf("body = %q, want %q", gotBody, want)
	}

	// A non-2xx from the store must fail closed.
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte("no write permission"))
	}))
	defer bad.Close()
	if err := httpPutFile(bad.URL+"/x", path, "tok"); err == nil {
		t.Error("httpPutFile did not fail on HTTP 403")
	}

	// No bearer => no Authorization header (anonymous stores / tests).
	gotAuth = "sentinel"
	if err := httpPutFile(srv.URL+"/x", path, ""); err != nil {
		t.Fatalf("httpPutFile no-bearer: %v", err)
	}
	if gotAuth != "" {
		t.Errorf("auth = %q, want empty when bearer is empty", gotAuth)
	}
}
