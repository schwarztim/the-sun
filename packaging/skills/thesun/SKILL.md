---
name: thesun
description: >-
  Generate a verified MCP server from any REST API: an OpenAPI spec, a URL/service
  name, or a browser/HAR capture of an undocumented app. Produces GO servers by
  default (streamable-http only, browser-realistic uTLS ClientHello fingerprint,
  adaptive outbound rate limiting, dual-mode Hermes auth, secrets never emitted),
  with Python/FastMCP available via `--lang python`. Every result is gated on the
  Conformance Lab (`thesun verify`). USE WHEN the user wants to create/build/make an
  MCP for a service, API, or tool that has no existing MCP; says "thesun X", "create
  an MCP for X", "build me an MCP", "wrap the X API"; or wants to interact with an
  API Claude cannot otherwise reach. Accepts natural language, a target name, a
  spec/HAR path, or a batch list; anything after the invocation is the input.
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
  - Task
  - WebSearch
  - WebFetch
  - AskUserQuestion
---

# thesun: Generate a verified MCP server

Autonomous REST-API to MCP-server generator. The generator (a TypeScript CLI, package
name `thesun`, bin `thesun` -> `dist/cli/index.js`) lives at
`~/Projects/thesun/generator`. It produces **Go** servers by default (native, low
footprint, single shared instance, uTLS browser-realistic TLS fingerprint); Python/FastMCP
is the opt-in via `--lang python`. This skill is the global entry point: it drives that
repo's pipeline and gates the output on the Conformance Lab.

## Input

Everything after the invocation is the target. All of these are valid:

```
/thesun stripe
/thesun venafi ~/docs/venafi-openapi.yaml
/thesun wrap the internal orders app at https://orders.acme.corp   (undocumented, browser capture)
/thesun crowdstrike, datadog, tufin                                (batch)
/thesun rebuild the servicenow MCP, it's broken                    (fix mode)
```

## Preflight (always)

1. `REPO=~/Projects/thesun/generator`. If `$REPO` is missing, tell the user and stop.
2. Ensure the CLI/Lab are built: if `$REPO/dist/cli/index.js` is absent, run
   `npm --prefix "$REPO" install && npm --prefix "$REPO" run build`.
3. For a **Go** target, ensure a Go toolchain (`go version`) is on PATH so the output can
   be compiled/verified (`go mod tidy && go build ./...`). For a **Python** target, ensure a
   Python toolchain with the generated-server deps (fastmcp, curl_cffi, httpx, aiolimiter,
   tenacity, mcp) is available for `thesun verify`, e.g. a `uv venv` in the generated dir.

## The Go default path is deterministic and needs a discovery/spec JSON

`generate --lang go` is a **deterministic** generator: it bypasses the agentic orchestrator
on purpose so its output is verifiable with `go build ./...`. It does NOT run discovery for
you. It reads one JSON file (`-f <spec.json>`) that already describes the API, and writes a
compilable Go MCP server (`main.go` + `go.mod` + `Dockerfile` + support files) to the output
dir. So the pipeline is: produce the discovery/spec JSON first (Discover), then generate,
then verify.

### The spec JSON shape (what `-f` must contain)

A single JSON object. Top-level service fields plus a non-empty `endpoints` array.
`runGoGeneration` reads exactly these keys (unknown keys are ignored):

```jsonc
{
  "name": "shodan",                    // service name; module becomes "<name>-mcp" (alias: "toolName")
  "baseUrl": "https://api.shodan.io",  // HTTPS API base URL
  "version": "dev",                    // optional
  "authScheme": "api_key",             // bearer | api_key | basic | hermes-token | cookie-session | none
  "authEnvPrefix": "SHODAN",           // optional; defaults to uppercased service name
  "apiKeyQueryParam": "key",           // api_key: query param carrying the key (default "key")
  "apiKeyHeader": "X-Figma-Token",     // api_key: send key in this header instead (takes precedence)
  "rateLimitRPS": 1,                   // optional outbound token-bucket rate (default 8)
  "rateLimitBurst": 2,                 // optional burst (default 4)
  "hermesTokenService": "servicenow",  // hermes-token / cookie-session: Hermes service name (verbatim)
  "hermesTokenScheme": "token",        // hermes-token scheme, or session scheme for cookie-session
  "hermesTokenHeader": "X-Venafi-Api-Key", // hermes-token: send token verbatim in this header, not Bearer
  "cookieName": "JSESSIONID",          // cookie-session: build Cookie as "<cookieName>=<value>"
  "requiresBrowserTLS": true,          // target does anti-bot/JA4 fingerprinting (alias: "antiBot")
  "endpoints": [
    {
      "method": "GET",
      "path": "/shodan/host/{ip}",     // {param} braces mark path params
      "operationId": "hostInfo",       // used to derive the tool name
      "description": "Return all services observed on an IP",
      "parameters": [
        { "name": "ip", "in": "path", "required": true },
        { "name": "history", "in": "query", "required": false, "description": "Show historical banners" }
      ]
    }
  ]
}
```

Two `endpoints` shapes are accepted:

- **Discovery shape (preferred):** each endpoint has a `parameters` array whose entries
  carry an `in` field (`"path"` or `"query"`). This is exactly the per-endpoint shape an
  OpenAPI spec or a HAR capture yields; the CLI auto-detects it and converts path/query
  params for you.
- **Raw shape:** each endpoint instead carries `pathParams: string[]` and
  `queryParams: [{name, required?, description?}]` directly.

Each endpoint becomes one MCP tool named `<service>_<operationId>` (a `<name>-mcp_help`
tool is always added). Non-GET/HEAD methods also get an optional raw-JSON `body` field.

