// Command servicenow-mcp is a thesun-generated Go MCP server.
//
// Transport: streamable-HTTP ONLY (never stdio, never SSE). The transport
// harness below is inlined so this server depends only on the go-sdk and is
// independently compilable and containerizable.
//
// Credentials are read from the environment at runtime and are NEVER logged,
// echoed, or surfaced in any tool result or error (errors are scrubbed of the
// credential-bearing URL and redacted defensively).
package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"golang.org/x/time/rate"
)

const (
	serverName = "servicenow-mcp"
	// apiBase is a placeholder; every ServiceNow instance has its own hostname,
	// so this is never a real target. Override with SERVICENOW_INSTANCE_URL.
	apiBase       = "https://your-instance.service-now.com" // HTTPS only
	httpTimeout   = 10 * time.Second
	maxBody       = 1 << 20 // cap response reads at 1 MiB
	shutdownGrace = 10 * time.Second

	// Outbound token-bucket rate limit — protects the upstream API (and this
	// server's own good standing) from bursty tool traffic.
	rateLimitRPS   = 8
	rateLimitBurst = 4
)

// version is stamped at build time via -ldflags="-X main.version=...".
var version = "dev"

// httpClient enforces a hard timeout and (via the default transport) HTTPS to apiBase.
var httpClient = &http.Client{Timeout: httpTimeout}

// apiLimiter throttles all outbound API calls (token bucket) so a burst of tool
// invocations can never hammer the upstream API past its rate limit.
var apiLimiter = rate.NewLimiter(rate.Limit(rateLimitRPS), rateLimitBurst)

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// boolPtr returns a pointer to b — used for the *bool tool-annotation hints
// (DestructiveHint/OpenWorldHint) so they always serialize onto the wire.
func boolPtr(b bool) *bool { return &b }

// hermesBaseURL returns the Hermes broker base URL, defaulting to the local
// loopback broker when HERMES_URL is unset.
func hermesBaseURL() string {
	if v := os.Getenv("HERMES_URL"); v != "" {
		return v
	}
	return "http://127.0.0.1:9876"
}

// hermesClientToken returns the Hermes broker client token from
// HERMES_CLIENT_TOKEN, falling back to reading ~/.hermes/client.token (the same
// file the fleetd supervisor reads) so supervised servers need no secret in their
// manifest env. Never logged.
func hermesClientToken() string {
	if v := os.Getenv("HERMES_CLIENT_TOKEN"); v != "" {
		return v
	}
	if home, err := os.UserHomeDir(); err == nil {
		if b, err := os.ReadFile(filepath.Join(home, ".hermes", "client.token")); err == nil {
			return strings.TrimSpace(string(b))
		}
	}
	return ""
}

// --- credential resolution (Hermes-managed session cookie + CSRF token) ---

const (
	hermesService     = "servicenow"
	hermesTokenScheme = "session"
	tokenTTL          = 60 * time.Second
)

var (
	tokMu        sync.Mutex
	tokCookie    string
	tokUserToken string
	tokFetched   time.Time
)

// refreshSessionLocked re-fetches the session bundle when the short-lived cache
// is stale. Caller must hold tokMu.
func refreshSessionLocked(ctx context.Context) {
	if tokCookie != "" && time.Since(tokFetched) < tokenTTL {
		return
	}
	if c, u, ok := fetchSessionFromHermes(ctx); ok {
		tokCookie = c
		tokUserToken = u
		tokFetched = time.Now()
	}
}

// resolveCredential returns the current Hermes-managed session cookie string,
// fetching a fresh bundle from the broker when the cache is stale. Never logged.
func resolveCredential(ctx context.Context) string {
	tokMu.Lock()
	defer tokMu.Unlock()
	refreshSessionLocked(ctx)
	return tokCookie
}

// hermesUserToken returns the CSRF token (ServiceNow g_ck) captured alongside the
// session cookie, or "" when the bundle carried none. Sent as X-UserToken on
// state-changing requests. Never logged.
func hermesUserToken(ctx context.Context) string {
	tokMu.Lock()
	defer tokMu.Unlock()
	refreshSessionLocked(ctx)
	return tokUserToken
}

// fetchSessionFromHermes GETs {HERMES_URL}/token/{service}/{scheme} (Bearer
// HERMES_CLIENT_TOKEN) and returns (cookie, userToken, ok). Returns ok=false on
// any failure. Never logs any value.
func fetchSessionFromHermes(ctx context.Context) (string, string, bool) {
	base := hermesBaseURL()
	client := hermesClientToken()
	if base == "" || client == "" {
		return "", "", false
	}
	reqURL := strings.TrimRight(base, "/") + "/token/" + hermesService + "/" + hermesTokenScheme
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return "", "", false
	}
	req.Header.Set("Authorization", "Bearer "+client)
	req.Header.Set("Accept", "application/json")
	resp, err := httpClient.Do(req)
	if err != nil {
		return "", "", false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", "", false
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBody))
	if err != nil {
		return "", "", false
	}
	var b struct {
		AccessToken string `json:"accessToken"`
		Extra       struct {
			GCk string `json:"g_ck"`
		} `json:"extra"`
	}
	if err := json.Unmarshal(body, &b); err != nil {
		return "", "", false
	}
	if b.AccessToken == "" {
		return "", "", false
	}
	return b.AccessToken, b.Extra.GCk, true
}

// --- generic auth (Basic / OAuth client-credentials) — the EASY default path ---
//
// A stock ServiceNow instance authenticates with a plain Basic-auth username +
// password, or an OAuth2 client-credentials application — no corporate SSO
// browser session required. This is the default, generic path. It activates
// automatically (no build-time flag) whenever one of these is present in the
// environment:
//
//	SERVICENOW_BASIC_AUTH="user:pass"          (or SERVICENOW_USERNAME + SERVICENOW_PASSWORD)
//	SERVICENOW_CLIENT_ID + SERVICENOW_CLIENT_SECRET
//
// Values may be supplied as hermescred://servicenow/<account> references in the
// fleetd manifest — fleetd resolves those against the Hermes vault at spawn
// time, so this server only ever sees the plaintext env var, never the ref
// itself. When NEITHER generic env var is set, apiCall falls back unchanged to
// the advanced Hermes-managed SSO session-cookie mode above (corporate setups
// that require Playwright + password + TOTP capture). Neither credential is
// ever logged.
const (
	envInstanceURL  = "SERVICENOW_INSTANCE_URL"
	envBasicAuth    = "SERVICENOW_BASIC_AUTH"
	envUsername     = "SERVICENOW_USERNAME"
	envPassword     = "SERVICENOW_PASSWORD"
	envClientID     = "SERVICENOW_CLIENT_ID"
	envClientSecret = "SERVICENOW_CLIENT_SECRET"
	envTokenURL     = "SERVICENOW_TOKEN_URL" // optional override; default {instance}/oauth_token.do

	oauthTokenExpirySkew = 30 * time.Second
	oauthTokenMinTTL     = 60 * time.Second
)

// instanceBaseURL returns the configured ServiceNow instance base URL, allowing
// a full override via SERVICENOW_INSTANCE_URL so this binary works against any
// stock ServiceNow instance, not just the one baked in as apiBase at generation
// time.
func instanceBaseURL() string {
	return envOr(envInstanceURL, apiBase)
}

// basicAuthValue returns the "user:pass" credential for HTTP Basic auth from
// SERVICENOW_BASIC_AUTH, or composed from SERVICENOW_USERNAME +
// SERVICENOW_PASSWORD. Returns "" when neither is configured. Never logged.
func basicAuthValue() string {
	if v := os.Getenv(envBasicAuth); v != "" {
		return v
	}
	u, p := os.Getenv(envUsername), os.Getenv(envPassword)
	if u != "" && p != "" {
		return u + ":" + p
	}
	return ""
}

// oauthConfigured reports whether OAuth2 client-credentials env vars are set.
func oauthConfigured() bool {
	return os.Getenv(envClientID) != "" && os.Getenv(envClientSecret) != ""
}

// genericAuthConfigured reports whether the easy generic path (Basic or
// OAuth2) is configured. When true, it takes priority over the advanced
// Hermes-managed SSO session-cookie mode.
func genericAuthConfigured() bool {
	return basicAuthValue() != "" || oauthConfigured()
}

var (
	oauthMu     sync.Mutex
	oauthTok    string
	oauthExpiry time.Time
)

// fetchOAuthToken performs the OAuth2 client-credentials grant against
// {instance}/oauth_token.do (or SERVICENOW_TOKEN_URL when set) and returns a
// bearer access token, caching it until shortly before it expires. Returns ""
// on any failure. Never logs the token or the client secret. Caller must hold
// oauthMu.
func fetchOAuthTokenLocked(ctx context.Context) string {
	if oauthTok != "" && time.Now().Before(oauthExpiry) {
		return oauthTok
	}
	tokenURL := envOr(envTokenURL, strings.TrimRight(instanceBaseURL(), "/")+"/oauth_token.do")
	form := url.Values{}
	form.Set("grant_type", "client_credentials")
	form.Set("client_id", os.Getenv(envClientID))
	form.Set("client_secret", os.Getenv(envClientSecret))
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, tokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return ""
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	resp, err := httpClient.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return ""
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBody))
	if err != nil {
		return ""
	}
	var tok struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.Unmarshal(body, &tok); err != nil || tok.AccessToken == "" {
		return ""
	}
	ttl := time.Duration(tok.ExpiresIn) * time.Second
	if ttl <= oauthTokenExpirySkew {
		ttl = oauthTokenMinTTL
	}
	oauthTok = tok.AccessToken
	oauthExpiry = time.Now().Add(ttl - oauthTokenExpirySkew)
	return oauthTok
}

// resolveOAuthToken returns a cached OAuth2 bearer token, refreshing it via the
// client-credentials grant when stale or absent. Never logged.
func resolveOAuthToken(ctx context.Context) string {
	oauthMu.Lock()
	defer oauthMu.Unlock()
	return fetchOAuthTokenLocked(ctx)
}

func textResult(text string) *mcp.CallToolResult {
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: text}}}
}

func errorResult(msg string) *mcp.CallToolResult {
	return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: msg}}}
}

// redact removes any literal occurrence of the credential from s.
func redact(s, key string) string {
	if key == "" {
		return s
	}
	return strings.ReplaceAll(s, key, "[REDACTED]")
}

// scrub converts a client error into a safe, credential-free string. *url.Error
// embeds the request URL (which may carry the key as a query param), so we use
// the inner error and never url.Error.Error(), then redact defensively.
func scrub(err error, key string) string {
	msg := err.Error()
	var uerr *url.Error
	if errors.As(err, &uerr) {
		if uerr.Err != nil {
			msg = uerr.Op + ": " + uerr.Err.Error()
		} else {
			msg = uerr.Op + ": request error"
		}
	}
	return redact(msg, key)
}

