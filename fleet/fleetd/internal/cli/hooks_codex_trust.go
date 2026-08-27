package cli

// hooks_codex_trust.go answers one question for `thesun hooks status`: is the
// Codex hook we installed actually able to run?
//
// This exists because Codex 0.145.0 has a trust gate that no other supported
// client has, and it fails in the worst possible way. A hook declared in
// config.toml OR in hooks.json does not execute until that specific hook is
// trusted, and an untrusted hook is skipped SILENTLY. There is no line on
// stdout, none on stderr, and `codex doctor` reports nothing about hooks. The
// tool call simply runs. Proven empirically 2026-08-21: with
// --dangerously-bypass-hook-trust the identical config fires and its deny is
// honored completely; without the flag, nothing.
//
// So `hooks status` reporting "installed" for Codex was worse than useless. It
// told an operator a guard was in place while every tool call went unguarded,
// which is exactly the fail-open-that-reads-as-success this whole layer exists
// to prevent. Status must distinguish "the file is written" from "the guard can
// run", because on Codex those are different facts.
//
// Why this only DETECTS rather than granting trust: the record is
// `[hooks.state."<resolved config path>:<snake_case event>:<group>:<hook>"]`
// carrying `trusted_hash = "sha256:..."`, and that hash could not be reproduced
// (roughly 90 candidate encodings were tried against a captured sample). It
// covers `command` and `matcher` but not `timeout`, and because our command
// embeds the user's home directory the value differs per machine, so a constant
// cannot be shipped either. Codex writes the record itself through an
// interactive TUI flow, so the honest remedy is to tell the operator to run that
// flow once. The alternative, setting `bypass_hook_trust`, is deliberately NOT
// done here: it would disable trust for EVERY hook including a malicious
// project-supplied one, trading a real protection for our convenience.

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/BurntSushi/toml"
)

// codexTrustState is what we can determine about a Codex hook's ability to run.
type codexTrustState int

const (
	// codexTrustUnknown means we could not read the config, so we say so rather
	// than guessing. Guessing "trusted" here would restore the original lie.
	codexTrustUnknown codexTrustState = iota
	// codexTrustGranted means a [hooks.state] record exists for this config.
	codexTrustGranted
	// codexTrustMissing means no record exists, so the hook is inert.
	codexTrustMissing
	// codexTrustBypassed means bypass_hook_trust is set, so hooks run without
	// records. Worth naming separately: it is not the same as being trusted, and
	// an operator should know it applies to every hook on the machine.
	codexTrustBypassed
)

// codexHookTrust reports whether Codex will actually run hooks declared for the
// given CODEX_HOME. configPath is the config.toml that carries both the hook
// declarations and, once granted, the trust records.
func codexHookTrust(configPath string) (codexTrustState, string) {
	raw, err := os.ReadFile(configPath)
	if err != nil {
		if os.IsNotExist(err) {
			return codexTrustMissing, "no " + configPath
		}
		return codexTrustUnknown, err.Error()
	}
	var doc map[string]any
	if _, err := toml.Decode(string(raw), &doc); err != nil {
		return codexTrustUnknown, "config.toml does not parse: " + err.Error()
	}

	if b, ok := doc["bypass_hook_trust"].(bool); ok && b {
		return codexTrustBypassed, "bypass_hook_trust is set, so EVERY hook runs untrusted, including any a project supplies"
	}

	hooks, _ := doc["hooks"].(map[string]any)
	state, _ := hooks["state"].(map[string]any)
	if len(state) == 0 {
		return codexTrustMissing, "no [hooks.state] record"
	}

	// The record is keyed on the RESOLVED absolute path of the file declaring the
	// hook. Compare against the resolved form: on macOS anything under /tmp or
	// /var reaches the same file by two different paths, and a textual compare
	// would report a trusted hook as untrusted.
	want := resolvePathForTrust(configPath)
	for key := range state {
		if src, ok := trustKeySource(key); ok {
			if resolvePathForTrust(src) == want {
				return codexTrustGranted, "trusted for " + configPath
			}
		}
	}
	return codexTrustMissing, "[hooks.state] exists but carries no record for " + configPath
}

// trustKeySource returns the config-path portion of a [hooks.state] key, whose
// shape is "<resolved config path>:<snake_case event>:<group>:<hook>".
//
// It strips the three trailing fields rather than cutting at the first colon.
// Cutting at the first colon is correct on POSIX but wrong on Windows, where
// the path opens with a drive letter: "C:\Users\...\config.toml:pre_tool_use:0:0"
// yielded "C", which never matches the config being checked, so a genuinely
// trusted hook was reported as untrusted on every Windows machine and the
// operator was told to grant trust they had already granted.
func trustKeySource(key string) (string, bool) {
	src := key
	for i := 0; i < 3; i++ {
		idx := strings.LastIndex(src, ":")
		if idx < 0 {
			return "", false
		}
		src = src[:idx]
	}
	if src == "" {
		return "", false
	}
	return src, true
}

// resolvePathForTrust resolves symlinks so two spellings of one file compare
// equal, falling back to the input when the path cannot be resolved (a recorded
// path may name a file that no longer exists, which is not an error here).
func resolvePathForTrust(p string) string {
	if abs, err := filepath.Abs(p); err == nil {
		p = abs
	}
	if real, err := filepath.EvalSymlinks(p); err == nil {
		return real
	}
	return p
}

// codexTrustDetail turns the state into the line `hooks status` prints. The
// remedy is spelled out because "untrusted" alone tells an operator nothing
// about what to do, and the activation flow is not discoverable: it only appears
// in the interactive TUI, never on the `codex exec` path.
func codexTrustDetail(state codexTrustState, why string) string {
	switch state {
	case codexTrustGranted:
		return ""
	case codexTrustBypassed:
		return "trust bypassed: " + why
	case codexTrustUnknown:
		return "trust state unknown (" + why + "); treat the hook as possibly inert until confirmed"
	default:
		return "INERT: Codex skips untrusted hooks silently (" + why + "). " +
			"Run `codex` once interactively and choose \"Trust all and continue\" at the hooks prompt, " +
			"then re-run `thesun hooks status`."
	}
}
