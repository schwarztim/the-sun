package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// isolate points every credential-resolution tier at nothing, so a test can
// never read the operator's real ~/.edgerc or ~/.hermes/client.token and can
// never reach the live Akamai API. HOME is redirected to an empty temp dir
// (which covers both dotfiles) and the explicit overrides close the rest.
func isolate(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("USERPROFILE", dir) // windows equivalent for os.UserHomeDir
	t.Setenv("AKAMAI_EDGERC", dir+"/no-such-edgerc")
	t.Setenv("AKAMAI_EDGERC_SECTION", "")
	for _, k := range []string{
		"AKAMAI_HOST", "AKAMAI_CLIENT_TOKEN", "AKAMAI_CLIENT_SECRET",
		"AKAMAI_ACCESS_TOKEN", "AKAMAI_ACCOUNT_KEY",
		"HERMES_URL", "HERMES_CLIENT_TOKEN",
	} {
		t.Setenv(k, "")
	}
	// No credential resolves, so apiCall fails before it can build a request.
	// This is what makes the write-gate tests safe to run: a permitted call
	// stops at credential resolution rather than reaching Akamai.
	credsMu.Lock()
	creds = nil
	credsMu.Unlock()
}

// loadTestRegistry initializes the package-level registry from the embedded
// catalogue, which the executor needs in order to resolve a tool name.
func loadTestRegistry(t *testing.T) {
	t.Helper()
	if reg != nil {
		return
	}
	r, err := loadRegistry()
	if err != nil {
		t.Fatalf("loadRegistry: %v", err)
	}
	reg = r
}

// resultText returns the text of a tool result's single content block. The
// per-tool helpers below wrap one call each; the named-tool tests need this for
// results they built by other routes.
func resultText(t *testing.T, res *mcp.CallToolResult) string {
	t.Helper()
	if res == nil || len(res.Content) == 0 {
		t.Fatal("tool result carried no content")
	}
	tc, ok := res.Content[0].(*mcp.TextContent)
	if !ok {
		t.Fatalf("expected text content, got %T", res.Content[0])
	}
	return tc.Text
}

// anyOpWithMethod returns the name of a real catalogued operation using the
// given method, so the tests exercise registry entries rather than fixtures.
func anyOpWithMethod(t *testing.T, method string) string {
	t.Helper()
	loadTestRegistry(t)
	names := reg.byMethod[strings.ToUpper(method)]
	if len(names) == 0 {
		t.Fatalf("no catalogued operation uses method %s", method)
	}
	return names[0]
}

// callRaw runs the executor and returns the text of its single content block.
func callRaw(t *testing.T, in RawRequestIn) (text string, isErr bool) {
	t.Helper()
	res, _, err := rawRequest(context.Background(), nil, in)
	if err != nil {
		t.Fatalf("rawRequest returned a transport error: %v", err)
	}
	if res == nil || len(res.Content) == 0 {
		t.Fatal("rawRequest returned no content")
	}
	tc, ok := res.Content[0].(*mcp.TextContent)
	if !ok {
		t.Fatalf("expected text content, got %T", res.Content[0])
	}
	return tc.Text, res.IsError
}

// --- write gate ---

// TestWriteGateDeniesMutatingMethodsByDefault is the core guarantee: an
// operator who configures nothing gets a read-only Akamai server. The catalogue
// contains 520 mutating operations including WAF-rule rewrites and security
// configuration deletion, so the default must be deny.
func TestWriteGateDeniesMutatingMethodsByDefault(t *testing.T) {
	isolate(t)
	writesAllowed = false
	t.Cleanup(func() { writesAllowed = false })

	for _, method := range []string{"POST", "PUT", "DELETE"} {
		name := anyOpWithMethod(t, method)
		text, isErr := callRaw(t, RawRequestIn{ToolName: name})
		if !isErr {
			t.Errorf("%s %s: expected an error result, got success", method, name)
		}
		if !strings.Contains(text, "writes are disabled") {
			t.Errorf("%s %s: expected a write-gate refusal, got: %s", method, name, text)
		}
		if !strings.Contains(text, "AKAMAI_ALLOW_WRITES") {
			t.Errorf("%s %s: refusal must say how to enable writes, got: %s", method, name, text)
		}
		if !strings.Contains(text, name) {
			t.Errorf("%s: refusal must name the operation, got: %s", method, text)
		}
	}
}

// TestWriteGatePermitsReadsByDefault proves the gate does not over-block: a GET
// passes it even with writes disabled. It then stops at credential resolution
// (nothing is enrolled in this isolated environment), which is exactly how we
// know it got past the gate without reaching the live API.
func TestWriteGatePermitsReadsByDefault(t *testing.T) {
	isolate(t)
	writesAllowed = false
	t.Cleanup(func() { writesAllowed = false })

	name := anyOpWithMethod(t, "GET")
	text, _ := callRaw(t, RawRequestIn{ToolName: name})
	if strings.Contains(text, "writes are disabled") {
		t.Fatalf("a GET operation was blocked by the write gate: %s", text)
	}
}

// TestWriteGatePermitsMutationsWhenEnabled proves the opt-in works: with the
// flag set, POST, PUT, and DELETE all clear the gate.
func TestWriteGatePermitsMutationsWhenEnabled(t *testing.T) {
	isolate(t)
	writesAllowed = true
	t.Cleanup(func() { writesAllowed = false })

	for _, method := range []string{"POST", "PUT", "DELETE"} {
		name := anyOpWithMethod(t, method)
		text, _ := callRaw(t, RawRequestIn{ToolName: name})
		if strings.Contains(text, "writes are disabled") {
			t.Errorf("%s %s was blocked with AKAMAI_ALLOW_WRITES enabled: %s", method, name, text)
		}
	}
}

// TestWriteGateUsesRegistryMethodNotCallerInput is the anti-spoofing check. The
// caller supplies only a tool name; the method is read from the registry entry.
// Extra caller-supplied fields (a "method" key smuggled into pathParams or
// queryParams, say) must not influence the gate.
func TestWriteGateUsesRegistryMethodNotCallerInput(t *testing.T) {
	isolate(t)
	writesAllowed = false
	t.Cleanup(func() { writesAllowed = false })

	del := anyOpWithMethod(t, "DELETE")
	op, ok := reg.get(del)
	if !ok {
		t.Fatalf("registry lost %q", del)
	}
	if strings.EqualFold(op.Method, "GET") {
		t.Fatalf("test setup error: %q is not a mutating operation", del)
	}

	// Try to talk the gate into seeing a GET. None of these are consulted.
	text, isErr := callRaw(t, RawRequestIn{
		ToolName:    del,
		PathParams:  map[string]any{"method": "GET"},
		QueryParams: map[string]any{"method": "GET", "_method": "GET"},
		Headers:     map[string]string{"X-HTTP-Method-Override": "GET"},
	})
	if !isErr || !strings.Contains(text, "writes are disabled") {
		t.Fatalf("caller-supplied method fields defeated the write gate for %s: %s", del, text)
	}

	// And the gate agrees with the registry directly.
	if isReadMethod(op.Method) {
		t.Errorf("isReadMethod(%q) said read for a DELETE operation", op.Method)
	}
}

// TestIsReadMethod pins exactly which methods count as non-mutating.
func TestIsReadMethod(t *testing.T) {
	for _, m := range []string{"GET", "get", " Get ", "HEAD", "head"} {
		if !isReadMethod(m) {
			t.Errorf("isReadMethod(%q) = false, want true", m)
		}
	}
	for _, m := range []string{"POST", "PUT", "PATCH", "DELETE", "", "OPTIONS", "TRACE"} {
		if isReadMethod(m) {
			t.Errorf("isReadMethod(%q) = true, want false", m)
		}
	}
}

// --- credential resolution ---

// hermesStub serves the broker's GET /cred/{service}/{account} contract for the
// accounts present in vals, and 404s for the rest (matching the real broker,
// which 404s an unenrolled account). Synthetic values only.
func hermesStub(t *testing.T, vals map[string]string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/cred/"), "/")
		if len(parts) != 2 || parts[0] != hermesService {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		v, ok := vals[parts[1]]
		if !ok || v == "" {
			w.WriteHeader(http.StatusNotFound)
			_ = json.NewEncoder(w).Encode(map[string]string{"code": "NOT_FOUND"})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{
			"service": parts[0], "account": parts[1], "value": v,
		})
	}))
	t.Cleanup(srv.Close)
	return srv
}

// completeStubVals returns a full synthetic account set. These are not
// credentials; they are fixed placeholder strings used only to prove assembly.
func completeStubVals() map[string]string {
	return map[string]string{
		hermesAcctHost:         "example-host.invalid",
		hermesAcctClientToken:  "synthetic-client-token",
		hermesAcctClientSecret: "synthetic-client-secret",
		hermesAcctAccessToken:  "synthetic-access-token",
	}
}

// TestHermesHitAssemblesCredential proves the four-accounts-under-one-service
// design: four separate broker reads assemble into one EdgeGrid credential.
func TestHermesHitAssemblesCredential(t *testing.T) {
	isolate(t)
	srv := hermesStub(t, completeStubVals())
	t.Setenv("HERMES_URL", srv.URL)
	t.Setenv("HERMES_CLIENT_TOKEN", "synthetic-broker-token")

	c := credsFromHermes(context.Background())
	if c == nil {
		t.Fatal("credsFromHermes returned nil for a fully enrolled service")
	}
	if !c.complete() {
		t.Fatal("assembled credential is not complete")
	}
	if c.host != "example-host.invalid" {
		t.Errorf("host was not assembled from the broker, got %q", c.host)
	}
}