// apiCall performs an authenticated HTTP call against the ServiceNow instance
// and returns a graceful MCP result. Auth mode is selected at request time:
// the generic easy path (Basic / OAuth2 client-credentials) when configured
// via environment, otherwise the advanced Hermes-managed SSO session-cookie
// mode. It NEVER returns the credential, or a key-bearing URL, in any output
// path.
func apiCall(ctx context.Context, method, path, query, body string) *mcp.CallToolResult {
	generic := genericAuthConfigured()

	instance := instanceBaseURL()
	instanceUnset := instance == apiBase && !strings.HasPrefix(path, "https://") && !strings.HasPrefix(path, "http://")
	if generic && instanceUnset {
		// Only the generic (easy) path needs this checked up front: it is the
		// one that always targets instance+path. The advanced Hermes-managed
		// SSO fallback below surfaces its own credential error first, unchanged.
		return errorResult("SERVICENOW_INSTANCE_URL not set — set it to your ServiceNow instance, e.g. https://your-instance.service-now.com")
	}

	reqURL := instance + path
	if strings.HasPrefix(path, "https://") || strings.HasPrefix(path, "http://") {
		reqURL = path // absolute endpoint URL (multi-host API); instance prefix skipped
	}
	if query != "" {
		reqURL += "?" + query
	}

	var bodyReader io.Reader
	if body != "" {
		bodyReader = strings.NewReader(body)
	}

	req, err := http.NewRequestWithContext(ctx, method, reqURL, bodyReader)
	if err != nil {
		return errorResult("failed to build request: " + err.Error())
	}
	req.Header.Set("Accept", "application/json")
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}

	// scrubKey holds whichever credential material was placed on the wire this
	// call, so error/response text stays redacted regardless of auth mode.
	var scrubKey string
	if generic {
		if b := basicAuthValue(); b != "" {
			scrubKey = b
			req.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(b)))
		} else {
			tok := resolveOAuthToken(ctx)
			if tok == "" {
				return errorResult("SERVICENOW_CLIENT_ID/SERVICENOW_CLIENT_SECRET are set but the OAuth2 client-credentials token request failed — check the instance's OAuth application registration and SERVICENOW_INSTANCE_URL/SERVICENOW_TOKEN_URL")
			}
			scrubKey = tok
			req.Header.Set("Authorization", "Bearer "+tok)
		}
	} else {
		key := resolveCredential(ctx)
		if key == "" {
			return errorResult("no ServiceNow credential configured — set SERVICENOW_BASIC_AUTH (or SERVICENOW_USERNAME + SERVICENOW_PASSWORD) for the easy default path, SERVICENOW_CLIENT_ID + SERVICENOW_CLIENT_SECRET for OAuth2, or HERMES_URL + HERMES_CLIENT_TOKEN with a Hermes-acquired session for the advanced corporate SSO path")
		}
		scrubKey = key
		req.Header.Set("Cookie", key)
		if ut := hermesUserToken(ctx); ut != "" {
			req.Header.Set("X-UserToken", ut)
		}
	}

	if err := apiLimiter.Wait(ctx); err != nil {
		return errorResult("rate limiter aborted request: " + err.Error())
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return errorResult("request failed: " + scrub(err, scrubKey))
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(io.LimitReader(resp.Body, maxBody))
	if err != nil {
		return errorResult("failed to read response: " + scrub(err, scrubKey))
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return errorResult(fmt.Sprintf("API returned HTTP %d: %s", resp.StatusCode, redact(string(respBody), scrubKey)))
	}
	return textResult(redact(string(respBody), scrubKey))
}

// serve mounts srv on a stateless streamable-HTTP handler at /mcp, adds
// /healthz, binds MCP_HOST:MCP_PORT, and blocks until a signal arrives — then
// drains connections with a bounded graceful shutdown. MCP_PORT is REQUIRED
// (no default) so a misconfigured unit fails loudly instead of colliding.
func serve(ctx context.Context, srv *mcp.Server) error {
	host := envOr("MCP_HOST", "127.0.0.1")
	port := os.Getenv("MCP_PORT")
	if port == "" {
		return errors.New("MCP_PORT is required and has no default; set MCP_PORT in the environment")
	}
	addr := net.JoinHostPort(host, port)

	mux := http.NewServeMux()
	mux.Handle("/mcp", mcp.NewStreamableHTTPHandler(
		func(*http.Request) *mcp.Server { return srv },
		&mcp.StreamableHTTPOptions{Stateless: true},
	))
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	httpSrv := &http.Server{Addr: addr, Handler: mux, ReadHeaderTimeout: 10 * time.Second}

	sigCtx, stop := signal.NotifyContext(ctx, syscall.SIGTERM, os.Interrupt)
	defer stop()

	serveErr := make(chan error, 1)
	go func() {
		log.Printf("%s: serving streamable-http on http://%s/mcp (health: /healthz)", serverName, addr)
		err := httpSrv.ListenAndServe()
		if errors.Is(err, http.ErrServerClosed) {
			err = nil
		}
		serveErr <- err
	}()

	select {
	case err := <-serveErr:
		return err
	case <-sigCtx.Done():
		log.Printf("%s: shutdown signal received, draining %s", serverName, addr)
		shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownGrace)
		defer cancel()
		return httpSrv.Shutdown(shutdownCtx)
	}
}

// ---- generated tool input structs ----

type ServicenowListIncidentIn struct {
	SysparmLimit        string `json:"sysparm_limit,omitempty" jsonschema:"max records to return (default 10)"`
	SysparmQuery        string `json:"sysparm_query,omitempty" jsonschema:"encoded query filter, e.g. 'active=true^ORDERBYDESCsys_created_on'"`
	SysparmFields       string `json:"sysparm_fields,omitempty" jsonschema:"comma-separated field list to return"`
	SysparmDisplayValue string `json:"sysparm_display_value,omitempty" jsonschema:"true|false|all — return display values for reference fields"`
}

type ServicenowGetIncidentIn struct {
	SysId         string `json:"sysId" jsonschema:"the sysId path parameter (required)"`
	SysparmFields string `json:"sysparm_fields,omitempty" jsonschema:"comma-separated field list"`
}

type ServicenowListChangeRequestIn struct {
	SysparmLimit  string `json:"sysparm_limit,omitempty" jsonschema:"max records to return"`
	SysparmQuery  string `json:"sysparm_query,omitempty" jsonschema:"encoded query filter"`
	SysparmFields string `json:"sysparm_fields,omitempty" jsonschema:"comma-separated field list"`
}

type ServicenowGetChangeRequestIn struct {
	SysId         string `json:"sysId" jsonschema:"the sysId path parameter (required)"`
	SysparmFields string `json:"sysparm_fields,omitempty" jsonschema:"comma-separated field list"`
}

type ServicenowListChangeTaskIn struct {
	SysparmLimit  string `json:"sysparm_limit,omitempty" jsonschema:"max records to return"`
	SysparmQuery  string `json:"sysparm_query,omitempty" jsonschema:"encoded query filter"`
	SysparmFields string `json:"sysparm_fields,omitempty" jsonschema:"comma-separated field list"`
}

type ServicenowListProblemIn struct {
	SysparmLimit  string `json:"sysparm_limit,omitempty" jsonschema:"max records to return"`
	SysparmQuery  string `json:"sysparm_query,omitempty" jsonschema:"encoded query filter"`
	SysparmFields string `json:"sysparm_fields,omitempty" jsonschema:"comma-separated field list"`
}

type ServicenowGetProblemIn struct {
	SysId         string `json:"sysId" jsonschema:"the sysId path parameter (required)"`
	SysparmFields string `json:"sysparm_fields,omitempty" jsonschema:"comma-separated field list"`
}

type ServicenowListRequestIn struct {
	SysparmLimit  string `json:"sysparm_limit,omitempty" jsonschema:"max records to return"`
	SysparmQuery  string `json:"sysparm_query,omitempty" jsonschema:"encoded query filter"`
	SysparmFields string `json:"sysparm_fields,omitempty" jsonschema:"comma-separated field list"`
}

type ServicenowListRequestedItemIn struct {
	SysparmLimit  string `json:"sysparm_limit,omitempty" jsonschema:"max records to return"`
	SysparmQuery  string `json:"sysparm_query,omitempty" jsonschema:"encoded query filter"`
	SysparmFields string `json:"sysparm_fields,omitempty" jsonschema:"comma-separated field list"`
}

type ServicenowListKnowledgeIn struct {
	SysparmLimit  string `json:"sysparm_limit,omitempty" jsonschema:"max records to return"`
	SysparmQuery  string `json:"sysparm_query,omitempty" jsonschema:"encoded query filter"`
	SysparmFields string `json:"sysparm_fields,omitempty" jsonschema:"comma-separated field list"`
}

type ServicenowGetKnowledgeIn struct {
	SysId         string `json:"sysId" jsonschema:"the sysId path parameter (required)"`
	SysparmFields string `json:"sysparm_fields,omitempty" jsonschema:"comma-separated field list"`
}

type ServicenowListSysUserIn struct {
	SysparmLimit  string `json:"sysparm_limit,omitempty" jsonschema:"max records to return"`
	SysparmQuery  string `json:"sysparm_query,omitempty" jsonschema:"encoded query filter, e.g. 'email=user@example.com'"`
	SysparmFields string `json:"sysparm_fields,omitempty" jsonschema:"comma-separated field list"`
}

type ServicenowGetSysUserIn struct {
	SysId         string `json:"sysId" jsonschema:"the sysId path parameter (required)"`
	SysparmFields string `json:"sysparm_fields,omitempty" jsonschema:"comma-separated field list"`
}

type ServicenowListGroupIn struct {
	SysparmLimit  string `json:"sysparm_limit,omitempty" jsonschema:"max records to return"`
	SysparmQuery  string `json:"sysparm_query,omitempty" jsonschema:"encoded query filter"`
	SysparmFields string `json:"sysparm_fields,omitempty" jsonschema:"comma-separated field list"`
}

type ServicenowQueryTableIn struct {
	Table               string `json:"table" jsonschema:"the table path parameter (required)"`
	SysparmLimit        string `json:"sysparm_limit,omitempty" jsonschema:"max records to return (default 10)"`
	SysparmQuery        string `json:"sysparm_query,omitempty" jsonschema:"encoded query filter, e.g. 'active=true^ORDERBYDESCsys_created_on'"`
	SysparmFields       string `json:"sysparm_fields,omitempty" jsonschema:"comma-separated field list to return"`
	SysparmDisplayValue string `json:"sysparm_display_value,omitempty" jsonschema:"true|false|all — return display values for reference fields"`
}

type ServicenowGetRecordIn struct {
	Table         string `json:"table" jsonschema:"the table path parameter (required)"`
	SysId         string `json:"sysId" jsonschema:"the sysId path parameter (required)"`
	SysparmFields string `json:"sysparm_fields,omitempty" jsonschema:"comma-separated field list"`
}

type ServicenowCreateIncidentIn struct {
	Body string `json:"body,omitempty" jsonschema:"raw JSON request body (optional)"`
}

type ServicenowUpdateIncidentIn struct {
	SysId string `json:"sysId" jsonschema:"the sysId path parameter (required)"`
	Body  string `json:"body,omitempty" jsonschema:"raw JSON request body (optional)"`
}

type ServicenowCreateChangeRequestIn struct {
	Body string `json:"body,omitempty" jsonschema:"raw JSON request body (optional)"`
}

type ServicenowCreateProblemIn struct {
	Body string `json:"body,omitempty" jsonschema:"raw JSON request body (optional)"`
}

type ServicenowCreateRecordIn struct {
	Table string `json:"table" jsonschema:"the table path parameter (required)"`
	Body  string `json:"body,omitempty" jsonschema:"raw JSON request body (optional)"`
}

type ServicenowUpdateRecordIn struct {
	Table string `json:"table" jsonschema:"the table path parameter (required)"`
	SysId string `json:"sysId" jsonschema:"the sysId path parameter (required)"`
	Body  string `json:"body,omitempty" jsonschema:"raw JSON request body (optional)"`
}

type ServicenowDeleteRecordIn struct {
	Table string `json:"table" jsonschema:"the table path parameter (required)"`
	SysId string `json:"sysId" jsonschema:"the sysId path parameter (required)"`
	Body  string `json:"body,omitempty" jsonschema:"raw JSON request body (optional)"`
}

type ServicenowListCatalogItemIn struct {
	SysparmLimit  string `json:"sysparm_limit,omitempty" jsonschema:"max records to return"`
	SysparmQuery  string `json:"sysparm_query,omitempty" jsonschema:"encoded query filter"`
	SysparmFields string `json:"sysparm_fields,omitempty" jsonschema:"comma-separated field list"`
}

type ServicenowGetCatalogItemIn struct {
	SysId         string `json:"sysId" jsonschema:"the sysId path parameter (required)"`
	SysparmFields string `json:"sysparm_fields,omitempty" jsonschema:"comma-separated field list"`
}

type ServicenowListCatalogCategoryIn struct {
	SysparmLimit  string `json:"sysparm_limit,omitempty" jsonschema:"max records to return"`
	SysparmQuery  string `json:"sysparm_query,omitempty" jsonschema:"encoded query filter"`
	SysparmFields string `json:"sysparm_fields,omitempty" jsonschema:"comma-separated field list"`
}

type ServicenowListCatalogItemVariableIn struct {
	SysparmLimit  string `json:"sysparm_limit,omitempty" jsonschema:"max records to return"`
	SysparmQuery  string `json:"sysparm_query,omitempty" jsonschema:"encoded query filter"`
	SysparmFields string `json:"sysparm_fields,omitempty" jsonschema:"comma-separated field list"`
}

type ServicenowListCmdbCiIn struct {
	SysparmLimit  string `json:"sysparm_limit,omitempty" jsonschema:"max records to return"`
	SysparmQuery  string `json:"sysparm_query,omitempty" jsonschema:"encoded query filter"`
	SysparmFields string `json:"sysparm_fields,omitempty" jsonschema:"comma-separated field list"`
}

