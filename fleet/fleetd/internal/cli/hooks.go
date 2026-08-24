package cli

// hooks.go implements `thesun hooks install` and `thesun hooks status` — the
// Phase 1b universal client-side hook layer installer. It idempotently wires
// ONE shared policy hook (packaging/hooks/thesun-hook.mjs, plus the OpenCode
// plugin variant) into whichever AI clients are present, pointing each at the
// packaged script. It NEVER clobbers unrelated config: JSON clients are
// read-merge-written touching only the thesun-owned hook entry (a `.bak` is
// taken before any change), Copilot gets its own dedicated thesun.json, and
// OpenCode gets the plugin + core copied into its plugin dir.
//
// It reuses wire.go's helpers (writeFileAtomic, fileExists, dirExists) — same
// package — so the atomic-write and detection discipline is identical to client
// MCP wiring.
//
// The gateway is the enforcement floor; this hook layer is a near-universal
// first line of defense (see docs/SECURITY-ROADMAP.md Phase 1b). An uninstalled
// or removed hook changes nothing about the gateway's Tier-B guarantees.

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"text/tabwriter"

	"mcp-fleet/fleetd/internal/paths"
)

// HookVersion is bumped whenever the hook config shape changes so `hooks status`
// can flag installs written by an older thesun.
const HookVersion = "1"

// pinnedClientVersions records the EXACT client version (or empirical pin date)
// each per-client deny contract in `thesun hooks verify` was validated against.
// The deny mechanisms are client-version-specific (e.g. Codex 0.142.4 fails OPEN
// if the envelope carries a top-level permissionDecision), so when a client
// updates its hook schema the packaged hook can silently fail open while status
// still says "installed". `hooks verify` behaviorally re-checks the live script
// against these pins; `hooks status` surfaces the pin so an operator knows what
// the current install was verified against.
var pinnedClientVersions = map[string]string{
	"Claude Code":        "empirical 2026-07-07",
	"OpenAI Codex CLI":   "0.142.4",
	"GitHub Copilot CLI": "empirical 2026-07-07",
	"Copilot VS Code":    "empirical 2026-07-07 (best-effort)",
}

// hookScriptSubpath / opencodePluginSubpath / hookCoreSubpath are the packaged
// artifacts relative to the bundle root.
var (
	hookScriptSubpath     = filepath.Join("packaging", "hooks", "thesun-hook.mjs")
	opencodePluginSubpath = filepath.Join("packaging", "hooks", "opencode-plugin.ts")
	hookCoreSubpath       = filepath.Join("packaging", "hooks", "core.mjs")
)

// The gateway MCP server name every client funnels through (matches
// wire.go GatewayEntryName / the gateway's own registration).
const gatewayMCPServer = GatewayEntryName // "mcp-gateway"

// Per-client PreToolUse matchers. They must fire on BOTH the gateway's mcp tools
// (Tier-A/B policy) AND the client's BUILT-IN file/exec tools (the credential-file
// guard + dep-scan shift-left guard operate on Read/Bash/Grep/Glob and the like).
// The core still silent-passes any tool that isn't a cred hit / install / gated
// mcp tool, so a broad matcher stays non-annoying. Built-in tool names are the
// #1 per-client item to confirm empirically (see docs/hook-verification-checklist.md).
// gatewayMcpMatcher matches the gateway's MCP tools across EVERY client, which
// takes four alternatives because all four clients spell the same tool
// differently. Verified 2026-08-21 against real payloads and client source, not
// guessed:
//
//	Claude Code   mcp__mcp-gateway__<tool>   double underscore, hyphen kept
//	Codex 0.145   mcp__mcp_gateway__<tool>   double underscore, hyphen normalized
//	Gemini 0.46   mcp_mcp-gateway_<tool>     SINGLE underscore, hyphen kept
//	Copilot CLI   mcp-gateway-<tool>         no mcp prefix at all
//
// Only the first form was previously emitted, so on Codex and Gemini every
// Tier-A/Tier-B gateway call passed the client hook unseen. The gateway PEP
// still caught them server-side, so it was a lost defense-in-depth layer rather
// than an open door, but the hook contributed nothing there.
//
// Every client gets all four alternatives rather than only its own. That follows
// the rule stated below: a name a client cannot emit simply never matches and
// costs nothing, while a missing one silently disables the guard. It also means
// a client changing its normalization does not silently reopen the hole.
//
// The forms are PREFIX-anchored on purpose. Gemini truncates any tool name past
// 63 characters to first30 + "..." + last30, so a matcher anchored on the tail
// would miss a long gateway tool name; the prefix survives truncation.
func gatewayMcpMatcher() string {
	esc := regexEscape(gatewayMCPServer)                  // mcp-gateway
	norm := regexEscape(underscoreName(gatewayMCPServer)) // mcp_gateway
	return `mcp__` + esc + `__.*` +                       // Claude Code
		`|mcp__` + norm + `__.*` + // Codex
		`|mcp_` + esc + `_.*` + // Gemini CLI
		`|` + esc + `-.*` // Copilot CLI
}

// underscoreName applies the normalization Codex performs on an MCP server name.
// Codex was only ever observed against a single server name, so whether its rule
// is "hyphen to underscore" or "any non-alphanumeric to underscore" is
// UNVERIFIED. The broader rule is used because it is a superset: if Codex only
// normalizes hyphens, this still produces the right string for any name that
// contains nothing else.
func underscoreName(s string) string {
	out := []rune(s)
	for i, r := range out {
		isAlnum := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9')
		if !isAlnum {
			out[i] = '_'
		}
	}
	return string(out)
}

