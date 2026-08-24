// Command akamai-mcp is a native-Go MCP server for the Akamai API. It mirrors
// the architecture of the upstream Node akamai-mcp-server: a small set of
// ergonomic tools plus a universal executor backed by an embedded registry of
// every Akamai API operation (generated from the Akamai OpenAPI specs). That
// gives a lean tool surface with zero loss of API coverage — anything not
// wrapped by a convenience tool is still reachable via akamai_raw_request.
//
// Transport: streamable-HTTP ONLY (never stdio, never SSE), matching the fleet
// substrate (fleetd + gateway + Hermes). The transport harness is inlined.
//
// Auth: EdgeGrid EG1-HMAC-SHA256 request signing. Credentials resolve in three
// tiers, Hermes broker then AKAMAI_* env vars then ~/.edgerc (see edgegrid.go).
// They are NEVER logged, echoed, or surfaced in any tool result or error.
//
// Writes are DENIED by default: only GET and HEAD operations execute unless
// AKAMAI_ALLOW_WRITES=1 is set. See writesAllowed.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"golang.org/x/time/rate"
)

const (
	serverName    = "akamai-mcp"
	httpTimeout   = 60 * time.Second
	maxRespBody   = 16 << 20 // cap response reads at 16 MiB
	shutdownGrace = 10 * time.Second

	// Outbound token-bucket rate limit — protects the Akamai API (and this
	// client's standing) from bursty tool traffic. Mirrors the Node server's
	// 20 req/s default.
	rateLimitRPS   = 20
	rateLimitBurst = 4

	// Pagination safety cap.
	defaultMaxPages = 20
	hardMaxPages    = 100
)

// version is stamped at build time via -ldflags="-X main.version=...".
var version = "dev"

// httpClient never follows a redirect at the transport layer. The EdgeGrid
// signature is computed over the request URL, so a followed redirect presents a
// signature for the URL it was NOT sent to, and Akamai answers 401 "The
// signature does not match" for a request that was perfectly valid. apiCall
// re-signs one hop explicitly instead. See redirectTarget.
var httpClient = &http.Client{
	Timeout:       httpTimeout,
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}
var apiLimiter = rate.NewLimiter(rate.Limit(rateLimitRPS), rateLimitBurst)

// reg is the embedded operation registry, built once at startup. creds are the
// EdgeGrid credentials; unlike reg they are mutable, because a 401 re-resolves
// them so a rotation does not require a restart. Read them through
// currentCreds() and write them through resolveCreds(), never directly: both
// take credsMu.
var (
	reg   *registry
	creds *edgercCreds
)

// headerAllowlist is the set of request headers a caller may forward, matching
// the upstream server's security control (prevents header injection).
var headerAllowlist = map[string]bool{
	"accept":        true,
	"content-type":  true,
	"if-match":      true,
	"if-none-match": true,
	"prefer":        true,
	"x-request-id":  true,
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func boolPtr(b bool) *bool { return &b }

func textResult(text string) *mcp.CallToolResult {
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: text}}}
}

func errorResult(msg string) *mcp.CallToolResult {
	return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: msg}}}
}

// jsonResult marshals v to indented JSON and returns it as a text result.
func jsonResult(v any) *mcp.CallToolResult {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return errorResult("failed to encode result: " + err.Error())
	}
	return textResult(string(b))
}

// toStringMap coerces a map[string]any of scalar values into url.Values.
func toQueryValues(m map[string]any) url.Values {
	q := url.Values{}
	for k, v := range m {
		if v == nil {
			continue
		}
		switch t := v.(type) {
		case string:
			q.Set(k, t)
		case float64:
			// JSON numbers decode as float64; render ints without trailing .0.
			if t == float64(int64(t)) {
				q.Set(k, fmt.Sprintf("%d", int64(t)))
			} else {
				q.Set(k, fmt.Sprintf("%g", t))
			}
		case bool:
			q.Set(k, fmt.Sprintf("%t", t))
		default:
			q.Set(k, fmt.Sprintf("%v", t))
		}
	}
	return q
}

// setIf records k=v only when v is non-empty. Named tools build their path and
// query maps through this so an unset optional argument is left out entirely
// rather than sent as an empty value: an empty path token would silently
// address the collection instead of the item, and several Akamai products
// reject an empty query parameter rather than ignoring it.
func setIf(m map[string]any, k, v string) {
	if strings.TrimSpace(v) != "" {
		m[k] = v
	}
}

// setIfPositive is setIf for numbers, treating zero as unset. Every numeric
// argument a named tool takes (a property version, a page size, an offset) is
// meaningless at zero, so zero is the natural "not supplied" value for the
// optional ones and an omission worth reporting for the required ones.
func setIfPositive(m map[string]any, k string, v int) {
	if v > 0 {
		m[k] = v
	}
}

// boolOr resolves an optional boolean argument: nil means the caller expressed
// no preference, so the tool's own default applies. Used where false is a
// meaningful value AND the useful default is true, which a plain bool cannot
// express because Go cannot tell an unset one from a false one.
func boolOr(v *bool, def bool) bool {
	if v == nil {
		return def
	}
	return *v
}

// substitutePath replaces {name} tokens in a path with URL-encoded values.
// Returns an error naming the first unsubstituted token.
func substitutePath(path string, pathParams map[string]any) (string, error) {
	for k, v := range pathParams {
		if v == nil {
			continue
		}
		path = strings.ReplaceAll(path, "{"+k+"}", url.PathEscape(fmt.Sprintf("%v", v)))
	}
	if i := strings.Index(path, "{"); i >= 0 {
		if j := strings.Index(path[i:], "}"); j >= 0 {
			return "", fmt.Errorf("path parameter not provided: %s", path[i+1:i+j])
		}
	}
	return path, nil
}

// filterHeaders keeps only allowlisted headers (case-insensitive).
func filterHeaders(in map[string]string) map[string]string {
	if len(in) == 0 {
		return nil
	}
	out := map[string]string{}
	for k, v := range in {
		if headerAllowlist[strings.ToLower(strings.TrimSpace(k))] {
			out[k] = v
		}
	}
	return out
}

// writesAllowed reports whether mutating operations may be executed. Resolved
// once at startup rather than per call, so the operating mode cannot change
// under a running process and is logged exactly once (see main).
//
// The default is read-only. The gateway already classifies akamai_raw_request
// as PRODUCTION, i.e. Tier-B, so every call needs out-of-band human approval;
// this gate is a SECOND boundary that holds even if that policy is ever
// misconfigured, because it lives in the process that signs the request.
var writesAllowed bool

// isReadMethod reports whether an HTTP method is non-mutating. Only GET and
// HEAD qualify: POST, PUT, PATCH, and DELETE all change state at Akamai, and
// the catalogue contains 520 such operations including WAF-rule rewrites and
// security-configuration activation.
func isReadMethod(method string) bool {
	switch strings.ToUpper(strings.TrimSpace(method)) {
	case http.MethodGet, http.MethodHead:
		return true
	default:
		return false
	}
}

// --- credential lifecycle and the shared signed-call path ---

// credsMu guards creds, which is no longer written once at startup: a 401 can
// trigger a re-resolve while other tool calls are in flight.
var credsMu sync.RWMutex

// credsRetryAfter429 bounds how long a single call will wait out a 429 before
// giving up. Akamai rate-limits and sends Retry-After; waiting a short, bounded
// interval turns a spurious failure into a success, while a long wait would
// just hold the caller hostage.
const maxRetryAfterWait = 30 * time.Second

func currentCreds() *edgercCreds {
	credsMu.RLock()
	defer credsMu.RUnlock()
	return creds
}

// resolveCreds re-runs the three-tier resolution and swaps in the result. It is
// called at startup, lazily when no credential resolved then, and once after a
// 401 so a rotated credential is picked up without a restart. A failed
// re-resolution leaves the existing credential in place rather than clearing
// it: the old one may still work, and dropping it would turn one 401 into a
// permanent outage.
func resolveCreds(ctx context.Context) *edgercCreds {
	c, err := loadCreds(ctx)
	if err != nil || c == nil {
		return currentCreds()
	}
	credsMu.Lock()
	creds = c
	credsMu.Unlock()
	return c
}

// apiCall is the single path every signed Akamai request takes. It owns the
// three cross-cutting concerns that used to be absent or scattered:
//
//   - Nil credentials. Resolution is not fatal at startup, so a call may be the
//     first thing that needs a credential; it retries resolution once here and
//     otherwise fails legibly rather than panicking.
//   - 401. Re-resolves the credential ONCE and retries the request once, so a
//     rotation does not require a restart. Bounded deliberately: a second 401
//     is returned to the caller rather than retried, so a genuinely bad
//     credential cannot become a retry storm against Akamai.
//   - 429. Honors Retry-After for one bounded wait and retries once. Akamai
//     rate-limits, and the header was previously ignored so the caller saw a
//     generic error with no indication that waiting would have worked.
//
// Each retry happens at most once, so any single call issues at most three
// requests in the worst case (original, one 401 retry, one 429 retry).
func apiCall(ctx context.Context, method, path string, query url.Values, headers map[string]string, body []byte) (*signedResponse, error) {
	c := currentCreds()
	if c == nil {
		if c = resolveCreds(ctx); c == nil {
			return nil, fmt.Errorf("no EdgeGrid credentials resolved: tried the Hermes broker " +
				"(HERMES_URL plus HERMES_CLIENT_TOKEN, service \"akamai\", accounts host, client_token, " +
				"client_secret, access_token), then AKAMAI_* env vars, then the .edgerc file. " +
				"Enroll with `hermes creds set akamai <account>` or provide .edgerc")
		}
	}

	if err := apiLimiter.Wait(ctx); err != nil {
		return nil, fmt.Errorf("rate limiter aborted: %w", err)
	}
	resp, err := c.doSigned(httpClient, method, path, query, headers, body)
	if err != nil {
		return nil, err
	}

	// 3xx: re-sign and follow exactly one hop. path and query are rebound to the
	// hop's, so the 401 and 429 retries below repeat the request that was
	// actually made rather than the one that was redirected away from.
	if hopPath, hopQuery, ok := redirectTarget(c, resp); ok {
		if werr := apiLimiter.Wait(ctx); werr == nil {
			if hopped, herr := c.doSigned(httpClient, method, hopPath, hopQuery, headers, body); herr == nil {
				resp, path, query = hopped, hopPath, hopQuery
			}
		}
	}

	// 401: the credential may have rotated underneath us. Re-resolve once.
	if resp.StatusCode == http.StatusUnauthorized {
		if fresh := resolveCreds(ctx); fresh != nil && fresh != c {
			if err := apiLimiter.Wait(ctx); err != nil {
				return resp, nil // return the 401 rather than the limiter error
			}
			if retried, rerr := fresh.doSigned(httpClient, method, path, query, headers, body); rerr == nil {
				return retried, nil
			}
		}
		return resp, nil
	}

	// 429: honor Retry-After for one bounded wait.
	if resp.StatusCode == http.StatusTooManyRequests {
		wait, ok := retryAfterDelay(resp.Headers.Get("Retry-After"))
		if !ok {
			return resp, nil
		}
		select {
		case <-ctx.Done():
			return resp, nil
		case <-time.After(wait):
		}
		if err := apiLimiter.Wait(ctx); err != nil {
			return resp, nil
		}
		if retried, rerr := c.doSigned(httpClient, method, path, query, headers, body); rerr == nil {
			return retried, nil
		}
	}
	return resp, nil
}

// redirectTarget decides whether a response is a redirect this client may
// follow, and returns the path and query to re-sign for.
//
// PAPI answers a request that omits contractId and groupId with a 302 to the
// canonical URL carrying both, with Akamai's own id prefixes stripped: GET
// /papi/v1/properties/prp_257958 becomes
// /papi/v1/properties/257958?groupId=150866&contractId=3-HINVO. Because
// EdgeGrid signs the URL, a client that follows that hop with the original
// Authorization header presents a signature computed over the pre-redirect URL,
// and Akamai answers 401 "The signature does not match". Go's http.Client
// follows redirects by default, so every operation whose scoping arguments are
// optional failed with an authentication error that had nothing to do with the
// credential. Re-signing the hop is what makes those arguments genuinely
// optional.
//
// A redirect that leaves the credential's own host is refused rather than
// followed: an EdgeGrid Authorization header must never be minted for an origin
// the credential was not issued for, and a Location is attacker-adjacent input
// in a way a catalogued path is not.
func redirectTarget(c *edgercCreds, resp *signedResponse) (string, url.Values, bool) {
	if resp.StatusCode < 300 || resp.StatusCode >= 400 {
		return "", nil, false
	}
	loc := strings.TrimSpace(resp.Headers.Get("Location"))
	if loc == "" {
		return "", nil, false
	}
	u, err := url.Parse(loc)
	if err != nil || u.Path == "" {
		return "", nil, false
	}
	if u.Host != "" && !strings.EqualFold(u.Host, c.host) {
		return "", nil, false
	}
	return u.Path, u.Query(), true
}

// retryAfterDelay parses a Retry-After header, which is either a delay in
// seconds or an HTTP date. It returns ok=false when the header is absent,
// unparseable, or asks for a wait longer than maxRetryAfterWait, in which case
// the 429 is surfaced to the caller instead of silently stalling the call.
func retryAfterDelay(h string) (time.Duration, bool) {
	h = strings.TrimSpace(h)
	if h == "" {
		return 0, false
	}
	if secs, err := strconv.Atoi(h); err == nil {
		if secs < 0 {
			return 0, false
		}
		d := time.Duration(secs) * time.Second
		return d, d <= maxRetryAfterWait
	}
	if t, err := http.ParseTime(h); err == nil {
		d := time.Until(t)
		if d <= 0 {
			return 0, true // the deadline already passed: retry immediately
		}
		return d, d <= maxRetryAfterWait
	}
	return 0, false
}

// --- catalogued-operation dispatch (akamai_raw_request, akamai_read_request) ---

