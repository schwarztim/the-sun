/**
 * Go MCP Server Generator (thesun `--lang go` target)
 *
 * Deterministic code generator that turns thesun's structured endpoint IR
 * (the same `DiscoveredEndpoint[]` the discovery phase produces from an
 * OpenAPI spec / HAR capture) into a compilable Go MCP server built on the
 * proven mcp-fleet `mcptemplate` pattern.
 *
 * Design goals (KISS + portability):
 *  - **Transport: streamable-HTTP ONLY.** Never stdio, never SSE. The transport
 *    harness (mcp.NewStreamableHTTPHandler at /mcp, Stateless, /healthz,
 *    MCP_PORT required, SIGTERM graceful shutdown) is INLINED into the generated
 *    main.go so the output depends only on the go-sdk — no mcp-fleet internal
 *    packages — and is therefore independently compilable and containerizable.
 *  - **No secrets anywhere.** Credentials are read from the environment at
 *    runtime only; they are never logged, echoed, or surfaced in a tool result
 *    or error (errors are scrubbed of the credential-bearing URL and redacted).
 *  - **One main.go + go.mod + Dockerfile.** Tools map 1:1 from API endpoints.
 *
 * This path is deterministic (no agent/"bob" in the loop) so its output is
 * verifiable with `go build ./...`.
 */

/** A single API endpoint the generator turns into one MCP tool. */
export interface GoEndpointSpec {
  /** HTTP method, e.g. "GET" | "POST" | "PUT" | "DELETE" | "PATCH". */
  method: string;
  /** URL path template relative to baseUrl, e.g. "/shodan/host/{ip}". */
  path: string;
  /** Stable operation id; used to derive the tool name and Go identifier. */
  operationId?: string;
  /** Human-readable tool description (surfaced to the MCP client). */
  description?: string;
  /** Path parameters (each becomes a REQUIRED string field, URL-escaped). */
  pathParams?: string[];
  /** Query parameters (each becomes an optional string field unless required). */
  queryParams?: Array<{ name: string; required?: boolean; description?: string }>;
}

/** Authentication mode for the generated server's outbound calls. */
export type GoAuthScheme = "bearer" | "api_key" | "basic" | "hermes-token" | "cookie-session" | "none";

/** Full configuration for a generated Go MCP server. */
export interface GoServerConfig {
  /** Service name, e.g. "shodan" — the module becomes "<name>-mcp". */
  name: string;
  /** Server version string (default "dev"; also overridable via -ldflags). */
  version?: string;
  /** HTTPS API base URL, e.g. "https://api.shodan.io". */
  baseUrl: string;
  /** Auth scheme for outbound calls. */
  authScheme: GoAuthScheme;
  /**
   * Env-var prefix for the credential, e.g. "SHODAN" → reads SHODAN_API_KEY /
   * SHODAN_TOKEN. Defaults to the uppercased, sanitized service name.
   */
  authEnvPrefix?: string;
  /**
   * For authScheme "api_key": the outbound query-parameter name carrying the
   * key (default "key", mirroring Shodan). Ignored for other schemes and when
   * apiKeyHeader is set.
   */
  apiKeyQueryParam?: string;
  /**
   * For authScheme "api_key": send the key in this HTTP header instead of a
   * query parameter (e.g. "X-Figma-Token", "Netskope-Api-Token"). Takes
   * precedence over apiKeyQueryParam when set.
   */
  apiKeyHeader?: string;
  /** The endpoints to expose as tools. */
  endpoints: GoEndpointSpec[];
  /** Go toolchain version for go.mod (default "1.26"). */
  goVersion?: string;
  /** go-sdk version to require (default "v1.6.1"). */
  sdkVersion?: string;
  /** Default in-container listen port for the Dockerfile (default "8080"). */
  defaultPort?: string;
  /** Outbound token-bucket rate: requests/sec (default 8). */
  rateLimitRPS?: number;
  /** Outbound token-bucket burst size (default 4). */
  rateLimitBurst?: number;
  /**
   * Per-target capability flag: the target performs anti-bot / JA4
   * fingerprinting on the MCP's OWN outbound calls, so the generated server
   * must present a browser-realistic TLS fingerprint (curl_cffi on the Python
   * path; uTLS on Go once added). When true, the Conformance Lab's
   * wire-fingerprint gate is REQUIRED (a browser-JA4 self-test must pass);
   * when false/absent (the common REST-API case — api.github.com, etc.), that
   * gate is informational-pass. This is the discriminator that routes a
   * target to Python vs Go — browser-TLS need, NOT SSO-ness. Persisted into
   * lab.launch.json so `thesun verify` can read it off the server directory.
   */
  requiresBrowserTLS?: boolean;
  /**
   * For authScheme "hermes-token": the Hermes service name to fetch the bearer
   * token for (defaults to the server name). The token is owned + refreshed by
   * the local Hermes broker; the server fetches the current one at request time.
   */
  hermesTokenService?: string;
  /**
   * For authScheme "hermes-token": the Hermes scheme (e.g. "graph", "teams-bearer",
   * "token"). Defaults to "token". For authScheme "cookie-session" it is the
   * session scheme (e.g. "session"); defaults to "session".
   */
  hermesTokenScheme?: string;
  /**
   * For authScheme "hermes-token": when set, the fetched token is sent verbatim in
   * this raw HTTP header (e.g. "X-Venafi-Api-Key") instead of `Authorization: Bearer`.
   * Required for services (Venafi TPP WebSDK) that reject a bearer-framed API-key GUID
   * with "invalid_token". Unset (default) preserves the `Authorization: Bearer` behavior.
   */
  hermesTokenHeader?: string;
  /**
   * For authScheme "cookie-session": when set, the outbound Cookie header is built
   * as `<cookieName>=<value>`. When unset (default — the ServiceNow case), the
   * Hermes bundle's accessToken already carries the full raw Cookie header string
   * (multiple `; `-joined cookies) and is sent verbatim as the Cookie header.
   */
  cookieName?: string;
  /**
   * For authScheme "cookie-session": enable a GENERIC easy-auth fallback that is
   * tried FIRST, ahead of the Hermes-managed SSO session cookie. Many products that
   * offer a corporate SSO-only integration (the cookie-session default — browser
   * login captured via Hermes/Playwright) ALSO expose a plain HTTP Basic or OAuth2
   * client-credentials API on a stock, non-SSO instance (e.g. a personal ServiceNow
   * developer instance). When true, the generated server activates the generic path
   * automatically based on env presence, no build-time choice required:
   *   - `<PREFIX>_BASIC_AUTH="user:pass"` (or `<PREFIX>_USERNAME` + `<PREFIX>_PASSWORD`)
   *   - `<PREFIX>_CLIENT_ID` + `<PREFIX>_CLIENT_SECRET` (OAuth2 client-credentials
   *     against `<PREFIX>_TOKEN_URL`, default `{instance}/oauth_token.do`)
   * `<PREFIX>_INSTANCE_URL` also becomes available to override the base URL baked in
   * at generation time, so one binary can target any instance of the product. When
   * none of the generic env vars are set, behavior is UNCHANGED — the server falls
   * back to the advanced Hermes-managed SSO session-cookie mode. Values may be
   * supplied as `hermescred://<service>/<account>` refs in the fleetd manifest;
   * fleetd resolves those to plaintext before spawning this process. Default false
   * (existing cookie-session-only servers, e.g. akamai-wsa, are unaffected).
   */
  genericAuthFallback?: boolean;
}

/** The generated file set: relative path → file contents. */
export interface GeneratedGoServer {
  files: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Identifier / string helpers
// ---------------------------------------------------------------------------

/** Uppercase, sanitize to a valid env-var prefix ([A-Z0-9_]). */
function envPrefix(config: GoServerConfig): string {
  const raw = config.authEnvPrefix ?? config.name;
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "SERVICE";
}

/** snake_case token safe for tool names ([a-z0-9_]). */
function snake(input: string): string {
  return (
    input
      .replace(/\{[^}]*\}/g, "") // drop path-param braces
      .replace(/[^a-zA-Z0-9]+/g, "_")
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toLowerCase()
      .replace(/^_+|_+$/g, "")
      .replace(/_+/g, "_") || "op"
  );
}

/** Derive a stable tool name: "<service>_<op>". */
function toolName(config: GoServerConfig, ep: GoEndpointSpec): string {
  const svc = snake(config.name);
  const op = ep.operationId
    ? snake(ep.operationId)
    : `${ep.method.toLowerCase()}_${snake(ep.path)}`;
  return `${svc}_${op}`;
}

