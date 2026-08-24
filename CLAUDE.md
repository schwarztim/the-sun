# thesun

> Project guidance for `thesun`. This file is the practical working guide for contributors
> (human or AI); `docs/SECURITY-MODEL.md` is the authoritative security doc (code wins on
> conflict).

## What thesun is

One CLI that **generates, runs, routes, and authenticates** MCP servers, with no Docker and no
ToolHive. Four subsystems behind a single `thesun` binary:

- **`generator/`** (TypeScript, bin `thesun` -> `dist/cli/index.js`): turns a REST API into an MCP
  server. Defaults to **Go** output (`generate --lang go`); Python/FastMCP via `--lang python`.
- **`fleet/fleetd/`** (Go): the `fleetd` supervisor plus the unified `thesun` CLI (init, install,
  up, status, doctor, onboard, approve, trust, hooks, skills, uninstall, upgrade, wire). Runs under
  an OS service (launchd label `com.example.fleetd` on macOS, by convention; pick any reverse-DNS
  label for your own install).
- **`gateway/`** (Node/TS): the MCP mux on `127.0.0.1:3100`. This is the security policy
  enforcement point (PEP) and the un-bypassable floor. Launched by fleetd as
  `node <bundleRoot>/gateway/dist/index.js`.
- **`hermes/`** (TS): the auth broker + encrypted vault on `127.0.0.1:9876`.

Data flow: generate -> run (fleetd) -> route (gateway) -> authenticate (hermes).

## Build, test, validate (exact commands)

```bash
./install.sh                                    # build all subsystems (idempotent)
( cd gateway && npm run build )                 # tsc -> gateway/dist  (the gateway runs from dist/)
( cd gateway && ./node_modules/.bin/vitest run ) # gateway suite  (pnpm exec is broken here; use the binary directly)
( cd generator && npm run build && npm test )   # tsc + vitest
( cd fleet/fleetd && go build ./... && go vet ./... && go test ./... )
( cd fleet/fleetd && GOOS=windows go build ./... ) # ALWAYS cross-check: Windows is a supported target
```

## Make changes live locally

The gateway serves the built `gateway/dist`, so after a gateway change: `npm run build` then
restart the gateway. Restart via the CLI (`thesun restart gateway` / `thesun up`); to reload a
rebuilt fleetd binary use `launchctl kickstart -k gui/$(id -u)/<your-launchd-label>` on macOS, or
the equivalent for your service manager elsewhere. Prove the new build is live by hitting
`GET 127.0.0.1:3100/healthz` and `GET 127.0.0.1:3100/metrics`. Never work around an expired
credential by hand; re-authenticate with `hermes acquire <service>`.

## Non-negotiable invariants

- **Transport is streamable-http only.** Never stdio, never SSE, anywhere (servers, gateway
  backends, client wiring). stdio deadlocks under supervision; SSE 405-fails.
- **The gateway is the only un-bypassable control.** Two tiers: Tier-A (WRITE/SIDE_EFFECT/
  UNCLASSIFIED) is a model self-confirm, a speed bump, NOT a boundary; Tier-B (PRODUCTION/
  VAULT_VALUE/HUMAN_OUTBOUND or any writeGuard) requires out-of-band human `thesun approve` or a
  trust/class grant. Client-side hooks (`thesun hooks install`) are defense-in-depth, never the
  guarantee. Prove any security claim against the worst reachable state (a full-auto client with
  no hooks), not against a hook.
- **Fail closed** in enforcement paths (content-guard oversize, manifest reload, bind guard).
- **Never write to production; synthetic test data only; never echo/persist secret values.** Test
  fixtures that need a secret-shaped string assemble it at runtime (e.g. `"AKIA"+"..."`) so no
  contiguous literal lands in git history, and CI blocks pushes that contain one.

## Working conventions

- Do not commit or push without explicit maintainer/reviewer sign-off on your own fork's
  conventions.
- `gateway/pnpm-lock.yaml` and `gateway/pnpm-workspace.yaml` are stray scratch (gateway is
  npm/package-lock managed). They are gitignored; never commit them.
- `fleet/servers/generated/` carries only the shipped defaults (atlassian, servicenow); other
  curated servers live in the separate `thesun-servers` repo and install via `thesun add` from the
  `thesun-registry` index (see `docs/MCP-STORE.md`). `*/bin/` directories are build artifacts and
  are gitignored.

## Client wiring and onboarding

Every supported AI client is wired to the SAME gateway URL, which is the point: a client that
registers its own MCP servers is running tools outside the policy enforcement point.

```bash
thesun wire                # (re)wire every detected client; idempotent
thesun wire --report       # every MCP registration per client, transport + liveness
thesun wire --prune        # preview removing stdio and dead-port entries
thesun wire --prune --yes  # apply it (backs up each file first)
thesun onboard             # dependency check, then credential ceremony per backend
thesun onboard --check     # report only, change nothing
```

`thesun install` ends by running `onboard` when a human is at the terminal (`--no-onboard` prints
the pointer instead). That is not a convenience: every bundled backend ships DISABLED, because one
without a credential fails its health check, so a finished install is green with nothing reachable
until you onboard.

