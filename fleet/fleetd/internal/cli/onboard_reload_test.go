package cli

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestReloadTargetsTheGatewaysConfigEndpoint pins WHICH lever onboarding pulls.
//
// The bug this guards against is silent: enabling a backend edits
// config.fleet.yaml, and only the gateway re-reads that file. Calling fleetd's
// reload instead (it re-reads the suite manifest) leaves the new backend
// unrouted while onboarding reports it enabled, and nothing anywhere errors.
func TestReloadTargetsTheGatewaysConfigEndpoint(t *testing.T) {
	var gotPath, gotMethod string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotMethod = r.URL.Path, r.Method
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	t.Setenv("THESUN_GATEWAY_URL", srv.URL)
	if err := reloadGatewayConfig(); err != nil {
		t.Fatalf("reload: %v", err)
	}
	if gotPath != "/admin/reload-config" {
		t.Errorf("posted to %q; only /admin/reload-config makes the gateway re-read its YAML", gotPath)
	}
	if gotMethod != http.MethodPost {
		t.Errorf("method %q, want POST", gotMethod)
	}
}

// TestReloadSendsTheAdminTokenWhenConfigured: the admin surface is loopback-only
// UNLESS MCP_GATEWAY_ADMIN_TOKEN is set, in which case it demands a bearer
// token. Omitting it would 401 on exactly the hardened installs where the
// walkthrough matters most.
func TestReloadSendsTheAdminTokenWhenConfigured(t *testing.T) {
	var auth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	t.Setenv("THESUN_GATEWAY_URL", srv.URL)
	t.Setenv("MCP_GATEWAY_ADMIN_TOKEN", "not-a-real-token")
	if err := reloadGatewayConfig(); err != nil {
		t.Fatalf("reload: %v", err)
	}
	if !strings.HasPrefix(auth, "Bearer ") {
		t.Errorf("no bearer credential was sent (%q); a token-gated gateway would 401", auth)
	}
}

// TestReloadReportsTheGatewaysOwnError. A failed reload must say what the
// gateway said, because the config on disk is already correct at that point and
// the only remaining question is why the running process would not re-read it.
func TestReloadReportsTheGatewaysOwnError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":"Failed to reload config: bad yaml"}`))
	}))
	defer srv.Close()

	t.Setenv("THESUN_GATEWAY_URL", srv.URL)
	err := reloadGatewayConfig()
	if err == nil {
		t.Fatal("a 500 from the gateway was reported as success")
	}
	if !strings.Contains(err.Error(), "bad yaml") {
		t.Errorf("the gateway's own explanation was dropped: %v", err)
	}
}

// TestReloadFailsClearlyWhenTheGatewayIsDown covers the ordinary case of the
// stack not being up yet; the message has to name the address it tried.
func TestReloadFailsClearlyWhenTheGatewayIsDown(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	url := srv.URL
	srv.Close() // nothing is listening now

	t.Setenv("THESUN_GATEWAY_URL", url)
	err := reloadGatewayConfig()
	if err == nil {
		t.Fatal("reported success against a closed port")
	}
	if !strings.Contains(err.Error(), url) {
		t.Errorf("the error should name the address it tried: %v", err)
	}
}
