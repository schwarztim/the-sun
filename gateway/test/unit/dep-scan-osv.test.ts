import { describe, it, expect } from "vitest";
import { scanOne, type LocalScanner } from "../../src/dep-scan/osv.js";
import type { FetchLike, ScanVerdict } from "../../src/dep-scan/types.js";

/** Build a stub fetch returning a fixed JSON payload / status. NO live network. */
function stub(payload: unknown, opts: { ok?: boolean; status?: number } = {}): FetchLike {
  return async () => ({
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    json: async () => payload,
  });
}

const throwingFetch: FetchLike = async () => {
  throw new Error("network down");
};

describe("scanOne — OSV HTTP path", () => {
  it("reports clean when OSV returns no vulns", async () => {
    const v = await scanOne("npm", "lodash", "4.17.21", { fetchFn: stub({ vulns: [] }) });
    expect(v.status).toBe("clean");
    expect(v.vulns).toHaveLength(0);
  });

  it("reports vulnerable and normalizes id/aliases/summary/fixed", async () => {
    const payload = {
      vulns: [
        {
          id: "GHSA-abcd",
          aliases: ["CVE-2021-23337"],
          summary: "prototype pollution",
          severity: [{ type: "CVSS_V3", score: "7.4" }],
          affected: [{ ranges: [{ events: [{ introduced: "0" }, { fixed: "4.17.21" }] }] }],
        },
      ],
    };
    const v = await scanOne("npm", "lodash", "4.17.20", { fetchFn: stub(payload) });
    expect(v.status).toBe("vulnerable");
    expect(v.vulns[0].id).toBe("GHSA-abcd");
    expect(v.vulns[0].aliases).toContain("CVE-2021-23337");
    expect(v.vulns[0].summary).toBe("prototype pollution");
    expect(v.vulns[0].severity).toBe("high"); // 7.4 → high
    expect(v.vulns[0].fixedVersions).toEqual(["4.17.21"]);
  });

  it("buckets numeric CVSS scores (>=9 critical)", async () => {
    const v = await scanOne("PyPI", "x", "1.0.0", {
      fetchFn: stub({ vulns: [{ id: "V", severity: [{ type: "CVSS_V3", score: "9.8" }] }] }),
    });
    expect(v.vulns[0].severity).toBe("critical");
  });

  it("maps database_specific severity strings and moderate→medium", async () => {
    const v = await scanOne("npm", "x", "1.0.0", {
      fetchFn: stub({ vulns: [{ id: "V", database_specific: { severity: "MODERATE" } }] }),
    });
    expect(v.vulns[0].severity).toBe("medium");
  });

  it("keeps the HIGHEST severity across signals", async () => {
    const v = await scanOne("npm", "x", "1.0.0", {
      fetchFn: stub({
        vulns: [
          {
            id: "V",
            database_specific: { severity: "LOW" },
            severity: [{ type: "CVSS_V3", score: "9.1" }],
          },
        ],
      }),
    });
    expect(v.vulns[0].severity).toBe("critical");
  });

  it("collects fixed versions across multiple ranges", async () => {
    const v = await scanOne("npm", "x", "1.0.0", {
      fetchFn: stub({
        vulns: [
          {
            id: "V",
            affected: [
              { ranges: [{ events: [{ fixed: "1.2.0" }] }, { events: [{ fixed: "2.3.0" }] }] },
            ],
          },
        ],
      }),
    });
    expect(v.vulns[0].fixedVersions).toEqual(["1.2.0", "2.3.0"]);
  });
});

describe("scanOne — fail-open invariant (NEVER throws)", () => {
  it("returns unknown on a thrown network error", async () => {
    const v = await scanOne("npm", "x", "1.0.0", { fetchFn: throwingFetch });
    expect(v.status).toBe("unknown");
    expect(v.vulns).toHaveLength(0);
  });

  it("returns unknown on a non-ok HTTP status", async () => {
    const v = await scanOne("npm", "x", "1.0.0", { fetchFn: stub({}, { ok: false, status: 503 }) });
    expect(v.status).toBe("unknown");
  });

  it("returns unknown when JSON parsing throws", async () => {
    const badFetch: FetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("bad json");
      },
    });
    const v = await scanOne("npm", "x", "1.0.0", { fetchFn: badFetch });
    expect(v.status).toBe("unknown");
  });
});

describe("scanOne — local scanner source order", () => {
  it("uses a definitive local scanner result and skips OSV HTTP", async () => {
    const localVerdict: ScanVerdict = { status: "vulnerable", vulns: [], scannedVersion: "1.0.0" };
    const local: LocalScanner = async () => localVerdict;
    // fetchFn would throw if reached — proves the local result short-circuited.
    const v = await scanOne("npm", "x", "1.0.0", { fetchFn: throwingFetch, localScanners: [local] });
    expect(v).toEqual(localVerdict);
  });

  it("falls through to OSV HTTP when a local scanner is not definitive (null)", async () => {
    const local: LocalScanner = async () => null;
    const v = await scanOne("npm", "x", "1.0.0", { fetchFn: stub({ vulns: [] }), localScanners: [local] });
    expect(v.status).toBe("clean");
  });
});
