package cli

import (
	"flag"
	"fmt"
	"os"
	"strings"

	"mcp-fleet/fleetd/internal/fleet"
	"mcp-fleet/fleetd/internal/manifest"
)

// envFlag collects repeated --env KEY=VAL flags.
type envFlag map[string]string

func (e envFlag) String() string { return "" }
func (e envFlag) Set(v string) error {
	k, val, ok := strings.Cut(v, "=")
	if !ok || strings.TrimSpace(k) == "" {
		return fmt.Errorf("--env must be KEY=VALUE, got %q", v)
	}
	e[strings.TrimSpace(k)] = val
	return nil
}

func runAdd(args []string) int {
	// Accept the name as the leading positional arg (before flags).
	name := ""
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		name = args[0]
		args = args[1:]
	}

	fs := flag.NewFlagSet("add", flag.ExitOnError)
	cmdStr := fs.String("cmd", "", `server command: "BIN [ARG ...]" (first token is the binary)`)
	nameFlag := fs.String("name", "", "server name (alternative to positional)")
	kind := fs.String("kind", "", `entry kind: "mcp" (default) or "system" (infra: exempt from the static-port window, not published)`)
	port := fs.Int("port", 0, "loopback port (mcp: 42000-42999; system: any well-known port)")
	health := fs.String("health", "", "health path (default /healthz)")
	maxRestarts := fs.Int("max-restarts", 0, "circuit-breaker threshold (default 5)")
	env := envFlag{}
	fs.Var(env, "env", "environment KEY=VALUE (repeatable; hermescred:// refs allowed)")
	fs.Usage = func() {
		fmt.Fprintln(os.Stderr, `usage: fleetd add <name> --cmd "BIN [ARGS]" --port N [--env K=V ...] [--health /p] [--max-restarts N]`)
	}
	_ = fs.Parse(args)

	if name == "" {
		name = *nameFlag
	}
	if name == "" || *cmdStr == "" || *port == 0 {
		fs.Usage()
		fmt.Fprintln(os.Stderr, "fleetd: add requires <name>, --cmd, and --port")
		return 2
	}

	fields := strings.Fields(*cmdStr)
	if len(fields) == 0 {
		fmt.Fprintln(os.Stderr, "fleetd: --cmd is empty")
		return 2
	}
	spec := manifest.AddSpec{
		Name:        name,
		Kind:        *kind,
		Bin:         fields[0],
		Args:        fields[1:],
		Port:        *port,
		Env:         map[string]string(env),
		Health:      *health,
		MaxRestarts: *maxRestarts,
	}

	if err := manifest.Append(fleet.ManifestPath(), spec); err != nil {
		fmt.Fprintf(os.Stderr, "fleetd: %v\n", err)
		return 1
	}
	fmt.Printf("added %q (port %d) to %s (backup: %s.bak)\n", name, *port, fleet.ManifestPath(), fleet.ManifestPath())
	reloadAfterEdit()
	return 0
}

func runRemove(args []string) int {
	fs := flag.NewFlagSet("rm", flag.ExitOnError)
	all := fs.Bool("all", false, "remove every server from the manifest")
	fs.Usage = func() {
		fmt.Fprintln(os.Stderr, "usage: fleetd rm <name>... | --all")
	}
	_ = fs.Parse(args)

	var removed []string
	var err error
	if *all {
		removed, err = manifest.RemoveAll(fleet.ManifestPath())
	} else {
		if fs.NArg() < 1 {
			fs.Usage()
			return 2
		}
		removed, err = manifest.Remove(fleet.ManifestPath(), fs.Args())
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "fleetd: %v\n", err)
		return 1
	}
	fmt.Printf("removed %v from %s (backup: %s.bak)\n", removed, fleet.ManifestPath(), fleet.ManifestPath())
	reloadAfterEdit()
	return 0
}

// reloadAfterEdit asks a running daemon to re-read the manifest so the edit takes
// effect (start new / stop+drop removed). If the daemon is down, the file edit
// still stands and takes effect on next daemon start.
func reloadAfterEdit() {
	resp, err := fleet.SendControl(fleet.Request{Cmd: "reload"})
	if err != nil {
		fmt.Fprintf(os.Stderr, "note: manifest edited, but daemon reload skipped (%v); edit applies on next `fleetd run`\n", err)
		return
	}
	if resp.Message != "" {
		fmt.Println(resp.Message)
	}
	if !resp.OK && resp.Error != "" {
		fmt.Fprintln(os.Stderr, "reload error: "+resp.Error)
	}
}
