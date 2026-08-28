// Command powerautomate-mcp serves Microsoft Power Automate (Flow) as a
// standalone mcp-fleet server: 17 tools over stateless streamable-HTTP, never
// stdio and never SSE (mcptemplate owns the transport).
//
// WHY THIS IS ITS OWN SERVER, not a surface on a Microsoft 365 server.
// Power Automate has NO Microsoft Graph surface; it is its own control plane at
// api.flow.microsoft.com/providers/Microsoft.ProcessSimple. A combined M365
// server typically falls back to Graph when its primary path errors, so hosting
// Flow inside one couples a working Power Automate credential to the Graph one:
// a tenant that withholds Graph consent then takes Power Automate down with it,
// even though the Flow endpoints answer fine. Separate server, separate
// credential, no shared failure.
//
// AUTH. The outbound bearer is fetched from the Hermes broker at request time:
//
//	GET {HERMES_URL}/token/powerautomate/token   (Authorization: Bearer <client token>)
//
// The client token comes from HERMES_CLIENT_TOKEN, falling back to
// ~/.hermes/client.token, so nothing secret is ever written into thesun.toml or
// this source. The token is cached in memory until tokenRefreshBuffer before its
// stated expiry, and force-refetched once (behind a cooldown) when the API
// answers 401/403, so a rotation needs no restart. Token values are never logged.
//
// REQUIRES YOUR OWN Microsoft 365 account with Power Automate access. There is
// no usable default. Register the service with the broker, substituting your own
// sign-in address and your own OS credential-store entries:
//
//	hermes register powerautomate --provider oauth2 --scheme token --config '{
//	  "loginHint": "you@example.com",
//	  "tenant": "common",
//	  "clientId": "04b07795-8ddb-461a-bbee-02f9e1bf7b46",
//	  "scopes": ["https://service.flow.microsoft.com/.default", "offline_access"],
//	  "headless": true,
//	  "passwordKeychainService": "<your-sso-entry>",
//	  "passwordKeychainAccount": "password",
//	  "totpKeychainService": "<your-totp-entry>",
//	  "totpKeychainAccount": "you@example.com"
//	}'
//
// The clientId above is the Microsoft-published Azure CLI public client, chosen
// because service.flow.microsoft.com/.default is a resource scope it can request;
// register your own Entra application instead if your tenant requires it.
//
// ENDPOINT PROVENANCE. Microsoft publishes no reference for this API. Every URL,
// query parameter, and request body below was read verbatim out of
// pnp/cli-microsoft365 (src/m365/flow/commands/**); the source file is named on
// each tool. No endpoint here was guessed.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"mcp-fleet/servers/internal/mcptemplate"
)

const (
	// The Power Automate control plane. Environment-scoped resources hang off
	// envPrefix/{envId}; listing environments is the one global call.
	apiBase    = "https://api.flow.microsoft.com"
	apiVersion = "2016-11-01"
	envPrefix  = "/providers/Microsoft.ProcessSimple/environments"

	// Hermes credential coordinates for the flow-service bearer.
	hermesService = "powerautomate"
	hermesScheme  = "token"

	httpTimeout = 30 * time.Second
	maxBody     = 8 << 20 // 8 MiB — an ARM template export is the largest body

	// Refresh the cached bearer this long before its stated expiry.
	tokenRefreshBuffer = 5 * time.Minute
	// Floor between two forced (401/403-driven) refetches, so a persistently
	// rejecting token cannot turn one bad call into a broker request storm.
	authRetryCooldown = 30 * time.Second
)

// version is stamped at build time via -ldflags="-X main.version=...".
var version = "dev"

// httpClient enforces a hard timeout and (via the default transport) verified TLS.
var httpClient = &http.Client{Timeout: httpTimeout}

// --- Hermes broker plumbing ------------------------------------------------

// hermesBaseURL returns the broker base URL, defaulting to the loopback broker.
func hermesBaseURL() string {
	if v := os.Getenv("HERMES_URL"); v != "" {
		return v
	}
	return "http://127.0.0.1:9876"
}

// hermesClientToken returns the broker client token from HERMES_CLIENT_TOKEN,
// falling back to ~/.hermes/client.token so a supervised server needs no secret
// in its manifest env. Never logged.
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