**`patchright` is the dependency that actually bites.** It is a Playwright fork and a PEER
dependency of `@hermes/auth-core`, so no package manager guarantees it, and `managed-browser.ts`
loads it with a bare `await import("patchright")` inside the SSO flow. A machine without it fails
browser sign-in with `ERR_MODULE_NOT_FOUND` from inside a broker call, which reads as "auth is
broken." Its chromium build is a separate download from the module, so onboard checks both;
`chromium_headless_shell-*` in the browser cache does NOT count, since a headless shell cannot
render a visible sign-in window. Onboarding offers to install it (module then browser, in that
order, because the CLI that fetches the browser ships inside the module).

**Two reload levers, and picking the wrong one fails silently.** Enabling a backend edits
`gateway/config.fleet.yaml`, and only the GATEWAY re-reads that file, via `POST
/admin/reload-config` (what `thesun gateway reload` calls). fleetd's `reload` re-reads the suite
manifest (`thesun.toml`) and knows nothing about the YAML, so calling it after an enable leaves the
backend unrouted while the command reports success. Nothing errors.

`wire --prune` deletes by (file, container, name), never by name alone. `~/.claude.json` holds a
global `mcpServers` map AND a `projects.<path>.mcpServers` map per project, and the same name can
legitimately sit in both: a name-wide delete would remove a LIVE global entry that the preview just
promised to leave alone.

Clients and their transport keys, all streamable-http:

| Client | File | Entry shape |
| ------ | ---- | ----------- |
| Claude Code | `~/.claude.json` or project `.mcp.json` | `mcpServers`, `type: http` |
| GitHub Copilot CLI | `~/.copilot/mcp-config.json` | `mcpServers`, `type: http`, `tools: ["*"]` |
| OpenAI Codex CLI | `~/.codex/config.toml` | `[mcp_servers.mcp-gateway]` |
| Gemini CLI | `~/.gemini/settings.json` | `mcpServers`, `url` + `type: "http"` |
| OpenCode | `~/.config/opencode/opencode.json` | `mcp`, `type: remote` |
| VS Code | workspace `.vscode/mcp.json` | `servers`, `type: http` |

**Gemini's transport key is a trap.** `createUrlTransport` accepts three spellings: `httpUrl` is
streamable-http but deprecated, `url` paired with the http type value is streamable-http, and `url`
paired with the event-stream type value is the forbidden transport. Write the streamable-http form.
The event-stream form 405-fails against the gateway and exposes zero tools, so getting this wrong
looks like successful wiring and delivers nothing.

Gemini also differs on hooks: its event is `BeforeTool`, not `PreToolUse`, and an unrecognised
event name is skipped with a warning rather than an error. Its payload is otherwise byte-identical
to Claude's (`tool_name` / `tool_input`), and it reads a block from the top-level
`{"decision":"block"}` the shared hook already emits for Codex, so no new output dialect was
needed. Its built-in tool names share nothing with the other clients (`run_shell_command`,
`write_file`, `replace`, `read_many_files`, `search_file_content`, `list_directory`); a name
missing from the matcher or from `core.mjs`'s tool sets means the guard never runs and the call is
allowed silently.

## Generation quickstart

```bash
thesun generate --lang go <name>                 # bare name -> apis.guru discovery -> Go server
thesun generate --lang go --file <spec.yaml|json> # OpenAPI 3.x / Swagger 2.0 -> Go server
thesun generate --lang python -t <name>           # fully agentic path, from a bare name
thesun verify <dir>                               # Conformance Lab hard gate
```

Go is deterministic (needs a spec or an apis.guru match); Python drives the agentic orchestrator
from a bare name. A Conformance Lab PASS is necessary, not sufficient (it does not prove semantic
or live-target correctness).

## MCP Store (find, install, publish signed servers)

The store spans three repos: `thesun` (toolchain), `thesun-servers` (curated Go server monorepo),
`thesun-registry` (the signed `index.toml` catalog; default index
`https://raw.githubusercontent.com/schwarztim/thesun-registry/main/index.toml`, override with
`--index` or `THESUN_REGISTRY_INDEX`).

```bash
thesun search <query> [--tier curated|community]   # filter the catalog + print a trust badge
thesun add <name>[@version] [--community]          # verify (sha256 + Ed25519) then install + wire
thesun remove <name>                               # remove from the manifest + reload
thesun update [<name>]                              # refresh the cache, or upgrade one server
thesun keygen                                       # author Ed25519 keypair -> THESUN_HOME/keys
thesun publish <dir> [--community] [--index file]  # Lab-gated: cross-compile, sign, emit entry
```

Two invariants match the security model: (1) `add` is fail-closed (revoked, lab-report, sha256, or
signature failure refuses and writes nothing; curated needs `lab_report.passed==true` plus a
verifying signature; community needs `--community`); (2) both tiers are contained at runtime by the
gateway PEP, so WRITE/DELETE/outbound tools of a pulled server still hit Tier-B. `publish`
HARD-gates on `<dir>/lab-report.json` `passed==true`. The compiled-in curated pubkey
(`curatedPubKeyB64` in `cmd/thesun/registry.go`) is a placeholder until the maintainer's first
signed rollout; operators can trust additional keys via `THESUN_HOME/trusted_keys`. Full reference:
`docs/MCP-STORE.md`.
