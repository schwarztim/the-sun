/**
 * CTX-2: per-backend tool visibility filter (applyToolVisibility). Filtered-out
 * tools are never registered, so they never appear in tools/list or
 * gateway_search_tools and are denied fail-closed if somehow called.
 *
 * Precedence contract: deny beats allow. This tests the pure predicate; the
 * registration path calls it with config.tools_allow / config.tools_deny.
 */
import { describe, it, expect } from "vitest";
import { applyToolVisibility } from "../../src/gateway.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

function tools(...names: string[]): Tool[] {
  return names.map((name) => ({
    name,
    description: `desc ${name}`,
    inputSchema: { type: "object", properties: {} },
  }));
}

const NAMES = (ts: Tool[]) => ts.map((t) => t.name);

describe("applyToolVisibility — no filter", () => {
  it("exposes all tools when allow and deny are both undefined", () => {
    const out = applyToolVisibility(tools("a", "b", "c"));
    expect(NAMES(out)).toEqual(["a", "b", "c"]);
  });

  it("treats an empty allow array as no filter (exposes all)", () => {
    const out = applyToolVisibility(tools("a", "b"), []);
    expect(NAMES(out)).toEqual(["a", "b"]);
  });
});

describe("applyToolVisibility — allow", () => {
  it("exposes only the allowed tools when allow is non-empty", () => {
    const out = applyToolVisibility(tools("a", "b", "c"), ["a", "c"]);
    expect(NAMES(out)).toEqual(["a", "c"]);
  });

  it("ignores allow entries that are not real tool names", () => {
    const out = applyToolVisibility(tools("a", "b"), ["a", "ghost"]);
    expect(NAMES(out)).toEqual(["a"]);
  });
});

describe("applyToolVisibility — deny", () => {
  it("hides the denied tools", () => {
    const out = applyToolVisibility(tools("a", "b", "c"), undefined, ["b"]);
    expect(NAMES(out)).toEqual(["a", "c"]);
  });
});

describe("applyToolVisibility — precedence: deny beats allow", () => {
  it("hides a tool present in BOTH allow and deny", () => {
    const out = applyToolVisibility(tools("a", "b", "c"), ["a", "b"], ["b"]);
    // b is allowed but also denied; deny wins.
    expect(NAMES(out)).toEqual(["a"]);
  });

  it("deny removes even when allow would otherwise expose everything listed", () => {
    const out = applyToolVisibility(tools("read", "write", "delete"), ["read", "write", "delete"], ["delete"]);
    expect(NAMES(out)).toEqual(["read", "write"]);
  });
});