### How the discovery/spec JSON is produced

- **From an OpenAPI/Swagger spec** (a path or URL was provided): parse it and emit one
  `endpoints` entry per path+method, copying `operationId`, `summary`/`description`, and each
  parameter as `{name, in, required, description}`. Map `securitySchemes` to the right
  `authScheme` (bearer/api_key/basic; SSO/OAuth/session targets to `hermes-token` or
  `cookie-session`). Set `baseUrl` from the spec `servers`.
- **From a bare service name** (research): run discovery/research to find the API. Use the
  repo's research assets under `$REPO/.claude-plugin/`: the `api-researcher` agent
  (`skills/research-api.md`) and the `mcp-optimizer` PRE-generation intelligence
  (`skills/optimize-mcp-creation.md`) produce the endpoint inventory, auth method, and rate
  limits. Fold that into the spec JSON above.
- **From an undocumented app** (a URL): capture real traffic. The `/sun-auth <service> <url>`
  companion captures a session (Hermes brokers it at runtime); the observed request set
  becomes the `endpoints` array (this observed set is also the coverage denominator the Lab
  scores against). If the target does anti-bot/JA4 fingerprinting, set `requiresBrowserTLS: true`;
  the Go path already provides a browser-realistic uTLS ClientHello, so no language switch is
  needed and the Lab's wire-fingerprint gate then applies.

Stage the JSON somewhere stable (e.g. `~/.thesun/blueprints/<target>-spec.json`).

## Pipeline

Read and follow these repo files; they are the authoritative pipeline docs, so do not
reproduce them from memory:

- `$REPO/.claude-plugin/skills/optimize-mcp-creation.md`: the end-to-end autonomous pipeline
  (research -> generate -> Conformance Lab hard gate -> auto-fix -> report).
- `$REPO/.claude-plugin/skills/research-api.md` and `agents/api-researcher.md`: discovery.
- `$REPO/.claude-plugin/agents/{mcp-optimizer,mcp-builder}.md`: intelligence and generation.

Execute for the target:

1. **Discover:** produce the spec/discovery JSON described above (spec-parsed, researched,
   or HAR-captured).
2. **Generate (Go default):** pick an output dir (e.g. `~/Scripts/mcp-servers/<target>-mcp-go`):
   ```bash
   node "$REPO"/dist/cli/index.js generate --lang go -f <spec.json> -o <outdir>
   ```
   Useful flags: `--dry-run` (list files without writing), `-t/--tool <name>` (fallback
   service name when the JSON omits one). The generator refuses to write if any generated file
   contains a secret-shaped string (e.g. a captured session cookie); move it to Hermes/env and
   regenerate. Then compile: `cd <outdir> && go mod tidy && go build ./...`.

   **Python opt-in** (`--lang python`): use when a target needs the richer agentic
   FastMCP/`from_openapi` path, deep SDK/CLI marrying, or the full optimizer loop rather than a
   deterministic endpoint-to-tool mapping. Invoke `node "$REPO"/dist/cli/index.js generate
   --lang python -t <target> -o <outdir>` (drives the internal orchestrator/StateMachine), or
   run the agentic `optimize-mcp-creation` pipeline. Python servers copy the
   `src/templates/python/` http_client/ratelimit/auth templates and run
   `mcp.run(transport="streamable-http", ...)`.

3. **Verify (hard gate):**
   ```bash
   node "$REPO"/dist/cli/index.js verify <outdir>
   ```
   The Lab spawns the server, speaks real MCP protocol, and asserts on captured wire bytes
   across its gates (protocol, instrumentation, transport, wire-fingerprint, credential scan,
   callability, precision, coverage, rate-limiter). Options: `--target <name>` (defaults to the
   dir basename), `--live` (opt-in live-credential smoke path). Non-zero exit means fail. Read
   `<outdir>/lab-report.json`, fix the specific failing gate(s), and re-run (max ~5 iterations).
   Do not consider generation complete until `thesun verify` passes.
4. **Report:** target, tool list, auth mode, language, and the Lab verdict. State plainly what
   a PASS does NOT cover (semantic correctness, live-target/WAF acceptance) from the report's
   `residualUnverifiedSurface`.

## Modes

- **Fix** an existing MCP: follow `$REPO/.claude-plugin/skills/fix-mcp.md`. For a Go server,
  regenerate from an updated spec JSON and re-verify; for a Python server, the agentic FIX path
  validates and repairs in place.
- **Auth capture** for an undocumented app: `/sun-auth <service> <url>` captures a session;
  Hermes brokers it at runtime. Generated Go servers fetch the current token/session from the
  local Hermes broker (`hermes-token` / `cookie-session` schemes) and fall back to env vars.
- **Batch**: produce a spec JSON per target and run the Discover -> Generate -> Verify pipeline
  for each; report a summary table.

## Guardrails

- **Streamable-http only.** Generated servers serve `/mcp` over streamable-http (Go inlines the
  transport harness). Never stdio, never SSE. The Lab is invoked via the `thesun verify` CLI,
  not an MCP transport.
- **Secrets never emitted.** Credentials are read from the environment / Hermes broker at
  runtime and are never logged, echoed, or written into generated source. The generator blocks
  on any secret-shaped string in its output before writing.
- **Auth is Hermes-brokered** (dual-mode: broker when `HERMES_URL` + `HERMES_CLIENT_TOKEN` are
  set, env-var fallback otherwise) and mirrors the operator's own access; governance is external.
- **A Lab PASS is necessary, not sufficient.** It means structurally valid, alive, and correctly
  fingerprinted. It does NOT prove semantic correctness or live-target/WAF acceptance; egress
  leaves the operator's own machine and camouflage is fingerprint fidelity only.
