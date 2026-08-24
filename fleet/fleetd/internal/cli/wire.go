package cli

// wire.go implements multi-client MCP wiring: idempotently registering
// thesun's gateway (the streamable-HTTP mux at http://127.0.0.1:<port>/mcp)
// with whichever AI clients are present on the machine: Claude Code,
// GitHub Copilot CLI, OpenAI Codex CLI, Gemini CLI, OpenCode, and VS Code
// (GitHub Copilot agent mode). Every client converges on the SAME gateway URL;
// only the wrapper shape differs per client's config schema (JSON for five of
// them, TOML for Codex).
//
// One gateway URL for every client is the point, not an implementation detail.
// A client that also registers its own MCP servers is running a second copy of
// tools the gateway already fronts, outside the policy enforcement point, and
// that is what `thesun doctor` reports on.
//
// Detection is presence-of-file/dir based (no assumptions about which
// clients are installed). Merging touches only the thesun-owned entry: for
// the JSON clients, only containerKey.mcp-gateway; for Codex's TOML config,
// only the [mcp_servers.mcp-gateway] table. Every other key/table in the file
// round-trips untouched. Re-running is a true no-op: if the entry already
// matches, the file is not rewritten at all.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"

	"github.com/BurntSushi/toml"
)

// GatewayEntryName is the canonical MCP server name thesun registers itself
// under in every client config — matches the convention already used by
// hand-wired entries observed in the wild (Copilot/OpenCode "mcp-gateway").
const GatewayEntryName = "mcp-gateway"

// WireTarget describes one AI client's MCP config file.
type WireTarget struct {
	Client string // human-readable client name, e.g. "Claude Code"
	Path   string // absolute path to the config file
	// Detected reports whether this client is actually present on the
	// machine. Config-dir-based clients (Copilot, Codex, OpenCode) check
	// their own directory; Claude Code checks for an existing config file
	// directly, since its config lives straight in $HOME (which always
	// exists, so a dir-presence check would never say "not installed").
	Detected func() bool
	// Merge performs the client-specific, format-specific idempotent write
	// (JSON key merge or TOML table merge) and reports whether it changed
	// the file.
	Merge func(gatewayURL string) (bool, error)
}

// WireResult reports what happened for one target.
type WireResult struct {
	Client string
	Path   string
	Status string // "wired" | "already-wired" | "not-detected" | "error"
	Detail string
}