// Matchers decide which tool names invoke the hook at all, so a name missing
// here is a hole no rule inside the hook can close. Listing a name a client does
// not have costs nothing (it simply never matches), while omitting one silently
// disables every guard for that tool: so these are deliberately generous.
//
// WRITE tools must be listed. They were previously absent from every matcher,
// which left two gaps: the transport guard could not see a backend config being
// written, and on Copilot CLI the credential guard never ran on file access at
// all, because that client reaches files through `str_replace_editor` (one tool
// whose `command` arg selects view/create/str_replace/insert) and no matcher
// entry matched that name.

// claudeStyleMatcher — Claude Code / Copilot VS Code built-ins + gateway tools.
func claudeStyleMatcher() string {
	return `Read|Bash|Grep|Glob|Write|Edit|MultiEdit|NotebookEdit|` + gatewayMcpMatcher()
}

// codexMatcher: Codex CLI built-ins + gateway tools.
//
// `Bash` and `apply_patch` are the names Codex 0.145.0 actually emits, captured
// from live PreToolUse payloads. Its tool surface is far narrower than it looks:
// there is no separate read, write, edit, search, or list tool, because Codex
// does all of those through `Bash` (reading, grepping, listing) and
// `apply_patch` (create, edit, and patch in one envelope). Of the seven names
// this matcher previously listed, only `apply_patch` matched anything at all.
//
// Watch the capitalization: the wire-level call is named `exec_command` in the
// session transcript, but the HOOK sees `Bash`. A matcher must be written
// against the hook's vocabulary, and reading the transcript instead produces a
// name that never fires.
//
// The lowercase names are retained deliberately rather than deleted. They match
// nothing on this build, but Codex carries `unified_exec` and `search_tool`
// feature flags, and a differently configured install may expose distinct tools
// under those names. Keeping them costs nothing and follows the rule above.
func codexMatcher() string {
	return `Bash|apply_patch|list_mcp_resources|list_mcp_resource_templates|` +
		`shell|read|grep|glob|write|edit|` + gatewayMcpMatcher()
}

// geminiMatcher covers Gemini CLI's OWN built-in tool names, which share nothing
// with Claude's. Verified against the 0.46.0 bundle rather than guessed: a name
// missing here means the hook never fires for that tool and the call is allowed
// with no diagnostic, which is exactly how the earlier matcher gap went
// unnoticed on the other clients.
func geminiMatcher() string {
	return `run_shell_command|write_file|replace|edit|read_file|read_many_files|` +
		`search_file_content|glob|list_directory|web_fetch|` + gatewayMcpMatcher()
}

// copilotMatcher: Copilot CLI built-ins + gateway tools.
//
// Its gateway form is `mcp-gateway-<tool>`, with no `mcp` prefix at all. The bare
// escaped server name used before matched that as a SUBSTRING but not as a full
// match, so whether the hook fired depended on whether Copilot's matcher uses
// search or anchored semantics. That could not be determined from the binary
// (its JS is inside a compressed Node single-executable, where even `preToolUse`
// and `mcpServers` return zero hits), so the shared matcher above now carries
// the explicit `mcp-gateway-.*` form and the question stops mattering.
func copilotMatcher() string {
	return `bash|shell|view|grep|glob|str_replace_editor|create|edit|write|` + gatewayMcpMatcher()
}

// hookClientResult reports one client's install/status outcome.
type hookClientResult struct {
	Client  string `json:"client"`
	Path    string `json:"path"`
	Status  string `json:"status"` // install: wired|already-wired|not-detected|error ; status: installed|drift|not-installed|not-detected|error
	Detail  string `json:"detail"`
	Preview bool   `json:"preview,omitempty"`
}

// bundleHookScript resolves the absolute path to the packaged hook script.
func bundleHookScript() string {
	exe, _ := os.Executable()
	return filepath.Join(paths.BundleRoot(exe), hookScriptSubpath)
}
func bundleOpencodePlugin() string {
	exe, _ := os.Executable()
	return filepath.Join(paths.BundleRoot(exe), opencodePluginSubpath)
}
func bundleHookCore() string {
	exe, _ := os.Executable()
	return filepath.Join(paths.BundleRoot(exe), hookCoreSubpath)
}

// nodeCommand builds the `node <script>` command string, quoting the path when
// it contains whitespace so the client's command runner keeps it as one arg.
func nodeCommand(script string) string {
	return "node " + quotePath(script)
}

// quotePath quotes a path for embedding in a client's command string when it
// contains whitespace, so the command runner keeps it as a single argument. A
// home directory with a space in it is otherwise a hook that never runs.
func quotePath(p string) string {
	if strings.ContainsAny(p, " \t") {
		return fmt.Sprintf("%q", p)
	}
	return p
}

// ─── client target definitions ──────────────────────────────────────────────

type hookTarget struct {
	client  string
	path    string
	preview bool
	// note is appended to every result's Detail — used to flag best-effort /
	// UNVERIFIED clients (e.g. VS Code Copilot has no verifiable shell hook).
	note     string
	detected func() bool
	// install performs the idempotent write, returning changed + error.
	install func() (bool, error)
	// status reports installed|drift|not-installed for this client.
	status func() (string, string)
}

