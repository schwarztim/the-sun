# Install thesun

This is the install guide for both a human running commands and an AI agent (Claude Code,
GitHub Copilot CLI, Codex CLI, etc.) driving the setup on someone's behalf. Every command
below is copy-pasteable; the "agent-guided loop" section is written as literal instructions
an agent can execute without improvising.

## Prerequisites

**Today (dev checkout — this repo, cloned from source):**

- `node` — builds/runs the generator, gateway, and hermes (all TypeScript)
- `go` — builds `fleetd` and the Go CLI binary (`bin/thesun`) and the generated Go MCP
  servers (Atlassian, ServiceNow, etc.)
- `pnpm` — hermes is a pnpm workspace (`npm i -g pnpm` if you don't have it)
- `bash` — runs `install.sh`

**Coming (packaged release):** a single per-OS archive with `bin/thesun` (Go, no runtime
needed) plus `bin/gateway`/`bin/hermes` built as Node single-executable-applications — no
system `node`/`pnpm` required at all. See `docs/PACKAGING.md` for the release pipeline;
this isn't shipped yet, so today's path is the dev-checkout build below.

## The one-command path

```bash
./install.sh          # builds generator, fleetd + thesun CLI, gateway, hermes
export PATH="$(pwd)/bin:$PATH"   # or symlink bin/thesun onto your PATH
thesun install         # agent-guided setup: init → service install → up → doctor → wire clients
```

`install.sh` is idempotent and per-subsystem: it builds whatever's missing (npm/pnpm
install + build for the Node subsystems, `go build` for fleetd and the CLI) and reports
`✓`/`–`/`✗` per subsystem. If a subsystem is skipped or fails, it tells you why (missing
`npm`, missing `pnpm`, etc.) — fix that tool and re-run.

**Known issue: `install.sh` currently exits `0` even when a subsystem build fails.** Do not
trust the exit code alone; read the per-subsystem `✓`/`–`/`✗` report, and if anything looks
wrong, confirm the expected build artifacts actually exist (`bin/thesun`, `gateway/dist/`,
`generator/dist/`, `hermes/*/dist/`) before moving on to `thesun install`.

`thesun install` then drives the rest of the setup as one structured, streaming report.
Each step prints as it completes (not buffered to the end), so you can react before the
whole flow finishes:

```
thesun install — agent-guided setup

  ✓ PASS  build subsystems        generator/gateway/hermes/fleet already built
  ✓ PASS  thesun init             scaffolded /Users/you/.config/thesun/thesun.toml
  ✓ PASS  thesun service install  registered (user scope, no sudo)
  ✓ PASS  thesun up               stack up (hermes + gateway + servers)
  ✓ PASS  doctor: toolchain: node ...
  ...
  ✓ PASS  wire AI clients         Claude Code (~/.claude.json): wired; GitHub Copilot CLI: not-detected; ...

install: complete — run `thesun status` any time to check the stack.
```

What each step does:

1. **build subsystems** — skipped if this isn't a dev checkout (no `install.sh` next to
   the binary), otherwise runs `install.sh` for anything not already built.
2. **thesun init** — scaffolds `THESUN_HOME` (config dir, logs dir, run dir) and writes
   `thesun.toml`, the single suite config (`[generator]`/`[fleet]`/`[hermes]`/`[gateway]`
   sections plus the supervised `[[server]]` tree). On a fresh init it also merges
   thesun's shipped default MCP servers (ServiceNow, Atlassian, M365 — see below) from
   `fleet/default-manifest.toml`. Re-running is a no-op if `thesun.toml` already exists.
3. **thesun service install** — registers `fleetd` with the OS service manager
   (launchd on macOS, systemd `--user` on Linux, Windows service via kardianos) — user
   scope, no `sudo`. This is what makes the fleet come back after a reboot/login.
4. **thesun up** — starts (or adopts) `fleetd`, which in turn supervises hermes → gateway
   → every configured MCP server as one process tree.