// TestHermesMissFallsThrough proves an empty vault is harmless: the broker 404s
// every account and resolution yields nothing from this tier.
func TestHermesMissFallsThrough(t *testing.T) {
	isolate(t)
	srv := hermesStub(t, map[string]string{}) // nothing enrolled
	t.Setenv("HERMES_URL", srv.URL)
	t.Setenv("HERMES_CLIENT_TOKEN", "synthetic-broker-token")

	if c := credsFromHermes(context.Background()); c != nil {
		t.Fatal("credsFromHermes returned a credential from an empty vault")
	}
}

// TestHermesPartialIsTreatedAsMiss is the important one. Assembling a half
// credential would sign a request that fails as an opaque 401, which is far
// harder to diagnose than simply falling through to the next tier.
func TestHermesPartialIsTreatedAsMiss(t *testing.T) {
	isolate(t)
	for _, missing := range []string{
		hermesAcctHost, hermesAcctClientToken, hermesAcctClientSecret, hermesAcctAccessToken,
	} {
		vals := completeStubVals()
		delete(vals, missing)
		srv := hermesStub(t, vals)
		t.Setenv("HERMES_URL", srv.URL)
		t.Setenv("HERMES_CLIENT_TOKEN", "synthetic-broker-token")

		if c := credsFromHermes(context.Background()); c != nil {
			t.Errorf("a partial Hermes result missing %q assembled a credential; it must be treated as a miss", missing)
		}
	}
}

// TestHermesUnreachableIsAMiss proves a broker outage degrades to the next tier
// instead of failing the server.
func TestHermesUnreachableIsAMiss(t *testing.T) {
	isolate(t)
	t.Setenv("HERMES_URL", "http://127.0.0.1:1") // nothing listening
	t.Setenv("HERMES_CLIENT_TOKEN", "synthetic-broker-token")

	if c := credsFromHermes(context.Background()); c != nil {
		t.Fatal("an unreachable broker produced a credential")
	}
}

// TestEmptyVaultFallsThroughToEdgerc is the non-negotiable compatibility check:
// with nothing enrolled in Hermes, resolution must still land on .edgerc and
// produce exactly the credential that file describes, which is what the
// operator's live server depends on today.
func TestEmptyVaultFallsThroughToEdgerc(t *testing.T) {
	isolate(t)
	srv := hermesStub(t, map[string]string{}) // empty vault
	t.Setenv("HERMES_URL", srv.URL)
	t.Setenv("HERMES_CLIENT_TOKEN", "synthetic-broker-token")

	// A synthetic .edgerc, the shape the real file has. Values are placeholders.
	dir := t.TempDir()
	path := dir + "/edgerc"
	content := strings.Join([]string{
		"[default]",
		"host = example-host.invalid",
		"client_token = synthetic-file-client-token",
		"client_secret = synthetic-file-client-secret",
		"access_token = synthetic-file-access-token",
	}, "\n")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("AKAMAI_EDGERC", path)
	t.Setenv("AKAMAI_EDGERC_SECTION", "default")

	c, err := loadCreds(context.Background())
	if err != nil {
		t.Fatalf("resolution failed with an empty vault; the .edgerc path must still work: %v", err)
	}
	if c.clientToken != "synthetic-file-client-token" {
		t.Errorf("credential did not come from .edgerc as expected")
	}
}

// TestEnvTierPartialIsAMiss applies the same half-credential rule to env vars.
func TestEnvTierPartialIsAMiss(t *testing.T) {
	isolate(t)
	t.Setenv("AKAMAI_HOST", "example-host.invalid")
	t.Setenv("AKAMAI_CLIENT_TOKEN", "synthetic-client-token")
	// client_secret and access_token deliberately absent.

	if c := credsFromEnv(); c != nil {
		t.Fatal("a partial AKAMAI_* env set assembled a credential; it must be treated as a miss")
	}
}

// TestNilCredsProducesLegibleErrorNotPanic covers the consequence of making
// credential resolution non-fatal at startup: a tool call with no credential
// must explain what to fix, naming the resolution tiers, and must never panic
// or name a value.
func TestNilCredsProducesLegibleErrorNotPanic(t *testing.T) {
	isolate(t)

	_, err := apiCall(context.Background(), http.MethodGet, "/papi/v1/contracts", nil, nil, nil)
	if err == nil {
		t.Fatal("apiCall succeeded with no credentials resolved")
	}
	msg := err.Error()
	for _, want := range []string{"Hermes", "AKAMAI_", ".edgerc", "hermes creds set"} {
		if !strings.Contains(msg, want) {
			t.Errorf("error must mention %q so the operator knows what to fix, got: %s", want, msg)
		}
	}

	// The same path through the signer must also not panic on a nil receiver.
	var nilCreds *edgercCreds
	if _, derr := nilCreds.doSigned(httpClient, http.MethodGet, "/x", nil, nil, nil); derr == nil {
		t.Error("doSigned on nil credentials returned no error")
	}
}

// --- 429 handling ---

// TestRetryAfterDelay pins the Retry-After parsing, including the bound that
// keeps a hostile or mistaken header from stalling a call indefinitely.
func TestRetryAfterDelay(t *testing.T) {
	cases := []struct {
		header string
		wantOK bool
		want   time.Duration
	}{
		{"", false, 0},
		{"5", true, 5 * time.Second},
		{"0", true, 0},
		{"30", true, 30 * time.Second},
		{"31", false, 0},   // past the bound: surface the 429 instead of stalling
		{"3600", false, 0}, // an hour is never worth blocking a tool call
		{"-1", false, 0},   // nonsense
		{"soon", false, 0}, // unparseable
	}
	for _, c := range cases {
		got, ok := retryAfterDelay(c.header)
		if ok != c.wantOK {
			t.Errorf("retryAfterDelay(%q) ok = %v, want %v", c.header, ok, c.wantOK)
			continue
		}
		if ok && got != c.want {
			t.Errorf("retryAfterDelay(%q) = %s, want %s", c.header, got, c.want)
		}
	}

	// HTTP-date form, which Akamai may send instead of a delay in seconds.
	future := time.Now().Add(3 * time.Second).UTC().Format(http.TimeFormat)
	if _, ok := retryAfterDelay(future); !ok {
		t.Error("a near-future HTTP-date Retry-After should be honored")
	}
	past := time.Now().Add(-time.Hour).UTC().Format(http.TimeFormat)
	if d, ok := retryAfterDelay(past); !ok || d != 0 {
		t.Errorf("an elapsed HTTP-date Retry-After should retry immediately, got (%s, %v)", d, ok)
	}
	tooFar := time.Now().Add(time.Hour).UTC().Format(http.TimeFormat)
	if _, ok := retryAfterDelay(tooFar); ok {
		t.Error("a far-future HTTP-date Retry-After should not block the call")
	}
}

// TestUnknownOperationIsRejected confirms the executor still refuses a tool name
// that is not in the catalogue, which is what stops an arbitrary caller-supplied
// path from ever reaching Akamai.
func TestUnknownOperationIsRejected(t *testing.T) {
	isolate(t)
	loadTestRegistry(t)

	text, isErr := callRaw(t, RawRequestIn{ToolName: "akamai_not_a_real_operation"})
	if !isErr {
		t.Fatal("an unknown operation was accepted")
	}
	if !strings.Contains(text, "unknown operation") {
		t.Errorf("expected an unknown-operation error, got: %s", text)
	}
}

// --- akamai_translate_error ---

// callTranslate runs the error translator tool and returns the text of its
// single content block, mirroring callRaw.
func callTranslate(t *testing.T, in TranslateErrorIn) (text string, isErr bool) {
	t.Helper()
	res, _, err := translateError(context.Background(), nil, in)
	if err != nil {
		t.Fatalf("translateError returned a transport error: %v", err)
	}
	if res == nil || len(res.Content) == 0 {
		t.Fatal("translateError returned no content")
	}
	tc, ok := res.Content[0].(*mcp.TextContent)
	if !ok {
		t.Fatalf("expected text content, got %T", res.Content[0])
	}
	return tc.Text, res.IsError
}

// TestTranslateErrorEndpointsAreFixed pins the two paths this tool may reach.
// The whole point of the tool is that it is not the universal executor, so a
// change to either constant is a change to its blast radius and must be
// deliberate.
func TestTranslateErrorEndpointsAreFixed(t *testing.T) {
	if errorTranslatorPath != "/edge-diagnostics/v1/error-translator" {
		t.Errorf("submit path drifted to %q", errorTranslatorPath)
	}
	if got := errorTranslatorRequestPath(345); got != "/edge-diagnostics/v1/error-translator/requests/345" {
		t.Errorf("poll path drifted to %q", got)
	}
}

// TestTranslateErrorInputCannotSteerTheRequest is the containment guarantee: the
// input carries a reference code and a logging flag, and nothing else. A field
// naming a path, an operation, a method, or a host would let a caller aim the
// tool somewhere else, which is exactly what akamai_raw_request is classified
// PRODUCTION for.
func TestTranslateErrorInputCannotSteerTheRequest(t *testing.T) {
	allowed := map[string]bool{"ErrorCode": true, "TraceForwardLogs": true}
	ty := reflect.TypeOf(TranslateErrorIn{})
	for i := 0; i < ty.NumField(); i++ {
		if name := ty.Field(i).Name; !allowed[name] {
			t.Errorf("TranslateErrorIn gained field %q: any field beyond the reference code widens what this tool can reach", name)
		}
	}
}

