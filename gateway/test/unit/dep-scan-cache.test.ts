import { describe, it, expect, afterEach } from "vitest";
import { createScanCache } from "../../src/dep-scan/cache.js";
import type { ScanVerdict } from "../../src/dep-scan/types.js";

const clean: ScanVerdict = { status: "clean", vulns: [] };
const unknown: ScanVerdict = { status: "unknown", vulns: [] };

afterEach(() => {
  delete process.env.DEP_SCAN_TTL_HOURS;
  delete process.env.DEP_SCAN_UNKNOWN_TTL_HOURS;
});

describe("createScanCache", () => {
  it("stores and retrieves by (ecosystem, name, version)", () => {
    const c = createScanCache();
    c.set("npm", "lodash", "4.17.21", clean);
    expect(c.get("npm", "lodash", "4.17.21")).toEqual(clean);
    expect(c.get("npm", "lodash", "4.17.20")).toBeUndefined(); // different version
    expect(c.get("PyPI", "lodash", "4.17.21")).toBeUndefined(); // different ecosystem
  });

  it("expires clean/vulnerable entries after DEP_SCAN_TTL_HOURS", () => {
    let t = 0;
    const c = createScanCache({ now: () => t });
    c.set("npm", "lodash", "1.0.0", clean);
    t = 23 * 3_600_000; // within 24h
    expect(c.get("npm", "lodash", "1.0.0")).toEqual(clean);
    t = 25 * 3_600_000; // past 24h default
    expect(c.get("npm", "lodash", "1.0.0")).toBeUndefined();
  });

  it("expires unknown entries after the short (5 min) TTL", () => {
    let t = 0;
    const c = createScanCache({ now: () => t });
    c.set("npm", "x", "1.0.0", unknown);
    t = 4 * 60_000; // within 5 min
    expect(c.get("npm", "x", "1.0.0")).toEqual(unknown);
    t = 6 * 60_000; // past 5 min
    expect(c.get("npm", "x", "1.0.0")).toBeUndefined();
  });

  it("honors env-overridden TTLs", () => {
    process.env.DEP_SCAN_TTL_HOURS = "1";
    let t = 0;
    const c = createScanCache({ now: () => t });
    c.set("npm", "x", "1.0.0", clean);
    t = 2 * 3_600_000;
    expect(c.get("npm", "x", "1.0.0")).toBeUndefined();
  });

  it("busts entries written under a different engine version", () => {
    const store = new Map();
    const oldEngine = createScanCache({ store, engineVersion: 1 });
    oldEngine.set("npm", "lodash", "1.0.0", clean);
    expect(oldEngine.get("npm", "lodash", "1.0.0")).toEqual(clean);

    // A newer engine sharing the same store treats the old entry as a miss.
    const newEngine = createScanCache({ store, engineVersion: 2 });
    expect(newEngine.get("npm", "lodash", "1.0.0")).toBeUndefined();
    expect(store.size).toBe(0); // stale entry evicted
  });
});

describe("createScanCache — bounded LRU (OPS-5)", () => {
  it("never grows past maxEntries, evicting oldest-first", () => {
    const c = createScanCache({ maxEntries: 3 });
    c.set("npm", "a", "1", clean);
    c.set("npm", "b", "1", clean);
    c.set("npm", "c", "1", clean);
    expect(c.size()).toBe(3);
    // Fourth insert overflows → oldest ("a") is evicted.
    c.set("npm", "d", "1", clean);
    expect(c.size()).toBe(3);
    expect(c.get("npm", "a", "1")).toBeUndefined(); // evicted
    expect(c.get("npm", "d", "1")).toEqual(clean); // newest kept
  });

  it("a hit refreshes recency so the touched key survives the next eviction", () => {
    const c = createScanCache({ maxEntries: 3 });
    c.set("npm", "a", "1", clean);
    c.set("npm", "b", "1", clean);
    c.set("npm", "c", "1", clean);
    // Touch "a" — it becomes most-recently-used, so "b" is now the oldest.
    expect(c.get("npm", "a", "1")).toEqual(clean);
    c.set("npm", "d", "1", clean); // overflow → evicts "b", not "a"
    expect(c.get("npm", "b", "1")).toBeUndefined();
    expect(c.get("npm", "a", "1")).toEqual(clean);
  });

  it("re-setting an existing key does not grow size and refreshes recency", () => {
    const c = createScanCache({ maxEntries: 2 });
    c.set("npm", "a", "1", clean);
    c.set("npm", "b", "1", clean);
    c.set("npm", "a", "1", clean); // overwrite, not a new slot; "a" now newest
    expect(c.size()).toBe(2);
    c.set("npm", "c", "1", clean); // evicts oldest ("b")
    expect(c.get("npm", "b", "1")).toBeUndefined();
    expect(c.get("npm", "a", "1")).toEqual(clean);
  });

  it("still honors TTL under the LRU bound", () => {
    let t = 0;
    const c = createScanCache({ maxEntries: 10, now: () => t });
    c.set("npm", "x", "1", clean);
    t = 23 * 3_600_000; // within 24h default
    expect(c.get("npm", "x", "1")).toEqual(clean);
    t = 25 * 3_600_000; // past 24h
    expect(c.get("npm", "x", "1")).toBeUndefined();
  });
});