// hookTargets builds the per-client target list for the given home/cwd. home and
// cwd are parameters (not os.UserHomeDir/os.Getwd) so tests point them at temp
// dirs. script is the absolute path to thesun-hook.mjs.
func hookTargets(home, cwd, script, opencodePlugin, opencodeCore string) []hookTarget {
	claudeDir := filepath.Join(home, ".claude")
	claudeSettings := filepath.Join(claudeDir, "settings.json")
	claudeGlobal := filepath.Join(home, ".claude.json")

	copilotDir := filepath.Join(home, ".copilot")
	copilotHooks := filepath.Join(copilotDir, "hooks", "thesun.json")

	codexDir := filepath.Join(home, ".codex")
	codexHooks := filepath.Join(codexDir, "hooks.json")

	geminiDir := filepath.Join(home, ".gemini")
	geminiSettings := filepath.Join(geminiDir, "settings.json")

	vscodeUserDir := vscodeUserDir(home)
	vscodeHooks := filepath.Join(vscodeUserDir, "hooks.json")

	opencodeDir := filepath.Join(home, ".config", "opencode")
	opencodePluginDir := filepath.Join(opencodeDir, "plugin")

	cmd := nodeCommand(script)

	return []hookTarget{
		{
			client:   "Claude Code",
			path:     claudeSettings,
			detected: func() bool { return dirExists(claudeDir) || fileExists(claudeGlobal) },
			// Gateway mcp tools (confirmed form) + built-in Read/Bash/Grep/Glob.
			install: func() (bool, error) {
				return mergeEnvelopeHook(claudeSettings, "PreToolUse", claudeStyleMatcher(), cmd)
			},
			status: func() (string, string) { return envelopeHookStatus(claudeSettings, "PreToolUse", script) },
		},
		{
			client:   "GitHub Copilot CLI",
			path:     copilotHooks,
			detected: func() bool { return dirExists(copilotDir) },
			// Built-in bash/view/grep/glob + broad gateway match (toolName form unconfirmed).
			install: func() (bool, error) { return writeCopilotHook(copilotHooks, copilotMatcher(), script) },
			status:  func() (string, string) { return copilotHookStatus(copilotHooks, script) },
		},
		{
			client:   "OpenAI Codex CLI",
			path:     codexHooks,
			detected: func() bool { return dirExists(codexDir) },
			install: func() (bool, error) {
				return mergeEnvelopeHook(codexHooks, "PreToolUse", codexMatcher(), cmd)
			},
			// Codex is the one client where "the file is written" and "the guard
			// can run" are different facts, so status checks both. An installed
			// but untrusted hook is reported as drift rather than installed:
			// Codex skips it silently, so calling it installed tells the operator
			// a guard is in place while every tool call goes unguarded.
			status: func() (string, string) {
				st, detail := envelopeHookStatus(codexHooks, "PreToolUse", script)
				if st != "installed" {
					return st, detail
				}
				trust, why := codexHookTrust(filepath.Join(codexDir, "config.toml"))
				if trust == codexTrustGranted {
					return st, detail
				}
				if trust == codexTrustBypassed {
					return "installed", detail + "; " + codexTrustDetail(trust, why)
				}
				return "drift", codexTrustDetail(trust, why)
			},
		},
		{
			// Gemini CLI reads hooks from the SAME ~/.gemini/settings.json that
			// holds its MCP wiring, theme, and auth choice, so the merge must be
			// surgical. Two Gemini-specific details, both verified in the 0.46.0
			// bundle rather than assumed:
			//   - the event is "BeforeTool", not "PreToolUse"; an unrecognised
			//     event name is skipped with a warning, installing nothing.
			//   - the payload is byte-identical to Claude's (tool_name /
			//     tool_input, snake_case) and a block is read from the top-level
			//     {"decision":"block"}, which the shared hook already emits for
			//     Codex. So no new output dialect was needed, only the event and
			//     the tool names.
			// Caveat worth knowing: if an operator enables the folderTrust
			// setting, hooks fire only in trusted folders. It is off by default
			// (isTrustedFolder returns true when folderTrust is unset), and the
			// gateway remains the boundary either way.
			client:   "Gemini CLI",
			path:     geminiSettings,
			detected: func() bool { return dirExists(geminiDir) },
			install: func() (bool, error) {
				return mergeEnvelopeHook(geminiSettings, "BeforeTool", geminiMatcher(), cmd)
			},
			status: func() (string, string) { return envelopeHookStatus(geminiSettings, "BeforeTool", script) },
		},
		{
			client:   "Copilot VS Code",
			path:     vscodeHooks,
			preview:  true,
			note:     "UNVERIFIED/best-effort — no verifiable PreToolUse shell hook; VS Code Copilot is enforced by the gateway PEP, not this hook",
			detected: func() bool { return dirExists(vscodeUserDir) },
			install: func() (bool, error) {
				return mergeEnvelopeHook(vscodeHooks, "PreToolUse", claudeStyleMatcher(), cmd)
			},
			status: func() (string, string) { return envelopeHookStatus(vscodeHooks, "PreToolUse", script) },
		},
		{
			client:   "OpenCode",
			path:     opencodePluginDir,
			detected: func() bool { return dirExists(opencodeDir) },
			install:  func() (bool, error) { return installOpencodePlugin(opencodePluginDir, opencodePlugin, opencodeCore) },
			status:   func() (string, string) { return opencodePluginStatus(opencodePluginDir, opencodePlugin) },
		},
	}
}

// vscodeUserDir returns the per-platform VS Code user config directory.
func vscodeUserDir(home string) string {
	switch runtime.GOOS {
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", "Code", "User")
	case "windows":
		if ad := os.Getenv("APPDATA"); ad != "" {
			return filepath.Join(ad, "Code", "User")
		}
		return filepath.Join(home, "AppData", "Roaming", "Code", "User")
	default:
		return filepath.Join(home, ".config", "Code", "User")
	}
}

// ─── envelope-style hook merge (Claude / Codex / VS Code) ─────────────────────
//
// These clients accept a hooks.PreToolUse array of groups:
//   { "matcher": "<regex>", "hooks": [ { "type": "command", "command": "node ..." } ] }
// We touch ONLY our own group (identified by its command referencing
// thesun-hook.mjs); every other matcher/group round-trips untouched.