/** Exported Go identifier (PascalCase) from an arbitrary token. */
function goExport(input: string): string {
  const parts = snake(input).split("_").filter(Boolean);
  const id = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
  return /^[A-Za-z]/.test(id) ? id : `X${id}`;
}

/** unexported Go identifier (camelCase) from an arbitrary token. */
function goUnexport(input: string): string {
  const e = goExport(input);
  return e.charAt(0).toLowerCase() + e.slice(1);
}

/** Go string literal for a param field name from an API param name. */
function goFieldName(param: string): string {
  return goExport(param);
}

/** Escape a value for embedding in a Go double-quoted string literal. */
function goStr(s: string): string {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"';
}

// ---------------------------------------------------------------------------
// main.go
// ---------------------------------------------------------------------------

function renderInputStruct(config: GoServerConfig, ep: GoEndpointSpec): {
  typeName: string;
  code: string;
} {
  const typeName = `${goExport(toolName(config, ep))}In`;
  const fields: string[] = [];
  const seen = new Set<string>();

  for (const p of ep.pathParams ?? []) {
    const f = goFieldName(p);
    if (seen.has(f)) continue;
    seen.add(f);
    fields.push(
      `\t${f} string \`json:${goStr(p)} jsonschema:${goStr(`the ${p} path parameter (required)`)}\``,
    );
  }
  for (const q of ep.queryParams ?? []) {
    const f = goFieldName(q.name);
    if (seen.has(f)) continue;
    seen.add(f);
    const desc = q.description ?? `the ${q.name} query parameter${q.required ? " (required)" : " (optional)"}`;
    // jsonschema-go (go-sdk) marks a field REQUIRED unless the json tag carries
    // `,omitempty`. Optional query params must therefore be omitempty.
    const jsonTag = q.required ? goStr(q.name) : goStr(`${q.name},omitempty`);
    fields.push(`\t${f} string \`json:${jsonTag} jsonschema:${goStr(desc)}\``);
  }
  // Non-GET methods accept an optional raw JSON body (optional → omitempty).
  if (ep.method.toUpperCase() !== "GET" && ep.method.toUpperCase() !== "HEAD") {
    if (!seen.has("Body")) {
      fields.push(
        `\tBody string \`json:"body,omitempty" jsonschema:"raw JSON request body (optional)"\``,
      );
    }
  }

  const body = fields.length ? `\n${fields.join("\n")}\n` : "";
  return { typeName, code: `type ${typeName} struct {${body}}` };
}

function renderHandler(config: GoServerConfig, ep: GoEndpointSpec, typeName: string): {
  fnName: string;
  code: string;
} {
  const fnName = goUnexport(toolName(config, ep));
  const method = ep.method.toUpperCase();
  const lines: string[] = [];

  lines.push(
    `func ${fnName}(ctx context.Context, _ *mcp.CallToolRequest, in ${typeName}) (*mcp.CallToolResult, any, error) {`,
  );

  // Build the path from the template, validating + escaping each path param.
  // We build with fmt to keep it simple and injection-safe (url.PathEscape).
  let pathExpr = goStr(ep.path);
  for (const p of ep.pathParams ?? []) {
    const f = goFieldName(p);
    lines.push(`\t${goUnexport(p)}Val := strings.TrimSpace(in.${f})`);
    lines.push(`\tif ${goUnexport(p)}Val == "" {`);
    lines.push(
      `\t\treturn errorResult(${goStr(`${toolName(config, ep)}: ${p} is required`)}), nil, nil`,
    );
    lines.push(`\t}`);
    // Replace {p} in the path with the escaped value at runtime.
    pathExpr = `strings.Replace(${pathExpr}, ${goStr(`{${p}}`)}, url.PathEscape(${goUnexport(p)}Val), 1)`;
  }
  lines.push(`\tpath := ${pathExpr}`);

  // Query params.
  const queryParams = ep.queryParams ?? [];
  if (queryParams.length) {
    lines.push(`\tq := url.Values{}`);
    for (const qp of queryParams) {
      const f = goFieldName(qp.name);
      lines.push(`\tif v := strings.TrimSpace(in.${f}); v != "" {`);
      lines.push(`\t\tq.Set(${goStr(qp.name)}, v)`);
      lines.push(`\t}`);
      if (qp.required) {
        lines.push(`\tif in.${f} == "" {`);
        lines.push(
          `\t\treturn errorResult(${goStr(`${toolName(config, ep)}: ${qp.name} is required`)}), nil, nil`,
        );
        lines.push(`\t}`);
      }
    }
    lines.push(`\tquery := q.Encode()`);
  } else {
    lines.push(`\tquery := ""`);
  }

  // Body (non-GET).
  if (method !== "GET" && method !== "HEAD") {
    lines.push(`\tbody := in.Body`);
    lines.push(`\treturn apiCall(ctx, ${goStr(method)}, path, query, body), nil, nil`);
  } else {
    lines.push(`\treturn apiCall(ctx, ${goStr(method)}, path, query, ""), nil, nil`);
  }

  lines.push(`}`);
  return { fnName, code: lines.join("\n") };
}

/** Render the auth injection block used inside apiCall. */
function renderAuthBlock(config: GoServerConfig): string {
  const prefix = envPrefix(config);
  if (config.authScheme === "none") {
    return [
      `\t// authScheme=none — no credential injected.`,
      `\tkey := ""`,
    ].join("\n");
  }
  if (config.authScheme === "hermes-token") {
    return [
      `\tkey := resolveCredential(ctx)`,
      `\tif key == "" {`,
      `\t\treturn errorResult(${goStr(`no Hermes-managed token available — set HERMES_URL + HERMES_CLIENT_TOKEN and ensure the service is registered/acquired in Hermes`)})`,
      `\t}`,
    ].join("\n");
  }
  if (config.authScheme === "cookie-session" && config.genericAuthFallback) {
    // Generic easy path tried FIRST (Basic or OAuth2 client-credentials, both
    // configured via env / hermescred:// refs), falling back unchanged to the
    // advanced Hermes-managed SSO session-cookie mode when neither is set.
    return [
      `\tgeneric := genericAuthConfigured()`,
      `\tvar key string`,
      `\tvar genericIsBasic bool`,
      `\tif generic {`,
      `\t\tif b := basicAuthValue(); b != "" {`,
      `\t\t\tkey = b`,
      `\t\t\tgenericIsBasic = true`,
      `\t\t} else {`,
      `\t\t\ttok := resolveOAuthToken(ctx)`,
      `\t\t\tif tok == "" {`,
      `\t\t\t\treturn errorResult(${goStr(`${envPrefix(config)}_CLIENT_ID/${envPrefix(config)}_CLIENT_SECRET are set but the OAuth2 client-credentials token request failed — check the instance's OAuth application registration and ${envPrefix(config)}_INSTANCE_URL/${envPrefix(config)}_TOKEN_URL`)})`,
      `\t\t\t}`,
      `\t\t\tkey = tok`,
      `\t\t}`,
      `\t} else {`,
      `\t\tkey = resolveCredential(ctx)`,
      `\t\tif key == "" {`,
      `\t\t\treturn errorResult(${goStr(`no credential configured — set ${envPrefix(config)}_BASIC_AUTH (or ${envPrefix(config)}_USERNAME + ${envPrefix(config)}_PASSWORD) for the easy default path, ${envPrefix(config)}_CLIENT_ID + ${envPrefix(config)}_CLIENT_SECRET for OAuth2, or HERMES_URL + HERMES_CLIENT_TOKEN with a Hermes-acquired session for the advanced corporate SSO path`)})`,
      `\t\t}`,
      `\t}`,
    ].join("\n");
  }
  if (config.authScheme === "cookie-session") {
    return [
      `\tkey := resolveCredential(ctx)`,
      `\tif key == "" {`,
      `\t\treturn errorResult(${goStr(`no Hermes-managed session available — set HERMES_URL + HERMES_CLIENT_TOKEN and ensure the service session is acquired in Hermes (hermes acquire)`)})`,
      `\t}`,
    ].join("\n");
  }
  // Dual-mode: prefer the Hermes broker (when HERMES_URL + HERMES_CLIENT_TOKEN
  // are set), fall back to the ${prefix}_API_KEY / ${prefix}_TOKEN env vars.
  return [
    `\tkey := resolveCredential(ctx)`,
    `\tif key == "" {`,
    `\t\treturn errorResult(${goStr(`credential not set — enroll it in Hermes and set HERMES_URL + HERMES_CLIENT_TOKEN (broker mode), or set ${prefix}_API_KEY / ${prefix}_TOKEN`)})`,
    `\t}`,
  ].join("\n");
}