// RawRequestIn is the input for both catalogued-operation tools. They share one
// input type because they take the same arguments and do the same work; what
// differs is which operations each will dispatch, and that is decided from the
// operation's own catalogue entry, never from an argument.
type RawRequestIn struct {
	ToolName    string            `json:"toolName" jsonschema:"exact operation tool name from akamai_list_operations (e.g. akamai_papi_get-properties)"`
	PathParams  map[string]any    `json:"pathParams,omitempty" jsonschema:"path parameter values keyed by name"`
	QueryParams map[string]any    `json:"queryParams,omitempty" jsonschema:"query parameter values keyed by name"`
	Headers     map[string]string `json:"headers,omitempty" jsonschema:"extra request headers (only accept, content-type, if-match, if-none-match, prefer, x-request-id are forwarded)"`
	Body        any               `json:"body,omitempty" jsonschema:"request body: for POST/PUT/PATCH operations on akamai_raw_request, and for the error-translator submit on akamai_read_request"`
	Paginate    bool              `json:"paginate,omitempty" jsonschema:"auto-paginate list results using the operation's limit/offset params"`
	MaxPages    int               `json:"maxPages,omitempty" jsonschema:"max pages to fetch when paginating (default 20, hard cap 100)"`
}

// operationGate decides whether one catalogued operation may be dispatched by
// one tool. It returns nil to permit, or the refusal to hand back to the caller.
type operationGate func(op operation) *mcp.CallToolResult

// dispatch is the shared body of both catalogued-operation tools. Everything
// after the gate (parameter validation, path substitution, body encoding, header
// filtering, pagination, signing) is identical for the two, and it stays
// identical by being one function rather than two that drift apart.
func dispatch(ctx context.Context, tool string, gate operationGate, shape responseShaper, in RawRequestIn) *mcp.CallToolResult {
	if strings.TrimSpace(in.ToolName) == "" {
		return errorResult(tool + ": toolName is required (use akamai_list_operations to find it)")
	}
	op, ok := reg.get(in.ToolName)
	if !ok {
		return errorResult(fmt.Sprintf("%s: unknown operation %q, use akamai_list_operations to find the exact tool name", tool, in.ToolName))
	}

	// Gate first, before parameter validation, so a refused operation never
	// reaches request construction. The gate reads op, which came from the
	// registry, so no crafted argument can talk it into another verdict.
	if refusal := gate(op); refusal != nil {
		return refusal
	}

	// Validate required params.
	for _, p := range op.PathParameters {
		if p.Required {
			if in.PathParams == nil || in.PathParams[p.Name] == nil {
				return errorResult(fmt.Sprintf("%s: missing required path parameter %q for %s", tool, p.Name, op.ToolName))
			}
		}
	}
	for _, p := range op.QueryParameters {
		if p.Required {
			if in.QueryParams == nil || in.QueryParams[p.Name] == nil {
				return errorResult(fmt.Sprintf("%s: missing required query parameter %q for %s", tool, p.Name, op.ToolName))
			}
		}
	}
	if op.BodyRequired && in.Body == nil {
		return errorResult(fmt.Sprintf("%s: operation %s requires a body", tool, op.ToolName))
	}

	path, err := substitutePath(op.Path, in.PathParams)
	if err != nil {
		return errorResult(tool + ": " + err.Error())
	}

	var bodyBytes []byte
	if in.Body != nil {
		bodyBytes, err = json.Marshal(in.Body)
		if err != nil {
			return errorResult(tool + ": failed to encode body: " + err.Error())
		}
	}
	headers := filterHeaders(in.Headers)

	// Pagination path.
	if in.Paginate && op.SupportsPagination {
		return paginate(ctx, tool, op, path, in, headers)
	}

	resp, err := apiCall(ctx, op.Method, path, toQueryValues(in.QueryParams), headers, bodyBytes)
	if err != nil {
		return errorResult(tool + ": request failed: " + err.Error())
	}
	return renderResponse(op, resp, shape)
}

// writeGate is akamai_raw_request's gate: the server-wide write switch. The
// method comes from the registry entry, never from caller input, so this cannot
// be spoofed by a crafted argument.
func writeGate(op operation) *mcp.CallToolResult {
	if isReadMethod(op.Method) || writesAllowed {
		return nil
	}
	return errorResult(fmt.Sprintf(
		"akamai_raw_request: refusing %s %s (operation %s): writes are disabled on this server. "+
			"It is running read-only, which is the default. To permit mutating operations, set "+
			"AKAMAI_ALLOW_WRITES=1 in the server's fleet manifest env and restart it. "+
			"Note the gateway independently requires out-of-band human approval for this tool.",
		op.Method, op.Path, op.ToolName))
}

// readOnlyExceptions names every non-GET operation akamai_read_request will
// dispatch. It is an allowlist of exact operation names on purpose: two named
// entries can be audited by reading them, whereas a rule like "POSTs that look
// diagnostic" cannot be, and would grow to fit whatever the next caller wanted.
//
// Both entries are the Edge Diagnostics error translator. The POST submits an
// error reference string and returns log detail about a request Akamai already
// served; it changes no property, security configuration, content, or delivery
// behavior, so it is a read that happens to be spelled POST. Its GET companion
// is listed beside it for auditability, even though the GET rule already admits
// it, so this map answers "what is the error translator allowed to do" on its
// own.
var readOnlyExceptions = map[string]bool{
	"akamai_edge_diagnostics_post-error-translator":        true,
	"akamai_edge_diagnostics_get-error-translator-request": true,
}

// readGate is akamai_read_request's gate. It admits catalogued GET operations
// and the two named exceptions above, and refuses everything else.
//
// Deliberately NOT written in terms of isReadMethod, which also counts HEAD: the
// rule here is GET or an explicitly named exception, so that what this tool can
// reach is answerable by reading one map and one comparison. The 3 catalogued
// HEAD operations return no body and so carry nothing a caller could want from
// this path anyway.
//
// Fail closed. An operation the catalogue cannot classify is refused rather than
// guessed at: the registry is regenerated from upstream OpenAPI specs, and an
// entry that arrives without a method must not become a default-GET dispatch.
func readGate(op operation) *mcp.CallToolResult {
	method := strings.ToUpper(strings.TrimSpace(op.Method))
	if method == "" {
		return errorResult(fmt.Sprintf(
			"akamai_read_request: refusing operation %s: the catalogue carries no HTTP method for it, "+
				"and an operation whose class cannot be proven is not treated as a read.", op.ToolName))
	}
	if method == http.MethodGet || readOnlyExceptions[op.ToolName] {
		return nil
	}
	return errorResult(fmt.Sprintf(
		"akamai_read_request: refusing %s %s (operation %s): this tool dispatches catalogued GET "+
			"operations only, plus the Edge Diagnostics error translator, so that what it can reach is "+
			"the Akamai read surface rather than the whole API. Mutating operations stay reachable only "+
			"through akamai_raw_request, which the gateway gates on out-of-band human approval.",
		method, op.Path, op.ToolName))
}

func rawRequest(ctx context.Context, _ *mcp.CallToolRequest, in RawRequestIn) (*mcp.CallToolResult, any, error) {
	return dispatch(ctx, "akamai_raw_request", writeGate, nil, in), nil, nil
}

func readRequest(ctx context.Context, _ *mcp.CallToolRequest, in RawRequestIn) (*mcp.CallToolResult, any, error) {
	return dispatch(ctx, "akamai_read_request", readGate, nil, in), nil, nil
}

// renderResponse normalizes an API response into a tool result. Non-2xx becomes
// an error result carrying the status and (best-effort JSON) body.
func renderResponse(op operation, resp *signedResponse, shape responseShaper) *mcp.CallToolResult {
	var parsed any
	if len(resp.Body) > 0 {
		if err := json.Unmarshal(resp.Body, &parsed); err != nil {
			parsed = string(resp.Body) // non-JSON body: pass through as text
		}
	}
	// Shape only a success. An error body is the diagnosis, and projecting it
	// down to fields chosen for a success payload would throw that away.
	if shape != nil && parsed != nil && resp.StatusCode >= 200 && resp.StatusCode < 300 {
		parsed = shape(parsed)
	}
	envelope := map[string]any{
		"operation": map[string]any{"toolName": op.ToolName, "method": op.Method, "path": op.Path, "product": op.Product},
		"status":    resp.StatusCode,
		"data":      parsed,
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		envelope["error"] = true
		return &mcp.CallToolResult{IsError: true, Content: jsonContent(envelope)}
	}
	return &mcp.CallToolResult{Content: jsonContent(envelope)}
}

func jsonContent(v any) []mcp.Content {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return []mcp.Content{&mcp.TextContent{Text: fmt.Sprintf("failed to encode result: %v", err)}}
	}
	return []mcp.Content{&mcp.TextContent{Text: string(b)}}
}

// paginate performs offset-based pagination over an operation that supports it,
// combining the item arrays from each page. It stops when a page returns no new
// items or the page cap is reached.
func paginate(ctx context.Context, tool string, op operation, path string, in RawRequestIn, headers map[string]string) *mcp.CallToolResult {
	maxPages := in.MaxPages
	if maxPages <= 0 {
		maxPages = defaultMaxPages
	}
	if maxPages > hardMaxPages {
		maxPages = hardMaxPages
	}

	// Identify the offset/limit param names present on the operation.
	offsetName, limitName := "", ""
	for _, p := range op.QueryParameters {
		n := strings.ToLower(p.Name)
		if offsetName == "" && (n == "offset" || n == "page") {
			offsetName = p.Name
		}
		if limitName == "" && (n == "limit" || n == "pagesize") {
			limitName = p.Name
		}
	}

	base := map[string]any{}
	for k, v := range in.QueryParams {
		base[k] = v
	}

	var combined []any
	pages := 0
	offset := 0
	pageSize := 100
	if v, ok := base[limitName]; ok {
		if f, ok := v.(float64); ok && f > 0 {
			pageSize = int(f)
		}
	}

	for pages < maxPages {
		q := map[string]any{}
		for k, v := range base {
			q[k] = v
		}
		if offsetName != "" {
			q[offsetName] = float64(offset)
		}
		if limitName != "" {
			q[limitName] = float64(pageSize)
		}

		resp, err := apiCall(ctx, op.Method, path, toQueryValues(q), headers, nil)
		if err != nil {
			return errorResult(tool + ": pagination request failed: " + err.Error())
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return renderResponse(op, resp, nil)
		}
		items := extractItems(resp.Body)
		if len(items) == 0 {
			break
		}
		combined = append(combined, items...)
		pages++
		if offsetName == "" || len(items) < pageSize {
			break // no offset param, or last (partial) page reached
		}
		offset += pageSize
	}

	return jsonResult(map[string]any{
		"operation":  map[string]any{"toolName": op.ToolName, "method": op.Method, "path": op.Path},
		"paginated":  true,
		"pages":      pages,
		"totalItems": len(combined),
		"items":      combined,
	})
}

// extractItems pulls the list array from a paginated response body, checking the
// common Akamai envelope keys.
func extractItems(body []byte) []any {
	var m map[string]any
	if err := json.Unmarshal(body, &m); err != nil {
		return nil
	}
	for _, key := range []string{"items", "results", "data", "properties", "zones", "records"} {
		if v, ok := m[key]; ok {
			if arr, ok := v.([]any); ok {
				return arr
			}
			// Nested one level (e.g. {"properties":{"items":[...]}}).
			if inner, ok := v.(map[string]any); ok {
				if iv, ok := inner["items"].([]any); ok {
					return iv
				}
			}
		}
	}
	return nil
}

// --- akamai_list_operations ---

type ListOpsIn struct {
	Product     string `json:"product,omitempty" jsonschema:"filter by product (e.g. papi, appsec, config-gtm, config-dns, edgeworkers)"`
	Method      string `json:"method,omitempty" jsonschema:"filter by HTTP method (GET, POST, PUT, DELETE, PATCH)"`
	Query       string `json:"query,omitempty" jsonschema:"text search across tool name, summary, and path"`
	Paginatable *bool  `json:"paginatable,omitempty" jsonschema:"filter operations that support pagination"`
	Limit       int    `json:"limit,omitempty" jsonschema:"max results to return (default 50)"`
}

func listOperations(_ context.Context, _ *mcp.CallToolRequest, in ListOpsIn) (*mcp.CallToolResult, any, error) {
	total, results := reg.search(searchOpts{
		Product: in.Product, Method: in.Method, Query: in.Query,
		Paginatable: in.Paginatable, Limit: in.Limit,
	})
	return jsonResult(map[string]any{
		"total":      total,
		"showing":    len(results),
		"operations": results,
	}), nil, nil
}

// --- akamai_registry_stats ---

type NoIn struct{}

func registryStats(_ context.Context, _ *mcp.CallToolRequest, _ NoIn) (*mcp.CallToolResult, any, error) {
	return jsonResult(reg.stats()), nil, nil
}

// --- akamai_account_overview (bounded aggregation) ---

// accountOverview fetches the user profile, contracts, and groups in one call.
// All three are single, bounded requests — no account-wide enumeration (which
// can time out; for that, use akamai_read_request scoped to a contract/group).
func accountOverview(ctx context.Context, _ *mcp.CallToolRequest, _ NoIn) (*mcp.CallToolResult, any, error) {
	get := func(path string, q url.Values) any {
		resp, err := apiCall(ctx, http.MethodGet, path, q, nil, nil)
		if err != nil {
			return map[string]any{"error": err.Error()}
		}
		var parsed any
		if e := json.Unmarshal(resp.Body, &parsed); e != nil {
			parsed = string(resp.Body)
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return map[string]any{"error": true, "status": resp.StatusCode, "body": parsed}
		}
		return parsed
	}

	overview := map[string]any{
		"profile":   get("/identity-management/v3/user-profile", nil),
		"contracts": get("/papi/v1/contracts", nil),
		"groups":    get("/papi/v1/groups", nil),
	}
	return jsonResult(overview), nil, nil
}

// --- response shaping ---

// Three named tools return payloads far past what a caller can actually read
// through the gateway, which compacts anything over 6000 characters and pages
// the rest into an artifact. Measured against this account: the CPS enrollment
// list is 145,671 characters, the security-configuration list 17,831, and the
// traffic report 19,357. A tool whose answer is always cut off mid-object is
// only half-built, so these three project their list down to the fields that
// answer the question and say so in the response.
//
// Every shaper is reversible from the caller's side with full=true, and each
// one drops only fields that another named tool returns in full. Nothing is
// unreachable, it is just no longer all returned at once.
type responseShaper func(any) any

// curatedShapers holds the projection for the tools that need one. A tool absent
// from this map returns the API's payload untouched, which is the default.
var curatedShapers = map[string]responseShaper{
	"akamai_certificate_list":     compactEnrollments,
	"akamai_security_config_list": compactSecurityConfigs,
	"akamai_traffic_report":       compactReport,
}

// keepFields copies the named keys that are present, which is how each shaper
// states its projection as a list of field names rather than as control flow.
func keepFields(dst, src map[string]any, names ...string) {
	for _, n := range names {
		if v, ok := src[n]; ok {
			dst[n] = v
		}
	}
}