// TestTranslateErrorRequiresErrorCode confirms a blank reference code is
// refused before anything is signed or sent.
func TestTranslateErrorRequiresErrorCode(t *testing.T) {
	isolate(t)

	for _, code := range []string{"", "   "} {
		text, isErr := callTranslate(t, TranslateErrorIn{ErrorCode: code})
		if !isErr {
			t.Fatalf("a blank errorCode (%q) was accepted", code)
		}
		if !strings.Contains(text, "errorCode is required") {
			t.Errorf("expected a required-field error, got: %s", text)
		}
	}

	text, isErr := callTranslate(t, TranslateErrorIn{ErrorCode: strings.Repeat("a", maxErrorCodeLen+1)})
	if !isErr {
		t.Fatal("an oversized errorCode was accepted")
	}
	if !strings.Contains(text, "over the") {
		t.Errorf("expected a length-limit error, got: %s", text)
	}
}

// TestTranslateErrorWithNoCredentialsFailsLegibly proves the tool goes through
// the shared signed-call path (so it inherits the credential lifecycle, the rate
// limiter, and the 401/429 handling) and names what is missing instead of
// panicking on a nil credential.
func TestTranslateErrorWithNoCredentialsFailsLegibly(t *testing.T) {
	isolate(t)

	text, isErr := callTranslate(t, TranslateErrorIn{ErrorCode: "0.11111111.1700000000.abcdef"})
	if !isErr {
		t.Fatal("the tool succeeded with no credentials resolved")
	}
	if !strings.Contains(text, "EdgeGrid credentials") {
		t.Errorf("expected a credential-resolution error, got: %s", text)
	}
}

// TestPollWaitIsBounded pins the polling interval: a missing or zero retryAfter
// must not become a hot loop, and an oversized one must not stall the call.
func TestPollWaitIsBounded(t *testing.T) {
	cases := []struct {
		retryAfter int
		want       time.Duration
	}{
		{0, diagMinPollWait},
		{-5, diagMinPollWait},
		{1, 1 * time.Second},
		{5, 5 * time.Second},
		{3600, diagMaxPollWait},
	}
	for _, c := range cases {
		if got := pollWait(c.retryAfter); got != c.want {
			t.Errorf("pollWait(%d) = %s, want %s", c.retryAfter, got, c.want)
		}
	}
}

// --- akamai_read_request ---

// callRead runs the read dispatcher and returns the text of its single content
// block, mirroring callRaw.
func callRead(t *testing.T, in RawRequestIn) (text string, isErr bool) {
	t.Helper()
	res, _, err := readRequest(context.Background(), nil, in)
	if err != nil {
		t.Fatalf("readRequest returned a transport error: %v", err)
	}
	if res == nil || len(res.Content) == 0 {
		t.Fatal("readRequest returned no content")
	}
	tc, ok := res.Content[0].(*mcp.TextContent)
	if !ok {
		t.Fatalf("expected text content, got %T", res.Content[0])
	}
	return tc.Text, res.IsError
}

// anyMutatingOp returns a catalogued operation with the given method that is not
// one of the named exceptions, so a refusal test cannot accidentally pick the
// error translator and prove nothing.
func anyMutatingOp(t *testing.T, method string) string {
	t.Helper()
	loadTestRegistry(t)
	for _, name := range reg.byMethod[strings.ToUpper(method)] {
		if !readOnlyExceptions[name] {
			return name
		}
	}
	t.Fatalf("no non-exception operation uses method %s", method)
	return ""
}

// TestReadGateRefusesEveryMutatingMethod is the containment guarantee for the
// read dispatcher: nothing that writes gets through, and the refusal happens
// before the request is built, which the absence of a credential error proves
// (a dispatched call in this isolated environment dies at credential
// resolution instead).
func TestReadGateRefusesEveryMutatingMethod(t *testing.T) {
	isolate(t)
	writesAllowed = true // the read gate must not depend on the write switch
	t.Cleanup(func() { writesAllowed = false })

	for _, method := range []string{"POST", "PUT", "PATCH", "DELETE", "HEAD"} {
		name := anyMutatingOp(t, method)
		text, isErr := callRead(t, RawRequestIn{ToolName: name})
		if !isErr {
			t.Errorf("%s %s: expected a refusal, got success", method, name)
			continue
		}
		if !strings.Contains(text, "GET") || !strings.Contains(text, name) {
			t.Errorf("%s %s: refusal must name the operation and the rule, got: %s", method, name, text)
		}
		if strings.Contains(text, "EdgeGrid credentials") {
			t.Errorf("%s %s: the call reached the signing path instead of being refused: %s", method, name, text)
		}
	}
}

// TestReadGatePermitsCataloguedGets proves the gate does not over-block. The
// call then stops at credential resolution, which is how we know it got past
// the gate without reaching the live API.
func TestReadGatePermitsCataloguedGets(t *testing.T) {
	isolate(t)

	name := anyOpWithMethod(t, "GET")
	text, _ := callRead(t, RawRequestIn{ToolName: name})
	if strings.Contains(text, "refusing") {
		t.Fatalf("a catalogued GET was refused by the read gate: %s", text)
	}
}

// TestReadGateAdmitsOnlyGetsAndTheNamedExceptions walks the whole catalogue and
// checks the gate's verdict against the rule, so a future registry regeneration
// cannot quietly widen what this tool reaches.
func TestReadGateAdmitsOnlyGetsAndTheNamedExceptions(t *testing.T) {
	loadTestRegistry(t)

	if len(readOnlyExceptions) != 2 {
		t.Fatalf("the exception allowlist has %d entries; it is meant to hold exactly the two error-translator operations", len(readOnlyExceptions))
	}
	for name := range readOnlyExceptions {
		op, ok := reg.get(name)
		if !ok {
			t.Errorf("allowlisted operation %q is not in the catalogue", name)
			continue
		}
		if !strings.Contains(op.Path, "/edge-diagnostics/v1/error-translator") {
			t.Errorf("allowlisted operation %q resolves to %s, which is not the error translator", name, op.Path)
		}
	}

	for name, op := range reg.ops {
		permitted := readGate(op) == nil
		want := strings.EqualFold(op.Method, "GET") || readOnlyExceptions[name]
		if permitted != want {
			t.Errorf("readGate(%s %s) permitted=%v, want %v", op.Method, name, permitted, want)
		}
	}
}

// TestReadGateFailsClosedOnUnclassifiableOperation covers a registry
// regeneration that drops a method: an operation whose class cannot be proven
// must be refused, not treated as a GET.
func TestReadGateFailsClosedOnUnclassifiableOperation(t *testing.T) {
	isolate(t)
	loadTestRegistry(t)

	const name = "akamai_test_operation_with_no_method"
	reg.ops[name] = operation{ToolName: name, Product: "test", Path: "/test/v1/thing"}
	t.Cleanup(func() { delete(reg.ops, name) })

	text, isErr := callRead(t, RawRequestIn{ToolName: name})
	if !isErr {
		t.Fatal("an operation with no catalogued method was dispatched")
	}
	if !strings.Contains(text, "no HTTP method") {
		t.Errorf("expected a fail-closed refusal, got: %s", text)
	}
}

// TestReadGateUsesRegistryMethodNotCallerInput is the anti-spoofing check for
// the read dispatcher: the method comes from the catalogue, so a caller cannot
// assert that a write is a read.
func TestReadGateUsesRegistryMethodNotCallerInput(t *testing.T) {
	isolate(t)

	del := anyMutatingOp(t, "DELETE")
	text, isErr := callRead(t, RawRequestIn{
		ToolName:    del,
		PathParams:  map[string]any{"method": "GET"},
		QueryParams: map[string]any{"method": "GET", "_method": "GET"},
		Headers:     map[string]string{"X-HTTP-Method-Override": "GET"},
	})
	if !isErr || !strings.Contains(text, "refusing") {
		t.Fatalf("caller-supplied method fields defeated the read gate for %s: %s", del, text)
	}
}

// --- curated named tools ---

// TestCuratedOperationsAreCatalogued is the drift gate for every named tool.
//
// The predecessor TypeScript server (akamai-mcp-server) shipped 23 of its 52
// tools dead on arrival: the tools named operations in camelCase while the
// spec-derived registry emitted kebab-case, so every one of them resolved to
// nothing and failed only when a user called it. Its CI printed coverage
// statistics and exited 0, so nothing caught it. This registry is regenerated
// from the same upstream OpenAPI specs, so the same drift is one regeneration
// away; this test is what turns it into a red build instead of a support
// ticket. It asserts the pairing every named tool actually depends on: the
// operation exists, and it is the operation the tool means.
func TestCuratedOperationsAreCatalogued(t *testing.T) {
	loadTestRegistry(t)

	if len(curatedOperations) == 0 {
		t.Fatal("no named tools are pinned to catalogued operations")
	}
	for tool, opName := range curatedOperations {
		op, ok := reg.get(opName)
		if !ok {
			t.Errorf("%s pins operation %q, which is not in the catalogue: the tool would fail every call", tool, opName)
			continue
		}
		if op.ToolName != opName {
			t.Errorf("%s pins %q but the catalogue returned %q", tool, opName, op.ToolName)
		}
		if strings.TrimSpace(op.Path) == "" || strings.TrimSpace(op.Method) == "" {
			t.Errorf("%s pins %q, whose catalogue entry has no method or path (%q %q)", tool, opName, op.Method, op.Path)
		}
	}
}