5. **doctor** — runs the full readiness suite in-process (same checks as
   `thesun doctor --json`) and reports each as its own PASS/WARN/FAIL row: toolchains,
   `THESUN_HOME`/config, ports, hermes/auth reachability + session expiry, manifest-vs-
   running drift, per-server `/health`, and OS service registration.
6. **wire AI clients** — idempotently points every detected AI client's MCP config at the
   gateway (see **Per-client wiring** below).

Flags: `--skip-build` (assume subsystems are already built, run `install.sh` directly if
you need to build), `--skip-wire` (skip step 6), `--gateway-url URL` (wire a different
gateway URL than the manifest's own, e.g. if the gateway is on a non-default port).

## The agent-guided loop (explicit instructions)

If you are an AI agent setting this up on the operator's behalf, follow this loop exactly:

1. Run `thesun install`.
2. Read the output top to bottom. If every step is `PASS` (or `WARN` with no action
   needed), go to step 4.
3. For any `FAIL` row, the line directly under it (`→ next: ...`) is the exact next
   action. Do that action, then re-run `thesun install` (it's idempotent — already-done
   steps report `PASS` immediately and cost nothing to re-check).
4. Run `thesun status` and confirm every server shows a healthy state. If not, run
   `thesun logs <name>` for the unhealthy one and act on what you see there.
5. Report to the operator: which clients got wired (from the "wire AI clients" line),
   which default MCP servers need credentials (any `auth:` WARN from doctor), and the
   final `thesun status` output.

Do not hand-edit `thesun.toml`, client config files, or the vault to work around a FAIL —
every step above already exists to be idempotent; re-running `thesun install` is the
correct recovery path in nearly every case.

## Per-client wiring

`thesun install` (step 6) and `thesun install --skip-build --skip-wire=false` both call
the same wiring logic. It only touches a client's config if that client is actually
present on the machine (file/dir presence check) — nothing is created for a client that
isn't installed. Every client converges on the same gateway URL
(`http://127.0.0.1:3100/mcp` by default); only the file format differs:

| Client | Config file | Detected by | Entry format |
|---|---|---|---|
| Claude Code | `./.mcp.json` (project, if one already exists in the cwd `thesun install` ran from) or `~/.claude.json` (global) | an existing `.mcp.json`/`.claude.json` file (never fabricated from scratch) | JSON: `mcpServers.mcp-gateway = {"type":"http","url":"..."}` |
| GitHub Copilot CLI | `~/.copilot/mcp-config.json` | `~/.copilot/` directory exists | JSON: `mcpServers.mcp-gateway = {"type":"http","url":"...","tools":["*"]}` |
| Copilot in VS Code | `.vscode/mcp.json` (workspace-relative) | a `.vscode/` directory in the workspace | JSON: `servers.mcp-gateway = {"type":"http","url":"..."}` |
| OpenCode | `~/.config/opencode/opencode.json` | `~/.config/opencode/` directory exists | JSON: `mcp.mcp-gateway = {"type":"remote","url":"..."}` |
| OpenAI Codex CLI | `~/.codex/config.toml` | `~/.codex/` directory exists | TOML: `[mcp_servers.mcp-gateway]` / `url = '...'` |

Every write is atomic (temp file + rename) and touches only the `mcp-gateway` entry —
every other key in your config is left byte-for-byte alone. Re-running `thesun install`
against an already-wired client reports `already-wired` and doesn't rewrite the file.

If a client wasn't detected because you installed it after running `thesun install`,
just re-run `thesun install` (or `thesun install --skip-build`) once it's present.

## Windows

thesun runs natively on Windows: `fleetd` and the `thesun` CLI are Go binaries, the
gateway/hermes are Node, and `thesun service install` registers `fleetd` as a Windows
service (via kardianos, user scope, no admin prompt) so the stack comes back after a
reboot/login. Two Windows-specific things differ from the POSIX guide above — the paths,
and the fleetd control channel.

### Per-client MCP config paths (Windows)

Same wiring logic, same gateway URL (`http://127.0.0.1:3100/mcp`); only the file location
uses Windows conventions. These mirror the POSIX table under **Per-client wiring** above,
with `%USERPROFILE%` (typically `C:\Users\<you>`) standing in for `~`:

| Client | POSIX path | Windows path | Entry format |
|---|---|---|---|
| Claude Code | `./.mcp.json` or `~/.claude.json` | `.\.mcp.json` (project) or `%USERPROFILE%\.claude.json` (global) | JSON: `mcpServers.mcp-gateway = {"type":"http","url":"..."}` |
| GitHub Copilot CLI | `~/.copilot/mcp-config.json` | `%USERPROFILE%\.copilot\mcp-config.json` | JSON: `mcpServers.mcp-gateway = {"type":"http","url":"...","tools":["*"]}` |
| Copilot in VS Code | `.vscode/mcp.json` | `.vscode\mcp.json` (workspace-relative — same on both) | JSON: `servers.mcp-gateway = {"type":"http","url":"..."}` |
| OpenCode | `~/.config/opencode/opencode.json` | `%USERPROFILE%\.config\opencode\opencode.json` | JSON: `mcp.mcp-gateway = {"type":"remote","url":"..."}` |
| OpenAI Codex CLI | `~/.codex/config.toml` | `%USERPROFILE%\.codex\config.toml` | TOML: `[mcp_servers.mcp-gateway]` / `url = '...'` |

As on POSIX, `thesun install` only writes a client's config if that client is already
present on the machine (file/dir presence check), every write is atomic, and only the
`mcp-gateway` entry is touched. The VS Code Copilot workspace file (`.vscode\mcp.json`) is
per-project rather than global; wire it in the workspace you want the gateway available in.

### THESUN_HOME on Windows

`THESUN_HOME` (where `approvals.json`, `grants.json`, config, logs, and the run dir live)
resolves on Windows to **`%AppData%\thesun`** — i.e. `%APPDATA%\thesun`, which is normally
`C:\Users\<you>\AppData\Roaming\thesun`. Set the `THESUN_HOME` environment variable to
override it. The gateway (Node) and `fleetd` (Go) agree on this location so approvals
written by one are read by the other (`gateway/src/approvals.ts:49-52` resolves
`%APPDATA%` ?? `~\AppData\Roaming`, then `thesun`).

### The fleetd control channel on Windows

The `thesun` CLI talks to the running `fleetd` over a **local control channel**. On
macOS/Linux that channel is a unix-domain socket protected by 0700/0600 filesystem
permissions. Windows has no dependable unix-socket support in Go, so on Windows the control
channel is a **127.0.0.1 TCP listener on an ephemeral port, authenticated by a per-boot
random token** (`fleet/fleetd/internal/fleet/control_windows.go`):

- On start, `fleetd` binds `127.0.0.1:0`, generates a 32-byte random token, and writes a
  descriptor file `fleetd.control` (`"<port>\n<token>\n"`) at mode `0600` inside the `0700`
  run dir under `THESUN_HOME`.
- Because loopback TCP is reachable by any local process, the token — not file permissions
  — is the gate: a client must present the token as its first line or the connection is
  refused. Only a process that can read the owner-only run dir can learn the port and token.
- The descriptor is removed on shutdown so a stale port is never dialed. If you ever see
  "fleetd not running (control endpoint … unreachable)", the daemon isn't up — run
  `thesun up`.

Everything else — `thesun install` / `status` / `doctor` / `logs`, the reboot guarantee,
and the secrets flow — works identically to the POSIX guide.

## Default MCP servers

A fresh `thesun init` merges these three servers into `thesun.toml` (all "genuinely-easy"
auth — no corporate SSO broker, no admin-consent app registration):

| Server | Port | Auth | Setup |
|---|---|---|---|
| `ms365-mcp` (Teams, Mail, Calendar, OneDrive via Graph) | 42030 | Device-code login, own multi-tenant Azure AD app (like `az login --use-device-code`) | One-time: `cd servers/vendor/ms365 && npm install && node node_modules/@softeria/ms-365-mcp-server/dist/index.js --login --org-mode` — opens a device-code URL, sign in once, MSAL caches the token in your OS keychain |
| `atlassian-mcp` (Jira + Confluence) | 42031 | Basic auth: your Atlassian email + an API token (Atlassian Cloud, no SSO) | `thesun secrets add atlassian basic` (prompts for email:token via stdin/hidden prompt — never typed into a config file) |
| `servicenow-mcp` | 42032 | Basic auth against your instance | Set `SERVICENOW_INSTANCE_URL` in `thesun.toml` to your instance (not a secret), then `thesun secrets add servicenow basic` |

**GitHub is opt-in, not shipped by default** — it needs a personal access token, which
isn't "genuinely easy" auth by thesun's bar. To add it: `brew install github-mcp-server`,
then merge the `[[server]]` block from `servers/vendor/github/github.default.toml` into
your `thesun.toml` and the `GITHUB_PAT` env line into the gateway's `[server.env]` — that
file documents the exact steps and the credential flow.

### Storing credentials (the secrets flow)

```bash
thesun secrets add <service> <account>    # e.g. thesun secrets add atlassian basic
```

This prompts for the secret value on stdin/a hidden prompt — the value is never a
command-line argument and never touches the transcript or shell history. Other useful
commands:

```bash
thesun secrets list              # every service with a stored secret + SSO status
thesun secrets show <svc> <acct> # metadata only (updated time, SSO status, which
                                  # server(s) reference it) — the value is never printed
thesun secrets rm <svc> <acct>   # delete a stored credential
thesun acquire <svc>             # (re)authenticate an SSO session (not a static secret)
```

`add`/`set`/`rm` print a restart hint when a running server only resolves
`hermescred://<svc>/<acct>` at spawn time — run `thesun restart <name>` to pick up a
changed credential.

## Client-side policy hooks

`thesun install` wires the shared client-side policy hook as part of its normal flow
(`--skip-wire` skips it too), so on the happy path there is nothing extra to do. The
commands exist for when you need to check or repair that layer:

```bash
thesun hooks install [--client all|claude|copilot|copilot-vscode|codex|opencode]
thesun hooks status [--json]     # per-client installed / drift / not-installed
thesun hooks verify              # behaviorally re-check each client's deny contract
```

The hook human-gates a Tier-A self-confirm in the client's own UX (`ask`, `deny`, or `off`
via `THESUN_HOOK_MODE`, default `ask`), passes Tier-B calls through so the gateway can park
them, and is silent on reads. Installs are idempotent and take a `.bak` before changing
anything.