// renderCredentialResolver emits the dual-mode credential resolver for the
// generated server: it mirrors the Python path's Hermes onboarding — broker
// mode via GET {HERMES_URL}/token/{service}/{scheme} (Bearer HERMES_CLIENT_TOKEN,
// reading the bundle's accessToken), with an env-var fallback. The value is
// resolved once, cached for the process lifetime, and NEVER logged. Returns ""
// for authScheme=none (no resolver needed).
function renderCredentialResolver(config: GoServerConfig): string {
  if (config.authScheme === "none") return "";
  const prefix = envPrefix(config);

  if (config.authScheme === "hermes-token") {
    // Hermes-managed OAuth/SSO bearer: the token is acquired + refreshed by the
    // local Hermes broker; this server fetches the CURRENT bearer from
    // GET {HERMES_URL}/token/{service}/{scheme} at request time and caches it
    // briefly (Hermes refreshes proactively, so a short TTL always yields a
    // valid token). Requires HERMES_URL + HERMES_CLIENT_TOKEN. Never logged.
    // Hermes service name is used VERBATIM (registered names keep hyphens, e.g.
    // "az-teams", "azure-devops") — never snake_cased.
    const tService = config.hermesTokenService ?? config.name;
    const tScheme = config.hermesTokenScheme ?? "token";
    return `// --- credential resolution (Hermes-managed OAuth/SSO bearer token) ---

const (
	hermesService     = ${goStr(tService)}
	hermesTokenScheme = ${goStr(tScheme)}
	tokenTTL          = 60 * time.Second
)

var (
	tokMu      sync.Mutex
	tokVal     string
	tokFetched time.Time
)

// resolveCredential returns the current Hermes-managed bearer token, fetching a
// fresh one from the broker when the short-lived cache is stale. Never logged.
func resolveCredential(ctx context.Context) string {
	tokMu.Lock()
	defer tokMu.Unlock()
	if tokVal != "" && time.Since(tokFetched) < tokenTTL {
		return tokVal
	}
	if v := fetchTokenFromHermes(ctx); v != "" {
		tokVal = v
		tokFetched = time.Now()
	}
	return tokVal
}

// fetchTokenFromHermes GETs {HERMES_URL}/token/{service}/{scheme} (Bearer
// HERMES_CLIENT_TOKEN) and returns the bundle's accessToken. Returns "" on any
// failure. Never logs the token.
func fetchTokenFromHermes(ctx context.Context) string {
	base := hermesBaseURL()
	client := hermesClientToken()
	if base == "" || client == "" {
		return ""
	}
	reqURL := strings.TrimRight(base, "/") + "/token/" + hermesService + "/" + hermesTokenScheme
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return ""
	}
	req.Header.Set("Authorization", "Bearer "+client)
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
	var b struct {
		AccessToken string \`json:"accessToken"\`
	}
	if err := json.Unmarshal(body, &b); err != nil {
		return ""
	}
	return b.AccessToken
}
`;
  }

  if (config.authScheme === "cookie-session") {
    // Hermes-managed session cookie (e.g. ServiceNow SSO session): the browser
    // session is captured + refreshed by the local Hermes broker; this server
    // fetches the CURRENT session bundle from GET {HERMES_URL}/token/{service}/
    // {scheme} at request time and caches it briefly. The bundle's accessToken
    // carries the raw Cookie header string (multiple `; `-joined cookies);
    // extra.g_ck carries the CSRF token (sent as X-UserToken) for state-changing
    // requests. Requires HERMES_URL + HERMES_CLIENT_TOKEN. Neither value is ever
    // logged. The Hermes service name is used VERBATIM (e.g. "servicenow",
    // "akamai-wsa") — never snake_cased.
    const tService = config.hermesTokenService ?? config.name;
    const tScheme = config.hermesTokenScheme ?? "session";
    const genericHelpers = config.genericAuthFallback ? renderGenericAuthHelpers(config) : "";
    return `// --- credential resolution (Hermes-managed session cookie + CSRF token) ---

const (
	hermesService     = ${goStr(tService)}
	hermesTokenScheme = ${goStr(tScheme)}
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
		AccessToken string \`json:"accessToken"\`
		Extra       struct {
			GCk string \`json:"g_ck"\`
		} \`json:"extra"\`
	}
	if err := json.Unmarshal(body, &b); err != nil {
		return "", "", false
	}
	if b.AccessToken == "" {
		return "", "", false
	}
	return b.AccessToken, b.Extra.GCk, true
}
${genericHelpers}`;
  }

  const service = snake(config.name);
  const scheme = config.authScheme; // "api_key" | "bearer" — matches Python's scheme
  return `// --- credential resolution (dual-mode: Hermes broker → env fallback) ---

const (
	hermesService = ${goStr(service)}
	hermesAccount = ${goStr(scheme)}
)

var (
	credOnce sync.Once
	credVal  string
)

// resolveCredential returns the outbound API credential, preferring the Hermes
// broker (when HERMES_URL + HERMES_CLIENT_TOKEN are set) and falling back to the
// ${prefix}_API_KEY / ${prefix}_TOKEN environment variables. Resolved once and
// cached; the value is never logged or surfaced in any output.
func resolveCredential(ctx context.Context) string {
	credOnce.Do(func() {
		if v := fetchCredFromHermes(ctx); v != "" {
			credVal = v
			return
		}
		for _, envKey := range []string{${goStr(`${prefix}_API_KEY`)}, ${goStr(`${prefix}_TOKEN`)}} {
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
// GET /cred/{service}/{account} endpoint — the read side of \`hermes creds set
// {service} {account}\` — so onboarding is a single secret-safe CLI command.
// Returns "" (no error) when unset or on any failure so the caller falls back
// to env vars. Never logs the credential value.
func fetchCredFromHermes(ctx context.Context) string {
	base := hermesBaseURL()
	token := hermesClientToken()
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
		Value string \`json:"value"\`
	}
	if err := json.Unmarshal(body, &cred); err != nil {
		return ""
	}
	return cred.Value
}
`;
}

// renderGenericAuthHelpers emits the EASY generic auth path (Basic / OAuth2
// client-credentials) used alongside authScheme "cookie-session" when
// config.genericAuthFallback is set. It activates automatically based on env
// presence (no build-time flag) and takes priority over the Hermes-managed SSO
// session-cookie mode rendered above. `<PREFIX>_INSTANCE_URL` also lets one
// binary target any instance of the product, not just the one baked in as
// apiBase at generation time. Neither credential is ever logged.
function renderGenericAuthHelpers(config: GoServerConfig): string {
  const prefix = envPrefix(config);
  return `
// --- generic auth (Basic / OAuth2 client-credentials) — the EASY default path ---
//
// A stock, non-SSO instance of this product typically authenticates with a
// plain Basic-auth username + password, or an OAuth2 client-credentials
// application. This activates automatically whenever one of these env vars is
// set (values may be hermescred://${snake(config.name)}/<account> refs, resolved
// to plaintext by fleetd at spawn time — this server only ever sees the
// plaintext env var):
//
//\t${prefix}_BASIC_AUTH="user:pass"          (or ${prefix}_USERNAME + ${prefix}_PASSWORD)
//\t${prefix}_CLIENT_ID + ${prefix}_CLIENT_SECRET
//
// When neither is set, callers fall back unchanged to the advanced
// Hermes-managed SSO session-cookie mode above (corporate setups).
const (
	env${prefix}InstanceURL  = ${goStr(`${prefix}_INSTANCE_URL`)}
	env${prefix}BasicAuth    = ${goStr(`${prefix}_BASIC_AUTH`)}
	env${prefix}Username     = ${goStr(`${prefix}_USERNAME`)}
	env${prefix}Password     = ${goStr(`${prefix}_PASSWORD`)}
	env${prefix}ClientID     = ${goStr(`${prefix}_CLIENT_ID`)}
	env${prefix}ClientSecret = ${goStr(`${prefix}_CLIENT_SECRET`)}
	env${prefix}TokenURL     = ${goStr(`${prefix}_TOKEN_URL`)} // optional override; default {instance}/oauth_token.do

	oauthTokenExpirySkew = 30 * time.Second
	oauthTokenMinTTL     = 60 * time.Second
)

// instanceBaseURL returns the configured instance base URL, allowing a full
// override via ${prefix}_INSTANCE_URL so this binary works against any instance
// of the product, not just the one baked in as apiBase at generation time.
func instanceBaseURL() string {
	return envOr(env${prefix}InstanceURL, apiBase)
}

// basicAuthValue returns the "user:pass" credential for HTTP Basic auth from
// ${prefix}_BASIC_AUTH, or composed from ${prefix}_USERNAME + ${prefix}_PASSWORD.
// Returns "" when neither is configured. Never logged.
func basicAuthValue() string {
	if v := os.Getenv(env${prefix}BasicAuth); v != "" {
		return v
	}
	u, p := os.Getenv(env${prefix}Username), os.Getenv(env${prefix}Password)
	if u != "" && p != "" {
		return u + ":" + p
	}
	return ""
}

// oauthConfigured reports whether OAuth2 client-credentials env vars are set.
func oauthConfigured() bool {
	return os.Getenv(env${prefix}ClientID) != "" && os.Getenv(env${prefix}ClientSecret) != ""
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

// fetchOAuthTokenLocked performs the OAuth2 client-credentials grant against
// {instance}/oauth_token.do (or ${prefix}_TOKEN_URL when set) and returns a
// bearer access token, caching it until shortly before it expires. Returns ""
// on any failure. Never logs the token or the client secret. Caller must hold
// oauthMu.
func fetchOAuthTokenLocked(ctx context.Context) string {
	if oauthTok != "" && time.Now().Before(oauthExpiry) {
		return oauthTok
	}
	tokenURL := envOr(env${prefix}TokenURL, strings.TrimRight(instanceBaseURL(), "/")+"/oauth_token.do")
	form := url.Values{}
	form.Set("grant_type", "client_credentials")
	form.Set("client_id", os.Getenv(env${prefix}ClientID))
	form.Set("client_secret", os.Getenv(env${prefix}ClientSecret))
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
		AccessToken string \`json:"access_token"\`
		ExpiresIn   int    \`json:"expires_in"\`
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
`;
}