// TestCuratedToolsAreAllReads is the containment guarantee for the named
// surface: every one of them is classified READ in the gateway manifest, so
// none may dispatch a mutating operation. A named tool reaching a POST is
// allowed only when that operation is listed in curatedNonGETReads with a
// reason, which keeps the exceptions countable by reading one map.
func TestCuratedToolsAreAllReads(t *testing.T) {
	loadTestRegistry(t)

	for tool, opName := range curatedOperations {
		op, ok := reg.get(opName)
		if !ok {
			continue // reported by TestCuratedOperationsAreCatalogued
		}
		method := strings.ToUpper(op.Method)
		if method == "GET" {
			continue
		}
		if !curatedNonGETReads[opName] {
			t.Errorf("%s dispatches %s %s but %q is not declared in curatedNonGETReads", tool, method, op.Path, opName)
		}
		if method == "PUT" || method == "PATCH" || method == "DELETE" {
			t.Errorf("%s dispatches %s %s: a named read tool may never reach that method, whatever the allowlist says", tool, method, op.Path)
		}
	}
	for opName := range curatedNonGETReads {
		op, ok := reg.get(opName)
		if !ok {
			t.Errorf("curatedNonGETReads names %q, which is not in the catalogue", opName)
			continue
		}
		if strings.EqualFold(op.Method, "GET") {
			t.Errorf("curatedNonGETReads names %q, which is a GET and needs no exception", opName)
		}
	}
}

// TestCuratedNonGETReadsStayNarrow keeps the exception list from becoming the
// rule. It is meant to hold the handful of Akamai POSTs that are genuinely
// reads (a search body, a report query, an Edge Diagnostics submission); if it
// grows past that, the growth should be a deliberate, reviewed change rather
// than something that happened one tool at a time.
func TestCuratedNonGETReadsStayNarrow(t *testing.T) {
	const cap = 8
	if len(curatedNonGETReads) > cap {
		t.Fatalf("curatedNonGETReads holds %d entries, over the %d the named surface is meant to need; every entry must be a POST that returns data and changes nothing", len(curatedNonGETReads), cap)
	}
}

// TestCuratedOpRefusesAMethodChange proves the runtime half of the drift
// defense: if a regeneration turned a named tool's operation into a write, the
// tool refuses rather than executing it. The test mutates the in-memory
// catalogue, which is exactly what a bad regeneration would do to the embedded
// one.
func TestCuratedOpRefusesAMethodChange(t *testing.T) {
	isolate(t)
	loadTestRegistry(t)

	const tool = "akamai_property_list"
	opName := curatedOperations[tool]
	original, ok := reg.get(opName)
	if !ok {
		t.Fatalf("%s is not catalogued", opName)
	}
	mutated := original
	mutated.Method = "DELETE"
	reg.ops[opName] = mutated
	t.Cleanup(func() { reg.ops[opName] = original })

	_, refusal := curatedOp(tool)
	if refusal == nil {
		t.Fatal("a named tool kept dispatching after its operation became a DELETE")
	}
	if !refusal.IsError {
		t.Error("the refusal was not returned as an error result")
	}
}

// TestCuratedOpRefusesAMissingOperation covers the other drift shape: the
// operation is renamed or dropped. The refusal has to say which tool and which
// operation, because that is the whole diagnosis.
func TestCuratedOpRefusesAMissingOperation(t *testing.T) {
	isolate(t)
	loadTestRegistry(t)

	const tool = "akamai_property_get"
	opName := curatedOperations[tool]
	original, ok := reg.get(opName)
	if !ok {
		t.Fatalf("%s is not catalogued", opName)
	}
	delete(reg.ops, opName)
	t.Cleanup(func() { reg.ops[opName] = original })

	_, refusal := curatedOp(tool)
	if refusal == nil {
		t.Fatal("a named tool kept dispatching after its operation left the catalogue")
	}
	text := resultText(t, refusal)
	if !strings.Contains(text, tool) || !strings.Contains(text, opName) {
		t.Errorf("the refusal must name the tool and the missing operation, got: %s", text)
	}
}

// TestCuratedToolsIgnoreCallerSuppliedOperation is the anti-steering check for
// the named surface. A named tool takes no operation argument at all, so the
// only way to test the guarantee is at the layer beneath: callCurated must
// overwrite whatever toolName it is handed with the pinned constant.
func TestCuratedToolsIgnoreCallerSuppliedOperation(t *testing.T) {
	isolate(t)
	loadTestRegistry(t)

	activation := anyMutatingOp(t, "POST")
	res := callCurated(context.Background(), "akamai_property_list", RawRequestIn{
		ToolName:    activation,
		QueryParams: map[string]any{"contractId": "ctr_TEST", "groupId": "grp_TEST"},
	})
	text := resultText(t, res)
	if strings.Contains(text, activation) {
		t.Fatalf("a caller-supplied toolName reached the dispatcher: %s", text)
	}
	// With no credential resolvable, a call that got past the pin dies at
	// credential resolution. That is how we know it dispatched the pinned
	// operation rather than the caller's.
	if !strings.Contains(text, "EdgeGrid credentials") {
		t.Errorf("expected the pinned operation to reach credential resolution, got: %s", text)
	}
}

// TestPropertySearchRequiresExactlyOneTerm covers the one named tool whose
// arguments are mutually exclusive: PAPI's search endpoint matches on a single
// key, so a call with none or several has to be refused rather than guessed at.
func TestPropertySearchRequiresExactlyOneTerm(t *testing.T) {
	isolate(t)
	loadTestRegistry(t)

	for _, in := range []PropertySearchIn{
		{},
		{Hostname: "www.example.com", PropertyName: "www.example.com_pm"},
		{Hostname: "www.example.com", EdgeHostname: "www.example.com.edgesuite.net"},
	} {
		res, _, err := propertySearch(context.Background(), nil, in)
		if err != nil {
			t.Fatalf("propertySearch returned a transport error: %v", err)
		}
		if !res.IsError {
			t.Errorf("%+v was accepted; exactly one search term is required", in)
		}
	}

	res, _, err := propertySearch(context.Background(), nil, PropertySearchIn{Hostname: "www.example.com"})
	if err != nil {
		t.Fatalf("propertySearch returned a transport error: %v", err)
	}
	if text := resultText(t, res); !strings.Contains(text, "EdgeGrid credentials") {
		t.Errorf("a single search term should have dispatched and stopped at credential resolution, got: %s", text)
	}
}

// TestNamedToolsOmitUnsetArguments guards the map builders every named tool uses.
// An empty string written into a path map would substitute an empty segment and
// silently address the collection instead of the item, which is a wrong answer
// rather than an error.
func TestNamedToolsOmitUnsetArguments(t *testing.T) {
	m := map[string]any{}
	setIf(m, "kept", "value")
	setIf(m, "empty", "")
	setIf(m, "blank", "   ")
	setIfPositive(m, "positive", 3)
	setIfPositive(m, "zero", 0)
	setIfPositive(m, "negative", -1)

	want := map[string]any{"kept": "value", "positive": 3}
	if !reflect.DeepEqual(m, want) {
		t.Errorf("got %v, want %v", m, want)
	}
}

// TestPropertyVersionToolsRefuseAnIncompleteAddress proves the consequence: a
// missing propertyId or version fails loudly at path substitution instead of
// requesting a URL with a hole in it.
func TestPropertyVersionToolsRefuseAnIncompleteAddress(t *testing.T) {
	isolate(t)
	loadTestRegistry(t)

	for _, in := range []PropertyVersionIn{
		{PropertyVersion: 7},
		{PropertyID: "prp_257958"},
	} {
		res, _, err := propertyHostnames(context.Background(), nil, in)
		if err != nil {
			t.Fatalf("propertyHostnames returned a transport error: %v", err)
		}
		if !res.IsError {
			t.Errorf("%+v was dispatched with an incomplete path", in)
			continue
		}
		if text := resultText(t, res); !strings.Contains(text, "path parameter not provided") {
			t.Errorf("expected a path-substitution refusal, got: %s", text)
		}
	}
}

// TestEveryNamedToolIsRegistered closes the last gap between the map and the
// server: an operation can be pinned correctly and still be unreachable if
// nobody called mcp.AddTool for it. This walks the server's own tool list.
func TestEveryNamedToolIsRegistered(t *testing.T) {
	loadTestRegistry(t)

	srv := mcp.NewServer(&mcp.Implementation{Name: serverName, Version: version}, nil)

	registered := map[string]bool{}
	for _, name := range registerTools(srv) {
		if registered[name] {
			t.Errorf("%s is registered twice; the second registration silently replaces the first", name)
		}
		registered[name] = true
	}
	for tool := range curatedOperations {
		if !registered[tool] {
			t.Errorf("%s pins a catalogued operation but is never registered, so no caller can reach it", tool)
		}
	}
}

// --- outgoing-request proof for the named tools ---

// capturedRequest is what the local stub saw. Every named tool is fired at that
// stub so the test can assert on the request that actually left the process,
// rather than on the arguments that went in.
type capturedRequest struct {
	Method string
	Path   string
	Query  url.Values
	Header http.Header
	Body   []byte
	Calls  int
}