// listUnder returns the array under key, and whether it was there. Shapers bail
// out and return the payload untouched when the shape is not what they expect,
// so an API change degrades to a large response rather than a wrong one.
func listUnder(data any, key string) ([]any, map[string]any, bool) {
	m, ok := data.(map[string]any)
	if !ok {
		return nil, nil, false
	}
	items, ok := m[key].([]any)
	if !ok {
		return nil, nil, false
	}
	return items, m, true
}

// compactEnrollments turns the CPS enrollment list into an index. The bulk of a
// CPS payload is per-enrollment contact blocks, org addresses, CSR detail, and
// TLS configuration, none of which answers "which certificates exist and when do
// they renew". The SAN list is dropped for size and replaced with its count:
// akamai_certificate_get returns the full list for one enrollment, and the
// hostname filter on this tool answers the SAN question directly.
func compactEnrollments(data any) any {
	items, _, ok := listUnder(data, "enrollments")
	if !ok {
		return data
	}
	out := make([]any, 0, len(items))
	for _, it := range items {
		e, ok := it.(map[string]any)
		if !ok {
			out = append(out, it)
			continue
		}
		lean := map[string]any{}
		keepFields(lean, e, "id", "certificateType", "validationType", "autoRenewalStartTime")
		if csr, ok := e["csr"].(map[string]any); ok {
			keepFields(lean, csr, "cn")
			if sans, ok := csr["sans"].([]any); ok {
				lean["sanCount"] = len(sans)
			}
		}
		// Only when there is something pending. A zero on every row costs more
		// than it tells anyone, and the budget here is the response size.
		if pending, ok := e["pendingChanges"].([]any); ok && len(pending) > 0 {
			lean["pendingChangeCount"] = len(pending)
		}
		out = append(out, lean)
	}
	return map[string]any{
		"enrollments": out,
		"count":       len(out),
		"compacted": "Per-enrollment SANs, contacts, CSR detail, and TLS configuration are omitted so the list " +
			"fits in one response. Filter by hostname to see the enrollments covering it, call " +
			"akamai_certificate_get for one enrollment in full, or pass full=true for the raw payload.",
	}
}

// compactSecurityConfigs drops the hostname arrays that dominate the security
// configuration list. A single configuration can protect hundreds of hostnames,
// and inlining all of them for every configuration answers a question nobody
// asked of a listing. akamai_security_config_get returns them for one
// configuration with includeHostnames.
func compactSecurityConfigs(data any) any {
	items, _, ok := listUnder(data, "configurations")
	if !ok {
		return data
	}
	dropped := false
	out := make([]any, 0, len(items))
	for _, it := range items {
		c, ok := it.(map[string]any)
		if !ok {
			out = append(out, it)
			continue
		}
		lean := map[string]any{}
		keepFields(lean, c, "id", "name", "description", "latestVersion", "stagingVersion", "productionVersion", "targetProduct", "fileType")
		for _, key := range []string{"productionHostnames", "stagingHostnames"} {
			if hosts, ok := c[key].([]any); ok {
				lean[strings.TrimSuffix(key, "s")+"Count"] = len(hosts)
				dropped = true
			}
		}
		out = append(out, lean)
	}
	res := map[string]any{"configurations": out, "count": len(out)}
	if dropped {
		res["compacted"] = "Protected hostnames are counted rather than listed. Call akamai_security_config_get " +
			"with includeHostnames for one configuration's hostnames, or pass full=true for the raw payload."
	}
	return res
}

// compactReport keeps a report's data and trims its metadata. The reporting API
// echoes the resolved query back with every response, including the full list of
// CP codes it authorized the caller for, which on this account is longer than the
// report itself.
func compactReport(data any) any {
	m, ok := data.(map[string]any)
	if !ok {
		return data
	}
	out := map[string]any{}
	keepFields(out, m, "data", "summaryStatistics")
	if meta, ok := m["metadata"].(map[string]any); ok {
		lean := map[string]any{}
		keepFields(lean, meta, "start", "end", "rowCount", "availableDataEnds")
		if dims, ok := meta["dimensions"].([]any); ok {
			lean["dimensions"] = namesOf(dims)
		}
		if metrics, ok := meta["metrics"].([]any); ok {
			lean["metrics"] = namesOf(metrics)
		}
		if filters, ok := meta["filters"].([]any); ok {
			lean["filterCount"] = len(filters)
		}
		out["metadata"] = lean
	}
	out["compacted"] = "Report metadata is summarized: the echoed dimension and metric definitions and the " +
		"authorized CP code list are omitted. Pass full=true for the raw payload."
	return out
}

// namesOf projects a list of objects down to their name fields, which is what
// makes an echoed dimension or metric definition useful without its schema.
func namesOf(items []any) []any {
	out := make([]any, 0, len(items))
	for _, it := range items {
		if m, ok := it.(map[string]any); ok {
			if n, ok := m["name"]; ok {
				out = append(out, n)
				continue
			}
		}
		out = append(out, it)
	}
	return out
}

// filterEnrollmentsByHostname keeps the enrollments whose common name or SANs
// cover a hostname. Done here rather than at Akamai because CPS has no such
// filter, and without one the description's promise ("which certificates cover
// this hostname") could not be kept: the unfiltered list does not fit in a
// response, so the answer would always be truncated somewhere arbitrary.
func filterEnrollmentsByHostname(data any, hostname string) any {
	items, m, ok := listUnder(data, "enrollments")
	if !ok {
		return data
	}
	want := strings.ToLower(strings.TrimSpace(hostname))
	kept := make([]any, 0, 4)
	for _, it := range items {
		e, ok := it.(map[string]any)
		if !ok {
			continue
		}
		csr, ok := e["csr"].(map[string]any)
		if !ok {
			continue
		}
		if cn, ok := csr["cn"].(string); ok && strings.EqualFold(strings.TrimSpace(cn), want) {
			kept = append(kept, e)
			continue
		}
		if sans, ok := csr["sans"].([]any); ok {
			for _, s := range sans {
				if str, ok := s.(string); ok && strings.EqualFold(strings.TrimSpace(str), want) {
					kept = append(kept, e)
					break
				}
			}
		}
	}
	out := map[string]any{}
	for k, v := range m {
		out[k] = v
	}
	out["enrollments"] = kept
	out["matchedHostname"] = hostname
	return out
}

// --- curated named tools ---

// A named tool answers one question and reaches one Akamai operation. Both
// catalogued-operation tools above take the operation from the caller, which is
// what makes akamai_raw_request's blast radius the whole API and, separately,
// what makes either of them hard to FIND: a caller has to already know that
// akamai_papi_get-properties is the answer to "which version is live on
// staging". Naming the operations callers actually want fixes both at once. It
// is not a hypothetical: a model asked to check staging properties invented the
// tool name akamai_property_list rather than discover the executor, which is
// exactly the name it now resolves to.
//
// Each named tool pins its operation as a compile-time constant. None of them
// takes an operation, path, method, or product from its caller; only the
// parameters that one operation defines.
const (
	opPropertyList        = "akamai_papi_get-properties"
	opPropertyGet         = "akamai_papi_get-property"
	opPropertyHostnames   = "akamai_papi_get-property-version-hostnames"
	opPropertyRules       = "akamai_papi_get-property-version-rules"
	opPropertyActivations = "akamai_papi_get-property-activations"
	opPropertySearch      = "akamai_papi_post-search-find-by-value"
	opHostnameList        = "akamai_papi_get-hostnames"
)

// curatedOperations pairs every named tool with the one catalogued operation it
// dispatches. It is the single place those pairings are written down: each
// handler reads its operation from here, main validates the whole map at
// startup, and TestCuratedOperationsAreCatalogued walks it against the registry.
//
// That test is not ceremony. The predecessor TypeScript server shipped 23 of its
// 52 tools dead on arrival because they named operations in camelCase while the
// spec-derived registry emitted kebab-case, and nothing failed until a user
// called one: CI printed statistics and exited 0. This registry is regenerated
// from upstream OpenAPI specs too, so the same drift is one regeneration away.
// The map plus that test is what turns it into a failing build instead of a tool
// that is broken only for whoever tries to use it.
var curatedOperations = map[string]string{
	"akamai_property_list":        opPropertyList,
	"akamai_property_get":         opPropertyGet,
	"akamai_property_hostnames":   opPropertyHostnames,
	"akamai_property_rules":       opPropertyRules,
	"akamai_property_activations": opPropertyActivations,
	"akamai_property_search":      opPropertySearch,
	"akamai_hostname_list":        opHostnameList,

	"akamai_security_config_list": opSecurityConfigList,
	"akamai_security_config_get":  opSecurityConfigGet,
	"akamai_network_list_list":    opNetworkListList,
	"akamai_network_list_get":     opNetworkListGet,

	"akamai_dns_zone_list": opDNSZoneList,
	"akamai_dns_records":   opDNSRecords,

	"akamai_certificate_list": opCertificateList,
	"akamai_certificate_get":  opCertificateGet,

	"akamai_traffic_report": opTrafficReport,

	"akamai_edge_curl":        opEdgeCurl,
	"akamai_edge_dig":         opEdgeDig,
	"akamai_edge_mtr":         opEdgeMtr,
	"akamai_grep_logs":        opGrepLogs,
	"akamai_url_health_check": opURLHealthCheck,
}

// curatedNonGETReads names every non-GET operation a named tool may dispatch,
// and records why each one is a read despite its method. Akamai's read/write
// split is not method-shaped: about 32 catalogued POSTs return data and change
// nothing, because that is how those APIs accept a query too large or too
// structured for a URL. A GET-only rule cannot express that, which is precisely
// why these tools are named rather than left to akamai_read_request.
//
// An entry admits its operation ONLY while that operation is still a POST. The
// map names reads that happen to be spelled POST, not operations that are
// permanently exempt, so an entry cannot survive a method change and quietly
// admit a DELETE under a familiar name. curatedOp enforces that.
//
// Kept separate from readOnlyExceptions, which is akamai_read_request's
// allowlist, deliberately: an entry there widens what the general dispatcher can
// reach for every caller, while an entry here only affects the single named tool
// that pins that operation.
var curatedNonGETReads = map[string]bool{
	// POST /papi/v1/search/find-by-value. The body carries the hostname,
	// property name, or edge hostname being searched for; the response is a
	// list of matching properties. It creates nothing and activates nothing,
	// and it is the only way to answer "which property serves this hostname".
	opPropertySearch: true,

	// POST /reporting-api/v2/reports/{family}/{area}/{report}/data. The body is
	// the query (dimensions, metrics, filters) because it does not fit in a URL.
	// It computes over traffic Akamai already served and writes nothing.
	opTrafficReport: true,

	// The Edge Diagnostics operations below all submit a question about traffic
	// Akamai has already served: fetch this URL from an edge server, resolve
	// this name from one, trace the path to one, search one's request logs,
	// health check one URL. None of them changes a property, a security
	// configuration, cached content, or delivery behavior. Every operation in
	// the product is a POST, so a method rule cannot separate these from the
	// ones that do, which is exactly why each is named individually here.
	opEdgeCurl:       true,
	opEdgeDig:        true,
	opEdgeMtr:        true,
	opGrepLogs:       true,
	opURLHealthCheck: true,
}

// curatedOp resolves the operation behind a named tool and re-checks that it is
// still a read. Both checks run at call time, not only in the test, because the
// catalogue is embedded from regenerated specs: an operation that is renamed
// becomes a legible refusal instead of a confusing failure deep in request
// construction, and one whose method changes cannot quietly turn a named read
// tool into a write.
func curatedOp(tool string) (operation, *mcp.CallToolResult) {
	opName, ok := curatedOperations[tool]
	if !ok {
		return operation{}, errorResult(tool + ": no catalogued operation is pinned for this tool. That is a defect in this server, not in the call.")
	}
	op, ok := reg.get(opName)
	if !ok {
		return operation{}, errorResult(fmt.Sprintf(
			"%s: its pinned operation %q is not in the embedded catalogue. The catalogue was regenerated and this tool now points at nothing, which no argument can repair. "+
				"Use akamai_list_operations to find the operation's new name and akamai_read_request to dispatch it in the meantime.", tool, opName))
	}
	// GET always; POST only when the operation is named in curatedNonGETReads;
	// nothing else, ever. The POST clause is not redundant: without it an
	// allowlist entry would outlive a method change, so an operation that drifted
	// from POST to DELETE would still be admitted on the strength of its name.
	// The allowlist says "this POST is a read", not "this operation is always
	// safe". PUT, PATCH, and DELETE have no read-shaped form in this API and are
	// refused whatever the allowlist says.
	method := strings.ToUpper(strings.TrimSpace(op.Method))
	if method != http.MethodGet && !(method == http.MethodPost && curatedNonGETReads[opName]) {
		return operation{}, errorResult(fmt.Sprintf(
			"%s: refusing to dispatch %s %s (operation %s). Every named tool on this server is a read: the catalogued method must be GET, or POST for one of the named non-GET reads. This is neither, so it is refused rather than executed.",
			tool, method, op.Path, opName))
	}
	return op, nil
}

// callCurated dispatches a named tool's pinned operation down the same path as
// akamai_read_request: the same parameter validation, path substitution, header
// filtering, pagination, EdgeGrid signing, and response shaping. The operation
// name is overwritten from the pinned constant, so nothing in the caller's
// arguments can redirect the call, and the gate is a no-op because curatedOp
// already made that decision above.
func callCurated(ctx context.Context, tool string, in RawRequestIn) *mcp.CallToolResult {
	return callCuratedShaped(ctx, tool, in, curatedShapers[tool])
}

// callCuratedFull is callCurated without the projection, for the full=true
// argument on the tools that have one.
func callCuratedFull(ctx context.Context, tool string, in RawRequestIn) *mcp.CallToolResult {
	return callCuratedShaped(ctx, tool, in, nil)
}

func callCuratedShaped(ctx context.Context, tool string, in RawRequestIn, shape responseShaper) *mcp.CallToolResult {
	op, refusal := curatedOp(tool)
	if refusal != nil {
		return refusal
	}
	in.ToolName = op.ToolName
	return dispatch(ctx, tool, func(operation) *mcp.CallToolResult { return nil }, shape, in)
}