// WireClients detects every supported AI client under homeDir/cwd and
// idempotently merges the gateway entry into each one found. homeDir and cwd
// are parameters (not os.UserHomeDir()/os.Getwd() calls) so tests can point
// them at throwaway copies without touching real files — production callers
// pass the real values.
func WireClients(homeDir, cwd, gatewayURL string) []WireResult {
	copilotDir := filepath.Join(homeDir, ".copilot")
	opencodeDir := filepath.Join(homeDir, ".config", "opencode")
	codexDir := filepath.Join(homeDir, ".codex")
	geminiDir := filepath.Join(homeDir, ".gemini")

	copilotPath := filepath.Join(copilotDir, "mcp-config.json")
	opencodePath := filepath.Join(opencodeDir, "opencode.json")
	codexPath := filepath.Join(codexDir, "config.toml")
	geminiPath := filepath.Join(geminiDir, "settings.json")

	// VS Code (GitHub Copilot's agent mode) reads MCP servers from a
	// WORKSPACE-scoped .vscode/mcp.json — the documented per-project location
	// (docs.github.com / VS Code MCP docs). It is a workspace file, so it lives
	// under cwd, exactly mirroring the Claude Code project .mcp.json handling
	// below (both key off cwd, not $HOME).
	vscodeMCPPath := filepath.Join(cwd, ".vscode", "mcp.json")

	targets := []WireTarget{
		claudeCodeTarget(homeDir, cwd),
		{
			Client:   "GitHub Copilot CLI",
			Path:     copilotPath,
			Detected: func() bool { return dirExists(copilotDir) },
			Merge: func(url string) (bool, error) {
				entry := map[string]any{"type": "http", "url": url, "tools": []any{"*"}}
				return mergeJSONEntry(copilotPath, "mcpServers", GatewayEntryName, entry)
			},
		},
		{
			Client:   "OpenCode",
			Path:     opencodePath,
			Detected: func() bool { return dirExists(opencodeDir) },
			Merge: func(url string) (bool, error) {
				entry := map[string]any{"type": "remote", "url": url}
				return mergeJSONEntry(opencodePath, "mcp", GatewayEntryName, entry)
			},
		},
		{
			Client:   "OpenAI Codex CLI",
			Path:     codexPath,
			Detected: func() bool { return dirExists(codexDir) },
			Merge: func(url string) (bool, error) {
				return mergeCodexEntry(codexPath, url)
			},
		},
		{
			// Gemini CLI reads MCP servers from ~/.gemini/settings.json under a
			// top-level "mcpServers" map, the same container key Claude Code and
			// Copilot use. The transport key is the part worth getting right,
			// because Gemini accepts three spellings and they do NOT mean the
			// same thing. From createUrlTransport in the 0.46.0 bundle:
			//
			//   httpUrl            -> streamable-http, but logs a deprecation
			//                         warning telling you to migrate
			//   url + type "http"  -> streamable-http   <- what we write
			//   url + type "sse"   -> SSE               <- prohibited outright
			//   url alone          -> streamable-http (fallback)
			//
			// So we write the explicit, non-deprecated form. Never emit
			// type "sse" here: SSE 405-fails against a streamable-http server
			// and the backend exposes zero tools.
			Client:   "Gemini CLI",
			Path:     geminiPath,
			Detected: func() bool { return dirExists(geminiDir) },
			Merge: func(url string) (bool, error) {
				entry := map[string]any{"type": "http", "url": url}
				return mergeJSONEntry(geminiPath, "mcpServers", GatewayEntryName, entry)
			},
		},
		{
			// VS Code's mcp.json schema: a top-level "servers" map, each entry
			// { "type": "http", "url": ... } for a streamable-HTTP server. VS
			// Code's "http" type IS streamable-HTTP (never stdio, never sse), so
			// this obeys the transport rule. Detected when VS Code is installed
			// on the machine (its per-platform user dir exists — reusing
			// hooks.go's vscodeUserDir) OR a workspace .vscode/mcp.json already
			// exists; that guard stops us fabricating a .vscode/ tree in a random
			// directory on a machine that has never run VS Code.
			Client:   "VS Code (.vscode/mcp.json)",
			Path:     vscodeMCPPath,
			Detected: func() bool { return dirExists(vscodeUserDir(homeDir)) || fileExists(vscodeMCPPath) },
			Merge: func(url string) (bool, error) {
				entry := map[string]any{"type": "http", "url": url}
				return mergeJSONEntry(vscodeMCPPath, "servers", GatewayEntryName, entry)
			},
		},
	}

	results := make([]WireResult, 0, len(targets))
	for _, t := range targets {
		results = append(results, wireOne(t, gatewayURL))
	}
	return results
}

// claudeCodeTarget picks between a project-scoped .mcp.json (preferred, if one
// already exists in cwd) and the global ~/.claude.json mcpServers map. Claude
// Code is considered "detected" only if one of those two files already
// exists — $HOME always exists, so a dir-presence check would never say "not
// installed" and would end up fabricating a global config on a machine that
// has never run Claude Code.
func claudeCodeTarget(homeDir, cwd string) WireTarget {
	projectFile := filepath.Join(cwd, ".mcp.json")
	if fileExists(projectFile) {
		return WireTarget{
			Client:   "Claude Code (project .mcp.json)",
			Path:     projectFile,
			Detected: func() bool { return true },
			Merge: func(url string) (bool, error) {
				entry := map[string]any{"type": "http", "url": url}
				return mergeJSONEntry(projectFile, "mcpServers", GatewayEntryName, entry)
			},
		}
	}
	globalFile := filepath.Join(homeDir, ".claude.json")
	return WireTarget{
		Client:   "Claude Code (~/.claude.json)",
		Path:     globalFile,
		Detected: func() bool { return fileExists(globalFile) },
		Merge: func(url string) (bool, error) {
			entry := map[string]any{"type": "http", "url": url}
			return mergeJSONEntry(globalFile, "mcpServers", GatewayEntryName, entry)
		},
	}
}

