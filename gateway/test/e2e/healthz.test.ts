/**
 * healthz.test.ts (OPS-1) — proves the unauthenticated liveness endpoint:
 *
 *   - GET /healthz returns 200 with NO auth header (admin token or bearer).
 *   - The body is coarse liveness only: status "ok", a numeric uptime, and
 *     backend {connected,total} counts that match the booted fake backend.
 *   - It leaks nothing sensitive (no tokens, no config, no per-backend detail).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootGateway, fakeBackend, type BootedGateway, type FakeBackend } from "./harness.js";

describe("healthz liveness endpoint (OPS-1)", () => {
  let backend: FakeBackend;
  let gw: BootedGateway;

  beforeAll(async () => {
    backend = await fakeBackend("hz");
    gw = await bootGateway({ backends: { hz: { url: backend.url } } });
  });

  afterAll(async () => {
    await gw.stop();
    await backend.close();
  });

  it("returns 200 and backend counts WITHOUT any auth header", async () => {
    // No Authorization header, no admin token — must still be reachable.
    const res = await fetch(`${gw.adminUrl}/healthz`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(typeof body.uptime_s).toBe("number");
    expect(body.uptime_s).toBeGreaterThanOrEqual(0);

    // One fake backend was booted and should be connected.
    expect(body.backends.total).toBe(1);
    expect(body.backends.connected).toBe(1);

    // Liveness must not leak sensitive surface: only the three known keys.
    expect(Object.keys(body).sort()).toEqual(["backends", "status", "uptime_s"]);

    // STAB-3: the status breakdown is ADDITIVE. connected and total keep their
    // original meaning and position (asserted above) because `thesun status`
    // and `thesun doctor` read exactly those two; the rest is new detail.
    expect(Object.keys(body.backends).sort()).toEqual([
      "abandoned",
      "connected",
      "disabled",
      "retrying",
      "starting",
      "total",
    ]);

    // Still counts only, never per-backend detail (no names, no URLs, no config).
    for (const value of Object.values(body.backends)) {
      expect(typeof value).toBe("number");
    }
  });

  it("breakdown accounts for every known backend exactly once", async () => {
    const res = await fetch(`${gw.adminUrl}/healthz`);
    const body = await res.json();
    const b = body.backends;

    // The four mutually exclusive non-connected buckets plus connected must sum
    // to total. If this ever drifts, the denominator is lying again.
    expect(b.connected + b.starting + b.retrying + b.abandoned + b.disabled).toBe(
      b.total
    );
  });
});