`hooks verify` is worth running after a client upgrade: each client's deny contract is
pinned to a version, and a client update can silently flip the hook to fail-open while
`hooks status` still reports "installed". `verify` spawns the packaged hook with each
client's exact stdin and asserts the pinned exit code and JSON contract. `thesun doctor`
runs it too.

This layer is defense in depth and nothing more. It is per-machine opt-in, its config lives
in user-writable files, and an autonomous agent with filesystem access can remove it. The
gateway is the enforcement point; see [`SECURITY-MODEL.md`](SECURITY-MODEL.md) for what
each layer does and does not guarantee.

There is currently **no** `thesun hooks uninstall`; removing the hook means editing the
client's config by hand.

## Agent skills

Separately from the hook layer, thesun can install its MCP-generation skill into each
coding agent so the agent knows how to drive `thesun generate`:

```bash
thesun skills install [--client all|claude|copilot|codex|opencode]
thesun skills status [--json]
```

Idempotent, and a `.bak` is taken before overwriting a foreign file at the target path.
This is not part of `thesun install`; run it if you want it.

## Installing servers from the MCP Store

Beyond the defaults above and anything you generate yourself, `thesun` can install signed
server binaries from a catalog:

```bash
thesun store                      # interactive catalog browser
thesun search <query>             # search the catalog + print a trust badge
thesun add <name>[@version]       # verify (sha256 + Ed25519) then install + wire
thesun remove <name>              # remove an installed server + reload
thesun update [<name>]            # refresh the catalog, or upgrade one server
```

