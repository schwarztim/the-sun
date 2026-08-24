import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { auditContracts } from "../../scripts/audit-contracts.js";
import type { AuditResult } from "../../scripts/audit-contracts.js";

// Resolve paths relative to the repo root (process.cwd() under vitest).
const REAL_MANIFESTS = resolve(process.cwd(), "manifests");
const BAD_FIXTURES = resolve(process.cwd(), "test/fixtures/manifests-bad");

// ─── Real manifests must be clean ─────────────────────────────────────────────

describe("auditContracts — real manifests/ directory", () => {
  it("returns zero violations against the shipped manifests", () => {
    const result: AuditResult = auditContracts(REAL_MANIFESTS);
    if (result.violations.length > 0) {
      // Print details so failures are actionable in CI.
      const msgs = result.violations.map(
        (v) => `[${v.rule}] ${v.file}${v.backend ? " > " + v.backend : ""}${v.tool ? " > " + v.tool : ""}: ${v.detail}`
      );
      throw new Error(`Expected zero violations but got ${result.violations.length}:\n${msgs.join("\n")}`);
    }
    expect(result.violations).toHaveLength(0);
    expect(result.filesAudited).toBeGreaterThan(0);
    expect(result.capabilitiesAudited).toBeGreaterThan(0);
  });
});

// ─── Fixture: write_guard explicitly empty ────────────────────────────────────

describe("auditContracts — WRITE_GUARD_EMPTY violation", () => {
  it("catches a gated capability with an explicitly empty write_guard", () => {
    // Uses test/fixtures/manifests-bad/missing-write-guard.json:
    //   { tool: "send_alert", safety_class: "HUMAN_OUTBOUND", write_guard: "" }
    const result = auditContracts(BAD_FIXTURES);
    const v = result.violations.filter((x) => x.rule === "WRITE_GUARD_EMPTY");
    expect(v.length).toBeGreaterThanOrEqual(1);
    expect(v[0].tool).toBe("send_alert");
    expect(v[0].backend).toBe("fixture-missing-guard");
  });
});

// ─── Fixture: risky-as-read ────────────────────────────────────────────────────

describe("auditContracts — RISKY_AS_READ violation", () => {
  it("catches a write-verb tool classified as READ", () => {
    // Uses test/fixtures/manifests-bad/risky-as-read.json:
    //   { tool: "records_delete_all", safety_class: "READ" }
    const result = auditContracts(BAD_FIXTURES);
    const v = result.violations.filter((x) => x.rule === "RISKY_AS_READ");
    expect(v.length).toBeGreaterThanOrEqual(1);
    expect(v[0].tool).toBe("records_delete_all");
    expect(v[0].backend).toBe("fixture-risky-read");
  });
});

// ─── Fixture: malformed JSON ───────────────────────────────────────────────────

describe("auditContracts — INVALID_JSON violation", () => {
  it("catches a garbage/non-JSON file", () => {
    // Uses test/fixtures/manifests-bad/malformed.json (not valid JSON).
    const result = auditContracts(BAD_FIXTURES);
    const v = result.violations.filter((x) => x.rule === "INVALID_JSON");
    expect(v.length).toBeGreaterThanOrEqual(1);
    expect(v[0].file).toBe("malformed.json");
  });
});

// ─── Fixture: duplicate tool ───────────────────────────────────────────────────

describe("auditContracts — DUPLICATE_TOOL violation", () => {
  it("catches a tool name that appears twice within the same backend", () => {
    // Uses test/fixtures/manifests-bad/duplicate-tool.json:
    //   two capabilities both named "get_status"
    const result = auditContracts(BAD_FIXTURES);
    const v = result.violations.filter((x) => x.rule === "DUPLICATE_TOOL");
    expect(v.length).toBeGreaterThanOrEqual(1);
    expect(v[0].tool).toBe("get_status");
    expect(v[0].backend).toBe("fixture-dup-tool");
  });
});

// ─── AuditResult shape ─────────────────────────────────────────────────────────

describe("auditContracts — result shape", () => {
  it("returns correct counts for a clean manifest", () => {
    const result = auditContracts(REAL_MANIFESTS);
    expect(typeof result.filesAudited).toBe("number");
    expect(typeof result.capabilitiesAudited).toBe("number");
    expect(Array.isArray(result.violations)).toBe(true);
  });

  it("handles a missing directory gracefully with a DIR_UNREADABLE violation", () => {
    const result = auditContracts("/nonexistent/path/that/never/exists");
    expect(result.filesAudited).toBe(0);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].rule).toBe("DIR_UNREADABLE");
  });
});
