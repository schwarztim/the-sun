# Onboarding a new Go MCP server in thesun

**This is THE reference for creating an MCP server as a native Go server in
thesun.** Follow it top to bottom and you get a compiling, verified,
gateway-classified, fleet-supervised server on the first try. Every step is
grounded in the real code (paths cited inline). No hedging — do exactly this.

> **Canonical repo:** this repo (`generator/`, `fleet/`, `gateway/`, `hermes/`).

> **One tool, one binary.** `thesun` (built to `bin/thesun` from
> `fleet/fleetd/cmd/thesun`) drives all four subsystems. `thesun generate` /
> `thesun verify` delegate to the Node generator (`generator/dist/cli/index.js`,
> see `cmd/thesun/main.go:38` + `stack.go:78`); the fleet/stack verbs run
> in-process. If `thesun` isn't on your PATH yet, run `./install.sh` then
> `export PATH="$PWD/bin:$PATH"`.

---

## 0. The 30-second mental model

```
REST API  ──thesun generate --lang go──▶  <svc>-mcp-go/   (main.go + 8 files)
                                              │
                                    go mod tidy && go build   ← REQUIRED, not optional
                                              │
                                    thesun verify <dir>        ← Conformance Lab, 9 gates
                                              │
   thesun add / edit thesun.toml  ──▶  fleetd supervises it on a static 42xxx port
                                              │
   copy gateway-manifest.json ──▶ gateway/manifests/<svc>-go.json ──▶ reload gateway
                                              │
                                    tool reachable through the gateway (READ/WRITE gated)
```

A generated Go server is **self-contained**: it depends only on the go-sdk +
three vendored libs, inlines its own streamable-HTTP transport, resolves its
credential from Hermes (or env) at runtime, and camouflages its outbound TLS.
fleetd supervises it; the gateway classifies and routes it.

---

## A. WHEN Go vs Python — decide once, don't re-litigate

**Go is the default. Use Go unless a hard blocker forces Python.**

`thesun generate` defaults to `--lang go` (`generator/src/cli/index.ts:179`,
`options.lang ?? 'go'`). Go servers are native, single static binaries with a
tiny footprint, supervised as one shared fleetd process — no per-server Python
venv, no interpreter startup cost.

Choose **`--lang python`** ONLY when the target needs one of:

1. **Mature browser-TLS impersonation the Go uTLS path doesn't yet cover.** The
   Go server ships uTLS camouflage (a real Chrome ClientHello — see §G), which
   covers the common anti-bot case. But if the target does aggressive JA3/JA4 +
   HTTP/2 frame fingerprinting that only `curl_cffi`'s full browser impersonation
   defeats, use Python. Signal: the config's `requiresBrowserTLS` is true AND the
   target is known to block bare uTLS. The Go CLI **warns** (does not block) in
   this case (`index.ts:97`) — the Conformance Lab wire-fingerprint gate is the
   backstop.
2. **A Python-only SDK** with no REST surface worth wrapping directly.

The discriminator is **browser-TLS need, not SSO-ness.** SSO/OAuth/cookie targets
are fully handled on the Go path via Hermes (see §C). Don't route to Python just
because auth is hard.

---

## B. GENERATE

### B.1 Author the input spec (`GoServerConfig`)

Write a JSON file describing the API. Full field reference:
[`docs/reference/go-server-config.md`](reference/go-server-config.md). Minimum:
`name`, `baseUrl` (**must be `https://`**), `authScheme`, and ≥1 `endpoints`.

**Worked example — `ipinfo` (a simple bearer-token REST API).** Save as
`ipinfo.json`:

```json
{
  "name": "ipinfo",
  "version": "1.0.0",
  "baseUrl": "https://ipinfo.io",
  "authScheme": "bearer",
  "authEnvPrefix": "IPINFO",
  "rateLimitRPS": 5,
  "rateLimitBurst": 3,
  "endpoints": [
    {
      "method": "GET",
      "path": "/{ip}/json",
      "operationId": "ipinfo_lookup",
      "description": "Full geolocation + ASN details for an IP address",
      "pathParams": ["ip"]
    },
    {
      "method": "GET",
      "path": "/{ip}/{field}",
      "operationId": "ipinfo_field",
      "description": "A single field (city, org, hostname, …) for an IP",
      "pathParams": ["ip", "field"]
    }
  ]
}
```

