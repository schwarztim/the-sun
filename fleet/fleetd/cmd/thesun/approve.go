package main

// approve.go implements `thesun approve` and `thesun grants` — thin HTTP
// clients over the gateway's loopback-only Tier-B approval channel
// (/approve, /grants). The gateway (Node, gateway/src/approvals.ts +
// gateway.ts setupApprovalRoutes) owns the approvals.json/grants.json store;
// this file only talks HTTP to it, mirroring gatewayCmd's pattern in
// stack.go — no store logic is duplicated here.
//
// SC-4 design constraint: nothing that authorizes a Tier-B call may travel
// through the model. PRODUCTION / VAULT_VALUE / HUMAN_OUTBOUND and any
// write_guard-flagged tool never accept a model-supplied confirmed:true —
// these two commands are how a HUMAN AT THE CONSOLE authorizes them instead.

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"text/tabwriter"
	"time"
)

type pendingApproval struct {
	ID          string `json:"id"`
	Ts          string `json:"ts"`
	Identity    string `json:"identity"`
	Backend     string `json:"backend"`
	Tool        string `json:"tool"`
	ArgsSummary string `json:"argsSummary"`
	SafetyClass string `json:"safetyClass"`
	ExpiresAt   string `json:"expiresAt"`
	Summary     string `json:"summary"`
}

type standingGrant struct {
	ID        string `json:"id"`
	Identity  string `json:"identity"`
	Backend   string `json:"backend"`
	Tool      string `json:"tool"`
	CreatedAt string `json:"createdAt"`
	ExpiresAt string `json:"expiresAt,omitempty"`
	OneTime   bool   `json:"oneTime,omitempty"`
}

var approvalHTTPClient = &http.Client{Timeout: 8 * time.Second}

// httpJSON does a method+url request with an optional JSON body and returns
// the status code + raw response body. Distinct from stack.go's httpText
// (which returns a plain string and is used for the simpler gateway status/
// reload probes) because callers here need to unmarshal structured JSON.
func httpJSON(method, url string, body any) (int, []byte, error) {
	var reqBody io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return 0, nil, fmt.Errorf("marshal request body: %w", err)
		}
		reqBody = strings.NewReader(string(b))
	}
	req, err := http.NewRequest(method, url, reqBody)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("accept", "application/json")
	if body != nil {
		req.Header.Set("content-type", "application/json")
	}
	resp, err := approvalHTTPClient.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	return resp.StatusCode, b, nil
}

// ---- thesun approve ----

func approveCmd(args []string) int {
	if len(args) > 0 && (args[0] == "-h" || args[0] == "--help") {
		approveUsage()
		return 0
	}

	var id string
	always := false
	ttlMinutes := 0
	for _, a := range args {
		switch {
		case a == "--always":
			always = true
		case strings.HasPrefix(a, "--ttl="):
			var err error
			ttlMinutes, err = parseTTL(strings.TrimPrefix(a, "--ttl="))
			if err != nil {
				fmt.Fprintf(os.Stderr, "thesun approve: %v\n", err)
				approveUsage()
				return 2
			}
		case strings.HasPrefix(a, "--"):
			fmt.Fprintf(os.Stderr, "thesun approve: unknown flag %q\n", a)
			approveUsage()
			return 2
		case id == "":
			id = a
		default:
			fmt.Fprintf(os.Stderr, "thesun approve: unexpected argument %q\n", a)
			approveUsage()
			return 2
		}
	}

	base := gatewayURL()

	// Only fetch/print the pending list when no id was given on the command
	// line — a direct `thesun approve <id>` never needs the list endpoint.
	if id == "" {
		pending, err := fetchPending(base)
		if err != nil {
			fmt.Fprintf(os.Stderr, "thesun: gateway not reachable at %s (%v)\n", base, err)
			return 1
		}
		if len(pending) == 0 {
			fmt.Println("no pending Tier-B approvals")
			return 0
		}
		printPending(pending)
		id = promptLine("Approve which id (blank to cancel): ")
		if id == "" {
			fmt.Println("cancelled — no id selected")
			return 0
		}
		if !always {
			always = promptYesNo("Standing grant (always allow this backend+tool going forward)?")
		}
	}

	body := map[string]any{"id": id}
	if always {
		body["standing"] = true
	}
	if ttlMinutes > 0 {
		body["ttlMinutes"] = ttlMinutes
	}
	code, respBody, err := httpJSON(http.MethodPost, base+"/approve", body)
	if err != nil {
		fmt.Fprintf(os.Stderr, "thesun: approve request failed: %v\n", err)
		return 1
	}
	if code == http.StatusNotFound {
		fmt.Fprintf(os.Stderr, "thesun: no pending approval with id %q (expired or already actioned)\n", id)
		return 1
	}
	if code >= 300 {
		fmt.Fprintf(os.Stderr, "thesun: approve failed (%d): %s\n", code, string(respBody))
		return 1
	}

	var out struct {
		Status   string        `json:"status"`
		ID       string        `json:"id"`
		Standing bool          `json:"standing"`
		Grant    standingGrant `json:"grant"`
	}
	if err := json.Unmarshal(respBody, &out); err != nil {
		fmt.Println(string(respBody))
		return 0
	}
	kind := "one-time"
	if out.Standing {
		kind = "standing"
	}
	fmt.Printf("approved %s (%s grant) — %s.%s\n", out.ID, kind, out.Grant.Backend, out.Grant.Tool)
	return 0
}

