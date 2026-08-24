// wire_cmd.go is the `thesun wire` command.
//
// Wiring already ran as a step inside `thesun install`, but it needs to be
// runnable on its own for a reason that bites in practice: client detection is
// presence-based, so a client installed AFTER thesun was never wired, and the
// install-time report said "not-detected" and moved on. The documentation has
// told people to run `thesun wire` for a while; this is that command.
//
// It also carries the two subcommands for the problem the doctor check reports:
// --report lists every MCP registration each client holds, and --prune removes
// the ones that are prohibited or dead. Pruning is opt-in, previewed by default,
// and backs up each file it touches, because these are the developer's own
// configs and some entries in them are deliberate.
package cli

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/BurntSushi/toml"
)

// WireCmd implements `thesun wire`. defaultURL is passed in rather than resolved
// here because gateway URL resolution (env override, then the loaded suite
// manifest, then the default port) lives with the rest of the stack commands.
func WireCmd(args []string, defaultURL string) int {
	fs := flag.NewFlagSet("wire", flag.ExitOnError)
	report := fs.Bool("report", false, "list every MCP server registration per client and exit")
	prune := fs.Bool("prune", false, "remove stdio and dead-port registrations that bypass the gateway")
	yes := fs.Bool("yes", false, "with --prune, actually apply the changes (otherwise a preview)")
	gatewayURL := fs.String("url", "", "gateway URL to wire (default: the configured gateway)")
	_ = fs.Parse(args)

	home, err := os.UserHomeDir()
	if err != nil {
		fmt.Fprintln(os.Stderr, "thesun wire: cannot resolve home directory:", err)
		return 1
	}
	cwd, _ := os.Getwd()

	switch {
	case *report:
		return wireReport(home, cwd)
	case *prune:
		return wirePrune(home, cwd, *yes)
	}

	url := *gatewayURL
	if url == "" {
		url = defaultURL
	}

	fmt.Printf("wiring AI clients to %s\n\n", url)
	results := WireClients(home, cwd, url)
	wired := 0
	for _, r := range results {
		switch r.Status {
		case "wired", "already-wired":
			wired++
			fmt.Printf("  ok        %-32s %s\n", r.Client, r.Path)
		case "not-detected":
			fmt.Printf("  skipped   %-32s not installed on this machine\n", r.Client)
		default:
			fmt.Printf("  ERROR     %-32s %s\n", r.Client, r.Detail)
		}
	}
	fmt.Printf("\n%d client(s) wired. Every one points at the same gateway, which is the\n", wired)
	fmt.Println("policy enforcement point; `thesun wire --report` shows anything that does not.")
	return 0
}

// wireReport prints the full registration table. This is the detail behind the
// doctor summary, and the thing to read before deciding to prune.
func wireReport(home, cwd string) int {
	regs := CollectClientMCPRegistrations(home, cwd)
	if len(regs) == 0 {
		fmt.Println("No AI client on this machine has any MCP server registered.")
		fmt.Println("Run `thesun wire` to point them at the gateway.")
		return 0
	}

	fmt.Println("MCP server registrations, by client.")
	fmt.Println()
	fmt.Println("  gateway  routed through thesun's policy enforcement point")
	fmt.Println("  live     reachable, but registered directly: it bypasses the gateway")
	fmt.Println("  dead     nothing is listening; the client retries it every session")
	fmt.Println("  stdio    prohibited transport: deadlocks under supervision, exposes zero tools")
	fmt.Println()

	var current string
	for _, r := range regs {
		if r.Client != current {
			current = r.Client
			fmt.Printf("%s\n", current)
		}
		fmt.Printf("   %-8s %-28s %s\n", mcpVerdict(r), r.Name, r.URL)
	}

	stdio, dead, live := countRegs(regs)
	fmt.Println()
	fmt.Printf("%d registration(s): %d gateway, %d live outside the gateway, %d dead, %d stdio.\n",
		len(regs), len(regs)-stdio-dead-live, live, dead, stdio)
	if stdio+dead > 0 {
		fmt.Println("`thesun wire --prune` previews removing the dead and stdio ones.")
	}
	return 0
}

// mcpVerdict is the single-word classification shown in the report.
func mcpVerdict(r mcpRegistration) string {
	switch {
	case r.Name == GatewayEntryName:
		return "gateway"
	case r.Transport == "stdio":
		return "stdio"
	case !r.Live:
		return "dead"
	default:
		return "live"
	}
}

func countRegs(regs []mcpRegistration) (stdio, dead, live int) {
	for _, r := range regs {
		if r.Name == GatewayEntryName {
			continue
		}
		switch {
		case r.Transport == "stdio":
			stdio++
		case !r.Live:
			dead++
		default:
			live++
		}
	}
	return
}

// prunable reports whether an entry is one --prune removes. The rule is
// deliberately narrow: prohibited transport, or nothing listening. A live
// non-gateway server is left alone, because it may be a deliberate direct
// wiring the operator wants, and a diagnostic should not overrule that.
func prunable(r mcpRegistration) bool {
	if r.Name == GatewayEntryName {
		return false
	}
	return r.Transport == "stdio" || !r.Live
}

