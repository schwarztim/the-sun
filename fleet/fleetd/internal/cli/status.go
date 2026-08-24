package cli

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"text/tabwriter"

	"mcp-fleet/fleetd/internal/fleet"
	"mcp-fleet/fleetd/internal/manifest"
)

// status.go implements the rich, aggregated `thesun status` — the whole stack
// (hermes, gateway, every MCP server) plus an auth-session summary, from ONE
// command. fleetd already health-checks hermes and the gateway (they are
// kind="system" supervised entries), so a single control-socket call yields the
// entire supervised tree — no three separate curls. The auth summary is layered
// on from Hermes's values-free status surface.

// authSummary is the values-free roll-up of Hermes auth sessions.
type authSummary struct {
	OK       int      `json:"ok"`
	Expiring int      `json:"expiring"`
	Expired  int      `json:"expired"`
	Other    int      `json:"other"`
	Problems []string `json:"problems,omitempty"` // "service/scheme: <expiry-state>"
	Note     string   `json:"note,omitempty"`     // set when Hermes is unreachable
}

// stackReport is the full --json payload.
type stackReport struct {
	FleetUp bool         `json:"fleet_up"`
	System  []row        `json:"system"` // hermes, gateway
	Servers []row        `json:"servers"`
	Auth    *authSummary `json:"auth,omitempty"`
}

// Status renders the aggregated stack view. `--json` emits stackReport.
func Status(args []string) int {
	fs := flag.NewFlagSet("status", flag.ExitOnError)
	asJSON := fs.Bool("json", false, "emit the aggregated stack report as JSON")
	noAuth := fs.Bool("no-auth", false, "skip the Hermes auth-session summary")
	_ = fs.Parse(args)

	rep := stackReport{}
	rows, err := fetchRows()
	if err == nil {
		rep.FleetUp = true
		for _, r := range rows {
			if r.Kind == manifest.KindSystem {
				rep.System = append(rep.System, r)
			} else {
				rep.Servers = append(rep.Servers, r)
			}
		}
	}

	if !*noAuth {
		rep.Auth = collectAuthSummary()
	}

	if *asJSON {
		b, _ := json.MarshalIndent(rep, "", "  ")
		fmt.Println(string(b))
		if !rep.FleetUp {
			return 1
		}
		return 0
	}

	return renderStatus(&rep, err)
}

// collectAuthSummary rolls up Hermes session health without ever touching a
// secret value. A missing/unreachable Hermes is reported as a note, not a crash.
func collectAuthSummary() *authSummary {
	st, err := fetchHermesStatus()
	if err != nil {
		return &authSummary{Note: "hermes status unavailable"}
	}
	sum := &authSummary{}
	for _, s := range st.Services {
		switch expiryState(s.tokenExpiry()) {
		case "valid":
			sum.OK++
		case "expiring":
			sum.Expiring++
			sum.Problems = append(sum.Problems, fmt.Sprintf("%s/%s: expiring soon", s.Service, s.Scheme))
		case "expired":
			sum.Expired++
			sum.Problems = append(sum.Problems, fmt.Sprintf("%s/%s: EXPIRED", s.Service, s.Scheme))
		default:
			// No token expiry recorded — count as OK only if Hermes marks it ok.
			if s.Status == "ok" || s.Status == "healthy" {
				sum.OK++
			} else {
				sum.Other++
			}
		}
	}
	return sum
}

func renderStatus(rep *stackReport, fleetErr error) int {
	if !rep.FleetUp {
		fmt.Println("stack: DOWN")
		fmt.Printf("  fleetd not running — run `thesun up` (%v)\n", fleetErr)
		if rep.Auth != nil {
			printAuthSummary(rep.Auth)
		}
		return 1
	}

	fmt.Println("stack: UP")
	if len(rep.System) > 0 {
		fmt.Println("\n── infrastructure ──")
		printServerTable(rep.System)
	}
	fmt.Println("\n── mcp servers ──")
	if len(rep.Servers) == 0 {
		fmt.Println("  (none — add one with `thesun add`)")
	} else {
		printServerTable(rep.Servers)
	}
	if rep.Auth != nil {
		fmt.Println()
		printAuthSummary(rep.Auth)
	}

	// Exit non-zero if any supervised component is not healthy.
	for _, r := range append(append([]row{}, rep.System...), rep.Servers...) {
		if r.State != fleet.StateRunning {
			return 1
		}
	}
	return 0
}

func printServerTable(rows []row) {
	tw := tabwriter.NewWriter(os.Stdout, 0, 2, 2, ' ', 0)
	fmt.Fprintln(tw, "  NAME\tSTATE\tHEALTH\tPORT\tPID\tUPTIME\tRESTARTS")
	for _, r := range rows {
		pid := "-"
		if r.PID > 0 {
			pid = fmt.Sprintf("%d", r.PID)
		}
		fmt.Fprintf(tw, "  %s\t%s\t%s\t%d\t%s\t%s\t%d\n",
			r.Name, r.State, r.HealthTag, r.Port, pid, r.Uptime, r.Restarts)
	}
	tw.Flush()
}

func printAuthSummary(a *authSummary) {
	if a.Note != "" {
		fmt.Printf("auth: %s\n", a.Note)
		return
	}
	fmt.Printf("auth: %d ok · %d expiring · %d expired", a.OK, a.Expiring, a.Expired)
	if a.Other > 0 {
		fmt.Printf(" · %d other", a.Other)
	}
	fmt.Println()
	for _, p := range a.Problems {
		fmt.Printf("  ⚠ %s\n", p)
	}
}