That is the **raw `GoEndpointSpec`** shape. If you instead have a thesun
discovery result (endpoints with `parameters[].in`), pass it as-is — the CLI
auto-detects and converts it (`index.ts:61`, `endpointsFromDiscovery`). See the
reference for both shapes.

### B.2 Run the generator

```bash
thesun generate ipinfo --lang go --file ipinfo.json --output ./ipinfo-mcp-go
```

- `--lang go` is the default but state it explicitly for clarity.
- `--file` is **required** for the Go path (`index.ts:44`). No file ⇒ hard error.
- `--output` defaults to `./<name>-mcp-go` if omitted.
- `--dry-run` lists the files it would write without writing.

The generator refuses to write if it finds a secret-shaped string in the output
(supply-chain guard, `index.ts:122`) — this catches a captured cookie/token
accidentally baked into the spec. Fix the leak and re-run; nothing is written on
a block.

**Emitted file set (exactly 9):** `main.go`, `go.mod`, `Dockerfile`,
`.dockerignore`, `.env.example`, `README.md`, `lab.launch.json`, `coverage.json`,
`gateway-manifest.json`. See `generateGoServer()`, go-generator.ts:1748.

### B.3 Resolve the module graph — **REQUIRED, do not skip**

```bash
cd ipinfo-mcp-go
go mod tidy      # populates go.sum — the generator does NOT emit one
go build ./...   # now succeeds
```

**`go.sum` is intentionally not emitted** (`renderGoServer` writes `go.mod` only).
On a clean machine `go build` fails without it. `go mod tidy` populates it. The
CLI prints this exact reminder after generating (`index.ts:162`). This is the #1
recurring "the generated server won't build" failure — it is a missing
`go mod tidy`, nothing more.

---

## C. AUTH — wire the credential

Pick `authScheme` by how the target authenticates. All schemes resolve **dual
mode**: the local Hermes broker first, env-var fallback second (except pure
cookie-session, which is broker-only). The credential is resolved once, cached,
and **never logged or surfaced in tool output** (`renderCredentialResolver`,
go-generator.ts:376).

| Target uses… | `authScheme` | Extra config | Outbound injection |
|---|---|---|---|
| `Authorization: Bearer <token>` | `bearer` | — | `Authorization: Bearer <key>` |
| API key in a query param | `api_key` | `apiKeyQueryParam` (default `key`) | `?<param>=<key>` |
| API key in a header | `api_key` | `apiKeyHeader` (e.g. `X-Figma-Token`) | `<header>: <key>` |
| `username:token` Basic | `basic` | — | `Authorization: Basic base64(user:token)` |
| OAuth/SSO bearer, Hermes-brokered | `hermes-token` | `hermesTokenService`, `hermesTokenScheme`, opt. `hermesTokenHeader` | `Authorization: Bearer <fetched>` (or raw header) |
| SSO session cookie, Hermes-brokered | `cookie-session` | `cookieName?`, `genericAuthFallback?` | `Cookie: …` + `X-UserToken` (CSRF) |
| No auth | `none` | — | nothing injected |

**The env-var contract** (dual-mode schemes): the server reads
`<PREFIX>_API_KEY` then `<PREFIX>_TOKEN` (`<PREFIX>` = `authEnvPrefix`, default
uppercased name). Under fleetd you never set these literally — you set a Hermes
**reference** and fleetd resolves it at spawn (§D).

### C.1 Enroll the secret in Hermes (secret-safe, once)

```bash
thesun secrets add ipinfo bearer      # value via hidden stdin prompt ONLY, never argv
```

`thesun secrets add|set <service> <account>` reads the value from a hidden
prompt/stdin — it never appears in argv or shell history
(`fleet/fleetd/internal/cli/secrets.go:68`). The `<account>` is conventionally
the scheme name (`bearer`, `api_key`, `basic`). For OAuth/SSO sessions use
`thesun acquire <service>` (interactive login) instead.