var (
	tokMu        sync.Mutex
	tokValue     string
	tokExpires   time.Time
	lastForcedAt time.Time
)

// resolveBearer returns the current flow-service bearer, fetching a fresh one
// from Hermes when the cache is stale or when force is set (a 401/403 retry).
// Returns "" when no token could be obtained. Never logged.
func resolveBearer(ctx context.Context, force bool) string {
	tokMu.Lock()
	defer tokMu.Unlock()
	now := time.Now()
	if force {
		// Honour the cooldown: a token the API just rejected is worth one
		// refetch, not one per call.
		if !lastForcedAt.IsZero() && now.Sub(lastForcedAt) < authRetryCooldown {
			return tokValue
		}
		lastForcedAt = now
	} else if tokValue != "" && now.Before(tokExpires.Add(-tokenRefreshBuffer)) {
		return tokValue
	}
	if tok, exp, ok := fetchBearerFromHermes(ctx); ok {
		tokValue = tok
		tokExpires = exp
		return tokValue
	}
	// Fall back to the cached token rather than nothing: one inside its refresh
	// buffer still authenticates.
	return tokValue
}

// fetchBearerFromHermes GETs {HERMES_URL}/token/powerautomate/token and returns
// (token, expiry, ok). Any failure returns ok=false and never surfaces a value.
func fetchBearerFromHermes(ctx context.Context) (string, time.Time, bool) {
	base, client := hermesBaseURL(), hermesClientToken()
	if base == "" || client == "" {
		return "", time.Time{}, false
	}
	reqURL := strings.TrimRight(base, "/") + "/token/" + hermesService + "/" + hermesScheme
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return "", time.Time{}, false
	}
	req.Header.Set("Authorization", "Bearer "+client)
	req.Header.Set("Accept", "application/json")
	resp, err := httpClient.Do(req)
	if err != nil {
		return "", time.Time{}, false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", time.Time{}, false
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBody))
	if err != nil {
		return "", time.Time{}, false
	}
	var b struct {
		AccessToken string `json:"accessToken"`
		ExpiresAt   int64  `json:"expiresAt"` // epoch milliseconds
	}
	if err := json.Unmarshal(body, &b); err != nil || b.AccessToken == "" {
		return "", time.Time{}, false
	}
	exp := time.Now().Add(30 * time.Minute) // conservative default
	if b.ExpiresAt > 0 {
		exp = time.UnixMilli(b.ExpiresAt)
	}
	return b.AccessToken, exp, true
}

// --- Power Automate request layer ------------------------------------------

// envURL builds an environment-scoped URL, e.g. .../environments/{envId}/flows.
// resource must start with "/".
func envURL(envID, resource string) string {
	return apiBase + envPrefix + "/" + envID + resource
}

// apiRequest issues one authenticated call and returns the raw JSON body. It
// retries exactly once, with a force-refreshed bearer, when the service answers
// 401 or 403 — an expired token is the common cause and a rotation should not
// need a restart.
func apiRequest(ctx context.Context, method, rawURL string, query url.Values, body any) (json.RawMessage, error) {
	if query == nil {
		query = url.Values{}
	}
	query.Set("api-version", apiVersion)
	full := rawURL + "?" + query.Encode()

	raw, status, err := apiOnce(ctx, method, full, body, false)
	if err == nil {
		return raw, nil
	}
	if status == http.StatusUnauthorized || status == http.StatusForbidden {
		raw, _, err = apiOnce(ctx, method, full, body, true)
		if err == nil {
			return raw, nil
		}
	}
	return nil, err
}

