package cli

// Hermes credential/session delegation.
//
// fleetd does NOT own secret storage — Hermes is the single source of truth for
// the vault and SSO sessions. These helpers are a thin, friendly front-end that
// shells out to the Hermes CLI (`hermes`, or `node <repo>/.../cli.js`). Secret
// VALUES never pass through fleetd: `creds set` streams the value straight from
// our stdin into `hermes creds set` (Hermes reads it securely), and listing uses
// only values-free surfaces (`hermes status --json`, `hermes creds list`) —
// never the broker's /cred or /token endpoints (which return values).

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// hermesCLI resolves how to invoke the Hermes CLI, in order:
//  1. $HERMES_CLI (an explicit binary path)
//  2. `hermes` on $PATH
//  3. node <$HERMES_REPO|~/Projects/hermes>/packages/broker/dist/cli.js
//
// It returns (prog, prefixArgs) so callers append their own args.
func hermesCLI() (string, []string, error) {
	if cli := os.Getenv("HERMES_CLI"); cli != "" {
		return cli, nil, nil
	}
	if p, err := exec.LookPath("hermes"); err == nil {
		return p, nil, nil
	}
	home, _ := os.UserHomeDir()
	repo := os.Getenv("HERMES_REPO")
	if repo == "" {
		repo = filepath.Join(home, "Projects", "hermes")
	}
	js := filepath.Join(repo, "packages", "broker", "dist", "cli.js")
	if _, err := os.Stat(js); err == nil {
		node, err := exec.LookPath("node")
		if err != nil {
			return "", nil, fmt.Errorf("found Hermes CLI at %s but `node` is not on PATH", js)
		}
		return node, []string{js}, nil
	}
	return "", nil, fmt.Errorf("hermes CLI not found — install `hermes`, or set HERMES_CLI / HERMES_REPO")
}

// hermesCmd builds an *exec.Cmd for `hermes <args...>`.
func hermesCmd(ctx context.Context, args ...string) (*exec.Cmd, error) {
	prog, prefix, err := hermesCLI()
	if err != nil {
		return nil, err
	}
	full := append(append([]string{}, prefix...), args...)
	return exec.CommandContext(ctx, prog, full...), nil
}

// hermesExec builds an *exec.Cmd with no context deadline, for interactive
// hand-over (the TUI's tea.ExecProcess): browser SSO login or Hermes's own
// hidden credential prompt, both of which need the real terminal and can take
// minutes.
func hermesExec(args ...string) (*exec.Cmd, error) {
	prog, prefix, err := hermesCLI()
	if err != nil {
		return nil, err
	}
	full := append(append([]string{}, prefix...), args...)
	return exec.Command(prog, full...), nil
}

// ---- values-free status model (subset of `hermes status --json`) ----

type hermesEvidence struct {
	Kind    string `json:"kind"`
	Status  string `json:"status"`
	Details struct {
		AccessTokenExpiresAt string `json:"accessTokenExpiresAt"`
	} `json:"details"`
}

type hermesService struct {
	Service   string           `json:"service"`
	Scheme    string           `json:"scheme"`
	Status    string           `json:"status"`
	Reason    string           `json:"reason"`
	ProofTier string           `json:"proofTier"`
	Evidence  []hermesEvidence `json:"evidence"`
}

type hermesStatus struct {
	Status   string          `json:"status"`
	Summary  string          `json:"summary"`
	Services []hermesService `json:"services"`
}

// tokenExpiry returns the access-token expiry (RFC3339) from the service's
// evidence, or "" if none is recorded.
func (s hermesService) tokenExpiry() string {
	for _, e := range s.Evidence {
		if e.Kind == "token" {
			return e.Details.AccessTokenExpiresAt
		}
	}
	return ""
}

// fetchHermesStatus runs `hermes status --json` and parses it. stderr is
// discarded so incidental log lines never corrupt the JSON on stdout.
func fetchHermesStatus() (*hermesStatus, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cmd, err := hermesCmd(ctx, "status", "--json")
	if err != nil {
		return nil, err
	}
	out, err := cmd.Output() // stdout only
	if err != nil {
		// `hermes status` exits non-zero when the fleet is degraded but still
		// prints valid JSON — try to parse anyway before surfacing the error.
		if len(out) == 0 {
			return nil, fmt.Errorf("hermes status failed: %w", err)
		}
	}
	var st hermesStatus
	if jerr := json.Unmarshal(out, &st); jerr != nil {
		return nil, fmt.Errorf("hermes status: unparseable JSON: %w", jerr)
	}
	return &st, nil
}

// credAccounts runs `hermes creds list <service>` and returns the enrolled
// account names (values are never shown by Hermes). A "no credentials" result
// is an empty slice, not an error.
func credAccounts(service string) ([]string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd, err := hermesCmd(ctx, "creds", "list", service)
	if err != nil {
		return nil, err
	}
	out, _ := cmd.Output()
	var accts []string
	for _, ln := range strings.Split(string(out), "\n") {
		ln = strings.TrimSpace(ln)
		if ln == "" || strings.Contains(strings.ToLower(ln), "no credentials stored") {
			continue
		}
		accts = append(accts, ln)
	}
	return accts, nil
}

// ---- cross-service enumeration (`thesun secrets` — values-free) ----

// hermesCredAccount is one stored account's non-secret metadata.
type hermesCredAccount struct {
	Account   string `json:"account"`
	UpdatedAt string `json:"updatedAt"`
}

// hermesCredServiceEntry is one service with its enrolled accounts, as
// returned by `hermes creds services --json`.
type hermesCredServiceEntry struct {
	Service  string              `json:"service"`
	Accounts []hermesCredAccount `json:"accounts"`
}

// credServices runs `hermes creds services --json` and returns every service
// that has at least one stored credential, with each account's updatedAt.
// Values are never shown by Hermes.
func credServices() ([]hermesCredServiceEntry, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd, err := hermesCmd(ctx, "creds", "services", "--json")
	if err != nil {
		return nil, err
	}
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("hermes creds services failed: %w", err)
	}
	var entries []hermesCredServiceEntry
	if jerr := json.Unmarshal(out, &entries); jerr != nil {
		return nil, fmt.Errorf("hermes creds services: unparseable JSON: %w", jerr)
	}
	return entries, nil
}

// credShow runs `hermes creds show <service> <account> --json` and returns
// the entry's non-secret metadata. ok=false (with err=nil) means the
// credential does not exist — that is an expected outcome, not a failure.
func credShow(service, account string) (updatedAt string, ok bool, err error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd, cmdErr := hermesCmd(ctx, "creds", "show", service, account, "--json")
	if cmdErr != nil {
		return "", false, cmdErr
	}
	out, runErr := cmd.Output()
	if runErr != nil {
		// `hermes creds show` exits 1 when the credential is not found.
		return "", false, nil
	}
	var meta struct {
		UpdatedAt string `json:"updatedAt"`
	}
	if jerr := json.Unmarshal(out, &meta); jerr != nil {
		return "", false, fmt.Errorf("hermes creds show: unparseable JSON: %w", jerr)
	}
	return meta.UpdatedAt, true, nil
}