// validateCuratedOperations names, at startup and once, every named tool whose
// pinned operation no longer resolves against the embedded catalogue. The tools
// stay registered and refuse legibly when called (see curatedOp); this exists so
// the drift is visible in the server's own log instead of only in the face of
// whoever called one. Deliberately not fatal: a catalogue that lost an operation
// must not turn into a fleetd restart loop, which is the same reasoning that
// keeps credential resolution non-fatal in main.
func validateCuratedOperations() {
	tools := make([]string, 0, len(curatedOperations))
	for tool := range curatedOperations {
		tools = append(tools, tool)
	}
	sort.Strings(tools)

	var broken []string
	for _, tool := range tools {
		if _, ok := reg.get(curatedOperations[tool]); !ok {
			broken = append(broken, tool+" -> "+curatedOperations[tool])
		}
	}
	if len(broken) == 0 {
		log.Printf("%s: %d named tools resolved against the catalogue", serverName, len(curatedOperations))
		return
	}
	log.Printf("%s: CATALOGUE DRIFT, %d of %d named tools point at operations that are not in the registry and will refuse every call: %s",
		serverName, len(broken), len(curatedOperations), strings.Join(broken, ", "))
}

// --- property family ---

// PropertyListIn lists the properties in one contract and group. The response
// carries each property's latestVersion, stagingVersion, and productionVersion,
// which is the whole answer to "what is live on staging versus production".
type PropertyListIn struct {
	ContractID string `json:"contractId" jsonschema:"contract the properties belong to, e.g. ctr_3-HINVO. Required by PAPI. akamai_account_overview lists the account's contracts."`
	GroupID    string `json:"groupId" jsonschema:"group the properties belong to, e.g. grp_150866. Required by PAPI. akamai_account_overview lists the account's groups."`
}

func propertyList(ctx context.Context, _ *mcp.CallToolRequest, in PropertyListIn) (*mcp.CallToolResult, any, error) {
	q := map[string]any{}
	setIf(q, "contractId", in.ContractID)
	setIf(q, "groupId", in.GroupID)
	return callCurated(ctx, "akamai_property_list", RawRequestIn{QueryParams: q}), nil, nil
}

// PropertyGetIn fetches one property's metadata, including its staging and
// production version numbers.
type PropertyGetIn struct {
	PropertyID string `json:"propertyId" jsonschema:"property id, e.g. prp_257958. akamai_property_list and akamai_property_search both return these."`
	ContractID string `json:"contractId,omitempty" jsonschema:"optional contract id to scope the lookup, e.g. ctr_3-HINVO"`
	GroupID    string `json:"groupId,omitempty" jsonschema:"optional group id to scope the lookup, e.g. grp_150866"`
}

func propertyGet(ctx context.Context, _ *mcp.CallToolRequest, in PropertyGetIn) (*mcp.CallToolResult, any, error) {
	p := map[string]any{}
	setIf(p, "propertyId", in.PropertyID)
	q := map[string]any{}
	setIf(q, "contractId", in.ContractID)
	setIf(q, "groupId", in.GroupID)
	return callCurated(ctx, "akamai_property_get", RawRequestIn{PathParams: p, QueryParams: q}), nil, nil
}

// PropertyVersionIn addresses one version of one property. Shared by the
// hostname and rule-tree tools because it is genuinely the same address: pick
// the version from akamai_property_list (stagingVersion or productionVersion)
// to read what a given network is actually serving.
type PropertyVersionIn struct {
	PropertyID      string `json:"propertyId" jsonschema:"property id, e.g. prp_257958"`
	PropertyVersion int    `json:"propertyVersion" jsonschema:"version number to read. Use stagingVersion or productionVersion from akamai_property_list to read what that network is serving."`
	ContractID      string `json:"contractId,omitempty" jsonschema:"optional contract id to scope the lookup"`
	GroupID         string `json:"groupId,omitempty" jsonschema:"optional group id to scope the lookup"`
}

// propertyVersionCall is the shared request shape behind the two version-scoped
// property tools, which differ only in which operation they pin.
func propertyVersionCall(ctx context.Context, tool string, in PropertyVersionIn, extra map[string]any) *mcp.CallToolResult {
	p := map[string]any{}
	setIf(p, "propertyId", in.PropertyID)
	setIfPositive(p, "propertyVersion", in.PropertyVersion)
	q := map[string]any{}
	for k, v := range extra {
		q[k] = v
	}
	setIf(q, "contractId", in.ContractID)
	setIf(q, "groupId", in.GroupID)
	return callCurated(ctx, tool, RawRequestIn{PathParams: p, QueryParams: q})
}

func propertyHostnames(ctx context.Context, _ *mcp.CallToolRequest, in PropertyVersionIn) (*mcp.CallToolResult, any, error) {
	return propertyVersionCall(ctx, "akamai_property_hostnames", in, nil), nil, nil
}

func propertyRules(ctx context.Context, _ *mcp.CallToolRequest, in PropertyVersionIn) (*mcp.CallToolResult, any, error) {
	return propertyVersionCall(ctx, "akamai_property_rules", in, nil), nil, nil
}

// PropertyActivationsIn lists a property's activation history: which version
// went to STAGING or PRODUCTION, when, by whom, and whether it is still active.
type PropertyActivationsIn struct {
	PropertyID string `json:"propertyId" jsonschema:"property id, e.g. prp_257958"`
	ContractID string `json:"contractId,omitempty" jsonschema:"optional contract id to scope the lookup"`
	GroupID    string `json:"groupId,omitempty" jsonschema:"optional group id to scope the lookup"`
}

func propertyActivations(ctx context.Context, _ *mcp.CallToolRequest, in PropertyActivationsIn) (*mcp.CallToolResult, any, error) {
	p := map[string]any{}
	setIf(p, "propertyId", in.PropertyID)
	q := map[string]any{}
	setIf(q, "contractId", in.ContractID)
	setIf(q, "groupId", in.GroupID)
	return callCurated(ctx, "akamai_property_activations", RawRequestIn{PathParams: p, QueryParams: q}), nil, nil
}

// PropertySearchIn searches properties by exactly one value. PAPI's search
// endpoint takes one key per request, so the tool takes three optional fields
// and requires exactly one: sending two would silently search on whichever the
// API picked.
type PropertySearchIn struct {
	Hostname     string `json:"hostname,omitempty" jsonschema:"find the properties serving this hostname, e.g. www.example.com"`
	PropertyName string `json:"propertyName,omitempty" jsonschema:"find properties by exact property name, e.g. www.example.com_pm"`
	EdgeHostname string `json:"edgeHostname,omitempty" jsonschema:"find properties pointing at this edge hostname, e.g. www.example.com.edgesuite.net"`
}

func propertySearch(ctx context.Context, _ *mcp.CallToolRequest, in PropertySearchIn) (*mcp.CallToolResult, any, error) {
	body := map[string]any{}
	setIf(body, "hostname", in.Hostname)
	setIf(body, "propertyName", in.PropertyName)
	setIf(body, "edgeHostname", in.EdgeHostname)
	if len(body) != 1 {
		return errorResult("akamai_property_search: give exactly one of hostname, propertyName, or edgeHostname. " +
			"The PAPI search endpoint matches on a single key per request, so a call with none has nothing to search for and a call with several is ambiguous."), nil, nil
	}
	return callCurated(ctx, "akamai_property_search", RawRequestIn{Body: body}), nil, nil
}

// HostnameListIn lists hostnames across the account rather than within one
// property, optionally filtered and scoped. This is the account-wide inventory;
// akamai_property_hostnames answers the same question for a single version.
type HostnameListIn struct {
	Hostname   string `json:"hostname,omitempty" jsonschema:"filter to hostnames matching this value"`
	CnameTo    string `json:"cnameTo,omitempty" jsonschema:"filter to hostnames whose edge hostname (CNAME target) matches this value"`
	Network    string `json:"network,omitempty" jsonschema:"filter by activation network: STAGING or PRODUCTION"`
	ContractID string `json:"contractId,omitempty" jsonschema:"optional contract id to scope the listing"`
	GroupID    string `json:"groupId,omitempty" jsonschema:"optional group id to scope the listing"`
	Limit      int    `json:"limit,omitempty" jsonschema:"page size (Akamai's own default applies when unset)"`
	Offset     int    `json:"offset,omitempty" jsonschema:"page offset"`
	Paginate   bool   `json:"paginate,omitempty" jsonschema:"follow pages and combine the results instead of returning the first page"`
	MaxPages   int    `json:"maxPages,omitempty" jsonschema:"max pages to fetch when paginating (default 20, hard cap 100)"`
}

func hostnameList(ctx context.Context, _ *mcp.CallToolRequest, in HostnameListIn) (*mcp.CallToolResult, any, error) {
	q := map[string]any{}
	setIf(q, "hostname", in.Hostname)
	setIf(q, "cnameTo", in.CnameTo)
	setIf(q, "network", strings.ToUpper(strings.TrimSpace(in.Network)))
	setIf(q, "contractId", in.ContractID)
	setIf(q, "groupId", in.GroupID)
	setIfPositive(q, "limit", in.Limit)
	setIfPositive(q, "offset", in.Offset)
	return callCurated(ctx, "akamai_hostname_list", RawRequestIn{
		QueryParams: q, Paginate: in.Paginate, MaxPages: in.MaxPages,
	}), nil, nil
}

// --- security, DNS, and certificate families ---

const (
	opSecurityConfigList = "akamai_appsec_get-configs"
	opSecurityConfigGet  = "akamai_appsec_get-config"
	opNetworkListList    = "akamai_network_lists_get-network-lists"
	opNetworkListGet     = "akamai_network_lists_get-network-list"
	opDNSZoneList        = "akamai_config_dns_get-zones"
	opDNSRecords         = "akamai_config_dns_get-zones-zone-recordsets"
	opCertificateList    = "akamai_cps_get-enrollments"
	opCertificateGet     = "akamai_cps_get-enrollment"
)

// CPS answers 406 Not Acceptable unless the request names a specific versioned
// media type; there is no default representation to fall back on. The version
// is pinned here because no caller can be expected to guess "v11", and getting
// it wrong is the difference between a certificate inventory and an error. Note
// the singular/plural split: the collection and the item are different media
// types, not one type at two paths.
const (
	cpsEnrollmentsAccept = "application/vnd.akamai.cps.enrollments.v11+json"
	cpsEnrollmentAccept  = "application/vnd.akamai.cps.enrollment.v11+json"
)

// SecurityConfigGetIn addresses one security configuration by its numeric id.
type SecurityConfigGetIn struct {
	ConfigID         int  `json:"configId" jsonschema:"security configuration id, e.g. 12345. akamai_security_config_list returns these."`
	IncludeHostnames bool `json:"includeHostnames,omitempty" jsonschema:"also return the hostnames the configuration protects (default false)"`
}

// SecurityConfigListIn takes no filters, because the API takes none. The one
// argument is the escape hatch from this server's own summarization.
type SecurityConfigListIn struct {
	Full bool `json:"full,omitempty" jsonschema:"return the raw payload including every protected hostname inlined per configuration (large)"`
}

func securityConfigList(ctx context.Context, _ *mcp.CallToolRequest, in SecurityConfigListIn) (*mcp.CallToolResult, any, error) {
	if in.Full {
		return callCuratedFull(ctx, "akamai_security_config_list", RawRequestIn{}), nil, nil
	}
	return callCurated(ctx, "akamai_security_config_list", RawRequestIn{}), nil, nil
}

func securityConfigGet(ctx context.Context, _ *mcp.CallToolRequest, in SecurityConfigGetIn) (*mcp.CallToolResult, any, error) {
	p := map[string]any{}
	setIfPositive(p, "configId", in.ConfigID)
	// Sent explicitly rather than omitted: Go cannot tell an unset bool from a
	// false one, so the tool states the value it means instead of inheriting
	// whichever default the product happens to have today.
	q := map[string]any{"includeHostnames": in.IncludeHostnames}
	return callCurated(ctx, "akamai_security_config_get", RawRequestIn{PathParams: p, QueryParams: q}), nil, nil
}

// NetworkListListIn lists the account's network lists. Elements are excluded by
// default: a single list can hold tens of thousands of addresses (the Tor exit
// node list alone runs to thousands), and a caller asking which lists exist
// rarely wants all of their contents inlined.
type NetworkListListIn struct {
	Search          string `json:"search,omitempty" jsonschema:"filter lists by name or element"`
	ListType        string `json:"listType,omitempty" jsonschema:"filter by list type: IP or GEO"`
	IncludeElements bool   `json:"includeElements,omitempty" jsonschema:"inline every address or country code in each list (default false; these can be very large)"`
	Extended        bool   `json:"extended,omitempty" jsonschema:"include creation, modification, and deployment metadata (default false)"`
}

func networkListList(ctx context.Context, _ *mcp.CallToolRequest, in NetworkListListIn) (*mcp.CallToolResult, any, error) {
	q := map[string]any{"includeElements": in.IncludeElements, "extended": in.Extended}
	setIf(q, "search", in.Search)
	setIf(q, "listType", strings.ToUpper(strings.TrimSpace(in.ListType)))
	return callCurated(ctx, "akamai_network_list_list", RawRequestIn{QueryParams: q}), nil, nil
}

// NetworkListGetIn reads one network list. Elements default to on here, unlike
// the listing: asking for a specific list by id is asking what is in it.
type NetworkListGetIn struct {
	NetworkListID   string `json:"networkListId" jsonschema:"network list id, e.g. 365_AKAMAITOREXITNODES. akamai_network_list_list returns these."`
	ExcludeElements bool   `json:"excludeElements,omitempty" jsonschema:"return only the list's metadata, not its addresses (default false, so elements are included)"`
	Extended        bool   `json:"extended,omitempty" jsonschema:"include creation, modification, and deployment metadata (default false)"`
}

func networkListGet(ctx context.Context, _ *mcp.CallToolRequest, in NetworkListGetIn) (*mcp.CallToolResult, any, error) {
	p := map[string]any{}
	setIf(p, "networkListId", in.NetworkListID)
	q := map[string]any{"includeElements": !in.ExcludeElements, "extended": in.Extended}
	return callCurated(ctx, "akamai_network_list_get", RawRequestIn{PathParams: p, QueryParams: q}), nil, nil
}

// DNSZoneListIn lists the Edge DNS zones on the account.
type DNSZoneListIn struct {
	ContractIDs string `json:"contractIds,omitempty" jsonschema:"comma-separated contract ids to scope the listing"`
	Search      string `json:"search,omitempty" jsonschema:"filter zones by name"`
	Types       string `json:"types,omitempty" jsonschema:"comma-separated zone types: PRIMARY, SECONDARY, ALIAS"`
	Page        int    `json:"page,omitempty" jsonschema:"page number"`
	PageSize    int    `json:"pageSize,omitempty" jsonschema:"page size"`
	Paginate    bool   `json:"paginate,omitempty" jsonschema:"follow pages and combine the results instead of returning the first page"`
	MaxPages    int    `json:"maxPages,omitempty" jsonschema:"max pages to fetch when paginating (default 20, hard cap 100)"`
}

