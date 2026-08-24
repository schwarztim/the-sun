/**
 * SEC-6 regression suite: one-time grant default TTL + pruning.
 *
 * The bug: a one-time grant approved WITHOUT an explicit ttl had no
 * `expiresAt`, and loadGrants only prunes entries that HAVE an `expiresAt`. So
 * an approved-but-never-consumed one-time grant lived in grants.json forever as
 * stale standing authority.
 *
 * The fix: approve() applies DEFAULT_ONE_TIME_TTL_MS (24h) to a one-time grant
 * when no explicit ttlMs is given, so loadGrants prunes it once past expiry and
 * a subsequent dispatch re-parks. Standing / wildcard / explicitly-TTL'd grants
 * are unaffected.
 *
 * Covers:
 *  - a one-time grant created with no explicit ttl gets a non-empty expiresAt
 *    (default TTL applied), roughly 24h out
 *  - an already-expired one-time grant on disk is pruned: findAndConsume and
 *    listGrants no longer return it, so a call re-parks
 *  - an explicitly-TTL'd one-time grant keeps its explicit ttl (not the default)
 *  - a standing grant is unaffected (no expiresAt when no ttl given)
 *  - a "*" wildcard trust grant is unaffected (no default expiry)
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalStore, summarizeArgs, type StandingGrant } from "../../src/approvals.js";

const DAY_MS = 24 * 60 * 60 * 1000;

let dir: string;
let store: ApprovalStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "approvals-ttl-"));
  store = new ApprovalStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Park + approve to mint a grant through the same path production uses. */
function mintGrant(tool: string, opts: { standing?: boolean; ttlMs?: number } = {}): StandingGrant {
  const pending = store.createPending({
    identity: "id-1",
    backend: "github",
    tool,
    argsSummary: summarizeArgs({ x: 1 }),
    // HUMAN_OUTBOUND, not PRODUCTION: this suite exercises standing-grant
    // mechanics, and PRODUCTION now forbids standing authority outright
    // (approvals.ts NO_STANDING_GRANT_CLASSES). The class here is incidental to
    // what is under test; HUMAN_OUTBOUND is Tier-B and standing-capable.
    safetyClass: "HUMAN_OUTBOUND",
  });
  const result = store.approve(pending.id, opts);
  if (!result) throw new Error("approve failed in fixture");
  return result.grant;
}

/** Write a grants.json directly so a specific (e.g. already-expired) grant can be planted. */
function writeGrants(grants: StandingGrant[]): void {
  writeFileSync(join(dir, "grants.json"), JSON.stringify(grants, null, 2), { mode: 0o600 });
}

describe("SEC-6 — one-time grant default TTL", () => {
  it("a one-time grant with no explicit ttl gets a non-empty expiresAt (~24h out)", () => {
    const before = Date.now();
    const grant = mintGrant("github_delete_repo"); // one-time (no standing, no ttl)
    const after = Date.now();

    expect(grant.oneTime).toBe(true);
    expect(grant.expiresAt).toBeTruthy();

    const expiry = new Date(grant.expiresAt as string).getTime();
    // Expiry sits a full default TTL out from when approve() ran.
    expect(expiry).toBeGreaterThanOrEqual(before + DAY_MS);
    expect(expiry).toBeLessThanOrEqual(after + DAY_MS + 1000);
  });

  it("an explicitly-TTL'd one-time grant keeps its explicit ttl, not the default", () => {
    const before = Date.now();
    const grant = mintGrant("github_delete_repo", { ttlMs: 60_000 }); // 60s explicit
    const after = Date.now();

    expect(grant.oneTime).toBe(true);
    const expiry = new Date(grant.expiresAt as string).getTime();
    expect(expiry).toBeGreaterThanOrEqual(before + 60_000);
    expect(expiry).toBeLessThanOrEqual(after + 60_000 + 1000);
    // Well short of the 24h default.
    expect(expiry).toBeLessThan(before + DAY_MS);
  });
});

describe("SEC-6 — expired one-time grant is pruned (re-parks)", () => {
  it("an already-expired one-time grant on disk is dropped by findAndConsume and listGrants", () => {
    const expired: StandingGrant = {
      id: "stale-one-time",
      identity: "id-1",
      backend: "github",
      tool: "github_delete_repo",
      createdAt: new Date(Date.now() - 2 * DAY_MS).toISOString(),
      expiresAt: new Date(Date.now() - DAY_MS).toISOString(), // expired 24h ago
      oneTime: true,
    };
    writeGrants([expired]);

    // Pruned on load: no authorization survives, so the next dispatch re-parks.
    expect(store.findAndConsume("id-1", "github", "github_delete_repo")).toBeUndefined();
    expect(store.findGrant("id-1", "github", "github_delete_repo")).toBeUndefined();
    expect(store.listGrants().filter((g) => g.id === "stale-one-time")).toHaveLength(0);
  });

  it("a live default-TTL one-time grant is still returned before it expires", () => {
    const grant = mintGrant("github_delete_repo");
    const found = store.findAndConsume("id-1", "github", "github_delete_repo");
    expect(found?.id).toBe(grant.id);
  });
});

describe("SEC-6 — standing / wildcard grants are unaffected", () => {
  it("a standing grant with no ttl has no expiresAt (never auto-expires)", () => {
    const grant = mintGrant("github_delete_repo", { standing: true });
    expect(grant.oneTime).toBe(false);
    expect(grant.expiresAt).toBeUndefined();
  });

  it('a "*" wildcard trust grant gets no default expiry', () => {
    const wildcard = store.createTrustGrant({ identity: "id-1", backend: "github" });
    expect(wildcard.expiresAt).toBeUndefined();
    // Survives repeated resolution without being consumed or pruned.
    expect(store.findAndConsume("id-1", "github", "any_tool")?.id).toBe(wildcard.id);
    expect(store.listGrants().filter((g) => g.tool === "*")).toHaveLength(1);
  });
});
