import { describe, it, expect } from "vitest";
// The shared client-hook decision core lives in packaging/ (dependency-free ESM
// served to every client). Import it directly so the SAME code the installed
// hooks run is what is under test.
import {
  decide,
  extractToolName,
  extractArgs,
  lookupKeys,
  resolveMode,
  resolveThesunHome,
} from "../../../packaging/hooks/core.mjs";

// A representative snapshot: one Tier-A benign write, one Tier-B escalated
// delete, one Tier-B outbound, and (implicitly) READ tools omitted entirely.
const SNAP = {
  version: 1,
  tools: {
    gh_update_issue: { tier: "A", class: "WRITE" },
    gh_delete_repo: { tier: "B", class: "WRITE", rule: "policy:delete-method" },
    sn_send_email: { tier: "B", class: "HUMAN_OUTBOUND" },
  },
};

// EMPIRICAL per-client runtime tool-name shapes for a gateway ("mcp-gateway")
// tool named "gh_update_issue" (verified 2026-07-07):
//   Claude / Codex : mcp__mcp-gateway__gh_update_issue  (mcp__<server>__<tool>)
//   Copilot CLI    : mcp-gateway-gh_update_issue        (<server>-<tool>, hyphen)
//   OpenCode       : mcp-gateway_gh_update_issue        (<server>_<tool>, underscore)
const T_CLAUDE = (name: string) => `mcp__mcp-gateway__${name}`;
const T_COPILOT = (name: string) => `mcp-gateway-${name}`;
const T_OPENCODE = (name: string) => `mcp-gateway_${name}`;

describe("extractToolName — every client envelope shape", () => {
  it("Claude / VS Code / Codex: tool_name", () => {
    expect(extractToolName({ tool_name: T_CLAUDE("gh_update_issue"), tool_input: {} })).toBe(T_CLAUDE("gh_update_issue"));
  });
  it("Copilot CLI camelCase: toolName", () => {
    expect(extractToolName({ toolName: T_COPILOT("gh_update_issue"), toolArgs: "{}" })).toBe(T_COPILOT("gh_update_issue"));
  });
  it("OpenCode-style: toolName from input.tool passthrough", () => {
    expect(extractToolName({ toolName: T_OPENCODE("gh_update_issue") })).toBe(T_OPENCODE("gh_update_issue"));
  });
  it("empty when absent", () => {
    expect(extractToolName({})).toBe("");
    expect(extractToolName(null)).toBe("");
  });
});

describe("extractArgs — object and JSON-string (Copilot toolArgs)", () => {
  it("Claude tool_input object", () => {
    expect(extractArgs({ tool_input: { confirmed: true } })).toEqual({ confirmed: true });
  });
  it("Copilot toolArgs JSON string is parsed", () => {
    expect(extractArgs({ toolArgs: '{"confirmed":true}' })).toEqual({ confirmed: true });
  });
  it("malformed toolArgs string → {}", () => {
    expect(extractArgs({ toolArgs: "{not json" })).toEqual({});
  });
  it("missing → {}", () => {
    expect(extractArgs({})).toEqual({});
  });
});

describe("lookupKeys — real per-client join styles → gateway tool key", () => {
  it("Claude/Codex mcp__mcp-gateway__<tool> → <tool>", () => {
    expect(lookupKeys("mcp__mcp-gateway__gh_delete_repo")).toContain("gh_delete_repo");
  });
  it("Copilot mcp-gateway-<tool> (hyphen) → <tool>", () => {
    expect(lookupKeys("mcp-gateway-gh_delete_repo")).toContain("gh_delete_repo");
  });
  it("OpenCode mcp-gateway_<tool> (underscore) → <tool>", () => {
    expect(lookupKeys("mcp-gateway_gh_delete_repo")).toContain("gh_delete_repo");
  });
  it("bare tool is itself a candidate", () => {
    expect(lookupKeys("gh_delete_repo")).toContain("gh_delete_repo");
  });
});

describe("decide — the core policy (across real per-client toolName forms)", () => {
  it("fail-open when snapshot is null (missing/corrupt)", () => {
    expect(decide({ tool_name: T_CLAUDE("gh_delete_repo"), tool_input: { confirmed: true } }, null, "deny").action).toBe("allow");
  });

  it("unlisted / READ tool → allow (silent pass)", () => {
    expect(decide({ tool_name: T_CLAUDE("gh_get_repo"), tool_input: {} }, SNAP, "ask").action).toBe("allow");
  });

  it("Tier-B tool → allow PASS-THROUGH even with confirmed:true (gateway parks it)", () => {
    const d = decide({ tool_name: T_CLAUDE("gh_delete_repo"), tool_input: { confirmed: true } }, SNAP, "deny");
    expect(d.action).toBe("allow");
    expect(d.reason).toMatch(/tier-b/);
  });

  it("Tier-A tool WITHOUT confirmed → allow (gateway speed-bump handles the first call)", () => {
    expect(decide({ tool_name: T_CLAUDE("gh_update_issue"), tool_input: {} }, SNAP, "ask").action).toBe("allow");
  });

  it("Tier-A + confirmed:true → ask (Claude form, default mode)", () => {
    const d = decide({ tool_name: T_CLAUDE("gh_update_issue"), tool_input: { confirmed: true } }, SNAP, "ask");
    expect(d.action).toBe("ask");
    expect(d.reason).toContain("gh_update_issue");
  });

  it("Tier-A + confirmed:true → deny when mode=deny", () => {
    expect(decide({ tool_name: T_CLAUDE("gh_update_issue"), tool_input: { confirmed: true } }, SNAP, "deny").action).toBe("deny");
  });

  it("Tier-A + confirmed:true → allow when mode=off", () => {
    expect(decide({ tool_name: T_CLAUDE("gh_update_issue"), tool_input: { confirmed: true } }, SNAP, "off").action).toBe("allow");
  });

  it("resolves via Copilot HYPHEN form + string toolArgs end-to-end", () => {
    const d = decide({ toolName: T_COPILOT("gh_update_issue"), toolArgs: '{"confirmed":true}' }, SNAP, "ask");
    expect(d.action).toBe("ask");
  });

  it("resolves via OpenCode UNDERSCORE form", () => {
    const d = decide({ toolName: T_OPENCODE("gh_update_issue"), toolArgs: '{"confirmed":true}' }, SNAP, "ask");
    expect(d.action).toBe("ask");
  });
});

describe("resolveMode / resolveThesunHome env handling", () => {
  it("defaults mode to ask; unknown → ask", () => {
    expect(resolveMode({})).toBe("ask");
    expect(resolveMode({ THESUN_HOOK_MODE: "bogus" })).toBe("ask");
    expect(resolveMode({ THESUN_HOOK_MODE: "DENY" })).toBe("deny");
  });
  it("THESUN_HOME override wins", () => {
    expect(resolveThesunHome({ THESUN_HOME: "/tmp/xyz" })).toBe("/tmp/xyz");
  });
});