// mergeEnvelopeHook writes the shared hook into a Claude-style settings file
// under the given hook EVENT. The event is a parameter because it is not
// universal: Claude Code, Codex, and VS Code fire "PreToolUse", while Gemini CLI
// fires "BeforeTool" and rejects an unknown event name outright ("Invalid hook
// event name ... Skipping"), which would silently install nothing.
func mergeEnvelopeHook(path, event, matcher, command string) (bool, error) {
	doc, mode, err := readJSONDoc(path)
	if err != nil {
		return false, err
	}

	hooks, _ := doc["hooks"].(map[string]any)
	if hooks == nil {
		hooks = map[string]any{}
	}
	pre, _ := hooks[event].([]any)

	ourGroup := map[string]any{
		"matcher": matcher,
		"hooks": []any{
			map[string]any{"type": "command", "command": command},
		},
	}

	// Rebuild PreToolUse: keep every group that is NOT ours, then append ours.
	rebuilt := make([]any, 0, len(pre)+1)
	for _, g := range pre {
		if !isThesunHookGroup(g) {
			rebuilt = append(rebuilt, g)
		}
	}
	rebuilt = append(rebuilt, ourGroup)

	hooks[event] = rebuilt
	doc["hooks"] = hooks

	return writeJSONDocIfChanged(path, doc, mode)
}

// isThesunHookGroup reports whether a PreToolUse group is one thesun wrote
// (its command references our hook script).
func isThesunHookGroup(group any) bool {
	g, ok := group.(map[string]any)
	if !ok {
		return false
	}
	hs, ok := g["hooks"].([]any)
	if !ok {
		return false
	}
	for _, h := range hs {
		hm, ok := h.(map[string]any)
		if !ok {
			continue
		}
		if cmd, _ := hm["command"].(string); strings.Contains(cmd, "thesun-hook.mjs") {
			return true
		}
	}
	return false
}

func envelopeHookStatus(path, event, script string) (string, string) {
	doc, _, err := readJSONDoc(path)
	if err != nil {
		return "error", err.Error()
	}
	hooks, _ := doc["hooks"].(map[string]any)
	pre, _ := hooks[event].([]any)
	for _, g := range pre {
		if !isThesunHookGroup(g) {
			continue
		}
		// Found our group — is it pointing at the current bundle script?
		gm := g.(map[string]any)
		hs, _ := gm["hooks"].([]any)
		for _, h := range hs {
			hm, _ := h.(map[string]any)
			cmd, _ := hm["command"].(string)
			if strings.Contains(cmd, script) {
				return "installed", "current (" + path + ")"
			}
		}
		return "drift", "hook points at a different script path — re-run `thesun hooks install`"
	}
	return "not-installed", "no thesun hook entry"
}

// ─── Copilot CLI dedicated hook file ──────────────────────────────────────────
//
// Copilot config is ~/.copilot/hooks/*.json with the FLAT schema
// (copilot-cli-hook-contract): { version, hooks:{ preToolUse:[ {type,matcher,
// bash,powershell,timeoutSec} ] } }. thesun writes its OWN thesun.json so it
// never touches the operator's other hook files (e.g. another-tool.json).

func writeCopilotHook(path, serverMatch, script string) (bool, error) {
	cmd := nodeCommand(script)
	doc := map[string]any{
		"version": 1,
		"hooks": map[string]any{
			"preToolUse": []any{
				map[string]any{
					"type":       "command",
					"matcher":    serverMatch, // broad: matches mcp__mcp-gateway__x and mcp-gateway(x)
					"bash":       cmd,
					"powershell": cmd,
					"timeoutSec": 5,
				},
			},
		},
	}
	// Dedicated thesun file — full write, but still back up any pre-existing
	// (non-thesun) content that happens to share the path.
	existing, _, err := readJSONDoc(path)
	if err != nil {
		return false, err
	}
	if reflect.DeepEqual(existing, doc) {
		return false, nil
	}
	return writeJSONDocIfChanged(path, doc, 0o600)
}

func copilotHookStatus(path, script string) (string, string) {
	if !fileExists(path) {
		return "not-installed", "no " + filepath.Base(path)
	}
	doc, _, err := readJSONDoc(path)
	if err != nil {
		return "error", err.Error()
	}
	hooks, _ := doc["hooks"].(map[string]any)
	pre, _ := hooks["preToolUse"].([]any)
	for _, h := range pre {
		hm, _ := h.(map[string]any)
		bash, _ := hm["bash"].(string)
		if strings.Contains(bash, script) {
			return "installed", "current (" + path + ")"
		}
		if strings.Contains(bash, "thesun-hook.mjs") {
			return "drift", "hook points at a different script path — re-run `thesun hooks install`"
		}
	}
	return "not-installed", "no thesun preToolUse entry"
}

// ─── OpenCode plugin copy ─────────────────────────────────────────────────────
//
// OpenCode loads plugins from <opencodeDir>/plugin/*.ts|*.js. We copy the plugin
// AND core.mjs so the plugin's `./core.mjs` import resolves. Deny-only (no ask).

func installOpencodePlugin(pluginDir, srcPlugin, srcCore string) (bool, error) {
	pluginDest := filepath.Join(pluginDir, "thesun-opencode-plugin.ts")
	coreDest := filepath.Join(pluginDir, "core.mjs")
	changed := false
	for _, pair := range [][2]string{{srcPlugin, pluginDest}, {srcCore, coreDest}} {
		src, dst := pair[0], pair[1]
		data, err := os.ReadFile(src)
		if err != nil {
			return changed, fmt.Errorf("read packaged %s: %w", filepath.Base(src), err)
		}
		if fileExists(dst) {
			if cur, err := os.ReadFile(dst); err == nil && reflect.DeepEqual(cur, data) {
				continue // already current
			}
		}
		if err := writeFileAtomic(dst, data, 0o644); err != nil {
			return changed, err
		}
		changed = true
	}
	return changed, nil
}

func opencodePluginStatus(pluginDir, srcPlugin string) (string, string) {
	pluginDest := filepath.Join(pluginDir, "thesun-opencode-plugin.ts")
	if !fileExists(pluginDest) {
		return "not-installed", "no plugin in " + pluginDir
	}
	cur, err := os.ReadFile(pluginDest)
	if err != nil {
		return "error", err.Error()
	}
	src, err := os.ReadFile(srcPlugin)
	if err != nil {
		// Can't compare — report installed but unverifiable.
		return "installed", "present (" + pluginDest + "); packaged source unreadable for drift check"
	}
	if reflect.DeepEqual(cur, src) {
		return "installed", "current (" + pluginDest + ")"
	}
	return "drift", "installed plugin differs from packaged version — re-run `thesun hooks install`"
}

