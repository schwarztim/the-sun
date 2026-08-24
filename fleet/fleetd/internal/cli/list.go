package cli

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"text/tabwriter"
	"time"

	"mcp-fleet/fleetd/internal/fleet"
)

// row is the enriched per-server view: the daemon's ServerStatus plus a
// client-computed uptime and derived health label + URL.
type row struct {
	fleet.ServerStatus
	UptimeSecs int64  `json:"uptime_secs"`
	Uptime     string `json:"uptime"`
	HealthTag  string `json:"health_tag"`
	URL        string `json:"url"`
}

// fetchRows queries the daemon's status and enriches each server with uptime
// (from the pidfile mtime — daemon-independent) and a derived health tag + URL.
func fetchRows() ([]row, error) {
	resp, err := fleet.SendControl(fleet.Request{Cmd: "status"})
	if err != nil {
		return nil, err
	}
	if !resp.OK && resp.Error != "" {
		return nil, fmt.Errorf("%s", resp.Error)
	}
	rows := make([]row, 0, len(resp.Servers))
	for _, s := range resp.Servers {
		r := row{ServerStatus: s}
		r.HealthTag = healthTag(s.State, s.Serving)
		r.URL = fmt.Sprintf("http://127.0.0.1:%d/mcp", s.Port)
		if secs := uptimeSecs(s.Name, s.State); secs > 0 {
			r.UptimeSecs = secs
			r.Uptime = humanDuration(secs)
		} else {
			r.Uptime = "-"
		}
		rows = append(rows, r)
	}
	return rows, nil
}

// uptimeSecs derives uptime from the pidfile mtime (written at spawn/adopt). Only
// meaningful for running servers; returns 0 otherwise.
func uptimeSecs(name, state string) int64 {
	if state != fleet.StateRunning {
		return 0
	}
	info, err := os.Stat(fleet.PidFile(name))
	if err != nil {
		return 0
	}
	d := time.Since(info.ModTime()).Seconds()
	if d < 0 {
		return 0
	}
	return int64(d)
}

// healthTag renders the health column. It prefers the live probe carried in
// ServerStatus.Serving over the supervisor's own state: a server the supervisor
// calls degraded whose port is nonetheless serving is reported as such, rather
// than flatly as degraded, so an operator can tell a real outage apart from a
// supervision problem (a process fleetd does not own holding the port).
func healthTag(state string, serving bool) string {
	switch state {
	case fleet.StateRunning:
		return "healthy"
	case fleet.StateDegraded:
		if serving {
			return "degraded/serving"
		}
		return "degraded"
	case fleet.StateStopped:
		return "stopped"
	case fleet.StateStarting:
		return "starting"
	default:
		return state
	}
}

func humanDuration(secs int64) string {
	d := time.Duration(secs) * time.Second
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm%ds", int(d.Minutes()), int(d.Seconds())%60)
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh%dm", int(d.Hours()), int(d.Minutes())%60)
	default:
		return fmt.Sprintf("%dd%dh", int(d.Hours())/24, int(d.Hours())%24)
	}
}

func runList(args []string) int {
	fs := flag.NewFlagSet("list", flag.ExitOnError)
	asJSON := fs.Bool("json", false, "emit JSON instead of a table")
	_ = fs.Parse(args)

	rows, err := fetchRows()
	if err != nil {
		fmt.Fprintf(os.Stderr, "fleetd: %v\n", err)
		return 1
	}

	if *asJSON {
		b, _ := json.MarshalIndent(rows, "", "  ")
		fmt.Println(string(b))
		return 0
	}

	tw := tabwriter.NewWriter(os.Stdout, 0, 2, 2, ' ', 0)
	fmt.Fprintln(tw, "NAME\tPORT\tPID\tSTATE\tHEALTH\tRESTARTS\tUPTIME\tURL")
	for _, r := range rows {
		pid := "-"
		if r.PID > 0 {
			pid = fmt.Sprintf("%d", r.PID)
		}
		fmt.Fprintf(tw, "%s\t%d\t%s\t%s\t%s\t%d\t%s\t%s\n",
			r.Name, r.Port, pid, r.State, r.HealthTag, r.Restarts, r.Uptime, r.URL)
	}
	tw.Flush()
	return 0
}
