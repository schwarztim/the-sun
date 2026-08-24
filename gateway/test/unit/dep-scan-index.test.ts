import { describe, it, expect } from "vitest";
import { assessInstallCommand, type AssessDeps } from "../../src/dep-scan/index.js";
import { createScanCache } from "../../src/dep-scan/cache.js";
import type { FetchLike, ScanVerdict } from "../../src/dep-scan/types.js";

const noFetch: FetchLike = async () => {
  throw new Error("no network in tests");
};

/** Deps that never touch the network — version resolves to undefined, scan is stubbed. */
function deps(scan: AssessDeps["scan"], over: Partial<AssessDeps> = {}): AssessDeps {
  return {
    fetchFn: noFetch,
    cache: createScanCache(),
    resolveVersion: async (_e, pkg) => pkg.versionSpec, // echo pinned spec, no network
    existence: async () => ({ exists: true, checked: true }),
    scan,
    env: {},
    ...over,
  };
}

const cleanScan: AssessDeps["scan"] = async () => ({ status: "clean", vulns: [] });

describe("assessInstallCommand — orchestration", () => {
  it("allows (null) when the command is not an install", async () => {
    expect(await assessInstallCommand("npm run build", deps(cleanScan))).toBeNull();
  });

  it("allows (null) for a clean package", async () => {
    expect(await assessInstallCommand("npm i lodash@4.17.21", deps(cleanScan))).toBeNull();
  });

  it("vetoes a vulnerable package with a computed safe version", async () => {
    const scan: AssessDeps["scan"] = async () => ({
      status: "vulnerable",
      vulns: [
        {
          id: "GHSA-x",
          aliases: ["CVE-2021-23337"],
          severity: "high",
          fixedVersions: ["4.17.21"],
        },
      ],
      scannedVersion: "4.17.20",
    });
    const d = await assessInstallCommand("npm i lodash@4.17.20", deps(scan));
    expect(d?.action).toBe("veto");
    expect(d?.message).toContain("use >=4.17.21 instead");
  });

  it("vetoes a typosquat (registry 404)", async () => {
    const d = await assessInstallCommand(
      "npm i lodahs",
      deps(cleanScan, { existence: async () => ({ exists: false, checked: true }) })
    );
    expect(d?.action).toBe("veto");
    expect(d?.message).toContain("typosquat");
  });

  it("DEP_SCAN_DISABLE=1 returns null immediately", async () => {
    const d = await assessInstallCommand(
      "npm i lodahs",
      deps(cleanScan, {
        env: { DEP_SCAN_DISABLE: "1" },
        existence: async () => ({ exists: false, checked: true }),
      })
    );
    expect(d).toBeNull();
  });

  it("fail-open: an unknown verdict does not block", async () => {
    const scan: AssessDeps["scan"] = async () => ({ status: "unknown", vulns: [] });
    expect(await assessInstallCommand("npm i mystery", deps(scan))).toBeNull();
  });

  it("fail-open: a throwing scan resolves to null (never throws)", async () => {
    const scan: AssessDeps["scan"] = async () => {
      throw new Error("scanner exploded");
    };
    expect(await assessInstallCommand("npm i lodash", deps(scan))).toBeNull();
  });

  it("uses the cache on a repeat scan (scan invoked once)", async () => {
    let calls = 0;
    const scan: AssessDeps["scan"] = async () => {
      calls++;
      return { status: "clean", vulns: [] } as ScanVerdict;
    };
    const d = deps(scan);
    await assessInstallCommand("npm i lodash@4.17.21", d);
    await assessInstallCommand("npm i lodash@4.17.21", d);
    expect(calls).toBe(1);
  });
});