type ServicenowListCmdbRelationshipIn struct {
	SysparmLimit  string `json:"sysparm_limit,omitempty" jsonschema:"max records to return"`
	SysparmQuery  string `json:"sysparm_query,omitempty" jsonschema:"encoded query filter"`
	SysparmFields string `json:"sysparm_fields,omitempty" jsonschema:"comma-separated field list"`
}

type ServicenowListCmdbInstanceIn struct {
	ClassName    string `json:"className" jsonschema:"the className path parameter (required)"`
	SysparmLimit string `json:"sysparm_limit,omitempty" jsonschema:"max records to return"`
	SysparmQuery string `json:"sysparm_query,omitempty" jsonschema:"encoded query filter"`
}

type ServicenowListCmdbClassIn struct {
	SysparmLimit  string `json:"sysparm_limit,omitempty" jsonschema:"max records to return"`
	SysparmQuery  string `json:"sysparm_query,omitempty" jsonschema:"encoded query filter"`
	SysparmFields string `json:"sysparm_fields,omitempty" jsonschema:"comma-separated field list"`
}

type ServicenowListGroupMemberIn struct {
	SysparmLimit  string `json:"sysparm_limit,omitempty" jsonschema:"max records to return"`
	SysparmQuery  string `json:"sysparm_query,omitempty" jsonschema:"encoded query filter"`
	SysparmFields string `json:"sysparm_fields,omitempty" jsonschema:"comma-separated field list"`
}

type ServicenowListUserRoleIn struct {
	SysparmLimit  string `json:"sysparm_limit,omitempty" jsonschema:"max records to return"`
	SysparmQuery  string `json:"sysparm_query,omitempty" jsonschema:"encoded query filter"`
	SysparmFields string `json:"sysparm_fields,omitempty" jsonschema:"comma-separated field list"`
}

type ServicenowListRoleIn struct {
	SysparmLimit  string `json:"sysparm_limit,omitempty" jsonschema:"max records to return"`
	SysparmQuery  string `json:"sysparm_query,omitempty" jsonschema:"encoded query filter"`
	SysparmFields string `json:"sysparm_fields,omitempty" jsonschema:"comma-separated field list"`
}

type ServicenowListAclIn struct {
	SysparmLimit  string `json:"sysparm_limit,omitempty" jsonschema:"max records to return"`
	SysparmQuery  string `json:"sysparm_query,omitempty" jsonschema:"encoded query filter"`
	SysparmFields string `json:"sysparm_fields,omitempty" jsonschema:"comma-separated field list"`
}

type ServicenowListApprovalIn struct {
	SysparmLimit  string `json:"sysparm_limit,omitempty" jsonschema:"max records to return"`
	SysparmQuery  string `json:"sysparm_query,omitempty" jsonschema:"encoded query filter"`
	SysparmFields string `json:"sysparm_fields,omitempty" jsonschema:"comma-separated field list"`
}

type ServicenowListTaskIn struct {
	SysparmLimit  string `json:"sysparm_limit,omitempty" jsonschema:"max records to return"`
	SysparmQuery  string `json:"sysparm_query,omitempty" jsonschema:"encoded query filter"`
	SysparmFields string `json:"sysparm_fields,omitempty" jsonschema:"comma-separated field list"`
}

type ServicenowListSlaIn struct {
	SysparmLimit  string `json:"sysparm_limit,omitempty" jsonschema:"max records to return"`
	SysparmQuery  string `json:"sysparm_query,omitempty" jsonschema:"encoded query filter"`
	SysparmFields string `json:"sysparm_fields,omitempty" jsonschema:"comma-separated field list"`
}

type ServicenowListTaskSlaIn struct {
	SysparmLimit  string `json:"sysparm_limit,omitempty" jsonschema:"max records to return"`
	SysparmQuery  string `json:"sysparm_query,omitempty" jsonschema:"encoded query filter"`
	SysparmFields string `json:"sysparm_fields,omitempty" jsonschema:"comma-separated field list"`
}

type ServicenowListWorkflowIn struct {
	SysparmLimit  string `json:"sysparm_limit,omitempty" jsonschema:"max records to return"`
	SysparmQuery  string `json:"sysparm_query,omitempty" jsonschema:"encoded query filter"`
	SysparmFields string `json:"sysparm_fields,omitempty" jsonschema:"comma-separated field list"`
}

type ServicenowListWorkflowContextIn struct {
	SysparmLimit  string `json:"sysparm_limit,omitempty" jsonschema:"max records to return"`
	SysparmQuery  string `json:"sysparm_query,omitempty" jsonschema:"encoded query filter"`
	SysparmFields string `json:"sysparm_fields,omitempty" jsonschema:"comma-separated field list"`
}

type ServicenowListEmailIn struct {
	SysparmLimit  string `json:"sysparm_limit,omitempty" jsonschema:"max records to return"`
	SysparmQuery  string `json:"sysparm_query,omitempty" jsonschema:"encoded query filter"`
	SysparmFields string `json:"sysparm_fields,omitempty" jsonschema:"comma-separated field list"`
}

type ServicenowListNotificationIn struct {
	SysparmLimit  string `json:"sysparm_limit,omitempty" jsonschema:"max records to return"`
	SysparmQuery  string `json:"sysparm_query,omitempty" jsonschema:"encoded query filter"`
	SysparmFields string `json:"sysparm_fields,omitempty" jsonschema:"comma-separated field list"`
}

type ServicenowListEventIn struct {
	SysparmLimit  string `json:"sysparm_limit,omitempty" jsonschema:"max records to return"`
	SysparmQuery  string `json:"sysparm_query,omitempty" jsonschema:"encoded query filter"`
	SysparmFields string `json:"sysparm_fields,omitempty" jsonschema:"comma-separated field list"`
}

type ServicenowCreateEventIn struct {
	Body string `json:"body,omitempty" jsonschema:"raw JSON request body (optional)"`
}

type ServicenowListJournalIn struct {
	SysparmLimit  string `json:"sysparm_limit,omitempty" jsonschema:"max records to return"`
	SysparmQuery  string `json:"sysparm_query,omitempty" jsonschema:"encoded query filter"`
	SysparmFields string `json:"sysparm_fields,omitempty" jsonschema:"comma-separated field list"`
}

type ServicenowListAuditIn struct {
	SysparmLimit  string `json:"sysparm_limit,omitempty" jsonschema:"max records to return"`
	SysparmQuery  string `json:"sysparm_query,omitempty" jsonschema:"encoded query filter"`
	SysparmFields string `json:"sysparm_fields,omitempty" jsonschema:"comma-separated field list"`
}

type ServicenowListScheduledJobIn struct {
	SysparmLimit  string `json:"sysparm_limit,omitempty" jsonschema:"max records to return"`
	SysparmQuery  string `json:"sysparm_query,omitempty" jsonschema:"encoded query filter"`
	SysparmFields string `json:"sysparm_fields,omitempty" jsonschema:"comma-separated field list"`
}

type ServicenowListUpdateSetIn struct {
	SysparmLimit  string `json:"sysparm_limit,omitempty" jsonschema:"max records to return"`
	SysparmQuery  string `json:"sysparm_query,omitempty" jsonschema:"encoded query filter"`
	SysparmFields string `json:"sysparm_fields,omitempty" jsonschema:"comma-separated field list"`
}

type ServicenowListAssetIn struct {
	SysparmLimit  string `json:"sysparm_limit,omitempty" jsonschema:"max records to return"`
	SysparmQuery  string `json:"sysparm_query,omitempty" jsonschema:"encoded query filter"`
	SysparmFields string `json:"sysparm_fields,omitempty" jsonschema:"comma-separated field list"`
}

type ServicenowGetAssetIn struct {
	SysId         string `json:"sysId" jsonschema:"the sysId path parameter (required)"`
	SysparmFields string `json:"sysparm_fields,omitempty" jsonschema:"comma-separated field list"`
}

type ServicenowListLicenseIn struct {
	SysparmLimit  string `json:"sysparm_limit,omitempty" jsonschema:"max records to return"`
	SysparmQuery  string `json:"sysparm_query,omitempty" jsonschema:"encoded query filter"`
	SysparmFields string `json:"sysparm_fields,omitempty" jsonschema:"comma-separated field list"`
}

type ServicenowListLicenseEntitlementIn struct {
	SysparmLimit  string `json:"sysparm_limit,omitempty" jsonschema:"max records to return"`
	SysparmQuery  string `json:"sysparm_query,omitempty" jsonschema:"encoded query filter"`
	SysparmFields string `json:"sysparm_fields,omitempty" jsonschema:"comma-separated field list"`
}

type ServicenowListSoftwareIn struct {
	SysparmLimit  string `json:"sysparm_limit,omitempty" jsonschema:"max records to return"`
	SysparmQuery  string `json:"sysparm_query,omitempty" jsonschema:"encoded query filter"`
	SysparmFields string `json:"sysparm_fields,omitempty" jsonschema:"comma-separated field list"`
}

type ServicenowListContractIn struct {
	SysparmLimit  string `json:"sysparm_limit,omitempty" jsonschema:"max records to return"`
	SysparmQuery  string `json:"sysparm_query,omitempty" jsonschema:"encoded query filter"`
	SysparmFields string `json:"sysparm_fields,omitempty" jsonschema:"comma-separated field list"`
}

type ServicenowListLocationIn struct {
	SysparmLimit  string `json:"sysparm_limit,omitempty" jsonschema:"max records to return"`
	SysparmQuery  string `json:"sysparm_query,omitempty" jsonschema:"encoded query filter"`
	SysparmFields string `json:"sysparm_fields,omitempty" jsonschema:"comma-separated field list"`
}

type ServicenowListDepartmentIn struct {
	SysparmLimit  string `json:"sysparm_limit,omitempty" jsonschema:"max records to return"`
	SysparmQuery  string `json:"sysparm_query,omitempty" jsonschema:"encoded query filter"`
	SysparmFields string `json:"sysparm_fields,omitempty" jsonschema:"comma-separated field list"`
}

type ServicenowListCostCenterIn struct {
	SysparmLimit  string `json:"sysparm_limit,omitempty" jsonschema:"max records to return"`
	SysparmQuery  string `json:"sysparm_query,omitempty" jsonschema:"encoded query filter"`
	SysparmFields string `json:"sysparm_fields,omitempty" jsonschema:"comma-separated field list"`
}

type ServicenowListDiscoveryStatusIn struct {
	SysparmLimit  string `json:"sysparm_limit,omitempty" jsonschema:"max records to return"`
	SysparmQuery  string `json:"sysparm_query,omitempty" jsonschema:"encoded query filter"`
	SysparmFields string `json:"sysparm_fields,omitempty" jsonschema:"comma-separated field list"`
}

type ServicenowListDiscoveryScheduleIn struct {
	SysparmLimit  string `json:"sysparm_limit,omitempty" jsonschema:"max records to return"`
	SysparmQuery  string `json:"sysparm_query,omitempty" jsonschema:"encoded query filter"`
	SysparmFields string `json:"sysparm_fields,omitempty" jsonschema:"comma-separated field list"`
}

type ServicenowTableSchemaIn struct {
	SysparmLimit  string `json:"sysparm_limit,omitempty" jsonschema:"max records to return"`
	SysparmQuery  string `json:"sysparm_query,omitempty" jsonschema:"encoded query filter"`
	SysparmFields string `json:"sysparm_fields,omitempty" jsonschema:"comma-separated field list"`
}

type ServicenowListChoiceIn struct {
	SysparmLimit  string `json:"sysparm_limit,omitempty" jsonschema:"max records to return"`
	SysparmQuery  string `json:"sysparm_query,omitempty" jsonschema:"encoded query filter"`
	SysparmFields string `json:"sysparm_fields,omitempty" jsonschema:"comma-separated field list"`
}

type ServicenowListAttachmentIn struct {
	SysparmQuery string `json:"sysparm_query,omitempty" jsonschema:"encoded query, e.g. 'table_name=incident^table_sys_id=<sysId>'"`
	SysparmLimit string `json:"sysparm_limit,omitempty" jsonschema:"max records to return"`
}

type ServicenowGetAttachmentIn struct {
	SysId string `json:"sysId" jsonschema:"the sysId path parameter (required)"`
}

type ServicenowDownloadAttachmentIn struct {
	SysId string `json:"sysId" jsonschema:"the sysId path parameter (required)"`
}

type ServicenowDeleteAttachmentIn struct {
	SysId string `json:"sysId" jsonschema:"the sysId path parameter (required)"`
	Body  string `json:"body,omitempty" jsonschema:"raw JSON request body (optional)"`
}

