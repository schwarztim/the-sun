/**
 * gateway-wiring.test.ts — proves the two Phase-1b wiring points are LIVE:
 *
 *   1. Policy snapshot writer — after boot, THESUN_HOME (the boot's approvals
 *      dir, which is where the writer targets: config.approvals.dir) contains
 *      policy-snapshot.json; it parses, carries a gatewayUrl, and has ≥1 entry
 *      for the fake backend's gated tools with a plausible tier.
 *   2. Dep-scan route — POST <adminUrl>/dep-scan is MOUNTED and reachable on
 *      loopback (not 404). A non-install command returns the fail-open shape
 *      (null) WITHOUT any network scan.
 *
 * Both assert the INTEGRATION only — the module internals have their own unit
 * suites; here we prove gateway.ts actually calls them.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootGateway, fakeBackend, type BootedGateway, type FakeBackend } from "./harness.js";

describe("gateway wiring (policy snapshot + dep-scan route)", () => {
  let backend: FakeBackend;
  let gw: BootedGateway;

  beforeAll(async () => {
    backend = await fakeBackend("wiring");
    gw = await bootGateway({ backends: { wiring: { url: backend.url } } });
  });

  afterAll(async () => {
    await gw.stop();
    await backend.close();
  });

  it("writes policy-snapshot.json into THESUN_HOME on start", async () => {
    const path = join(gw.approvalsDir, "policy-snapshot.json");
    const raw = await readFile(path, "utf-8");
    const snapshot = JSON.parse(raw);

    expect(snapshot.version).toBe(1);
    expect(typeof snapshot.tools).toBe("object");

    // gatewayUrl carries the loopback base so the hook can find /dep-scan.
    expect(typeof snapshot.gatewayUrl).toBe("string");
    expect(snapshot.gatewayUrl).toContain(`127.0.0.1:${gw.port}`);

    // The fake backend's write-verb fixture (wiring_fake_delete_item) is a
    // gated WRITE by name-pattern, so it must appear with a plausible tier.
    const entries = Object.entries(snapshot.tools) as Array<[string, { tier: string; class: string }]>;
    expect(entries.length).toBeGreaterThanOrEqual(1);
    for (const [, entry] of entries) {
      expect(["A", "B"]).toContain(entry.tier);
      // READ tools are omitted by the builder — nothing listed should be READ.
      expect(entry.class).not.toBe("READ");
    }
    const deleteEntry = snapshot.tools["wiring_fake_delete_item"];
    expect(deleteEntry).toBeDefined();
    expect(["A", "B"]).toContain(deleteEntry.tier);
  });

  it("mounts POST /dep-scan on loopback (non-install → fail-open null)", async () => {
    // A non-install command returns null WITHOUT any OSV network scan — proves
    // the route is reachable (non-404) and wired to assessInstallCommand.
    for (const command of ["npm run build", "cd /tmp"]) {
      const res = await fetch(`${gw.adminUrl}/dep-scan`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command }),
      });
      expect(res.status).not.toBe(404);
      expect(res.status).toBe(200);
      const body = await res.json();
      // Fail-open shape: allow == null (no veto/warn for a non-install).
      expect(body).toBeNull();
    }
  });
});
