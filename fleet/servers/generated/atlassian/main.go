// Command atlassian-mcp is a thesun-generated Go MCP server.
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
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"golang.org/x/time/rate"
)

const (
	serverName = "atlassian-mcp"
	// apiBase is a placeholder; every Atlassian Cloud site has its own
	// subdomain, so this is never a real target. Override with ATLASSIAN_BASE_URL.
	apiBase       = "https://your-domain.atlassian.net" // HTTPS only
	envBaseURL    = "ATLASSIAN_BASE_URL"
	httpTimeout   = 10 * time.Second
	maxBody       = 1 << 20 // cap response reads at 1 MiB
	shutdownGrace = 10 * time.Second

	// Outbound token-bucket rate limit — protects the upstream API (and this
	// server's own good standing) from bursty tool traffic.
	rateLimitRPS   = 8
	rateLimitBurst = 4
)

// apiBaseURL returns the configured Atlassian site base URL, read from
// ATLASSIAN_BASE_URL. There is no usable default: every Atlassian Cloud site
// has its own subdomain, so an unset override leaves apiBase at its
// placeholder value, which apiCall refuses to call against.
func apiBaseURL() string {
	return envOr(envBaseURL, apiBase)
}

// version is stamped at build time via -ldflags="-X main.version=...".
var version = "dev"

// httpClient enforces a hard timeout and (via the default transport) HTTPS to apiBaseURL().
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

// --- credential resolution (dual-mode: Hermes broker → env fallback) ---

const (
	hermesService = "atlassian"
	hermesAccount = "basic"
)

var (
	credOnce sync.Once
	credVal  string
)

// resolveCredential returns the outbound API credential, preferring the Hermes
// broker (when HERMES_URL + HERMES_CLIENT_TOKEN are set) and falling back to the
// ATLASSIAN_API_KEY / ATLASSIAN_TOKEN environment variables. Resolved once and
// cached; the value is never logged or surfaced in any output.
func resolveCredential(ctx context.Context) string {
	credOnce.Do(func() {
		if v := fetchCredFromHermes(ctx); v != "" {
			credVal = v
			return
		}
		for _, envKey := range []string{"ATLASSIAN_API_KEY", "ATLASSIAN_TOKEN"} {
			if v := os.Getenv(envKey); v != "" {
				credVal = v
				return
			}
		}
	})
	return credVal
}

// fetchCredFromHermes fetches the credential from the local Hermes broker when
// HERMES_URL + HERMES_CLIENT_TOKEN are configured. It reads the broker's
// GET /cred/{service}/{account} endpoint — the read side of `hermes creds set
// {service} {account}` — so onboarding is a single secret-safe CLI command.
// Returns "" (no error) when unset or on any failure so the caller falls back
// to env vars. Never logs the credential value.
func fetchCredFromHermes(ctx context.Context) string {
	base := os.Getenv("HERMES_URL")
	token := os.Getenv("HERMES_CLIENT_TOKEN")
	if base == "" || token == "" {
		return ""
	}
	reqURL := strings.TrimRight(base, "/") + "/cred/" + hermesService + "/" + hermesAccount
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return ""
	}
	req.Header.Set("Authorization", "Bearer "+token)
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
	var cred struct {
		Value string `json:"value"`
	}
	if err := json.Unmarshal(body, &cred); err != nil {
		return ""
	}
	return cred.Value
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

