/**
 * inventory-lifecycle.test.ts (STAB-8, STAB-9, STAB-10) — the three changes that
 * stop the gateway from hammering, and losing track of, its backend inventory.
 *
 * Context: the live gateway carried 19 permanently dead backends (ToolHive
 * containers whose Docker daemon is down) and retried every one of them, every
 * 30 seconds, forever. None of them ever reached "abandoned", because the
 * restart budget is only spent by drops FROM a connected state and these had
 * never connected. Meanwhile the backend set was materialized once at boot, so
 * anything fleetd started later stayed invisible until an operator forced a
 * reload.
 */
import { describe, expect, it } from "vitest";

// ─── STAB-8: retry backoff ────────────────────────────────────────────────────

/** Mirror of Gateway.nextAttemptAt, exercised directly for timing assertions. */
const BACKOFF_MAX_EXPONENT = 6;
const BACKOFF_CEILING_MS = 15 * 60 * 1000;
function nextAttemptAt(
  lastFailureAt: number | undefined,
  failures: number,
  reconnectIntervalSec: number
): number {
  if (lastFailureAt === undefined || failures <= 0) return 0;
  const baseMs = Math.max(1, reconnectIntervalSec) * 1000;
  const exponent = Math.min(failures - 1, BACKOFF_MAX_EXPONENT);
  return lastFailureAt + Math.min(baseMs * 2 ** exponent, BACKOFF_CEILING_MS);
}

describe("retry backoff timing (STAB-8)", () => {
  const T0 = 1_000_000;

  it("is due immediately when nothing has failed yet", () => {
    // A fresh drop must retry as fast as it always has; backoff only builds
    // after repeated failures.
    expect(nextAttemptAt(undefined, 0, 5)).toBe(0);
  });

  it("doubles the delay per consecutive failure", () => {
    expect(nextAttemptAt(T0, 1, 5)).toBe(T0 + 5_000);
    expect(nextAttemptAt(T0, 2, 5)).toBe(T0 + 10_000);
    expect(nextAttemptAt(T0, 3, 5)).toBe(T0 + 20_000);
    expect(nextAttemptAt(T0, 4, 5)).toBe(T0 + 40_000);
  });

  it("stops doubling at the exponent cap", () => {
    // 5s * 2^6 = 320s, and it must not keep growing past that.
    const capped = nextAttemptAt(T0, 7, 5);
    expect(capped).toBe(T0 + 320_000);
    expect(nextAttemptAt(T0, 20, 5)).toBe(capped);
    expect(nextAttemptAt(T0, 1000, 5)).toBe(capped);
  });

  it("honours the absolute ceiling for large reconnect intervals", () => {
    // A 600s interval would otherwise reach 600 * 64 = 10.6 hours.
    expect(nextAttemptAt(T0, 10, 600)).toBe(T0 + BACKOFF_CEILING_MS);
  });

  it("collapses the 30 second hammer into something proportionate", () => {
    // The point of the whole change: a permanently dead backend goes from a
    // retry every 30s to one every 320s, roughly a 10x reduction in pointless
    // connect attempts, without ever giving up entirely.
    const delayMs = nextAttemptAt(T0, 9, 5) - T0;
    expect(delayMs).toBeGreaterThan(30_000);
    expect(delayMs).toBe(320_000);
  });
});

// ─── STAB-9: skip, do not queue ───────────────────────────────────────────────

/** Mirror of the periodic tick's guard behavior. */
function makeTicker() {
  let mutationInFlight: Promise<void> | undefined;
  let runs = 0;
  let skips = 0;
  return {
    get runs() { return runs; },
    get skips() { return skips; },
    setMutation(p: Promise<void> | undefined) { mutationInFlight = p; },
    tick(work: () => Promise<void>) {
      if (mutationInFlight) { skips++; return; }
      runs++;
      const inflight = work().finally(() => {
        if (mutationInFlight === inflight) mutationInFlight = undefined;
      });
      mutationInFlight = inflight;
      return inflight;
    },
  };
}

describe("periodic re-ingest concurrency (STAB-9)", () => {
  it("skips the tick when a mutation is already in flight", async () => {
    const t = makeTicker();
    let release!: () => void;
    const reload = new Promise<void>((r) => { release = r; });
    t.setMutation(reload);

    t.tick(async () => {});
    t.tick(async () => {});
    expect(t.runs).toBe(0);
    expect(t.skips).toBe(2);

    release();
    await reload;
  });

  it("does NOT queue skipped ticks for later", async () => {
    // A queued re-ingest would re-scan a set the reload just refreshed. Missing
    // the tick entirely is the intended behavior; the next one is 3 minutes out.
    const t = makeTicker();
    let release!: () => void;
    const reload = new Promise<void>((r) => { release = r; });
    t.setMutation(reload);
    t.tick(async () => {});
    release();
    await reload;
    t.setMutation(undefined);

    // Nothing runs retroactively; only a fresh tick does work.
    expect(t.runs).toBe(0);
    await t.tick(async () => {});
    expect(t.runs).toBe(1);
  });

  it("clears the guard after its own work finishes so the next tick can run", async () => {
    const t = makeTicker();
    await t.tick(async () => {});
    await t.tick(async () => {});
    expect(t.runs).toBe(2);
    expect(t.skips).toBe(0);
  });
});

