package main

// store.go is the browsable MCP Store experience: `thesun store` opens an
// interactive, category-grouped catalog browser (store_tui.go) and degrades to
// a static grouped listing (`thesun store list`) when stdout is not a TTY.
//
// Everything here is presentation. Every trust decision (revoked, community
// consent, curated lab gate, sha256, Ed25519) stays inside registryAdd; the
// store calls that one audited path and never reimplements verification. The
// badge helpers below are pure functions over real index state so a badge can
// never claim more than the data proves; they are unit-tested in store_test.go.

import (
	"context"
	"flag"
	"fmt"
	"os"
	"sort"
	"strings"

	"mcp-fleet/fleetd/internal/fleet"
	"mcp-fleet/fleetd/internal/manifest"
	"mcp-fleet/fleetd/internal/registry"
)

// ---- badges (pure, tested) ------------------------------------------------

// badgeLevel classifies a badge for styling: good (green), caution (yellow),
// bad (red).
type badgeLevel int

const (
	badgeGood badgeLevel = iota
	badgeCaution
	badgeBad
)

// storeBadge is a rendered-agnostic trust badge: a glyph, a label, and a
// styling level. The label states only what the index data proves; the
// cryptographic verification itself happens in registryAdd at install time.
type storeBadge struct {
	Glyph string
	Label string
	Level badgeLevel
}

// badgeFor derives the honest trust badge for an entry and its (usually
// latest) version. Revoked entries are delisted by callers before display, but
// the function is total and flags them anyway.
func badgeFor(e *registry.Entry, v *registry.Version) storeBadge {
	if e.Revoked {
		return storeBadge{"⛔", "REVOKED · delisted", badgeBad}
	}
	if v == nil {
		return storeBadge{"✖", "no released version", badgeBad}
	}
	if e.Curated() {
		switch {
		case !v.LabReport.Passed:
			return storeBadge{"✖", "curated · LAB FAILED (install will refuse)", badgeBad}
		case strings.TrimSpace(v.Ed25519Sig) == "":
			return storeBadge{"✖", "curated · UNSIGNED (install will refuse)", badgeBad}
		default:
			return storeBadge{"✔", "curated · lab-verified · signed", badgeGood}
		}
	}
	return storeBadge{"◇", "community · self-attested (unverified)", badgeCaution}
}

// safetyLabel summarizes the gateway write surface. A writer is honest about
// the runtime consequence: the gateway PEP gates its writes behind Tier-B
// approval regardless of tier.
func safetyLabel(v *registry.Version) string {
	if v == nil {
		return "unknown"
	}
	gm := v.GatewayManifest
	if gm.HasWrite {
		return fmt.Sprintf("⚠ writes: approval-gated (%dr/%dw)", gm.ReadCount, gm.WriteCount)
	}
	return "read-only"
}

// ---- category grouping (pure, tested) --------------------------------------

// storeCategory is one display group of the catalog.
type storeCategory struct {
	Name    string
	Entries []*registry.Entry
}

// categoryName normalizes an entry's category for grouping.
func categoryName(e *registry.Entry) string {
	c := strings.ToLower(strings.TrimSpace(e.Category))
	if c == "" {
		return "uncategorized"
	}
	return c
}

// groupByCategory groups entries into categories sorted alphabetically, with
// "uncategorized" always last; entries are sorted by name inside each group.
func groupByCategory(entries []*registry.Entry) []storeCategory {
	byCat := map[string][]*registry.Entry{}
	for _, e := range entries {
		c := categoryName(e)
		byCat[c] = append(byCat[c], e)
	}
	names := make([]string, 0, len(byCat))
	for c := range byCat {
		names = append(names, c)
	}
	sort.Slice(names, func(i, j int) bool {
		if names[i] == "uncategorized" {
			return false
		}
		if names[j] == "uncategorized" {
			return true
		}
		return names[i] < names[j]
	})
	out := make([]storeCategory, 0, len(names))
	for _, c := range names {
		es := byCat[c]
		sort.Slice(es, func(i, j int) bool { return es[i].Name < es[j].Name })
		out = append(out, storeCategory{Name: c, Entries: es})
	}
	return out
}

// ---- fuzzy filter (pure, tested) --------------------------------------------

// fuzzySubseq reports whether q is a case-insensitive subsequence of s
// ("shdn" matches "shodan"). An empty q matches everything.
func fuzzySubseq(s, q string) bool {
	s, q = strings.ToLower(s), strings.ToLower(q)
	i := 0
	for _, r := range s {
		if i >= len(q) {
			return true
		}
		if rune(q[i]) == r {
			i++
		}
	}
	return i >= len(q)
}

// entryMatchesFuzzy reports whether an entry matches a live filter query:
// subsequence on the name (fast to type), substring on description, category,
// and tags (precision where the text is prose).
func entryMatchesFuzzy(e *registry.Entry, q string) bool {
	q = strings.ToLower(strings.TrimSpace(q))
	if q == "" {
		return true
	}
	if fuzzySubseq(e.Name, q) {
		return true
	}
	if strings.Contains(strings.ToLower(e.Description), q) ||
		strings.Contains(categoryName(e), q) {
		return true
	}
	for _, t := range e.Tags {
		if strings.Contains(strings.ToLower(t), q) {
			return true
		}
	}
	return false
}

// filterStoreEntries applies the store's visibility rules: revoked entries are
// delisted (matching `thesun search`), then the tier and fuzzy filters apply.
func filterStoreEntries(idx *registry.Index, query, tier string) []*registry.Entry {
	var out []*registry.Entry
	for i := range idx.Entries {
		e := &idx.Entries[i]
		if e.Revoked {
			continue
		}
		if tier != "" && e.Tier != tier {
			continue
		}
		if !entryMatchesFuzzy(e, query) {
			continue
		}
		out = append(out, e)
	}
	return out
}