`add` is fail-closed: a revoked entry, a failed lab-report gate, a sha256 mismatch, or a
signature failure refuses the install and writes nothing. It allocates a port, appends a
`[[server]]` block to your manifest, reloads the fleet, and PRINTS (never runs) the
credential enrollment command if the server needs one.

Authors publish with `thesun keygen` and `thesun publish <dir>`, which hard-gates on a
passing Conformance Lab report. Full reference, including the trust tiers and the index
format: [`MCP-STORE.md`](MCP-STORE.md).

## The reboot guarantee

After `thesun install`, `thesun service install` has registered `fleetd` with your OS's
service manager (user scope, no `sudo`), so the whole stack comes back after a
reboot/login without you doing anything. If it ever doesn't, `thesun up` brings it back
manually — it's always safe to run and is a no-op if the stack is already up.

**Linux headless/SSH-only caveat:** a systemd `--user` unit only starts at *login* unless
lingering is enabled for your account. On a headless box with no interactive login
session, the fleet would otherwise never start after a reboot even though the unit is
correctly installed. `thesun doctor` checks this (`service: linux linger`) and tells you
to run `loginctl enable-linger <user>` if it's off. macOS's LaunchAgent starts at login
(not boot) by design — that's expected and doctor reports it as informational, not a
problem.