func dnsZoneList(ctx context.Context, _ *mcp.CallToolRequest, in DNSZoneListIn) (*mcp.CallToolResult, any, error) {
	q := map[string]any{}
	setIf(q, "contractIds", in.ContractIDs)
	setIf(q, "search", in.Search)
	setIf(q, "types", strings.ToUpper(strings.TrimSpace(in.Types)))
	setIfPositive(q, "page", in.Page)
	setIfPositive(q, "pageSize", in.PageSize)
	return callCurated(ctx, "akamai_dns_zone_list", RawRequestIn{
		QueryParams: q, Paginate: in.Paginate, MaxPages: in.MaxPages,
	}), nil, nil
}

// DNSRecordsIn reads one zone's record sets.
type DNSRecordsIn struct {
	Zone     string `json:"zone" jsonschema:"zone name, e.g. example.com. akamai_dns_zone_list returns these."`
	Types    string `json:"types,omitempty" jsonschema:"comma-separated record types to return, e.g. A,AAAA,CNAME"`
	Search   string `json:"search,omitempty" jsonschema:"filter record sets by name"`
	Page     int    `json:"page,omitempty" jsonschema:"page number"`
	PageSize int    `json:"pageSize,omitempty" jsonschema:"page size"`
	Paginate bool   `json:"paginate,omitempty" jsonschema:"follow pages and combine the results instead of returning the first page"`
	MaxPages int    `json:"maxPages,omitempty" jsonschema:"max pages to fetch when paginating (default 20, hard cap 100)"`
}

func dnsRecords(ctx context.Context, _ *mcp.CallToolRequest, in DNSRecordsIn) (*mcp.CallToolResult, any, error) {
	p := map[string]any{}
	setIf(p, "zone", in.Zone)
	q := map[string]any{}
	setIf(q, "types", strings.ToUpper(strings.TrimSpace(in.Types)))
	setIf(q, "search", in.Search)
	setIfPositive(q, "page", in.Page)
	setIfPositive(q, "pageSize", in.PageSize)
	return callCurated(ctx, "akamai_dns_records", RawRequestIn{
		PathParams: p, QueryParams: q, Paginate: in.Paginate, MaxPages: in.MaxPages,
	}), nil, nil
}

// cpsContractID normalizes a contract id for CPS, which is the one product here
// that wants it bare. Every other Akamai API on this server returns and accepts
// the prefixed form (ctr_3-HINVO), and CPS answers a prefixed id with "400
// Invalid Contract ... does not belong to ACG list", which reads like an
// entitlement problem rather than a formatting one. Stripping it here means a
// caller can pass what akamai_account_overview handed them and get data.
func cpsContractID(id string) string {
	return strings.TrimPrefix(strings.TrimSpace(id), "ctr_")
}

// CertificateListIn lists CPS certificate enrollments on one contract.
type CertificateListIn struct {
	ContractID string `json:"contractId" jsonschema:"contract to list enrollments for, e.g. ctr_3-HINVO or 3-HINVO (either form works). Required by CPS; akamai_account_overview lists the account's contracts."`
	Hostname   string `json:"hostname,omitempty" jsonschema:"return only the enrollments whose common name or SANs cover this hostname, e.g. www.example.com. Matched here rather than at Akamai, which offers no such filter."`
	Full       bool   `json:"full,omitempty" jsonschema:"return the raw CPS payload instead of the summarized list (very large: on a mid-sized account the full list runs past 140,000 characters)"`
}

func certificateList(ctx context.Context, _ *mcp.CallToolRequest, in CertificateListIn) (*mcp.CallToolResult, any, error) {
	q := map[string]any{}
	setIf(q, "contractId", cpsContractID(in.ContractID))
	req := RawRequestIn{QueryParams: q, Headers: map[string]string{"accept": cpsEnrollmentsAccept}}

	// A hostname filter implies the caller wants those enrollments in full:
	// having narrowed to a handful, the SANs and TLS settings are the answer,
	// and they now fit. Without a filter the list is summarized so it fits at
	// all. full=true overrides both.
	if hostname := strings.TrimSpace(in.Hostname); hostname != "" {
		return callCuratedShaped(ctx, "akamai_certificate_list", req, func(data any) any {
			return filterEnrollmentsByHostname(data, hostname)
		}), nil, nil
	}
	if in.Full {
		return callCuratedFull(ctx, "akamai_certificate_list", req), nil, nil
	}
	return callCurated(ctx, "akamai_certificate_list", req), nil, nil
}

// CertificateGetIn reads one enrollment.
type CertificateGetIn struct {
	EnrollmentID int `json:"enrollmentId" jsonschema:"enrollment id, e.g. 19243. akamai_certificate_list returns these."`
}

func certificateGet(ctx context.Context, _ *mcp.CallToolRequest, in CertificateGetIn) (*mcp.CallToolResult, any, error) {
	p := map[string]any{}
	setIfPositive(p, "enrollmentId", in.EnrollmentID)
	return callCurated(ctx, "akamai_certificate_get", RawRequestIn{
		PathParams: p, Headers: map[string]string{"accept": cpsEnrollmentAccept},
	}), nil, nil
}

// --- reporting family ---

const opTrafficReport = "akamai_reporting_api_post-report-data"

// The v2 reporting API addresses a report as product family / reporting area /
// report, and its data endpoint is a POST because the query (dimensions,
// metrics, filters) does not fit in a URL. It is still a read: it computes over
// traffic Akamai already served and changes nothing. These defaults name the
// CDN traffic report, which is what "traffic report" means without further
// qualification; a caller after another report overrides all three.
const (
	defaultReportProductFamily = "delivery"
	defaultReportingArea       = "traffic"
	defaultReportName          = "current"
)

// TrafficReportIn requests one report's data. Leaving start and end unset uses
// the report's own default window, which the API documents per report, rather
// than this tool inventing one.
type TrafficReportIn struct {
	Start         string           `json:"start,omitempty" jsonschema:"start of the window, ISO 8601 UTC, e.g. 2026-08-18T00:00:00Z. Omit to use the report's default window."`
	End           string           `json:"end,omitempty" jsonschema:"end of the window, ISO 8601 UTC. Omit to use the report's default window."`
	Dimensions    []string         `json:"dimensions,omitempty" jsonschema:"group by these dimensions, e.g. hostname, cpcode, responseClass, time1hour. Report defaults apply when unset."`
	Metrics       []string         `json:"metrics,omitempty" jsonschema:"measure these metrics, e.g. edgeHitsSum, edgeBytesSum. Report defaults apply when unset."`
	Filters       []map[string]any `json:"filters,omitempty" jsonschema:"filter objects in the reporting API's own form, e.g. {\"name\":\"hostname\",\"operator\":\"IN_LIST\",\"values\":[\"www.example.com\"]}"`
	Limit         int              `json:"limit,omitempty" jsonschema:"maximum data points to return"`
	ProductFamily string           `json:"productFamily,omitempty" jsonschema:"report product family (default delivery). akamai_read_request on akamai_reporting_api_get-reports lists every report."`
	ReportingArea string           `json:"reportingArea,omitempty" jsonschema:"report reporting area (default traffic)"`
	Report        string           `json:"report,omitempty" jsonschema:"report name (default current, the CDN traffic report)"`
	Full          bool             `json:"full,omitempty" jsonschema:"return the raw payload including the echoed query metadata and the full authorized CP code list (large)"`
}

func trafficReport(ctx context.Context, _ *mcp.CallToolRequest, in TrafficReportIn) (*mcp.CallToolResult, any, error) {
	p := map[string]any{
		"productFamily": firstNonEmpty(in.ProductFamily, defaultReportProductFamily),
		"reportingArea": firstNonEmpty(in.ReportingArea, defaultReportingArea),
		"report":        firstNonEmpty(in.Report, defaultReportName),
	}
	q := map[string]any{}
	setIf(q, "start", in.Start)
	setIf(q, "end", in.End)

	// Always a body, even an empty one: the endpoint is a POST, and sending
	// nothing would leave Content-Type unset on a request the API expects to be
	// JSON. An empty object means "use this report's documented defaults".
	body := map[string]any{}
	if len(in.Dimensions) > 0 {
		body["dimensions"] = in.Dimensions
	}
	if len(in.Metrics) > 0 {
		body["metrics"] = in.Metrics
	}
	if len(in.Filters) > 0 {
		body["filters"] = in.Filters
	}
	if in.Limit > 0 {
		body["limit"] = in.Limit
	}
	req := RawRequestIn{PathParams: p, QueryParams: q, Body: body}
	if in.Full {
		return callCuratedFull(ctx, "akamai_traffic_report", req), nil, nil
	}
	return callCurated(ctx, "akamai_traffic_report", req), nil, nil
}

// firstNonEmpty returns the first non-blank value, which is how the reporting
// tool applies its defaults without a caller having to name all three parts of
// a report they did not ask to change.
func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

// --- Edge Diagnostics family ---

const (
	opEdgeCurl       = "akamai_edge_diagnostics_post-curl"
	opEdgeDig        = "akamai_edge_diagnostics_post-dig"
	opEdgeMtr        = "akamai_edge_diagnostics_post-mtr"
	opGrepLogs       = "akamai_edge_diagnostics_post-grep"
	opURLHealthCheck = "akamai_edge_diagnostics_post-url-health-check"
)

// Every Edge Diagnostics operation is a POST, which is the first reason none of
// them is reachable through akamai_read_request. The second is that the API
// splits them: curl, dig, and mtr answer synchronously with a 200, while grep
// and the URL health check answer 202 with a requestId and expect the caller to
// poll <endpoint>/requests/{requestId}. An MCP caller cannot sleep between tool
// calls, so for those two the polling has to happen inside the call or the
// endpoint is unreachable in practice however it is dispatched.
//
// All of them submit a diagnostic question about traffic Akamai has already
// served. None changes a property, a security configuration, cached content, or
// delivery behavior, which is why they are READ despite the method.

// diagnosticResponse is the async envelope Edge Diagnostics wraps its answers
// in. Only the fields that drive polling are typed; everything else stays raw so
// fields Akamai adds later reach the caller untouched.
type diagnosticResponse struct {
	ExecutionStatus string `json:"executionStatus"`
	RequestID       int    `json:"requestId"`
	RetryAfter      int    `json:"retryAfter"`
}

// decodeDiagnostic parses one stage of a diagnostic exchange, or turns an API
// refusal into a tool error that keeps Akamai's own body. That distinction
// matters here more than anywhere else on this server: a 403 pep-authz means the
// API client lacks the Edge Diagnostics grant, which is an entitlement to
// request in Control Center, while a 400 means the request was malformed. Both
// collapsed into "request failed" would send the operator after the wrong one.
func decodeDiagnostic(tool, stage string, resp *signedResponse) (diagnosticResponse, json.RawMessage, *mcp.CallToolResult) {
	var raw json.RawMessage = resp.Body
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var parsed any
		if err := json.Unmarshal(resp.Body, &parsed); err != nil {
			parsed = string(resp.Body)
		}
		return diagnosticResponse{}, nil, &mcp.CallToolResult{IsError: true, Content: jsonContent(map[string]any{
			"error":  true,
			"tool":   tool,
			"stage":  stage,
			"status": resp.StatusCode,
			"body":   parsed,
		})}
	}
	var env diagnosticResponse
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &env); err != nil {
			// A body that does not carry the envelope is not an error: the
			// synchronous operations return their result directly. Pass it
			// through and let the caller read it.
			return diagnosticResponse{}, raw, nil
		}
	}
	return env, raw, nil
}

// runDiagnostic submits one pinned Edge Diagnostics operation and, when the API
// answers asynchronously and the operation has a poll endpoint, collects the
// finished result within a bounded number of attempts and a bounded wall clock.
// A slow diagnostic returns IN_PROGRESS with its requestId rather than hanging
// the caller, matching akamai_translate_error's contract.
//
// Deliberately not dispatch(): the polling decision needs the parsed response
// body, and dispatch hands back a rendered result. The method and path still
// come from the pinned catalogue entry, so the two paths cannot drift apart on
// which endpoint they address.
func runDiagnostic(ctx context.Context, tool string, body map[string]any, pollable bool) *mcp.CallToolResult {
	op, refusal := curatedOp(tool)
	if refusal != nil {
		return refusal
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return errorResult(tool + ": failed to encode the request: " + err.Error())
	}

	resp, err := apiCall(ctx, op.Method, op.Path, nil, nil, payload)
	if err != nil {
		return errorResult(tool + ": request failed: " + err.Error())
	}
	env, raw, failure := decodeDiagnostic(tool, "submit", resp)
	if failure != nil {
		return failure
	}

	polls := 0
	deadline := time.Now().Add(diagMaxWait)
	for pollable && env.ExecutionStatus == statusInProgress && env.RequestID > 0 && polls < diagMaxPolls {
		wait := pollWait(env.RetryAfter)
		if time.Now().Add(wait).After(deadline) {
			break
		}
		select {
		case <-ctx.Done():
			return errorResult(fmt.Sprintf("%s: cancelled while waiting for request %d", tool, env.RequestID))
		case <-time.After(wait):
		}
		polls++

		pollResp, perr := apiCall(ctx, http.MethodGet, diagnosticRequestPath(op.Path, env.RequestID), nil, nil, nil)
		if perr != nil {
			return errorResult(fmt.Sprintf("%s: the request was accepted as %d, but polling for the result failed: %v", tool, env.RequestID, perr))
		}
		nextEnv, nextRaw, pfail := decodeDiagnostic(tool, "poll", pollResp)
		if pfail != nil {
			return pfail
		}
		env, raw = nextEnv, nextRaw
	}

	out := map[string]any{
		"operation": map[string]any{"toolName": op.ToolName, "method": op.Method, "path": op.Path, "product": op.Product},
		"polls":     polls,
		"data":      raw,
	}
	if env.ExecutionStatus == statusInProgress {
		out["note"] = fmt.Sprintf("Akamai is still processing this request. Call %s again with the same arguments to pick up the finished result.", tool)
	}
	return jsonResult(out)
}