/** Render how the credential is attached to the outbound request. */
function renderAuthApply(config: GoServerConfig): {
  queryInject: string;
  headerInject: string;
} {
  if (config.authScheme === "api_key") {
    // Header-carried API key (e.g. figma's X-Figma-Token, netskope's
    // Netskope-Api-Token) when apiKeyHeader is set; otherwise a query param.
    if (config.apiKeyHeader) {
      return {
        queryInject: "",
        headerInject: [
          `\tif key != "" {`,
          `\t\treq.Header.Set(${goStr(config.apiKeyHeader)}, key)`,
          `\t}`,
        ].join("\n"),
      };
    }
    const qp = config.apiKeyQueryParam ?? "key";
    return {
      queryInject: [
        `\tif key != "" {`,
        `\t\tqv, _ := url.ParseQuery(query)`,
        `\t\tqv.Set(${goStr(qp)}, key)`,
        `\t\tquery = qv.Encode()`,
        `\t}`,
      ].join("\n"),
      headerInject: "",
    };
  }
  if (config.authScheme === "bearer" || config.authScheme === "hermes-token") {
    // hermes-token with an explicit raw header (e.g. Venafi X-Venafi-Api-Key): send
    // the fetched token verbatim in that header, NOT framed as `Authorization: Bearer`.
    if (config.authScheme === "hermes-token" && config.hermesTokenHeader) {
      return {
        queryInject: "",
        headerInject: [`\tif key != "" {`, `\t\treq.Header.Set(${goStr(config.hermesTokenHeader)}, key)`, `\t}`].join("\n"),
      };
    }
    return {
      queryInject: "",
      headerInject: [`\tif key != "" {`, `\t\treq.Header.Set("Authorization", "Bearer "+key)`, `\t}`].join("\n"),
    };
  }
  if (config.authScheme === "cookie-session" && config.genericAuthFallback) {
    // `generic`/`genericIsBasic` are declared in the auth block above (same
    // function scope). Generic mode: Basic (base64 "user:pass") or OAuth2
    // Bearer, no CSRF header needed (Basic/OAuth requests are exempt from
    // ServiceNow's session-CSRF check). Session mode: unchanged Cookie +
    // X-UserToken behavior.
    const cookieExpr = config.cookieName ? `${goStr(`${config.cookieName}=`)}+key` : "key";
    return {
      queryInject: "",
      headerInject: [
        `\tif generic {`,
        `\t\tif genericIsBasic {`,
        `\t\t\treq.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(key)))`,
        `\t\t} else {`,
        `\t\t\treq.Header.Set("Authorization", "Bearer "+key)`,
        `\t\t}`,
        `\t} else {`,
        `\t\tif key != "" {`,
        `\t\t\treq.Header.Set("Cookie", ${cookieExpr})`,
        `\t\t}`,
        `\t\tif ut := hermesUserToken(ctx); ut != "" {`,
        `\t\t\treq.Header.Set("X-UserToken", ut)`,
        `\t\t}`,
        `\t}`,
      ].join("\n"),
    };
  }
  if (config.authScheme === "cookie-session") {
    // `key` is the session cookie (raw Cookie header string unless cookieName is
    // set, in which case it is `<cookieName>=<value>`). The CSRF token (g_ck) is
    // sent as X-UserToken when present — required for ServiceNow writes, harmless
    // on reads.
    const cookieExpr = config.cookieName ? `${goStr(`${config.cookieName}=`)}+key` : "key";
    return {
      queryInject: "",
      headerInject: [
        `\tif key != "" {`,
        `\t\treq.Header.Set("Cookie", ${cookieExpr})`,
        `\t}`,
        `\tif ut := hermesUserToken(ctx); ut != "" {`,
        `\t\treq.Header.Set("X-UserToken", ut)`,
        `\t}`,
      ].join("\n"),
    };
  }
  if (config.authScheme === "basic") {
    // HTTP Basic: the resolved credential is the "username:token" userinfo
    // string; the server base64-encodes it (correct even if the token contains
    // colons — Basic splits on the first colon). Keeps the single-value cred
    // model: enroll "<user>:<token>" via `hermes creds set <svc> basic`.
    return {
      queryInject: "",
      headerInject: [
        `\tif key != "" {`,
        `\t\treq.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(key)))`,
        `\t}`,
      ].join("\n"),
    };
  }
  return { queryInject: "", headerInject: "" };
}

// renderToolAnnotations produces the Go `&mcp.ToolAnnotations{...}` literal for
// an endpoint's HTTP method. The Conformance Lab instrumentation gate requires
// all four hint keys present on the wire. The go-sdk marshals ReadOnlyHint /
// IdempotentHint as `bool,omitempty` (a false value is omitted), so they are
// emitted only when true; DestructiveHint / OpenWorldHint are `*bool` and are
// always emitted via boolPtr — guaranteeing all four keys serialize for the
// read-only (GET/HEAD) tools that dominate REST->MCP generation.
function renderToolAnnotations(method: string): string {
  const m = method.toUpperCase();
  const readOnly = m === "GET" || m === "HEAD";
  const idempotent = readOnly || m === "PUT" || m === "DELETE";
  const destructive = m === "DELETE";
  const lines: string[] = [];
  if (readOnly) lines.push(`\t\t\tReadOnlyHint:    true,`);
  if (idempotent) lines.push(`\t\t\tIdempotentHint:  true,`);
  lines.push(`\t\t\tDestructiveHint: boolPtr(${destructive}),`);
  lines.push(`\t\t\tOpenWorldHint:   boolPtr(true),`);
  return `&mcp.ToolAnnotations{\n${lines.join("\n")}\n\t\t}`;
}

