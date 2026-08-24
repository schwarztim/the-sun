// auth_test.go proves the generic easy-auth path (Basic / OAuth2
// client-credentials) forms the correct outbound Authorization header and
// that it takes priority over the advanced Hermes-managed SSO session-cookie
// mode when configured. Uses only fake, obviously-non-real credential values
// against a local httptest server — never a real ServiceNow instance.
package main

import (
	"context"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

// withEnv sets the given env vars for the duration of the test and restores
// (or unsets) their prior values on cleanup.
func withEnv(t *testing.T, kv map[string]string) {
	t.Helper()
	for k, v := range kv {
		prev, had := os.LookupEnv(k)
		if err := os.Setenv(k, v); err != nil {
			t.Fatalf("setenv %s: %v", k, err)
		}
		t.Cleanup(func() {
			if had {
				os.Setenv(k, prev)
			} else {
				os.Unsetenv(k)
			}
		})
	}
}

// resetGenericAuthEnv clears every generic/session auth env var so tests don't
// bleed into each other via ambient environment state.
func resetGenericAuthEnv(t *testing.T) {
	t.Helper()
	for _, k := range []string{
		envInstanceURL, envBasicAuth, envUsername, envPassword,
		envClientID, envClientSecret, envTokenURL,
		"HERMES_URL", "HERMES_CLIENT_TOKEN",
	} {
		prev, had := os.LookupEnv(k)
		os.Unsetenv(k)
		t.Cleanup(func() {
			if had {
				os.Setenv(k, prev)
			}
		})
	}
}

// TestApiCall_BasicAuth_CombinedForm proves that with SERVICENOW_BASIC_AUTH set
// to "alice:secret" (a fake credential — never a real one), apiCall sends
// Authorization: Basic <base64("alice:secret")> and skips the Hermes
// session-cookie / X-UserToken path entirely.
func TestApiCall_BasicAuth_CombinedForm(t *testing.T) {
	resetGenericAuthEnv(t)

	var gotAuth, gotCookie, gotUserToken string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotCookie = r.Header.Get("Cookie")
		gotUserToken = r.Header.Get("X-UserToken")
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"result":[]}`))
	}))
	defer srv.Close()

	withEnv(t, map[string]string{
		envInstanceURL: srv.URL,
		envBasicAuth:   "alice:secret",
	})

	want := "Basic " + base64.StdEncoding.EncodeToString([]byte("alice:secret"))

	res := apiCall(context.Background(), "GET", "/api/now/table/incident", "", "")
	if res == nil || res.IsError {
		t.Fatalf("apiCall returned an error result: %+v", res)
	}
	if gotAuth != want {
		t.Fatalf("Authorization header = %q, want %q", gotAuth, want)
	}
	if gotCookie != "" {
		t.Fatalf("Cookie header should be empty in generic-auth mode, got %q", gotCookie)
	}
	if gotUserToken != "" {
		t.Fatalf("X-UserToken header should be empty in generic-auth mode, got %q", gotUserToken)
	}
}

// TestApiCall_BasicAuth_SplitForm proves the split SERVICENOW_USERNAME /
// SERVICENOW_PASSWORD form composes to the same header as the combined form.
func TestApiCall_BasicAuth_SplitForm(t *testing.T) {
	resetGenericAuthEnv(t)

	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"result":[]}`))
	}))
	defer srv.Close()

	withEnv(t, map[string]string{
		envInstanceURL: srv.URL,
		envUsername:    "bob",
		envPassword:    "hunter2fake",
	})

	want := "Basic " + base64.StdEncoding.EncodeToString([]byte("bob:hunter2fake"))

	res := apiCall(context.Background(), "GET", "/api/now/table/incident", "", "")
	if res == nil || res.IsError {
		t.Fatalf("apiCall returned an error result: %+v", res)
	}
	if gotAuth != want {
		t.Fatalf("Authorization header = %q, want %q", gotAuth, want)
	}
}

// TestApiCall_OAuthClientCredentials proves that with SERVICENOW_CLIENT_ID /
// SERVICENOW_CLIENT_SECRET set, apiCall performs the client-credentials grant
// against {instance}/oauth_token.do and sends the returned token as a Bearer
// Authorization header on the actual API call.
func TestApiCall_OAuthClientCredentials(t *testing.T) {
	resetGenericAuthEnv(t)

	// Reset the process-lifetime OAuth token cache so this test is independent
	// of test ordering.
	oauthMu.Lock()
	oauthTok, oauthExpiry = "", time.Time{}
	oauthMu.Unlock()

	const fakeToken = "fake-oauth-bearer-token"
	var gotAuth, gotGrantType string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/oauth_token.do":
			r.ParseForm()
			gotGrantType = r.Form.Get("grant_type")
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(`{"access_token":"` + fakeToken + `","expires_in":3600}`))
		default:
			gotAuth = r.Header.Get("Authorization")
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(`{"result":[]}`))
		}
	}))
	defer srv.Close()

	withEnv(t, map[string]string{
		envInstanceURL:  srv.URL,
		envClientID:     "fake-client-id",
		envClientSecret: "fake-client-secret",
	})

	res := apiCall(context.Background(), "GET", "/api/now/table/incident", "", "")
	if res == nil || res.IsError {
		t.Fatalf("apiCall returned an error result: %+v", res)
	}
	if gotGrantType != "client_credentials" {
		t.Fatalf("token request grant_type = %q, want client_credentials", gotGrantType)
	}
	wantAuth := "Bearer " + fakeToken
	if gotAuth != wantAuth {
		t.Fatalf("Authorization header = %q, want %q", gotAuth, wantAuth)
	}
}

// TestApiCall_FallsBackToSessionModeWhenGenericUnset proves that with no
// generic-auth env vars set, apiCall falls back to the (unchanged) advanced
// Hermes-managed SSO session-cookie mode and surfaces its existing error when
// no session is available — proving the corporate path is untouched.
func TestApiCall_FallsBackToSessionModeWhenGenericUnset(t *testing.T) {
	resetGenericAuthEnv(t)
	// Point at a refused local port so the (unmodified) Hermes broker fetch
	// fails fast with "connection refused" instead of a real 10s dial timeout
	// against the default loopback broker address — keeps this test fast and
	// independent of whether a Hermes broker happens to be running locally.
	withEnv(t, map[string]string{"HERMES_URL": "http://127.0.0.1:1"})

	res := apiCall(context.Background(), "GET", "/api/now/table/incident", "", "")
	if res == nil || !res.IsError {
		t.Fatalf("expected an error result when no credential of any kind is configured, got: %+v", res)
	}
	text, _ := resultText(res)
	if !strings.Contains(text, "Hermes-acquired session") {
		t.Fatalf("expected the fallback error to mention the advanced Hermes SSO path, got: %q", text)
	}
}