// apiOnce performs a single attempt. status is the HTTP status when the call
// reached the service, 0 when it did not.
func apiOnce(ctx context.Context, method, full string, body any, force bool) (json.RawMessage, int, error) {
	token := resolveBearer(ctx, force)
	if token == "" {
		return nil, 0, fmt.Errorf(
			"no Hermes-managed Power Automate token available - ensure the Hermes broker is running and %s/%s is acquired (hermes acquire %s)",
			hermesService, hermesScheme, hermesService)
	}

	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, 0, fmt.Errorf("could not encode request body: %w", err)
		}
		reader = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(ctx, method, full, reader)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(resp.Body, maxBody))
	if err != nil {
		return nil, resp.StatusCode, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, resp.StatusCode, fmt.Errorf("power automate returned HTTP %d: %s",
			resp.StatusCode, strings.TrimSpace(truncate(string(payload), 600)))
	}
	if len(bytes.TrimSpace(payload)) == 0 {
		// start/stop/cancel answer 200 with no body.
		return json.RawMessage(`{"status":"ok"}`), resp.StatusCode, nil
	}
	return json.RawMessage(payload), resp.StatusCode, nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

// --- default environment ----------------------------------------------------

var (
	envMu      sync.Mutex
	defaultEnv string
)

// resolveEnvID returns envID when given, otherwise the cached default
// environment: the one whose properties.isDefault is true, else the first.
func resolveEnvID(ctx context.Context, envID string) (string, error) {
	if envID != "" {
		return envID, nil
	}
	envMu.Lock()
	defer envMu.Unlock()
	if defaultEnv != "" {
		return defaultEnv, nil
	}
	raw, err := apiRequest(ctx, http.MethodGet, apiBase+envPrefix, nil, nil)
	if err != nil {
		return "", err
	}
	var envs struct {
		Value []struct {
			Name       string `json:"name"`
			Properties struct {
				IsDefault bool `json:"isDefault"`
			} `json:"properties"`
		} `json:"value"`
	}
	if err := json.Unmarshal(raw, &envs); err != nil {
		return "", fmt.Errorf("could not read the environment list: %w", err)
	}
	if len(envs.Value) == 0 {
		return "", fmt.Errorf("no Power Automate environments found for this account")
	}
	pick := envs.Value[0].Name
	for _, e := range envs.Value {
		if e.Properties.IsDefault {
			pick = e.Name
			break
		}
	}
	defaultEnv = pick
	return defaultEnv, nil
}

// --- tool result helpers ----------------------------------------------------

func jsonResult(raw json.RawMessage) *mcp.CallToolResult {
	return mcptemplate.TextResult(string(raw))
}

func fail(tool string, err error) (*mcp.CallToolResult, any, error) {
	return mcptemplate.ErrorResult(fmt.Sprintf("%s: %v", tool, err)), nil, nil
}

func boolPtr(b bool) *bool { return &b }

// --- tool argument types ----------------------------------------------------

type envOnlyIn struct {
	EnvID string `json:"env_id,omitempty" jsonschema:"Power Automate environment ID; omit to use the default environment"`
}

type noArgsIn struct{}

type listFlowsIn struct {
	EnvID                string `json:"env_id,omitempty" jsonschema:"Power Automate environment ID; omit to use the default environment"`
	FlowFilter           string `json:"flow_filter,omitempty" jsonschema:"'personal' for My flows or 'team' for flows shared with me; omit for every visible flow"`
	IncludeSolutionFlows bool   `json:"include_solution_flows,omitempty" jsonschema:"include solution-aware cloud flows, which the plain listing omits"`
}

type flowIn struct {
	FlowID string `json:"flow_id" jsonschema:"the flow's ID (its 'name' field, a GUID)"`
	EnvID  string `json:"env_id,omitempty" jsonschema:"Power Automate environment ID; omit to use the default environment"`
}

type runIn struct {
	FlowID string `json:"flow_id" jsonschema:"the flow's ID (its 'name' field, a GUID)"`
	RunID  string `json:"run_id" jsonschema:"the run's ID"`
	EnvID  string `json:"env_id,omitempty" jsonschema:"Power Automate environment ID; omit to use the default environment"`
}

type getRunIn struct {
	FlowID      string `json:"flow_id" jsonschema:"the flow's ID (its 'name' field, a GUID)"`
	RunID       string `json:"run_id" jsonschema:"the run's ID"`
	EnvID       string `json:"env_id,omitempty" jsonschema:"Power Automate environment ID; omit to use the default environment"`
	WithActions bool   `json:"with_actions,omitempty" jsonschema:"expand each action's status and its input/output links, to see which step failed"`
}