type ServicenowAggregateIn struct {
	Table            string `json:"table" jsonschema:"the table path parameter (required)"`
	SysparmQuery     string `json:"sysparm_query,omitempty" jsonschema:"encoded query filter"`
	SysparmCount     string `json:"sysparm_count,omitempty" jsonschema:"true to return a record count"`
	SysparmGroupBy   string `json:"sysparm_group_by,omitempty" jsonschema:"comma-separated fields to group by"`
	SysparmSumFields string `json:"sysparm_sum_fields,omitempty" jsonschema:"comma-separated numeric fields to sum"`
	SysparmAvgFields string `json:"sysparm_avg_fields,omitempty" jsonschema:"comma-separated numeric fields to average"`
	SysparmHaving    string `json:"sysparm_having,omitempty" jsonschema:"having clause on aggregates"`
}

type ServicenowImportSetLoadIn struct {
	Table string `json:"table" jsonschema:"the table path parameter (required)"`
	Body  string `json:"body,omitempty" jsonschema:"raw JSON request body (optional)"`
}

type ServicenowBatchRequestIn struct {
	Body string `json:"body,omitempty" jsonschema:"raw JSON request body (optional)"`
}

type helpIn struct {
	Topic string `json:"topic,omitempty" jsonschema:"optional help topic; omit for a full overview of all tools"`
}

// ---- generated tool handlers ----