// ─── shared JSON doc helpers (read-merge-write with .bak) ─────────────────────

func readJSONDoc(path string) (map[string]any, os.FileMode, error) {
	mode := os.FileMode(0o644)
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]any{}, mode, nil
		}
		return nil, mode, fmt.Errorf("read %s: %w", path, err)
	}
	if fi, statErr := os.Stat(path); statErr == nil {
		mode = fi.Mode()
	}
	if len(strings.TrimSpace(string(raw))) == 0 {
		return map[string]any{}, mode, nil
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, mode, fmt.Errorf("parse %s: %w", path, err)
	}
	if doc == nil {
		doc = map[string]any{}
	}
	return doc, mode, nil
}

// writeJSONDocIfChanged marshals doc and writes it only when it differs from the
// file on disk. Before overwriting existing content it takes a one-time `.bak`
// so an operator can recover a hand-edited config.
func writeJSONDocIfChanged(path string, doc map[string]any, mode os.FileMode) (bool, error) {
	out, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return false, fmt.Errorf("marshal %s: %w", path, err)
	}
	out = append(out, '\n')

	if cur, err := os.ReadFile(path); err == nil {
		if reflect.DeepEqual(cur, out) {
			return false, nil // already current — no write, no churn
		}
		// Content will change — back up the pre-existing file once.
		bak := path + ".bak"
		if !fileExists(bak) {
			_ = writeFileAtomic(bak, cur, mode)
		}
	}
	return true, writeFileAtomic(path, out, mode)
}

// regexEscape escapes regex metacharacters in a literal (for the matcher).
func regexEscape(s string) string {
	const meta = `\.+*?()|[]{}^$`
	var b strings.Builder
	for _, r := range s {
		if strings.ContainsRune(meta, r) {
			b.WriteByte('\\')
		}
		b.WriteRune(r)
	}
	return b.String()
}

// ─── CLI front-end ────────────────────────────────────────────────────────────

// Hooks dispatches `thesun hooks <install|status>`.
func Hooks(args []string) int {
	if len(args) == 0 {
		return hooksUsage()
	}
	sub := args[0]
	rest := args[1:]
	switch sub {
	case "install":
		return hooksInstall(rest)
	case "status":
		return hooksStatus(rest)
	case "verify":
		return hooksVerify(rest)
	case "-h", "--help", "help":
		return hooksUsage()
	default:
		fmt.Fprintf(os.Stderr, "thesun hooks: unknown subcommand %q\n\n", sub)
		return hooksUsage()
	}
}

func hooksUsage() int {
	fmt.Fprint(os.Stderr, `thesun hooks — the universal client-side policy hook (Phase 1b)

  install [--client all|claude|copilot|copilot-vscode|codex|opencode]
                     wire the shared policy hook into detected AI clients
                     (idempotent; never clobbers unrelated config; .bak taken)
  status  [--json]   per-client installed / drift / not-installed report
  verify  [--json]   behavioral canary: spawn the packaged hook with each
                     client's pinned Tier-A deny fixture and assert it still
                     DENIES per that client's contract. Exits non-zero on any
                     FAIL (a silent fail-open after a client update). CI/doctor
                     usable. Requires node; no network (DEP_SCAN_DISABLE=1).

The hook human-gates a Tier-A self-confirm (mode ask|deny|off via
THESUN_HOOK_MODE, default ask), passes Tier-B through to the gateway park, and
is silent on reads. It is a first line of defense; the gateway is the guarantee.
`)
	return 2
}

// clientKey maps a --client value to the matching hookTarget.client name.
var clientKeyToName = map[string]string{
	"claude":         "Claude Code",
	"copilot":        "GitHub Copilot CLI",
	"codex":          "OpenAI Codex CLI",
	"copilot-vscode": "Copilot VS Code",
	"opencode":       "OpenCode",
}

func resolveTargets(clientFlag string) ([]hookTarget, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, fmt.Errorf("resolve home dir: %w", err)
	}
	cwd, _ := os.Getwd()
	all := hookTargets(home, cwd, bundleHookScript(), bundleOpencodePlugin(), bundleHookCore())
	if clientFlag == "" || clientFlag == "all" {
		return all, nil
	}
	name, ok := clientKeyToName[clientFlag]
	if !ok {
		return nil, fmt.Errorf("unknown client %q (want: all|claude|copilot|copilot-vscode|codex|opencode)", clientFlag)
	}
	for _, t := range all {
		if t.client == name {
			return []hookTarget{t}, nil
		}
	}
	return nil, fmt.Errorf("no target for client %q", clientFlag)
}

func hooksInstall(args []string) int {
	fs := flag.NewFlagSet("hooks install", flag.ExitOnError)
	client := fs.String("client", "all", "which client(s): all|claude|copilot|copilot-vscode|codex|opencode")
	asJSON := fs.Bool("json", false, "emit results as JSON")
	_ = fs.Parse(args)

	targets, err := resolveTargets(*client)
	if err != nil {
		fmt.Fprintln(os.Stderr, "thesun hooks install:", err)
		return 2
	}

	results := make([]hookClientResult, 0, len(targets))
	anyErr := false
	for _, t := range targets {
		r := hookClientResult{Client: t.client, Path: t.path, Preview: t.preview}
		if !t.detected() {
			r.Status = "not-detected"
			r.Detail = "client not installed on this machine"
			results = append(results, r)
			continue
		}
		changed, err := t.install()
		if err != nil {
			r.Status = "error"
			r.Detail = err.Error()
			anyErr = true
		} else if changed {
			r.Status = "wired"
			r.Detail = "hook installed/updated"
		} else {
			r.Status = "already-wired"
			r.Detail = "hook already current"
		}
		if t.note != "" {
			r.Detail += " — " + t.note
		}
		results = append(results, r)
	}

	renderHookResults("install", results, *asJSON)
	if anyErr {
		return 1
	}
	return 0
}

