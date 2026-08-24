import { describe, it, expect } from "vitest";
import { assessScanResults } from "../../src/dep-scan/policy.js";
import type { PkgResult, VulnInfo } from "../../src/dep-scan/types.js";

const vuln = (over: Partial<VulnInfo> = {}): VulnInfo => ({
  id: "GHSA-x",
  aliases: ["CVE-2021-23337"],
  severity: "high",
  fixedVersions: ["4.17.21"],
  ...over,
});

const base = (over: Partial<PkgResult>): PkgResult => ({
  ecosystem: "npm",
  name: "lodash",
  status: "clean",
  vulns: [],
  ...over,
});

describe("assessScanResults — veto rules", () => {
  it("vetoes a typosquat (not found)", () => {
    const d = assessScanResults([base({ name: "lodahs", notFound: true })], {});
    expect(d?.action).toBe("veto");
    expect(d?.message).toContain("possible typosquat");
    expect(d?.message).toContain("lodahs");
  });

  it("vetoes vulnerable WITH a safe version and names the fix", () => {
    const d = assessScanResults(
      [base({ status: "vulnerable", vulns: [vuln()], scannedVersion: "4.17.20", safeVersion: "4.17.21" })],
      {}
    );
    expect(d?.action).toBe("veto");
    expect(d?.message).toContain("🔒 Dependency guard");
    expect(d?.message).toContain("lodash@4.17.20");
    expect(d?.message).toContain("[CVE-2021-23337]");
    expect(d?.message).toContain("use >=4.17.21 instead");
    expect(d?.message).toContain("Re-run the install");
  });

  it("WARNS (not veto) when vulnerable with no fix and enforce off", () => {
    const d = assessScanResults(
      [base({ status: "vulnerable", vulns: [vuln({ fixedVersions: [] })], scannedVersion: "1.0.0" })],
      {}
    );
    expect(d?.action).toBe("warn");
    expect(d?.message).toContain("⚠️");
    expect(d?.message).toContain("no fixed version");
  });

  it("escalates no-fix WARN to VETO when DEP_SCAN_ENFORCE=1", () => {
    const d = assessScanResults(
      [base({ status: "vulnerable", vulns: [vuln({ fixedVersions: [] })], scannedVersion: "1.0.0" })],
      { DEP_SCAN_ENFORCE: "1" }
    );
    expect(d?.action).toBe("veto");
    expect(d?.message).toContain("blocked by policy");
  });

  it("returns null for clean packages", () => {
    expect(assessScanResults([base({ status: "clean" })], {})).toBeNull();
  });

  it("returns null for unknown verdicts (fail-open)", () => {
    expect(assessScanResults([base({ status: "unknown" })], {})).toBeNull();
  });

  it("DEP_SCAN_DISABLE=1 short-circuits to null even with a typosquat", () => {
    const d = assessScanResults([base({ notFound: true })], { DEP_SCAN_DISABLE: "1" });
    expect(d).toBeNull();
  });

  it("veto beats warn when both present", () => {
    const d = assessScanResults(
      [
        base({ name: "good", status: "vulnerable", vulns: [vuln({ fixedVersions: [] })] }),
        base({ name: "bad", status: "vulnerable", vulns: [vuln()], safeVersion: "4.17.21" }),
      ],
      {}
    );
    expect(d?.action).toBe("veto");
  });
});
