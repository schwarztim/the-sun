# Golden Fixtures -- Conformance Lab Pinned Reference

Stage 1 deliverable (see `~/.claude/plans/draft-the-implementation-plan-cosmic-moth.md`).
Hand-built Python/FastMCP servers the Conformance Lab (Stage 2, `src/lab/`,
separate TS code) must PASS or FAIL for specific, isolated reasons. Each
fixture uses the full generated-server stack from Stage 3
(`src/templates/python/{http_client,ratelimit,auth}.py`, copied verbatim into
every fixture directory -- exactly how the real generator will copy them into
every server it produces).

## Layout

```
golden-servers/
├── pyproject.toml          deps for a fresh `uv sync` (fastmcp/curl_cffi/httpx/aiolimiter/tenacity/mcp)
├── verify_golden_servers.py  standalone verification harness (this agent's evidence; not the Lab itself)
├── _mock_target/           shared plain-HTTP mock backend -- TEST INFRASTRUCTURE, not a Lab fixture
│   └── app.py
├── rest-bearer/            PASS fixture 1: spec-backed REST, bearer auth, cursor pagination
├── cookie-session/         PASS fixture 2: hand-written tools, cookie/session auth
├── outlier/                PASS fixture 3: hand-written tools, GraphQL + API-key auth
├── _broken/                FAIL fixture: malformed tool, crashes at import (never binds a port)
├── _stdio/                 FAIL fixture: protocol-valid MCP server, wrong transport (stdio)
└── _ua-mismatch/           FAIL fixture: protocol-valid, but egress doesn't match claimed browser identity
```

**Only `rest-bearer/`, `cookie-session/`, `outlier/`, `_broken/`, `_stdio/`,
`_ua-mismatch/` are fixtures for the Lab to spawn.** `_mock_target/` is shared
test plumbing (stdlib-only fake backend the three PASS fixtures call) and
`verify_golden_servers.py`/`pyproject.toml`/this README are harness/docs, not
servers.

## What each fixture proves

