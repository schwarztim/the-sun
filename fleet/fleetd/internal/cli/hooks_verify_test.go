package cli

import (
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

// These tests cover the SEC-4 deny-contract canary. The contract-comparison
// logic is exercised with FAKE runner outputs (no node needed), so the pinned
// per-client contracts are validated deterministically in CI. One integration
// test spawns the REAL packaged hook and t.Skips cleanly when node is absent.

// correct outputs per client family (mirrors packaging/hooks/thesun-hook.mjs).
const (
	goodEnvelopeStdout = `{"decision":"block","reason":"blocked","hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"blocked"}}`
	goodCopilotStdout  = `{"permissionDecision":"deny","permissionDecisionReason":"blocked"}`
)

// fakeRunner routes on the stdin form: Copilot stdin carries "toolName", the
// envelope family carries "tool_name". It returns the caller-supplied outputs.
func fakeRunner(envelope, copilot hookRunOutput) hookRunner {
	return func(_ /*script*/, stdin string, _ map[string]string) hookRunOutput {
		if contains(stdin, `"toolName"`) {
			return copilot
		}
		return envelope
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

// failingClients returns the set of clients that FAILED, as a name→true map.
func failingClients(results []hookVerifyResult) map[string]bool {
	out := map[string]bool{}
	for _, r := range results {
		if !r.Pass {
			out[r.Client] = true
		}
	}
	return out
}

func TestRunHookContracts_AllPassOnCorrectOutput(t *testing.T) {
	run := fakeRunner(
		hookRunOutput{exitCode: 0, stdout: goodEnvelopeStdout},
		hookRunOutput{exitCode: 2, stdout: goodCopilotStdout},
	)
	results := runHookContracts(hookContracts(), "irrelevant", run, "irrelevant")
	if len(results) != 4 {
		t.Fatalf("want 4 client results, got %d", len(results))
	}
	for _, r := range results {
		if !r.Pass {
			t.Errorf("client %q unexpectedly FAILED: %s", r.Client, r.Detail)
		}
		if r.PinnedVersion == "" {
			t.Errorf("client %q missing pinned version", r.Client)
		}
	}
}

func TestRunHookContracts_ContractMutationsFail(t *testing.T) {
	cases := []struct {
		name        string
		envelope    hookRunOutput
		copilot     hookRunOutput
		wantFailing []string // clients that MUST fail; others must pass
	}{
		{
			name:        "envelope missing permissionDecision fails all envelope clients",
			envelope:    hookRunOutput{exitCode: 0, stdout: `{"decision":"block","reason":"x","hookSpecificOutput":{"hookEventName":"PreToolUse"}}`},
			copilot:     hookRunOutput{exitCode: 2, stdout: goodCopilotStdout},
			wantFailing: []string{"Claude Code", "OpenAI Codex CLI", "Copilot VS Code"},
		},
		{
			name:        "top-level permissionDecision poisons Codex fail-open (all envelope fail)",
			envelope:    hookRunOutput{exitCode: 0, stdout: `{"permissionDecision":"deny","decision":"block","reason":"x","hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny"}}`},
			copilot:     hookRunOutput{exitCode: 2, stdout: goodCopilotStdout},
			wantFailing: []string{"Claude Code", "OpenAI Codex CLI", "Copilot VS Code"},
		},
		{
			name:        "missing legacy block only fails Codex (Claude/VSCode tolerate its absence)",
			envelope:    hookRunOutput{exitCode: 0, stdout: `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"x"}}`},
			copilot:     hookRunOutput{exitCode: 2, stdout: goodCopilotStdout},
			wantFailing: []string{"OpenAI Codex CLI"},
		},
		{
			name:        "copilot wrong exit code (0 not 2) fails Copilot only",
			envelope:    hookRunOutput{exitCode: 0, stdout: goodEnvelopeStdout},
			copilot:     hookRunOutput{exitCode: 0, stdout: goodCopilotStdout},
			wantFailing: []string{"GitHub Copilot CLI"},
		},
		{
			name:        "copilot envelope leak (hookSpecificOutput present) fails Copilot only",
			envelope:    hookRunOutput{exitCode: 0, stdout: goodEnvelopeStdout},
			copilot:     hookRunOutput{exitCode: 2, stdout: `{"permissionDecision":"deny","hookSpecificOutput":{}}`},
			wantFailing: []string{"GitHub Copilot CLI"},
		},
		{
			name:        "envelope non-zero exit fails all envelope clients",
			envelope:    hookRunOutput{exitCode: 2, stdout: goodEnvelopeStdout},
			copilot:     hookRunOutput{exitCode: 2, stdout: goodCopilotStdout},
			wantFailing: []string{"Claude Code", "OpenAI Codex CLI", "Copilot VS Code"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			run := fakeRunner(tc.envelope, tc.copilot)
			got := failingClients(runHookContracts(hookContracts(), "s", run, "h"))
			want := map[string]bool{}
			for _, c := range tc.wantFailing {
				want[c] = true
			}
			if len(got) != len(want) {
				t.Fatalf("failing set mismatch: got %v, want %v", got, want)
			}
			for c := range want {
				if !got[c] {
					t.Errorf("expected client %q to FAIL but it passed", c)
				}
			}
		})
	}
}

func TestRunHookContracts_RunErrorIsFail(t *testing.T) {
	run := func(_, _ string, _ map[string]string) hookRunOutput {
		return hookRunOutput{runErr: exec.ErrNotFound}
	}
	results := runHookContracts(hookContracts(), "s", run, "h")
	for _, r := range results {
		if r.Pass {
			t.Errorf("client %q should FAIL when the runner errors", r.Client)
		}
	}
}

func TestRenderVerifyResults_ReportsAnyFail(t *testing.T) {
	if renderVerifyResults([]hookVerifyResult{{Client: "X", Pass: true}}, true) {
		t.Errorf("all-pass should report no failure")
	}
	if !renderVerifyResults([]hookVerifyResult{{Client: "X", Pass: true}, {Client: "Y", Pass: false}}, true) {
		t.Errorf("a failing client should report failure")
	}
}

// TestHookScriptVerify_Integration spawns the REAL packaged hook via node. It
// t.Skips cleanly when node or the packaged script is unavailable (CI safety).
func TestHookScriptVerify_Integration(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node not on PATH — skipping real-hook integration test")
	}
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Skip("cannot resolve test file path")
	}
	// <repo>/fleet/fleetd/internal/cli/ → up 4 → <repo>.
	script := filepath.Join(filepath.Dir(thisFile), "..", "..", "..", "..", "packaging", "hooks", "thesun-hook.mjs")
	if !fileExists(script) {
		t.Skipf("packaged hook script not found at %s", script)
	}
	home := t.TempDir()
	if err := writeVerifySnapshot(home); err != nil {
		t.Fatalf("write snapshot: %v", err)
	}
	results := runHookContracts(hookContracts(), script, nodeHookRunner, home)
	for _, r := range results {
		if !r.Pass {
			t.Errorf("real hook FAILED client %q: %s", r.Client, r.Detail)
		}
	}
}