type triggerFlowIn struct {
	FlowID string          `json:"flow_id" jsonschema:"the flow's ID (its 'name' field, a GUID)"`
	EnvID  string          `json:"env_id,omitempty" jsonschema:"Power Automate environment ID; omit to use the default environment"`
	Body   json.RawMessage `json:"body,omitempty" jsonschema:"JSON payload for the manual trigger; defaults to an empty object"`
}

type resubmitIn struct {
	FlowID      string `json:"flow_id" jsonschema:"the flow's ID (its 'name' field, a GUID)"`
	RunID       string `json:"run_id" jsonschema:"the run to resubmit"`
	TriggerName string `json:"trigger_name,omitempty" jsonschema:"trigger that produced the run; defaults to the one named on the run itself"`
	EnvID       string `json:"env_id,omitempty" jsonschema:"Power Automate environment ID; omit to use the default environment"`
}

type addOwnerIn struct {
	FlowID        string `json:"flow_id" jsonschema:"the flow's ID (its 'name' field, a GUID)"`
	PrincipalID   string `json:"principal_id" jsonschema:"Entra object ID of the user or group"`
	PrincipalType string `json:"principal_type,omitempty" jsonschema:"'User' or 'Group'; defaults to User"`
	RoleName      string `json:"role_name,omitempty" jsonschema:"'CanView' or 'CanEdit'; defaults to CanView"`
	EnvID         string `json:"env_id,omitempty" jsonschema:"Power Automate environment ID; omit to use the default environment"`
}

type removeOwnerIn struct {
	FlowID      string `json:"flow_id" jsonschema:"the flow's ID (its 'name' field, a GUID)"`
	PrincipalID string `json:"principal_id" jsonschema:"Entra object ID of the user or group to unshare from"`
	EnvID       string `json:"env_id,omitempty" jsonschema:"Power Automate environment ID; omit to use the default environment"`
}

// --- tools ------------------------------------------------------------------

// listEnvironments is the one global (non environment-scoped) call.
// Source: pnp/cli-microsoft365 src/m365/flow/commands/environment/environment-list.ts
func listEnvironments(ctx context.Context, _ *mcp.CallToolRequest, _ noArgsIn) (*mcp.CallToolResult, any, error) {
	raw, err := apiRequest(ctx, http.MethodGet, apiBase+envPrefix, nil, nil)
	if err != nil {
		return fail("flow_list_environments", err)
	}
	return jsonResult(raw), nil, nil
}

// Source: pnp/cli-microsoft365 src/m365/flow/commands/flow-list.ts getApiUrl()
func listFlows(ctx context.Context, _ *mcp.CallToolRequest, in listFlowsIn) (*mcp.CallToolResult, any, error) {
	if in.FlowFilter != "" && in.FlowFilter != "personal" && in.FlowFilter != "team" {
		return fail("flow_list_flows", fmt.Errorf("flow_filter must be 'personal', 'team', or omitted"))
	}
	eid, err := resolveEnvID(ctx, in.EnvID)
	if err != nil {
		return fail("flow_list_flows", err)
	}
	q := url.Values{}
	if in.FlowFilter != "" {
		q.Set("$filter", fmt.Sprintf("search('%s')", in.FlowFilter))
	}
	if in.IncludeSolutionFlows {
		q.Set("include", "includeSolutionCloudFlows")
	}
	raw, err := apiRequest(ctx, http.MethodGet, envURL(eid, "/flows"), q, nil)
	if err != nil {
		return fail("flow_list_flows", err)
	}
	return jsonResult(raw), nil, nil
}

// Source: pnp/cli-microsoft365 src/m365/flow/commands/flow-get.ts
func getFlow(ctx context.Context, _ *mcp.CallToolRequest, in flowIn) (*mcp.CallToolResult, any, error) {
	eid, err := resolveEnvID(ctx, in.EnvID)
	if err != nil {
		return fail("flow_get_flow", err)
	}
	raw, err := apiRequest(ctx, http.MethodGet, envURL(eid, "/flows/"+in.FlowID), nil, nil)
	if err != nil {
		return fail("flow_get_flow", err)
	}
	return jsonResult(raw), nil, nil
}

