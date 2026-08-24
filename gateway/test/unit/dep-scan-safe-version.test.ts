import { describe, it, expect } from "vitest";
import { computeSafeVersion, compareVersions } from "../../src/dep-scan/safe-version.js";
import type { VulnInfo } from "../../src/dep-scan/types.js";

function vuln(fixed: string[]): VulnInfo {
  return { id: "X", aliases: [], severity: "high", fixedVersions: fixed };
}

describe("compareVersions", () => {
  it("compares dotted-numeric segments numerically", () => {
    expect(compareVersions("4.17.21", "4.17.20")).toBe(1);
    expect(compareVersions("4.17.9", "4.17.20")).toBe(-1); // 9 < 20 numerically
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  it("treats missing segments as zero", () => {
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1.2.1", "1.2")).toBe(1);
  });

  it("falls back to lexical comparison for non-numeric segments", () => {
    expect(compareVersions("1.0.0-beta", "1.0.0-alpha")).toBe(1);
  });
});

describe("computeSafeVersion", () => {
  it("returns the MAX fixed across multiple vulns", () => {
    const vulns = [vuln(["4.17.12"]), vuln(["4.17.21", "4.17.19"]), vuln(["4.17.15"])];
    expect(computeSafeVersion(vulns, "4.17.20")).toBe("4.17.21");
  });

  it("only returns a version strictly newer than the scanned version", () => {
    // MAX fix equals scanned version → no usable upgrade.
    expect(computeSafeVersion([vuln(["4.17.21"])], "4.17.21")).toBeUndefined();
    // MAX fix older than scanned → no usable upgrade.
    expect(computeSafeVersion([vuln(["4.17.10"])], "4.17.20")).toBeUndefined();
  });

  it("returns undefined when no vuln lists a fix", () => {
    expect(computeSafeVersion([vuln([]), vuln([])], "1.0.0")).toBeUndefined();
  });

  it("recommends the max fix when the scanned version is unknown", () => {
    expect(computeSafeVersion([vuln(["2.0.0", "3.0.0"])], undefined)).toBe("3.0.0");
  });
});