function renderMainGo(config: GoServerConfig): string {
  const structs: string[] = [];
  const handlers: string[] = [];
  const registrations: string[] = [];

  for (const ep of config.endpoints) {
    const { typeName, code } = renderInputStruct(config, ep);
    structs.push(code);
    const { fnName, code: hcode } = renderHandler(config, ep, typeName);
    handlers.push(hcode);
    const tName = toolName(config, ep);
    const desc = ep.description ?? `${ep.method.toUpperCase()} ${ep.path}`;
    registrations.push(
      `\tmcp.AddTool(srv, &mcp.Tool{\n\t\tName:        ${goStr(tName)},\n\t\tDescription: ${goStr(desc)},\n\t\tAnnotations: ${renderToolAnnotations(ep.method)},\n\t}, ${fnName})`,
    );
  }

  const auth = renderAuthBlock(config);
  const { queryInject, headerInject } = renderAuthApply(config);
  const serverName = `${snake(config.name)}-mcp`;
  // instanceBaseURL() (env-overridable) replaces the hardcoded apiBase constant
  // ONLY for the generic-fallback cookie-session case — every other authScheme
  // (and cookie-session servers without genericAuthFallback, e.g. akamai-wsa)
  // keeps the existing apiBase-only behavior unchanged.
  const baseURLExpr =
    config.authScheme === "cookie-session" && config.genericAuthFallback ? "instanceBaseURL()" : "apiBase";

  // Help tool — required by the Conformance Lab instrumentation gate: a
  // `<serverName>_help` tool exposing a `topic` parameter and returning usage
  // text. Registered alongside the API tools below.
  const toolCatalog = config.endpoints
    .map((ep) => `- ${toolName(config, ep)}: ${ep.description ?? `${ep.method.toUpperCase()} ${ep.path}`}`)
    .join("\n");
  const helpBody = `${serverName} — thesun-generated Go MCP server (streamable-HTTP only).\n\nTools:\n${toolCatalog}\n\nCredentials are read from the environment at runtime and are never logged or surfaced in tool output.`;
  structs.push(
    `type helpIn struct {\n\tTopic string \`json:"topic,omitempty" jsonschema:"optional help topic; omit for a full overview of all tools"\`\n}`,
  );
  handlers.push(
    `// helpHandler returns static usage text for this server (Conformance Lab\n// instrumentation gate requires a <server>_help tool with a topic parameter).\nfunc helpHandler(_ context.Context, _ *mcp.CallToolRequest, _ helpIn) (*mcp.CallToolResult, any, error) {\n\treturn textResult(${goStr(helpBody)}), nil, nil\n}`,
  );
  registrations.push(
    `\tmcp.AddTool(srv, &mcp.Tool{\n\t\tName:        ${goStr(`${serverName}_help`)},\n\t\tDescription: ${goStr("Return usage help for this server and its tools. Optionally pass a topic.")},\n\t\tAnnotations: &mcp.ToolAnnotations{\n\t\t\tReadOnlyHint:    true,\n\t\t\tIdempotentHint:  true,\n\t\t\tDestructiveHint: boolPtr(false),\n\t\t\tOpenWorldHint:   boolPtr(false),\n\t\t},\n\t}, helpHandler)`,
  );

  // Dual-mode credential resolver + the extra stdlib imports it needs
  // (encoding/json, sync) — added only when the server actually authenticates.
  const needsAuth = config.authScheme !== "none";
  const credResolver = needsAuth ? `\n${renderCredentialResolver(config)}` : "";
  // Shared Hermes broker locators — used by every self-fetch credential path
  // (token/session/cred). HERMES_URL defaults to the local loopback broker, and
  // the client token falls back to ~/.hermes/client.token (the same file fleetd
  // reads) so a supervised server needs NO secret in its manifest env. The token
  // is never logged, echoed, or surfaced.
  const hermesLocators = needsAuth
    ? `
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
`
    : "";
  const stdlib = [
    // bufio, encoding/json, and path/filepath are unconditional: every
    // generated server loads <THESUN_HOME>/camouflage.json (browser
    // camouflage — see camouflageRoundTripper below) regardless of auth
    // scheme.
    "bufio", "context", "encoding/json", "errors", "fmt", "io", "log", "net",
    "net/http", "net/url", "os", "os/signal", "path/filepath", "strconv",
    "strings", "syscall", "time",
    ...(needsAuth ? ["sync"] : []),
    ...(config.authScheme === "basic" ||
    (config.authScheme === "cookie-session" && config.genericAuthFallback)
      ? ["encoding/base64"]
      : []),
  ].sort();
  const imports = stdlib.map((p) => `\t${goStr(p)}`).join("\n");

  return `// Command ${serverName} is a thesun-generated Go MCP server.
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
${imports}

	"github.com/modelcontextprotocol/go-sdk/mcp"
	utls "github.com/refraction-networking/utls"
	"golang.org/x/net/http2"
	"golang.org/x/time/rate"
)

const (
	serverName    = ${goStr(serverName)}
	apiBase       = ${goStr(config.baseUrl)} // HTTPS only
	httpTimeout   = 10 * time.Second
	maxBody       = 1 << 20 // cap response reads at 1 MiB
	shutdownGrace = 10 * time.Second

	// Outbound token-bucket rate limit — protects the upstream API (and this
	// server's own good standing) from bursty tool traffic.
	rateLimitRPS   = ${config.rateLimitRPS ?? 8}
	rateLimitBurst = ${config.rateLimitBurst ?? 4}
)

// version is stamped at build time via -ldflags="-X main.version=...".
var version = ${goStr(config.version ?? "dev")}

// httpClient enforces a hard timeout and (via the default transport) HTTPS.
// Used for the local Hermes broker and OAuth token-endpoint helpers below —
// NOT for the outbound call to apiBase, which uses camouflageClient instead
// (see the camouflage block below apiLimiter).
var httpClient = &http.Client{Timeout: httpTimeout}

// apiLimiter throttles all outbound API calls (token bucket) so a burst of tool
// invocations can never hammer the upstream API past its rate limit.
var apiLimiter = rate.NewLimiter(rate.Limit(rateLimitRPS), rateLimitBurst)

// --- Browser-fingerprint camouflage (uTLS) ---------------------------------
//
// camouflageClient is the ONLY client used for the outbound call to apiBase
// (the operator-authorized external target) — it performs a real browser TLS
// ClientHello (uTLS) instead of Go's bare net/http fingerprint, mirroring the
// guarantee thesun's Python/curl_cffi servers already provide. The
// ClientHelloID + User-Agent come from <THESUN_HOME>/camouflage.json,
// written by fleetd's internal/camouflage package from a detection of the
// OPERATOR'S OWN machine/browser; when that file is absent, unreadable, or
// names an unrecognized profile, this falls back to a recent Chrome
// ClientHello (HelloChrome_131) rather than failing the server. The local
// Hermes broker and OAuth helpers above keep using the plain httpClient —
// they are loopback/internal calls, not the operator-authorized target.

// camouflageProfile is the subset of fleetd's camouflage.Profile JSON this
// server actually needs.
type camouflageProfile struct {
	TLSProfile string \`json:"tls_profile"\`
	UserAgent  string \`json:"user_agent"\`
}

// camouflageTLSProfiles maps every tls_profile name fleetd's
// internal/camouflage package can produce to the matching utls
// ClientHelloID. Keep in sync with that package's anchor tables
// (fleet/fleetd/internal/camouflage/profile.go).
var camouflageTLSProfiles = map[string]utls.ClientHelloID{
	"HelloChrome_58":   utls.HelloChrome_58,
	"HelloChrome_62":   utls.HelloChrome_62,
	"HelloChrome_70":   utls.HelloChrome_70,
	"HelloChrome_72":   utls.HelloChrome_72,
	"HelloChrome_83":   utls.HelloChrome_83,
	"HelloChrome_87":   utls.HelloChrome_87,
	"HelloChrome_96":   utls.HelloChrome_96,
	"HelloChrome_100":  utls.HelloChrome_100,
	"HelloChrome_102":  utls.HelloChrome_102,
	"HelloChrome_120":  utls.HelloChrome_120,
	"HelloChrome_131":  utls.HelloChrome_131,
	"HelloChrome_133":  utls.HelloChrome_133,
	"HelloEdge_106":    utls.HelloEdge_106,
	"HelloSafari_16_0": utls.HelloSafari_16_0,
}

const defaultCamouflageUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

// thesunHome resolves THESUN_HOME exactly the way fleetd's
// internal/paths.Home() does: an explicit env override, else the per-OS
// user-config default. Duplicated here (rather than imported) because this
// server is an independently compilable module with no dependency on the
// fleetd source tree.
func thesunHome() string {
	if h := os.Getenv("THESUN_HOME"); h != "" {
		return h
	}
	cfg, err := os.UserConfigDir()
	if err != nil || cfg == "" {
		return filepath.Join(os.TempDir(), "thesun")
	}
	return filepath.Join(cfg, "thesun")
}

// loadCamouflageProfile reads <THESUN_HOME>/camouflage.json. Never fails to
// the caller — any problem (missing file, bad JSON, unrecognized
// tls_profile) yields the Chrome-131 default.
func loadCamouflageProfile() (utls.ClientHelloID, string) {
	data, err := os.ReadFile(filepath.Join(thesunHome(), "camouflage.json"))
	if err != nil {
		return utls.HelloChrome_131, defaultCamouflageUserAgent
	}
	var p camouflageProfile
	if err := json.Unmarshal(data, &p); err != nil || p.UserAgent == "" {
		return utls.HelloChrome_131, defaultCamouflageUserAgent
	}
	helloID, ok := camouflageTLSProfiles[p.TLSProfile]
	if !ok {
		helloID = utls.HelloChrome_131
	}
	return helloID, p.UserAgent
}

var camouflageHelloID, camouflageUserAgent = loadCamouflageProfile()

// camouflageRoundTripper performs the TLS handshake itself via uTLS (instead
// of crypto/tls) so the outbound ClientHello matches a real browser's
// JA3/JA4 fingerprint, then hands the negotiated connection to the right
// protocol layer: HTTP/2 via golang.org/x/net/http2 when ALPN negotiates h2
// (the common case against modern APIs), or a raw HTTP/1.1 request/response
// over the same connection otherwise. Non-https requests (the local Hermes
// broker) pass straight through to a plain transport — uTLS only applies to
// TLS connections.
type camouflageRoundTripper struct {
	helloID  utls.ClientHelloID
	timeout  time.Duration
	fallback http.RoundTripper
}

func (rt *camouflageRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.URL.Scheme != "https" {
		return rt.fallback.RoundTrip(req)
	}
	host := req.URL.Hostname()
	port := req.URL.Port()
	if port == "" {
		port = "443"
	}
	dialer := &net.Dialer{Timeout: rt.timeout}
	raw, err := dialer.DialContext(req.Context(), "tcp", net.JoinHostPort(host, port))
	if err != nil {
		return nil, err
	}
	uconn := utls.UClient(raw, &utls.Config{ServerName: host, NextProtos: []string{"h2", "http/1.1"}}, rt.helloID)
	if err := uconn.HandshakeContext(req.Context()); err != nil {
		_ = raw.Close()
		return nil, err
	}
	if uconn.ConnectionState().NegotiatedProtocol == "h2" {
		t2 := &http2.Transport{}
		cc, err := t2.NewClientConn(uconn)
		if err != nil {
			_ = uconn.Close()
			return nil, err
		}
		return cc.RoundTrip(req)
	}
	if err := req.Write(uconn); err != nil {
		_ = uconn.Close()
		return nil, err
	}
	return http.ReadResponse(bufio.NewReader(uconn), req)
}

// camouflageClient is used only for the outbound call to apiBase — see the
// package comment above.
var camouflageClient = &http.Client{
	Timeout: httpTimeout,
	Transport: &camouflageRoundTripper{
		helloID:  camouflageHelloID,
		timeout:  httpTimeout,
		fallback: &http.Transport{},
	},
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// boolPtr returns a pointer to b — used for the *bool tool-annotation hints
// (DestructiveHint/OpenWorldHint) so they always serialize onto the wire.
func boolPtr(b bool) *bool { return &b }
${hermesLocators}${credResolver}

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

// retryAfterDelay decides how long to wait before retrying a throttled request.
// It honors a Retry-After header in either standard form (delta-seconds, e.g.
// "120", or an HTTP-date), and when the header is absent or unparseable it falls
// back to exponential backoff (1s, 2s, 4s, ... by attempt). The returned delay
// is always clamped to maxWait so a hostile or mistaken header can never stall
// the server for long. This is a reliability helper (reactive backoff), not a
// camouflage feature.
func retryAfterDelay(header string, attempt int, maxWait time.Duration) time.Duration {
	clamp := func(d time.Duration) time.Duration {
		if d < 0 {
			return 0
		}
		if d > maxWait {
			return maxWait
		}
		return d
	}
	header = strings.TrimSpace(header)
	if header != "" {
		if secs, err := strconv.Atoi(header); err == nil {
			return clamp(time.Duration(secs) * time.Second)
		}
		if t, err := http.ParseTime(header); err == nil {
			return clamp(time.Until(t))
		}
	}
	return clamp(time.Duration(1<<uint(attempt)) * time.Second)
}

// apiCall performs an authenticated HTTP call against apiBase and returns a
// graceful MCP result. It NEVER returns the credential, or a key-bearing URL,
// in any output path.
func apiCall(ctx context.Context, method, path, query, body string) *mcp.CallToolResult {
${auth}

	reqURL := ${baseURLExpr} + path
	if strings.HasPrefix(path, "https://") || strings.HasPrefix(path, "http://") {
		reqURL = path // absolute endpoint URL (multi-host API); base prefix skipped
	}
${queryInject === "" ? "\tif query != \"\" {\n\t\treqURL += \"?\" + query\n\t}" : queryInject + "\n\tif query != \"\" {\n\t\treqURL += \"?\" + query\n\t}"}

	// reactiveMaxRetries bounds how many times a throttled request (HTTP 429 or
	// 503) is retried before the error surfaces; reactiveMaxWait caps any single
	// backoff. Together with retryAfterDelay this gives REACTIVE backoff only,
	// using nothing but net/http and time: the request rate stays a fixed token
	// bucket (apiLimiter) and narrows only after the target has already pushed
	// back. This is NOT parity with the Python path, whose AdaptiveRateLimiter
	// (src/templates/python/ratelimit.py) also reads live X-RateLimit-* response
	// headers and slows down proactively, before being throttled.
	const reactiveMaxRetries = 3
	const reactiveMaxWait = 30 * time.Second

	var respBody []byte
	for attempt := 0; ; attempt++ {
		var bodyReader io.Reader
		if body != "" {
			bodyReader = strings.NewReader(body)
		}

		req, err := http.NewRequestWithContext(ctx, method, reqURL, bodyReader)
		if err != nil {
			return errorResult("failed to build request: " + scrub(err, key))
		}
		req.Header.Set("Accept", "application/json")
		req.Header.Set("User-Agent", camouflageUserAgent)
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
${headerInject}

		if err := apiLimiter.Wait(ctx); err != nil {
			return errorResult("rate limiter aborted request: " + err.Error())
		}
		resp, err := camouflageClient.Do(req)
		if err != nil {
			return errorResult("request failed: " + scrub(err, key))
		}

		respBody, err = io.ReadAll(io.LimitReader(resp.Body, maxBody))
		resp.Body.Close()
		if err != nil {
			return errorResult("failed to read response: " + scrub(err, key))
		}

		// Reactive backoff: on HTTP 429 (Too Many Requests) or 503 (Service
		// Unavailable), wait per Retry-After (or exponential fallback) and retry
		// up to reactiveMaxRetries times so a transient upstream throttle does
		// not surface as a hard tool error.
		if (resp.StatusCode == 429 || resp.StatusCode == 503) && attempt < reactiveMaxRetries {
			timer := time.NewTimer(retryAfterDelay(resp.Header.Get("Retry-After"), attempt, reactiveMaxWait))
			select {
			case <-ctx.Done():
				timer.Stop()
				return errorResult("request canceled during retry backoff: " + ctx.Err().Error())
			case <-timer.C:
			}
			continue
		}

		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return errorResult(fmt.Sprintf("API returned HTTP %d: %s", resp.StatusCode, redact(string(respBody), key)))
		}
		return textResult(redact(string(respBody), key))
	}
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

${structs.join("\n\n")}

// ---- generated tool handlers ----

${handlers.join("\n\n")}

func main() {
	log.SetFlags(0)

	srv := mcp.NewServer(&mcp.Implementation{Name: serverName, Version: version}, nil)

${registrations.join("\n\n")}

	if err := serve(context.Background(), srv); err != nil {
		log.Fatalf("%s: %v", serverName, err)
	}
}
`;
}

