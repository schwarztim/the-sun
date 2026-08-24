/**
 * dep-scan-limit.test.ts (OPS-5) — the per-package fan-out is bounded, so a huge
 * install list cannot open unbounded sockets at once.
 *
 * Covers mapLimit directly (peak concurrency + order preservation) and proves
 * index.ts wires it (assessInstallCommand over a 20-package command never runs
 * more than the configured ceiling of scans concurrently). NO live network.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mapLimit, DEFAULT_CONCURRENCY } from "../../src/dep-scan/limit.js";
import { assessInstallCommand, type AssessDeps } from "../../src/dep-scan/index.js";
import { createScanCache } from "../../src/dep-scan/cache.js";
import type { FetchLike } from "../../src/dep-scan/types.js";

const noFetch: FetchLike = async () => {
  throw new Error("no network in tests");
};

afterEach(() => {
  delete process.env.DEP_SCAN_CONCURRENCY;
});

/** A concurrency tracker: wraps an async body, recording the peak in-flight count. */
function tracker() {
  let inFlight = 0;
  let peak = 0;
  return {
    peak: () => peak,
    run: async <R>(body: () => Promise<R>): Promise<R> => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      try {
        return await body();
      } finally {
        inFlight--;
      }
    },
  };
}

/** Resolve on the next macrotask so several tasks genuinely overlap. */
const tick = () => new Promise((r) => setTimeout(r, 1));

describe("mapLimit — bounded concurrency", () => {
  it("runs at most `limit` tasks at once", async () => {
    const t = tracker();
    const items = Array.from({ length: 30 }, (_, i) => i);
    await mapLimit(items, 4, (n) => t.run(async () => {
      await tick();
      return n;
    }));
    expect(t.peak()).toBeLessThanOrEqual(4);
    expect(t.peak()).toBeGreaterThan(1); // actually parallel, not accidentally serial
  });

  it("preserves input order in the result array", async () => {
    const items = [10, 20, 30, 40, 50];
    const out = await mapLimit(items, 2, async (n, i) => {
      await tick();
      return `${i}:${n * 2}`;
    });
    expect(out).toEqual(["0:20", "1:40", "2:60", "3:80", "4:100"]);
  });

  it("clamps a bad limit and still processes every item", async () => {
    const items = [1, 2, 3];
    expect(await mapLimit(items, 0, async (n) => n)).toEqual([1, 2, 3]);
    expect(await mapLimit(items, -5, async (n) => n)).toEqual([1, 2, 3]);
  });

  it("returns an empty array for no items (no workers spawned)", async () => {
    let called = false;
    const out = await mapLimit([], 8, async () => {
      called = true;
      return 1;
    });
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });
});

describe("assessInstallCommand — fan-out is bounded (index.ts wiring)", () => {
  function deps(over: Partial<AssessDeps> = {}): AssessDeps {
    return {
      fetchFn: noFetch,
      cache: createScanCache(),
      resolveVersion: async (_e, pkg) => pkg.versionSpec,
      existence: async () => ({ exists: true, checked: true }),
      env: {},
      ...over,
    };
  }

  it("never scans more than DEFAULT_CONCURRENCY packages at once", async () => {
    const t = tracker();
    const scan: AssessDeps["scan"] = () =>
      t.run(async () => {
        await tick();
        return { status: "clean", vulns: [] };
      });
    const cmd = "npm i " + Array.from({ length: 20 }, (_, i) => `p${i}`).join(" ");
    await assessInstallCommand(cmd, deps({ scan }));
    expect(t.peak()).toBeLessThanOrEqual(DEFAULT_CONCURRENCY);
    expect(t.peak()).toBeGreaterThan(1);
  });

  it("respects a DEP_SCAN_CONCURRENCY override", async () => {
    const t = tracker();
    const scan: AssessDeps["scan"] = () =>
      t.run(async () => {
        await tick();
        return { status: "clean", vulns: [] };
      });
    const cmd = "npm i " + Array.from({ length: 20 }, (_, i) => `q${i}`).join(" ");
    await assessInstallCommand(cmd, deps({ scan, env: { DEP_SCAN_CONCURRENCY: "3" } }));
    expect(t.peak()).toBeLessThanOrEqual(3);
  });
});