// Source: pnp/cli-microsoft365 src/m365/flow/commands/run/run-list.ts
func getFlowRuns(ctx context.Context, _ *mcp.CallToolRequest, in flowIn) (*mcp.CallToolResult, any, error) {
	eid, err := resolveEnvID(ctx, in.EnvID)
	if err != nil {
		return fail("flow_get_flow_runs", err)
	}
	raw, err := apiRequest(ctx, http.MethodGet, envURL(eid, "/flows/"+in.FlowID+"/runs"), nil, nil)
	if err != nil {
		return fail("flow_get_flow_runs", err)
	}
	return jsonResult(raw), nil, nil
}

// Source: pnp/cli-microsoft365 src/m365/flow/commands/run/run-get.ts
func getFlowRun(ctx context.Context, _ *mcp.CallToolRequest, in getRunIn) (*mcp.CallToolResult, any, error) {
	eid, err := resolveEnvID(ctx, in.EnvID)
	if err != nil {
		return fail("flow_get_flow_run", err)
	}
	raw, err := fetchRun(ctx, eid, in.FlowID, in.RunID, in.WithActions)
	if err != nil {
		return fail("flow_get_flow_run", err)
	}
	return jsonResult(raw), nil, nil
}

func fetchRun(ctx context.Context, envID, flowID, runID string, withActions bool) (json.RawMessage, error) {
	q := url.Values{}
	if withActions {
		q.Set("$expand", "properties/actions")
	}
	return apiRequest(ctx, http.MethodGet, envURL(envID, "/flows/"+flowID+"/runs/"+runID), q, nil)
}

// Source: pnp/cli-microsoft365 src/m365/flow/commands/trigger/trigger-list.ts
func listFlowTriggers(ctx context.Context, _ *mcp.CallToolRequest, in flowIn) (*mcp.CallToolResult, any, error) {
	eid, err := resolveEnvID(ctx, in.EnvID)
	if err != nil {
		return fail("flow_list_flow_triggers", err)
	}
	raw, err := apiRequest(ctx, http.MethodGet, envURL(eid, "/flows/"+in.FlowID+"/triggers"), nil, nil)
	if err != nil {
		return fail("flow_list_flow_triggers", err)
	}
	return jsonResult(raw), nil, nil
}

// listConnectors lists the connectors available in an environment.
//
// Note this is Microsoft.PowerApps/apis, NOT a ProcessSimple path: the
// environment-scoped .../environments/{env}/connections URL answers 404, and the
// admin-scoped .../PowerApps/scopes/admin/environments/{env}/connections answers
// 403 without a Power Platform admin role (both probed live 2026-08-28). The
// connection INSTANCES a given flow uses are not reachable on this audience
// either; they come back inside flow_get_flow as properties.parameters.$connections.
//
// Source: pnp/cli-microsoft365 src/m365/flow/commands/connector/connector-list.ts
func listConnectors(ctx context.Context, _ *mcp.CallToolRequest, in envOnlyIn) (*mcp.CallToolResult, any, error) {
	eid, err := resolveEnvID(ctx, in.EnvID)
	if err != nil {
		return fail("flow_list_connectors", err)
	}
	q := url.Values{}
	q.Set("$filter", fmt.Sprintf("environment eq '%s'", eid))
	raw, err := apiRequest(ctx, http.MethodGet, apiBase+"/providers/Microsoft.PowerApps/apis", q, nil)
	if err != nil {
		return fail("flow_list_connectors", err)
	}
	return jsonResult(raw), nil, nil
}

// Source: pnp/cli-microsoft365 src/m365/flow/commands/owner/owner-list.ts
func listOwners(ctx context.Context, _ *mcp.CallToolRequest, in flowIn) (*mcp.CallToolResult, any, error) {
	eid, err := resolveEnvID(ctx, in.EnvID)
	if err != nil {
		return fail("flow_list_owners", err)
	}
	raw, err := apiRequest(ctx, http.MethodGet, envURL(eid, "/flows/"+in.FlowID+"/permissions"), nil, nil)
	if err != nil {
		return fail("flow_list_owners", err)
	}
	return jsonResult(raw), nil, nil
}

