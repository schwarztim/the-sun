/**
 * dep-scan-timeout.test.ts (OPS-5) — every outbound dep-scan fetch is wrapped
 * with an AbortController + setTimeout, so a hung endpoint aborts instead of
 * hanging the install-gating request, and degrades via the existing fail-open
 * path (unknown / undefined / exists:true).
 *
 * NO live network. `hangingFetch` mimics a real fetch against a dead endpoint:
 * it never resolves on its own and only settles (rejects) when its abort signal
 * fires. If the timeout wiring were missing, these calls would never settle and
 * the test would hit vitest's own timeout — so a passing test PROVES the abort.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  fetchWithTimeout,
  fetchTimeoutMs,
  DEFAULT_FETCH_TIMEOUT_MS,
} from "../../src/dep-scan/fetch-timeout.js";
import { scanOne } from "../../src/dep-scan/osv.js";
import { resolveScanVersion } from "../../src/dep-scan/resolve-version.js";
import { checkExistence } from "../../src/dep-scan/existence.js";
import type { FetchLike } from "../../src/dep-scan/types.js";

/** A fetch that hangs until its abort signal fires, then rejects (like real fetch). */
const hangingFetch: FetchLike = (_url, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted by timeout")));
  });

afterEach(() => {
  delete process.env.DEP_SCAN_FETCH_TIMEOUT_MS;
});

describe("fetchTimeoutMs — configurable, safe default", () => {
  it("defaults to DEFAULT_FETCH_TIMEOUT_MS when unset or invalid", () => {
    delete process.env.DEP_SCAN_FETCH_TIMEOUT_MS;
    expect(fetchTimeoutMs()).toBe(DEFAULT_FETCH_TIMEOUT_MS);
    process.env.DEP_SCAN_FETCH_TIMEOUT_MS = "0";
    expect(fetchTimeoutMs()).toBe(DEFAULT_FETCH_TIMEOUT_MS);
    process.env.DEP_SCAN_FETCH_TIMEOUT_MS = "not-a-number";
    expect(fetchTimeoutMs()).toBe(DEFAULT_FETCH_TIMEOUT_MS);
  });

  it("honors a positive override", () => {
    process.env.DEP_SCAN_FETCH_TIMEOUT_MS = "1234";
    expect(fetchTimeoutMs()).toBe(1234);
  });
});

describe("fetchWithTimeout — aborts a hung fetch and passes the signal through", () => {
  it("rejects when the timeout fires", async () => {
    await expect(fetchWithTimeout(hangingFetch, "https://x", {}, 15)).rejects.toThrow();
  });

  it("passes an AbortSignal to the wrapped fetch", async () => {
    let sawSignal = false;
    const probe: FetchLike = async (_url, init) => {
      sawSignal = init?.signal instanceof AbortSignal;
      return { ok: true, status: 200, json: async () => ({}) };
    };
    await fetchWithTimeout(probe, "https://x", { method: "GET" }, 1000);
    expect(sawSignal).toBe(true);
  });

  it("resolves normally (and clears the timer) on a fast success", async () => {
    const ok: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ v: 1 }) });
    const resp = await fetchWithTimeout(ok, "https://x", {}, 1000);
    expect(resp.ok).toBe(true);
  });
});

describe("timeout degrades fail-open in every fetch module", () => {
  // Small real timeout so a hung endpoint settles quickly instead of hanging.
  const short = () => {
    process.env.DEP_SCAN_FETCH_TIMEOUT_MS = "15";
  };

  it("scanOne → unknown when the OSV endpoint hangs", async () => {
    short();
    const v = await scanOne("npm", "x", "1.0.0", { fetchFn: hangingFetch });
    expect(v.status).toBe("unknown");
    expect(v.vulns).toHaveLength(0);
  });

  it("resolveScanVersion → undefined when the registry hangs", async () => {
    short();
    const out = await resolveScanVersion("npm", { name: "x", versionSpec: "latest" }, hangingFetch);
    expect(out).toBeUndefined();
  });

  it("checkExistence → fail-open (exists, not checked) when the registry hangs", async () => {
    short();
    const out = await checkExistence("npm", "x", hangingFetch);
    expect(out).toEqual({ exists: true, checked: false });
  });
});