func hooksStatus(args []string) int {
	fs := flag.NewFlagSet("hooks status", flag.ExitOnError)
	client := fs.String("client", "all", "which client(s): all|claude|copilot|copilot-vscode|codex|opencode")
	asJSON := fs.Bool("json", false, "emit results as JSON")
	_ = fs.Parse(args)

	targets, err := resolveTargets(*client)
	if err != nil {
		fmt.Fprintln(os.Stderr, "thesun hooks status:", err)
		return 2
	}

	results := make([]hookClientResult, 0, len(targets))
	for _, t := range targets {
		r := hookClientResult{Client: t.client, Path: t.path, Preview: t.preview}
		if !t.detected() {
			r.Status = "not-detected"
			r.Detail = "client not installed"
			results = append(results, r)
			continue
		}
		status, detail := t.status()
		r.Status = status
		r.Detail = detail
		// Drift surface: for an installed hook, tell the operator which client
		// version the deny contract was verified against. The mechanisms are
		// version-pinned (see pinnedClientVersions), so if the client has since
		// updated, `thesun hooks verify` is the behavioral confirmation.
		if status == "installed" {
			if pv := pinnedClientVersions[t.client]; pv != "" {
				r.Detail += fmt.Sprintf(" [deny contract verified against %s; run `thesun hooks verify`]", pv)
			}
		}
		if t.note != "" {
			r.Detail += " — " + t.note
		}
		results = append(results, r)
	}
	renderHookResults("status", results, *asJSON)
	return 0
}

func renderHookResults(action string, results []hookClientResult, asJSON bool) {
	if asJSON {
		b, _ := json.MarshalIndent(results, "", "  ")
		fmt.Println(string(b))
		return
	}
	fmt.Printf("thesun hooks %s:\n", action)
	tw := tabwriter.NewWriter(os.Stdout, 0, 2, 2, ' ', 0)
	for _, r := range results {
		name := r.Client
		if r.Preview {
			name += " (preview)"
		}
		fmt.Fprintf(tw, "  %s\t%s\t%s\n", name, r.Status, r.Detail)
	}
	_ = tw.Flush()
}

// HooksDoctorCheck runs a read-only hooks summary for `thesun doctor`. It is
// informational: hooks are opt-in, so "not installed" is PASS; only a detected
// drift is worth a WARN.
func HooksDoctorCheck(add func(name, status, detail string)) {
	// Behavioral canary first: a fail-open regression (client updated its hook
	// schema so the packaged hook no longer denies) is a FAIL, not a WARN — it
	// silently leaks. This is independent of whether any client has the hook
	// installed; it validates the packaged script's contract itself.
	hooksVerifyDoctorCheck(add)

	home, err := os.UserHomeDir()
	if err != nil {
		add("client hooks", statusWarn, "cannot resolve home dir: "+err.Error())
		return
	}
	cwd, _ := os.Getwd()
	targets := hookTargets(home, cwd, bundleHookScript(), bundleOpencodePlugin(), bundleHookCore())
	installed, detected, drift := 0, 0, 0
	var driftClients []string
	for _, t := range targets {
		if !t.detected() {
			continue
		}
		detected++
		st, _ := t.status()
		switch st {
		case "installed":
			installed++
		case "drift":
			drift++
			driftClients = append(driftClients, t.client)
		}
	}
	if drift > 0 {
		add("client hooks", statusWarn,
			fmt.Sprintf("%d/%d detected clients have the policy hook; DRIFT on: %s — run `thesun hooks install`",
				installed, detected, strings.Join(driftClients, ", ")))
		return
	}
	add("client hooks", statusPass,
		fmt.Sprintf("%d/%d detected clients have the policy hook (optional; `thesun hooks install` to add)", installed, detected))
}

// ─── SEC-4: behavioral deny-contract canary (`thesun hooks verify`) ───────────
//
// The per-client deny mechanisms are pinned to exact client versions (e.g.
// Codex 0.142.4 fails OPEN if a top-level permissionDecision is present). When a
// client updates and changes its hook schema, the packaged hook can silently
// fail OPEN while `hooks status` still reports "installed / current". `verify`
// closes that gap: it SPAWNS the real packaged hook script with each client's
// EXACT stdin fixture carrying a synthetic Tier-A deny payload and asserts the
// response matches the pinned contract (mirroring gateway/test/unit/
// hook-script.test.ts). Any mismatch is a FAIL and exits non-zero.

// hookRunOutput is the captured result of one packaged-hook invocation.
type hookRunOutput struct {
	exitCode int
	stdout   string
	stderr   string
	runErr   error // the process could not be started/run (e.g. node missing)
}

// hookRunner spawns the packaged hook and captures (exitCode, stdout, stderr).
// It is a function value so the contract-comparison logic is unit-testable with
// fake outputs, without requiring node in CI.
type hookRunner func(script, stdin string, env map[string]string) hookRunOutput

// nodeHookRunner is the real runner: `node <script>` with stdin + env, capturing
// the exit code (a nonzero exit is a valid result, not a run failure).
func nodeHookRunner(script, stdin string, env map[string]string) hookRunOutput {
	node, err := exec.LookPath("node")
	if err != nil {
		return hookRunOutput{runErr: fmt.Errorf("node not on PATH: %w", err)}
	}
	cmd := exec.Command(node, script)
	cmd.Stdin = strings.NewReader(stdin)
	var out, errb bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errb
	cmd.Env = os.Environ()
	for k, v := range env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	runErr := cmd.Run()
	exit := 0
	if ee, ok := runErr.(*exec.ExitError); ok {
		exit = ee.ExitCode()
		runErr = nil // a nonzero exit is a valid contract result
	} else if runErr == nil && cmd.ProcessState != nil {
		exit = cmd.ProcessState.ExitCode()
	}
	return hookRunOutput{exitCode: exit, stdout: out.String(), stderr: errb.String(), runErr: runErr}
}