// ---------------------------------------------------------------------------
// go.mod / Dockerfile / support files
// ---------------------------------------------------------------------------

function renderGoMod(config: GoServerConfig): string {
  const goVersion = config.goVersion ?? "1.26";
  const sdk = config.sdkVersion ?? "v1.6.1";
  return `module ${snake(config.name)}-mcp

go ${goVersion}

require (
	github.com/modelcontextprotocol/go-sdk ${sdk}
	github.com/refraction-networking/utls v1.8.2
	golang.org/x/net v0.38.0
	golang.org/x/time v0.8.0
)
`;
}

function renderDockerfile(config: GoServerConfig): string {
  const goVersion = config.goVersion ?? "1.26";
  const port = config.defaultPort ?? "8080";
  const serverName = `${snake(config.name)}-mcp`;
  return `# syntax=docker/dockerfile:1
# Multi-stage build → static CGO-free binary → distroless. Streamable-HTTP only.

FROM golang:${goVersion} AS build
WORKDIR /src
COPY go.mod go.sum* ./
RUN go mod download
COPY . .
# CGO disabled → fully static binary that runs on scratch/distroless.
RUN CGO_ENABLED=0 GOOS=linux go build \\
    -ldflags="-s -w -X main.version=$(cat VERSION 2>/dev/null || echo docker)" \\
    -o /out/${serverName} .

# Distroless static: no shell, no libc, nonroot by default.
FROM gcr.io/distroless/static:nonroot
COPY --from=build /out/${serverName} /${serverName}
# Bind on all interfaces inside the container so the port is reachable; the
# harness still REQUIRES MCP_PORT (no default) — set it at run time.
ENV MCP_HOST=0.0.0.0 \\
    MCP_PORT=${port}
EXPOSE ${port}
USER nonroot:nonroot
ENTRYPOINT ["/${serverName}"]
`;
}