// ─── STAB-10: pruning safety ──────────────────────────────────────────────────

interface PruneEntry { fleetIngested: boolean; connected: boolean }

/** Mirror of Gateway.pruneVanishedBackends, including both safety guards. */
function makePruner(threshold = 2) {
  const absences = new Map<string, number>();
  return (
    backends: Map<string, PruneEntry>,
    present: Set<string>,
    enabled = true
  ): string[] => {
    const pruned: string[] = [];
    if (!enabled) return pruned;
    if (present.size === 0) return pruned; // guard 1: empty read
    for (const [name, entry] of backends) {
      if (present.has(name)) { absences.delete(name); continue; }
      if (!entry.fleetIngested) continue;
      if (entry.connected) { absences.delete(name); continue; }
      const n = (absences.get(name) ?? 0) + 1;
      if (n < threshold) { absences.set(name, n); continue; } // guard 2
      absences.delete(name);
      pruned.push(name);
    }
    for (const name of pruned) backends.delete(name);
    return pruned;
  };
}

describe("fleet pruning safety (STAB-10)", () => {
  const fleetDead: PruneEntry = { fleetIngested: true, connected: false };

  it("never prunes on an empty inventory read", () => {
    // A Docker daemon that is down reads as "nothing exists". Acting on that
    // would wipe the entire fleet in a single tick.
    const prune = makePruner();
    const backends = new Map([["a", fleetDead], ["b", fleetDead]]);
    expect(prune(backends, new Set())).toEqual([]);
    expect(prune(backends, new Set())).toEqual([]);
    expect(backends.size).toBe(2);
  });

  it("requires two consecutive absences before removing", () => {
    const prune = makePruner();
    const backends = new Map([["gone", fleetDead], ["here", fleetDead]]);
    expect(prune(backends, new Set(["here"]))).toEqual([]);   // first absence
    expect(prune(backends, new Set(["here"]))).toEqual(["gone"]);
    expect(backends.has("gone")).toBe(false);
  });

  it("resets the absence count when a backend reappears", () => {
    // A container restarting between reads must not be evicted.
    const prune = makePruner();
    const backends = new Map([["flappy", fleetDead], ["anchor", fleetDead]]);
    prune(backends, new Set(["anchor"]));                      // absent once
    prune(backends, new Set(["anchor", "flappy"]));            // back: reset
    prune(backends, new Set(["anchor"]));                      // absent once again
    expect(backends.has("flappy")).toBe(true);
  });

  it("never prunes a statically configured backend, however dead", () => {
    const prune = makePruner();
    const backends = new Map([["static", { fleetIngested: false, connected: false }]]);
    prune(backends, new Set(["other"]));
    prune(backends, new Set(["other"]));
    prune(backends, new Set(["other"]));
    expect(backends.has("static")).toBe(true);
  });

  it("never prunes a connected backend", () => {
    // Absence from the inventory while serving traffic is an inventory problem,
    // not a reason to drop a working route.
    const prune = makePruner();
    const backends = new Map([["live", { fleetIngested: true, connected: true }]]);
    prune(backends, new Set(["other"]));
    prune(backends, new Set(["other"]));
    expect(backends.has("live")).toBe(true);
  });

  it("does nothing at all when the feature is disabled", () => {
    const prune = makePruner();
    const backends = new Map([["gone", fleetDead], ["here", fleetDead]]);
    prune(backends, new Set(["here"]), false);
    prune(backends, new Set(["here"]), false);
    expect(backends.size).toBe(2);
  });
});

describe("configuration and observability of the lifecycle changes", () => {
  it("prune_missing defaults to OFF", async () => {
    // The only one of the three that changes what operators see in
    // gateway_backend_status, so it must be opt-in.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../src/config.ts", import.meta.url), "utf-8");
    expect(src).toMatch(/prune_missing:\s*z\.boolean\(\)\.default\(false\)/);
  });

  it("exposes a pruned counter so a pruning storm is visible", async () => {
    const { COUNTERS, Metrics } = await import("../../src/metrics.js");
    const out = new Metrics().renderPrometheus({ backendsConnected: 0, backendsTotal: 0 });
    expect(out).toContain(`${COUNTERS.backendsPruned} 0`);
    expect(out).toContain(`# TYPE ${COUNTERS.backendsPruned} counter`);
  });

  it("runs fleet refresh on its own timer, not inside the health callback", async () => {
    // A slow inventory read must never delay reconnects.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../src/gateway.ts", import.meta.url), "utf-8");
    expect(src).toMatch(/private fleetRefreshTimer\?/);
    expect(src).toMatch(/startFleetRefreshTimer/);
    expect(src).toMatch(/clearInterval\(this\.fleetRefreshTimer\)/);
  });
});