// hookContract is one client's pinned deny expectation.
type hookContract struct {
	client        string
	pinnedVersion string
	stdin         string // the client's exact stdin fixture (Tier-A confirmed)
	mode          string // THESUN_HOOK_MODE
	// assert compares one run's output against the pinned contract.
	assert func(hookRunOutput) (bool, string)
}

// hookVerifyResult is one client's verify outcome (JSON-friendly).
type hookVerifyResult struct {
	Client        string `json:"client"`
	PinnedVersion string `json:"pinnedVersion"`
	Pass          bool   `json:"pass"`
	Detail        string `json:"detail"`
}

// jsonMarshal marshals to a compact string (errors → "{}").
func jsonMarshal(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return "{}"
	}
	return string(b)
}

// hookContracts builds the per-client deny contracts, mirroring the fixtures and
// expectations in gateway/test/unit/hook-script.test.ts. The synthetic Tier-A
// tool is gh_update_issue (tier A / WRITE) from the verify snapshot; a
// confirmed:true input in mode=deny must be DENIED by every client's contract.
func hookContracts() []hookContract {
	// Claude / Codex / VS Code are indistinguishable from stdin (tool_name +
	// tool_input); the hook emits ONE combined object for all three.
	envelopeStdin := jsonMarshal(map[string]any{
		"tool_name":  "mcp__mcp-gateway__gh_update_issue",
		"tool_input": map[string]any{"confirmed": true},
	})
	// Copilot uses camelCase toolName + toolArgs (a JSON *string*).
	copilotStdin := jsonMarshal(map[string]any{
		"toolName": "mcp-gateway-gh_update_issue",
		"toolArgs": jsonMarshal(map[string]any{"confirmed": true}),
	})
	return []hookContract{
		{
			client: "Claude Code", pinnedVersion: pinnedClientVersions["Claude Code"],
			stdin: envelopeStdin, mode: "deny", assert: assertEnvelopeDeny(false),
		},
		{
			// Codex additionally requires the LEGACY top-level {decision:"block"}.
			client: "OpenAI Codex CLI", pinnedVersion: pinnedClientVersions["OpenAI Codex CLI"],
			stdin: envelopeStdin, mode: "deny", assert: assertEnvelopeDeny(true),
		},
		{
			client: "GitHub Copilot CLI", pinnedVersion: pinnedClientVersions["GitHub Copilot CLI"],
			stdin: copilotStdin, mode: "deny", assert: assertCopilotDeny,
		},
		{
			client: "Copilot VS Code", pinnedVersion: pinnedClientVersions["Copilot VS Code"],
			stdin: envelopeStdin, mode: "deny", assert: assertEnvelopeDeny(false),
		},
	}
}

// parseHookJSON parses a hook's stdout as a JSON object.
func parseHookJSON(s string) (map[string]any, error) {
	var m map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(s)), &m); err != nil {
		return nil, err
	}
	return m, nil
}

// assertEnvelopeDeny returns the contract check for envelope-family clients
// (Claude / Codex / VS Code): exit 0, hookSpecificOutput.permissionDecision ==
// "deny", and NO top-level permissionDecision (its presence fails Codex OPEN).
// requireLegacyBlock additionally demands the legacy top-level {decision:"block"}
// with a non-empty reason (Codex 0.142.4 reads only that).
func assertEnvelopeDeny(requireLegacyBlock bool) func(hookRunOutput) (bool, string) {
	return func(o hookRunOutput) (bool, string) {
		if o.exitCode != 0 {
			return false, fmt.Sprintf("want exit 0, got %d", o.exitCode)
		}
		m, err := parseHookJSON(o.stdout)
		if err != nil {
			return false, "stdout is not JSON: " + err.Error()
		}
		hso, ok := m["hookSpecificOutput"].(map[string]any)
		if !ok {
			return false, "missing hookSpecificOutput object"
		}
		if hso["permissionDecision"] != "deny" {
			return false, fmt.Sprintf("hookSpecificOutput.permissionDecision = %v, want \"deny\"", hso["permissionDecision"])
		}
		if _, present := m["permissionDecision"]; present {
			return false, "top-level permissionDecision present (Codex fail-open regression)"
		}
		if requireLegacyBlock {
			if m["decision"] != "block" {
				return false, fmt.Sprintf("legacy top-level decision = %v, want \"block\"", m["decision"])
			}
			if r, _ := m["reason"].(string); r == "" {
				return false, "legacy top-level reason is empty"
			}
			return true, "deny via nested envelope + legacy {decision:block}, exit 0"
		}
		return true, "deny via nested envelope, exit 0, no top-level permissionDecision"
	}
}

// assertCopilotDeny is the Copilot CLI contract: exit 2 with a FLAT stdout
// {permissionDecision:"deny"} and NO hookSpecificOutput envelope.
func assertCopilotDeny(o hookRunOutput) (bool, string) {
	if o.exitCode != 2 {
		return false, fmt.Sprintf("want exit 2, got %d", o.exitCode)
	}
	m, err := parseHookJSON(o.stdout)
	if err != nil {
		return false, "stdout is not JSON: " + err.Error()
	}
	if m["permissionDecision"] != "deny" {
		return false, fmt.Sprintf("flat permissionDecision = %v, want \"deny\"", m["permissionDecision"])
	}
	if _, present := m["hookSpecificOutput"]; present {
		return false, "hookSpecificOutput present (Copilot contract must be FLAT)"
	}
	return true, "deny via flat {permissionDecision:deny} + exit 2"
}