| Fixture | Structural shape | Auth scheme | Should the Lab... |
|---|---|---|---|
| `rest-bearer/` | `FastMCP.from_openapi()` -- deterministic generation path, zero hand-written tool code | `bearer` | **PASS** all gates |
| `cookie-session/` | Hand-written `@mcp.tool` functions -- the undocumented-target path | `session` (Cookie header) | **PASS** all gates |
| `outlier/` | Hand-written tools, single-endpoint GraphQL (`POST /graphql`, `{query,variables}` body, errors in JSON not just status) | `api_key` (`X-API-Key` header) | **PASS** all gates |
| `_broken/` | Tool annotated with an undefined forward-ref type (`x: "NonExistentType"`) | n/a | **FAIL** at spawn -- process exits non-zero before any port opens, stderr shows `NameError` |
| `_stdio/` | Otherwise-correct server; `mcp.run_async(transport="stdio")` instead of `"streamable-http"` | `bearer` | **FAIL** transport gate only -- connecting to its configured HTTP port gets nothing (no socket ever opens); it IS a valid MCP server over stdio (verified) |
| `_ua-mismatch/` | Otherwise-correct server; imports `httpx.AsyncClient()` directly instead of `http_client.build_http_client()`, but hand-stamps Chrome-looking `User-Agent`/`Sec-CH-UA*` headers | `bearer` | **FAIL** wire-fingerprint gate only -- protocol/transport/tool-call all pass; `http_client.py` sits unused right next to `server.py` (`grep -L build_http_client _ua-mismatch/server.py` shows it's not imported) |

Each FAIL fixture is designed to fail for exactly **one** gate so the Lab's
gates can be shown to discriminate independently, not just rubber-stamp
everything that starts.

## Credential-free callability (Lab Gate 6)

Every PASS fixture resolves `get_auth_headers()` **lazily**, per tool call --
never at import/startup. This is deliberate and load-bearing: `auth.py`'s
`get_token()` raises `RuntimeError` when no credential is configured and
Hermes isn't reachable, and if that call happened at server startup the
process would crash before ever answering `initialize`. Verified
(2026-07-02): a `rest-bearer` instance started with **zero** credentials
configured answers `initialize`/`listTools` normally; only `callTool` fails,
and it fails as a well-formed MCP tool error (`isError=true`, human-readable
message), not a transport-level crash:

```
isError= True
content= Error calling tool 'listItems': No credential for rest_bearer: set
HERMES_URL/HERMES_CLIENT_TOKEN or REST_BEARER_TOKEN/_API_KEY/_SESSION
```

- `rest-bearer/`: auth is wired via a small `httpx.Auth` subclass
  (`_LazyBearerAuth` in `server.py`) attached to `client.auth` post-construction,
  since `FastMCP.from_openapi` only takes a pre-built client and
  `build_http_client()`'s `default_headers` param would force eager resolution.
- `cookie-session/` / `outlier/` / `_stdio/` / `_ua-mismatch/`: hand-written
  tools call `await get_auth_headers()` inside the tool body, per call.

## Known upstream gap (found while building these fixtures)

`src/templates/python/http_client.py`'s `CurlCffiTransport` only forwarded a
**hardcoded 4-header allowlist** (`authorization`, `content-type`, `accept`,
`accept-language`) from the caller's `httpx.Request` into the actual
curl_cffi call -- silently dropping every other header, including `Cookie`
(SCHEME=session) and `X-API-Key` (SCHEME=api_key). Since `auth.py` documents
exactly three schemes (bearer/api_key/session) and only one of the three
produces an `Authorization` header, this broke 2 of the 3 documented auth
schemes for every server built on the template, not just these fixtures.

Verified failure mode (2026-07-02): `cookie-session` and `outlier` returned
well-formed 401s from the mock target even with a **correct** credential
configured, because the Cookie/X-API-Key header never left the process.

**This repo's hard rule confines this agent to `test-fixtures/golden-servers/**`**,
so the fix is applied **locally, in each fixture's copy** of `http_client.py`
only (forward every caller header that isn't an identity/fetch header,
instead of a fixed 4-name allowlist -- see the `GOLDEN-FIXTURE PATCH` comment
block in any fixture's `http_client.py`, e.g. `rest-bearer/http_client.py:108`).
**The canonical fix still needs to land in `src/templates/python/http_client.py`**
(owned by Stage 0/3, outside this agent's write scope) -- otherwise every
future `session`/`api_key`-auth generated server inherits the same silent
auth failure. Flagging this for whoever owns that file / the team lead.

## Verification

`verify_golden_servers.py` is a standalone Python harness (not the Lab
itself -- that's Stage 2's TS code) that spawns each fixture, speaks real MCP
protocol via the Python SDK (`mcp` 1.28.1, same protocol family the Lab's TS
SDK client speaks), and prints evidence for each. Run with the Stage-0 spike
venv (already has fastmcp/curl_cffi/httpx/aiolimiter/tenacity/mcp installed)
or a fresh `uv sync` in this directory:

```bash
# using the existing spike venv:
~/Scripts/mcp-servers/thesun/test-fixtures/spike/.venv/bin/python \
    test-fixtures/golden-servers/verify_golden_servers.py

# OR a fresh venv:
cd test-fixtures/golden-servers && uv venv && uv pip install -e . && \
    .venv/bin/python verify_golden_servers.py
```

Exit 0 = every PASS fixture passed and every FAIL fixture failed exactly as
designed; exit 1 = something misbehaved, printed in the SUMMARY block.

**Last verified run (2026-07-02, spike venv):** all 6 fixtures behaved
correctly -- `initialize`/`listTools`/`callTool` round-tripped real data for
all three PASS fixtures (bearer-paginated items, cookie-authenticated
profile, GraphQL viewer/mutation), `_stdio` proved protocol-valid-but-
transport-invalid, `_broken` crashed at import with `NameError` before
binding any port, `_ua-mismatch` proved protocol-valid with `http_client.py`
present-but-unwired. Both READ (`listItems`/`get_profile`/`graphql_viewer`)
and WRITE (`createItem`/`add_profile_note`/`graphql_create_widget`) tools
were exercised against real credentials with real 2xx responses from
`_mock_target`.

## Running a fixture manually

Each PASS/`_stdio`/`_ua-mismatch` fixture needs the mock backend running
first:

```bash
python _mock_target/app.py 8790 &   # or 0 for an OS-assigned port; prints the bound port

# rest-bearer (streamable-http on :8801, mcp endpoint at /mcp)
cd rest-bearer
PORT=8801 MOCK_API_BASE_URL=http://127.0.0.1:8790 \
    REST_BEARER_TOKEN=golden-bearer-secret python server.py

# cookie-session (streamable-http on :8802)
cd cookie-session
PORT=8802 MOCK_API_BASE_URL=http://127.0.0.1:8790 \
    COOKIE_SESSION_SESSION="session=golden-session-abc123" python server.py

# outlier / GraphQL (streamable-http on :8803)
cd outlier
PORT=8803 MOCK_API_BASE_URL=http://127.0.0.1:8790 \
    OUTLIER_GRAPHQL_API_KEY=golden-apikey-secret python server.py

# _stdio (no port -- speaks MCP over stdio only)
cd _stdio
STDIO_FIXTURE_TOKEN=golden-bearer-secret MOCK_API_BASE_URL=http://127.0.0.1:8790 python server.py

# _ua-mismatch (streamable-http on :8806)
cd _ua-mismatch
PORT=8806 MOCK_API_BASE_URL=http://127.0.0.1:8790 \
    UA_MISMATCH_FIXTURE_TOKEN=golden-bearer-secret python server.py

# _broken -- crashes immediately, no env needed
cd _broken && python server.py
```

The MCP endpoint path for every streamable-http fixture is `/mcp`
(FastMCP's default `streamable_http_path`), e.g.
`http://127.0.0.1:8801/mcp`.

Default mock credentials (override via `MOCK_BEARER_TOKEN` /
`MOCK_SESSION_COOKIE` / `MOCK_API_KEY` env vars on `_mock_target/app.py`):

| Credential | Default value |
|---|---|
| Bearer token | `golden-bearer-secret` |
| Session cookie (full `Cookie:` value) | `session=golden-session-abc123` |
| API key | `golden-apikey-secret` |

## Interface assumptions for the Lab agent

- **Transport**: streamable-http, MCP endpoint at `/mcp`, host/port controlled
  by `HOST`/`PORT` env vars (defaults: `127.0.0.1`, and
  8801/8802/8803/8806 respectively -- but the Lab should assign its own free
  port via these env vars rather than relying on the defaults, to run fixtures
  concurrently/repeatedly without collisions).
- **Readiness**: no separate health endpoint. Poll `initialize` itself (bounded
  retry, e.g. 150ms interval / ~10s ceiling) -- this is what
  `verify_golden_servers.py._wait_ready_http` does and it's the same pattern
  the plan calls for in Stage 2.
- **`_broken/` never opens a port.** The Lab's spawn harness must treat "process
  exited non-zero within the readiness window" as a distinct, correctly-
  diagnosed failure (not lumped in with a generic timeout) -- stderr contains
  `NameError` at the top of the traceback.
- **`_stdio/` never opens a port either** (by design -- it's stdio-only). If the
  Lab's harness is HTTP-only, this fixture surfaces as "no listener at
  host:port" and the Lab should attribute that to the transport gate. If the
  Lab wants to positively confirm the server IS otherwise valid (stronger,
  more specific finding), it can additionally speak stdio to it exactly as
  `verify_golden_servers.py.verify_stdio_fixture` does (Python SDK
  `mcp.client.stdio.stdio_client`; the Lab's TS SDK has an equivalent
  `StdioClientTransport`).
- **`_ua-mismatch/` needs a real wire-capture** (Stage 0's mechanism) to fail --
  it is indistinguishable from `rest-bearer`-style fixtures at the MCP-protocol
  layer by design. This fixture is only useful once Stage 2's wire-fingerprint
  gate exists; it will pass every gate this agent's harness can check.
- **Mock target must be started before the three PASS/`_stdio`/`_ua-mismatch`
  fixtures** and its base URL passed via `MOCK_API_BASE_URL`. `_broken` doesn't
  need it (crashes before making any request).
- **Each fixture directory is self-contained** (own copies of
  `http_client.py`/`ratelimit.py`/`auth.py`, no shared `sys.path` dependency on
  `src/templates/python/`) -- exactly how a real generated server ships, so
  the Lab can `cp -r` or spawn any fixture directory in isolation.
