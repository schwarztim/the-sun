package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"text/tabwriter"
	"time"
)

// runCreds dispatches `fleetd creds <sub>` (alias `fleetd secret`). It is a
// front-end over Hermes: fleetd never stores or prints secret values.
func runCreds(args []string) int {
	if len(args) == 0 {
		return credsList(nil)
	}
	sub := args[0]
	rest := args[1:]
	switch sub {
	case "list", "ls", "status":
		return credsList(rest)
	case "set", "enroll", "add":
		return credsSet(rest)
	case "rm", "remove", "delete", "del":
		return credsRemove(rest)
	case "-h", "--help", "help":
		credsUsage()
		return 0
	default:
		fmt.Fprintf(os.Stderr, "unknown creds subcommand %q\n", sub)
		credsUsage()
		return 2
	}
}

func credsUsage() {
	fmt.Fprint(os.Stderr, `fleetd creds — credential + auth-session management (delegates to Hermes)

  fleetd creds list [service]      list services with session/token status; a
                                   service also shows its enrolled account names
                                   (values are NEVER shown)
  fleetd creds set <svc> <account> enroll a credential — value read from stdin or
                                   a hidden prompt (never argv, never logged)
  fleetd creds rm  <svc> <account> delete a stored credential
  fleetd acquire   <service>       (re)acquire an SSO session via interactive login

Hermes owns the vault; fleetd is a friendly front-end. Secret values never pass
through fleetd. Override the CLI with $HERMES_CLI or $HERMES_REPO.
`)
}

// credsList shows per-service auth health from `hermes status --json`. With a
// service argument it also lists that service's enrolled credential accounts.
func credsList(args []string) int {
	asJSON := false
	var service string
	for _, a := range args {
		if a == "--json" {
			asJSON = true
		} else if service == "" {
			service = a
		}
	}

	st, err := fetchHermesStatus()
	if err != nil {
		fmt.Fprintf(os.Stderr, "fleetd: %v\n", err)
		return 1
	}

	svcs := st.Services
	if service != "" {
		filtered := svcs[:0:0]
		for _, s := range svcs {
			if s.Service == service {
				filtered = append(filtered, s)
			}
		}
		svcs = filtered
		// A service may have enrolled credentials without being a registered SSO
		// service (e.g. a static API key). Only error later if it has neither an
		// SSO session nor any enrolled credential.
	}
	sort.SliceStable(svcs, func(i, j int) bool {
		if svcs[i].Service == svcs[j].Service {
			return svcs[i].Scheme < svcs[j].Scheme
		}
		return svcs[i].Service < svcs[j].Service
	})

	if asJSON {
		type outRow struct {
			Service   string `json:"service"`
			Scheme    string `json:"scheme"`
			Status    string `json:"status"`
			Expiry    string `json:"token_expiry,omitempty"`
			ExpiresIn string `json:"expires_in,omitempty"`
			Reason    string `json:"reason,omitempty"`
		}
		rows := make([]outRow, 0, len(svcs))
		for _, s := range svcs {
			exp := s.tokenExpiry()
			rows = append(rows, outRow{s.Service, s.Scheme, s.Status, exp, humanExpiry(exp), s.Reason})
		}
		b, _ := json.MarshalIndent(rows, "", "  ")
		fmt.Println(string(b))
		return 0
	}

	// For a specific service, gather its enrolled accounts too so a non-SSO
	// (static-credential) service still shows something useful.
	var accts []string
	if service != "" {
		accts, _ = credAccounts(service)
		if len(svcs) == 0 && len(accts) == 0 {
			fmt.Fprintf(os.Stderr, "fleetd: %q is unknown to Hermes (no auth session and no enrolled credential)\n", service)
			return 1
		}
	}

	if service == "" && st.Summary != "" {
		fmt.Println(st.Summary)
	}
	if len(svcs) > 0 {
		tw := tabwriter.NewWriter(os.Stdout, 0, 2, 2, ' ', 0)
		fmt.Fprintln(tw, "SERVICE\tSCHEME\tSTATUS\tEXPIRES\tTOKEN-EXPIRY")
		for _, s := range svcs {
			exp := s.tokenExpiry()
			fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\n",
				s.Service, s.Scheme, s.Status, humanExpiry(exp), orDash(exp))
		}
		tw.Flush()
	} else if service != "" {
		fmt.Printf("%s: no SSO auth session in Hermes (static credential only)\n", service)
	}

	if service != "" {
		fmt.Printf("\ncredentials enrolled for %s: ", service)
		if len(accts) == 0 {
			fmt.Println("(none)")
		} else {
			fmt.Println()
			for _, a := range accts {
				fmt.Printf("  - %s\n", a)
			}
		}
	}
	return 0
}