// akamaiStub points the signed-call path at a local TLS test server and returns
// the record of what it received. Nothing leaves the machine and nothing real is
// used: isolate() first closes every route to the operator's own credentials,
// then synthetic AKAMAI_* values are installed so the EdgeGrid signature is
// computed over the stub's URL. The handler may be nil for a bare 200.
func akamaiStub(t *testing.T, handler http.HandlerFunc) *capturedRequest {
	t.Helper()
	isolate(t)

	captured := &capturedRequest{}
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		captured.Calls++
		captured.Method = r.Method
		captured.Path = r.URL.Path
		captured.Query = r.URL.Query()
		captured.Header = r.Header.Clone()
		captured.Body, _ = io.ReadAll(r.Body)
		if handler != nil {
			handler(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"items":[]}`))
	}))
	t.Cleanup(srv.Close)

	// Copy the production client and replace ONLY its transport, so the stub is
	// reachable over TLS while every policy the real client carries (redirect
	// handling, timeout) still applies. Swapping in httptest's own client
	// instead would silently drop those policies: doing exactly that made the
	// first version of the redirect test reproduce the bug it was written to
	// prove fixed, because httptest's client follows redirects.
	prev := httpClient
	testClient := *prev
	testClient.Transport = srv.Client().Transport
	httpClient = &testClient
	t.Cleanup(func() { httpClient = prev })

	t.Setenv("AKAMAI_HOST", strings.TrimPrefix(srv.URL, "https://"))
	t.Setenv("AKAMAI_CLIENT_TOKEN", "synthetic-client-token")
	t.Setenv("AKAMAI_CLIENT_SECRET", "synthetic-client-secret")
	t.Setenv("AKAMAI_ACCESS_TOKEN", "synthetic-access-token")
	credsMu.Lock()
	creds = nil
	credsMu.Unlock()
	if resolveCreds(context.Background()) == nil {
		t.Fatal("the synthetic AKAMAI_* credentials did not resolve, so no request would be signed")
	}
	return captured
}

// pathMatcher turns a catalogued path template into a regexp that accepts any
// single segment in place of each {token}, so a test can prove a tool hit its
// pinned endpoint without hard-coding the ids it was called with.
func pathMatcher(t *testing.T, template string) *regexp.Regexp {
	t.Helper()
	var b strings.Builder
	b.WriteString("^")
	for _, part := range regexp.MustCompile(`\{[^}]+\}`).Split(template, -1) {
		b.WriteString(regexp.QuoteMeta(part))
		b.WriteString(`[^/]*`)
	}
	// Split leaves a trailing empty part only when the template ends in a
	// token; the extra matcher is harmless either way because it can match
	// nothing. Anchor the end so a longer path cannot pass.
	pattern := strings.TrimSuffix(b.String(), `[^/]*`) + `[^/]*$`
	return regexp.MustCompile(pattern)
}

// namedToolCall is one named tool plus a minimal, valid invocation of it.
type namedToolCall struct {
	tool string
	call func(context.Context) (*mcp.CallToolResult, any, error)
}

// namedToolCalls covers every tool in curatedOperations. A tool added to that
// map without an entry here fails TestEveryNamedToolReachesItsPinnedEndpoint,
// which is deliberate: the whole point of these tests is that no named tool
// ships without its outgoing request having been looked at once.
func namedToolCalls() []namedToolCall {
	ctxCall := func(f func(context.Context) (*mcp.CallToolResult, any, error)) func(context.Context) (*mcp.CallToolResult, any, error) {
		return f
	}
	return []namedToolCall{
		{"akamai_property_list", ctxCall(func(ctx context.Context) (*mcp.CallToolResult, any, error) {
			return propertyList(ctx, nil, PropertyListIn{ContractID: "ctr_TEST", GroupID: "grp_TEST"})
		})},
		{"akamai_property_get", ctxCall(func(ctx context.Context) (*mcp.CallToolResult, any, error) {
			return propertyGet(ctx, nil, PropertyGetIn{PropertyID: "prp_1"})
		})},
		{"akamai_property_hostnames", ctxCall(func(ctx context.Context) (*mcp.CallToolResult, any, error) {
			return propertyHostnames(ctx, nil, PropertyVersionIn{PropertyID: "prp_1", PropertyVersion: 3})
		})},
		{"akamai_property_rules", ctxCall(func(ctx context.Context) (*mcp.CallToolResult, any, error) {
			return propertyRules(ctx, nil, PropertyVersionIn{PropertyID: "prp_1", PropertyVersion: 3})
		})},
		{"akamai_property_activations", ctxCall(func(ctx context.Context) (*mcp.CallToolResult, any, error) {
			return propertyActivations(ctx, nil, PropertyActivationsIn{PropertyID: "prp_1"})
		})},
		{"akamai_property_search", ctxCall(func(ctx context.Context) (*mcp.CallToolResult, any, error) {
			return propertySearch(ctx, nil, PropertySearchIn{Hostname: "www.example.com"})
		})},
		{"akamai_hostname_list", ctxCall(func(ctx context.Context) (*mcp.CallToolResult, any, error) {
			return hostnameList(ctx, nil, HostnameListIn{Hostname: "www.example.com"})
		})},
		{"akamai_security_config_list", ctxCall(func(ctx context.Context) (*mcp.CallToolResult, any, error) {
			return securityConfigList(ctx, nil, SecurityConfigListIn{})
		})},
		{"akamai_security_config_get", ctxCall(func(ctx context.Context) (*mcp.CallToolResult, any, error) {
			return securityConfigGet(ctx, nil, SecurityConfigGetIn{ConfigID: 42})
		})},
		{"akamai_network_list_list", ctxCall(func(ctx context.Context) (*mcp.CallToolResult, any, error) {
			return networkListList(ctx, nil, NetworkListListIn{})
		})},
		{"akamai_network_list_get", ctxCall(func(ctx context.Context) (*mcp.CallToolResult, any, error) {
			return networkListGet(ctx, nil, NetworkListGetIn{NetworkListID: "1_TEST"})
		})},
		{"akamai_dns_zone_list", ctxCall(func(ctx context.Context) (*mcp.CallToolResult, any, error) {
			return dnsZoneList(ctx, nil, DNSZoneListIn{})
		})},
		{"akamai_dns_records", ctxCall(func(ctx context.Context) (*mcp.CallToolResult, any, error) {
			return dnsRecords(ctx, nil, DNSRecordsIn{Zone: "example.com"})
		})},
		{"akamai_certificate_list", ctxCall(func(ctx context.Context) (*mcp.CallToolResult, any, error) {
			return certificateList(ctx, nil, CertificateListIn{ContractID: "ctr_TEST"})
		})},
		{"akamai_certificate_get", ctxCall(func(ctx context.Context) (*mcp.CallToolResult, any, error) {
			return certificateGet(ctx, nil, CertificateGetIn{EnrollmentID: 19243})
		})},
		{"akamai_traffic_report", ctxCall(func(ctx context.Context) (*mcp.CallToolResult, any, error) {
			return trafficReport(ctx, nil, TrafficReportIn{})
		})},
		{"akamai_edge_curl", ctxCall(func(ctx context.Context) (*mcp.CallToolResult, any, error) {
			return edgeCurl(ctx, nil, EdgeCurlIn{URL: "https://www.example.com/", EdgeLocationID: "EDGE1"})
		})},
		{"akamai_edge_dig", ctxCall(func(ctx context.Context) (*mcp.CallToolResult, any, error) {
			return edgeDig(ctx, nil, EdgeDigIn{Hostname: "www.example.com", EdgeIP: "192.0.2.1"})
		})},
		{"akamai_edge_mtr", ctxCall(func(ctx context.Context) (*mcp.CallToolResult, any, error) {
			return edgeMtr(ctx, nil, EdgeMtrIn{Destination: "www.example.com"})
		})},
		{"akamai_grep_logs", ctxCall(func(ctx context.Context) (*mcp.CallToolResult, any, error) {
			return grepLogs(ctx, nil, GrepLogsIn{
				EdgeIP: "192.0.2.1", Start: "2026-08-19T12:00:00Z", End: "2026-08-19T13:00:00Z",
				Hostnames: []string{"www.example.com"},
			})
		})},
		{"akamai_url_health_check", ctxCall(func(ctx context.Context) (*mcp.CallToolResult, any, error) {
			return urlHealthCheck(ctx, nil, URLHealthCheckIn{URL: "https://www.example.com/"})
		})},
	}
}

// TestEveryNamedToolReachesItsPinnedEndpoint is the strongest form of the
// dead-on-arrival check. TestCuratedOperationsAreCatalogued proves the pinned
// operation exists; this proves the tool actually reaches it, by firing every
// named tool at a local stub and comparing the request that left the process
// against the catalogue entry it claims to dispatch. A tool wired to the wrong
// operation, or one whose arguments never reach the path, fails here rather
// than in front of a user.
func TestEveryNamedToolReachesItsPinnedEndpoint(t *testing.T) {
	loadTestRegistry(t)

	covered := map[string]bool{}
	for _, tc := range namedToolCalls() {
		tc := tc
		t.Run(tc.tool, func(t *testing.T) {
			covered[tc.tool] = true
			opName, ok := curatedOperations[tc.tool]
			if !ok {
				t.Fatalf("%s is exercised here but pins no operation", tc.tool)
			}
			op, ok := reg.get(opName)
			if !ok {
				t.Fatalf("%s pins %q, which is not catalogued", tc.tool, opName)
			}

			captured := akamaiStub(t, nil)
			res, _, err := tc.call(context.Background())
			if err != nil {
				t.Fatalf("%s returned a transport error: %v", tc.tool, err)
			}
			if res.IsError {
				t.Fatalf("%s failed against the stub: %s", tc.tool, resultText(t, res))
			}
			if captured.Calls == 0 {
				t.Fatalf("%s issued no request at all", tc.tool)
			}
			if !strings.EqualFold(captured.Method, op.Method) {
				t.Errorf("%s sent %s, but its pinned operation is %s", tc.tool, captured.Method, op.Method)
			}
			if strings.Contains(captured.Path, "{") {
				t.Errorf("%s sent an unsubstituted path template: %s", tc.tool, captured.Path)
			}
			if m := pathMatcher(t, op.Path); !m.MatchString(captured.Path) {
				t.Errorf("%s sent %s, which does not match its pinned path %s", tc.tool, captured.Path, op.Path)
			}
		})
	}

	for tool := range curatedOperations {
		if !covered[tool] {
			t.Errorf("%s is a named tool but no case in namedToolCalls exercises its outgoing request", tool)
		}
	}
}

// TestCertificateToolsSendTheVersionedCPSMediaType covers a failure mode no
// caller could recover from on their own: CPS answers 406 Not Acceptable unless
// the request names a specific versioned media type, and the collection and the
// item use different ones. Pinning them is most of why these two tools exist
// rather than leaving CPS to akamai_read_request.
func TestCertificateToolsSendTheVersionedCPSMediaType(t *testing.T) {
	loadTestRegistry(t)

	t.Run("list", func(t *testing.T) {
		captured := akamaiStub(t, nil)
		if _, _, err := certificateList(context.Background(), nil, CertificateListIn{ContractID: "ctr_TEST"}); err != nil {
			t.Fatalf("certificateList: %v", err)
		}
		if got := captured.Header.Get("Accept"); got != cpsEnrollmentsAccept {
			t.Errorf("Accept was %q, want the versioned collection type %q", got, cpsEnrollmentsAccept)
		}
	})

	t.Run("get", func(t *testing.T) {
		captured := akamaiStub(t, nil)
		if _, _, err := certificateGet(context.Background(), nil, CertificateGetIn{EnrollmentID: 19243}); err != nil {
			t.Fatalf("certificateGet: %v", err)
		}
		if got := captured.Header.Get("Accept"); got != cpsEnrollmentAccept {
			t.Errorf("Accept was %q, want the versioned item type %q", got, cpsEnrollmentAccept)
		}
	})

	for name, media := range map[string]string{"collection": cpsEnrollmentsAccept, "item": cpsEnrollmentAccept} {
		if !strings.HasPrefix(media, "application/vnd.akamai.cps.") || !strings.HasSuffix(media, "+json") {
			t.Errorf("the CPS %s media type %q is not a versioned CPS type", name, media)
		}
	}
}

// TestCertificateListStripsTheContractPrefix covers the one place where Akamai
// disagrees with itself about a format. Every other product here returns and
// accepts ctr_3-HINVO; CPS answers that form with "400 Invalid Contract ... does
// not belong to ACG list", which reads like a permissions problem and sends the
// caller hunting for the wrong thing.
func TestCertificateListStripsTheContractPrefix(t *testing.T) {
	loadTestRegistry(t)

	captured := akamaiStub(t, nil)
	if _, _, err := certificateList(context.Background(), nil, CertificateListIn{ContractID: "ctr_3-TEST"}); err != nil {
		t.Fatalf("certificateList: %v", err)
	}
	if got := captured.Query.Get("contractId"); got != "3-TEST" {
		t.Errorf("contractId went out as %q, want the bare form %q", got, "3-TEST")
	}

	if got := cpsContractID("  3-TEST  "); got != "3-TEST" {
		t.Errorf("cpsContractID(%q) = %q, want %q", "  3-TEST  ", got, "3-TEST")
	}
}

// TestNetworkListElementDefaults pins the two deliberate default choices in the
// network-list tools, because they differ from each other on purpose: listing
// every list should not inline tens of thousands of addresses, while asking for
// one list by id is asking what is in it.
func TestNetworkListElementDefaults(t *testing.T) {
	loadTestRegistry(t)

	t.Run("listing excludes elements", func(t *testing.T) {
		captured := akamaiStub(t, nil)
		if _, _, err := networkListList(context.Background(), nil, NetworkListListIn{}); err != nil {
			t.Fatalf("networkListList: %v", err)
		}
		if got := captured.Query.Get("includeElements"); got != "false" {
			t.Errorf("includeElements was %q, want false by default", got)
		}
	})

	t.Run("get includes elements", func(t *testing.T) {
		captured := akamaiStub(t, nil)
		if _, _, err := networkListGet(context.Background(), nil, NetworkListGetIn{NetworkListID: "1_TEST"}); err != nil {
			t.Fatalf("networkListGet: %v", err)
		}
		if got := captured.Query.Get("includeElements"); got != "true" {
			t.Errorf("includeElements was %q, want true by default", got)
		}
	})
}

// TestPropertySearchSendsTheTermInTheBody proves the shape of the one named
// POST that is a read: the search term travels as a body field, and nothing the
// caller sends becomes part of the path or the method.
func TestPropertySearchSendsTheTermInTheBody(t *testing.T) {
	loadTestRegistry(t)

	captured := akamaiStub(t, nil)
	if _, _, err := propertySearch(context.Background(), nil, PropertySearchIn{Hostname: "www.example.com"}); err != nil {
		t.Fatalf("propertySearch: %v", err)
	}
	var body map[string]any
	if err := json.Unmarshal(captured.Body, &body); err != nil {
		t.Fatalf("the search body was not JSON: %v", err)
	}
	if body["hostname"] != "www.example.com" || len(body) != 1 {
		t.Errorf("body was %v, want exactly one key, hostname", body)
	}
	if captured.Path != "/papi/v1/search/find-by-value" {
		t.Errorf("path was %q, want the pinned search endpoint", captured.Path)
	}
}

// --- Edge Diagnostics async behavior ---

// TestGrepLogsPollsForTheAsyncResult covers the reason these tools exist as
// tools rather than as dispatcher calls. Akamai answers grep with 202 and a
// requestId, and an MCP caller cannot sleep between tool calls, so if the
// polling did not happen inside the call the endpoint would be unreachable in
// practice however it was dispatched.
func TestGrepLogsPollsForTheAsyncResult(t *testing.T) {
	loadTestRegistry(t)

	var paths []string
	captured := akamaiStub(t, func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.Method+" "+r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodPost {
			w.WriteHeader(http.StatusAccepted)
			_, _ = w.Write([]byte(`{"executionStatus":"IN_PROGRESS","requestId":4242,"retryAfter":1,` +
				`"link":"/edge-diagnostics/v1/somewhere-else/9999"}`))
			return
		}
		_, _ = w.Write([]byte(`{"executionStatus":"SUCCESS","requestId":4242,"logLinesCount":3}`))
	})

	res, _, err := grepLogs(context.Background(), nil, GrepLogsIn{
		EdgeIP: "192.0.2.1", Start: "2026-08-19T12:00:00Z", End: "2026-08-19T13:00:00Z",
		Hostnames: []string{"www.example.com"},
	})
	if err != nil {
		t.Fatalf("grepLogs: %v", err)
	}
	if res.IsError {
		t.Fatalf("grepLogs failed against the stub: %s", resultText(t, res))
	}
	if captured.Calls < 2 {
		t.Fatalf("grepLogs made %d request(s); an IN_PROGRESS answer must be polled", captured.Calls)
	}
	if want := "GET /edge-diagnostics/v1/grep/requests/4242"; paths[1] != want {
		t.Errorf("polled %q, want %q built from the requestId", paths[1], want)
	}
	// The poll path is built from Akamai's own integer requestId, never from
	// the link in the response body. Following a path out of a response would
	// reopen exactly the steering problem these named tools exist to close.
	for _, p := range paths {
		if strings.Contains(p, "somewhere-else") {
			t.Errorf("a path from the response body was followed: %s", p)
		}
	}
	if text := resultText(t, res); !strings.Contains(text, "SUCCESS") {
		t.Errorf("the finished result was not returned: %s", text)
	}
}

// TestSynchronousDiagnosticsDoNotPoll pins the other half of that split. curl,
// dig, and mtr answer 200 with the result inline and have no poll endpoint in
// the catalogue at all, so a poll would be a request to a URL that does not
// exist.
func TestSynchronousDiagnosticsDoNotPoll(t *testing.T) {
	loadTestRegistry(t)

	for _, tc := range []struct {
		name string
		call func(context.Context) (*mcp.CallToolResult, any, error)
	}{
		{"curl", func(ctx context.Context) (*mcp.CallToolResult, any, error) {
			return edgeCurl(ctx, nil, EdgeCurlIn{URL: "https://www.example.com/", EdgeIP: "192.0.2.1"})
		}},
		{"dig", func(ctx context.Context) (*mcp.CallToolResult, any, error) {
			return edgeDig(ctx, nil, EdgeDigIn{Hostname: "www.example.com", EdgeIP: "192.0.2.1"})
		}},
		{"mtr", func(ctx context.Context) (*mcp.CallToolResult, any, error) {
			return edgeMtr(ctx, nil, EdgeMtrIn{Destination: "www.example.com"})
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			captured := akamaiStub(t, func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"executionStatus":"IN_PROGRESS","requestId":77,"retryAfter":1}`))
			})
			if _, _, err := tc.call(context.Background()); err != nil {
				t.Fatalf("%s: %v", tc.name, err)
			}
			if captured.Calls != 1 {
				t.Errorf("%s made %d requests; it has no poll endpoint and must issue exactly one", tc.name, captured.Calls)
			}
		})
	}
}