// exportARMTemplate is a POST that changes nothing: it renders the flow as an
// ARM template and returns it.
// Source: pnp/cli-microsoft365 src/m365/flow/commands/flow-export.ts
func exportARMTemplate(ctx context.Context, _ *mcp.CallToolRequest, in flowIn) (*mcp.CallToolResult, any, error) {
	eid, err := resolveEnvID(ctx, in.EnvID)
	if err != nil {
		return fail("flow_export_arm_template", err)
	}
	raw, err := apiRequest(ctx, http.MethodPost, envURL(eid, "/flows/"+in.FlowID+"/exportToARMTemplate"), nil, nil)
	if err != nil {
		return fail("flow_export_arm_template", err)
	}
	return jsonResult(raw), nil, nil
}

// Source: pnp/cli-microsoft365 src/m365/flow/commands/flow-enable.ts
func enableFlow(ctx context.Context, _ *mcp.CallToolRequest, in flowIn) (*mcp.CallToolResult, any, error) {
	eid, err := resolveEnvID(ctx, in.EnvID)
	if err != nil {
		return fail("flow_enable_flow", err)
	}
	raw, err := apiRequest(ctx, http.MethodPost, envURL(eid, "/flows/"+in.FlowID+"/start"), nil, nil)
	if err != nil {
		return fail("flow_enable_flow", err)
	}
	return jsonResult(raw), nil, nil
}

// Source: pnp/cli-microsoft365 src/m365/flow/commands/flow-disable.ts
func disableFlow(ctx context.Context, _ *mcp.CallToolRequest, in flowIn) (*mcp.CallToolResult, any, error) {
	eid, err := resolveEnvID(ctx, in.EnvID)
	if err != nil {
		return fail("flow_disable_flow", err)
	}
	raw, err := apiRequest(ctx, http.MethodPost, envURL(eid, "/flows/"+in.FlowID+"/stop"), nil, nil)
	if err != nil {
		return fail("flow_disable_flow", err)
	}
	return jsonResult(raw), nil, nil
}

// Source: pnp/cli-microsoft365 src/m365/flow/commands/run/run-cancel.ts
func cancelRun(ctx context.Context, _ *mcp.CallToolRequest, in runIn) (*mcp.CallToolResult, any, error) {
	eid, err := resolveEnvID(ctx, in.EnvID)
	if err != nil {
		return fail("flow_cancel_run", err)
	}
	raw, err := apiRequest(ctx, http.MethodPost, envURL(eid, "/flows/"+in.FlowID+"/runs/"+in.RunID+"/cancel"), nil, nil)
	if err != nil {
		return fail("flow_cancel_run", err)
	}
	return jsonResult(raw), nil, nil
}

// Source: pnp/cli-microsoft365 src/m365/flow/commands/flow-run.ts
func triggerFlow(ctx context.Context, _ *mcp.CallToolRequest, in triggerFlowIn) (*mcp.CallToolResult, any, error) {
	eid, err := resolveEnvID(ctx, in.EnvID)
	if err != nil {
		return fail("flow_trigger_flow", err)
	}
	var body any = map[string]any{}
	if len(in.Body) > 0 {
		var decoded any
		if err := json.Unmarshal(in.Body, &decoded); err != nil {
			return fail("flow_trigger_flow", fmt.Errorf("body is not valid JSON: %w", err))
		}
		body = decoded
	}
	raw, err := apiRequest(ctx, http.MethodPost, envURL(eid, "/flows/"+in.FlowID+"/triggers/manual/run"), nil, body)
	if err != nil {
		return fail("flow_trigger_flow", err)
	}
	return jsonResult(raw), nil, nil
}

// Source: pnp/cli-microsoft365 src/m365/flow/commands/run/run-resubmit.ts
func resubmitRun(ctx context.Context, _ *mcp.CallToolRequest, in resubmitIn) (*mcp.CallToolResult, any, error) {
	eid, err := resolveEnvID(ctx, in.EnvID)
	if err != nil {
		return fail("flow_resubmit_run", err)
	}
	name := in.TriggerName
	if name == "" {
		name, err = triggerNameForRun(ctx, eid, in.FlowID, in.RunID)
		if err != nil {
			return fail("flow_resubmit_run", err)
		}
	}
	raw, err := apiRequest(ctx, http.MethodPost,
		envURL(eid, "/flows/"+in.FlowID+"/triggers/"+name+"/histories/"+in.RunID+"/resubmit"), nil, nil)
	if err != nil {
		return fail("flow_resubmit_run", err)
	}
	return jsonResult(raw), nil, nil
}

