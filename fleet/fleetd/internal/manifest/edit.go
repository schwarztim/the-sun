package manifest

// Text-based manifest editing for `fleetd add` / `fleetd rm`.
//
// We deliberately do NOT round-trip the manifest through toml.Marshal: the
// operator's fleet.toml carries hand-written comments (per-server auth notes)
// and intentional formatting that a marshal/unmarshal cycle would destroy.
// Instead we append a new [[server]] block as text, or cut existing blocks by
// name, leaving every other byte untouched. Every write backs up the prior file
// to <path>.bak and is atomic (temp + rename) so a crash mid-write never leaves
// a half-written manifest.

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// AddSpec is the input to Append — a new server to add to the manifest.
type AddSpec struct {
	Name        string
	Kind        string // "" or "mcp" (default) | "system"
	Bin         string
	Args        []string
	Port        int
	Env         map[string]string
	Health      string
	MaxRestarts int
}

// serverHeaderRe matches a "[[server]]" table-array header line (leading space
// tolerated; trailing comment tolerated).
var serverHeaderRe = regexp.MustCompile(`^\s*\[\[\s*server\s*\]\]`)

// nameKeyRe matches a top-level `name = "..."` key line inside a server block.
var nameKeyRe = regexp.MustCompile(`^\s*name\s*=\s*"([^"]*)"`)

// Append validates spec against the current manifest (no duplicate name/port),
// appends a new [[server]] block to the manifest text at path, and commits it
// atomically after re-parsing the full result. Returns an error (and leaves the
// file untouched) on any collision, parse failure, or IO error.
func Append(path string, spec AddSpec) error {
	spec.Name = strings.TrimSpace(spec.Name)
	spec.Bin = strings.TrimSpace(spec.Bin)
	if spec.Name == "" {
		return fmt.Errorf("add: server name is required")
	}
	if spec.Bin == "" {
		return fmt.Errorf("add: --cmd (server binary) is required")
	}
	kind := strings.TrimSpace(spec.Kind)
	if kind == "" {
		kind = KindMCP
	}
	if kind != KindMCP && kind != KindSystem {
		return fmt.Errorf("add: invalid kind %q (want %q or %q)", kind, KindMCP, KindSystem)
	}
	if spec.Port <= 0 {
		return fmt.Errorf("add: port is required")
	}
	// Only MCP servers are confined to the static window; system infra binds its
	// own well-known port.
	if kind == KindMCP && (spec.Port < PortMin || spec.Port > PortMax) {
		return fmt.Errorf("add: port %d out of range (must be %d-%d)", spec.Port, PortMin, PortMax)
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("add: read manifest %s: %w", path, err)
	}
	cur, err := Parse(raw)
	if err != nil {
		return fmt.Errorf("add: current manifest is invalid, refusing to edit: %w", err)
	}
	for _, sv := range cur.Servers {
		if sv.Name == spec.Name {
			return fmt.Errorf("add: server %q already exists", spec.Name)
		}
		if sv.Port == spec.Port {
			return fmt.Errorf("add: port %d already used by %q", spec.Port, sv.Name)
		}
	}

	block := renderBlock(spec)
	next := string(raw)
	if !strings.HasSuffix(next, "\n") {
		next += "\n"
	}
	next += block

	// Fail closed: the edited manifest must parse+validate before we commit it.
	if _, err := Parse([]byte(next)); err != nil {
		return fmt.Errorf("add: edited manifest failed validation (not written): %w", err)
	}
	return writeAtomicWithBackup(path, []byte(next))
}

// Remove cuts the [[server]] blocks whose names appear in names from the
// manifest text at path, preserving all other formatting and comments, then
// commits atomically. Returns the names actually removed (missing names are
// reported via the error only if NONE matched).
func Remove(path string, names []string) ([]string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("rm: read manifest %s: %w", path, err)
	}
	want := map[string]bool{}
	for _, n := range names {
		want[strings.TrimSpace(n)] = true
	}

	preamble, blocks := splitBlocks(string(raw))
	var kept []string
	var removed []string
	out := preamble
	for _, blk := range blocks {
		name := blockName(blk)
		if want[name] {
			removed = append(removed, name)
			continue
		}
		out += blk
		kept = append(kept, name)
	}
	if len(removed) == 0 {
		return nil, fmt.Errorf("rm: no matching server(s) in manifest for %v", names)
	}

	// A non-empty result must still parse+validate; an empty result (rm --all)
	// is written as-is since the daemon fails closed on an empty manifest and
	// the operator explicitly asked to clear it.
	if len(kept) > 0 {
		if _, err := Parse([]byte(out)); err != nil {
			return nil, fmt.Errorf("rm: edited manifest failed validation (not written): %w", err)
		}
	}
	if err := writeAtomicWithBackup(path, []byte(out)); err != nil {
		return nil, err
	}
	sort.Strings(removed)
	return removed, nil
}