// verifySnapshot is the synthetic policy snapshot the fixtures resolve against:
// one Tier-A WRITE tool. Written into a throwaway THESUN_HOME.
func verifySnapshot() map[string]any {
	return map[string]any{
		"version": 1,
		"tools": map[string]any{
			"gh_update_issue": map[string]any{"tier": "A", "class": "WRITE"},
		},
	}
}

// writeVerifySnapshot writes the synthetic snapshot into dir (a temp THESUN_HOME).
func writeVerifySnapshot(dir string) error {
	b, err := json.MarshalIndent(verifySnapshot(), "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "policy-snapshot.json"), b, 0o600)
}

// runHookContracts runs every contract through the given runner against a temp
// THESUN_HOME (which must already contain the verify snapshot) and returns the
// per-client PASS/FAIL results. This is the unit-testable core (runner injected).
func runHookContracts(contracts []hookContract, script string, run hookRunner, home string) []hookVerifyResult {
	results := make([]hookVerifyResult, 0, len(contracts))
	for _, c := range contracts {
		env := map[string]string{
			"THESUN_HOME":      home,
			"DEP_SCAN_DISABLE": "1", // no network on the verify path
			"THESUN_HOOK_MODE": c.mode,
		}
		out := run(script, c.stdin, env)
		r := hookVerifyResult{Client: c.client, PinnedVersion: c.pinnedVersion}
		if out.runErr != nil {
			r.Pass = false
			r.Detail = "could not run hook: " + out.runErr.Error()
		} else {
			r.Pass, r.Detail = c.assert(out)
		}
		results = append(results, r)
	}
	return results
}

// hooksVerify implements `thesun hooks verify`.
func hooksVerify(args []string) int {
	fs := flag.NewFlagSet("hooks verify", flag.ExitOnError)
	asJSON := fs.Bool("json", false, "emit results as JSON")
	_ = fs.Parse(args)

	script := bundleHookScript()
	if !fileExists(script) {
		fmt.Fprintf(os.Stderr, "thesun hooks verify: packaged hook script not found at %s\n", script)
		return 2
	}
	if _, err := exec.LookPath("node"); err != nil {
		fmt.Fprintln(os.Stderr, "thesun hooks verify: node not on PATH — required to spawn the hook and verify the deny contracts")
		return 2
	}

	home, err := os.MkdirTemp("", "thesun-hook-verify-")
	if err != nil {
		fmt.Fprintln(os.Stderr, "thesun hooks verify:", err)
		return 1
	}
	defer os.RemoveAll(home)
	if err := writeVerifySnapshot(home); err != nil {
		fmt.Fprintln(os.Stderr, "thesun hooks verify:", err)
		return 1
	}

	results := runHookContracts(hookContracts(), script, nodeHookRunner, home)
	if renderVerifyResults(results, *asJSON) {
		return 1
	}
	return 0
}

// renderVerifyResults prints the per-client PASS/FAIL table (with the pinned
// version) and returns whether any client FAILED.
func renderVerifyResults(results []hookVerifyResult, asJSON bool) bool {
	anyFail := false
	for _, r := range results {
		if !r.Pass {
			anyFail = true
		}
	}
	if asJSON {
		b, _ := json.MarshalIndent(results, "", "  ")
		fmt.Println(string(b))
		return anyFail
	}
	fmt.Println("thesun hooks verify (behavioral deny-contract canary):")
	tw := tabwriter.NewWriter(os.Stdout, 0, 2, 2, ' ', 0)
	for _, r := range results {
		verdict := "PASS"
		if !r.Pass {
			verdict = "FAIL"
		}
		fmt.Fprintf(tw, "  %s\t%s\tpinned %s\t%s\n", r.Client, verdict, r.PinnedVersion, r.Detail)
	}
	_ = tw.Flush()
	// OpenCode denies by throwing inside its plugin (not this stdin contract),
	// so it is NOT covered by this canary; flag it as manual.
	fmt.Println("  OpenCode: not covered here (denies via plugin throw, not the stdin hook contract) — verify manually")
	if anyFail {
		fmt.Println("\nFAIL: at least one client no longer denies per its pinned contract (possible silent fail-open after a client update).")
	}
	return anyFail
}

// hooksVerifyDoctorCheck adds the behavioral canary as a `thesun doctor` check.
// A FAIL here means the packaged hook no longer denies per a pinned contract (a
// silent fail-open) — surfaced as statusFail. node/script absent → WARN (skip).
func hooksVerifyDoctorCheck(add func(name, status, detail string)) {
	script := bundleHookScript()
	if !fileExists(script) {
		add("hooks: deny contract", statusWarn, "packaged hook script not found — skipping behavioral verify")
		return
	}
	if _, err := exec.LookPath("node"); err != nil {
		add("hooks: deny contract", statusWarn, "node not on PATH — skipping behavioral verify")
		return
	}
	home, err := os.MkdirTemp("", "thesun-hook-verify-")
	if err != nil {
		add("hooks: deny contract", statusWarn, "temp dir: "+err.Error())
		return
	}
	defer os.RemoveAll(home)
	if err := writeVerifySnapshot(home); err != nil {
		add("hooks: deny contract", statusWarn, err.Error())
		return
	}
	results := runHookContracts(hookContracts(), script, nodeHookRunner, home)
	var failed []string
	for _, r := range results {
		if !r.Pass {
			failed = append(failed, r.Client)
		}
	}
	if len(failed) > 0 {
		add("hooks: deny contract", statusFail,
			fmt.Sprintf("FAIL-OPEN regression: %s no longer deny per pinned contract — run `thesun hooks verify`", strings.Join(failed, ", ")))
		return
	}
	add("hooks: deny contract", statusPass,
		fmt.Sprintf("%d client deny-contracts verified against pinned versions (`thesun hooks verify` for detail)", len(results)))
}