// credsSet streams a secret value from OUR stdin into `hermes creds set`. The
// value never appears in argv, a log, or any fleetd output — Hermes reads it
// directly (piped stdin, or its own hidden TTY prompt) and stores it.
func credsSet(args []string) int {
	if len(args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: fleetd creds set <service> <account>")
		return 2
	}
	service, account := args[0], args[1]

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	cmd, err := hermesCmd(ctx, "creds", "set", service, account)
	if err != nil {
		fmt.Fprintf(os.Stderr, "fleetd: %v\n", err)
		return 1
	}
	// Hand our stdin/stdout/stderr straight to Hermes: piped value flows through
	// untouched; an interactive run gets Hermes's hidden prompt. fleetd never
	// sees the bytes.
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "fleetd: hermes creds set failed: %v\n", err)
		return 1
	}
	// Confirm by name only — never echo the value.
	fmt.Printf("stored %s/%s (via Hermes vault)\n", service, account)
	return 0
}

func credsRemove(args []string) int {
	if len(args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: fleetd creds rm <service> <account>")
		return 2
	}
	service, account := args[0], args[1]
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd, err := hermesCmd(ctx, "creds", "delete", service, account)
	if err != nil {
		fmt.Fprintf(os.Stderr, "fleetd: %v\n", err)
		return 1
	}
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "fleetd: hermes creds delete failed: %v\n", err)
		return 1
	}
	return 0
}

// runAcquire triggers Hermes's interactive SSO session acquisition (browser
// login). This is how a dead/expired session (venafi, tufin, …) is renewed.
// The optional scheme arg is accepted for symmetry but Hermes acquires per
// service, so it is informational only.
func runAcquire(args []string) int {
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, "usage: fleetd acquire <service> [scheme]")
		return 2
	}
	service := args[0]
	if len(args) > 1 {
		fmt.Fprintf(os.Stderr, "note: Hermes acquires per service; scheme %q is informational\n", args[1])
	}

	// No timeout: interactive browser login can take minutes. Hand the terminal
	// to Hermes so its prompts/output render normally.
	cmd, err := hermesCmd(context.Background(), "acquire", service)
	if err != nil {
		fmt.Fprintf(os.Stderr, "fleetd: %v\n", err)
		return 1
	}
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "fleetd: hermes acquire failed: %v\n", err)
		return 1
	}
	return 0
}

// ---- expiry helpers (shared with the menu's auth view) ----

// humanExpiry renders an RFC3339 expiry as a relative "in 2h3m" / "expired 5m
// ago" / "-". Robust to Hermes's timestamp formats.
func humanExpiry(rfc3339 string) string {
	if rfc3339 == "" {
		return "-"
	}
	t, err := parseTime(rfc3339)
	if err != nil {
		return "?"
	}
	d := time.Until(t)
	if d < 0 {
		return "expired " + humanDuration(int64(-d.Seconds())) + " ago"
	}
	return "in " + humanDuration(int64(d.Seconds()))
}

// expiryState classifies an expiry for coloring: "valid", "expiring" (<30m
// left), "expired", or "none".
func expiryState(rfc3339 string) string {
	if rfc3339 == "" {
		return "none"
	}
	t, err := parseTime(rfc3339)
	if err != nil {
		return "none"
	}
	d := time.Until(t)
	switch {
	case d < 0:
		return "expired"
	case d < 30*time.Minute:
		return "expiring"
	default:
		return "valid"
	}
}

func parseTime(s string) (time.Time, error) {
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05.000Z"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t, nil
		}
	}
	return time.Time{}, fmt.Errorf("unrecognized time %q", s)
}

func orDash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

// hermesServiceForServer maps a fleet server name (e.g. "venafi-go") to its
// Hermes auth service ("venafi") by trimming the "-go" suffix. Best-effort:
// static-API-key servers have no SSO session in Hermes and simply won't match.
func hermesServiceForServer(name string) string {
	const suffix = "-go"
	if len(name) > len(suffix) && name[len(name)-len(suffix):] == suffix {
		return name[:len(name)-len(suffix)]
	}
	return name
}