### C.2 The two Hermes reference schemes — know the difference

fleetd resolves two ref schemes in a manifest env value
(`fleet/fleetd/internal/hermes/hermes.go:26`):

- **`hermescred://<service>/<account>`** → broker `GET /cred/<svc>/<acct>` →
  returns a **static credential value** (API keys, PATs, Basic strings). This is
  the read side of `thesun secrets add`. **Use this for `bearer` / `api_key` /
  `basic`.**
- **`hermes://<service>/<scheme>`** → broker `GET /token/<svc>/<scheme>` →
  returns an **OAuth/session `accessToken`** the broker owns and refreshes. Use
  this for `hermes-token` / `cookie-session`.

fleetd resolves the ref to plaintext at spawn and injects it into the child's env
**only** — never to disk, logs, or the published gateway config
(hermes.go:89). If a ref can't resolve, only that one server is marked degraded;
the fleet stays up.

---

## D. FLEET REGISTRATION — put it under fleetd

fleetd supervises every server on a **static loopback port in the 42000–42999
window** (`fleet/fleetd/internal/manifest/manifest.go:19`). The manifest is
`$THESUN_HOME/thesun.toml` (default: OS user-config dir; `thesun init` scaffolds
it). Two equivalent ways to register:

### D.1 Pick a free port

Reserved shipped defaults: **42030 (ms365), 42031 (atlassian), 42032
(servicenow)**, with 42033–42039 held for future defaults
(`fleet/default-manifest.toml:15`). The live Tier-1 Go migration occupies
**42011–42020, 42026** (`gateway/config.fleet.yaml`). Pick any other free port in
range and confirm it's unused:

```bash
thesun list          # shows every supervised server's port + state
# or, against the manifest directly:
grep -R "port =" "${THESUN_HOME:-$HOME/.config/thesun}/thesun.toml"
```

The manifest **fails closed** on a duplicate port or name, or a port outside
42000–42999 (manifest.go:99). A bad port = the whole daemon refuses to start.

### D.2a Register via `thesun add` (recommended)

```bash
thesun add ipinfo-mcp \
  --cmd "/abs/path/to/ipinfo-mcp-go/ipinfo-mcp" \
  --port 42040 \
  --health /healthz \
  --max-restarts 5 \
  --env MCP_HOST=127.0.0.1 \
  --env MCP_PORT=42040 \
  --env IPINFO_API_KEY=hermescred://ipinfo/bearer
```

`thesun add` appends the `[[server]]` block, then reloads + starts it
(`cmd/thesun/main.go:113`, dispatch `fleet/fleetd/internal/cli`). `thesun.toml` is
backed up to `.bak` before every write.

- `MCP_PORT` must equal `--port` — the server **requires** `MCP_PORT` and has no
  default (`serve()`, go-generator.ts:1282); a mismatch or omission fails loudly.
- `MCP_HOST` defaults to `127.0.0.1` if unset.
- Set the credential as a `hermescred://` (or `hermes://`) ref, not a literal.

### D.2b Or edit `thesun.toml` by hand

```toml
[[server]]
name = "ipinfo-mcp"
bin = "/abs/path/to/ipinfo-mcp-go/ipinfo-mcp"
port = 42040
health = "/healthz"
max_restarts = 5
[server.env]
MCP_HOST = "127.0.0.1"
MCP_PORT = "42040"
IPINFO_API_KEY = "hermescred://ipinfo/bearer"
```

Required fields: `name`, `bin`, `port`. Defaults: `health=/healthz`,
`max_restarts=5`, `kind=mcp` (manifest.go:23). Then `thesun reload`.

> **Changed a credential?** fleetd resolves `hermescred://` only at spawn.
> `thesun secrets add/rm` prints a restart hint; run `thesun restart <name>` to
> apply it to a running server (secrets.go:261).

---

## E. GATEWAY — safety classification (READ vs WRITE)

The gateway gates every tool call by a **safety manifest**
(`isaac-router-manifest/v1`). The generator already emitted the correct one as
`gateway-manifest.json` (backend `<svc>-go`). Install it:

