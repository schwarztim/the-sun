# thesun

**One CLI that generates, runs, routes, and authenticates MCP servers, with zero Docker
dependency.**

thesun bundles what used to be four separate projects into a single, cohesive, shippable
tool. You install it once and manage everything through one CLI. MCP servers run as native
Go binaries (or Python bundled the same way) supervised by a local process manager, no
Docker and no ToolHive required.

```
generate  ─▶  run  ─▶  route  ─▶  authenticate
generator     fleet    gateway    hermes
```

## What thesun is for

If you use an AI coding agent (Claude Code, GitHub Copilot CLI, OpenAI Codex CLI, Gemini
CLI, OpenCode, or VS Code Copilot) and want it to call out to real APIs, services, or
internal tools, you need MCP (Model Context Protocol) servers. thesun is the toolchain that
takes you from "there's a REST API I want my agent to use" to "my agent can safely call it,
from any of my AI clients, with one policy floor in front of every call":

- **generate** an MCP server from an OpenAPI spec, an API name, or a browser capture of an
  undocumented app.
- **run** it as a supervised local process, no containers.
- **route** every client through one gateway, so tool access is governed in exactly one
  place instead of once per client.
- **authenticate** it without ever putting a plaintext secret in a config file.

## Prerequisites

- **`node`** (builds/runs the generator, gateway, and hermes; all TypeScript)
- **`go`** (builds `fleetd`, the `thesun` CLI binary, and generated Go MCP servers)
- **`pnpm`** (hermes is a pnpm workspace: `npm i -g pnpm` if you don't have it)
- **`bash`** (runs `install.sh`)
- A supported AI client you want to wire up: Claude Code, GitHub Copilot CLI, OpenAI Codex
  CLI, Gemini CLI, OpenCode, or VS Code with the Copilot extension. None are required to
  build or run thesun itself.

A packaged, no-toolchain-required release (one archive per OS with everything prebuilt) is
in progress; see [`docs/PACKAGING.md`](docs/PACKAGING.md). Until then, build from source with
the steps below.

## Setup

```bash
git clone <this-repo-url>
cd thesun
./install.sh                     # builds generator, fleetd + thesun CLI, gateway, hermes
export PATH="$(pwd)/bin:$PATH"   # or symlink bin/thesun onto your PATH permanently
thesun install                    # init -> register OS service -> bring the stack up -> wire AI clients
thesun status                     # confirm the whole stack + every server's health
```

`install.sh` is idempotent and reports `PASS`/`SKIP`/`FAIL` per subsystem; re-run it any
time. `thesun install` is a guided, streaming setup: it scaffolds config, registers `fleetd`
with your OS service manager (so the fleet survives a reboot), starts the stack, runs a full
readiness check, and wires every AI client it finds on your machine to the gateway.

thesun ships three default MCP servers with "genuinely easy" auth, meaning no admin-consent
app registration and no corporate SSO broker required: **ServiceNow** and **Atlassian**
(Jira + Confluence) via basic auth, and **Microsoft 365** (Teams, Mail, Calendar, OneDrive)
via a one-time personal device-code login. They are built by `install.sh` but not yet
usable; each needs its own credential before its first call:

```bash
thesun secrets add atlassian basic     # prompts for email:token, never typed into a file
thesun secrets add servicenow basic    # prompts for basic-auth credentials
# ms365 is a one-time device-code login; see servers/vendor/ms365/README.md
```

Run `thesun doctor` any time to see exactly which defaults are ready and what's still
missing. GitHub is available opt-in (`servers/vendor/github/README.md`) since it needs a
personal access token, which doesn't meet the zero-pre-shared-secret bar for a default.

Full walkthrough, including Windows-specific paths and the agent-guided install loop, lives
in [`docs/INSTALL.md`](docs/INSTALL.md).

## Usage

```bash
thesun generate <spec>                # generate a new MCP server (delegates to generator/)
thesun list | menu | logs <name>      # fleet inspection: status table, dashboard, tail logs
thesun start|stop|restart [name]      # lifecycle (all if name omitted)
thesun add|rm <name> ...              # add/remove a server from the fleet
thesun secrets add|list|show|rm       # credentials (secret-safe; delegates to the vault)
thesun acquire <svc>                  # (re)authenticate an SSO session
thesun approve | grants               # human-only approvals for high-risk calls
thesun gateway status|reload          # the mux/router
thesun up|down|status|doctor|install  # whole-stack lifecycle + readiness diagnostics
thesun upgrade | version              # self-update
```

Every command has a `--help`. `thesun --help`, or `fleet/fleetd/cmd/thesun/main.go`'s
`usage()`, is the authoritative reference for the full surface.

## Project structure

| Dir | What it is | Role |
|-----|-----------|------|
| `generator/` | REST-to-MCP generator (TypeScript) | **generate** MCP servers (Go by default; Python only when a target needs browser-TLS impersonation) |
| `fleet/` | `fleetd` supervisor + unified CLI (Go) | **run/manage**: start/stop/restart, logs, add/remove, credential + session management |
| `gateway/` | MCP mux/router (Node/TS) | **route**: one endpoint that muxes every server to every client, with safety classification |
| `hermes/` | local auth broker + encrypted vault (TS) | **authenticate**: SSO re-authentication, token caching; servers never store secrets themselves |
| `servers/vendor/` | vendored default MCP servers (ms365, github) | pinned upstream packages with genuinely-easy auth |
| `docs/` | reference documentation | install, security model, gateway config, MCP store, onboarding |

## Security model, in brief

Every tool call from every client passes through a single chokepoint in the gateway
(`127.0.0.1:3100`), the **policy enforcement point (PEP)**. It classifies each call's blast
radius and, for the genuinely dangerous classes (production systems, secret-value handling,
outbound human-facing messages), refuses to dispatch until a human approves it out of band
with `thesun approve`. No tool the gateway exposes can grant that approval itself, on any
client, so a model cannot talk its way past it purely within the MCP tool plane. This holds
regardless of which client you use, what version it is, or whether it's running in a fully
autonomous mode.

**Transport is streamable-http only, everywhere.** Never stdio, never SSE, for any server,
gateway backend, or client wiring. stdio deadlocks under process supervision; SSE fails the
handshake against a streamable-http endpoint and silently exposes zero tools.

Client-side hooks (`thesun hooks install`) are defense in depth on top of the gateway, not a
substitute for it: they add a human check inside the client's own UX, but their config lives
in user-writable files an autonomous agent with filesystem access could edit. The gateway is
the control that holds even then.

Full detail, including exactly what each layer defends against and where the guarantees
stop: [`docs/SECURITY-MODEL.md`](docs/SECURITY-MODEL.md).

## Connect your own tenant

The default MCP servers ship pointed at nothing; each needs your own account, tenant, or
instance URL before it's useful. See [`docs/ONBOARDING.md`](docs/ONBOARDING.md) for the
per-connector setup: what to have ready, exactly which configuration values to supply, how
to run the onboarding command, and how to verify it worked.

## MCP Store

Beyond generating your own servers, thesun ships a store for finding, installing, and
publishing signed MCP server binaries, spanning three repos: `thesun` (this toolchain),
`thesun-servers` (the curated Go server monorepo), and `thesun-registry` (the signed catalog
index the CLI fetches).

```bash
thesun search <query>            # search the catalog (trust badge: curated vs community)
thesun add <name>[@version]      # verify (sha256 + Ed25519) then install + wire into the fleet
thesun remove <name>             # remove an installed server
thesun update [<name>]           # refresh the catalog, or upgrade an installed server
thesun keygen                    # generate an author Ed25519 keypair
thesun publish <dir>             # Lab-gated: cross-compile, sign, and emit an index entry
```

Two trust tiers: **curated** (maintainer-signed, Conformance-Lab-proven, CI-re-gated) and
**community** (self-attested, clearly labeled, opt-in via `--community`). Every `add` is
fail-closed: a checksum, signature, revocation, or lab-report failure refuses the install and
writes nothing. Both tiers are contained at runtime by the same gateway policy floor, so a
pulled server's write/delete/outbound tools still require the same out-of-band approval.
Full reference: [`docs/MCP-STORE.md`](docs/MCP-STORE.md).

## Design principles

- **Docker-free.** Servers run native (Go) or as thin static/Python-in-Go builds, supervised
  by `fleetd`.
- **Secrets stay in the vault.** Hermes owns credentials and SSO re-auth; nothing else stores
  secret values.
- **Go-native by default.** Python is used only when a target genuinely needs browser-TLS
  impersonation.
- **One CLI, one install.** Ship it as a single package that's easy for anyone to run and
  manage.
- **One policy floor.** Every client, every tool call, one gateway; nothing bypasses it.

See [`docs/README.md`](docs/README.md) for the full documentation index.