// wirePrune removes prohibited and dead registrations. Without --yes it only
// prints what it would do.
func wirePrune(home, cwd string, apply bool) int {
	regs := CollectClientMCPRegistrations(home, cwd)
	var doomed []mcpRegistration
	for _, r := range regs {
		if prunable(r) {
			doomed = append(doomed, r)
		}
	}
	if len(doomed) == 0 {
		fmt.Println("Nothing to prune: no stdio or dead-port registrations found.")
		return 0
	}

	stdio, dead, live := countRegs(regs)
	fmt.Printf("%d registration(s) would be removed (%d stdio, %d dead port).\n", len(doomed), stdio, dead)
	if live > 0 {
		fmt.Printf("%d live non-gateway server(s) will be LEFT ALONE; a reachable server may be\n", live)
		fmt.Println("a deliberate direct wiring, so removing it is your call, not this command's.")
	}
	fmt.Println()
	var current string
	for _, r := range doomed {
		if r.Client != current {
			current = r.Client
			fmt.Printf("%s\n", current)
		}
		reason := "dead port"
		if r.Transport == "stdio" {
			reason = "stdio (prohibited)"
		}
		fmt.Printf("   remove  %-28s %s\n", r.Name, reason)
	}
	fmt.Println()

	if !apply {
		fmt.Println("This was a preview. Re-run with --yes to apply:")
		fmt.Println("    thesun wire --prune --yes")
		fmt.Println("Each file is backed up before it is changed.")
		return 0
	}

	// Group by the file that holds them, so each config is rewritten once. The
	// entries carry their own file and container, so nothing here has to map a
	// display label back to a path and guess which map inside it was meant.
	byFile := map[string][]mcpRegistration{}
	for _, r := range doomed {
		if r.File == "" {
			continue
		}
		byFile[r.File] = append(byFile[r.File], r)
	}

	paths := make([]string, 0, len(byFile))
	for p := range byFile {
		paths = append(paths, p)
	}
	sort.Strings(paths)

	failed := 0
	for _, path := range paths {
		targets := byFile[path]
		backup, err := pruneFile(path, targets)
		if err != nil {
			fmt.Printf("  ERROR  %s: %v\n", path, err)
			failed++
			continue
		}
		fmt.Printf("  pruned %d from %s (backup: %s)\n", len(targets), path, filepath.Base(backup))
	}
	if failed > 0 {
		return 1
	}
	fmt.Println()
	fmt.Println("Done. Restart any running AI client so it re-reads its config.")
	return 0
}

// backupFile copies path beside itself with a timestamp suffix. A timestamp
// rather than a fixed name so a second prune cannot destroy the record of the
// first.
func backupFile(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	dst := fmt.Sprintf("%s.thesun-bak-%s", path, time.Now().Format("20060102-150405"))
	if err := os.WriteFile(dst, b, 0o600); err != nil {
		return "", err
	}
	return dst, nil
}

// pruneFile removes the named servers from one config file, preserving
// everything else in it. targets carry their own container path, so only the
// map each entry was actually found in is touched.
func pruneFile(path string, targets []mcpRegistration) (string, error) {
	backup, err := backupFile(path)
	if err != nil {
		return "", err
	}
	if strings.HasSuffix(path, ".toml") {
		return backup, pruneCodexTOML(path, targets)
	}
	return backup, pruneJSONConfig(path, targets)
}

// resolveContainer walks a container path ("mcpServers",
// "projects/<key>/mcpServers") to the map it names, without creating anything.
// A path that does not resolve returns nil, which prunes nothing: an entry we
// can no longer find is one the file no longer holds.
func resolveContainer(doc map[string]any, container string) map[string]any {
	// Split on the LAST separator only. A project key is itself a filesystem
	// path full of slashes, so splitting on every separator would shred it.
	node := doc
	if i := strings.Index(container, "/"); i >= 0 {
		outer, rest := container[:i], container[i+1:]
		j := strings.LastIndex(rest, "/")
		if j < 0 {
			return nil
		}
		key, leaf := rest[:j], rest[j+1:]
		m, ok := doc[outer].(map[string]any)
		if !ok {
			return nil
		}
		child, ok := m[key].(map[string]any)
		if !ok {
			return nil
		}
		node, container = child, leaf
	}
	out, _ := node[container].(map[string]any)
	return out
}

// pruneJSONConfig deletes each target from the exact container it was collected
// from.
//
// Deleting by name across every container in the file was a real bug: a dead
// project-scoped `foo` and a LIVE global `foo` both live in ~/.claude.json, the
// preview correctly promises to leave the live one alone, and a name-wide
// delete removes it anyway. A destructive command whose preview lies is worse
// than no command.
func pruneJSONConfig(path string, targets []mcpRegistration) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var doc map[string]any
	if err := json.Unmarshal(b, &doc); err != nil {
		return fmt.Errorf("not valid JSON, refusing to rewrite: %w", err)
	}

	for _, t := range targets {
		if c := resolveContainer(doc, t.Container); c != nil {
			delete(c, t.Name)
		}
	}

	out, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(out, '\n'), 0o600)
}

// pruneCodexTOML removes [mcp_servers.<name>] tables. It re-encodes the decoded
// document, which normalises formatting and drops comments; the backup written
// beforehand is the recovery path for anyone who cared about those.
func pruneCodexTOML(path string, targets []mcpRegistration) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var doc map[string]any
	if _, err := toml.Decode(string(b), &doc); err != nil {
		return fmt.Errorf("not valid TOML, refusing to rewrite: %w", err)
	}
	if servers, ok := doc["mcp_servers"].(map[string]any); ok {
		for _, t := range targets {
			delete(servers, t.Name)
		}
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".thesun-wire-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	if err := toml.NewEncoder(f).Encode(doc); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, path)
}
