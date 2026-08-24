/**
 * The report must let a reader tell "nothing failed" apart from "everything was
 * proven". `passed` keeps its original every-gate-passed meaning; the new
 * `unverifiedGates` rollup names the gates that passed without demonstrating
 * their property.
 */
import { describe, expect, it } from "vitest";
import { buildReport } from "./report.js";
import type { GateFinding } from "./types.js";

const BASE = {
  target: "example-mcp",
  serverDir: "/tmp/example-mcp",
  startedAt: "2026-07-28T00:00:00.000Z",
  finishedAt: "2026-07-28T00:00:01.000Z",
  transport: "streamable-http" as const,
  toolCount: 3,
  liveAcceptanceLastVerified: null,
};

function gate(overrides: Partial<GateFinding> & Pick<GateFinding, "gate">): GateFinding {
  return { passed: true, message: "ok", ...overrides };
}

describe("buildReport", () => {
  it("names passing-but-unverified gates without changing the aggregate verdict", () => {
    const report = buildReport({
      ...BASE,
      gates: [
        gate({ gate: "protocol" }),
        gate({ gate: "wire-fingerprint", verified: false }),
        gate({ gate: "rate-limiter", verified: false }),
      ],
    });
    // Aggregate semantics are unchanged: an unverified gate still passes.
    expect(report.passed).toBe(true);
    expect(report.unverifiedGates).toEqual(["wire-fingerprint", "rate-limiter"]);
  });

  it("leaves unverifiedGates empty when every passing gate actually verified", () => {
    const report = buildReport({
      ...BASE,
      gates: [gate({ gate: "protocol" }), gate({ gate: "transport" })],
    });
    expect(report.passed).toBe(true);
    expect(report.unverifiedGates).toEqual([]);
  });

  it("does not list failing or skipped gates as merely unverified", () => {
    const report = buildReport({
      ...BASE,
      gates: [
        gate({ gate: "coverage", passed: false, verified: false }),
        gate({ gate: "callability", passed: false, skipped: true }),
        gate({ gate: "rate-limiter", verified: false }),
      ],
    });
    expect(report.passed).toBe(false);
    // A failing gate is already loud; only a PASS can be misread as proof.
    expect(report.unverifiedGates).toEqual(["rate-limiter"]);
  });
});