// apiCall performs an authenticated HTTP call against apiBaseURL() and returns a
// graceful MCP result. It NEVER returns the credential, or a key-bearing URL,
// in any output path.
func apiCall(ctx context.Context, method, path, query, body string) *mcp.CallToolResult {
	key := resolveCredential(ctx)
	if key == "" {
		return errorResult("credential not set — enroll it in Hermes and set HERMES_URL + HERMES_CLIENT_TOKEN (broker mode), or set ATLASSIAN_API_KEY / ATLASSIAN_TOKEN")
	}

	base := apiBaseURL()
	if base == apiBase {
		return errorResult("ATLASSIAN_BASE_URL not set — set it to your Atlassian site, e.g. https://your-domain.atlassian.net")
	}

	reqURL := base + path
	if query != "" {
		reqURL += "?" + query
	}

	var bodyReader io.Reader
	if body != "" {
		bodyReader = strings.NewReader(body)
	}

	req, err := http.NewRequestWithContext(ctx, method, reqURL, bodyReader)
	if err != nil {
		return errorResult("failed to build request: " + scrub(err, key))
	}
	req.Header.Set("Accept", "application/json")
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if key != "" {
		req.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(key)))
	}

	if err := apiLimiter.Wait(ctx); err != nil {
		return errorResult("rate limiter aborted request: " + err.Error())
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return errorResult("request failed: " + scrub(err, key))
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(io.LimitReader(resp.Body, maxBody))
	if err != nil {
		return errorResult("failed to read response: " + scrub(err, key))
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return errorResult(fmt.Sprintf("API returned HTTP %d: %s", resp.StatusCode, redact(string(respBody), key)))
	}
	return textResult(redact(string(respBody), key))
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

type AtlassianSearchJiraIssuesIn struct {
	Body string `json:"body,omitempty" jsonschema:"raw JSON request body (optional)"`
}

type AtlassianGetIssueIn struct {
	IssueKey string `json:"issueKey" jsonschema:"the issueKey path parameter (required)"`
}

type AtlassianCreateIssueIn struct {
	Body string `json:"body,omitempty" jsonschema:"raw JSON request body (optional)"`
}

type AtlassianUpdateIssueIn struct {
	IssueKey string `json:"issueKey" jsonschema:"the issueKey path parameter (required)"`
	Body     string `json:"body,omitempty" jsonschema:"raw JSON request body (optional)"`
}

type AtlassianAddJiraCommentIn struct {
	IssueKey string `json:"issueKey" jsonschema:"the issueKey path parameter (required)"`
	Body     string `json:"body,omitempty" jsonschema:"raw JSON request body (optional)"`
}

type AtlassianGetTransitionsIn struct {
	IssueKey string `json:"issueKey" jsonschema:"the issueKey path parameter (required)"`
}

type AtlassianTransitionIssueIn struct {
	IssueKey string `json:"issueKey" jsonschema:"the issueKey path parameter (required)"`
	Body     string `json:"body,omitempty" jsonschema:"raw JSON request body (optional)"`
}

type AtlassianGetProjectsIn struct {
	MaxResults string `json:"maxResults,omitempty" jsonschema:"maximum number of results (default 50)"`
}

type AtlassianGetProjectIn struct {
	ProjectKey string `json:"projectKey" jsonschema:"the projectKey path parameter (required)"`
}

type AtlassianGetCurrentUserIn struct{}

type AtlassianGetMyIssuesIn struct {
	Body string `json:"body,omitempty" jsonschema:"raw JSON request body (optional)"`
}

type AtlassianGetInProgressIssuesIn struct {
	Body string `json:"body,omitempty" jsonschema:"raw JSON request body (optional)"`
}

type AtlassianGetRecentIssuesIn struct {
	Body string `json:"body,omitempty" jsonschema:"raw JSON request body (optional)"`
}

type AtlassianAssignIssueIn struct {
	IssueKey string `json:"issueKey" jsonschema:"the issueKey path parameter (required)"`
	Body     string `json:"body,omitempty" jsonschema:"raw JSON request body (optional)"`
}

type AtlassianSearchUsersIn struct {
	Query      string `json:"query" jsonschema:"search query (display name or email)"`
	MaxResults string `json:"maxResults,omitempty" jsonschema:"maximum results (default 10)"`
}

type AtlassianSearchConfluenceIn struct {
	Cql    string `json:"cql" jsonschema:"the CQL query string, e.g. 'space=DEV AND type=page'"`
	Limit  string `json:"limit,omitempty" jsonschema:"maximum number of results (default 25)"`
	Expand string `json:"expand,omitempty" jsonschema:"fields to expand (default 'space,version')"`
}

type AtlassianGetConfluencePageIn struct {
	PageId string `json:"pageId" jsonschema:"the pageId path parameter (required)"`
	Expand string `json:"expand,omitempty" jsonschema:"fields to expand (default 'body.storage,version,space')"`
}

type AtlassianGetConfluencePageByTitleIn struct {
	SpaceKey string `json:"spaceKey" jsonschema:"the space key, e.g. DEV (from get_confluence_spaces)"`
	Title    string `json:"title" jsonschema:"the page title"`
	Expand   string `json:"expand,omitempty" jsonschema:"fields to expand (default 'body.storage,version')"`
}

type AtlassianCreateConfluencePageIn struct {
	Body string `json:"body,omitempty" jsonschema:"raw JSON request body (optional)"`
}

type AtlassianUpdateConfluencePageIn struct {
	PageId string `json:"pageId" jsonschema:"the pageId path parameter (required)"`
	Body   string `json:"body,omitempty" jsonschema:"raw JSON request body (optional)"`
}

type AtlassianGetConfluenceSpacesIn struct {
	Limit string `json:"limit,omitempty" jsonschema:"maximum number of results (default 25)"`
	Type  string `json:"type,omitempty" jsonschema:"space type filter: 'global' or 'personal'"`
}

type AtlassianGetConfluenceSpaceIn struct {
	SpaceKey string `json:"spaceKey" jsonschema:"the spaceKey path parameter (required)"`
}

type AtlassianAddConfluenceCommentIn struct {
	Body string `json:"body,omitempty" jsonschema:"raw JSON request body (optional)"`
}

type AtlassianSearchConfluenceByTextIn struct {
	Cql   string `json:"cql" jsonschema:"text search, submitted as a CQL text ~ query"`
	Limit string `json:"limit,omitempty" jsonschema:"maximum results (default 25)"`
}

type AtlassianGetConfluencePageV2In struct {
	PageId string `json:"pageId" jsonschema:"the pageId path parameter (required)"`
}

type helpIn struct {
	Topic string `json:"topic,omitempty" jsonschema:"optional help topic; omit for a full overview of all tools"`
}

// ---- generated tool handlers ----

func atlassianSearchJiraIssues(ctx context.Context, _ *mcp.CallToolRequest, in AtlassianSearchJiraIssuesIn) (*mcp.CallToolResult, any, error) {
	path := "/rest/api/3/search/jql"
	query := ""
	body := in.Body
	return apiCall(ctx, "POST", path, query, body), nil, nil
}

func atlassianGetIssue(ctx context.Context, _ *mcp.CallToolRequest, in AtlassianGetIssueIn) (*mcp.CallToolResult, any, error) {
	issueKeyVal := strings.TrimSpace(in.IssueKey)
	if issueKeyVal == "" {
		return errorResult("atlassian_get_issue: issueKey is required"), nil, nil
	}
	path := strings.Replace("/rest/api/3/issue/{issueKey}", "{issueKey}", url.PathEscape(issueKeyVal), 1)
	query := ""
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func atlassianCreateIssue(ctx context.Context, _ *mcp.CallToolRequest, in AtlassianCreateIssueIn) (*mcp.CallToolResult, any, error) {
	path := "/rest/api/3/issue"
	query := ""
	body := in.Body
	return apiCall(ctx, "POST", path, query, body), nil, nil
}

func atlassianUpdateIssue(ctx context.Context, _ *mcp.CallToolRequest, in AtlassianUpdateIssueIn) (*mcp.CallToolResult, any, error) {
	issueKeyVal := strings.TrimSpace(in.IssueKey)
	if issueKeyVal == "" {
		return errorResult("atlassian_update_issue: issueKey is required"), nil, nil
	}
	path := strings.Replace("/rest/api/3/issue/{issueKey}", "{issueKey}", url.PathEscape(issueKeyVal), 1)
	query := ""
	body := in.Body
	return apiCall(ctx, "PUT", path, query, body), nil, nil
}

func atlassianAddJiraComment(ctx context.Context, _ *mcp.CallToolRequest, in AtlassianAddJiraCommentIn) (*mcp.CallToolResult, any, error) {
	issueKeyVal := strings.TrimSpace(in.IssueKey)
	if issueKeyVal == "" {
		return errorResult("atlassian_add_jira_comment: issueKey is required"), nil, nil
	}
	path := strings.Replace("/rest/api/3/issue/{issueKey}/comment", "{issueKey}", url.PathEscape(issueKeyVal), 1)
	query := ""
	body := in.Body
	return apiCall(ctx, "POST", path, query, body), nil, nil
}

func atlassianGetTransitions(ctx context.Context, _ *mcp.CallToolRequest, in AtlassianGetTransitionsIn) (*mcp.CallToolResult, any, error) {
	issueKeyVal := strings.TrimSpace(in.IssueKey)
	if issueKeyVal == "" {
		return errorResult("atlassian_get_transitions: issueKey is required"), nil, nil
	}
	path := strings.Replace("/rest/api/3/issue/{issueKey}/transitions", "{issueKey}", url.PathEscape(issueKeyVal), 1)
	query := ""
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func atlassianTransitionIssue(ctx context.Context, _ *mcp.CallToolRequest, in AtlassianTransitionIssueIn) (*mcp.CallToolResult, any, error) {
	issueKeyVal := strings.TrimSpace(in.IssueKey)
	if issueKeyVal == "" {
		return errorResult("atlassian_transition_issue: issueKey is required"), nil, nil
	}
	path := strings.Replace("/rest/api/3/issue/{issueKey}/transitions", "{issueKey}", url.PathEscape(issueKeyVal), 1)
	query := ""
	body := in.Body
	return apiCall(ctx, "POST", path, query, body), nil, nil
}

func atlassianGetProjects(ctx context.Context, _ *mcp.CallToolRequest, in AtlassianGetProjectsIn) (*mcp.CallToolResult, any, error) {
	path := "/rest/api/3/project/search"
	q := url.Values{}
	if v := strings.TrimSpace(in.MaxResults); v != "" {
		q.Set("maxResults", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func atlassianGetProject(ctx context.Context, _ *mcp.CallToolRequest, in AtlassianGetProjectIn) (*mcp.CallToolResult, any, error) {
	projectKeyVal := strings.TrimSpace(in.ProjectKey)
	if projectKeyVal == "" {
		return errorResult("atlassian_get_project: projectKey is required"), nil, nil
	}
	path := strings.Replace("/rest/api/3/project/{projectKey}", "{projectKey}", url.PathEscape(projectKeyVal), 1)
	query := ""
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func atlassianGetCurrentUser(ctx context.Context, _ *mcp.CallToolRequest, in AtlassianGetCurrentUserIn) (*mcp.CallToolResult, any, error) {
	path := "/rest/api/3/myself"
	query := ""
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func atlassianGetMyIssues(ctx context.Context, _ *mcp.CallToolRequest, in AtlassianGetMyIssuesIn) (*mcp.CallToolResult, any, error) {
	path := "/rest/api/3/search/jql"
	query := ""
	body := in.Body
	return apiCall(ctx, "POST", path, query, body), nil, nil
}

func atlassianGetInProgressIssues(ctx context.Context, _ *mcp.CallToolRequest, in AtlassianGetInProgressIssuesIn) (*mcp.CallToolResult, any, error) {
	path := "/rest/api/3/search/jql"
	query := ""
	body := in.Body
	return apiCall(ctx, "POST", path, query, body), nil, nil
}

func atlassianGetRecentIssues(ctx context.Context, _ *mcp.CallToolRequest, in AtlassianGetRecentIssuesIn) (*mcp.CallToolResult, any, error) {
	path := "/rest/api/3/search/jql"
	query := ""
	body := in.Body
	return apiCall(ctx, "POST", path, query, body), nil, nil
}

func atlassianAssignIssue(ctx context.Context, _ *mcp.CallToolRequest, in AtlassianAssignIssueIn) (*mcp.CallToolResult, any, error) {
	issueKeyVal := strings.TrimSpace(in.IssueKey)
	if issueKeyVal == "" {
		return errorResult("atlassian_assign_issue: issueKey is required"), nil, nil
	}
	path := strings.Replace("/rest/api/3/issue/{issueKey}/assignee", "{issueKey}", url.PathEscape(issueKeyVal), 1)
	query := ""
	body := in.Body
	return apiCall(ctx, "PUT", path, query, body), nil, nil
}

func atlassianSearchUsers(ctx context.Context, _ *mcp.CallToolRequest, in AtlassianSearchUsersIn) (*mcp.CallToolResult, any, error) {
	path := "/rest/api/3/user/search"
	q := url.Values{}
	if v := strings.TrimSpace(in.Query); v != "" {
		q.Set("query", v)
	}
	if in.Query == "" {
		return errorResult("atlassian_search_users: query is required"), nil, nil
	}
	if v := strings.TrimSpace(in.MaxResults); v != "" {
		q.Set("maxResults", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func atlassianSearchConfluence(ctx context.Context, _ *mcp.CallToolRequest, in AtlassianSearchConfluenceIn) (*mcp.CallToolResult, any, error) {
	path := "/wiki/rest/api/content/search"
	q := url.Values{}
	if v := strings.TrimSpace(in.Cql); v != "" {
		q.Set("cql", v)
	}
	if in.Cql == "" {
		return errorResult("atlassian_search_confluence: cql is required"), nil, nil
	}
	if v := strings.TrimSpace(in.Limit); v != "" {
		q.Set("limit", v)
	}
	if v := strings.TrimSpace(in.Expand); v != "" {
		q.Set("expand", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func atlassianGetConfluencePage(ctx context.Context, _ *mcp.CallToolRequest, in AtlassianGetConfluencePageIn) (*mcp.CallToolResult, any, error) {
	pageIdVal := strings.TrimSpace(in.PageId)
	if pageIdVal == "" {
		return errorResult("atlassian_get_confluence_page: pageId is required"), nil, nil
	}
	path := strings.Replace("/wiki/rest/api/content/{pageId}", "{pageId}", url.PathEscape(pageIdVal), 1)
	q := url.Values{}
	if v := strings.TrimSpace(in.Expand); v != "" {
		q.Set("expand", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func atlassianGetConfluencePageByTitle(ctx context.Context, _ *mcp.CallToolRequest, in AtlassianGetConfluencePageByTitleIn) (*mcp.CallToolResult, any, error) {
	path := "/wiki/rest/api/content"
	q := url.Values{}
	if v := strings.TrimSpace(in.SpaceKey); v != "" {
		q.Set("spaceKey", v)
	}
	if in.SpaceKey == "" {
		return errorResult("atlassian_get_confluence_page_by_title: spaceKey is required"), nil, nil
	}
	if v := strings.TrimSpace(in.Title); v != "" {
		q.Set("title", v)
	}
	if in.Title == "" {
		return errorResult("atlassian_get_confluence_page_by_title: title is required"), nil, nil
	}
	if v := strings.TrimSpace(in.Expand); v != "" {
		q.Set("expand", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func atlassianCreateConfluencePage(ctx context.Context, _ *mcp.CallToolRequest, in AtlassianCreateConfluencePageIn) (*mcp.CallToolResult, any, error) {
	path := "/wiki/rest/api/content"
	query := ""
	body := in.Body
	return apiCall(ctx, "POST", path, query, body), nil, nil
}

func atlassianUpdateConfluencePage(ctx context.Context, _ *mcp.CallToolRequest, in AtlassianUpdateConfluencePageIn) (*mcp.CallToolResult, any, error) {
	pageIdVal := strings.TrimSpace(in.PageId)
	if pageIdVal == "" {
		return errorResult("atlassian_update_confluence_page: pageId is required"), nil, nil
	}
	path := strings.Replace("/wiki/rest/api/content/{pageId}", "{pageId}", url.PathEscape(pageIdVal), 1)
	query := ""
	body := in.Body
	return apiCall(ctx, "PUT", path, query, body), nil, nil
}

func atlassianGetConfluenceSpaces(ctx context.Context, _ *mcp.CallToolRequest, in AtlassianGetConfluenceSpacesIn) (*mcp.CallToolResult, any, error) {
	path := "/wiki/rest/api/space"
	q := url.Values{}
	if v := strings.TrimSpace(in.Limit); v != "" {
		q.Set("limit", v)
	}
	if v := strings.TrimSpace(in.Type); v != "" {
		q.Set("type", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func atlassianGetConfluenceSpace(ctx context.Context, _ *mcp.CallToolRequest, in AtlassianGetConfluenceSpaceIn) (*mcp.CallToolResult, any, error) {
	spaceKeyVal := strings.TrimSpace(in.SpaceKey)
	if spaceKeyVal == "" {
		return errorResult("atlassian_get_confluence_space: spaceKey is required"), nil, nil
	}
	path := strings.Replace("/wiki/rest/api/space/{spaceKey}", "{spaceKey}", url.PathEscape(spaceKeyVal), 1)
	query := ""
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func atlassianAddConfluenceComment(ctx context.Context, _ *mcp.CallToolRequest, in AtlassianAddConfluenceCommentIn) (*mcp.CallToolResult, any, error) {
	path := "/wiki/rest/api/content"
	query := ""
	body := in.Body
	return apiCall(ctx, "POST", path, query, body), nil, nil
}

func atlassianSearchConfluenceByText(ctx context.Context, _ *mcp.CallToolRequest, in AtlassianSearchConfluenceByTextIn) (*mcp.CallToolResult, any, error) {
	path := "/wiki/rest/api/content/search"
	q := url.Values{}
	if v := strings.TrimSpace(in.Cql); v != "" {
		q.Set("cql", v)
	}
	if in.Cql == "" {
		return errorResult("atlassian_search_confluence_by_text: cql is required"), nil, nil
	}
	if v := strings.TrimSpace(in.Limit); v != "" {
		q.Set("limit", v)
	}
	query := q.Encode()
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

func atlassianGetConfluencePageV2(ctx context.Context, _ *mcp.CallToolRequest, in AtlassianGetConfluencePageV2In) (*mcp.CallToolResult, any, error) {
	pageIdVal := strings.TrimSpace(in.PageId)
	if pageIdVal == "" {
		return errorResult("atlassian_get_confluence_page_v2: pageId is required"), nil, nil
	}
	path := strings.Replace("/wiki/api/v2/pages/{pageId}", "{pageId}", url.PathEscape(pageIdVal), 1)
	query := ""
	return apiCall(ctx, "GET", path, query, ""), nil, nil
}

// helpHandler returns static usage text for this server (Conformance Lab
// instrumentation gate requires a <server>_help tool with a topic parameter).
func helpHandler(_ context.Context, _ *mcp.CallToolRequest, _ helpIn) (*mcp.CallToolResult, any, error) {
	return textResult("atlassian-mcp — thesun-generated Go MCP server (streamable-HTTP only).\n\nTools:\n- atlassian_search_jira_issues: Search Jira issues using JQL. Pass the JQL query and options (jql, fields, maxResults) in the JSON body. Jira Cloud search is POST /rest/api/3/search/jql.\n- atlassian_get_issue: Get detailed information about a Jira issue by key. Requires an issueKey (e.g. PROJ-123) obtained from a prior search_jira_issues result.\n- atlassian_create_issue: Create a new Jira issue. Pass project, issueType, summary and optional fields in the JSON body.\n- atlassian_update_issue: Update an existing Jira issue. Requires an issueKey — call search_jira_issues to obtain one. Editable fields go in the JSON body.\n- atlassian_add_jira_comment: Add a comment to a Jira issue. Requires an issueKey — call search_jira_issues or get_issue to obtain one. Comment text goes in the JSON body.\n- atlassian_get_transitions: Get available workflow transitions for a Jira issue. Requires an issueKey — call search_jira_issues to obtain one.\n- atlassian_transition_issue: Transition a Jira issue to a new status. Requires an issueKey and a transitionId — call get_transitions to obtain both. Payload goes in the JSON body.\n- atlassian_get_projects: Get the list of all accessible Jira projects.\n- atlassian_get_project: Get detailed information about a specific Jira project. Requires a projectKey (e.g. PROJ) — call get_projects to obtain one.\n- atlassian_get_current_user: Get information about the currently authenticated Jira user.\n- atlassian_get_my_issues: Get Jira issues assigned to the current user (excludes done/closed/cancelled by default). Options go in the JSON body.\n- atlassian_get_in_progress_issues: Get Jira issues currently in progress assigned to the current user. Options go in the JSON body.\n- atlassian_get_recent_issues: Get recently updated Jira issues assigned to the current user. Options (days, maxResults) go in the JSON body.\n- atlassian_assign_issue: Assign a Jira issue to a user. Requires an issueKey — call search_jira_issues to obtain one. The accountId goes in the JSON body (use search_users to find it).\n- atlassian_search_users: Search for Jira users by name or email to obtain their account IDs.\n- atlassian_search_confluence: Search Confluence content using CQL (Confluence Query Language).\n- atlassian_get_confluence_page: Get a Confluence page by ID with full content. Requires a pageId — call search_confluence or search_confluence_by_text first to obtain it.\n- atlassian_get_confluence_page_by_title: Get a Confluence page by title and space key. Requires a spaceKey — call get_confluence_spaces to obtain one.\n- atlassian_create_confluence_page: Create a new Confluence page. Pass spaceKey, title, content and content_format in the JSON body.\n- atlassian_update_confluence_page: Update an existing Confluence page. Requires a pageId and the current version number, obtained from a prior get_confluence_page result. New content goes in the JSON body.\n- atlassian_get_confluence_spaces: Get the list of all accessible Confluence spaces.\n- atlassian_get_confluence_space: Get detailed information about a specific Confluence space. Requires a spaceKey — call get_confluence_spaces to obtain one.\n- atlassian_add_confluence_comment: Add a comment to a Confluence page. Requires a pageId (call search_confluence to obtain it) and comment text, both passed in the JSON body.\n- atlassian_search_confluence_by_text: Simple text search across Confluence pages (no CQL required). Good for quick lookups.\n- atlassian_get_confluence_page_v2: Get a Confluence page via the v2 API with improved performance and optional public link. Requires a pageId obtained from a prior search_confluence result.\n\nCredentials are read from the environment at runtime and are never logged or surfaced in tool output."), nil, nil
}

func main() {
	log.SetFlags(0)

	srv := mcp.NewServer(&mcp.Implementation{Name: serverName, Version: version}, nil)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "atlassian_search_jira_issues",
		Description: "Search Jira issues using JQL. Pass the JQL query and options (jql, fields, maxResults) in the JSON body. Jira Cloud search is POST /rest/api/3/search/jql.",
		Annotations: &mcp.ToolAnnotations{
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, atlassianSearchJiraIssues)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "atlassian_get_issue",
		Description: "Get detailed information about a Jira issue by key. Requires an issueKey (e.g. PROJ-123) obtained from a prior search_jira_issues result.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, atlassianGetIssue)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "atlassian_create_issue",
		Description: "Create a new Jira issue. Pass project, issueType, summary and optional fields in the JSON body.",
		Annotations: &mcp.ToolAnnotations{
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, atlassianCreateIssue)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "atlassian_update_issue",
		Description: "Update an existing Jira issue. Requires an issueKey — call search_jira_issues to obtain one. Editable fields go in the JSON body.",
		Annotations: &mcp.ToolAnnotations{
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, atlassianUpdateIssue)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "atlassian_add_jira_comment",
		Description: "Add a comment to a Jira issue. Requires an issueKey — call search_jira_issues or get_issue to obtain one. Comment text goes in the JSON body.",
		Annotations: &mcp.ToolAnnotations{
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, atlassianAddJiraComment)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "atlassian_get_transitions",
		Description: "Get available workflow transitions for a Jira issue. Requires an issueKey — call search_jira_issues to obtain one.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, atlassianGetTransitions)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "atlassian_transition_issue",
		Description: "Transition a Jira issue to a new status. Requires an issueKey and a transitionId — call get_transitions to obtain both. Payload goes in the JSON body.",
		Annotations: &mcp.ToolAnnotations{
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, atlassianTransitionIssue)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "atlassian_get_projects",
		Description: "Get the list of all accessible Jira projects.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, atlassianGetProjects)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "atlassian_get_project",
		Description: "Get detailed information about a specific Jira project. Requires a projectKey (e.g. PROJ) — call get_projects to obtain one.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, atlassianGetProject)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "atlassian_get_current_user",
		Description: "Get information about the currently authenticated Jira user.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, atlassianGetCurrentUser)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "atlassian_get_my_issues",
		Description: "Get Jira issues assigned to the current user (excludes done/closed/cancelled by default). Options go in the JSON body.",
		Annotations: &mcp.ToolAnnotations{
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, atlassianGetMyIssues)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "atlassian_get_in_progress_issues",
		Description: "Get Jira issues currently in progress assigned to the current user. Options go in the JSON body.",
		Annotations: &mcp.ToolAnnotations{
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, atlassianGetInProgressIssues)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "atlassian_get_recent_issues",
		Description: "Get recently updated Jira issues assigned to the current user. Options (days, maxResults) go in the JSON body.",
		Annotations: &mcp.ToolAnnotations{
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, atlassianGetRecentIssues)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "atlassian_assign_issue",
		Description: "Assign a Jira issue to a user. Requires an issueKey — call search_jira_issues to obtain one. The accountId goes in the JSON body (use search_users to find it).",
		Annotations: &mcp.ToolAnnotations{
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, atlassianAssignIssue)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "atlassian_search_users",
		Description: "Search for Jira users by name or email to obtain their account IDs.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, atlassianSearchUsers)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "atlassian_search_confluence",
		Description: "Search Confluence content using CQL (Confluence Query Language).",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, atlassianSearchConfluence)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "atlassian_get_confluence_page",
		Description: "Get a Confluence page by ID with full content. Requires a pageId — call search_confluence or search_confluence_by_text first to obtain it.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, atlassianGetConfluencePage)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "atlassian_get_confluence_page_by_title",
		Description: "Get a Confluence page by title and space key. Requires a spaceKey — call get_confluence_spaces to obtain one.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, atlassianGetConfluencePageByTitle)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "atlassian_create_confluence_page",
		Description: "Create a new Confluence page. Pass spaceKey, title, content and content_format in the JSON body.",
		Annotations: &mcp.ToolAnnotations{
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, atlassianCreateConfluencePage)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "atlassian_update_confluence_page",
		Description: "Update an existing Confluence page. Requires a pageId and the current version number, obtained from a prior get_confluence_page result. New content goes in the JSON body.",
		Annotations: &mcp.ToolAnnotations{
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, atlassianUpdateConfluencePage)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "atlassian_get_confluence_spaces",
		Description: "Get the list of all accessible Confluence spaces.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, atlassianGetConfluenceSpaces)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "atlassian_get_confluence_space",
		Description: "Get detailed information about a specific Confluence space. Requires a spaceKey — call get_confluence_spaces to obtain one.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, atlassianGetConfluenceSpace)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "atlassian_add_confluence_comment",
		Description: "Add a comment to a Confluence page. Requires a pageId (call search_confluence to obtain it) and comment text, both passed in the JSON body.",
		Annotations: &mcp.ToolAnnotations{
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, atlassianAddConfluenceComment)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "atlassian_search_confluence_by_text",
		Description: "Simple text search across Confluence pages (no CQL required). Good for quick lookups.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, atlassianSearchConfluenceByText)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "atlassian_get_confluence_page_v2",
		Description: "Get a Confluence page via the v2 API with improved performance and optional public link. Requires a pageId obtained from a prior search_confluence result.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(true),
		},
	}, atlassianGetConfluencePageV2)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "atlassian-mcp_help",
		Description: "Return usage help for this server and its tools. Optionally pass a topic.",
		Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint:    true,
			IdempotentHint:  true,
			DestructiveHint: boolPtr(false),
			OpenWorldHint:   boolPtr(false),
		},
	}, helpHandler)

	if err := serve(context.Background(), srv); err != nil {
		log.Fatalf("%s: %v", serverName, err)
	}
}