// triggerNameForRun reads the trigger off the RUN (properties.trigger.name)
// rather than the flow's trigger list. That is both more correct — it is the
// trigger that actually fired for this run — and more reliable: the service
// answers HTTP 500 for the triggers of some flows (observed 2026-08-28 on 2 of
// 4 live flows) while their runs read back fine. The trigger list is the
// fallback, and when both fail the caller is told to pass trigger_name.
func triggerNameForRun(ctx context.Context, envID, flowID, runID string) (string, error) {
	if raw, err := fetchRun(ctx, envID, flowID, runID, false); err == nil {
		var run struct {
			Properties struct {
				Trigger struct {
					Name string `json:"name"`
				} `json:"trigger"`
			} `json:"properties"`
		}
		if json.Unmarshal(raw, &run) == nil && run.Properties.Trigger.Name != "" {
			return run.Properties.Trigger.Name, nil
		}
	}
	raw, err := apiRequest(ctx, http.MethodGet, envURL(envID, "/flows/"+flowID+"/triggers"), nil, nil)
	if err != nil {
		return "", fmt.Errorf("could not read the triggers of flow %s (%v); pass trigger_name explicitly to resubmit", flowID, err)
	}
	var triggers struct {
		Value []struct {
			Name string `json:"name"`
		} `json:"value"`
	}
	if err := json.Unmarshal(raw, &triggers); err != nil || len(triggers.Value) == 0 {
		return "", fmt.Errorf("flow %s exposes no triggers - cannot resubmit", flowID)
	}
	return triggers.Value[0].Name, nil
}

// Source: pnp/cli-microsoft365 src/m365/flow/commands/owner/owner-ensure.ts
func addOwner(ctx context.Context, _ *mcp.CallToolRequest, in addOwnerIn) (*mcp.CallToolResult, any, error) {
	principalType := in.PrincipalType
	if principalType == "" {
		principalType = "User"
	}
	if principalType != "User" && principalType != "Group" {
		return fail("flow_add_owner", fmt.Errorf("principal_type must be 'User' or 'Group'"))
	}
	roleName := in.RoleName
	if roleName == "" {
		roleName = "CanView"
	}
	if roleName != "CanView" && roleName != "CanEdit" {
		return fail("flow_add_owner", fmt.Errorf("role_name must be 'CanView' or 'CanEdit'"))
	}
	eid, err := resolveEnvID(ctx, in.EnvID)
	if err != nil {
		return fail("flow_add_owner", err)
	}
	body := map[string]any{
		"put": []any{map[string]any{
			"properties": map[string]any{
				"principal": map[string]any{"id": in.PrincipalID, "type": principalType},
				"roleName":  roleName,
			},
		}},
	}
	raw, err := apiRequest(ctx, http.MethodPost, envURL(eid, "/flows/"+in.FlowID+"/modifyPermissions"), nil, body)
	if err != nil {
		return fail("flow_add_owner", err)
	}
	return jsonResult(raw), nil, nil
}

// Source: pnp/cli-microsoft365 src/m365/flow/commands/owner/owner-remove.ts
func removeOwner(ctx context.Context, _ *mcp.CallToolRequest, in removeOwnerIn) (*mcp.CallToolResult, any, error) {
	eid, err := resolveEnvID(ctx, in.EnvID)
	if err != nil {
		return fail("flow_remove_owner", err)
	}
	body := map[string]any{"delete": []any{map[string]any{"id": in.PrincipalID}}}
	raw, err := apiRequest(ctx, http.MethodPost, envURL(eid, "/flows/"+in.FlowID+"/modifyPermissions"), nil, body)
	if err != nil {
		return fail("flow_remove_owner", err)
	}
	return jsonResult(raw), nil, nil
}

