package cli

// secrets.go implements `thesun secrets` — the unified front door over the
// Hermes-backed credential vault (aliased as `thesun secret`). It reuses
// everything creds.go/hermesctl.go already do (credsSet/credsRemove/credsList,
// the stdin-only secret path, fetchHermesStatus) and adds three things the
// legacy `creds` surface doesn't have:
//
//  1. list ALL services with a stored secret, not just one you already know
//     the name of (creds.go's `list <service>` requires the name up front).
//  2. `show` — non-secret metadata (updatedAt, SSO session, which manifest
//     server(s) reference it) for one credential. The value is never fetched.
//  3. A restart-on-change hint: fleetd only resolves `hermescred://` refs at
//     spawn time (see internal/fleet supervisor spawn path), so changing a
//     credential does nothing to an already-running server until it restarts.
//     `add`/`set`/`rm` print which server(s) need `thesun restart <name>`.
//
// KISS: no new vault, no new crypto, no new IPC. Every mutation still shells
// out to `hermes creds ...` exactly like creds.go; this file only adds
// read-side aggregation and the restart-hint side effect. `thesun creds` /
// `fleetd creds` / `hermes creds` are untouched — no behavior removed.
import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
	"text/tabwriter"

	"mcp-fleet/fleetd/internal/fleet"
	"mcp-fleet/fleetd/internal/hermes"
	"mcp-fleet/fleetd/internal/manifest"
)

// runSecrets dispatches `thesun secrets ...` / `thesun secret ...`.
func runSecrets(args []string) int {
	if len(args) == 0 {
		return runMenuCreds(nil)
	}
	sub := args[0]
	rest := args[1:]
	switch sub {
	case "list", "ls":
		return secretsList(rest)
	case "add", "set", "enroll":
		return secretsSet(rest)
	case "rm", "remove", "delete", "del":
		return secretsRemove(rest)
	case "show":
		return secretsShow(rest)
	case "-h", "--help", "help":
		secretsUsage()
		return 0
	default:
		fmt.Fprintf(os.Stderr, "unknown secrets subcommand %q\n", sub)
		secretsUsage()
		return 2
	}
}

func secretsUsage() {
	fmt.Fprint(os.Stderr, `thesun secrets — unified credential + auth-session front door (Hermes-backed)

  thesun secrets                     interactive TUI (auth/creds view)
  thesun secrets list                 every service with a stored secret, plus
                                      SSO status in a separate column
  thesun secrets list <svc>           one service's accounts + SSO status
  thesun secrets add|set <svc> <acct> store a credential — value via stdin/
                                      hidden prompt ONLY, never argv
  thesun secrets rm <svc> <acct>      delete a stored credential
  thesun secrets show <svc> <acct>    metadata only: updatedAt, SSO session,
                                      referencing server(s) — value NEVER shown

add/set/rm print a restart hint when a manifest server resolves
hermescred://<svc>/<acct> only at spawn time.

fleetd/hermes 'creds' are kept as aliases — same vault, no behavior removed.
`)
}

// secretsList enumerates every service with a stored secret (via `hermes
// creds services --json`), merged with SSO-registered services (`hermes
// status --json`) in a separate column so the two concepts never conflate.
// With a service argument it delegates unchanged to creds.go's credsList,
// which already shows that one service's accounts + SSO status.
func secretsList(args []string) int {
	asJSON := false
	var service string
	for _, a := range args {
		if a == "--json" {
			asJSON = true
		} else if service == "" {
			service = a
		}
	}
	if service != "" {
		return credsList(args)
	}

	entries, err := credServices()
	if err != nil {
		fmt.Fprintf(os.Stderr, "thesun: %v\n", err)
		return 1
	}
	st, statusErr := fetchHermesStatus()
	ssoByService := map[string][]hermesService{}
	if statusErr == nil {
		for _, s := range st.Services {
			ssoByService[s.Service] = append(ssoByService[s.Service], s)
		}
	}
	printed := map[string]bool{}
	for _, e := range entries {
		printed[e.Service] = true
	}
	var ssoOnly []string
	for svc := range ssoByService {
		if !printed[svc] {
			ssoOnly = append(ssoOnly, svc)
		}
	}
	sort.Strings(ssoOnly)

	if asJSON {
		type outSvc struct {
			Service  string              `json:"service"`
			Accounts []hermesCredAccount `json:"accounts,omitempty"`
			SSO      []hermesService     `json:"sso,omitempty"`
		}
		out := make([]outSvc, 0, len(entries)+len(ssoOnly))
		for _, e := range entries {
			out = append(out, outSvc{Service: e.Service, Accounts: e.Accounts, SSO: ssoByService[e.Service]})
		}
		for _, svc := range ssoOnly {
			out = append(out, outSvc{Service: svc, SSO: ssoByService[svc]})
		}
		b, _ := json.MarshalIndent(out, "", "  ")
		fmt.Println(string(b))
		return 0
	}

	if len(entries) == 0 && len(ssoOnly) == 0 {
		fmt.Println("no credentials stored and no SSO sessions registered")
		return 0
	}
	tw := tabwriter.NewWriter(os.Stdout, 0, 2, 2, ' ', 0)
	fmt.Fprintln(tw, "SERVICE\tSTORED ACCOUNTS\tSSO STATUS")
	for _, e := range entries {
		fmt.Fprintf(tw, "%s\t%s\t%s\n", e.Service, formatCredAccounts(e.Accounts), formatSSOStatus(ssoByService[e.Service]))
	}
	for _, svc := range ssoOnly {
		fmt.Fprintf(tw, "%s\t%s\t%s\n", svc, "-", formatSSOStatus(ssoByService[svc]))
	}
	tw.Flush()
	return 0
}