func fileExists(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && !fi.IsDir()
}

func dirExists(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && fi.IsDir()
}

// wireOne detects, merges, and reports for a single target. A client that
// isn't present on this machine is reported as "not-detected" — not an error,
// and no file is created or touched for it.
func wireOne(t WireTarget, gatewayURL string) WireResult {
	if t.Detected != nil && !t.Detected() {
		return WireResult{Client: t.Client, Path: t.Path, Status: "not-detected",
			Detail: "client not installed on this machine"}
	}

	changed, err := t.Merge(gatewayURL)
	if err != nil {
		return WireResult{Client: t.Client, Path: t.Path, Status: "error", Detail: err.Error()}
	}
	if changed {
		return WireResult{Client: t.Client, Path: t.Path, Status: "wired", Detail: "gateway entry added/updated"}
	}
	return WireResult{Client: t.Client, Path: t.Path, Status: "already-wired", Detail: "gateway entry already current"}
}

// ---- JSON clients (Claude Code, Copilot, OpenCode) ----

// mergeJSONEntry idempotently sets containerKey.entryName = entry inside the
// JSON document at path, touching nothing else. Missing files are created
// (starting from `{}`); missing containers are created as empty objects.
// Returns changed=false (and performs no write) when the existing entry
// already deep-equals the desired one — the no-op case that makes repeated
// runs safe.
func mergeJSONEntry(path, containerKey, entryName string, entry map[string]any) (bool, error) {
	var doc map[string]any
	mode := os.FileMode(0o644)
	if raw, err := os.ReadFile(path); err == nil {
		if fi, statErr := os.Stat(path); statErr == nil {
			mode = fi.Mode()
		}
		if len(raw) == 0 {
			doc = map[string]any{}
		} else if err := json.Unmarshal(raw, &doc); err != nil {
			return false, fmt.Errorf("parse %s: %w", path, err)
		}
	} else if os.IsNotExist(err) {
		doc = map[string]any{}
	} else {
		return false, fmt.Errorf("read %s: %w", path, err)
	}
	if doc == nil {
		doc = map[string]any{}
	}

	container, _ := doc[containerKey].(map[string]any)
	if container == nil {
		container = map[string]any{}
	}

	if existing, ok := container[entryName].(map[string]any); ok && reflect.DeepEqual(existing, entry) {
		return false, nil // already current — no write, structurally idempotent
	}

	container[entryName] = entry
	doc[containerKey] = container

	out, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return false, fmt.Errorf("marshal %s: %w", path, err)
	}
	out = append(out, '\n')

	return true, writeFileAtomic(path, out, mode)
}

// ---- Codex CLI (TOML) ----
//
// Codex CLI's ~/.codex/config.toml (verified against the real file, codex-cli
// 0.142.4) declares MCP servers as dotted tables under [mcp_servers.<name>],
// and streamable-HTTP servers use a bare `url = '...'` key — no `type` field,
// no stdio `command`/`args` needed. Every entry observed in this operator's
// real config.toml (akamai, ms365, thesun, etc.) already uses exactly this
// shape, confirming the version installed here supports url-based
// streamable-HTTP servers; we never wire stdio.
//
// This file carries hundreds of unrelated tables (marketplaces, projects,
// plugins, other mcp_servers). Like manifest/edit.go's fleet.toml editor, we
// deliberately do NOT round-trip the whole file through toml.Unmarshal +
// toml.Marshal — that would restyle every table (quote style, key order) and
// risk corrupting quoted keys like [projects.'/Users/name/Scripts']. Instead
// we splice only our own [mcp_servers.mcp-gateway] block in as text, leaving
// every other byte untouched — new block appended at EOF if absent (TOML
// dotted-table headers are valid anywhere in the file, not just contiguous
// with sibling tables), or the existing block's span replaced in place if
// already present.

// Leading whitespace is permitted before a TOML table header, and a TOML
// encoder is entitled to indent nested tables (BurntSushi's does). Anchoring
// this pattern hard at column zero meant an indented but perfectly valid
// [mcp_servers.mcp-gateway] went undetected, so the merge appended a SECOND
// one and the write was refused for a duplicate key. The file was fine; the
// pattern was too strict.
var codexGatewayHeaderRe = regexp.MustCompile(`(?m)^[ \t]*\[mcp_servers\.` + regexp.QuoteMeta(GatewayEntryName) + `\][ \t]*$`)