// TestEdgeDiagnosticsRequireTheirMandatoryFields keeps the tools from spending a
// round trip to learn what they could have said locally. Every field asserted
// here is required by the upstream OpenAPI schema for that endpoint.
func TestEdgeDiagnosticsRequireTheirMandatoryFields(t *testing.T) {
	isolate(t)
	loadTestRegistry(t)

	cases := []struct {
		name string
		call func(context.Context) (*mcp.CallToolResult, any, error)
	}{
		{"curl without url", func(ctx context.Context) (*mcp.CallToolResult, any, error) {
			return edgeCurl(ctx, nil, EdgeCurlIn{EdgeIP: "192.0.2.1"})
		}},
		{"curl without an edge target", func(ctx context.Context) (*mcp.CallToolResult, any, error) {
			return edgeCurl(ctx, nil, EdgeCurlIn{URL: "https://www.example.com/"})
		}},
		{"curl with both edge targets", func(ctx context.Context) (*mcp.CallToolResult, any, error) {
			return edgeCurl(ctx, nil, EdgeCurlIn{URL: "https://www.example.com/", EdgeIP: "192.0.2.1", EdgeLocationID: "EDGE1"})
		}},
		{"dig without hostname", func(ctx context.Context) (*mcp.CallToolResult, any, error) {
			return edgeDig(ctx, nil, EdgeDigIn{EdgeIP: "192.0.2.1"})
		}},
		{"mtr without destination", func(ctx context.Context) (*mcp.CallToolResult, any, error) {
			return edgeMtr(ctx, nil, EdgeMtrIn{})
		}},
		{"grep without a window", func(ctx context.Context) (*mcp.CallToolResult, any, error) {
			return grepLogs(ctx, nil, GrepLogsIn{EdgeIP: "192.0.2.1", Hostnames: []string{"www.example.com"}})
		}},
		{"grep without a scope", func(ctx context.Context) (*mcp.CallToolResult, any, error) {
			return grepLogs(ctx, nil, GrepLogsIn{EdgeIP: "192.0.2.1", Start: "2026-08-19T12:00:00Z", End: "2026-08-19T13:00:00Z"})
		}},
		{"health check without url", func(ctx context.Context) (*mcp.CallToolResult, any, error) {
			return urlHealthCheck(ctx, nil, URLHealthCheckIn{})
		}},
	}

	for _, tc := range cases {
		res, _, err := tc.call(context.Background())
		if err != nil {
			t.Fatalf("%s returned a transport error: %v", tc.name, err)
		}
		if !res.IsError {
			t.Errorf("%s was accepted", tc.name)
			continue
		}
		if text := resultText(t, res); strings.Contains(text, "EdgeGrid credentials") {
			t.Errorf("%s reached the signing path instead of being refused locally: %s", tc.name, text)
		}
	}
}