func formatCredAccounts(accts []hermesCredAccount) string {
	if len(accts) == 0 {
		return "-"
	}
	parts := make([]string, 0, len(accts))
	for _, a := range accts {
		parts = append(parts, a.Account)
	}
	return strings.Join(parts, ",")
}

func formatSSOStatus(rows []hermesService) string {
	if len(rows) == 0 {
		return "-"
	}
	parts := make([]string, 0, len(rows))
	for _, r := range rows {
		parts = append(parts, r.Scheme+":"+r.Status)
	}
	return strings.Join(parts, ",")
}

// secretsSet stores a credential (upsert) via creds.go's credsSet — the
// identical secret-safe stdin path — then prints a restart hint if any
// manifest server resolves this ref only at spawn time.
func secretsSet(args []string) int {
	if len(args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: thesun secrets add|set <service> <account>")
		return 2
	}
	rc := credsSet(args)
	if rc == 0 {
		printRestartHint(args[0], args[1])
	}
	return rc
}

// secretsRemove deletes a credential via creds.go's credsRemove, then prints a
// restart hint under the same rule as secretsSet (removal changes resolution
// at the next spawn too — a running server keeps its already-injected env
// until restarted).
func secretsRemove(args []string) int {
	if len(args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: thesun secrets rm <service> <account>")
		return 2
	}
	rc := credsRemove(args)
	if rc == 0 {
		printRestartHint(args[0], args[1])
	}
	return rc
}

// secretsShow prints non-secret metadata for one credential: updatedAt,
// whether an SSO session exists for the service, and which manifest server(s)
// reference it. The value is NEVER fetched (no /cred, no /token call).
func secretsShow(args []string) int {
	if len(args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: thesun secrets show <service> <account>")
		return 2
	}
	service, account := args[0], args[1]

	updatedAt, ok, err := credShow(service, account)
	if err != nil {
		fmt.Fprintf(os.Stderr, "thesun: %v\n", err)
		return 1
	}
	if !ok {
		fmt.Fprintf(os.Stderr, "thesun: no credential found for %s/%s\n", service, account)
		return 1
	}

	fmt.Printf("%s/%s\n", service, account)
	fmt.Printf("  updated:   %s\n", updatedAt)

	if st, err := fetchHermesStatus(); err == nil {
		hasSSO := false
		for _, s := range st.Services {
			if s.Service == service {
				hasSSO = true
				fmt.Printf("  sso:       %s/%s — %s\n", s.Service, s.Scheme, s.Status)
			}
		}
		if !hasSSO {
			fmt.Println("  sso:       (no SSO session for this service)")
		}
	} else {
		fmt.Println("  sso:       (hermes status unavailable)")
	}

	names, err := referencingServers(service, account)
	switch {
	case err != nil:
		fmt.Printf("  used by:   (manifest unavailable: %v)\n", err)
	case len(names) == 0:
		fmt.Println("  used by:   (no manifest server references this credential)")
	default:
		fmt.Printf("  used by:   %s\n", strings.Join(names, ", "))
	}
	return 0
}

// printRestartHint warns that fleetd resolves hermescred:// refs only at
// spawn time — changing a credential does nothing to an already-running
// server until it restarts. Advisory only: an unloadable manifest (e.g. not
// yet initialized) is silently skipped, never an error for the caller.
func printRestartHint(service, account string) {
	names, err := referencingServers(service, account)
	if err != nil || len(names) == 0 {
		return
	}
	for _, n := range names {
		fmt.Printf("note: server %q resolves this only at spawn — run `thesun restart %s` to apply.\n", n, n)
	}
}

// referencingServers returns manifest server names whose env references
// hermescred://<service>/<account> exactly.
func referencingServers(service, account string) ([]string, error) {
	m, err := manifest.Load(fleet.ManifestPath())
	if err != nil {
		return nil, err
	}
	ref := hermes.CredRefPrefix + service + "/" + account
	var names []string
	for _, s := range m.Servers {
		for _, v := range s.Env {
			if v == ref {
				names = append(names, s.Name)
				break
			}
		}
	}
	return names, nil
}