func fetchPending(base string) ([]pendingApproval, error) {
	code, body, err := httpJSON(http.MethodGet, base+"/approve", nil)
	if err != nil {
		return nil, err
	}
	if code >= 300 {
		return nil, fmt.Errorf("gateway returned %d: %s", code, string(body))
	}
	var out struct {
		Pending []pendingApproval `json:"pending"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("parse response: %w", err)
	}
	return out.Pending, nil
}

func printPending(pending []pendingApproval) {
	tw := tabwriter.NewWriter(os.Stdout, 0, 2, 2, ' ', 0)
	fmt.Fprintln(tw, "ID\tCLASS\tBACKEND.TOOL\tIDENTITY\tARGS\tEXPIRES")
	for _, p := range pending {
		fmt.Fprintf(tw, "%s\t%s\t%s.%s\t%s\t%s\t%s\n", p.ID, p.SafetyClass, p.Backend, p.Tool, p.Identity, p.ArgsSummary, p.ExpiresAt)
	}
	tw.Flush()
}

// promptLine and promptYesNo read one line from stdin. On a non-interactive
// stdin (piped/closed) Scan() returns false immediately — treated the same
// as an empty/no answer rather than blocking, so `thesun approve` never
// hangs a script that forgot to pass an id.
func promptLine(prompt string) string {
	fmt.Print(prompt)
	scanner := bufio.NewScanner(os.Stdin)
	if !scanner.Scan() {
		return ""
	}
	return strings.TrimSpace(scanner.Text())
}

func promptYesNo(question string) bool {
	ans := strings.ToLower(promptLine(question + " [y/N]: "))
	return ans == "y" || ans == "yes"
}

func approveUsage() {
	fmt.Fprint(os.Stderr, `thesun approve — authorize a parked Tier-B tool call (SC-4 out-of-band approval)

  thesun approve                 list pending approvals, prompt for one
  thesun approve <id>             approve one-time (the exact next dispatch proceeds, then re-parks)
  thesun approve <id> --always    approve + create a standing grant (persists across dispatches)
  thesun approve <id> --ttl=N     cap the grant's lifetime: N minutes, or with
                                  a unit suffix — --ttl=45m / --ttl=12h /
                                  --ttl=30d. Composes with --always (a standing
                                  grant that self-expires); without --always the
                                  one-time approval expires if unused by then.

Tier-B classes (PRODUCTION, VAULT_VALUE, HUMAN_OUTBOUND, or any write_guard-
flagged tool) never accept a model-supplied confirmed:true — this is the only
way to authorize them. Talks to the gateway's loopback-only /approve endpoint
(same host as 'thesun gateway status'); there is no MCP tool that can reach it.
`)
}

// ---- thesun grants ----

func grantsCmd(args []string) int {
	sub := "list"
	if len(args) > 0 {
		sub = args[0]
	}
	switch sub {
	case "list", "ls", "":
		return grantsList()
	case "rm", "remove", "revoke":
		if len(args) < 2 {
			fmt.Fprintln(os.Stderr, "usage: thesun grants rm <id>")
			return 2
		}
		return grantsRevoke(args[1])
	case "-h", "--help", "help":
		grantsUsage()
		return 0
	default:
		fmt.Fprintf(os.Stderr, "thesun grants: unknown subcommand %q\n", sub)
		grantsUsage()
		return 2
	}
}

func grantsList() int {
	base := gatewayURL()
	code, body, err := httpJSON(http.MethodGet, base+"/grants", nil)
	if err != nil {
		fmt.Fprintf(os.Stderr, "thesun: gateway not reachable at %s (%v)\n", base, err)
		return 1
	}
	if code >= 300 {
		fmt.Fprintf(os.Stderr, "thesun: grants list failed (%d): %s\n", code, string(body))
		return 1
	}
	var out struct {
		Grants []standingGrant `json:"grants"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		fmt.Println(string(body))
		return 0
	}
	if len(out.Grants) == 0 {
		fmt.Println("no standing grants")
		return 0
	}
	tw := tabwriter.NewWriter(os.Stdout, 0, 2, 2, ' ', 0)
	fmt.Fprintln(tw, "ID\tBACKEND.TOOL\tIDENTITY\tKIND\tCREATED\tEXPIRES")
	for _, g := range out.Grants {
		kind := "standing"
		if g.OneTime {
			kind = "one-time"
		}
		expires := g.ExpiresAt
		if expires == "" {
			expires = "-"
		}
		fmt.Fprintf(tw, "%s\t%s.%s\t%s\t%s\t%s\t%s\n", g.ID, g.Backend, g.Tool, g.Identity, kind, g.CreatedAt, expires)
	}
	tw.Flush()
	return 0
}

func grantsRevoke(id string) int {
	base := gatewayURL()
	code, body, err := httpJSON(http.MethodDelete, base+"/grants/"+id, nil)
	if err != nil {
		fmt.Fprintf(os.Stderr, "thesun: gateway not reachable at %s (%v)\n", base, err)
		return 1
	}
	if code == http.StatusNotFound {
		fmt.Fprintf(os.Stderr, "thesun: no grant with id %q\n", id)
		return 1
	}
	if code >= 300 {
		fmt.Fprintf(os.Stderr, "thesun: revoke failed (%d): %s\n", code, string(body))
		return 1
	}
	fmt.Printf("revoked %s\n", id)
	return 0
}

func grantsUsage() {
	fmt.Fprint(os.Stderr, `thesun grants — manage Tier-B standing grants (SC-4)

  thesun grants [list]      every standing/one-time grant (identity, backend.tool, kind, expiry)
  thesun grants rm <id>     revoke a grant — the next matching call re-parks for approval
`)
}