// EdgeCurlIn runs curl from an Akamai edge server. Either edgeLocationId or
// edgeIp identifies which server; the API requires one of them and this tool
// says so rather than letting the API answer with a 400.
type EdgeCurlIn struct {
	URL            string   `json:"url" jsonschema:"URL to request from the edge, e.g. https://www.example.com/"`
	EdgeLocationID string   `json:"edgeLocationId,omitempty" jsonschema:"edge server location to run from. Give this or edgeIp."`
	EdgeIP         string   `json:"edgeIp,omitempty" jsonschema:"edge server IP to run from. Give this or edgeLocationId."`
	IPVersion      string   `json:"ipVersion,omitempty" jsonschema:"IPV4 or IPV6"`
	RequestHeaders []string `json:"requestHeaders,omitempty" jsonschema:"extra request headers as \"Header: value\" strings, including Akamai Pragma headers"`
}

func edgeCurl(ctx context.Context, _ *mcp.CallToolRequest, in EdgeCurlIn) (*mcp.CallToolResult, any, error) {
	if strings.TrimSpace(in.URL) == "" {
		return errorResult("akamai_edge_curl: url is required"), nil, nil
	}
	if refusal := requireEdgeTarget("akamai_edge_curl", in.EdgeIP, in.EdgeLocationID); refusal != nil {
		return refusal, nil, nil
	}
	body := map[string]any{"url": strings.TrimSpace(in.URL)}
	setIf(body, "edgeLocationId", in.EdgeLocationID)
	setIf(body, "edgeIp", in.EdgeIP)
	setIf(body, "ipVersion", strings.ToUpper(strings.TrimSpace(in.IPVersion)))
	if len(in.RequestHeaders) > 0 {
		body["requestHeaders"] = in.RequestHeaders
	}
	return runDiagnostic(ctx, "akamai_edge_curl", body, false), nil, nil
}

// EdgeDigIn runs dig from an Akamai edge server.
type EdgeDigIn struct {
	Hostname       string `json:"hostname" jsonschema:"hostname or domain to look up, e.g. www.example.com"`
	QueryType      string `json:"queryType,omitempty" jsonschema:"DNS record type: A, AAAA, SOA, CNAME, PTR, MX, NS, TXT, SRV, CAA, ANY (default A)"`
	EdgeLocationID string `json:"edgeLocationId,omitempty" jsonschema:"edge server location to run from. Give this or edgeIp."`
	EdgeIP         string `json:"edgeIp,omitempty" jsonschema:"edge server IP to run from. Give this or edgeLocationId."`
	IsGtmHostname  bool   `json:"isGtmHostname,omitempty" jsonschema:"set when the hostname is a GTM hostname (default false)"`
}

func edgeDig(ctx context.Context, _ *mcp.CallToolRequest, in EdgeDigIn) (*mcp.CallToolResult, any, error) {
	if strings.TrimSpace(in.Hostname) == "" {
		return errorResult("akamai_edge_dig: hostname is required"), nil, nil
	}
	if refusal := requireEdgeTarget("akamai_edge_dig", in.EdgeIP, in.EdgeLocationID); refusal != nil {
		return refusal, nil, nil
	}
	// queryType and isGtmHostname are required by the API, so both are always
	// sent: a default the tool states beats a 400 the caller has to decode.
	body := map[string]any{
		"hostname":      strings.TrimSpace(in.Hostname),
		"queryType":     firstNonEmpty(strings.ToUpper(in.QueryType), "A"),
		"isGtmHostname": in.IsGtmHostname,
	}
	setIf(body, "edgeLocationId", in.EdgeLocationID)
	setIf(body, "edgeIp", in.EdgeIP)
	return runDiagnostic(ctx, "akamai_edge_dig", body, false), nil, nil
}

// EdgeMtrIn traces the network path from an Akamai edge server to a destination.
type EdgeMtrIn struct {
	Destination     string `json:"destination" jsonschema:"hostname or IP to trace to, matching destinationType"`
	DestinationType string `json:"destinationType,omitempty" jsonschema:"HOST or IP (default HOST). Use IP for a GTM or Site Shield hostname."`
	Source          string `json:"source,omitempty" jsonschema:"edge server IP or edge location id to trace from, matching sourceType"`
	SourceType      string `json:"sourceType,omitempty" jsonschema:"EDGE_IP or LOCATION"`
	PacketType      string `json:"packetType,omitempty" jsonschema:"ICMP or TCP (default ICMP)"`
	Port            int    `json:"port,omitempty" jsonschema:"80 or 443, only for destinationType HOST"`
	ResolveDNS      *bool  `json:"resolveDns,omitempty" jsonschema:"resolve DNS for each hop (default true)"`
	ShowIPs         *bool  `json:"showIps,omitempty" jsonschema:"show the IP of each hop (default true)"`
	ShowLocations   *bool  `json:"showLocations,omitempty" jsonschema:"show the location of each hop (default true)"`
}

func edgeMtr(ctx context.Context, _ *mcp.CallToolRequest, in EdgeMtrIn) (*mcp.CallToolResult, any, error) {
	if strings.TrimSpace(in.Destination) == "" {
		return errorResult("akamai_edge_mtr: destination is required"), nil, nil
	}
	// All six of these are required by the API. The three booleans default to
	// true because a trace that resolves nothing and shows nothing is not the
	// trace anyone asked for; *bool is what lets a caller turn one off, which a
	// plain bool could not express.
	body := map[string]any{
		"destination":     strings.TrimSpace(in.Destination),
		"destinationType": firstNonEmpty(strings.ToUpper(in.DestinationType), "HOST"),
		"packetType":      firstNonEmpty(strings.ToUpper(in.PacketType), "ICMP"),
		"resolveDns":      boolOr(in.ResolveDNS, true),
		"showIps":         boolOr(in.ShowIPs, true),
		"showLocations":   boolOr(in.ShowLocations, true),
	}
	setIf(body, "source", in.Source)
	setIf(body, "sourceType", strings.ToUpper(strings.TrimSpace(in.SourceType)))
	if in.Port > 0 {
		body["port"] = in.Port
	}
	return runDiagnostic(ctx, "akamai_edge_mtr", body, false), nil, nil
}

// GrepLogsIn searches an edge server's own request logs. This is the asynchronous
// one: the submit answers 202 and the result is collected by polling, which this
// tool does inside the call.
type GrepLogsIn struct {
	EdgeIP     string   `json:"edgeIp" jsonschema:"edge server IP whose logs to search"`
	Start      string   `json:"start" jsonschema:"start of the search window, ISO 8601 UTC, e.g. 2026-08-19T12:00:00Z"`
	End        string   `json:"end" jsonschema:"end of the search window, ISO 8601 UTC"`
	LogType    string   `json:"logType,omitempty" jsonschema:"R for client requests to the edge, F for forward requests to origin, BOTH (default R)"`
	CPCodes    []int    `json:"cpCodes,omitempty" jsonschema:"CP codes to filter by. Give these or hostnames."`
	Hostnames  []string `json:"hostnames,omitempty" jsonschema:"hostnames to filter by. Give these or cpCodes."`
	ClientIPs  []string `json:"clientIps,omitempty" jsonschema:"client IPs to filter by"`
	UserAgents []string `json:"userAgents,omitempty" jsonschema:"user agents to filter by"`
}

func grepLogs(ctx context.Context, _ *mcp.CallToolRequest, in GrepLogsIn) (*mcp.CallToolResult, any, error) {
	missing := []string{}
	if strings.TrimSpace(in.EdgeIP) == "" {
		missing = append(missing, "edgeIp")
	}
	if strings.TrimSpace(in.Start) == "" {
		missing = append(missing, "start")
	}
	if strings.TrimSpace(in.End) == "" {
		missing = append(missing, "end")
	}
	if len(missing) > 0 {
		return errorResult("akamai_grep_logs: missing required argument(s): " + strings.Join(missing, ", ")), nil, nil
	}
	if len(in.CPCodes) == 0 && len(in.Hostnames) == 0 {
		return errorResult("akamai_grep_logs: give cpCodes or hostnames. The edge log search is scoped to content you own, and the API refuses a search that names neither."), nil, nil
	}
	body := map[string]any{
		"edgeIp":  strings.TrimSpace(in.EdgeIP),
		"start":   strings.TrimSpace(in.Start),
		"end":     strings.TrimSpace(in.End),
		"logType": firstNonEmpty(strings.ToUpper(in.LogType), "R"),
	}
	if len(in.CPCodes) > 0 {
		body["cpCodes"] = in.CPCodes
	}
	if len(in.Hostnames) > 0 {
		body["hostnames"] = in.Hostnames
	}
	if len(in.ClientIPs) > 0 {
		body["clientIps"] = in.ClientIPs
	}
	if len(in.UserAgents) > 0 {
		body["userAgents"] = in.UserAgents
	}
	return runDiagnostic(ctx, "akamai_grep_logs", body, true), nil, nil
}

// URLHealthCheckIn runs the composite health check: curl, dig, and optionally
// MTR and log collection, against one URL from the edge. Asynchronous like grep.
type URLHealthCheckIn struct {
	URL            string   `json:"url" jsonschema:"URL to health check, e.g. https://www.example.com/"`
	EdgeLocationID string   `json:"edgeLocationId,omitempty" jsonschema:"edge server location to run from"`
	IPVersion      string   `json:"ipVersion,omitempty" jsonschema:"IPV4 or IPV6"`
	ViewsAllowed   []string `json:"viewsAllowed,omitempty" jsonschema:"extra checks to run: CONNECTIVITY (adds MTR) and LOGS (adds edge log lines)"`
	RequestHeaders []string `json:"requestHeaders,omitempty" jsonschema:"extra request headers as \"Header: value\" strings"`
}

func urlHealthCheck(ctx context.Context, _ *mcp.CallToolRequest, in URLHealthCheckIn) (*mcp.CallToolResult, any, error) {
	if strings.TrimSpace(in.URL) == "" {
		return errorResult("akamai_url_health_check: url is required"), nil, nil
	}
	body := map[string]any{"url": strings.TrimSpace(in.URL)}
	setIf(body, "edgeLocationId", in.EdgeLocationID)
	setIf(body, "ipVersion", strings.ToUpper(strings.TrimSpace(in.IPVersion)))
	if len(in.ViewsAllowed) > 0 {
		body["viewsAllowed"] = in.ViewsAllowed
	}
	if len(in.RequestHeaders) > 0 {
		body["requestHeaders"] = in.RequestHeaders
	}
	return runDiagnostic(ctx, "akamai_url_health_check", body, true), nil, nil
}

// requireEdgeTarget enforces the "one of these two" rule the curl and dig
// endpoints impose. Checking it here costs a round trip less than letting the
// API answer 400, and the message names both options rather than one.
func requireEdgeTarget(tool, edgeIP, edgeLocationID string) *mcp.CallToolResult {
	hasIP := strings.TrimSpace(edgeIP) != ""
	hasLocation := strings.TrimSpace(edgeLocationID) != ""
	if hasIP == hasLocation {
		return errorResult(tool + ": give exactly one of edgeIp or edgeLocationId, to say which edge server to run from. " +
			"Use akamai_read_request on akamai_edge_diagnostics_get-edge-locations to list the locations.")
	}
	return nil
}

// --- akamai_translate_error (fixed-endpoint diagnostic lookup) ---

// The Edge Diagnostics error translator is reachable through the universal
// executor, but only by naming an arbitrary catalogued operation, which is the
// reason that tool is classified PRODUCTION. This tool exists so a caller (a
// chat bot resolving a reference id from a live incident, say) can get a
// translation without being handed the executor. Both endpoints are fixed
// constants below: no caller input can change the path, the method, or the
// product reached.
const (
	errorTranslatorPath = "/edge-diagnostics/v1/error-translator"

	// maxErrorCodeLen bounds the reference string. Real reference codes and
	// Global Request Numbers are far shorter; the cap only stops an oversized
	// body being signed and shipped to Akamai.
	maxErrorCodeLen = 256

	// Polling bounds, shared by every asynchronous Edge Diagnostics tool: the
	// POST returns IN_PROGRESS with a retryAfter and the finished result is
	// collected by GET. They live here because they are a property of that API's
	// async contract rather than of any one tool, and they keep a call from
	// becoming an open-ended wait, at the cost of sometimes returning
	// IN_PROGRESS with the requestId for the caller to ask again.
	diagMaxPolls    = 4
	diagMaxWait     = 24 * time.Second
	diagMinPollWait = 1 * time.Second
	diagMaxPollWait = 8 * time.Second

	statusInProgress = "IN_PROGRESS"
)

// errorTranslatorRequestPath builds the poll path from Akamai's own numeric
// requestId. The response also carries a `link` to the same resource, which is
// deliberately NOT followed: a path taken from a response body would reopen the
// steering problem this tool exists to close, and building it here keeps the
// only variable part of the URL an integer.
func errorTranslatorRequestPath(requestID int) string {
	return diagnosticRequestPath(errorTranslatorPath, requestID)
}

// diagnosticRequestPath builds the poll path for any asynchronous Edge
// Diagnostics operation. The base comes from a pinned catalogue entry and the
// only variable part is an integer Akamai itself returned, so a response body
// can never steer a poll at another endpoint. Every one of those responses also
// carries a `link` to the same resource, which is deliberately NOT followed for
// that reason.
func diagnosticRequestPath(basePath string, requestID int) string {
	return basePath + "/requests/" + strconv.Itoa(requestID)
}

// TranslateErrorIn is the input for akamai_translate_error.
type TranslateErrorIn struct {
	ErrorCode        string `json:"errorCode" jsonschema:"Akamai error reference string from an error page or log line, e.g. 0.f2343217.1787166214.c816d2 (a Global Request Number also works)"`
	TraceForwardLogs bool   `json:"traceForwardLogs,omitempty" jsonschema:"collect logs from every edge server that handled the request instead of only the one that served the error (more detail, slower)"`
}

// errorTranslatorResponse is the part of the API payload this tool reads. result
// stays raw so fields Akamai adds later reach the caller untouched.
type errorTranslatorResponse struct {
	ExecutionStatus  string          `json:"executionStatus"`
	RequestID        int             `json:"requestId"`
	RetryAfter       int             `json:"retryAfter"`
	CreatedTime      string          `json:"createdTime"`
	CompletedTime    string          `json:"completedTime"`
	SuggestedActions []string        `json:"suggestedActions"`
	Result           json.RawMessage `json:"result"`
}