## Troubleshooting

```bash
thesun doctor              # full readiness report (PASS/WARN/FAIL) — non-zero exit on any FAIL
thesun doctor --json       # same report as JSON (what `thesun install` consumes internally)
thesun status              # one aggregated view: hermes + gateway + every server
                            # (state/health/uptime/port) + auth summary
thesun status --json       # machine-readable
thesun logs <name> [-f]    # tail one server's logs ( -f to follow )
thesun gateway status      # the mux/router's own admin status
```

Every `FAIL` from `doctor` (and therefore from `thesun install`) carries a one-line
next-action in its detail text — that line is the fix. Common ones:

- **toolchain: node — FAIL** — install Node.js; the generator/gateway/hermes are Node.
- **auth: hermes broker — FAIL** — the broker isn't reachable; check `thesun logs hermes`.
- **manifest sync — WARN** — the gateway's published config drifted from what's actually
  running; run `thesun gateway reload` (or `thesun reload`).
- **service: linux linger — WARN** — see the reboot guarantee section above.

## Self-update

```bash
thesun version              # print this binary's version
thesun upgrade --check       # check for a newer tagged release, report only
thesun upgrade                # download + verify + swap in the new bundle, restart the service
```

## Uninstall / stop

Stop the stack, or deregister it, without removing anything:

```bash
thesun down                  # stop the supervised tree (hermes, gateway, every server)
thesun service uninstall     # deregister from the OS service manager (no more auto-start)
```

Remove thesun's state entirely (the reverse of `thesun install`):

```bash
thesun uninstall --dry-run   # print exactly what would be removed, change nothing
thesun uninstall             # down -> service uninstall -> remove THESUN_HOME (prompts first)
thesun uninstall --yes       # same, without the confirmation prompt
thesun uninstall --keep-home # deregister and stop, but preserve THESUN_HOME
```

`THESUN_HOME` holds your config, logs, vault, approvals, and grants, so removing it is
destructive and unrecoverable. `uninstall` prints the paths and prompts before touching
them unless you pass `--yes`; run `--dry-run` first if you want to see the list.

Client MCP configs and the client-side policy hook are **not** removed by `thesun
uninstall`. Remove the `mcp-gateway` entry from each client config by hand (the files are
listed under **Per-client wiring** above), and see the note in **Client-side policy hooks**
about the missing `hooks uninstall`.
