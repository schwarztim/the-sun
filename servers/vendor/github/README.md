# github-mcp (vendored default)

thesun's shipped-default GitHub server. Vendors the **official**
[`github/github-mcp-server`](https://github.com/github/github-mcp-server) (MIT
license, GitHub's own Go implementation) rather than regenerating GitHub's API
from scratch — the operator's explicit preference when one exists.

## Transport verdict (verified against source, not assumed)

The official binary ships **two** local subcommands: `stdio` and `http`. The
`http` subcommand is real, current (v1.5.0), and genuinely **streamable-HTTP**
— confirmed by reading the actual source, not the README (the README only
documents the Docker+stdio path; the native `http` subcommand isn't written up
there yet):

- `cmd/github-mcp-server/main.go` registers `httpCmd` (`Use: "http"`) alongside
  `stdioCmd`, with `--port` (default 8082), `--listen-host`, `--base-url`,
  `--base-path`.
- `pkg/http/handler.go` mounts `mcp.NewStreamableHTTPHandler(...)` from the
  **official** `github.com/modelcontextprotocol/go-sdk/mcp` package — the same
  SDK thesun's own Go server template uses (`gateway/GO-MIGRATION-DESIGN.md`
  §1). This is the real MCP streamable-HTTP transport, not a look-alike REST API.
- thesun's own `gateway/GO-MIGRATION-DESIGN.md` had already anticipated this
  exact server as the textbook **T2** case: *"third-party, native-http capable
  (github [official Go server w/ http], playwright `--port`, azure) → Run the
  vendor binary directly under the supervisor — no container, no rewrite."*
  This finding independently confirms that design note.

**Verdict: local-official.** No stdio bridging, no remote-hosted dependency
needed. ⚠️ streamable-http ONLY is thesun's absolute rule — this is satisfied
natively, nothing was bent to make it fit.

(The remote-hosted alternative, `https://api.githubcopilot.com/mcp/`, also
speaks streamable-http and takes a PAT bearer header — see the README's
"Remote GitHub MCP Server" section — but it's an external hosted dependency.
Since the local binary is fully compliant, that path isn't needed here; it's
documented as the fallback of last resort at the bottom of this file.)

## Install

```bash
brew install github-mcp-server     # official tap: homebrew-core, MIT, v1.5.0 as of 2026-07-06
# binary lands at /opt/homebrew/bin/github-mcp-server
```

(Prebuilt release archives for darwin/linux/windows also exist on the GitHub
releases page if brew isn't available; the homebrew formula is the path of
least friction on this machine.)

## Auth model — why it differs from every other vendored/generated server

Every other thesun server (generated Go servers, the `ms365` vendor) reads its
credential from **its own process env at spawn time** — fleetd resolves a
`hermes://`/`hermescred://` ref once and injects it into the child's env.