function renderDockerignore(): string {
  return `# Keep the build context minimal.
*.md
lab-report.json
.env
.env.*
!.env.example
`;
}

function renderEnvExample(config: GoServerConfig): string {
  const prefix = envPrefix(config);
  const lines: string[] = [
    `# ${snake(config.name)}-mcp environment (streamable-HTTP transport).`,
    `# MCP_PORT is REQUIRED — the server refuses to start without it.`,
    `MCP_HOST=127.0.0.1`,
    `MCP_PORT=${config.defaultPort ?? "8080"}`,
    ``,
  ];
  if (config.authScheme === "cookie-session") {
    const hService = config.hermesTokenService ?? config.name;
    const hScheme = config.hermesTokenScheme ?? "session";
    if (config.genericAuthFallback) {
      lines.push(`# --- EASY default: generic Basic / OAuth2 (tried first) ---`);
      lines.push(`#`);
      lines.push(`# Set ONE of these for a stock, non-SSO instance (values may be`);
      lines.push(`# hermescred://${snake(config.name)}/<account> refs under fleetd):`);
      lines.push(`# ${prefix}_INSTANCE_URL=   # override the instance base URL (optional)`);
      lines.push(`# ${prefix}_BASIC_AUTH="user:pass"          # or split below`);
      lines.push(`# ${prefix}_USERNAME=`);
      lines.push(`# ${prefix}_PASSWORD=`);
      lines.push(`# ${prefix}_CLIENT_ID=`);
      lines.push(`# ${prefix}_CLIENT_SECRET=`);
      lines.push(`# ${prefix}_TOKEN_URL=   # override the OAuth token endpoint (optional)`);
      lines.push(`#`);
      lines.push(`# --- ADVANCED fallback: corporate SSO session cookie (Hermes-managed) ---`);
      lines.push(`#`);
      lines.push(`# Only used when NONE of the generic vars above are set.`);
      lines.push(`#   hermes acquire ${hService}`);
      lines.push(`# HERMES_URL=http://127.0.0.1:9876`);
      lines.push(`# HERMES_CLIENT_TOKEN=   # from ~/.hermes/client.token`);
      return lines.join("\n") + "\n";
    }
    lines.push(`# --- Session cookie (Hermes-managed, broker only) ---`);
    lines.push(`#`);
    lines.push(`# The SSO session is captured + refreshed by the local Hermes broker.`);
    lines.push(`# There is no env fallback — acquire the session once, then point this`);
    lines.push(`# server at the broker:`);
    lines.push(`#   hermes acquire ${hService}`);
    lines.push(`# HERMES_URL=http://127.0.0.1:9876`);
    lines.push(`# HERMES_CLIENT_TOKEN=   # from ~/.hermes/client.token`);
    lines.push(`#`);
    lines.push(`# At request time the server fetches the current bundle from`);
    lines.push(`# GET {HERMES_URL}/token/${hService}/${hScheme} — accessToken carries the`);
    lines.push(`# raw Cookie header string and extra.g_ck the CSRF token (X-UserToken).`);
    return lines.join("\n") + "\n";
  }
  if (config.authScheme !== "none") {
    const service = snake(config.name);
    lines.push(`# --- Credential (dual-mode: Hermes broker → env fallback) ---`);
    if (config.authScheme === "basic") {
      lines.push(`# HTTP Basic auth: the credential VALUE is "<username>:<token>"`);
      lines.push(`# (e.g. "user@example.com:abc123") — the server base64-encodes it.`);
    }
    lines.push(`#`);
    lines.push(`# EASY ONBOARDING (recommended — broker mode). Enroll the secret in`);
    lines.push(`# Hermes ONCE (the value never touches your shell history):`);
    lines.push(`#   hermes creds set ${service} ${config.authScheme}   # reads value from a hidden prompt/stdin`);
    lines.push(`# then point this server at the broker:`);
    lines.push(`# HERMES_URL=http://127.0.0.1:9876`);
    lines.push(`# HERMES_CLIENT_TOKEN=   # from ~/.hermes/client.token`);
    lines.push(`#`);
    lines.push(`# FALLBACK (standalone / no broker) — set ONE (do NOT commit real values):`);
    lines.push(`${prefix}_API_KEY=`);
    lines.push(`${prefix}_TOKEN=`);
    lines.push(`#`);
    lines.push(`# Under fleetd, prefer a hermes:// ref in fleet.toml — fleetd resolves it`);
    lines.push(`# and injects ${prefix}_API_KEY into this process's env at spawn.`);
  } else {
    lines.push(`# authScheme=none — no outbound credential required.`);
  }
  return lines.join("\n") + "\n";
}

function renderReadme(config: GoServerConfig): string {
  const serverName = `${snake(config.name)}-mcp`;
  const port = config.defaultPort ?? "8080";
  const toolList = config.endpoints
    .map((ep) => `- \`${toolName(config, ep)}\` — ${ep.method.toUpperCase()} ${ep.path}`)
    .join("\n");

  if (config.authScheme === "cookie-session") {
    const hService = config.hermesTokenService ?? config.name;
    const hScheme = config.hermesTokenScheme ?? "session";
    const prefix = envPrefix(config);
    const genericSection = config.genericAuthFallback
      ? `
## Configuration & credential onboarding (easy default + advanced fallback)

**Default (easy):** a plain HTTP Basic username/password, or an OAuth2
client-credentials application — works against any stock, non-SSO instance.
Set ONE of:

\`\`\`bash
export ${prefix}_INSTANCE_URL=https://your-instance.example.com   # optional override
export ${prefix}_BASIC_AUTH="user:pass"        # or ${prefix}_USERNAME + ${prefix}_PASSWORD
# — or —
export ${prefix}_CLIENT_ID=...
export ${prefix}_CLIENT_SECRET=...
\`\`\`

Values may be enrolled in the Hermes vault and referenced as
\`hermescred://${snake(config.name)}/<account>\` in the fleetd manifest — fleetd
resolves the reference to plaintext before spawning this process, so no secret
value ever appears in the manifest file itself.

**Advanced fallback (corporate SSO):** when NEITHER generic env var above is
set, this server falls back unchanged to the Hermes-managed SSO session
cookie:

\`\`\`bash
hermes acquire ${hService}
export HERMES_URL=http://127.0.0.1:9876
export HERMES_CLIENT_TOKEN=$(cat ~/.hermes/client.token)
\`\`\`

At request time it fetches the current session from
\`GET {HERMES_URL}/token/${hService}/${hScheme}\`. The bundle's \`accessToken\` carries
the raw \`Cookie\` header string; \`extra.g_ck\` carries the CSRF token, sent as
\`X-UserToken\` on state-changing requests. No credential of either mode is ever
logged or surfaced in tool output.
`
      : `
## Configuration & credential onboarding (Hermes-managed session)

This server authenticates with an **SSO session cookie** captured and refreshed by
the local Hermes broker. There is no environment fallback — the session cannot be
a static env var.

\`\`\`bash
hermes acquire ${hService}
export HERMES_URL=http://127.0.0.1:9876
export HERMES_CLIENT_TOKEN=$(cat ~/.hermes/client.token)
\`\`\`

At request time the server fetches the current session from
\`GET {HERMES_URL}/token/${hService}/${hScheme}\`. The bundle's \`accessToken\` carries
the raw \`Cookie\` header string; \`extra.g_ck\` carries the CSRF token, sent as
\`X-UserToken\` on state-changing requests. Neither value is ever logged or surfaced
in tool output.
`;
    return `# ${serverName}

thesun-generated Go MCP server (transport: **streamable-HTTP only** — never stdio/SSE).

## Tools

${toolList}

## Run locally

\`\`\`bash
go build -o ${serverName} .
HERMES_URL=http://127.0.0.1:9876 HERMES_CLIENT_TOKEN=$(cat ~/.hermes/client.token) \\
  MCP_HOST=127.0.0.1 MCP_PORT=${port} ./${serverName}
# MCP endpoint: POST http://127.0.0.1:${port}/mcp   (health: GET /healthz)
\`\`\`

MCP_PORT is required and has no default.
${genericSection}`;
  }

  return `# ${serverName}

thesun-generated Go MCP server (transport: **streamable-HTTP only** — never stdio/SSE).

## Tools

${toolList}

## Run locally

\`\`\`bash
go build -o ${serverName} .
MCP_HOST=127.0.0.1 MCP_PORT=${port} ./${serverName}
# MCP endpoint: POST http://127.0.0.1:${port}/mcp   (health: GET /healthz)
\`\`\`

MCP_PORT is required and has no default.

## Container

\`\`\`bash
docker build -t ${serverName} .
docker run --rm -e MCP_PORT=${port} -p ${port}:${port} ${serverName}
\`\`\`

## Configuration & credential onboarding

This server resolves its credential in **dual mode** (identical to thesun's Python
output), preferring the Hermes broker and falling back to environment variables.
The value is never logged or surfaced in tool output.

**Easy onboarding (recommended — Hermes broker).** Enroll the secret in Hermes
once — the value is read from a hidden prompt/stdin and never appears in your
shell history:

\`\`\`bash
hermes creds set ${snake(config.name)} ${config.authScheme}
export HERMES_URL=http://127.0.0.1:9876
export HERMES_CLIENT_TOKEN=$(cat ~/.hermes/client.token)
\`\`\`

When \`HERMES_URL\` + \`HERMES_CLIENT_TOKEN\` are set the server fetches the
credential from \`GET {HERMES_URL}/token/${snake(config.name)}/${config.authScheme}\`.

**Fallback (standalone).** Set \`${envPrefix(config)}_API_KEY\` (or \`_TOKEN\`) in
the environment — see \`.env.example\`.

**Under fleetd.** Put a \`hermes://\` ref in \`fleet.toml\`; fleetd resolves it and
injects the credential into this process's env at spawn — no broker vars needed
in the unit.
`;
}

