// Command thesun is the one cross-platform tool that generates, supervises,
// routes, and authenticates MCP servers — Docker-free. It bundles four
// subsystems and drives them from a single binary:
//
//	generator (Node)  — generate & verify MCP server code
//	fleet     (Go)    — fleetd supervisor (in-process; this same binary)
//	gateway   (Node)  — mux servers to MCP clients
//	hermes    (Node)  — auth broker + encrypted vault
//
// "fleetd is the center of gravity — supervise, don't script": bringing up the
// stack is one `thesun up`, which starts fleetd, and fleetd in turn spawns and
// health-checks hermes, the gateway, and every MCP server as one supervised
// tree. No launchd/systemd/pm2 scripting — `thesun service install` registers
// fleetd with the OS service manager cross-platform.
package main

import (
	"fmt"
	"os"

	"mcp-fleet/fleetd/internal/cli"
)

func main() {
	os.Exit(run(os.Args))
}

func run(argv []string) int {
	if len(argv) < 2 {
		usage()
		return 2
	}
	cmd := argv[1]
	args := argv[2:]

	switch cmd {
	// ---- generator (Node) ----
	case "generate", "verify":
		return runGenerator(cmd, args)

	// ---- MCP Store (registry pull + author/publish) ----
	case "store":
		return storeCmd(args)
	case "search":
		return registrySearch(args)
	case "publish":
		return publishCmd(args)
	case "keygen":
		return keygenCmd(args)
	case "update":
		return registryUpdate(args)

	// `add` is dual-purpose: a registry pull (`thesun add <name>` where the name
	// resolves to a store entry and no manual --bin/--cmd is given) OR the
	// existing manual add. Intercept ONLY the registry-pull shape; everything
	// else falls through to cli.Fleet unchanged (non-regression).
	case "add":
		if isRegistryPull(args) {
			return registryAdd(args)
		}
		return cli.Fleet(cmd, args)

	// ---- fleet lifecycle (in-process, shared with fleetd) ----
	case "list", "ls",
		"start", "stop", "restart", "reload",
		"logs", "run-server", "rm", "remove",
		"menu", "tui", "dashboard",
		"doctor",
		"creds", "secret", "secrets", "acquire", "login":
		return cli.Fleet(cmd, args)

	// ---- daemon (what the OS service runs) ----
	case "run", "daemon":
		return cli.Fleet("run", args)

	// ---- subsystem front-ends ----
	case "gateway":
		return gatewayCmd(args)
	case "hermes":
		return hermesPassthrough(args)

	// ---- SC-4 Tier-B out-of-band approvals ----
	case "approve":
		return approveCmd(args)
	case "trust":
		return trustCmd(args)
	case "grants":
		return grantsCmd(args)

	// ---- Phase 1b universal client-side policy hooks ----
	case "hooks":
		return cli.Hooks(args)

	// ---- Agent Skills distribution (MCP-generation skill into each client) ----
	case "skills":
		return cli.Skills(args)

	// ---- whole-stack supervision ----
	case "up":
		return stackUp(args)
	case "down":
		return stackDown(args)
	case "status":
		return cli.Status(args)

	// ---- setup ----
	case "init":
		return initHome(args)
	case "service":
		return serviceCmd(args)
	case "onboard":
		return cli.OnboardCmd(args)

	case "wire":
		return cli.WireCmd(args, gatewayURL()+"/mcp")

	case "install":
		// Agent-guided setup: (build, if a dev checkout) -> init -> service
		// install -> up -> doctor --json -> wire detected AI clients. See
		// install.go. Use --skip-build to only run install.sh directly.
		return runInstallFlow(args)
	case "uninstall":
		// Reverse of install: down -> service uninstall -> (confirmed) remove
		// THESUN_HOME (config/logs/vault/grants). Destructive; see uninstall.go.
		return uninstallCmd(args)

	// ---- self-update ----
	case "upgrade":
		return upgradeCmd(args)
	case "version", "--version":
		return versionCmd(args)

	case "help", "-h", "--help":
		usage()
		return 0
	default:
		fmt.Fprintf(os.Stderr, "thesun: unknown command %q\n\n", cmd)
		usage()
		return 2
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `thesun — generate, supervise, route, and authenticate MCP servers (no Docker)

Generate:
  generate <spec> [opts]        generate a new MCP server (Go default; --lang python for FastMCP)
  verify <dir>                  run the Conformance Lab on a generated server

Fleet (supervised MCP servers):
  list [--json]                 every server: port, state, health, uptime
  menu                          interactive dashboard (servers + auth health)
  start|stop|restart [name]     lifecycle (all if name omitted)
  logs <name> [-f] [-n N]       tail a server's logs
  add <name> --cmd .. --port N  add a server ( [--kind system] for infra )
  rm <name>... | --all          remove server(s)
  reload                        re-read the manifest + republish

MCP Store (find, install, and publish signed server binaries):
  store [query] [--tier t] [--index ref]
                                interactive catalog browser: category-grouped
                                entries with live fuzzy filter, honest trust
                                badges (curated = lab-verified + signed;
                                community = self-attested), write-safety and
                                auth indicators, installed state, and in-place
                                install/remove through the same verified
                                fail-closed path as add. Without a TTY it
                                degrades to:
  store list [query] [--tier t] [--index ref]
                                the same catalog as a static grouped listing
  search <query> [--tier curated|community] [--index ref]
                                search the catalog; prints a trust badge
                                (curated = lab-verified; community =
                                self-attested, unverified) + a one-line summary
  add <name>[@version] [--community] [--index ref]
                                verify (sha256 + Ed25519, fail-closed) then
                                install, allocate a port, wire into the fleet,
                                and PRINT (never run) the credential enrollment
                                command. A bare name (no --cmd/--bin) is a store
                                pull; --cmd/--bin is the manual add above.
  remove <name>                 remove an installed server + reload
  update [<name>]               refresh the catalog cache, or upgrade an
                                installed server to a newer verified version
  keygen                        generate an author Ed25519 keypair under
                                THESUN_HOME/keys (private key never printed)
  publish <dir> [--community] [--index localfile] [--release-dir dir] [--name n] [--version v]
                                Lab-gated (needs <dir>/lab-report.json
                                passed=true): cross-compile the platform matrix,
                                sign the version, and emit the index entry

Credentials (secret-safe; delegates to the Hermes vault):
  secrets                        interactive TUI (auth/creds view)
  secrets list [<svc>]           every service with a stored secret + SSO
                                 status (or one service's accounts + status)
  secrets add|set <svc> <acct>   store a credential (stdin/hidden prompt only)
  secrets rm <svc> <acct>        delete a stored credential
  secrets show <svc> <acct>      metadata only (updatedAt, SSO, referencing
                                 servers) — the value is NEVER shown; prints a
                                 restart hint when a running server resolves
                                 it only at spawn (add/set/rm do too)
  creds ...                      legacy alias — same vault, narrower surface
  acquire <svc>                  (re)authenticate an SSO session

Subsystems:
  gateway status|reload         the mux/router admin API
  hermes <cmd ...>              pass a command to the Hermes broker CLI

SC-4 Tier-B out-of-band approvals (PRODUCTION/VAULT_VALUE/HUMAN_OUTBOUND and
any write_guard-flagged tool never accept a model-supplied confirmed:true —
only a human via these commands, or the gateway's loopback /approve page,
can authorize them):
  approve                       list pending approvals, prompt for one
  approve <id> [--always] [--ttl=N]
                                approve one-time, or --always for a standing
                                grant (persists across dispatches); --ttl=N
                                expires the grant after N minutes (m/h/d
                                suffix accepted, e.g. --ttl=30d)
  trust <backend> [--ttl 30d]   backend-wide standing grant — covers ALL
                                current AND FUTURE tools of that backend
                                (prints a warning; prefer per-tool approve)
  grants [list]                 every standing/one-time grant
  grants rm <id>                revoke a grant

Client-side policy hooks (Phase 1b — near-universal first line of defense; the
gateway remains the un-bypassable floor):
  hooks install [--client all|claude|copilot|copilot-vscode|codex|opencode]
                                wire the shared policy hook into detected AI
                                clients (idempotent; never clobbers unrelated
                                config; a .bak is taken before any change).
                                Human-gates a Tier-A self-confirm (ask|deny|off
                                via THESUN_HOOK_MODE, default ask), passes
                                Tier-B through to the gateway park, silent on reads.
  hooks status [--json]         per-client installed / drift / not-installed

Agent Skills (distribute the MCP-generation skill into your coding agents):
  skills install [--client all|claude|copilot|codex|opencode]
                                copy the packaged thesun skill into each
                                detected client's skills root (Claude Code,
                                Codex CLI, Copilot CLI, OpenCode; idempotent,
                                a .bak is taken before overwriting a foreign
                                file at the path)
  skills status [--json]        per-client installed / drift / not-installed

Whole stack (fleetd supervises hermes + gateway + every server as one tree):
  up                            bring the stack up (starts/adopts fleetd)
  down                          bring the stack down
  status [--json] [--no-auth]   one aggregated view: hermes + gateway + every
                                server (state/health/uptime/port) + auth summary
  doctor [--json]               readiness diagnostics (PASS/WARN/FAIL; non-zero
                                exit on any FAIL): toolchains, home/config, ports,
                                vault/auth, manifest sync, per-server health

Setup:
  onboard [--check] [--non-interactive]
                                the walkthrough from "the stack runs" to "the
                                tools you need are authenticated and answering":
                                probe the dependencies, then for each bundled
                                server, sign in through Hermes (same corporate
                                SSO for all of them; no secret ever reaches this
                                process) and enable it. --check reports the
                                state and changes nothing.
  wire [--url URL]              point every detected AI client at the one
                                gateway. Runs inside "install" too; run it
                                again after installing a new client, since
                                detection is presence-based.
  wire --report                 every MCP server each client is registered
                                against, classified gateway/live/dead/stdio
  wire --prune [--yes]          remove the stdio (prohibited) and dead-port
                                registrations that bypass the gateway. Previews
                                by default; --yes applies it, backing up each
                                file first. Never touches the gateway entry or a
                                live server: a reachable one may be deliberate.
  init                          scaffold THESUN_HOME (dirs + default thesun.toml —
                                the single suite config: [generator] [fleet]
                                [hermes] [gateway] + the supervised [[server]] tree)
  service install|uninstall|start|stop|status
                                register fleetd with the OS service manager
                                (launchd/systemd/Windows — user scope, no sudo)
  install [--skip-build] [--skip-wire] [--no-onboard] [--no-auto-update] [--gateway-url URL]
                                agent-guided setup: (build, if a dev checkout)
                                -> init -> service install -> up -> doctor
                                --json -> wire the gateway into every detected
                                AI client (Claude Code, Copilot CLI, Codex CLI,
                                OpenCode) -> install the client-side policy hook
                                (defense in depth). Prints PASS/WARN/FAIL per
                                step with a next-action on any FAIL; re-run
                                after resolving. --skip-wire also skips hooks.
                                Ends by running "onboard" when a human is at the
                                terminal, because a green install still has no
                                credentials and so no reachable backend;
                                --no-onboard prints the pointer instead.
                                Also schedules automatic updates (ON by default,
                                --no-auto-update to skip), because a fix to the
                                policy enforcement point only protects anyone
                                once it is actually running. Skipped rather than
                                failed when there is nothing to track.
  uninstall [--yes] [--dry-run] [--keep-home]
                                reverse of install: bring the stack down,
                                deregister the OS service, then (after printing
                                the paths and prompting, unless --yes) remove
                                THESUN_HOME (config/logs/vault/grants). --dry-run
                                changes nothing; --keep-home preserves THESUN_HOME.
  run                           run the supervisor foreground (used by the service)

Self-update:
  version                        print this binary's version
  upgrade --track [--check] [--no-restart]
                                 update from THIS CHECKOUT'S upstream branch
                                 rather than a tagged release. Fast-forward only:
                                 it refuses a dirty tree and refuses a checkout
                                 with local commits, so nothing local is ever
                                 discarded. Rebuilds, verifies the built
                                 artifacts (install.sh exits 0 even when a
                                 subsystem fails, so its exit code is not the
                                 gate), and restarts ONLY if the build produced
                                 them; a failed build is rolled back and the
                                 running stack is left alone.
  upgrade --track --auto=on [--every 6h] | --auto=off
                                 register/remove a user-scoped scheduled job
                                 (launchd/systemd-timer/schtasks) that runs the
                                 above unattended. Logs every run to
                                 <THESUN_HOME>/logs/auto-update.log. Tracking a
                                 branch means whoever can land a commit on it
                                 replaces the policy enforcement point, so point
                                 it only at a protected, PR-gated branch.
  upgrade [--check] [--repo owner/repo]
                                 check the release feed (GitHub Releases API;
                                 default repo compiled in, override via
                                 THESUN_UPDATE_REPO or --repo) for a newer
                                 tagged version; --check reports only. Without
                                 --check: downloads the matching-OS/arch
                                 archive, verifies its checksum, swaps it in
                                 for the current bundle, and restarts the
                                 service (or the detached stack, if the OS
                                 service isn't installed).

Environment:
  THESUN_HOME            state root  (default: OS user-config dir /thesun)
  THESUN_BUNDLE          bundle root (default: parent of this binary's dir)
  THESUN_REGISTRY_INDEX  store index reference (default: the compiled-in URL)
`)
}
