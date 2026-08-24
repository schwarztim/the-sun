# `GoServerConfig` reference

The exact input contract for the deterministic Go emitter. This is the object
`thesun generate --lang go --file <spec.json>` builds and hands to
`generateGoServer()`.

- **Emitter:** `generator/src/generator/go-generator.ts` (`GoServerConfig`, lines 44–140; `generateGoServer`, lines 1736–1760).
- **CLI adapter:** `generator/src/cli/index.ts` (`runGoGeneration`, lines 38–165) — maps the JSON file's top-level keys onto `GoServerConfig` and defaults `authScheme` to `bearer`.

The `--file` JSON may be in **either** of two shapes; the CLI auto-detects:

1. **Discovery-result shape** — the object thesun's discovery phase emits: an
   `endpoints[]` where each endpoint has a `parameters[]` and each parameter
   carries an `in: "path" | "query"` field. Converted by `endpointsFromDiscovery()`
   (go-generator.ts:1766).
2. **Raw `GoServerConfig` shape** — you author `endpoints[]` directly as
   `GoEndpointSpec[]` (with `pathParams` / `queryParams`), no `in` field.

Detection rule (index.ts:61): if **any** endpoint has a `parameters[]` whose
entries carry `in`, the whole file is treated as discovery-shape. Otherwise it is
treated as raw `GoEndpointSpec[]`.

---

## Top-level fields

| Field | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| `name` | string | **yes** | — | Service name. Module + binary become `<snake(name)>-mcp`; tools are `<snake(name)>_<op>`. |
| `baseUrl` | string | **yes** | — | **Must be `https://…`** (validated — generation throws otherwise, go-generator.ts:1740). |
| `authScheme` | enum | no | `bearer` | One of `bearer` \| `api_key` \| `basic` \| `hermes-token` \| `cookie-session` \| `none`. Applied to **every** endpoint (see limitation below). |
| `endpoints` | array | **yes** | — | ≥1 required. Each becomes one MCP tool. |
| `version` | string | no | `dev` | Also overridable at build via `-ldflags "-X main.version=…"`. |
| `authEnvPrefix` | string | no | uppercased `name` | Env-var prefix, e.g. `SHODAN` → `SHODAN_API_KEY` / `SHODAN_TOKEN`. |
| `apiKeyQueryParam` | string | no | `key` | `api_key` scheme only: query-param name carrying the key. Ignored when `apiKeyHeader` is set. |
| `apiKeyHeader` | string | no | — | `api_key` scheme only: send key in this header (e.g. `X-Figma-Token`). **Takes precedence** over `apiKeyQueryParam`. |
| `hermesTokenService` | string | no | `name` | `hermes-token` / `cookie-session`: Hermes service name (used **verbatim** — keeps hyphens). |
| `hermesTokenScheme` | string | no | `token` (bearer) / `session` (cookie) | The `/token/<svc>/<scheme>` scheme segment. |
| `hermesTokenHeader` | string | no | — | `hermes-token`: send the fetched token verbatim in this raw header instead of `Authorization: Bearer` (e.g. Venafi `X-Venafi-Api-Key`). |
| `cookieName` | string | no | — | `cookie-session`: build `Cookie: <cookieName>=<value>`. Unset ⇒ the resolved value is the full raw Cookie header (ServiceNow case). |
| `genericAuthFallback` | boolean | no | `false` | `cookie-session`: also emit an easy Basic / OAuth2-client-credentials path tried **first**, falling back to the Hermes SSO cookie. |
| `requiresBrowserTLS` | boolean | no | `false` | Target anti-bot / JA4-fingerprints the MCP's own calls. Advisory only on the Go path today (uTLS camouflage always emitted; flag makes the Lab wire-fingerprint gate **required**). Alias: `antiBot`. |
| `rateLimitRPS` | number | no | `8` | Outbound token-bucket refill rate (req/s). |
| `rateLimitBurst` | number | no | `4` | Outbound token-bucket burst size. |
| `defaultPort` | string | no | `8080` | In-container listen port baked into the Dockerfile/`.env.example`. **Not** the fleet port — that is set at registration via `MCP_PORT`. |
| `goVersion` | string | no | `1.26` | `go` directive in `go.mod`. |
| `sdkVersion` | string | no | `v1.6.1` | `github.com/modelcontextprotocol/go-sdk` version. |

