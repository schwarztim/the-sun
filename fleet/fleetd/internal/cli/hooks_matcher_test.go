package cli

import (
	"regexp"
	"testing"
)

// realGatewayToolNames is the exact string each client emits for the SAME
// gateway tool. Four clients, four spellings, all established empirically or
// from client source on 2026-08-21 rather than guessed:
//
//   - Claude Code: observed live in a session's own tool list.
//   - Codex 0.145.0: captured from a real PreToolUse hook payload.
//   - Gemini 0.46.0: read out of bundle/chunk-G33JEOEV.js, where
//     MCP_QUALIFIED_NAME_SEPARATOR is "_" and the sanitizer's character class
//     explicitly permits "-", so the hyphen survives.
//   - Copilot CLI: prior live four-client probe (<server>-<tool>).
var realGatewayToolNames = map[string]string{
	"Claude Code": "mcp__mcp-gateway__gateway_call_tool",
	"Codex":       "mcp__mcp_gateway__gateway_call_tool",
	"Gemini CLI":  "mcp_mcp-gateway_gateway_call_tool",
	"Copilot CLI": "mcp-gateway-gateway_call_tool",
}

// TestEveryMatcherCatchesEveryClientsGatewayForm is the regression test for the
// hole that made the client hook layer useless on two of four clients.
//
// Only the Claude spelling was ever emitted, so on Codex and Gemini every
// Tier-A/Tier-B gateway tool call passed the hook unseen, with no diagnostic
// anywhere. Nothing inside the hook can close that: a matcher miss means the
// hook is never invoked at all.
//
// Each matcher is asserted against ALL four spellings, not just its own client's,
// because a client that changes its normalization must not silently reopen this.
func TestEveryMatcherCatchesEveryClientsGatewayForm(t *testing.T) {
	matchers := map[string]string{
		"claudeStyleMatcher": claudeStyleMatcher(),
		"codexMatcher":       codexMatcher(),
		"geminiMatcher":      geminiMatcher(),
		"copilotMatcher":     copilotMatcher(),
	}
	for mName, pattern := range matchers {
		re, err := regexp.Compile(pattern)
		if err != nil {
			t.Fatalf("%s produced an invalid regex: %v", mName, err)
		}
		for client, tool := range realGatewayToolNames {
			if !re.MatchString(tool) {
				t.Errorf("%s does not match %s's gateway tool %q; every gateway call from that client would bypass the hook unseen",
					mName, client, tool)
			}
		}
	}
}

// TestGatewayFormsSurviveAnchoredMatching guards the Copilot ambiguity.
//
// Copilot's matcher previously carried the bare escaped server name, which
// matched its tool as a substring but NOT as a full match. Whether the hook
// fired therefore depended on whether Copilot anchors its matcher, which could
// not be determined from its binary (the JS is inside a compressed Node
// single-executable: even `preToolUse` and `mcpServers` return zero hits). The
// matcher must work under EITHER semantic so the question stops mattering.
func TestGatewayFormsSurviveAnchoredMatching(t *testing.T) {
	for mName, pattern := range map[string]string{
		"claudeStyleMatcher": claudeStyleMatcher(),
		"codexMatcher":       codexMatcher(),
		"geminiMatcher":      geminiMatcher(),
		"copilotMatcher":     copilotMatcher(),
	} {
		anchored, err := regexp.Compile(`^(?:` + pattern + `)$`)
		if err != nil {
			t.Fatalf("%s could not be anchored: %v", mName, err)
		}
		for client, tool := range realGatewayToolNames {
			if !anchored.MatchString(tool) {
				t.Errorf("%s fails under anchored matching for %s (%q); a client that anchors its matcher would never fire the hook",
					mName, client, tool)
			}
		}
	}
}

// TestCodexMatcherUsesTheNamesCodexActuallyEmits.
//
// Codex has no separate read/write/edit/search/list tool: it does all of that
// through Bash and apply_patch. Of the seven names the matcher used to list,
// only apply_patch matched anything, so the shell guard was simply off. The
// capitalization matters and is easy to get wrong from the wrong source: the
// wire-level call is `exec_command` in the session transcript, but the hook sees
// `Bash`.
func TestCodexMatcherUsesTheNamesCodexActuallyEmits(t *testing.T) {
	re := regexp.MustCompile(`^(?:` + codexMatcher() + `)$`)
	for _, tool := range []string{"Bash", "apply_patch", "list_mcp_resources", "list_mcp_resource_templates"} {
		if !re.MatchString(tool) {
			t.Errorf("codexMatcher misses %q, a tool Codex 0.145.0 really emits", tool)
		}
	}
}

// TestUnderscoreNameNormalizes pins the transform used to build Codex's form.
// Codex was only ever exercised against one server name, so the exact class it
// normalizes is unverified; this uses the superset rule, and the test records
// that intent so a later reader does not "simplify" it back to hyphens only.
func TestUnderscoreNameNormalizes(t *testing.T) {
	for in, want := range map[string]string{
		"mcp-gateway": "mcp_gateway",
		"foo.bar":     "foo_bar",
		"plain":       "plain",
		"a-b.c:d":     "a_b_c_d",
	} {
		if got := underscoreName(in); got != want {
			t.Errorf("underscoreName(%q) = %q, want %q", in, got, want)
		}
	}
}