func servicenowListIncident(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowListIncidentIn) (*mcp.CallToolResult, any, error) {
	path := "/api/now/table/incident"
	q := url.Values{}
	if v := strings.TrimSpace(in.SysparmLimit); v != "" {
		q.Set("sysparm_limit", v)
	}
	if v := strings.TrimSpace(in.SysparmQuery); v != "" {
		q.Set("sysparm_query", v)
	}
	if v := strings.TrimSpace(in.SysparmFields); v != "" {
		q.Set("sysparm_fields", v)
	}
	if v := strings.TrimSpace(in.SysparmDisplayValue); v != "" {
		q.Set("sysparm_display_value", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func servicenowGetIncident(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowGetIncidentIn) (*mcp.CallToolResult, any, error) {
	sysIdVal := strings.TrimSpace(in.SysId)
	if sysIdVal == "" {
		return errorResult("servicenow_get_incident: sysId is required"), nil, nil
	}
	path := strings.Replace("/api/now/table/incident/{sysId}", "{sysId}", url.PathEscape(sysIdVal), 1)
	q := url.Values{}
	if v := strings.TrimSpace(in.SysparmFields); v != "" {
		q.Set("sysparm_fields", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func servicenowListChangeRequest(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowListChangeRequestIn) (*mcp.CallToolResult, any, error) {
	path := "/api/now/table/change_request"
	q := url.Values{}
	if v := strings.TrimSpace(in.SysparmLimit); v != "" {
		q.Set("sysparm_limit", v)
	}
	if v := strings.TrimSpace(in.SysparmQuery); v != "" {
		q.Set("sysparm_query", v)
	}
	if v := strings.TrimSpace(in.SysparmFields); v != "" {
		q.Set("sysparm_fields", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func servicenowGetChangeRequest(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowGetChangeRequestIn) (*mcp.CallToolResult, any, error) {
	sysIdVal := strings.TrimSpace(in.SysId)
	if sysIdVal == "" {
		return errorResult("servicenow_get_change_request: sysId is required"), nil, nil
	}
	path := strings.Replace("/api/now/table/change_request/{sysId}", "{sysId}", url.PathEscape(sysIdVal), 1)
	q := url.Values{}
	if v := strings.TrimSpace(in.SysparmFields); v != "" {
		q.Set("sysparm_fields", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func servicenowListChangeTask(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowListChangeTaskIn) (*mcp.CallToolResult, any, error) {
	path := "/api/now/table/change_task"
	q := url.Values{}
	if v := strings.TrimSpace(in.SysparmLimit); v != "" {
		q.Set("sysparm_limit", v)
	}
	if v := strings.TrimSpace(in.SysparmQuery); v != "" {
		q.Set("sysparm_query", v)
	}
	if v := strings.TrimSpace(in.SysparmFields); v != "" {
		q.Set("sysparm_fields", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func servicenowListProblem(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowListProblemIn) (*mcp.CallToolResult, any, error) {
	path := "/api/now/table/problem"
	q := url.Values{}
	if v := strings.TrimSpace(in.SysparmLimit); v != "" {
		q.Set("sysparm_limit", v)
	}
	if v := strings.TrimSpace(in.SysparmQuery); v != "" {
		q.Set("sysparm_query", v)
	}
	if v := strings.TrimSpace(in.SysparmFields); v != "" {
		q.Set("sysparm_fields", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func servicenowGetProblem(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowGetProblemIn) (*mcp.CallToolResult, any, error) {
	sysIdVal := strings.TrimSpace(in.SysId)
	if sysIdVal == "" {
		return errorResult("servicenow_get_problem: sysId is required"), nil, nil
	}
	path := strings.Replace("/api/now/table/problem/{sysId}", "{sysId}", url.PathEscape(sysIdVal), 1)
	q := url.Values{}
	if v := strings.TrimSpace(in.SysparmFields); v != "" {
		q.Set("sysparm_fields", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func servicenowListRequest(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowListRequestIn) (*mcp.CallToolResult, any, error) {
	path := "/api/now/table/sc_request"
	q := url.Values{}
	if v := strings.TrimSpace(in.SysparmLimit); v != "" {
		q.Set("sysparm_limit", v)
	}
	if v := strings.TrimSpace(in.SysparmQuery); v != "" {
		q.Set("sysparm_query", v)
	}
	if v := strings.TrimSpace(in.SysparmFields); v != "" {
		q.Set("sysparm_fields", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func servicenowListRequestedItem(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowListRequestedItemIn) (*mcp.CallToolResult, any, error) {
	path := "/api/now/table/sc_req_item"
	q := url.Values{}
	if v := strings.TrimSpace(in.SysparmLimit); v != "" {
		q.Set("sysparm_limit", v)
	}
	if v := strings.TrimSpace(in.SysparmQuery); v != "" {
		q.Set("sysparm_query", v)
	}
	if v := strings.TrimSpace(in.SysparmFields); v != "" {
		q.Set("sysparm_fields", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func servicenowListKnowledge(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowListKnowledgeIn) (*mcp.CallToolResult, any, error) {
	path := "/api/now/table/kb_knowledge"
	q := url.Values{}
	if v := strings.TrimSpace(in.SysparmLimit); v != "" {
		q.Set("sysparm_limit", v)
	}
	if v := strings.TrimSpace(in.SysparmQuery); v != "" {
		q.Set("sysparm_query", v)
	}
	if v := strings.TrimSpace(in.SysparmFields); v != "" {
		q.Set("sysparm_fields", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func servicenowGetKnowledge(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowGetKnowledgeIn) (*mcp.CallToolResult, any, error) {
	sysIdVal := strings.TrimSpace(in.SysId)
	if sysIdVal == "" {
		return errorResult("servicenow_get_knowledge: sysId is required"), nil, nil
	}
	path := strings.Replace("/api/now/table/kb_knowledge/{sysId}", "{sysId}", url.PathEscape(sysIdVal), 1)
	q := url.Values{}
	if v := strings.TrimSpace(in.SysparmFields); v != "" {
		q.Set("sysparm_fields", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func servicenowListSysUser(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowListSysUserIn) (*mcp.CallToolResult, any, error) {
	path := "/api/now/table/sys_user"
	q := url.Values{}
	if v := strings.TrimSpace(in.SysparmLimit); v != "" {
		q.Set("sysparm_limit", v)
	}
	if v := strings.TrimSpace(in.SysparmQuery); v != "" {
		q.Set("sysparm_query", v)
	}
	if v := strings.TrimSpace(in.SysparmFields); v != "" {
		q.Set("sysparm_fields", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func servicenowGetSysUser(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowGetSysUserIn) (*mcp.CallToolResult, any, error) {
	sysIdVal := strings.TrimSpace(in.SysId)
	if sysIdVal == "" {
		return errorResult("servicenow_get_sys_user: sysId is required"), nil, nil
	}
	path := strings.Replace("/api/now/table/sys_user/{sysId}", "{sysId}", url.PathEscape(sysIdVal), 1)
	q := url.Values{}
	if v := strings.TrimSpace(in.SysparmFields); v != "" {
		q.Set("sysparm_fields", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func servicenowListGroup(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowListGroupIn) (*mcp.CallToolResult, any, error) {
	path := "/api/now/table/sys_user_group"
	q := url.Values{}
	if v := strings.TrimSpace(in.SysparmLimit); v != "" {
		q.Set("sysparm_limit", v)
	}
	if v := strings.TrimSpace(in.SysparmQuery); v != "" {
		q.Set("sysparm_query", v)
	}
	if v := strings.TrimSpace(in.SysparmFields); v != "" {
		q.Set("sysparm_fields", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func servicenowQueryTable(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowQueryTableIn) (*mcp.CallToolResult, any, error) {
	tableVal := strings.TrimSpace(in.Table)
	if tableVal == "" {
		return errorResult("servicenow_query_table: table is required"), nil, nil
	}
	path := strings.Replace("/api/now/table/{table}", "{table}", url.PathEscape(tableVal), 1)
	q := url.Values{}
	if v := strings.TrimSpace(in.SysparmLimit); v != "" {
		q.Set("sysparm_limit", v)
	}
	if v := strings.TrimSpace(in.SysparmQuery); v != "" {
		q.Set("sysparm_query", v)
	}
	if v := strings.TrimSpace(in.SysparmFields); v != "" {
		q.Set("sysparm_fields", v)
	}
	if v := strings.TrimSpace(in.SysparmDisplayValue); v != "" {
		q.Set("sysparm_display_value", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func servicenowGetRecord(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowGetRecordIn) (*mcp.CallToolResult, any, error) {
	tableVal := strings.TrimSpace(in.Table)
	if tableVal == "" {
		return errorResult("servicenow_get_record: table is required"), nil, nil
	}
	sysIdVal := strings.TrimSpace(in.SysId)
	if sysIdVal == "" {
		return errorResult("servicenow_get_record: sysId is required"), nil, nil
	}
	path := strings.Replace(strings.Replace("/api/now/table/{table}/{sysId}", "{table}", url.PathEscape(tableVal), 1), "{sysId}", url.PathEscape(sysIdVal), 1)
	q := url.Values{}
	if v := strings.TrimSpace(in.SysparmFields); v != "" {
		q.Set("sysparm_fields", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func servicenowCreateIncident(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowCreateIncidentIn) (*mcp.CallToolResult, any, error) {
	path := "/api/now/table/incident"
	query := ""
	body := in.Body
	return apiCall(ctx, "POST", path, query, body), nil, nil
}

func servicenowUpdateIncident(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowUpdateIncidentIn) (*mcp.CallToolResult, any, error) {
	sysIdVal := strings.TrimSpace(in.SysId)
	if sysIdVal == "" {
		return errorResult("servicenow_update_incident: sysId is required"), nil, nil
	}
	path := strings.Replace("/api/now/table/incident/{sysId}", "{sysId}", url.PathEscape(sysIdVal), 1)
	query := ""
	body := in.Body
	return apiCall(ctx, "PATCH", path, query, body), nil, nil
}

func servicenowCreateChangeRequest(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowCreateChangeRequestIn) (*mcp.CallToolResult, any, error) {
	path := "/api/now/table/change_request"
	query := ""
	body := in.Body
	return apiCall(ctx, "POST", path, query, body), nil, nil
}

func servicenowCreateProblem(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowCreateProblemIn) (*mcp.CallToolResult, any, error) {
	path := "/api/now/table/problem"
	query := ""
	body := in.Body
	return apiCall(ctx, "POST", path, query, body), nil, nil
}

func servicenowCreateRecord(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowCreateRecordIn) (*mcp.CallToolResult, any, error) {
	tableVal := strings.TrimSpace(in.Table)
	if tableVal == "" {
		return errorResult("servicenow_create_record: table is required"), nil, nil
	}
	path := strings.Replace("/api/now/table/{table}", "{table}", url.PathEscape(tableVal), 1)
	query := ""
	body := in.Body
	return apiCall(ctx, "POST", path, query, body), nil, nil
}

func servicenowUpdateRecord(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowUpdateRecordIn) (*mcp.CallToolResult, any, error) {
	tableVal := strings.TrimSpace(in.Table)
	if tableVal == "" {
		return errorResult("servicenow_update_record: table is required"), nil, nil
	}
	sysIdVal := strings.TrimSpace(in.SysId)
	if sysIdVal == "" {
		return errorResult("servicenow_update_record: sysId is required"), nil, nil
	}
	path := strings.Replace(strings.Replace("/api/now/table/{table}/{sysId}", "{table}", url.PathEscape(tableVal), 1), "{sysId}", url.PathEscape(sysIdVal), 1)
	query := ""
	body := in.Body
	return apiCall(ctx, "PATCH", path, query, body), nil, nil
}

func servicenowDeleteRecord(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowDeleteRecordIn) (*mcp.CallToolResult, any, error) {
	tableVal := strings.TrimSpace(in.Table)
	if tableVal == "" {
		return errorResult("servicenow_delete_record: table is required"), nil, nil
	}
	sysIdVal := strings.TrimSpace(in.SysId)
	if sysIdVal == "" {
		return errorResult("servicenow_delete_record: sysId is required"), nil, nil
	}
	path := strings.Replace(strings.Replace("/api/now/table/{table}/{sysId}", "{table}", url.PathEscape(tableVal), 1), "{sysId}", url.PathEscape(sysIdVal), 1)
	query := ""
	body := in.Body
	return apiCall(ctx, "DELETE", path, query, body), nil, nil
}

func servicenowListCatalogItem(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowListCatalogItemIn) (*mcp.CallToolResult, any, error) {
	path := "/api/now/table/sc_cat_item"
	q := url.Values{}
	if v := strings.TrimSpace(in.SysparmLimit); v != "" {
		q.Set("sysparm_limit", v)
	}
	if v := strings.TrimSpace(in.SysparmQuery); v != "" {
		q.Set("sysparm_query", v)
	}
	if v := strings.TrimSpace(in.SysparmFields); v != "" {
		q.Set("sysparm_fields", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func servicenowGetCatalogItem(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowGetCatalogItemIn) (*mcp.CallToolResult, any, error) {
	sysIdVal := strings.TrimSpace(in.SysId)
	if sysIdVal == "" {
		return errorResult("servicenow_get_catalog_item: sysId is required"), nil, nil
	}
	path := strings.Replace("/api/now/table/sc_cat_item/{sysId}", "{sysId}", url.PathEscape(sysIdVal), 1)
	q := url.Values{}
	if v := strings.TrimSpace(in.SysparmFields); v != "" {
		q.Set("sysparm_fields", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func servicenowListCatalogCategory(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowListCatalogCategoryIn) (*mcp.CallToolResult, any, error) {
	path := "/api/now/table/sc_category"
	q := url.Values{}
	if v := strings.TrimSpace(in.SysparmLimit); v != "" {
		q.Set("sysparm_limit", v)
	}
	if v := strings.TrimSpace(in.SysparmQuery); v != "" {
		q.Set("sysparm_query", v)
	}
	if v := strings.TrimSpace(in.SysparmFields); v != "" {
		q.Set("sysparm_fields", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func servicenowListCatalogItemVariable(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowListCatalogItemVariableIn) (*mcp.CallToolResult, any, error) {
	path := "/api/now/table/item_option_new"
	q := url.Values{}
	if v := strings.TrimSpace(in.SysparmLimit); v != "" {
		q.Set("sysparm_limit", v)
	}
	if v := strings.TrimSpace(in.SysparmQuery); v != "" {
		q.Set("sysparm_query", v)
	}
	if v := strings.TrimSpace(in.SysparmFields); v != "" {
		q.Set("sysparm_fields", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func servicenowListCmdbCi(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowListCmdbCiIn) (*mcp.CallToolResult, any, error) {
	path := "/api/now/table/cmdb_ci"
	q := url.Values{}
	if v := strings.TrimSpace(in.SysparmLimit); v != "" {
		q.Set("sysparm_limit", v)
	}
	if v := strings.TrimSpace(in.SysparmQuery); v != "" {
		q.Set("sysparm_query", v)
	}
	if v := strings.TrimSpace(in.SysparmFields); v != "" {
		q.Set("sysparm_fields", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func servicenowListCmdbRelationship(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowListCmdbRelationshipIn) (*mcp.CallToolResult, any, error) {
	path := "/api/now/table/cmdb_rel_ci"
	q := url.Values{}
	if v := strings.TrimSpace(in.SysparmLimit); v != "" {
		q.Set("sysparm_limit", v)
	}
	if v := strings.TrimSpace(in.SysparmQuery); v != "" {
		q.Set("sysparm_query", v)
	}
	if v := strings.TrimSpace(in.SysparmFields); v != "" {
		q.Set("sysparm_fields", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func servicenowListCmdbInstance(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowListCmdbInstanceIn) (*mcp.CallToolResult, any, error) {
	classNameVal := strings.TrimSpace(in.ClassName)
	if classNameVal == "" {
		return errorResult("servicenow_list_cmdb_instance: className is required"), nil, nil
	}
	path := strings.Replace("/api/now/cmdb/instance/{className}", "{className}", url.PathEscape(classNameVal), 1)
	q := url.Values{}
	if v := strings.TrimSpace(in.SysparmLimit); v != "" {
		q.Set("sysparm_limit", v)
	}
	if v := strings.TrimSpace(in.SysparmQuery); v != "" {
		q.Set("sysparm_query", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func servicenowListCmdbClass(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowListCmdbClassIn) (*mcp.CallToolResult, any, error) {
	path := "/api/now/table/cmdb_class_info"
	q := url.Values{}
	if v := strings.TrimSpace(in.SysparmLimit); v != "" {
		q.Set("sysparm_limit", v)
	}
	if v := strings.TrimSpace(in.SysparmQuery); v != "" {
		q.Set("sysparm_query", v)
	}
	if v := strings.TrimSpace(in.SysparmFields); v != "" {
		q.Set("sysparm_fields", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func servicenowListGroupMember(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowListGroupMemberIn) (*mcp.CallToolResult, any, error) {
	path := "/api/now/table/sys_user_grmember"
	q := url.Values{}
	if v := strings.TrimSpace(in.SysparmLimit); v != "" {
		q.Set("sysparm_limit", v)
	}
	if v := strings.TrimSpace(in.SysparmQuery); v != "" {
		q.Set("sysparm_query", v)
	}
	if v := strings.TrimSpace(in.SysparmFields); v != "" {
		q.Set("sysparm_fields", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func servicenowListUserRole(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowListUserRoleIn) (*mcp.CallToolResult, any, error) {
	path := "/api/now/table/sys_user_has_role"
	q := url.Values{}
	if v := strings.TrimSpace(in.SysparmLimit); v != "" {
		q.Set("sysparm_limit", v)
	}
	if v := strings.TrimSpace(in.SysparmQuery); v != "" {
		q.Set("sysparm_query", v)
	}
	if v := strings.TrimSpace(in.SysparmFields); v != "" {
		q.Set("sysparm_fields", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func servicenowListRole(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowListRoleIn) (*mcp.CallToolResult, any, error) {
	path := "/api/now/table/sys_user_role"
	q := url.Values{}
	if v := strings.TrimSpace(in.SysparmLimit); v != "" {
		q.Set("sysparm_limit", v)
	}
	if v := strings.TrimSpace(in.SysparmQuery); v != "" {
		q.Set("sysparm_query", v)
	}
	if v := strings.TrimSpace(in.SysparmFields); v != "" {
		q.Set("sysparm_fields", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func servicenowListAcl(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowListAclIn) (*mcp.CallToolResult, any, error) {
	path := "/api/now/table/sys_security_acl"
	q := url.Values{}
	if v := strings.TrimSpace(in.SysparmLimit); v != "" {
		q.Set("sysparm_limit", v)
	}
	if v := strings.TrimSpace(in.SysparmQuery); v != "" {
		q.Set("sysparm_query", v)
	}
	if v := strings.TrimSpace(in.SysparmFields); v != "" {
		q.Set("sysparm_fields", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func servicenowListApproval(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowListApprovalIn) (*mcp.CallToolResult, any, error) {
	path := "/api/now/table/sysapproval_approver"
	q := url.Values{}
	if v := strings.TrimSpace(in.SysparmLimit); v != "" {
		q.Set("sysparm_limit", v)
	}
	if v := strings.TrimSpace(in.SysparmQuery); v != "" {
		q.Set("sysparm_query", v)
	}
	if v := strings.TrimSpace(in.SysparmFields); v != "" {
		q.Set("sysparm_fields", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func servicenowListTask(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowListTaskIn) (*mcp.CallToolResult, any, error) {
	path := "/api/now/table/task"
	q := url.Values{}
	if v := strings.TrimSpace(in.SysparmLimit); v != "" {
		q.Set("sysparm_limit", v)
	}
	if v := strings.TrimSpace(in.SysparmQuery); v != "" {
		q.Set("sysparm_query", v)
	}
	if v := strings.TrimSpace(in.SysparmFields); v != "" {
		q.Set("sysparm_fields", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func servicenowListSla(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowListSlaIn) (*mcp.CallToolResult, any, error) {
	path := "/api/now/table/contract_sla"
	q := url.Values{}
	if v := strings.TrimSpace(in.SysparmLimit); v != "" {
		q.Set("sysparm_limit", v)
	}
	if v := strings.TrimSpace(in.SysparmQuery); v != "" {
		q.Set("sysparm_query", v)
	}
	if v := strings.TrimSpace(in.SysparmFields); v != "" {
		q.Set("sysparm_fields", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func servicenowListTaskSla(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowListTaskSlaIn) (*mcp.CallToolResult, any, error) {
	path := "/api/now/table/task_sla"
	q := url.Values{}
	if v := strings.TrimSpace(in.SysparmLimit); v != "" {
		q.Set("sysparm_limit", v)
	}
	if v := strings.TrimSpace(in.SysparmQuery); v != "" {
		q.Set("sysparm_query", v)
	}
	if v := strings.TrimSpace(in.SysparmFields); v != "" {
		q.Set("sysparm_fields", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func servicenowListWorkflow(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowListWorkflowIn) (*mcp.CallToolResult, any, error) {
	path := "/api/now/table/wf_workflow"
	q := url.Values{}
	if v := strings.TrimSpace(in.SysparmLimit); v != "" {
		q.Set("sysparm_limit", v)
	}
	if v := strings.TrimSpace(in.SysparmQuery); v != "" {
		q.Set("sysparm_query", v)
	}
	if v := strings.TrimSpace(in.SysparmFields); v != "" {
		q.Set("sysparm_fields", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func servicenowListWorkflowContext(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowListWorkflowContextIn) (*mcp.CallToolResult, any, error) {
	path := "/api/now/table/wf_context"
	q := url.Values{}
	if v := strings.TrimSpace(in.SysparmLimit); v != "" {
		q.Set("sysparm_limit", v)
	}
	if v := strings.TrimSpace(in.SysparmQuery); v != "" {
		q.Set("sysparm_query", v)
	}
	if v := strings.TrimSpace(in.SysparmFields); v != "" {
		q.Set("sysparm_fields", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func servicenowListEmail(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowListEmailIn) (*mcp.CallToolResult, any, error) {
	path := "/api/now/table/sys_email"
	q := url.Values{}
	if v := strings.TrimSpace(in.SysparmLimit); v != "" {
		q.Set("sysparm_limit", v)
	}
	if v := strings.TrimSpace(in.SysparmQuery); v != "" {
		q.Set("sysparm_query", v)
	}
	if v := strings.TrimSpace(in.SysparmFields); v != "" {
		q.Set("sysparm_fields", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func servicenowListNotification(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowListNotificationIn) (*mcp.CallToolResult, any, error) {
	path := "/api/now/table/sysevent_email_action"
	q := url.Values{}
	if v := strings.TrimSpace(in.SysparmLimit); v != "" {
		q.Set("sysparm_limit", v)
	}
	if v := strings.TrimSpace(in.SysparmQuery); v != "" {
		q.Set("sysparm_query", v)
	}
	if v := strings.TrimSpace(in.SysparmFields); v != "" {
		q.Set("sysparm_fields", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func servicenowListEvent(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowListEventIn) (*mcp.CallToolResult, any, error) {
	path := "/api/now/table/sysevent"
	q := url.Values{}
	if v := strings.TrimSpace(in.SysparmLimit); v != "" {
		q.Set("sysparm_limit", v)
	}
	if v := strings.TrimSpace(in.SysparmQuery); v != "" {
		q.Set("sysparm_query", v)
	}
	if v := strings.TrimSpace(in.SysparmFields); v != "" {
		q.Set("sysparm_fields", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func servicenowCreateEvent(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowCreateEventIn) (*mcp.CallToolResult, any, error) {
	path := "/api/now/table/sysevent"
	query := ""
	body := in.Body
	return apiCall(ctx, "POST", path, query, body), nil, nil
}

func servicenowListJournal(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowListJournalIn) (*mcp.CallToolResult, any, error) {
	path := "/api/now/table/sys_journal_field"
	q := url.Values{}
	if v := strings.TrimSpace(in.SysparmLimit); v != "" {
		q.Set("sysparm_limit", v)
	}
	if v := strings.TrimSpace(in.SysparmQuery); v != "" {
		q.Set("sysparm_query", v)
	}
	if v := strings.TrimSpace(in.SysparmFields); v != "" {
		q.Set("sysparm_fields", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func servicenowListAudit(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowListAuditIn) (*mcp.CallToolResult, any, error) {
	path := "/api/now/table/sys_audit"
	q := url.Values{}
	if v := strings.TrimSpace(in.SysparmLimit); v != "" {
		q.Set("sysparm_limit", v)
	}
	if v := strings.TrimSpace(in.SysparmQuery); v != "" {
		q.Set("sysparm_query", v)
	}
	if v := strings.TrimSpace(in.SysparmFields); v != "" {
		q.Set("sysparm_fields", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func servicenowListScheduledJob(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowListScheduledJobIn) (*mcp.CallToolResult, any, error) {
	path := "/api/now/table/sysauto_script"
	q := url.Values{}
	if v := strings.TrimSpace(in.SysparmLimit); v != "" {
		q.Set("sysparm_limit", v)
	}
	if v := strings.TrimSpace(in.SysparmQuery); v != "" {
		q.Set("sysparm_query", v)
	}
	if v := strings.TrimSpace(in.SysparmFields); v != "" {
		q.Set("sysparm_fields", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func servicenowListUpdateSet(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowListUpdateSetIn) (*mcp.CallToolResult, any, error) {
	path := "/api/now/table/sys_update_set"
	q := url.Values{}
	if v := strings.TrimSpace(in.SysparmLimit); v != "" {
		q.Set("sysparm_limit", v)
	}
	if v := strings.TrimSpace(in.SysparmQuery); v != "" {
		q.Set("sysparm_query", v)
	}
	if v := strings.TrimSpace(in.SysparmFields); v != "" {
		q.Set("sysparm_fields", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func servicenowListAsset(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowListAssetIn) (*mcp.CallToolResult, any, error) {
	path := "/api/now/table/alm_asset"
	q := url.Values{}
	if v := strings.TrimSpace(in.SysparmLimit); v != "" {
		q.Set("sysparm_limit", v)
	}
	if v := strings.TrimSpace(in.SysparmQuery); v != "" {
		q.Set("sysparm_query", v)
	}
	if v := strings.TrimSpace(in.SysparmFields); v != "" {
		q.Set("sysparm_fields", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func servicenowGetAsset(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowGetAssetIn) (*mcp.CallToolResult, any, error) {
	sysIdVal := strings.TrimSpace(in.SysId)
	if sysIdVal == "" {
		return errorResult("servicenow_get_asset: sysId is required"), nil, nil
	}
	path := strings.Replace("/api/now/table/alm_asset/{sysId}", "{sysId}", url.PathEscape(sysIdVal), 1)
	q := url.Values{}
	if v := strings.TrimSpace(in.SysparmFields); v != "" {
		q.Set("sysparm_fields", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func servicenowListLicense(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowListLicenseIn) (*mcp.CallToolResult, any, error) {
	path := "/api/now/table/alm_license"
	q := url.Values{}
	if v := strings.TrimSpace(in.SysparmLimit); v != "" {
		q.Set("sysparm_limit", v)
	}
	if v := strings.TrimSpace(in.SysparmQuery); v != "" {
		q.Set("sysparm_query", v)
	}
	if v := strings.TrimSpace(in.SysparmFields); v != "" {
		q.Set("sysparm_fields", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func servicenowListLicenseEntitlement(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowListLicenseEntitlementIn) (*mcp.CallToolResult, any, error) {
	path := "/api/now/table/alm_entitlement"
	q := url.Values{}
	if v := strings.TrimSpace(in.SysparmLimit); v != "" {
		q.Set("sysparm_limit", v)
	}
	if v := strings.TrimSpace(in.SysparmQuery); v != "" {
		q.Set("sysparm_query", v)
	}
	if v := strings.TrimSpace(in.SysparmFields); v != "" {
		q.Set("sysparm_fields", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func servicenowListSoftware(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowListSoftwareIn) (*mcp.CallToolResult, any, error) {
	path := "/api/now/table/cmdb_sam_sw_install"
	q := url.Values{}
	if v := strings.TrimSpace(in.SysparmLimit); v != "" {
		q.Set("sysparm_limit", v)
	}
	if v := strings.TrimSpace(in.SysparmQuery); v != "" {
		q.Set("sysparm_query", v)
	}
	if v := strings.TrimSpace(in.SysparmFields); v != "" {
		q.Set("sysparm_fields", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func servicenowListContract(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowListContractIn) (*mcp.CallToolResult, any, error) {
	path := "/api/now/table/ast_contract"
	q := url.Values{}
	if v := strings.TrimSpace(in.SysparmLimit); v != "" {
		q.Set("sysparm_limit", v)
	}
	if v := strings.TrimSpace(in.SysparmQuery); v != "" {
		q.Set("sysparm_query", v)
	}
	if v := strings.TrimSpace(in.SysparmFields); v != "" {
		q.Set("sysparm_fields", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func servicenowListLocation(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowListLocationIn) (*mcp.CallToolResult, any, error) {
	path := "/api/now/table/cmn_location"
	q := url.Values{}
	if v := strings.TrimSpace(in.SysparmLimit); v != "" {
		q.Set("sysparm_limit", v)
	}
	if v := strings.TrimSpace(in.SysparmQuery); v != "" {
		q.Set("sysparm_query", v)
	}
	if v := strings.TrimSpace(in.SysparmFields); v != "" {
		q.Set("sysparm_fields", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func servicenowListDepartment(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowListDepartmentIn) (*mcp.CallToolResult, any, error) {
	path := "/api/now/table/cmn_department"
	q := url.Values{}
	if v := strings.TrimSpace(in.SysparmLimit); v != "" {
		q.Set("sysparm_limit", v)
	}
	if v := strings.TrimSpace(in.SysparmQuery); v != "" {
		q.Set("sysparm_query", v)
	}
	if v := strings.TrimSpace(in.SysparmFields); v != "" {
		q.Set("sysparm_fields", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func servicenowListCostCenter(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowListCostCenterIn) (*mcp.CallToolResult, any, error) {
	path := "/api/now/table/cmn_cost_center"
	q := url.Values{}
	if v := strings.TrimSpace(in.SysparmLimit); v != "" {
		q.Set("sysparm_limit", v)
	}
	if v := strings.TrimSpace(in.SysparmQuery); v != "" {
		q.Set("sysparm_query", v)
	}
	if v := strings.TrimSpace(in.SysparmFields); v != "" {
		q.Set("sysparm_fields", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func servicenowListDiscoveryStatus(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowListDiscoveryStatusIn) (*mcp.CallToolResult, any, error) {
	path := "/api/now/table/discovery_status"
	q := url.Values{}
	if v := strings.TrimSpace(in.SysparmLimit); v != "" {
		q.Set("sysparm_limit", v)
	}
	if v := strings.TrimSpace(in.SysparmQuery); v != "" {
		q.Set("sysparm_query", v)
	}
	if v := strings.TrimSpace(in.SysparmFields); v != "" {
		q.Set("sysparm_fields", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func servicenowListDiscoverySchedule(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowListDiscoveryScheduleIn) (*mcp.CallToolResult, any, error) {
	path := "/api/now/table/discovery_schedule"
	q := url.Values{}
	if v := strings.TrimSpace(in.SysparmLimit); v != "" {
		q.Set("sysparm_limit", v)
	}
	if v := strings.TrimSpace(in.SysparmQuery); v != "" {
		q.Set("sysparm_query", v)
	}
	if v := strings.TrimSpace(in.SysparmFields); v != "" {
		q.Set("sysparm_fields", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func servicenowTableSchema(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowTableSchemaIn) (*mcp.CallToolResult, any, error) {
	path := "/api/now/table/sys_dictionary"
	q := url.Values{}
	if v := strings.TrimSpace(in.SysparmLimit); v != "" {
		q.Set("sysparm_limit", v)
	}
	if v := strings.TrimSpace(in.SysparmQuery); v != "" {
		q.Set("sysparm_query", v)
	}
	if v := strings.TrimSpace(in.SysparmFields); v != "" {
		q.Set("sysparm_fields", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func servicenowListChoice(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowListChoiceIn) (*mcp.CallToolResult, any, error) {
	path := "/api/now/table/sys_choice"
	q := url.Values{}
	if v := strings.TrimSpace(in.SysparmLimit); v != "" {
		q.Set("sysparm_limit", v)
	}
	if v := strings.TrimSpace(in.SysparmQuery); v != "" {
		q.Set("sysparm_query", v)
	}
	if v := strings.TrimSpace(in.SysparmFields); v != "" {
		q.Set("sysparm_fields", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func servicenowListAttachment(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowListAttachmentIn) (*mcp.CallToolResult, any, error) {
	path := "/api/now/attachment"
	q := url.Values{}
	if v := strings.TrimSpace(in.SysparmQuery); v != "" {
		q.Set("sysparm_query", v)
	}
	if v := strings.TrimSpace(in.SysparmLimit); v != "" {
		q.Set("sysparm_limit", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func servicenowGetAttachment(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowGetAttachmentIn) (*mcp.CallToolResult, any, error) {
	sysIdVal := strings.TrimSpace(in.SysId)
	if sysIdVal == "" {
		return errorResult("servicenow_get_attachment: sysId is required"), nil, nil
	}
	path := strings.Replace("/api/now/attachment/{sysId}", "{sysId}", url.PathEscape(sysIdVal), 1)
	query := ""
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func servicenowDownloadAttachment(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowDownloadAttachmentIn) (*mcp.CallToolResult, any, error) {
	sysIdVal := strings.TrimSpace(in.SysId)
	if sysIdVal == "" {
		return errorResult("servicenow_download_attachment: sysId is required"), nil, nil
	}
	path := strings.Replace("/api/now/attachment/{sysId}/file", "{sysId}", url.PathEscape(sysIdVal), 1)
	query := ""
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func servicenowDeleteAttachment(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowDeleteAttachmentIn) (*mcp.CallToolResult, any, error) {
	sysIdVal := strings.TrimSpace(in.SysId)
	if sysIdVal == "" {
		return errorResult("servicenow_delete_attachment: sysId is required"), nil, nil
	}
	path := strings.Replace("/api/now/attachment/{sysId}", "{sysId}", url.PathEscape(sysIdVal), 1)
	query := ""
	body := in.Body
	return apiCall(ctx, "DELETE", path, query, body), nil, nil
}

func servicenowAggregate(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowAggregateIn) (*mcp.CallToolResult, any, error) {
	tableVal := strings.TrimSpace(in.Table)
	if tableVal == "" {
		return errorResult("servicenow_aggregate: table is required"), nil, nil
	}
	path := strings.Replace("/api/now/stats/{table}", "{table}", url.PathEscape(tableVal), 1)
	q := url.Values{}
	if v := strings.TrimSpace(in.SysparmQuery); v != "" {
		q.Set("sysparm_query", v)
	}
	if v := strings.TrimSpace(in.SysparmCount); v != "" {
		q.Set("sysparm_count", v)
	}
	if v := strings.TrimSpace(in.SysparmGroupBy); v != "" {
		q.Set("sysparm_group_by", v)
	}
	if v := strings.TrimSpace(in.SysparmSumFields); v != "" {
		q.Set("sysparm_sum_fields", v)
	}
	if v := strings.TrimSpace(in.SysparmAvgFields); v != "" {
		q.Set("sysparm_avg_fields", v)
	}
	if v := strings.TrimSpace(in.SysparmHaving); v != "" {
		q.Set("sysparm_having", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func servicenowImportSetLoad(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowImportSetLoadIn) (*mcp.CallToolResult, any, error) {
	tableVal := strings.TrimSpace(in.Table)
	if tableVal == "" {
		return errorResult("servicenow_import_set_load: table is required"), nil, nil
	}
	path := strings.Replace("/api/now/import/{table}", "{table}", url.PathEscape(tableVal), 1)
	query := ""
	body := in.Body
	return apiCall(ctx, "POST", path, query, body), nil, nil
}

func servicenowBatchRequest(ctx context.Context, _ *mcp.CallToolRequest, in ServicenowBatchRequestIn) (*mcp.CallToolResult, any, error) {
	path := "/api/now/v1/batch"
	query := ""
	body := in.Body
	return apiCall(ctx, "POST", path, query, body), nil, nil
}

// helpHandler returns static usage text for this server (Conformance Lab
// instrumentation gate requires a <server>_help tool with a topic parameter).
func helpHandler(_ context.Context, _ *mcp.CallToolRequest, _ helpIn) (*mcp.CallToolResult, any, error) {
	return textResult("servicenow-mcp — thesun-generated Go MCP server (streamable-HTTP only).\n\nTools:\n- servicenow_list_incident: List incident records from the ServiceNow Table API. Use sysparm_query to filter (encoded query, e.g. 'active=true^priority=1') and sysparm_limit to bound the result set. Read-only.\n- servicenow_get_incident: Get a single incident record by its sys_id. Requires a sysId — call servicenow_list_incident first to obtain one from a result row. Read-only.\n- servicenow_list_change_request: List change_request records from the ServiceNow Table API. Use sysparm_query to filter and sysparm_limit to bound results. Read-only.\n- servicenow_get_change_request: Get a single change_request record by its sys_id. Requires a sysId — call servicenow_list_change_request first. Read-only.\n- servicenow_list_change_task: List change_task records (tasks under change requests) from the Table API. Filter by parent change with sysparm_query='change_request=<sysId>'. Read-only.\n- servicenow_list_problem: List problem records from the ServiceNow Table API. Use sysparm_query to filter and sysparm_limit to bound results. Read-only.\n- servicenow_get_problem: Get a single problem record by its sys_id. Requires a sysId — call servicenow_list_problem first. Read-only.\n- servicenow_list_request: List sc_request (service catalog request / REQ) records from the Table API. Read-only.\n- servicenow_list_requested_item: List sc_req_item (requested item / RITM) records from the Table API. Filter by parent request with sysparm_query='request=<sysId>'. Read-only.\n- servicenow_list_knowledge: List kb_knowledge (knowledge base article) records from the Table API. Use sysparm_query to filter by workflow_state or text. Read-only.\n- servicenow_get_knowledge: Get a single kb_knowledge article by its sys_id. Requires a sysId — call servicenow_list_knowledge first. Read-only.\n- servicenow_list_sys_user: List sys_user records from the ServiceNow Table API. Use sysparm_query to filter by name, email, or department. Read-only.\n- servicenow_get_sys_user: Get a single sys_user record by its sys_id. Requires a sysId — call servicenow_list_sys_user first. Read-only.\n- servicenow_list_group: List sys_user_group (assignment group) records from the Table API. Use sysparm_query to filter by name. Read-only.\n- servicenow_query_table: Generic Table API read — list records from ANY ServiceNow table. Requires a table name. Powerful catch-all covering tables without a dedicated tool (e.g. cmdb_ci, sc_task, incident_task, sys_journal_field). Read-only.\n- servicenow_get_record: Generic Table API read — get a single record by sys_id from ANY table. Requires a table name and a sysId. Call servicenow_query_table first to obtain a sysId. Read-only.\n- servicenow_create_incident: Create a new incident record. WRITE operation — provide the new incident fields (short_description, description, urgency, impact, caller_id, etc.) as a JSON object in the request body.\n- servicenow_update_incident: Update an existing incident record. WRITE operation. Requires a sysId — call servicenow_list_incident first. Provide the fields to change (state, work_notes, comments, assigned_to, resolution_code, resolution_notes, etc.) as a JSON object in the request body. Also covers add-comment and resolve by setting the relevant fields.\n- servicenow_create_change_request: Create a new change_request record. WRITE operation — provide fields (short_description, type, category, assignment_group, start_date, end_date, justification, implementation_plan, backout_plan, test_plan, etc.) as a JSON object in the request body.\n- servicenow_create_problem: Create a new problem record. WRITE operation — provide fields (short_description, description, category, assignment_group, cmdb_ci, etc.) as a JSON object in the request body.\n- servicenow_create_record: Create a new record in ANY ServiceNow table. WRITE operation. Requires a table name. Provide the new record fields as a JSON object in the request body.\n- servicenow_update_record: Update an existing record in ANY ServiceNow table. WRITE operation. Requires a table name and a sysId — call servicenow_query_table first. Provide the fields to change as a JSON object in the request body.\n- servicenow_delete_record: Delete a record from ANY ServiceNow table by sys_id. WRITE operation. Requires a table name and a sysId — call servicenow_query_table first to obtain the sys_id.\n- servicenow_list_catalog_item: List sc_cat_item (service catalog item) records from the Table API. Use sysparm_query to filter by category or name. Read-only.\n- servicenow_get_catalog_item: Get a single sc_cat_item (catalog item) by its sys_id. Requires a sysId — call servicenow_list_catalog_item first. Read-only.\n- servicenow_list_catalog_category: List sc_category (service catalog category) records from the Table API. Read-only.\n- servicenow_list_catalog_item_variable: List item_option_new (catalog item variables/questions) records. Filter by parent item with sysparm_query='cat_item=<sysId>' to obtain the required fields for a request. Read-only.\n- servicenow_list_cmdb_ci: List cmdb_ci (configuration item) records from the Table API. Use sysparm_query to filter by name or class. Read-only.\n- servicenow_list_cmdb_relationship: List cmdb_rel_ci (CI relationship) records. Filter by CI with sysparm_query='parent=<sysId>' or 'child=<sysId>'. Read-only.\n- servicenow_list_cmdb_instance: List CMDB instances of a class via the CMDB Instance API (/api/now/cmdb/instance). Requires a className (e.g. 'cmdb_ci_server'). Read-only.\n- servicenow_list_cmdb_class: List CMDB CI classes. Read-only. (Backed by sys_db_object-derived class metadata; use query_table on sys_db_object for the authoritative class list.)\n- servicenow_list_group_member: List sys_user_grmember (group membership) records. Filter by group with sysparm_query='group=<sysId>' or by user with 'user=<sysId>'. Read-only.\n- servicenow_list_user_role: List sys_user_has_role (user role grant) records. Filter by user with sysparm_query='user=<sysId>'. Read-only.\n- servicenow_list_role: List sys_user_role (role definition) records from the Table API. Read-only.\n- servicenow_list_acl: List sys_security_acl (access control rule) records. Filter by table/operation via sysparm_query. Read-only.\n- servicenow_list_approval: List sysapproval_approver (approval) records. Filter pending with sysparm_query='state=requested' and by approver with 'approver=<sysId>'. Read-only. (Approve/reject is a WRITE PATCH via update_record setting state=approved|rejected.)\n- servicenow_list_task: List task records (base task table — incidents, changes, RITMs, etc.) from the Table API. Filter assigned work with sysparm_query='assigned_to=<sysId>^active=true'. Read-only.\n- servicenow_list_sla: List contract_sla (SLA definition) records from the Table API. Read-only.\n- servicenow_list_task_sla: List task_sla (SLA records attached to tasks) from the Table API. Filter by task with sysparm_query='task=<sysId>'. Read-only.\n- servicenow_list_workflow: List wf_workflow (workflow definition) records from the Table API. Read-only.\n- servicenow_list_workflow_context: List wf_context (running workflow instance) records from the Table API. Read-only.\n- servicenow_list_email: List sys_email (outbound/inbound email) records from the Table API. Read-only.\n- servicenow_list_notification: List sysevent_email_action (email notification rule) records from the Table API. Read-only.\n- servicenow_list_event: List sysevent (system event) records from the Table API. Read-only.\n- servicenow_create_event: Create/fire a system event by inserting a sysevent record. WRITE operation — provide fields (name, instance, parm1, parm2, table) as a JSON object in the request body.\n- servicenow_list_journal: List sys_journal_field (work notes / comments) entries for a record. Filter with sysparm_query='element_id=<record sysId>'. Read-only.\n- servicenow_list_audit: List sys_audit (field-level change history) entries for a record. Filter with sysparm_query='tablename=<table>^documentkey=<record sysId>'. Read-only.\n- servicenow_list_scheduled_job: List sysauto_script (scheduled script job) records from the Table API. Read-only.\n- servicenow_list_update_set: List sys_update_set (update set) records from the Table API. Read-only.\n- servicenow_list_asset: List alm_asset (asset) records from the Table API. Filter by asset_tag/state via sysparm_query. Read-only.\n- servicenow_get_asset: Get a single alm_asset (asset) by its sys_id. Requires a sysId — call servicenow_list_asset first. Read-only.\n- servicenow_list_license: List alm_license (software license) records from the Table API. Read-only.\n- servicenow_list_license_entitlement: List alm_entitlement (license entitlement/allocation) records. Filter by license with sysparm_query='license=<sysId>'. Read-only.\n- servicenow_list_software: List cmdb_sam_sw_install (software installation) records from the Table API. Read-only.\n- servicenow_list_contract: List ast_contract (contract) records from the Table API. Read-only.\n- servicenow_list_location: List cmn_location (location) records from the Table API. Read-only.\n- servicenow_list_department: List cmn_department (department) records from the Table API. Read-only.\n- servicenow_list_cost_center: List cmn_cost_center (cost center) records from the Table API. Read-only.\n- servicenow_list_discovery_status: List discovery_status records from the Table API. Read-only.\n- servicenow_list_discovery_schedule: List discovery_schedule records from the Table API. Read-only.\n- servicenow_table_schema: Get table schema/dictionary information. Filter with sysparm_query='name=<table>' to list a table's columns (field name, type, label). Read-only.\n- servicenow_list_choice: Get choice list values for a field. Filter with sysparm_query='name=<table>^element=<field>'. Read-only.\n- servicenow_list_attachment: List attachment metadata for a record via the Attachment API. Filter with sysparm_query='table_name=<table>^table_sys_id=<record sysId>'. Read-only.\n- servicenow_get_attachment: Get attachment metadata by its sys_id via the Attachment API. Requires a sysId — call servicenow_list_attachment first. Read-only.\n- servicenow_download_attachment: Download attachment binary content via the Attachment API. Requires a sysId — call servicenow_list_attachment first. Returns the raw file bytes (binary/base64 for non-text). Read-only.\n- servicenow_delete_attachment: Delete an attachment by its sys_id via the Attachment API. WRITE operation. Requires a sysId — call servicenow_list_attachment first.\n- servicenow_aggregate: Run aggregate queries (count, sum, avg, min, max) over a table via the Aggregate API. Requires a table name. Use sysparm_count=true for counts, sysparm_sum_fields/sysparm_avg_fields for math, sysparm_group_by to group. Read-only.\n- servicenow_import_set_load: Load a record into an import set staging table via the Import Set API. WRITE operation. Requires a staging table name (e.g. 'u_imp_incident'). Provide the row fields as a JSON object in the request body; ServiceNow runs the transform map and returns the resulting target record(s).\n- servicenow_batch_request: Execute multiple ServiceNow REST requests in a single call via the Batch API. WRITE-class (may contain writes). Provide {batch_request_id, rest_requests:[{id, method, url, headers, body}]} as a JSON object in the request body.\n\nCredentials are read from the environment at runtime and are never logged or surfaced in tool output."), nil, nil
}

func main() {
	log.SetFlags(0)

	srv := mcp.NewServer(&mcp.Implementation{Name: serverName, Version: version}, nil)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_list_incident",
		Description: "List incident records from the ServiceNow Table API. Use sysparm_query to filter (encoded query, e.g. 'active=true^priority=1') and sysparm_limit to bound the result set. Read-only.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowListIncident)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_get_incident",
		Description: "Get a single incident record by its sys_id. Requires a sysId — call servicenow_list_incident first to obtain one from a result row. Read-only.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowGetIncident)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_list_change_request",
		Description: "List change_request records from the ServiceNow Table API. Use sysparm_query to filter and sysparm_limit to bound results. Read-only.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowListChangeRequest)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_get_change_request",
		Description: "Get a single change_request record by its sys_id. Requires a sysId — call servicenow_list_change_request first. Read-only.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowGetChangeRequest)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_list_change_task",
		Description: "List change_task records (tasks under change requests) from the Table API. Filter by parent change with sysparm_query='change_request=<sysId>'. Read-only.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowListChangeTask)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_list_problem",
		Description: "List problem records from the ServiceNow Table API. Use sysparm_query to filter and sysparm_limit to bound results. Read-only.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowListProblem)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_get_problem",
		Description: "Get a single problem record by its sys_id. Requires a sysId — call servicenow_list_problem first. Read-only.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowGetProblem)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_list_request",
		Description: "List sc_request (service catalog request / REQ) records from the Table API. Read-only.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowListRequest)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_list_requested_item",
		Description: "List sc_req_item (requested item / RITM) records from the Table API. Filter by parent request with sysparm_query='request=<sysId>'. Read-only.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowListRequestedItem)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_list_knowledge",
		Description: "List kb_knowledge (knowledge base article) records from the Table API. Use sysparm_query to filter by workflow_state or text. Read-only.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowListKnowledge)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_get_knowledge",
		Description: "Get a single kb_knowledge article by its sys_id. Requires a sysId — call servicenow_list_knowledge first. Read-only.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowGetKnowledge)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_list_sys_user",
		Description: "List sys_user records from the ServiceNow Table API. Use sysparm_query to filter by name, email, or department. Read-only.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowListSysUser)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_get_sys_user",
		Description: "Get a single sys_user record by its sys_id. Requires a sysId — call servicenow_list_sys_user first. Read-only.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowGetSysUser)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_list_group",
		Description: "List sys_user_group (assignment group) records from the Table API. Use sysparm_query to filter by name. Read-only.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowListGroup)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_query_table",
		Description: "Generic Table API read — list records from ANY ServiceNow table. Requires a table name. Powerful catch-all covering tables without a dedicated tool (e.g. cmdb_ci, sc_task, incident_task, sys_journal_field). Read-only.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowQueryTable)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_get_record",
		Description: "Generic Table API read — get a single record by sys_id from ANY table. Requires a table name and a sysId. Call servicenow_query_table first to obtain a sysId. Read-only.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowGetRecord)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_create_incident",
		Description: "Create a new incident record. WRITE operation — provide the new incident fields (short_description, description, urgency, impact, caller_id, etc.) as a JSON object in the request body.",
		Annotations: &mcp.ToolAnnotations{
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowCreateIncident)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_update_incident",
		Description: "Update an existing incident record. WRITE operation. Requires a sysId — call servicenow_list_incident first. Provide the fields to change (state, work_notes, comments, assigned_to, resolution_code, resolution_notes, etc.) as a JSON object in the request body. Also covers add-comment and resolve by setting the relevant fields.",
		Annotations: &mcp.ToolAnnotations{
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowUpdateIncident)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_create_change_request",
		Description: "Create a new change_request record. WRITE operation — provide fields (short_description, type, category, assignment_group, start_date, end_date, justification, implementation_plan, backout_plan, test_plan, etc.) as a JSON object in the request body.",
		Annotations: &mcp.ToolAnnotations{
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowCreateChangeRequest)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_create_problem",
		Description: "Create a new problem record. WRITE operation — provide fields (short_description, description, category, assignment_group, cmdb_ci, etc.) as a JSON object in the request body.",
		Annotations: &mcp.ToolAnnotations{
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowCreateProblem)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_create_record",
		Description: "Create a new record in ANY ServiceNow table. WRITE operation. Requires a table name. Provide the new record fields as a JSON object in the request body.",
		Annotations: &mcp.ToolAnnotations{
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowCreateRecord)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_update_record",
		Description: "Update an existing record in ANY ServiceNow table. WRITE operation. Requires a table name and a sysId — call servicenow_query_table first. Provide the fields to change as a JSON object in the request body.",
		Annotations: &mcp.ToolAnnotations{
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowUpdateRecord)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_delete_record",
		Description: "Delete a record from ANY ServiceNow table by sys_id. WRITE operation. Requires a table name and a sysId — call servicenow_query_table first to obtain the sys_id.",
		Annotations: &mcp.ToolAnnotations{
			IdempotentHint:  true,
			DestructiveHint: boolPtr(true),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowDeleteRecord)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_list_catalog_item",
		Description: "List sc_cat_item (service catalog item) records from the Table API. Use sysparm_query to filter by category or name. Read-only.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowListCatalogItem)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_get_catalog_item",
		Description: "Get a single sc_cat_item (catalog item) by its sys_id. Requires a sysId — call servicenow_list_catalog_item first. Read-only.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowGetCatalogItem)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_list_catalog_category",
		Description: "List sc_category (service catalog category) records from the Table API. Read-only.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowListCatalogCategory)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_list_catalog_item_variable",
		Description: "List item_option_new (catalog item variables/questions) records. Filter by parent item with sysparm_query='cat_item=<sysId>' to obtain the required fields for a request. Read-only.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowListCatalogItemVariable)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_list_cmdb_ci",
		Description: "List cmdb_ci (configuration item) records from the Table API. Use sysparm_query to filter by name or class. Read-only.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowListCmdbCi)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_list_cmdb_relationship",
		Description: "List cmdb_rel_ci (CI relationship) records. Filter by CI with sysparm_query='parent=<sysId>' or 'child=<sysId>'. Read-only.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowListCmdbRelationship)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_list_cmdb_instance",
		Description: "List CMDB instances of a class via the CMDB Instance API (/api/now/cmdb/instance). Requires a className (e.g. 'cmdb_ci_server'). Read-only.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowListCmdbInstance)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_list_cmdb_class",
		Description: "List CMDB CI classes. Read-only. (Backed by sys_db_object-derived class metadata; use query_table on sys_db_object for the authoritative class list.)",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowListCmdbClass)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_list_group_member",
		Description: "List sys_user_grmember (group membership) records. Filter by group with sysparm_query='group=<sysId>' or by user with 'user=<sysId>'. Read-only.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowListGroupMember)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_list_user_role",
		Description: "List sys_user_has_role (user role grant) records. Filter by user with sysparm_query='user=<sysId>'. Read-only.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowListUserRole)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_list_role",
		Description: "List sys_user_role (role definition) records from the Table API. Read-only.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowListRole)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_list_acl",
		Description: "List sys_security_acl (access control rule) records. Filter by table/operation via sysparm_query. Read-only.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowListAcl)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_list_approval",
		Description: "List sysapproval_approver (approval) records. Filter pending with sysparm_query='state=requested' and by approver with 'approver=<sysId>'. Read-only. (Approve/reject is a WRITE PATCH via update_record setting state=approved|rejected.)",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowListApproval)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_list_task",
		Description: "List task records (base task table — incidents, changes, RITMs, etc.) from the Table API. Filter assigned work with sysparm_query='assigned_to=<sysId>^active=true'. Read-only.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowListTask)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_list_sla",
		Description: "List contract_sla (SLA definition) records from the Table API. Read-only.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowListSla)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_list_task_sla",
		Description: "List task_sla (SLA records attached to tasks) from the Table API. Filter by task with sysparm_query='task=<sysId>'. Read-only.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowListTaskSla)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_list_workflow",
		Description: "List wf_workflow (workflow definition) records from the Table API. Read-only.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowListWorkflow)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_list_workflow_context",
		Description: "List wf_context (running workflow instance) records from the Table API. Read-only.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowListWorkflowContext)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_list_email",
		Description: "List sys_email (outbound/inbound email) records from the Table API. Read-only.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowListEmail)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_list_notification",
		Description: "List sysevent_email_action (email notification rule) records from the Table API. Read-only.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowListNotification)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_list_event",
		Description: "List sysevent (system event) records from the Table API. Read-only.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowListEvent)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_create_event",
		Description: "Create/fire a system event by inserting a sysevent record. WRITE operation — provide fields (name, instance, parm1, parm2, table) as a JSON object in the request body.",
		Annotations: &mcp.ToolAnnotations{
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowCreateEvent)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_list_journal",
		Description: "List sys_journal_field (work notes / comments) entries for a record. Filter with sysparm_query='element_id=<record sysId>'. Read-only.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowListJournal)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_list_audit",
		Description: "List sys_audit (field-level change history) entries for a record. Filter with sysparm_query='tablename=<table>^documentkey=<record sysId>'. Read-only.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowListAudit)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_list_scheduled_job",
		Description: "List sysauto_script (scheduled script job) records from the Table API. Read-only.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowListScheduledJob)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_list_update_set",
		Description: "List sys_update_set (update set) records from the Table API. Read-only.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowListUpdateSet)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_list_asset",
		Description: "List alm_asset (asset) records from the Table API. Filter by asset_tag/state via sysparm_query. Read-only.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowListAsset)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_get_asset",
		Description: "Get a single alm_asset (asset) by its sys_id. Requires a sysId — call servicenow_list_asset first. Read-only.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowGetAsset)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_list_license",
		Description: "List alm_license (software license) records from the Table API. Read-only.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowListLicense)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_list_license_entitlement",
		Description: "List alm_entitlement (license entitlement/allocation) records. Filter by license with sysparm_query='license=<sysId>'. Read-only.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowListLicenseEntitlement)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_list_software",
		Description: "List cmdb_sam_sw_install (software installation) records from the Table API. Read-only.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowListSoftware)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_list_contract",
		Description: "List ast_contract (contract) records from the Table API. Read-only.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowListContract)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_list_location",
		Description: "List cmn_location (location) records from the Table API. Read-only.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowListLocation)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_list_department",
		Description: "List cmn_department (department) records from the Table API. Read-only.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowListDepartment)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_list_cost_center",
		Description: "List cmn_cost_center (cost center) records from the Table API. Read-only.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowListCostCenter)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_list_discovery_status",
		Description: "List discovery_status records from the Table API. Read-only.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowListDiscoveryStatus)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_list_discovery_schedule",
		Description: "List discovery_schedule records from the Table API. Read-only.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowListDiscoverySchedule)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_table_schema",
		Description: "Get table schema/dictionary information. Filter with sysparm_query='name=<table>' to list a table's columns (field name, type, label). Read-only.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowTableSchema)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_list_choice",
		Description: "Get choice list values for a field. Filter with sysparm_query='name=<table>^element=<field>'. Read-only.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowListChoice)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_list_attachment",
		Description: "List attachment metadata for a record via the Attachment API. Filter with sysparm_query='table_name=<table>^table_sys_id=<record sysId>'. Read-only.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowListAttachment)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_get_attachment",
		Description: "Get attachment metadata by its sys_id via the Attachment API. Requires a sysId — call servicenow_list_attachment first. Read-only.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowGetAttachment)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_download_attachment",
		Description: "Download attachment binary content via the Attachment API. Requires a sysId — call servicenow_list_attachment first. Returns the raw file bytes (binary/base64 for non-text). Read-only.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowDownloadAttachment)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_delete_attachment",
		Description: "Delete an attachment by its sys_id via the Attachment API. WRITE operation. Requires a sysId — call servicenow_list_attachment first.",
		Annotations: &mcp.ToolAnnotations{
			IdempotentHint:  true,
			DestructiveHint: boolPtr(true),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowDeleteAttachment)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_aggregate",
		Description: "Run aggregate queries (count, sum, avg, min, max) over a table via the Aggregate API. Requires a table name. Use sysparm_count=true for counts, sysparm_sum_fields/sysparm_avg_fields for math, sysparm_group_by to group. Read-only.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowAggregate)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_import_set_load",
		Description: "Load a record into an import set staging table via the Import Set API. WRITE operation. Requires a staging table name (e.g. 'u_imp_incident'). Provide the row fields as a JSON object in the request body; ServiceNow runs the transform map and returns the resulting target record(s).",
		Annotations: &mcp.ToolAnnotations{
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowImportSetLoad)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow_batch_request",
		Description: "Execute multiple ServiceNow REST requests in a single call via the Batch API. WRITE-class (may contain writes). Provide {batch_request_id, rest_requests:[{id, method, url, headers, body}]} as a JSON object in the request body.",
		Annotations: &mcp.ToolAnnotations{
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, servicenowBatchRequest)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "servicenow-mcp_help",
		Description: "Return usage help for this server and its tools. Optionally pass a topic.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(false),
		},
	}, helpHandler)

	// Hand-authored composite / orchestration tools (see composite.go). Kept out
	// of the generated block above so they survive regeneration of main.go.
	registerCompositeTools(srv)

	if err := serve(context.Background(), srv); err != nil {
		log.Fatalf("%s: %v", serverName, err)
	}
}