// ---- installed state ---------------------------------------------------------

// installedServers reads the live fleet manifest and returns a lookup from the
// name a store entry is keyed by to the actual manifest server name backing it.
// Legacy fleet servers migrated during the Go pilot carry a "-go" suffix, so
// index entry "shodan" resolves to manifest server "shodan-go"; a store-installed
// server resolves to itself. Both the exact name and the "-go"-stripped alias
// map to the real manifest name, so a caller can look up either form and, for a
// remove, recover the name fleetd actually knows. System entries (hermes,
// gateway) are skipped. A missing or unreadable manifest yields an empty map
// (everything shows as available) plus the error for the caller to surface.
func installedServers() (map[string]string, error) {
	names := map[string]string{}
	m, err := manifest.Load(fleet.ManifestPath())
	if err != nil {
		return names, err
	}
	for _, s := range m.Servers {
		if s.IsSystem() {
			continue
		}
		names[s.Name] = s.Name
		// Register the "-go"-stripped alias, but never let an alias clobber a
		// real bare server of the same name (exact match must win).
		if alias := strings.TrimSuffix(s.Name, "-go"); alias != s.Name {
			if _, exists := names[alias]; !exists {
				names[alias] = s.Name
			}
		}
	}
	return names, nil
}

// ---- dispatch ----------------------------------------------------------------

// storeCmd dispatches `thesun store`: the interactive browser on a TTY, the
// static grouped listing otherwise or when invoked as `thesun store list`.
func storeCmd(args []string) int {
	fs := flag.NewFlagSet("store", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	index := fs.String("index", "", "index reference (URL, file path, or file:// URL); default $THESUN_REGISTRY_INDEX or the compiled-in URL")
	tier := fs.String("tier", "", "filter by tier: curated | community")
	pos, rest := splitLeadingPositionals(args)
	if err := fs.Parse(rest); err != nil {
		return 2
	}
	positionals := append(pos, fs.Args()...)

	forceList := false
	if len(positionals) > 0 && positionals[0] == "list" {
		forceList = true
		positionals = positionals[1:]
	}
	query := strings.Join(positionals, " ")
	ref := registryIndexRef(*index)

	if forceList || !stdoutIsTTY() {
		return storeList(ref, query, *tier)
	}
	return runStoreTUI(ref, query, *tier)
}

// stdoutIsTTY reports whether stdout is a character device (an interactive
// terminal). Mirrors internal/cli's check for the dashboard.
func stdoutIsTTY() bool {
	fi, err := os.Stdout.Stat()
	if err != nil {
		return false
	}
	return fi.Mode()&os.ModeCharDevice != 0
}

// stdinIsTTY reports whether a human can actually answer a prompt.
//
// Separate from stdoutIsTTY on purpose: the two streams redirect independently,
// so an installer that pipes input can still hold a terminal on stdout, and a
// walkthrough that READS stdin has to gate on stdin.
//
// The char-device test alone is not enough here, because os.DevNull is itself a
// character device: `thesun install < /dev/null` would be classified as
// interactive, every prompt would read EOF, and the walkthrough would answer
// "no" to everything and exit 0 looking exactly like a human who declined. So
// the null device is excluded explicitly. os.SameFile compares the underlying
// device and inode rather than the path, and os.DevNull is "NUL" on Windows, so
// this holds on every supported target.
//
// A pipe is not a char device and so already reads as non-interactive, which is
// the right answer: piped input means a script, and a script should get the
// pointer rather than a walkthrough.
func stdinIsTTY() bool {
	fi, err := os.Stdin.Stat()
	if err != nil {
		return false
	}
	if fi.Mode()&os.ModeCharDevice == 0 {
		return false
	}
	if null, err := os.Stat(os.DevNull); err == nil && os.SameFile(fi, null) {
		return false
	}
	return true
}

// storeList prints the category-grouped catalog non-interactively: the same
// badges and install state as the browser, in plain scannable text.
func storeList(ref, query, tier string) int {
	idx, warnings, err := registry.FetchIndexAuth(context.Background(), ref, bearerForURL(context.Background(), ref))
	if err != nil {
		fmt.Fprintf(os.Stderr, "thesun store: %v\n", err)
		return 1
	}
	for _, w := range warnings {
		fmt.Fprintf(os.Stderr, "warning: %s\n", w)
	}
	installed, instErr := installedServers()

	entries := filterStoreEntries(idx, query, tier)
	if len(entries) == 0 {
		fmt.Println("no matching servers.")
		return 0
	}
	cats := groupByCategory(entries)

	fmt.Printf("thesun store · %d server(s) · index %s\n", len(entries), ref)
	if instErr != nil {
		fmt.Printf("(install state unavailable: %v)\n", instErr)
	}
	for _, cat := range cats {
		fmt.Printf("\n%s\n", strings.ToUpper(cat.Name))
		for _, e := range cat.Entries {
			v := e.Latest()
			b := badgeFor(e, v)
			state := "○ available"
			if _, ok := installed[e.Name]; ok {
				state = "● installed"
			}
			tools := 0
			auth := "none"
			if v != nil {
				tools = v.LabReport.ToolCount
				auth = authLabel(v.Auth)
			}
			fmt.Printf("  %s %-16s %s %s\n", state, e.Name, b.Glyph, b.Label)
			fmt.Printf("      %s\n", e.Description)
			fmt.Printf("      tools=%d · %s · auth=%s\n", tools, safetyLabel(v), auth)
		}
	}
	fmt.Printf("\ninstall:  thesun add <name>    browse interactively:  thesun store\n")
	return 0
}