### Structural limitation — one auth scheme per server

`authScheme` (+ its `apiKeyHeader` / `apiKeyQueryParam`) is **global**. The emitter
applies the same credential injection to every endpoint (`renderAuthApply`,
go-generator.ts:774). It **cannot** branch auth per endpoint. If an API needs
different auth on different routes (e.g. a `?token=` query param on `/v1/…` but a
`Netskope-Api-Token` header on `/api/v2/…`), you must either (a) pick the one
scheme the whole API accepts (Netskope's own generated server uses `bearer`
uniformly), or (b) split it into two generated servers, one per auth regime, or
(c) hand-edit the emitted `main.go`. Do not assume the generator handles it.

---

## `GoEndpointSpec` (raw shape)

`generator/src/generator/go-generator.ts:25`.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `method` | string | **yes** | `GET` \| `POST` \| `PUT` \| `PATCH` \| `DELETE` \| `HEAD`. Drives READ/WRITE classification. |
| `path` | string | **yes** | Template relative to `baseUrl`, e.g. `/shodan/host/{ip}`. `{param}` placeholders are replaced with URL-escaped values at runtime. An absolute `https://…` path is used verbatim (multi-host APIs). |
| `operationId` | string | no | Derives the tool name + Go identifier. Falls back to `<method>_<snake(path)>`. |
| `description` | string | no | Surfaced to the MCP client. Falls back to `"<METHOD> <path>"`. |
| `pathParams` | string[] | no | Each becomes a **required** string field, `url.PathEscape`-d into the path. |
| `queryParams` | `{name, required?, description?}[]` | no | Each becomes a query field — required ones validated, optional ones `,omitempty`. |

Non-GET/HEAD endpoints also get an optional `Body` field (raw JSON string).

### Discovery-shape endpoint (the `in`-carrying form)

```jsonc
{
  "path": "/shodan/host/{ip}",
  "method": "GET",
  "operationId": "shodan_host",
  "description": "Host information for an IP",
  "parameters": [
    { "name": "ip",      "in": "path",  "required": true },
    { "name": "history", "in": "query", "required": false, "description": "include history" }
  ]
}
```

`endpointsFromDiscovery()` splits `parameters` by `in` into `pathParams` /
`queryParams` and prefers `description` over `summary`.

---

## Emitted file set (exactly 9 — no `go.sum`)

`generateGoServer()` returns these relative paths (go-generator.ts:1748):

| File | Purpose |
|------|---------|
| `main.go` | The whole server: inlined streamable-HTTP harness at `/mcp`, `/healthz`, uTLS camouflage client, rate limiter, dual-mode credential resolver, one tool per endpoint, plus a synthetic `<name>-mcp_help` tool. |
| `go.mod` | Module `<name>-mcp`; requires go-sdk, utls, `golang.org/x/net`, `golang.org/x/time`. |
| `Dockerfile` | Multi-stage → static CGO-free binary → distroless nonroot. |
| `.dockerignore` | Minimal build context. |
| `.env.example` | Documents `MCP_HOST`/`MCP_PORT` (required) + the auth env contract. |
| `README.md` | Run + credential-onboarding instructions for the chosen scheme. |
| `lab.launch.json` | Conformance Lab launch descriptor (`command: go run .`, `mcpPath: /mcp`). |
| `coverage.json` | Spec-basis coverage manifest (100% by construction). |
| `gateway-manifest.json` | `isaac-router-manifest/v1` safety manifest, backend `<name>-go`. Copy to `gateway/manifests/<name>-go.json`. |

**`go.sum` is intentionally not emitted.** Run `go mod tidy` after generation
(the CLI prints this reminder) before `go build` will succeed on a clean machine.