// TestEdgeMtrSendsEveryRequiredFlag covers the six fields the MTR schema marks
// required, three of which are booleans. Go cannot distinguish an unset bool
// from a false one, so these default to true through *bool: a trace that
// resolves nothing and shows nothing is not the trace anyone asked for, and a
// caller who wants that can still say so.
func TestEdgeMtrSendsEveryRequiredFlag(t *testing.T) {
	loadTestRegistry(t)

	t.Run("defaults", func(t *testing.T) {
		captured := akamaiStub(t, nil)
		if _, _, err := edgeMtr(context.Background(), nil, EdgeMtrIn{Destination: "www.example.com"}); err != nil {
			t.Fatalf("edgeMtr: %v", err)
		}
		var body map[string]any
		if err := json.Unmarshal(captured.Body, &body); err != nil {
			t.Fatalf("body was not JSON: %v", err)
		}
		for _, k := range []string{"destination", "destinationType", "packetType", "resolveDns", "showIps", "showLocations"} {
			if _, ok := body[k]; !ok {
				t.Errorf("required field %q was not sent", k)
			}
		}
		for _, k := range []string{"resolveDns", "showIps", "showLocations"} {
			if body[k] != true {
				t.Errorf("%s defaulted to %v, want true", k, body[k])
			}
		}
	})

	t.Run("caller can turn one off", func(t *testing.T) {
		captured := akamaiStub(t, nil)
		off := false
		if _, _, err := edgeMtr(context.Background(), nil, EdgeMtrIn{Destination: "www.example.com", ShowLocations: &off}); err != nil {
			t.Fatalf("edgeMtr: %v", err)
		}
		var body map[string]any
		if err := json.Unmarshal(captured.Body, &body); err != nil {
			t.Fatalf("body was not JSON: %v", err)
		}
		if body["showLocations"] != false {
			t.Errorf("showLocations was %v, want false when the caller asked for false", body["showLocations"])
		}
		if body["showIps"] != true {
			t.Errorf("showIps was %v; turning one flag off must not change the others", body["showIps"])
		}
	})
}

// TestTrafficReportDefaultsToTheCDNTrafficReport pins the three-part report
// address, since "traffic report" has to mean something concrete for the tool
// to be callable without the caller first learning the reporting taxonomy.
func TestTrafficReportDefaultsToTheCDNTrafficReport(t *testing.T) {
	loadTestRegistry(t)

	captured := akamaiStub(t, nil)
	if _, _, err := trafficReport(context.Background(), nil, TrafficReportIn{}); err != nil {
		t.Fatalf("trafficReport: %v", err)
	}
	if want := "/reporting-api/v2/reports/delivery/traffic/current/data"; captured.Path != want {
		t.Errorf("path was %q, want %q", captured.Path, want)
	}
	if captured.Method != http.MethodPost {
		t.Errorf("method was %s, want POST", captured.Method)
	}
	if len(captured.Body) == 0 {
		t.Error("no body was sent; the endpoint is a POST and expects JSON")
	}

	other := akamaiStub(t, nil)
	if _, _, err := trafficReport(context.Background(), nil, TrafficReportIn{
		ProductFamily: "common", ReportingArea: "apis", Report: "usage",
	}); err != nil {
		t.Fatalf("trafficReport: %v", err)
	}
	if want := "/reporting-api/v2/reports/common/apis/usage/data"; other.Path != want {
		t.Errorf("path was %q, want %q when the caller names another report", other.Path, want)
	}
}

// TestNamedToolsIgnoreTheWriteSwitch matters because the server can be running
// with AKAMAI_ALLOW_WRITES=1, which is what akamai_raw_request's gate consults.
// The named surface must not widen with it: curatedOp decides from the
// catalogued method and the declared non-GET reads, and consults nothing else.
// Without this, "every named tool is a read" would hold only in the default
// configuration rather than in every configuration.
func TestNamedToolsIgnoreTheWriteSwitch(t *testing.T) {
	loadTestRegistry(t)
	writesAllowed = true
	t.Cleanup(func() { writesAllowed = false })

	for tool, opName := range curatedOperations {
		op, ok := reg.get(opName)
		if !ok {
			continue // reported by TestCuratedOperationsAreCatalogued
		}
		mutated := op
		mutated.Method = http.MethodDelete
		reg.ops[opName] = mutated

		_, refusal := curatedOp(tool)
		reg.ops[opName] = op

		if refusal == nil {
			t.Errorf("%s dispatched a DELETE because writes are enabled server-wide; the named surface must not widen with that switch", tool)
		}
	}
}

// --- redirect handling ---