The official server's `http` mode does **not** work that way. Read from
source (`pkg/http/middleware/token.go`, `ExtractUserToken`): every request must
carry its own `Authorization: Bearer <token>` header; there is no static-token
flag or env var for `http` mode (unlike `stdio` mode, which does take
`GITHUB_PERSONAL_ACCESS_TOKEN`). This is the standard "remote MCP resource
server" pattern — the same one GitHub's own hosted
`https://api.githubcopilot.com/mcp/` uses, and the same one the thesun `ms365`
vendor doc calls out for the same reason (see its "Why no bearer token is
required here" section — same shape of problem, different resolution).

**Resolution for a single-operator local deployment:** inject the
`Authorization` header at the **gateway**, not at the server. thesun's gateway
already supports per-backend static `headers:` with `${VAR}` substitution from
its own process env (`gateway/src/config.ts`, `resolveEnvVars`) — no new
gateway code is needed. The chain, entirely reusing existing mechanisms:

```
hermes creds set github token           (one-time, operator types the PAT once)
        │
        ▼
hermescred://github/token                (Hermes vault; static credential)
        │  resolved by fleetd's existing hermes.Resolver at GATEWAY spawn time
        │  (fleetd already resolves hermes refs for ANY supervised process,
        │  not just kind="mcp" servers — see supervisor.go resolveEnv)
        ▼
GITHUB_PAT env var, in the gateway process only (never on disk, never logged)
        │  resolved by the gateway's EXISTING ${VAR} substitution at config load
        ▼
headers: { Authorization: "Bearer ${GITHUB_PAT}" }   on the github-mcp backend
        │  attached by the gateway to every proxied request
        ▼
github-mcp-server http   (extracts the header per-request, calls the GitHub API)
```

The vendor binary itself is spawned with **no credential at all** — see
`github.default.toml` part 1. The PAT only ever lives in the Hermes vault and,
transiently, in the gateway process's env — never in a manifest, never on
disk, never in a log line.

## Setup (one-time)

```bash
hermes creds set github token      # reads the PAT from a hidden prompt/stdin,
                                    # never touches shell history or a file
```

Get a PAT at https://github.com/settings/personal-access-tokens/new — grant
only what you're comfortable letting the AI act on (the official server's
`--toolsets`/`--read-only` flags can further narrow scope at spawn time
independent of the token's own grants).

## Running it (once merged)

Not yet wired into the live stack — see `github.default.toml` and
`gateway-backend.snippet.yaml` in this directory for the exact blocks; the lead
merges them into `thesun.toml` / the shared default-manifest and gateway config
in Phase 2 (this directory is a self-contained deliverable so it doesn't
collide with the concurrent M365 default-manifest work).

To run and verify standalone (what was actually done to produce the evidence
below — port 48765 chosen only to avoid the live fleet's 42011-42020/42026):

```bash
github-mcp-server http --port 48765 --listen-host 127.0.0.1
```

**Note the endpoint path:** MCP is mounted at the HTTP **root** (`/`), not
`/mcp` like every thesun-generated server (`pkg/http/handler.go`:
`r.Mount("/", h)`). Point clients at `http://127.0.0.1:<port>/`, not
`.../mcp`. (`/readonly`, `/x/{toolset}` etc. also exist for filtered modes —
see the source comment in `github.default.toml`.)

## Verification (no real PAT used — proves the mechanism, not a live account)

**1. No `Authorization` header → proper MCP-spec auth challenge:**

```bash
curl -s -i -X POST http://127.0.0.1:48765/ \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"thesun-verify","version":"1.0"}}}'
```

Result: `HTTP/1.1 401 Unauthorized` with
`Www-Authenticate: Bearer resource_metadata="http://127.0.0.1:48765/.well-known/oauth-protected-resource"`
— proves the bearer-header auth path is live and enforced on every request,
per the MCP spec's own auth-challenge convention.

**2. A syntactically-fake token (never a real PAT) → streamable-HTTP works:**

```bash
curl -s -i -X POST http://127.0.0.1:48765/ \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Authorization: Bearer ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE0000' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"thesun-verify","version":"1.0"}}}'
```

Result: `HTTP/1.1 200 OK`, `Content-Type: text/event-stream`,
`Mcp-Session-Id: <session>`, body:
`{"jsonrpc":"2.0","id":1,"result":{"capabilities":{...},"protocolVersion":"2025-06-18","serverInfo":{"name":"github-mcp-server","version":"1.5.0",...}}}`.

This confirms genuine streamable-HTTP transport (session ID, SSE-framed
response, correct `serverInfo`) end to end. The server accepts any
present bearer at `initialize` and defers actual token validation to the
first real GitHub API call the token is used against — normal OAuth
resource-server behavior, and exactly why testing this without a real PAT is
safe and conclusive: it proves the wiring, not the credential.

Both checks ran against a scratch instance on port 48765; the process was
killed immediately after and nothing was left running.

## Fallback options (not used, kept here for the record)

- **Remote-hosted official** (`https://api.githubcopilot.com/mcp/`): also
  streamable-http, also PAT-bearer (see the official README's "Remote GitHub
  MCP Server" table — `headers: { Authorization: "Bearer ${input:github_mcp_pat}" }`).
  Not chosen because the local binary is fully compliant and keeps everything
  on-box; only relevant if a future host can't run local Go binaries.
- **thesun-generated `github-go`** (`fleet/servers/generated/github/`,
  already in this repo, already streamable-http, already PAT via
  `hermescred://`/`hermes://` dual-mode env): a legitimate fallback with a
  narrower, generator-curated tool surface (44 tools) vs. the official
  server's full toolset catalog (`actions, code_quality, code_security,
  copilot, dependabot, discussions, gists, git, issues, labels,
  notifications, orgs, projects, pull_requests, repos, secret_protection,
  security_advisories, stargazers, users`, plus scope-filtered variants).
  Both can coexist on different ports/namespaces if useful; this vendor
  directory doesn't remove or alter `github-go`.
