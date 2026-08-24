import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Integration test of the ACTUAL hook script, exercising the per-client DENY
// MECHANISM (verified empirically 2026-07-07): Claude/Codex share a COMBINED
// object + exit 0 — legacy top-level {decision:"block"} (Codex 0.142.4 reads
// this) AND the hookSpecificOutput envelope (Claude reads this). An "ask" omits
// the top-level "decision" (Codex has no ask → degrades to allow, Claude asks).
// Copilot CLI = flat stdout + EXIT 2 + stderr; allow = no output + exit 0.

const scriptPath = fileURLToPath(new URL("../../../packaging/hooks/thesun-hook.mjs", import.meta.url));

let home: string;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "thesun-hookscript-"));
  writeFileSync(
    join(home, "policy-snapshot.json"),
    JSON.stringify({ version: 1, tools: { gh_update_issue: { tier: "A", class: "WRITE" } } })
  );
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

function run(input: unknown, extraEnv: Record<string, string> = {}) {
  const res = spawnSync(process.execPath, [scriptPath], {
    input: JSON.stringify(input),
    encoding: "utf-8",
    env: { ...process.env, THESUN_HOME: home, DEP_SCAN_DISABLE: "1", ...extraEnv },
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

// Claude/Codex tool-name form and Copilot form for the same gateway tool.
const CLAUDE = (n: string) => `mcp__mcp-gateway__${n}`;
const COPILOT = (n: string) => `mcp-gateway-${n}`;

describe("hook script — Claude/Codex combined legacy+envelope + exit 0", () => {
  it("Tier-A confirmed, mode=deny → exit 0, BOTH legacy decision:block AND envelope deny", () => {
    const r = run({ tool_name: CLAUDE("gh_update_issue"), tool_input: { confirmed: true } }, { THESUN_HOOK_MODE: "deny" });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    // Claude reads the envelope.
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    // Codex 0.142.4 reads the LEGACY top-level {"decision":"block","reason"}.
    expect(out.decision).toBe("block");
    expect(typeof out.reason).toBe("string");
    expect(out.reason.length).toBeGreaterThan(0);
    // CRITICAL: permissionDecision/permissionDecisionReason must NOT be top-level.
    // Codex 0.142.4 fails OPEN (creds leak) if top-level permissionDecision is
    // present (empirically pinned, 5-probe). They live ONLY inside hookSpecificOutput.
    expect(out.permissionDecision).toBeUndefined();
    expect(out.permissionDecisionReason).toBeUndefined();
  });

  it("Tier-A confirmed, mode=ask → exit 0, envelope ask, NO top-level decision (Codex degrades to allow)", () => {
    const r = run({ tool_name: CLAUDE("gh_update_issue"), tool_input: { confirmed: true } }, { THESUN_HOOK_MODE: "ask" });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("ask");
    // No legacy block field on ask — otherwise Codex would wrongly block instead of allow.
    expect(out.decision).toBeUndefined();
  });
});

describe("hook script — Copilot CLI flat + EXIT 2 (deny), ask degrades to allow", () => {
  it("Tier-A confirmed, mode=deny → EXIT 2, flat deny (no envelope), stderr", () => {
    const r = run({ toolName: COPILOT("gh_update_issue"), toolArgs: JSON.stringify({ confirmed: true }) }, { THESUN_HOOK_MODE: "deny" });
    expect(r.status).toBe(2);
    const out = JSON.parse(r.stdout);
    expect(out.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput).toBeUndefined(); // FLAT only for Copilot
    expect(r.stderr).toMatch(/DENY/);
  });

  it("Tier-A confirmed, mode=ask → EXIT 0, no stdout (Copilot has no ask), stderr note", () => {
    const r = run({ toolName: COPILOT("gh_update_issue"), toolArgs: JSON.stringify({ confirmed: true }) }, { THESUN_HOOK_MODE: "ask" });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
    expect(r.stderr).toMatch(/allowed/);
  });
});

describe("hook script — allow is universal (exit 0, no output)", () => {
  it("Tier-A unconfirmed → allow", () => {
    const r = run({ tool_name: CLAUDE("gh_update_issue"), tool_input: {} });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });
  it("credential read via bash → Copilot EXIT 2 flat deny", () => {
    const r = run({ toolName: "bash", toolArgs: JSON.stringify({ command: "cat ~/.aws/credentials" }) });
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout).permissionDecision).toBe("deny");
  });
  it("credential read via Claude Bash → combined deny (legacy + envelope), exit 0", () => {
    const r = run({ tool_name: "Bash", tool_input: { command: "cat ~/.aws/credentials" } });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny"); // Claude
    expect(out.decision).toBe("block"); // Codex 0.142.4 legacy schema
  });
});