// Source: pnp/cli-microsoft365 src/m365/flow/commands/flow-remove.ts
func deleteFlow(ctx context.Context, _ *mcp.CallToolRequest, in flowIn) (*mcp.CallToolResult, any, error) {
	eid, err := resolveEnvID(ctx, in.EnvID)
	if err != nil {
		return fail("flow_delete_flow", err)
	}
	raw, err := apiRequest(ctx, http.MethodDelete, envURL(eid, "/flows/"+in.FlowID), nil, nil)
	if err != nil {
		return fail("flow_delete_flow", err)
	}
	return jsonResult(raw), nil, nil
}

// --- registration -----------------------------------------------------------

func main() {
	log.SetFlags(0)

	srv := mcp.NewServer(&mcp.Implementation{
		Name:    "powerautomate-mcp",
		Version: version,
	}, nil)

	ro := &mcp.ToolAnnotations{ReadOnlyHint: true}
	destructive := &mcp.ToolAnnotations{DestructiveHint: boolPtr(true)}

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "flow_list_environments",
		Description: "List every Power Automate environment the signed-in account can see. Each entry's 'name' is the environment ID other tools take as env_id.",
		Annotations: ro,
	}, listEnvironments)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "flow_list_flows",
		Description: "List cloud flows in an environment. flow_filter 'personal' or 'team' splits My flows from flows shared with me; include_solution_flows adds solution-aware flows, which the plain listing omits.",
		Annotations: ro,
	}, listFlows)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "flow_get_flow",
		Description: "Get one cloud flow by ID, including its definition, state, and connection references.",
		Annotations: ro,
	}, getFlow)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "flow_get_flow_runs",
		Description: "List the run history of a cloud flow, newest first.",
		Annotations: ro,
	}, getFlowRuns)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "flow_get_flow_run",
		Description: "Get one run of a cloud flow. Set with_actions to expand every action's status plus its input and output links, which is how to find the step that failed.",
		Annotations: ro,
	}, getFlowRun)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "flow_list_flow_triggers",
		Description: "List a flow's triggers. Note the service answers HTTP 500 for the triggers of some flows; flow_resubmit_run does not depend on this call.",
		Annotations: ro,
	}, listFlowTriggers)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "flow_list_connectors",
		Description: "List the connectors available in an environment. To see which connections a particular flow actually uses, read flow_get_flow instead: they come back under properties.parameters.$connections.",
		Annotations: ro,
	}, listConnectors)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "flow_list_owners",
		Description: "List the users and groups a flow is shared with, and each one's role.",
		Annotations: ro,
	}, listOwners)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "flow_export_arm_template",
		Description: "Export a flow as an ARM template. This reads only; nothing about the flow is changed.",
		Annotations: ro,
	}, exportARMTemplate)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "flow_enable_flow",
		Description: "Turn a cloud flow on, so its trigger fires again.",
	}, enableFlow)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "flow_disable_flow",
		Description: "Turn a cloud flow off. It stops firing until it is enabled again.",
	}, disableFlow)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "flow_cancel_run",
		Description: "Cancel a run that is still in progress.",
	}, cancelRun)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "flow_trigger_flow",
		Description: "Run a flow now through its manual trigger, optionally with a JSON payload. The flow's own actions then run for real, and what they touch is not knowable from here.",
		Annotations: destructive,
	}, triggerFlow)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "flow_resubmit_run",
		Description: "Run a past run again with its original trigger payload. Its actions execute for real a second time. trigger_name defaults to the trigger named on the run itself.",
		Annotations: destructive,
	}, resubmitRun)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "flow_add_owner",
		Description: "Share a flow with a user or group, or change their existing role. principal_id is an Entra object ID.",
		Annotations: destructive,
	}, addOwner)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "flow_remove_owner",
		Description: "Stop sharing a flow with a user or group.",
		Annotations: destructive,
	}, removeOwner)

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "flow_delete_flow",
		Description: "Delete a cloud flow. This cannot be undone; export it first if it may be needed again.",
		Annotations: destructive,
	}, deleteFlow)

	if err := mcptemplate.Serve(context.Background(), srv); err != nil {
		log.Fatalf("powerautomate-mcp: %v", err)
	}
}