// decodeTranslation turns a signed response into the parsed payload, or into an
// error result when the API refused the call. Akamai's own body is passed
// through on failure: a 403 for an account without Edge Diagnostics access reads
// very differently from a 400 for a malformed reference code, and collapsing
// both into "request failed" would cost the caller that distinction.
func decodeTranslation(stage string, resp *signedResponse) (*errorTranslatorResponse, *mcp.CallToolResult) {
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var parsed any
		if err := json.Unmarshal(resp.Body, &parsed); err != nil {
			parsed = string(resp.Body)
		}
		return nil, &mcp.CallToolResult{IsError: true, Content: jsonContent(map[string]any{
			"error":  true,
			"tool":   "akamai_translate_error",
			"stage":  stage,
			"status": resp.StatusCode,
			"body":   parsed,
		})}
	}
	var out errorTranslatorResponse
	if err := json.Unmarshal(resp.Body, &out); err != nil {
		return nil, errorResult("akamai_translate_error: could not parse the " + stage + " response: " + err.Error())
	}
	return &out, nil
}

// pollWait clamps the API's retryAfter to a usable interval. Zero or absent
// means "poll on our own cadence" rather than "poll immediately", and an
// oversized value must not stall the call past its budget.
func pollWait(retryAfter int) time.Duration {
	w := time.Duration(retryAfter) * time.Second
	if w < diagMinPollWait {
		return diagMinPollWait
	}
	if w > diagMaxPollWait {
		return diagMaxPollWait
	}
	return w
}

func translateError(ctx context.Context, _ *mcp.CallToolRequest, in TranslateErrorIn) (*mcp.CallToolResult, any, error) {
	code := strings.TrimSpace(in.ErrorCode)
	if code == "" {
		return errorResult("akamai_translate_error: errorCode is required (the Akamai error reference string, e.g. 0.f2343217.1787166214.c816d2)"), nil, nil
	}
	if len(code) > maxErrorCodeLen {
		return errorResult(fmt.Sprintf("akamai_translate_error: errorCode is %d characters, over the %d-character limit for a reference code", len(code), maxErrorCodeLen)), nil, nil
	}

	// The reference code travels as a JSON body field and nowhere else: not in
	// the path, not in the query string, not in a header. There is no request
	// shape a caller can produce here other than this one POST.
	body, err := json.Marshal(map[string]any{"errorCode": code, "traceForwardLogs": in.TraceForwardLogs})
	if err != nil {
		return errorResult("akamai_translate_error: failed to encode the request: " + err.Error()), nil, nil
	}

	resp, err := apiCall(ctx, http.MethodPost, errorTranslatorPath, nil, nil, body)
	if err != nil {
		return errorResult("akamai_translate_error: submitting the reference code failed: " + err.Error()), nil, nil
	}
	parsed, failure := decodeTranslation("submit", resp)
	if failure != nil {
		return failure, nil, nil
	}

	// Asynchronous case: collect the finished translation, bounded in both
	// attempts and total wall clock so the tool always answers, even when the
	// translator is slow or the logs never arrive.
	polls := 0
	deadline := time.Now().Add(diagMaxWait)
	for parsed.ExecutionStatus == statusInProgress && parsed.RequestID > 0 && polls < diagMaxPolls {
		wait := pollWait(parsed.RetryAfter)
		if time.Now().Add(wait).After(deadline) {
			break
		}
		select {
		case <-ctx.Done():
			return errorResult(fmt.Sprintf("akamai_translate_error: cancelled while waiting for request %d", parsed.RequestID)), nil, nil
		case <-time.After(wait):
		}
		polls++

		pollResp, perr := apiCall(ctx, http.MethodGet, errorTranslatorRequestPath(parsed.RequestID), nil, nil, nil)
		if perr != nil {
			return errorResult(fmt.Sprintf("akamai_translate_error: reference code accepted as request %d, but polling for the result failed: %v", parsed.RequestID, perr)), nil, nil
		}
		next, pfail := decodeTranslation("poll", pollResp)
		if pfail != nil {
			return pfail, nil, nil
		}
		parsed = next
	}

	out := map[string]any{
		"errorCode":       code,
		"executionStatus": parsed.ExecutionStatus,
		"polls":           polls,
	}
	if parsed.RequestID > 0 {
		out["requestId"] = parsed.RequestID
	}
	if parsed.CreatedTime != "" {
		out["createdTime"] = parsed.CreatedTime
	}
	if parsed.CompletedTime != "" {
		out["completedTime"] = parsed.CompletedTime
	}
	if len(parsed.SuggestedActions) > 0 {
		out["suggestedActions"] = parsed.SuggestedActions
	}
	if len(parsed.Result) > 0 {
		out["translation"] = parsed.Result
	}
	if parsed.ExecutionStatus == statusInProgress {
		out["note"] = "Akamai is still processing this reference code. Call akamai_translate_error again with the same errorCode to pick up the finished translation."
	}
	return jsonResult(out), nil, nil
}

// --- help ---

type HelpIn struct {
	Topic string `json:"topic,omitempty" jsonschema:"optional help topic"`
}

func helpHandler(_ context.Context, _ *mcp.CallToolRequest, _ HelpIn) (*mcp.CallToolResult, any, error) {
	products := make([]string, 0, len(reg.byProduct))
	for p := range reg.byProduct {
		products = append(products, p)
	}
	sort.Strings(products)
	mode := "READ-ONLY (writes denied; set AKAMAI_ALLOW_WRITES=1 in the fleet manifest to permit them)"
	if writesAllowed {
		mode = "READ-WRITE (mutating operations permitted; the gateway still requires human approval)"
	}
	lines := []string{
		"akamai-mcp (" + version + ") - native-Go MCP server for the Akamai API (EdgeGrid-signed).",
		"",
		"Mode: " + mode,
		"",
		"Tools:",
		"  akamai_list_operations(product?, method?, query?, paginatable?, limit?)",
		"      Discover operations. Start here to find the exact toolName.",
		"  akamai_raw_request(toolName, pathParams?, queryParams?, headers?, body?, paginate?, maxPages?)",
		fmt.Sprintf("      Execute ANY of the %d catalogued operations. The full Akamai API", len(reg.ops)),
		"      surface is reachable here even when no convenience tool wraps it.",
		"  akamai_read_request(toolName, pathParams?, queryParams?, headers?, body?, paginate?, maxPages?)",
		fmt.Sprintf("      Same dispatch, reads only: the %d catalogued GET operations plus the", len(reg.byMethod[http.MethodGet])),
		"      Edge Diagnostics error translator. Refuses every other method.",
		"  akamai_registry_stats()",
		"      Coverage stats (operations per product / method).",
		"  akamai_account_overview()",
		"      Bounded aggregation: user profile + contracts + groups in one call.",
		"  akamai_translate_error(errorCode, traceForwardLogs?)",
		"      Translate one Akamai error reference code into its diagnostic detail.",
		"      Fixed Edge Diagnostics endpoint; it reaches no other operation.",
		"  akamai-mcp_help(topic?)",
		"      This help.",
		"",
		"Named read tools - each pins ONE catalogued operation, takes no operation",
		"argument, and reaches nothing else. Prefer these over the dispatchers:",
		"",
		"  Property (CDN delivery configuration)",
		"    akamai_property_list(contractId, groupId)",
		"        Properties with their staging and production versions. Both ids are",
		"        required by Akamai; get them from akamai_account_overview. Know only",
		"        a hostname? Use akamai_hostname_list then akamai_property_get,",
		"        which need neither.",
		"    akamai_property_get(propertyId, contractId?, groupId?)",
		"    akamai_property_hostnames(propertyId, propertyVersion, ...)",
		"    akamai_property_rules(propertyId, propertyVersion, ...)",
		"    akamai_property_activations(propertyId, contractId?, groupId?)",
		"        Activation history: which version went where, when, by whom.",
		"    akamai_property_search(hostname | propertyName | edgeHostname)",
		"        Which property serves a hostname.",
		"    akamai_hostname_list(hostname?, cnameTo?, network?, ...)",
		"        Account-wide hostname inventory.",
		"",
		"  Security",
		"    akamai_security_config_list()",
		"        WAF / App and API Protector configurations and their versions.",
		"    akamai_security_config_get(configId, includeHostnames?)",
		"    akamai_network_list_list(search?, listType?, ...)",
		"        IP and geography lists. Elements excluded by default.",
		"    akamai_network_list_get(networkListId, ...)",
		"        One list with its contents and staging/production status.",
		"",
		"  DNS",
		"    akamai_dns_zone_list(contractIds?, search?, types?, ...)",
		"    akamai_dns_records(zone, types?, search?, ...)",
		"",
		"  Certificates",
		"    akamai_certificate_list(contractId)",
		"        CPS enrollments: common name, SANs, renewal dates. Sends the",
		"        versioned CPS media type the API requires.",
		"    akamai_certificate_get(enrollmentId)",
		"",
		"  Reporting",
		"    akamai_traffic_report(start?, end?, dimensions?, metrics?, filters?)",
		"        CDN traffic: hits and bytes by hostname, CP code, or time.",
		"",
		"  Edge Diagnostics - ALL of these need the Edge Diagnostics grant on the",
		"  API client. Without it Akamai answers 403 pep-authz, which is an",
		"  entitlement to add in Control Center, not a fault in the request.",
		"    akamai_edge_curl(url, edgeLocationId | edgeIp, ...)",
		"        What the edge actually serves for a URL.",
		"    akamai_edge_dig(hostname, edgeLocationId | edgeIp, queryType?)",
		"        How a name resolves from inside the Akamai network.",
		"    akamai_edge_mtr(destination, ...)",
		"        Hop-by-hop path from an edge server to a destination.",
		"    akamai_grep_logs(edgeIp, start, end, cpCodes | hostnames, ...)",
		"        Search an edge server's request logs. Polls for the result.",
		"    akamai_url_health_check(url, viewsAllowed?, ...)",
		"        Composite check: curl, DNS, optional MTR and log lines.",
		"",
		"Auth: EdgeGrid EG1-HMAC-SHA256. Credentials resolve from the Hermes broker,",
		"then AKAMAI_* env vars, then ~/.edgerc. Credentials are never surfaced.",
		"",
		"Tip: account-wide enumeration (all properties/hostnames) can be slow - scope",
		"akamai_read_request to a contractId + groupId instead of listing everything.",
		"",
		fmt.Sprintf("Products (%d): %s", len(products), strings.Join(products, ", ")),
	}
	return textResult(strings.Join(lines, "\n")), nil, nil
}