```bash
cp ipinfo-mcp-go/gateway-manifest.json gateway/manifests/ipinfo-go.json
```

Then make the gateway re-read its `manifests/` directory. **The gateway loads
manifests at startup only** — restart (or reload) the gateway so it picks up the
new file. Under the stack, `thesun gateway reload` or `thesun restart gateway`.

### How classification works

`gateway/src/manifest.ts` classifies each tool:

- **GET/HEAD → `READ`**, everything else → `WRITE` (derived from `ep.method`,
  never guessed). READ passes; WRITE (and every non-READ class) is **gated** —
  requires `confirmed: true` in blocking mode (`decideGate`, manifest.ts:96).
- The synthetic `<svc>-mcp_help` tool is `READ` + `locality: local` (no HTTP
  method — it never leaves the process).

The generator writes all this correctly. You only touch it if you hand-add tools.

---

## F. VERIFY + RUN

### F.1 Conformance Lab

```bash
thesun verify ipinfo-mcp-go
```

Runs 9 gates and writes `lab-report.json` (`generator/src/lab/index.ts`):
1 protocol · 2 instrumentation · 3 transport (**must be streamable-http**) ·
4 wire-fingerprint · 5 credential-scan · 6 callability · 7 precision ·
8 coverage · 9 rate-limiter. Exit 0 = PASS. A PASS means structurally valid,
alive, correctly fingerprinted, and secret-free — **not** that every endpoint was
exercised against the live API (the report lists that residual surface).

### F.2 Bring the stack up

```bash
thesun up        # starts/adopts fleetd → it supervises hermes + gateway + every server
thesun status    # one aggregated view: hermes, gateway, every server (state/health/port)
thesun doctor    # readiness diagnostics (PASS/WARN/FAIL; non-zero on any FAIL)
thesun logs ipinfo-mcp -f    # tail one server
```

fleetd brings the tree up **ordered and health-gated** — system infra (hermes →
gateway) first, then each MCP server sequentially, waiting for health before the
next (`fleet/fleetd/internal/fleet/supervisor.go:148`). A crashed server
auto-restarts with exponential backoff up to its circuit breaker. You do not
script startup — `thesun up` is the whole thing.

---

## G. CRITICAL GOTCHAS — the real failures this project has hit

Each is a "don't / do" grounded in a real bug. Read every one.

### G.1 Transport: streamable-HTTP ONLY

- **Don't** emit or wire stdio or SSE. Ever. stdio deadlocks under
  gateway/supervisor management; SSE 405s against a streamable-http backend.
- **Do** use streamable-http. Generated servers mount at **`/mcp`**
  (`mcp.NewStreamableHTTPHandler`, Stateless, go-generator.ts:1288) with
  `/healthz` alongside.
- **Exception:** official *vendored* servers may mount at the HTTP **root** `/`,
  not `/mcp`. `github-mcp-server` does — pointing its gateway backend `url` at
  `.../mcp` 404s (`servers/vendor/github/gateway-backend.snippet.yaml:5`). Check
  the vendored server's own README for its path.

### G.2 `go.sum`: run `go mod tidy` after every generation

- **Don't** `go build` a freshly-generated server on a clean machine and expect
  it to work — the generator emits `go.mod` but **not** `go.sum`.
- **Do** run `go mod tidy` first (the CLI prints this reminder, `index.ts:162`).
  This is the single most common "won't build" report. Ideally the generator
  should run it for you; until it does, it is a required manual step.

### G.3 Manifest classification: one mislabeled tool rejects the WHOLE backend

- **The bug:** a GET-backed tool whose **name** contains a write-verb segment —
  `shodan_dns_resolve` ("resolve"), any `..._set_...`, `..._update_...` — trips
  the gateway's `WRITE_VERB_REGEX` heuristic. If such a tool is classed `READ`
  **without** an `http_method`, the manifest fails `RISKY_AS_READ` validation and
  the gateway **rejects the entire backend manifest** (`validateManifestSemantics`
  + `loadDir`, manifest.ts:150/238). Every tool on that backend then falls to
  `UNCLASSIFIED` = fail-closed = **blocked** in blocking mode.