// TestSignedRedirectIsResignedNotFollowed covers a defect that made an optional
// argument into a hard failure. PAPI answers a property fetch that omits
// contractId and groupId with a 302 to the canonical URL carrying both. Go's
// http.Client follows redirects by default and carries the Authorization header
// with it, but EdgeGrid signs the URL, so the signature no longer matches what
// arrived and Akamai answers 401 "The signature does not match" for a request
// that was correct. Confirmed live before the fix: property_get with only a
// propertyId returned exactly that.
func TestSignedRedirectIsResignedNotFollowed(t *testing.T) {
	loadTestRegistry(t)

	var auths []string
	var paths []string
	captured := akamaiStub(t, func(w http.ResponseWriter, r *http.Request) {
		auths = append(auths, r.Header.Get("Authorization"))
		paths = append(paths, r.URL.RequestURI())
		if len(paths) == 1 {
			w.Header().Set("Location", "/papi/v1/properties/257958?groupId=150866&contractId=3-HINVO")
			w.WriteHeader(http.StatusFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"properties":{"items":[{"propertyId":"prp_257958","stagingVersion":737,"productionVersion":734}]}}`))
	})

	res, _, err := propertyGet(context.Background(), nil, PropertyGetIn{PropertyID: "prp_257958"})
	if err != nil {
		t.Fatalf("propertyGet: %v", err)
	}
	if captured.Calls != 2 {
		t.Fatalf("made %d request(s); the redirect must be followed exactly once", captured.Calls)
	}
	if paths[1] != "/papi/v1/properties/257958?contractId=3-HINVO&groupId=150866" &&
		paths[1] != "/papi/v1/properties/257958?groupId=150866&contractId=3-HINVO" {
		t.Errorf("the hop went to %q, which is not the redirect target", paths[1])
	}
	// The whole point: the second request carries a signature minted for the
	// second URL. Reusing the first would be the bug this test exists for.
	if auths[0] == auths[1] {
		t.Error("the redirect hop reused the original Authorization header instead of re-signing")
	}
	if auths[1] == "" {
		t.Error("the redirect hop was sent unsigned")
	}
	if res.IsError {
		t.Errorf("the redirected call failed: %s", resultText(t, res))
	}
	if text := resultText(t, res); !strings.Contains(text, "737") {
		t.Errorf("the response after the hop was not returned: %s", text)
	}
}

// TestOffHostRedirectIsRefused is the containment half. A Location is the one
// piece of request-shaping input that comes from outside the catalogue, so it
// must not be able to send an EdgeGrid Authorization header to an origin the
// credential was not issued for.
func TestOffHostRedirectIsRefused(t *testing.T) {
	loadTestRegistry(t)

	captured := akamaiStub(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Location", "https://attacker.example.invalid/papi/v1/properties/257958")
		w.WriteHeader(http.StatusFound)
	})

	if _, _, err := propertyGet(context.Background(), nil, PropertyGetIn{PropertyID: "prp_257958"}); err != nil {
		t.Fatalf("propertyGet: %v", err)
	}
	if captured.Calls != 1 {
		t.Errorf("made %d requests; an off-host redirect must not be followed at all", captured.Calls)
	}
}

// TestRedirectTargetRejectsWhatItShould pins the decision table directly, since
// each of these has its own reason to be refused rather than followed.
func TestRedirectTargetRejectsWhatItShould(t *testing.T) {
	c := &edgercCreds{host: "example-host.invalid"}
	hdr := func(loc string) http.Header {
		h := http.Header{}
		if loc != "" {
			h.Set("Location", loc)
		}
		return h
	}
	cases := []struct {
		name string
		resp *signedResponse
		want bool
	}{
		{"200 is not a redirect", &signedResponse{StatusCode: 200, Headers: hdr("/elsewhere")}, false},
		{"401 is not a redirect", &signedResponse{StatusCode: 401, Headers: hdr("/elsewhere")}, false},
		{"3xx with no Location", &signedResponse{StatusCode: 302, Headers: hdr("")}, false},
		{"3xx to another host", &signedResponse{StatusCode: 302, Headers: hdr("https://other.invalid/x")}, false},
		{"3xx to a relative path", &signedResponse{StatusCode: 302, Headers: hdr("/papi/v1/properties/1?a=b")}, true},
		{"3xx to the same host", &signedResponse{StatusCode: 302, Headers: hdr("https://example-host.invalid/papi/v1/x")}, true},
	}
	for _, tc := range cases {
		if _, _, ok := redirectTarget(c, tc.resp); ok != tc.want {
			t.Errorf("%s: followed=%v, want %v", tc.name, ok, tc.want)
		}
	}
}

// --- response shaping ---

// enrollmentFixture builds a CPS-shaped payload with n enrollments, so the
// shaping tests work on the structure the API actually returns rather than on a
// hand-simplified one.
func enrollmentFixture(n int) string {
	items := make([]string, 0, n)
	for i := 0; i < n; i++ {
		items = append(items, fmt.Sprintf(`{
			"id": %d,
			"certificateType": "san",
			"validationType": "ov",
			"autoRenewalStartTime": "2026-11-07T23:59:59Z",
			"csr": {"cn": "host%d.example.com", "sans": ["host%d.example.com", "alt%d.example.com"], "o": "Example", "st": "PA"},
			"adminContact": {"email": "admin@example.com", "phone": "555-0100"},
			"networkConfiguration": {"geography": "core", "mustHaveCiphers": "ak-akamai-2020q1"},
			"pendingChanges": []
		}`, 1000+i, i, i, i))
	}
	return `{"enrollments":[` + strings.Join(items, ",") + `]}`
}

// TestCertificateListIsSummarizedByDefault covers the reason shaping exists: the
// unshaped CPS list measured 145,671 characters against this account, and the
// gateway compacts anything past 6,000, so the honest default is a list that
// fits rather than one that is always cut off somewhere arbitrary.
func TestCertificateListIsSummarizedByDefault(t *testing.T) {
	loadTestRegistry(t)

	akamaiStub(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(enrollmentFixture(25)))
	})

	res, _, err := certificateList(context.Background(), nil, CertificateListIn{ContractID: "ctr_TEST"})
	if err != nil {
		t.Fatalf("certificateList: %v", err)
	}
	text := resultText(t, res)

	for _, dropped := range []string{"adminContact", "mustHaveCiphers", "555-0100"} {
		if strings.Contains(text, dropped) {
			t.Errorf("the summary still carries %q, which is not part of a certificate index", dropped)
		}
	}
	for _, kept := range []string{"host0.example.com", "sanCount", "autoRenewalStartTime", "compacted"} {
		if !strings.Contains(text, kept) {
			t.Errorf("the summary dropped %q, which answers the question the tool is for", kept)
		}
	}
	if len(text) > 6000 {
		t.Errorf("the summary is %d characters, past the 6000 the gateway will pass through intact", len(text))
	}
}

// TestCertificateListFullReturnsEverything proves the projection is the caller's
// choice, not a ceiling: nothing is made unreachable by summarizing.
func TestCertificateListFullReturnsEverything(t *testing.T) {
	loadTestRegistry(t)

	akamaiStub(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(enrollmentFixture(3)))
	})

	res, _, err := certificateList(context.Background(), nil, CertificateListIn{ContractID: "ctr_TEST", Full: true})
	if err != nil {
		t.Fatalf("certificateList: %v", err)
	}
	text := resultText(t, res)
	for _, kept := range []string{"adminContact", "mustHaveCiphers", "alt1.example.com"} {
		if !strings.Contains(text, kept) {
			t.Errorf("full=true dropped %q", kept)
		}
	}
	if strings.Contains(text, "compacted") {
		t.Error("full=true still reported the response as compacted")
	}
}

// TestCertificateListFiltersByHostname keeps the tool's own description honest.
// It promises to answer which certificates cover a hostname, and the unfiltered
// list does not fit in a response, so without this the answer would always be
// truncated somewhere arbitrary.
func TestCertificateListFiltersByHostname(t *testing.T) {
	loadTestRegistry(t)

	akamaiStub(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(enrollmentFixture(25)))
	})

	res, _, err := certificateList(context.Background(), nil, CertificateListIn{ContractID: "ctr_TEST", Hostname: "alt7.example.com"})
	if err != nil {
		t.Fatalf("certificateList: %v", err)
	}
	text := resultText(t, res)
	if !strings.Contains(text, "alt7.example.com") {
		t.Error("the matching enrollment was not returned")
	}
	if strings.Contains(text, "host8.example.com") {
		t.Error("a non-matching enrollment was returned")
	}
	// A filtered hit is returned in full: having narrowed to one enrollment,
	// the SANs and TLS settings are the answer rather than the bulk.
	if !strings.Contains(text, "mustHaveCiphers") {
		t.Error("the filtered enrollment was summarized; a narrowed result should be complete")
	}
}

// TestSecurityConfigListDropsInlinedHostnames covers the same problem in a
// different shape: one configuration can protect hundreds of hostnames, and
// inlining all of them per configuration answers a question nobody asked of a
// listing.
func TestSecurityConfigListDropsInlinedHostnames(t *testing.T) {
	loadTestRegistry(t)

	hosts := make([]string, 0, 200)
	for i := 0; i < 200; i++ {
		hosts = append(hosts, fmt.Sprintf(`"host%d.example.com"`, i))
	}
	akamaiStub(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"configurations":[{"id":32662,"name":"CBI","latestVersion":341,` +
			`"stagingVersion":340,"productionVersion":339,"targetProduct":"KSD","productionHostnames":[` +
			strings.Join(hosts, ",") + `]}]}`))
	})

	res, _, err := securityConfigList(context.Background(), nil, SecurityConfigListIn{})
	if err != nil {
		t.Fatalf("securityConfigList: %v", err)
	}
	text := resultText(t, res)
	if strings.Contains(text, "host100.example.com") {
		t.Error("the listing still inlines protected hostnames")
	}
	if !strings.Contains(text, "productionHostnameCount") {
		t.Error("the listing dropped the hostnames without saying how many there were")
	}
	for _, kept := range []string{"CBI", "341", "productionVersion"} {
		if !strings.Contains(text, kept) {
			t.Errorf("the listing dropped %q, which is what it is for", kept)
		}
	}
}

// TestShapersLeaveUnexpectedPayloadsAlone is the safety property for all of
// them. A shaper that guessed at an unfamiliar shape could silently return a
// wrong answer; degrading to the untouched payload is a large response, which
// is merely inconvenient.
func TestShapersLeaveUnexpectedPayloadsAlone(t *testing.T) {
	for name, shape := range curatedShapers {
		for _, payload := range []any{
			"a string body",
			map[string]any{"unexpected": "shape"},
			[]any{1, 2, 3},
			nil,
		} {
			got := shape(payload)
			if _, isMap := payload.(map[string]any); !isMap {
				if !reflect.DeepEqual(got, payload) {
					t.Errorf("%s rewrote an unrecognized payload %v into %v", name, payload, got)
				}
			}
		}
	}
}

// TestErrorBodiesAreNeverShaped protects the diagnosis. An Akamai error body is
// the whole reason a failure is actionable (a 403 pep-authz reads very
// differently from a 400), and projecting it down to fields chosen for a success
// payload would throw that away.
func TestErrorBodiesAreNeverShaped(t *testing.T) {
	loadTestRegistry(t)

	akamaiStub(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"type":"https://problems.luna.akamaiapis.net/-/pep-authz/deny",` +
			`"title":"Forbidden","detail":"The client does not have the grant needed for the request"}`))
	})

	res, _, err := certificateList(context.Background(), nil, CertificateListIn{ContractID: "ctr_TEST"})
	if err != nil {
		t.Fatalf("certificateList: %v", err)
	}
	if !res.IsError {
		t.Fatal("a 403 was not reported as an error")
	}
	text := resultText(t, res)
	if !strings.Contains(text, "does not have the grant needed") {
		t.Errorf("the shaper ate the diagnosis: %s", text)
	}
}
