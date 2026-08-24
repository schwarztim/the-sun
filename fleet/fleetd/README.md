# fleetd

Static-port process supervisor for **streamable-HTTP** MCP servers. Replaces
ToolHive (`thv`) for the Docker→Go MCP migration (Phase 0). Authoritative spec:
`../../mcp-gateway/GO-MIGRATION-DESIGN.md` §2.

One TOML manifest is the source of truth. fleetd spawns each MCP server on a
fixed loopback port (**42000–42999**), health-checks and auto-restarts it with a
circuit breaker, injects Hermes secrets into child env only, publishes an
MCPU-schema gateway config, and survives its own death by re-adopting still-
healthy children.

**Transport is streamable-HTTP only — never stdio, never SSE.** Every published
backend is `{"url":"http://127.0.0.1:<port>/mcp","transport":{"type":"http"}}`.

## Build

```bash
go build -o bin/fleetd ./cmd/fleetd
```

Requires Go 1.26+. Dependencies: `github.com/BurntSushi/toml` (manifest) and
`github.com/charmbracelet/bubbletea` + `lipgloss` (the `menu` dashboard).

## Use

fleetd is the ToolHive-parity fleet manager for the native Go MCP fleet.

**Fleet overview**

```bash
fleetd list [--json]          # tabular: name, port, pid, state, health, restarts, uptime
fleetd status                 # legacy state table (alias of list, no uptime)
fleetd menu                   # interactive dashboard (TUI); falls back to `list` on no-TTY
```

**Lifecycle**

```bash
fleetd start   [name]         # start a stopped/degraded server (all if omitted)
fleetd stop    [name]         # stop (kill) a server            (all if omitted)
fleetd restart [name]         # restart a server                (all if omitted)
fleetd reload                 # re-read manifest + republish gateway config
fleetd shutdown               # stop the daemon; children keep running for re-adopt
```

**Manifest editing** (`fleet.toml` is backed up to `fleet.toml.bak` before every write)

```bash
# append a [[server]] block, then reload + start it:
fleetd add <name> --cmd "BIN [ARGS]" --port N [--env K=V ...] [--health /p] [--max-restarts N]
fleetd rm <name>... | --all   # stop + remove server block(s), then reload
fleetd logs <name> [-f] [-n N] # print or tail (-f) a server's log (last N lines)
```

**Credentials & auth sessions** (delegated to Hermes — fleetd never stores secrets)

```bash
fleetd creds list [service]   # per-service session/token status; a service also
                              #   shows its enrolled account names (values NEVER shown)
fleetd creds set <svc> <acct> # enroll a credential — value read from stdin or a
                              #   hidden prompt, never from argv, never logged
fleetd creds rm  <svc> <acct> # delete a stored credential
fleetd acquire <service>      # (re)acquire an SSO session via interactive login
```

`creds`/`acquire` are a thin front-end over the Hermes CLI (`hermes`, or
`node <repo>/packages/broker/dist/cli.js`; override with `$HERMES_CLI` /
`$HERMES_REPO`). **Hermes stays the single source of truth for the vault** —
fleetd never reads `~/.claude/secrets.vault` or `@hermes/vault` directly, and
secret **values** never pass through fleetd: `creds list` uses only values-free
surfaces (`hermes status --json`, `hermes creds list`), `creds set` streams the
value straight into `hermes creds set` (piped stdin or Hermes's own hidden
prompt). The `menu` dashboard has a matching **auth view** (`c`) with color-coded
session health and per-service actions: acquire, enroll, remove.

**Daemon**

```bash
fleetd run [-manifest PATH]   # run the supervisor (launchd/systemd-managed)
```

Overview/lifecycle verbs talk to the running daemon over a loopback unix socket
under `$THESUN_HOME` (legacy `~/.mcp-fleet/fleetd.sock` when `FLEETD_ROOT` is
set). `list`/`logs` also read runtime state directly
(pidfile mtime for uptime, `logs/<name>.log`) so they work even mid-restart.

### `menu` (interactive dashboard)

A Bubble Tea TUI: live-refreshing table (2s) of every server with color-coded
state (green=running, red=degraded, yellow=starting), arrow-key selection, and
per-server actions — `s` start, `x` stop, `r` restart, `D` remove (confirm),
`l` logs, `o` show URL, `R` refresh, `q` quit. With no controlling TTY (piped,
cron, CI) it degrades to `fleetd list` automatically.

## Manifest

Copy `fleet.toml.example` to the manifest path: `$THESUN_HOME/thesun.toml` by
default (on macOS `~/Library/Application Support/thesun/thesun.toml`); the legacy
`~/.mcp-fleet/fleet.toml` is still honored via `FLEETD_ROOT` or `FLEETD_MANIFEST`.
Per-server: `name`,
`bin`, `args`, `port` (42000–42999), `env` (literal or `hermes://<svc>/<scheme>`),
`health` (default `/healthz`), `max_restarts`. Startup **fails closed** on an
out-of-range or duplicate port, a duplicate name, or a missing `bin`.

### Secrets

Env values of the form `hermes://<service>/<scheme>` are resolved from the local
Hermes broker (`http://127.0.0.1:9876/token/<service>/<scheme>`, auth
`~/.hermes/client.token`) at spawn time and injected into the **child env only** —
never written to disk, a log, or the published config. Literal values pass
through unchanged. If a ref cannot be resolved, that one server is marked
`degraded` with a clear reason; the fleet stays up (no insecure fallback).

## Layout

```
cmd/fleetd/         CLI + daemon entry point
cmd/stub/           throwaway MCP-server stand-in (proofs only)
internal/manifest/  TOML parse + fail-closed validation (port range/uniqueness)
internal/hermes/    hermes:// secret resolver (broker GET /token/:service/:scheme)
internal/fleet/     supervisor: spawn/health/restart/breaker/re-adopt, publish,
                    log rotation, unix-socket control
proof/run-proofs.sh acceptance proofs (kill-9 restart, breaker, fleetd-crash
                    re-adopt, no-secrets-on-disk, fail-closed ports)
```

## Runtime state (under `$THESUN_HOME` by default; legacy `~/.mcp-fleet` via `FLEETD_ROOT`)

```
fleet.toml          manifest (source of truth)
fleetd.sock         control socket
run/<name>.pid      per-child pidfile (used for re-adopt)
logs/<name>.log     per-child stdout+stderr, rotated at 50MB (keep 3)
```

Published gateway config: `~/.config/mcpu/config.go-fleet.json`
(override with `FLEETD_PUBLISH_PATH`).

## Proofs

```bash
bash proof/run-proofs.sh
```

Spins an isolated `FLEETD_ROOT` with a stub child (never touches the live gateway;
`FLEETD_SKIP_RELOAD=1`) and proves: (a) kill-9 auto-restart + circuit breaker,
(b) fleetd-crash re-adopt (same pid, no double-spawn), (c) secret in child env
only / none in derived artifacts, (d) `hermes://` fail-closed against the real
broker, plus adversarial fail-closed port validation.