// serve mounts srv on a stateless streamable-HTTP handler at /mcp, adds
// /healthz, binds MCP_HOST:MCP_PORT, and blocks until a signal arrives.
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
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })

	httpSrv := &http.Server{Addr: addr, Handler: mux, ReadHeaderTimeout: 10 * time.Second}

	sigCtx, stop := signal.NotifyContext(ctx, syscall.SIGTERM, os.Interrupt)
	defer stop()

	serveErr := make(chan error, 1)
	go func() {
		log.Printf("%s (%s): serving streamable-http on http://%s/mcp (health: /healthz) — %d operations loaded", serverName, version, addr, len(reg.ops))
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

// registerTools mounts every tool on srv and returns the names it registered.
//
// Extracted from main so a test can prove the list is complete. Pinning an
// operation correctly and never calling AddTool for it produces a tool that
// exists in the source, passes the drift test, and is reachable by nobody;
// returning the names is what lets TestEveryNamedToolIsRegistered close that
// gap without reaching into the SDK's unexported state.
func registerTools(srv *mcp.Server) []string {
	var names []string
	named := func(t *mcp.Tool) *mcp.Tool {
		names = append(names, t.Name)
		return t
	}

	mcp.AddTool(srv, named(&mcp.Tool{
		Name:        "akamai_raw_request",
		Description: "Execute any Akamai API operation by its tool name. The universal executor — the full catalogued API surface is reachable here. Find tool names with akamai_list_operations. Args: toolName (required), pathParams, queryParams, headers, body, paginate, maxPages.",
		Annotations: &mcp.ToolAnnotations{DestructiveHint: boolPtr(true), OpenWorldHint: boolPtr(true)},
	}), rawRequest)

	// The read surface, as its own tool. Everything a caller usually wants from
	// Akamai (property versions, hostnames, staging vs production state, config
	// detail) is catalogued as a GET, and before this tool existed the only way
	// to reach any of it was the universal executor, which the gateway gates on
	// human approval because of everything ELSE the executor can reach. That
	// left read-only callers with no door at all. IdempotentHint is left off
	// because of the one allowlisted POST, not because a GET is unrepeatable.
	mcp.AddTool(srv, named(&mcp.Tool{
		Name:        "akamai_read_request",
		Description: "Read Akamai configuration and state by catalogued operation name: properties and property versions, hostnames, staging versus production activation state, CP codes, edge hostnames, security configurations, DNS zones, GTM, network lists, and reporting. Dispatches catalogued GET operations only, plus the Edge Diagnostics error translator, so it reads everything and changes nothing. Find tool names with akamai_list_operations. Args: toolName (required), pathParams, queryParams, headers, body, paginate, maxPages.",
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true, DestructiveHint: boolPtr(false), OpenWorldHint: boolPtr(true)},
	}), readRequest)

	mcp.AddTool(srv, named(&mcp.Tool{
		Name:        "akamai_list_operations",
		Description: "Discover available Akamai API operations. Filter by product, method, paginatable, or text query. Returns tool names to use with akamai_raw_request.",
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true, IdempotentHint: true, DestructiveHint: boolPtr(false), OpenWorldHint: boolPtr(false)},
	}), listOperations)

	mcp.AddTool(srv, named(&mcp.Tool{
		Name:        "akamai_registry_stats",
		Description: "Coverage statistics for the embedded Akamai operation registry (totals, per-product, per-method, pagination support).",
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true, IdempotentHint: true, DestructiveHint: boolPtr(false), OpenWorldHint: boolPtr(false)},
	}), registryStats)

	mcp.AddTool(srv, named(&mcp.Tool{
		Name:        "akamai_account_overview",
		Description: "Fetch the Akamai user profile, contracts, and groups in one bounded call. The fastest way to understand account structure. For all properties/hostnames, use akamai_read_request scoped to a contract/group.",
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true, IdempotentHint: true, DestructiveHint: boolPtr(false), OpenWorldHint: boolPtr(true)},
	}), accountOverview)

	// The property family. Each of these was reachable before only by knowing
	// the catalogued operation name to hand the dispatcher, which is why a
	// model asked "what is live on staging" invented a tool name instead of
	// finding one. Descriptions carry the question each tool answers, not just
	// the endpoint it wraps, because the question is what a caller searches for.
	mcp.AddTool(srv, named(&mcp.Tool{
		Name:        "akamai_property_list",
		Description: "List Akamai CDN properties (delivery configurations) in a contract and group, with the version live on STAGING and the version live on PRODUCTION for each: every item carries stagingVersion, productionVersion, and latestVersion. contractId and groupId are both REQUIRED by Akamai's API, not by this tool; call akamai_account_overview first, which returns every contractId and groupId on the account (each group lists the contractIds it belongs to, so pair them from there). If you know the hostname instead and not the contract, skip this tool: call akamai_hostname_list(hostname) for the propertyId, then akamai_property_get(propertyId), neither of which needs a contract or group.",
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true, IdempotentHint: true, DestructiveHint: boolPtr(false), OpenWorldHint: boolPtr(true)},
	}), propertyList)

	mcp.AddTool(srv, named(&mcp.Tool{
		Name:        "akamai_property_get",
		Description: "Get one Akamai property by id, including the version live on STAGING and the version live on PRODUCTION, plus its contract and group. Needs ONLY a propertyId: contractId and groupId are optional and Akamai resolves them. Together with akamai_hostname_list this answers \"what version is live on staging versus production for this hostname\" without knowing any contract or group. Args: propertyId (required, e.g. prp_257958), contractId, groupId.",
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true, IdempotentHint: true, DestructiveHint: boolPtr(false), OpenWorldHint: boolPtr(true)},
	}), propertyGet)

	mcp.AddTool(srv, named(&mcp.Tool{
		Name:        "akamai_property_hostnames",
		Description: "List the hostnames a specific property version serves, with their edge hostnames (CNAME targets) and certificate status. Pass stagingVersion or productionVersion from akamai_property_list to see what that network is actually serving. Args: propertyId (required), propertyVersion (required), contractId, groupId.",
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true, IdempotentHint: true, DestructiveHint: boolPtr(false), OpenWorldHint: boolPtr(true)},
	}), propertyHostnames)

	mcp.AddTool(srv, named(&mcp.Tool{
		Name:        "akamai_property_rules",
		Description: "Get the rule tree (delivery behaviors: caching, origin, redirects, headers, match criteria) for one property version. This is the actual CDN configuration. Large responses are normal. Args: propertyId (required), propertyVersion (required), contractId, groupId.",
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true, IdempotentHint: true, DestructiveHint: boolPtr(false), OpenWorldHint: boolPtr(true)},
	}), propertyRules)

	mcp.AddTool(srv, named(&mcp.Tool{
		Name:        "akamai_property_activations",
		Description: "List a property's activation history: which version was pushed to STAGING or PRODUCTION, when, by whom, with what note, and whether it is still active. Use this for \"when did this last change\" and \"who activated it\". Reads the history; it cannot start an activation. Args: propertyId (required), contractId, groupId.",
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true, IdempotentHint: true, DestructiveHint: boolPtr(false), OpenWorldHint: boolPtr(true)},
	}), propertyActivations)

	// ReadOnlyHint is true despite the POST: the body is the search term and the
	// response is the matching properties. See curatedNonGETReads.
	mcp.AddTool(srv, named(&mcp.Tool{
		Name:        "akamai_property_search",
		Description: "Find which Akamai properties serve a hostname, match a property name, or point at an edge hostname. The way to answer \"which property serves www.example.com\" without knowing its contract or group. Give exactly one of: hostname, propertyName, edgeHostname.",
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true, IdempotentHint: true, DestructiveHint: boolPtr(false), OpenWorldHint: boolPtr(true)},
	}), propertySearch)

	mcp.AddTool(srv, named(&mcp.Tool{
		Name:        "akamai_hostname_list",
		Description: "List hostnames across the whole Akamai account with the property serving each one and its edge hostname. Needs NO contract or group, so this is the entry point when you know a hostname and nothing else: filter by hostname to get its propertyId, then call akamai_property_get for the staging and production versions. Distinct from akamai_property_hostnames, which reads one property version. Args: hostname, cnameTo, network (STAGING|PRODUCTION), contractId, groupId, limit, offset, paginate, maxPages.",
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true, IdempotentHint: true, DestructiveHint: boolPtr(false), OpenWorldHint: boolPtr(true)},
	}), hostnameList)

	// Security, DNS, and certificates. Same shape as the property family: one
	// pinned operation each, no operation argument.
	mcp.AddTool(srv, named(&mcp.Tool{
		Name:        "akamai_security_config_list",
		Description: "List Akamai security configurations (WAF / App and API Protector) on the account, with their production and staging version numbers. Start here for anything about WAF policy, rate controls, or bot management. Protected hostnames are counted rather than listed, since one configuration can protect hundreds; call akamai_security_config_get with includeHostnames for a specific one, or pass full=true here. Args: full.",
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true, IdempotentHint: true, DestructiveHint: boolPtr(false), OpenWorldHint: boolPtr(true)},
	}), securityConfigList)

	mcp.AddTool(srv, named(&mcp.Tool{
		Name:        "akamai_security_config_get",
		Description: "Get one Akamai security configuration by id: its versions, target hostnames, and which version is live on each network. Args: configId (required), includeHostnames.",
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true, IdempotentHint: true, DestructiveHint: boolPtr(false), OpenWorldHint: boolPtr(true)},
	}), securityConfigGet)

	mcp.AddTool(srv, named(&mcp.Tool{
		Name:        "akamai_network_list_list",
		Description: "List Akamai network lists: the IP and geography lists that WAF and property rules use to allow or block traffic. Elements are excluded by default because a single list can hold tens of thousands of addresses. Args: search, listType (IP|GEO), includeElements, extended.",
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true, IdempotentHint: true, DestructiveHint: boolPtr(false), OpenWorldHint: boolPtr(true)},
	}), networkListList)

	mcp.AddTool(srv, named(&mcp.Tool{
		Name:        "akamai_network_list_get",
		Description: "Get one Akamai network list by id, including its addresses or country codes and its deployment status on staging and production. Use this to answer \"is this IP blocked\". Args: networkListId (required), excludeElements, extended.",
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true, IdempotentHint: true, DestructiveHint: boolPtr(false), OpenWorldHint: boolPtr(true)},
	}), networkListGet)

	mcp.AddTool(srv, named(&mcp.Tool{
		Name:        "akamai_dns_zone_list",
		Description: "List Akamai Edge DNS zones on the account, with type (PRIMARY, SECONDARY, ALIAS), contract, activation state, and DNSSEC status. Args: contractIds, search, types, page, pageSize, paginate, maxPages.",
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true, IdempotentHint: true, DestructiveHint: boolPtr(false), OpenWorldHint: boolPtr(true)},
	}), dnsZoneList)

	mcp.AddTool(srv, named(&mcp.Tool{
		Name:        "akamai_dns_records",
		Description: "Read the DNS record sets in one Edge DNS zone: names, types, TTLs, and values. The way to answer \"what does this hostname resolve to in Akamai DNS\". Args: zone (required), types, search, page, pageSize, paginate, maxPages.",
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true, IdempotentHint: true, DestructiveHint: boolPtr(false), OpenWorldHint: boolPtr(true)},
	}), dnsRecords)

	mcp.AddTool(srv, named(&mcp.Tool{
		Name:        "akamai_certificate_list",
		Description: "List Akamai CPS certificate enrollments on a contract: common name, certificate type, validation type, SAN count, and auto-renewal date. To answer \"which certificate covers this hostname\", pass hostname and get the matching enrollments in full, SANs included. Summarized by default because the raw CPS payload runs past 140,000 characters on a mid-sized account; pass full=true for it. Args: contractId (required), hostname, full. Sends the versioned CPS media type the API requires.",
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true, IdempotentHint: true, DestructiveHint: boolPtr(false), OpenWorldHint: boolPtr(true)},
	}), certificateList)

	mcp.AddTool(srv, named(&mcp.Tool{
		Name:        "akamai_certificate_get",
		Description: "Get one Akamai CPS certificate enrollment by id: its CSR, SANs, TLS settings, contacts, and pending changes. Args: enrollmentId (required). Sends the versioned CPS media type the API requires.",
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true, IdempotentHint: true, DestructiveHint: boolPtr(false), OpenWorldHint: boolPtr(true)},
	}), certificateGet)

	mcp.AddTool(srv, named(&mcp.Tool{
		Name:        "akamai_traffic_report",
		Description: "Get Akamai CDN traffic report data: hits and bytes delivered from the edge, grouped by hostname, CP code, response class, or time, over a window you choose. Defaults to the CDN traffic report; other reports are reachable by naming productFamily, reportingArea, and report. The echoed query metadata is summarized so the data is not crowded out; pass full=true for it. Args: start, end, dimensions, metrics, filters, limit, full.",
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true, IdempotentHint: true, DestructiveHint: boolPtr(false), OpenWorldHint: boolPtr(true)},
	}), trafficReport)

	// Edge Diagnostics. Every one of these is a POST that asks a question about
	// traffic Akamai already served, so they are read-only in effect and
	// unreachable through akamai_read_request in practice: see
	// curatedNonGETReads and runDiagnostic.
	mcp.AddTool(srv, named(&mcp.Tool{
		Name:        "akamai_edge_curl",
		Description: "Fetch a URL from an Akamai edge server and return the raw response: status, headers, and body as the edge sees it. The way to answer \"what is the edge actually serving for this URL\" rather than what your own network sees. Args: url (required), one of edgeLocationId or edgeIp (required), ipVersion, requestHeaders.",
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true, DestructiveHint: boolPtr(false), OpenWorldHint: boolPtr(true)},
	}), edgeCurl)

	mcp.AddTool(srv, named(&mcp.Tool{
		Name:        "akamai_edge_dig",
		Description: "Run dig from an Akamai edge server to see how a hostname resolves from inside the Akamai network, which can differ from what your resolver returns. Args: hostname (required), one of edgeLocationId or edgeIp (required), queryType (default A), isGtmHostname.",
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true, DestructiveHint: boolPtr(false), OpenWorldHint: boolPtr(true)},
	}), edgeDig)

	mcp.AddTool(srv, named(&mcp.Tool{
		Name:        "akamai_edge_mtr",
		Description: "Trace the network path (MTR) from an Akamai edge server to a destination, hop by hop, with latency and packet loss. For diagnosing connectivity between the edge and an origin. Args: destination (required), destinationType, source, sourceType, packetType, port, resolveDns, showIps, showLocations.",
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true, DestructiveHint: boolPtr(false), OpenWorldHint: boolPtr(true)},
	}), edgeMtr)

	mcp.AddTool(srv, named(&mcp.Tool{
		Name:        "akamai_grep_logs",
		Description: "Search an Akamai edge server's own request logs over a time window, filtered by CP code or hostname and optionally by client IP or user agent. The way to see what the edge recorded for real traffic. Asynchronous at Akamai; this tool polls for the result within a bounded wait. Args: edgeIp, start, end (all required), one of cpCodes or hostnames (required), logType, clientIps, userAgents.",
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true, DestructiveHint: boolPtr(false), OpenWorldHint: boolPtr(true)},
	}), grepLogs)

	mcp.AddTool(srv, named(&mcp.Tool{
		Name:        "akamai_url_health_check",
		Description: "Run Akamai's composite URL health check from the edge: curl plus DNS resolution, optionally network connectivity (MTR) and edge log lines, for one URL in one call. The broadest single diagnostic for \"why is this URL failing\". Asynchronous at Akamai; this tool polls for the result within a bounded wait. Args: url (required), edgeLocationId, ipVersion, viewsAllowed (CONNECTIVITY, LOGS), requestHeaders.",
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true, DestructiveHint: boolPtr(false), OpenWorldHint: boolPtr(true)},
	}), urlHealthCheck)

	// ReadOnlyHint is true: this reaches one diagnostic endpoint that returns
	// information about a request Akamai already served, and changes no
	// configuration, content, or delivery behavior. IdempotentHint is
	// deliberately left off, because each submission creates a new translator
	// request record on Akamai's side even though the answer is the same.
	mcp.AddTool(srv, named(&mcp.Tool{
		Name:        "akamai_translate_error",
		Description: "Translate one Akamai error reference string (the code shown on an Akamai error page, e.g. 0.f2343217.1787166214.c816d2) into the diagnostic detail behind it: the URL, edge and origin IPs, HTTP status, reason for failure, property, CP code, and WAF details. Fixed Edge Diagnostics endpoint, reaches nothing else.",
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true, DestructiveHint: boolPtr(false), OpenWorldHint: boolPtr(true)},
	}), translateError)

	mcp.AddTool(srv, named(&mcp.Tool{
		Name:        "akamai-mcp_help",
		Description: "Usage help for this server and its tools, plus the list of covered Akamai products.",
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true, IdempotentHint: true, DestructiveHint: boolPtr(false), OpenWorldHint: boolPtr(false)},
	}), helpHandler)

	return names
}

func main() {
	var err error
	reg, err = loadRegistry()
	if err != nil {
		log.Fatalf("%s: %v", serverName, err)
	}
	creds, err = loadCreds(context.Background())
	if err != nil {
		// Deliberately NOT fatal. Exiting here made a missing or malformed
		// credential file a restart loop into fleetd's circuit breaker rather
		// than a legible state: the supervisor saw repeated non-zero exits and
		// eventually stopped restarting, with nothing pointing at the cause.
		// Serving /healthz with tool calls that fail loudly is more useful, and
		// it keeps the failure visible in `thesun status` rather than as a
		// degraded server with no explanation.
		log.Printf("%s: credential resolution failed, starting in unauthenticated state; "+
			"tool calls will fail until credentials resolve: %v", serverName, err)
	}

	// Resolve the write gate once, and say so out loud. Which mode the server is
	// in must be answerable from its log, not inferred from behavior.
	writesAllowed = os.Getenv("AKAMAI_ALLOW_WRITES") == "1"
	if writesAllowed {
		log.Printf("%s: AKAMAI_ALLOW_WRITES=1, mutating operations are PERMITTED "+
			"(POST, PUT, PATCH, DELETE reachable via akamai_raw_request)", serverName)
	} else {
		log.Printf("%s: read-only mode (default), mutating operations are REFUSED; "+
			"set AKAMAI_ALLOW_WRITES=1 to permit them", serverName)
	}

	validateCuratedOperations()

	srv := mcp.NewServer(&mcp.Implementation{Name: serverName, Version: version}, nil)
	registerTools(srv)

	if err := serve(context.Background(), srv); err != nil {
		log.Fatalf("%s: %v", serverName, err)
	}
}