// renderLabLaunch emits the Conformance Lab launch descriptor. The Lab's harness
// reads `<serverDir>/lab.launch.json` and, when present, launches the server per
// this spec instead of its Python default (`python3 server.py`). For a Go server
// the Lab compiles-and-runs via `go run .`, handing the server its assigned port
// and host through MCP_PORT/MCP_HOST (the env vars the generated harness reads).
// This is what makes `thesun verify` language-aware — the protocol, transport,
// wire-fingerprint, and credential-scan gates are transport-level and run
// unchanged once the Go server is launched correctly.
function renderLabLaunch(config: GoServerConfig): string {
  const spec: Record<string, unknown> = {
    transport: "streamable-http",
    command: "go",
    args: ["run", "."],
    portEnvVar: "MCP_PORT",
    hostEnvVar: "MCP_HOST",
    mcpPath: "/mcp",
    targetName: `${snake(config.name)}-mcp`,
  };
  // Only emit the flag when set — absence is the common case (informational
  // wire-fingerprint pass) and keeps the descriptor minimal for REST targets.
  if (config.requiresBrowserTLS) {
    spec.requiresBrowserTLS = true;
  }
  return JSON.stringify(spec, null, 2) + "\n";
}

// renderCoverage emits the coverage manifest consumed by the Lab's coverage gate.
// Every declared endpoint is deterministically mapped to exactly one generated
// tool, so spec-basis coverage is 100% by construction.
function renderCoverage(config: GoServerConfig): string {
  const ops = config.endpoints.map((ep) => ({
    path: ep.path,
    method: ep.method.toUpperCase(),
    tool: toolName(config, ep),
  }));
  const manifest = { basis: "spec", coverage_pct: 100, ops };
  return JSON.stringify(manifest, null, 2) + "\n";
}

// The gateway's manifest schema (gateway/src/manifest.ts, ManifestCapabilitySchema)
// only accepts these five HTTP methods on `http_method` — HEAD (a valid
// GoEndpointSpec.method for readOnly detection elsewhere) is deliberately not
// one of them, so a HEAD endpoint gets the field omitted rather than a value
// the gateway's own schema would reject.
const GATEWAY_HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

/** One capability entry in an isaac-router-manifest/v1 file (gateway/src/manifest.ts). */
interface GatewayManifestCapability {
  tool: string;
  safety_class: "READ" | "WRITE";
  locality: "remote" | "local";
  tags: string[];
  http_method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
}

/**
 * renderGatewayManifest emits the isaac-router-manifest/v1 safety manifest for
 * this generated backend — the same schema gateway/src/manifest.ts validates
 * and gateway/manifests/*.json ships today (hand-authored, one file per
 * backend). Emitting it here makes freshly-generated servers self-classifying
 * at generation time instead of requiring a hand-fix after the fact — the
 * shodan_dns_resolve RISKY_AS_READ bug was exactly this: a GET-backed tool
 * whose name contains a write-verb segment ("resolve") was flagged as
 * misclassified until an `http_method: "GET"` field was added by hand so the
 * gateway's WRITE_VERB_REGEX name heuristic could be overridden.
 *
 * Classification is derived, never guessed, from the same `ep.method` value
 * the coverage manifest and the "get"/"post" tag already carry — GET/HEAD are
 * READ, everything else is WRITE. This mirrors every hand-authored *-go.json
 * manifest in gateway/manifests/ (github-go, stash-go, atlassian-go,
 * netskope-go, tufin-go, venafi-go, ...) tool-for-tool, including the one
 * hand-classified exception those manifests all share: the synthetic
 * `<server>_help` tool has no HTTP method backing it (it never leaves the
 * process), so it gets `locality: "local"` and no `http_method` field.
 */
function renderGatewayManifest(config: GoServerConfig): string {
  const svc = snake(config.name);
  const serverName = `${svc}-mcp`;

  const capabilities: GatewayManifestCapability[] = config.endpoints.map((ep) => {
    const method = ep.method.toUpperCase();
    const readOnly = method === "GET" || method === "HEAD";
    const cap: GatewayManifestCapability = {
      tool: toolName(config, ep),
      safety_class: readOnly ? "READ" : "WRITE",
      locality: "remote",
      tags: [svc, method.toLowerCase()],
    };
    if (GATEWAY_HTTP_METHODS.has(method)) {
      cap.http_method = method as GatewayManifestCapability["http_method"];
    }
    return cap;
  });

  capabilities.push({
    tool: `${serverName}_help`,
    safety_class: "READ",
    locality: "local",
    tags: [svc, "help"],
  });

  const manifest = {
    manifest: "isaac-router-manifest/v1",
    backend: `${svc}-go`,
    capabilities,
  };
  return JSON.stringify(manifest, null, 2) + "\n";
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Generate a complete, compilable Go MCP server from a config.
 * Returns a map of relative-path → file-contents (no disk I/O).
 */
export function generateGoServer(config: GoServerConfig): GeneratedGoServer {
  if (!config.name || !config.name.trim()) {
    throw new Error("generateGoServer: config.name is required");
  }
  if (!config.baseUrl || !/^https:\/\//.test(config.baseUrl)) {
    throw new Error("generateGoServer: config.baseUrl must be an https:// URL");
  }
  if (!Array.isArray(config.endpoints) || config.endpoints.length === 0) {
    throw new Error("generateGoServer: at least one endpoint is required");
  }

  return {
    files: {
      "main.go": renderMainGo(config),
      "go.mod": renderGoMod(config),
      Dockerfile: renderDockerfile(config),
      ".dockerignore": renderDockerignore(),
      ".env.example": renderEnvExample(config),
      "README.md": renderReadme(config),
      "lab.launch.json": renderLabLaunch(config),
      "coverage.json": renderCoverage(config),
      "gateway-manifest.json": renderGatewayManifest(config),
    },
  };
}

/**
 * Adapt thesun's `DiscoveredEndpoint`-shaped objects (from the discovery phase
 * or a discovery-result JSON) into the generator's `GoEndpointSpec[]`.
 */
export function endpointsFromDiscovery(
  endpoints: Array<{
    path: string;
    method: string;
    operationId?: string;
    summary?: string;
    description?: string;
    parameters?: Array<{ name: string; in: string; required?: boolean; description?: string }>;
  }>,
): GoEndpointSpec[] {
  return endpoints.map((ep) => {
    const params = ep.parameters ?? [];
    return {
      method: ep.method,
      path: ep.path,
      operationId: ep.operationId,
      description: ep.description ?? ep.summary,
      pathParams: params.filter((p) => p.in === "path").map((p) => p.name),
      queryParams: params
        .filter((p) => p.in === "query")
        .map((p) => ({ name: p.name, required: p.required, description: p.description })),
    };
  });
}