// mergeCodexEntry idempotently sets [mcp_servers.mcp-gateway].url = '<url>' in
// the Codex config.toml at path.
func mergeCodexEntry(path, gatewayURL string) (bool, error) {
	mode := os.FileMode(0o600) // Codex ships config.toml at 0600 (auth-adjacent) — preserve if present
	var text string
	if raw, err := os.ReadFile(path); err == nil {
		text = string(raw)
		if fi, statErr := os.Stat(path); statErr == nil {
			mode = fi.Mode()
		}
	} else if !os.IsNotExist(err) {
		return false, fmt.Errorf("read %s: %w", path, err)
	}

	headerLine := fmt.Sprintf("[mcp_servers.%s]", GatewayEntryName)
	desiredBlock := headerLine + "\nurl = " + tomlLiteralString(gatewayURL)

	loc := codexGatewayHeaderRe.FindStringIndex(text)
	if loc == nil {
		// Not present — append a fresh block at EOF.
		newText := text
		if newText != "" && !strings.HasSuffix(newText, "\n") {
			newText += "\n"
		}
		if newText != "" {
			newText += "\n"
		}
		newText += desiredBlock + "\n"
		if err := validateTOML(newText); err != nil {
			return false, fmt.Errorf("refusing to write %s: generated TOML failed to parse: %w", path, err)
		}
		return true, writeFileAtomic(path, []byte(newText), mode)
	}

	start, end := codexTableBlockSpan(text, loc[0])
	existing := strings.TrimRight(text[start:end], "\n\r\t ")
	if existing == desiredBlock {
		return false, nil // already current — no write
	}
	newText := text[:start] + desiredBlock + "\n" + text[end:]
	if err := validateTOML(newText); err != nil {
		return false, fmt.Errorf("refusing to write %s: generated TOML failed to parse: %w", path, err)
	}
	return true, writeFileAtomic(path, []byte(newText), mode)
}

// codexTableBlockSpan returns the [start,end) byte range of the table block
// beginning at headerStart: from the header line through (but not including)
// the next line that opens another table, or EOF. Indented headers count as
// table openers for the same reason the pattern above allows them.
func codexTableBlockSpan(text string, headerStart int) (start, end int) {
	start = headerStart
	nl := strings.IndexByte(text[start:], '\n')
	if nl < 0 {
		return start, len(text)
	}
	contentStart := start + nl + 1
	rest := text[contentStart:]
	if loc := nextTableHeaderRe.FindStringIndex(rest); loc != nil {
		return start, contentStart + loc[0]
	}
	return start, len(text)
}

var nextTableHeaderRe = regexp.MustCompile(`(?m)^[ \t]*\[`)

// tomlLiteralString renders s as a TOML literal string ('...' — no escapes),
// matching Codex's own quoting style for URLs. Safe here because gateway URLs
// never contain a single quote or newline.
func tomlLiteralString(s string) string { return "'" + s + "'" }

// validateTOML is a fail-closed guard: before ever writing Codex's config.toml
// (which the operator's own auth/session state also lives in), confirm the
// edited text still parses as valid TOML. A parse failure aborts the write
// entirely rather than risking a corrupted config file.
func validateTOML(text string) error {
	var probe map[string]any
	_, err := toml.Decode(text, &probe)
	return err
}

// ---- shared atomic write ----

// writeFileAtomic writes data to path via temp-file + rename (crash-safe),
// creating parent directories as needed and preserving mode.
func writeFileAtomic(path string, data []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("mkdir %s: %w", filepath.Dir(path), err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".mcp-wire-*.tmp")
	if err != nil {
		return fmt.Errorf("create temp for %s: %w", path, err)
	}
	tmpName := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return fmt.Errorf("write temp for %s: %w", path, err)
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return err
	}
	if err := os.Chmod(tmpName, mode); err != nil {
		os.Remove(tmpName)
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		os.Remove(tmpName)
		return fmt.Errorf("rename into %s: %w", path, err)
	}
	return nil
}