- **Do** ensure each capability carries `http_method` (`GET`/`POST`/…). A
  `http_method: "GET"` overrides the name heuristic — a GET is read-safe
  regardless of its name (manifest.ts:167). **The generator emits this
  correctly** (`renderGatewayManifest`, go-generator.ts:1707). The gotcha bites
  only if you hand-edit a manifest and drop `http_method` from a
  write-verb-named GET tool.

### G.4 Per-endpoint auth: the generator applies ONE scheme uniformly

- **The reality:** `GoServerConfig.authScheme` is **global** — the emitter injects
  the same credential the same way on every endpoint (`renderAuthApply`,
  go-generator.ts:774). It **cannot** branch auth per route.
- **The trap:** some APIs authenticate differently per endpoint — e.g. Netskope
  v1 (`/api/v1/…`) historically took a `?token=` query param while v2
  (`/api/v2/…`) requires the `Netskope-Api-Token` **header**; sending the wrong
  one returns "Invalid REST API Token" even with a valid key.
- **Do** one of: (a) use the single scheme the whole API accepts — the shipped
  `netskope-go` server uses `bearer` uniformly across v1 + v2; (b) split into two
  generated servers, one per auth regime; or (c) hand-edit `main.go`. Do **not**
  assume the generator branches for you.

### G.5 Camouflage uTLS: only real utls ClientHello constants compile

- **Don't** add a `HelloChrome_106` / `_112` / `_114` / `_115` to the camouflage
  map — those bare constants **don't exist** in `refraction-networking/utls` (the
  real ones are suffixed `_Shuffle` / `_PSK`), so they fail to compile.
- **Do** use only the constants the generator's map already lists
  (go-generator.ts:1067): Chrome `58, 62, 70, 72, 83, 87, 96, 100, 102, 120, 131,
  133`, plus `HelloEdge_106` and `HelloSafari_16_0`. This map is **baked into the
  generator** and mirrors `fleet/fleetd/internal/camouflage/profile.go` — the
  operator never edits it per-server. It matters only if you touch the generator
  or that fleetd package. The server picks its profile from
  `<THESUN_HOME>/camouflage.json` at runtime and **falls back to
  `HelloChrome_131`** on any miss (never fails).

### G.6 Startup: never mass-parallel-start the fleet

- **Don't** start every server at once. A burst of concurrent starts trips
  circuit breakers via a reload cascade — health churn re-trips healthy servers.
  Proven 2026-07-06; serial one-at-a-time recovery was required three times
  before the fix.
- **Do** let fleetd do it: `thesun up` starts the tree **serially, health-gated**
  (supervisor.go:148). Recovery of individual servers is also one-at-a-time. Don't
  script your own parallel start loop around it.

### G.7 Right repo, right binary

- **Do** work in this repo. Edits made anywhere else don't ship.
- **Do** use the one `thesun` binary for everything. `thesun generate`/`verify`
  are the same tool as `thesun up`/`add`/`secrets`; it delegates to the Node
  generator internally (`cmd/thesun/main.go:38`).

---

## H. End-to-end checklist

```
[ ] Go chosen deliberately (Python only for browser-TLS-hard / Python-SDK targets)
[ ] Spec written: name, https baseUrl, authScheme, ≥1 endpoints
[ ] thesun generate <svc> --lang go --file spec.json
[ ] cd <dir> && go mod tidy && go build ./...        ← go.sum step, non-negotiable
[ ] Credential enrolled: thesun secrets add <svc> <acct>   (stdin only)
[ ] Free 42xxx port picked (avoid 42011-42020, 42026, 42030-42032)
[ ] Registered: thesun add … --env MCP_PORT=<port> --env <PREFIX>_API_KEY=hermescred://<svc>/<acct>
[ ] cp gateway-manifest.json gateway/manifests/<svc>-go.json  &&  reload gateway
[ ] thesun verify <dir>            → PASS
[ ] thesun up && thesun status     → server healthy
[ ] thesun doctor                  → no FAIL
```

If a step fails, the failure is almost always G.2 (missing `go mod tidy`), a
port collision (D.1), or a hand-edited manifest missing `http_method` (G.3).
