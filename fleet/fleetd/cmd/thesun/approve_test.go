package main

// approve_test.go proves the approve/grants HTTP client against a stub HTTP
// server standing in for the gateway's loopback /approve and /grants
// endpoints (gateway/src/gateway.ts setupApprovalRoutes) — no real gateway is
// started. THESUN_GATEWAY_URL is set per-test (t.Setenv, auto-restored) so
// gatewayURL() resolves to the stub instead of any real machine's gateway.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHTTPJSON_GET(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/approve" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		if got := r.Header.Get("accept"); got != "application/json" {
			t.Errorf("accept header = %q, want application/json", got)
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"pending":[]}`))
	}))
	defer srv.Close()

	code, body, err := httpJSON(http.MethodGet, srv.URL+"/approve", nil)
	if err != nil {
		t.Fatalf("httpJSON GET: %v", err)
	}
	if code != 200 {
		t.Errorf("code = %d, want 200", code)
	}
	var out struct {
		Pending []pendingApproval `json:"pending"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(out.Pending) != 0 {
		t.Errorf("pending = %v, want empty", out.Pending)
	}
}

func TestHTTPJSON_POST_SendsBodyAndContentType(t *testing.T) {
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("method = %s, want POST", r.Method)
		}
		if got := r.Header.Get("content-type"); got != "application/json" {
			t.Errorf("content-type = %q, want application/json", got)
		}
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.WriteHeader(200)
		_, _ = w.Write([]byte(`{"status":"approved","id":"abc","standing":true,"grant":{"id":"g1","identity":"install-x","backend":"fakebe","tool":"fakebe_fake_delete_item","createdAt":"now"}}`))
	}))
	defer srv.Close()

	code, body, err := httpJSON(http.MethodPost, srv.URL+"/approve", map[string]any{"id": "abc", "standing": true})
	if err != nil {
		t.Fatalf("httpJSON POST: %v", err)
	}
	if code != 200 {
		t.Errorf("code = %d, want 200", code)
	}
	if gotBody["id"] != "abc" || gotBody["standing"] != true {
		t.Errorf("server received body = %v, want id=abc standing=true", gotBody)
	}
	var out struct {
		Status   string `json:"status"`
		Standing bool   `json:"standing"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if out.Status != "approved" || !out.Standing {
		t.Errorf("response = %+v, want status=approved standing=true", out)
	}
}

func TestHTTPJSON_DELETE(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete || r.URL.Path != "/grants/g1" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(404)
		_, _ = w.Write([]byte(`{"error":"not_found","id":"g1"}`))
	}))
	defer srv.Close()

	code, _, err := httpJSON(http.MethodDelete, srv.URL+"/grants/g1", nil)
	if err != nil {
		t.Fatalf("httpJSON DELETE: %v", err)
	}
	if code != 404 {
		t.Errorf("code = %d, want 404", code)
	}
}

func TestFetchPending_ParsesAndSummarizes(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"pending":[{"id":"p1","backend":"fakebe","tool":"fakebe_fake_delete_item","safetyClass":"PRODUCTION","identity":"install-x","argsSummary":"{\"id\":\"<string>\"}","expiresAt":"2099-01-01T00:00:00.000Z"}]}`))
	}))
	defer srv.Close()

	pending, err := fetchPending(srv.URL)
	if err != nil {
		t.Fatalf("fetchPending: %v", err)
	}
	if len(pending) != 1 {
		t.Fatalf("got %d pending, want 1", len(pending))
	}
	p := pending[0]
	if p.ID != "p1" || p.Backend != "fakebe" || p.SafetyClass != "PRODUCTION" {
		t.Errorf("pending[0] = %+v, unexpected fields", p)
	}
	// No raw argument value ("<string>" is a type tag, not a value) leaked.
	if p.ArgsSummary == "" {
		t.Error("argsSummary must be present")
	}
}

func TestFetchPending_PropagatesServerError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
		_, _ = w.Write([]byte("boom"))
	}))
	defer srv.Close()

	if _, err := fetchPending(srv.URL); err == nil {
		t.Fatal("fetchPending should error on a 500 response")
	}
}

func TestGrantsList_UnreachableGateway(t *testing.T) {
	t.Setenv("THESUN_GATEWAY_URL", "http://127.0.0.1:1") // nothing listens here
	if rc := grantsList(); rc != 1 {
		t.Errorf("grantsList() with unreachable gateway = %d, want 1", rc)
	}
}

func TestGrantsRevoke_NotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(404)
		_, _ = w.Write([]byte(`{"error":"not_found"}`))
	}))
	defer srv.Close()
	t.Setenv("THESUN_GATEWAY_URL", srv.URL)

	if rc := grantsRevoke("does-not-exist"); rc != 1 {
		t.Errorf("grantsRevoke() for unknown id = %d, want 1", rc)
	}
}

func TestGrantsRevoke_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/grants/g1" || r.Method != http.MethodDelete {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(200)
		_, _ = w.Write([]byte(`{"status":"revoked","id":"g1"}`))
	}))
	defer srv.Close()
	t.Setenv("THESUN_GATEWAY_URL", srv.URL)

	if rc := grantsRevoke("g1"); rc != 0 {
		t.Errorf("grantsRevoke() = %d, want 0", rc)
	}
}

func TestApproveCmd_ExplicitID_Success(t *testing.T) {
	var posted map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/approve":
			_ = json.NewDecoder(r.Body).Decode(&posted)
			w.WriteHeader(200)
			_, _ = w.Write([]byte(`{"status":"approved","id":"p1","standing":true,"grant":{"id":"g1","identity":"install-x","backend":"fakebe","tool":"fakebe_fake_delete_item","createdAt":"now"}}`))
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()
	t.Setenv("THESUN_GATEWAY_URL", srv.URL)

	// An explicit id skips the pending-list GET entirely (no prompt needed).
	if rc := approveCmd([]string{"p1", "--always"}); rc != 0 {
		t.Fatalf("approveCmd(p1, --always) = %d, want 0", rc)
	}
	if posted["id"] != "p1" || posted["standing"] != true {
		t.Errorf("posted body = %v, want id=p1 standing=true", posted)
	}
}

func TestApproveCmd_ExplicitID_NotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(404)
		_, _ = w.Write([]byte(`{"error":"not_found"}`))
	}))
	defer srv.Close()
	t.Setenv("THESUN_GATEWAY_URL", srv.URL)

	if rc := approveCmd([]string{"missing-id"}); rc != 1 {
		t.Errorf("approveCmd(missing-id) = %d, want 1", rc)
	}
}

func TestApproveCmd_NoPending_NoArgs_ReturnsZero(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"pending":[]}`))
	}))
	defer srv.Close()
	t.Setenv("THESUN_GATEWAY_URL", srv.URL)

	// No id, no pending approvals, and no stdin to prompt against — must not
	// hang or error; "nothing to do" is success.
	if rc := approveCmd(nil); rc != 0 {
		t.Errorf("approveCmd(nil) with no pending = %d, want 0", rc)
	}
}
