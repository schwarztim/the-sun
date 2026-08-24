// Package cli holds the shared fleet command implementations — the daemon run
// loop, the control-socket client verbs (status/start/stop/restart/reload),
// list/logs/add/rm, the Hermes-delegating creds/acquire front-end, and the
// interactive menu. Both the legacy `fleetd` binary and the unified `thesun`
// binary drive these functions in-process, so there is exactly one copy of the
// logic.
package cli

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"text/tabwriter"

	"mcp-fleet/fleetd/internal/fleet"
	"mcp-fleet/fleetd/internal/manifest"
	"mcp-fleet/fleetd/internal/paths"
)

// Main is the entry point for the standalone `fleetd` binary: it parses argv,
// prints usage on no/help args, and dispatches one fleet verb.
func Main(argv []string) int {
	if len(argv) < 2 {
		FleetdUsage()
		return 2
	}
	switch argv[1] {
	case "-h", "--help", "help":
		FleetdUsage()
		return 0
	}
	return Fleet(argv[1], argv[2:])
}

// Fleet dispatches a single fleet/daemon verb in-process. Unknown verbs print an
// error plus usage and return 2. It is the shared surface `thesun` calls for its
// fleet subcommands.
func Fleet(cmd string, args []string) int {
	switch cmd {
	case "run", "daemon":
		return RunDaemon(args)
	case "status", "start", "stop", "restart", "reload", "shutdown":
		return runControl(cmd, args)
	case "list", "ls":
		return runList(args)
	case "doctor":
		return Doctor(args)
	case "overview":
		return Status(args)
	case "logs":
		return runLogs(args)
	case "add", "run-server":
		return runAdd(args)
	case "rm", "remove":
		return runRemove(args)
	case "menu", "tui", "dashboard":
		return runMenu(args)
	case "creds":
		return runCreds(args)
	case "secret", "secrets":
		return runSecrets(args)
	case "acquire", "login":
		return runAcquire(args)
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n", cmd)
		FleetdUsage()
		return 2
	}
}

// RunDaemon loads the manifest and runs the supervisor foreground until SIGTERM/
// SIGINT. This is what the OS service (`thesun run`) executes.
func RunDaemon(args []string) int {
	fs := flag.NewFlagSet("run", flag.ExitOnError)
	manifestPath := fs.String("manifest", "", "manifest path (default $FLEETD_MANIFEST or THESUN_HOME/thesun.toml)")
	_ = fs.Parse(args)
	if *manifestPath != "" {
		_ = os.Setenv("FLEETD_MANIFEST", *manifestPath)
	}

	// Ensure the runtime dir tree (run/, logs/, …) exists — the daemon may be
	// launched directly by the OS service manager before any `thesun up`/`init`.
	if err := paths.EnsureDirs(); err != nil {
		fmt.Fprintf(os.Stderr, "fleetd: %v\n", err)
		return 1
	}

	m, err := manifest.Load(fleet.ManifestPath())
	if err != nil {
		// Fail closed: never start on an invalid/ambiguous manifest.
		fmt.Fprintf(os.Stderr, "fleetd: %v\n", err)
		return 1
	}

	sup := fleet.New(m, nil)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	if err := sup.Run(ctx); err != nil {
		fmt.Fprintf(os.Stderr, "fleetd: %v\n", err)
		return 1
	}
	return 0
}

func runControl(cmd string, args []string) int {
	name := ""
	if len(args) > 0 {
		name = args[0]
	}
	resp, err := fleet.SendControl(fleet.Request{Cmd: cmd, Server: name})
	if err != nil {
		fmt.Fprintf(os.Stderr, "fleetd: %v\n", err)
		return 1
	}
	if cmd == "status" {
		printStatus(resp)
	} else {
		if resp.Message != "" {
			fmt.Println(resp.Message)
		}
		if len(resp.Servers) > 0 {
			printStatus(resp)
		}
	}
	if !resp.OK {
		if resp.Error != "" {
			fmt.Fprintln(os.Stderr, "error: "+resp.Error)
		}
		return 1
	}
	return 0
}

func printStatus(resp *fleet.Response) {
	tw := tabwriter.NewWriter(os.Stdout, 0, 2, 2, ' ', 0)
	fmt.Fprintln(tw, "NAME\tSTATE\tPORT\tPID\tRESTARTS\tDETAIL")
	for _, s := range resp.Servers {
		pid := ""
		if s.PID > 0 {
			pid = fmt.Sprintf("%d", s.PID)
		}
		fmt.Fprintf(tw, "%s\t%s\t%d\t%s\t%d\t%s\n",
			s.Name, s.State, s.Port, pid, s.Restarts, truncate(s.Detail, 60))
	}
	tw.Flush()
}

func truncate(s string, n int) string {
	s = strings.ReplaceAll(s, "\n", " ")
	if len(s) <= n {
		return s
	}
	return s[:n-1] + "…"
}

// FleetdUsage prints the standalone `fleetd` help text.
func FleetdUsage() {
	fmt.Fprint(os.Stderr, `fleetd — static-port supervisor for streamable-HTTP MCP servers
                (the supervision engine behind the `+"`thesun`"+` tool)

Fleet overview:
  fleetd list [--json]          tabular view: name, port, pid, state, health, restarts, uptime
  fleetd status                 legacy state table (alias of list, no uptime)
  fleetd overview [--json]      aggregated stack view (infra + servers + auth summary)
  fleetd doctor [--json]        readiness diagnostics (PASS/WARN/FAIL; non-zero on FAIL)
  fleetd menu                   interactive dashboard (TUI); falls back to list on no-TTY

Lifecycle:
  fleetd start   [name]         start a stopped/degraded server (all if omitted)
  fleetd stop    [name]         stop (kill) a server            (all if omitted)
  fleetd restart [name]         restart a server                (all if omitted)
  fleetd reload                 re-read manifest + republish gateway config
  fleetd shutdown               stop the daemon (children keep running for re-adopt)

Manifest editing (thesun.toml is backed up to <path>.bak before every write):
  fleetd add <name> --cmd "BIN [ARGS]" --port N [--kind system] [--env K=V ...] [--health /p] [--max-restarts N]
                                append a [[server]] block, then reload + start it
  fleetd rm <name>... | --all   stop + remove server block(s), then reload
  fleetd logs <name> [-f] [-n N] print or tail (-f) a server's log

Credentials & auth sessions (delegated to Hermes — fleetd never stores secrets):
  fleetd secrets [list|add|set|rm|show]  unified front door (see 'thesun secrets --help');
                                        bare 'secrets' opens the TUI creds/auth view
  fleetd creds list [service]   legacy alias — per-service session/token status
                                (+ enrolled accounts); same vault, narrower surface
  fleetd creds set <svc> <acct> enroll a credential (value via stdin/hidden prompt only)
  fleetd creds rm  <svc> <acct> delete a stored credential
  fleetd acquire <service>      (re)acquire an SSO session via interactive login

Daemon:
  fleetd run [-manifest PATH]   run the supervisor (foreground; launchd/systemd-managed)

Environment:
  THESUN_HOME          state root (default: OS user-config dir /thesun)
  FLEETD_MANIFEST      manifest path override (default THESUN_HOME/thesun.toml)
  FLEETD_ROOT          legacy state root override
  FLEETD_PUBLISH_PATH  published config path override
  FLEETD_SKIP_RELOAD=1 skip the gateway reload POST (publish file only)
  HERMES_BROKER_URL    Hermes broker base URL (default http://127.0.0.1:9876)
`)
}