// RemoveAll removes every server block, leaving only the preamble.
func RemoveAll(path string) ([]string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("rm: read manifest %s: %w", path, err)
	}
	_, blocks := splitBlocks(string(raw))
	var names []string
	for _, blk := range blocks {
		if n := blockName(blk); n != "" {
			names = append(names, n)
		}
	}
	if len(names) == 0 {
		return nil, fmt.Errorf("rm --all: manifest has no servers")
	}
	return Remove(path, names)
}

// splitBlocks separates the manifest text into a preamble (everything before the
// first [[server]] header) and a slice of block strings, one per server. Each
// block runs from its [[server]] header line up to (but not including) the next
// header, so in-block comments and blank lines travel with their block.
func splitBlocks(text string) (preamble string, blocks []string) {
	lines := strings.SplitAfter(text, "\n") // keep line endings
	var pre strings.Builder
	var cur strings.Builder
	started := false
	flush := func() {
		if started {
			blocks = append(blocks, cur.String())
			cur.Reset()
		}
	}
	for _, ln := range lines {
		if serverHeaderRe.MatchString(ln) {
			flush()
			started = true
			cur.WriteString(ln)
			continue
		}
		if started {
			cur.WriteString(ln)
		} else {
			pre.WriteString(ln)
		}
	}
	flush()
	return pre.String(), blocks
}

// blockName extracts the server name from a block, or "" if absent.
func blockName(block string) string {
	for _, ln := range strings.Split(block, "\n") {
		if m := nameKeyRe.FindStringSubmatch(ln); m != nil {
			return m[1]
		}
	}
	return ""
}

// renderBlock serializes an AddSpec to a TOML [[server]] block. Defaults mirror
// manifest validation (health=/healthz, max_restarts=5). A leading blank line
// separates it from the prior block.
func renderBlock(spec AddSpec) string {
	health := strings.TrimSpace(spec.Health)
	if health == "" {
		health = DefaultHealthPath
	}
	if !strings.HasPrefix(health, "/") {
		health = "/" + health
	}
	maxR := spec.MaxRestarts
	if maxR <= 0 {
		maxR = DefaultMaxRestarts
	}

	var b strings.Builder
	b.WriteString("\n[[server]]\n")
	b.WriteString("name = " + tomlStr(spec.Name) + "\n")
	if k := strings.TrimSpace(spec.Kind); k != "" && k != KindMCP {
		b.WriteString("kind = " + tomlStr(k) + "\n")
	}
	b.WriteString("bin = " + tomlStr(spec.Bin) + "\n")
	if len(spec.Args) > 0 {
		parts := make([]string, len(spec.Args))
		for i, a := range spec.Args {
			parts[i] = tomlStr(a)
		}
		b.WriteString("args = [" + strings.Join(parts, ", ") + "]\n")
	}
	b.WriteString("port = " + strconv.Itoa(spec.Port) + "\n")
	b.WriteString("health = " + tomlStr(health) + "\n")
	b.WriteString("max_restarts = " + strconv.Itoa(maxR) + "\n")
	if len(spec.Env) > 0 {
		keys := make([]string, 0, len(spec.Env))
		for k := range spec.Env {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		b.WriteString("[server.env]\n")
		for _, k := range keys {
			b.WriteString(k + " = " + tomlStr(spec.Env[k]) + "\n")
		}
	}
	return b.String()
}

// tomlStr renders a TOML basic (double-quoted) string. strconv.Quote's escaping
// (\", \\, \n, \t, …) is a valid subset of TOML basic-string escapes.
func tomlStr(s string) string { return strconv.Quote(s) }

// writeAtomicWithBackup backs up the existing file to <path>.bak, then writes
// data via a temp file in the same directory and renames it into place.
func writeAtomicWithBackup(path string, data []byte) error {
	if existing, err := os.ReadFile(path); err == nil {
		if err := os.WriteFile(path+".bak", existing, 0o644); err != nil {
			return fmt.Errorf("write backup %s.bak: %w", path, err)
		}
	}
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".fleet-toml-*.tmp")
	if err != nil {
		return fmt.Errorf("create temp: %w", err)
	}
	tmpName := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		os.Remove(tmpName)
		return err
	}
	return nil
}
