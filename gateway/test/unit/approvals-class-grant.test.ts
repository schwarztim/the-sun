/**
 * UX-1 suite: class-scoped grants.
 *
 * A class grant (createClassGrant) lets a human approve "trust <safetyClass> on
 * backend X for a short TTL", authorizing every tool of that class on that
 * backend without a fresh Tier-B prompt per tool, while staying human-issued,
 * TTL-bounded, and never one-time. It is stored with tool = "*" plus a
 * safetyClass tag, so it is distinct from a plain trust wildcard (no
 * safetyClass, matches every class).
 *
 * Covers:
 *  - one class grant authorizes two DIFFERENT tools of that class on the
 *    backend, with no consumption / re-park between them
 *  - it does NOT authorize a different class, or a different backend
 *  - it expires: an already-expired class grant on disk is pruned, so the call
 *    re-parks (findAndConsume / findGrant undefined)
 *  - precedence: an exact-tool grant still wins over a covering class grant
 *  - default TTL (~15m) applied when none given; explicit ttl capped at 1h
 *  - REFUSED outright for a class that forbids standing authority (PRODUCTION)
 *
 * The subject class here is VAULT_VALUE rather than PRODUCTION: a class grant is
 * standing authority over every current and future tool of a class, which
 * PRODUCTION no longer permits (approvals.ts NO_STANDING_GRANT_CLASSES).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalStore, summarizeArgs, type StandingGrant } from "../../src/approvals.js";

const MIN_MS = 60 * 1000;

let dir: string;
let store: ApprovalStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "approvals-class-"));
  store = new ApprovalStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Park + approve to mint an exact-tool grant through the production path. */
function mintExact(tool: string, opts: { standing?: boolean } = {}): StandingGrant {
  const pending = store.createPending({
    identity: "id-1",
    backend: "github",
    tool,
    argsSummary: summarizeArgs({ x: 1 }),
    safetyClass: "VAULT_VALUE",
  });
  const result = store.approve(pending.id, opts);
  if (!result) throw new Error("approve failed in fixture");
  return result.grant;
}

/** Write grants.json directly so a specific (e.g. already-expired) grant can be planted. */
function writeGrants(grants: StandingGrant[]): void {
  writeFileSync(join(dir, "grants.json"), JSON.stringify(grants, null, 2), { mode: 0o600 });
}

describe("UX-1 — class grant authorizes a whole class on a backend", () => {
  it("authorizes two DIFFERENT tools of the class with no consumption between them", () => {
    const grant = store.createClassGrant({ identity: "id-1", backend: "github", safetyClass: "VAULT_VALUE" });
    expect(grant.tool).toBe("*");
    expect(grant.safetyClass).toBe("VAULT_VALUE");
    expect(grant.oneTime).toBeUndefined(); // never one-time
    expect(grant.expiresAt).toBeTruthy(); // always TTL-bounded

    const first = store.findAndConsume("id-1", "github", "github_delete_repo", "VAULT_VALUE");
    expect(first?.id).toBe(grant.id);
    const second = store.findAndConsume("id-1", "github", "github_disable_branch", "VAULT_VALUE");
    expect(second?.id).toBe(grant.id);

    // Still exactly one class grant in the store after two dispatches (not consumed).
    expect(store.listGrants().filter((g) => g.safetyClass === "VAULT_VALUE")).toHaveLength(1);
  });

  it("does NOT authorize a different class or a different backend", () => {
    store.createClassGrant({ identity: "id-1", backend: "github", safetyClass: "VAULT_VALUE" });

    // Different class on the same backend: no match, re-parks.
    expect(store.findAndConsume("id-1", "github", "github_send_email", "HUMAN_OUTBOUND")).toBeUndefined();
    // Same class on a different backend: no match, re-parks.
    expect(store.findAndConsume("id-1", "stash", "stash_delete_repo", "VAULT_VALUE")).toBeUndefined();
    // A call that supplies no safetyClass at all does not ride the class grant.
    expect(store.findAndConsume("id-1", "github", "github_delete_repo")).toBeUndefined();
  });
});

describe("UX-1 — class grant expires (pruned, re-parks)", () => {
  it("an already-expired class grant on disk is dropped by findAndConsume / findGrant", () => {
    const expired: StandingGrant = {
      id: "stale-class",
      identity: "id-1",
      backend: "github",
      tool: "*",
      safetyClass: "VAULT_VALUE",
      createdAt: new Date(Date.now() - 60 * MIN_MS).toISOString(),
      expiresAt: new Date(Date.now() - MIN_MS).toISOString(), // expired 1m ago
    };
    writeGrants([expired]);

    expect(store.findAndConsume("id-1", "github", "github_delete_repo", "VAULT_VALUE")).toBeUndefined();
    expect(store.findGrant("id-1", "github", "github_delete_repo", "VAULT_VALUE")).toBeUndefined();
    expect(store.listGrants().filter((g) => g.id === "stale-class")).toHaveLength(0);
  });
});

describe("UX-1 — precedence: exact-tool grant still wins over a class grant", () => {
  it("an exact one-time grant is preferred over a covering class grant and is the one consumed", () => {
    store.createClassGrant({ identity: "id-1", backend: "github", safetyClass: "VAULT_VALUE" });
    const exact = mintExact("github_delete_repo"); // one-time exact, VAULT_VALUE class

    const first = store.findAndConsume("id-1", "github", "github_delete_repo", "VAULT_VALUE");
    expect(first?.id).toBe(exact.id); // exact wins over class
    expect(first?.oneTime).toBe(true);

    // Exact consumed; the class grant now answers (and is NOT consumed).
    const after = store.findAndConsume("id-1", "github", "github_delete_repo", "VAULT_VALUE");
    expect(after?.tool).toBe("*");
    expect(after?.safetyClass).toBe("VAULT_VALUE");
    expect(store.listGrants().filter((g) => g.safetyClass === "VAULT_VALUE")).toHaveLength(1);
  });

  it("class grant is preferred over a plain backend-wide trust wildcard", () => {
    store.createTrustGrant({ identity: "id-1", backend: "github" }); // matches every class
    const cls = store.createClassGrant({ identity: "id-1", backend: "github", safetyClass: "VAULT_VALUE" });

    // A VAULT_VALUE call rides the narrower class grant, not the wildcard.
    expect(store.findAndConsume("id-1", "github", "github_delete_repo", "VAULT_VALUE")?.id).toBe(cls.id);
    // A different-class call falls through to the wildcard.
    const other = store.findAndConsume("id-1", "github", "github_send_email", "HUMAN_OUTBOUND");
    expect(other?.tool).toBe("*");
    expect(other?.safetyClass).toBeUndefined();
  });
});

describe("UX-1 — class grant TTL default and cap", () => {
  it("applies the ~15m default when no ttl is given", () => {
    const before = Date.now();
    const grant = store.createClassGrant({ identity: "id-1", backend: "github", safetyClass: "VAULT_VALUE" });
    const after = Date.now();
    const expiry = new Date(grant.expiresAt as string).getTime();
    expect(expiry).toBeGreaterThanOrEqual(before + 15 * MIN_MS);
    expect(expiry).toBeLessThanOrEqual(after + 15 * MIN_MS + 1000);
  });

  it("caps an over-long explicit ttl at 1h", () => {
    const before = Date.now();
    const grant = store.createClassGrant({
      identity: "id-1",
      backend: "github",
      safetyClass: "VAULT_VALUE",
      ttlMs: 24 * 60 * MIN_MS, // request 24h
    });
    const after = Date.now();
    const expiry = new Date(grant.expiresAt as string).getTime();
    expect(expiry).toBeLessThanOrEqual(after + 60 * MIN_MS + 1000); // capped at 1h
    expect(expiry).toBeGreaterThanOrEqual(before + 60 * MIN_MS);
  });

  it("re-approving the same class refreshes rather than stacks", () => {
    const first = store.createClassGrant({ identity: "id-1", backend: "github", safetyClass: "VAULT_VALUE" });
    const second = store.createClassGrant({ identity: "id-1", backend: "github", safetyClass: "VAULT_VALUE" });
    const vaultValue = store.listGrants().filter((g) => g.safetyClass === "VAULT_VALUE");
    expect(vaultValue).toHaveLength(1);
    expect(vaultValue[0].id).toBe(second.id);
    expect(vaultValue[0].id).not.toBe(first.id);
  });
});

// ─── No-standing classes cannot have a class grant at all ─────────────────────

describe("createClassGrant refuses a class that forbids standing authority", () => {
  it("throws for PRODUCTION rather than minting authority the resolver ignores", () => {
    expect(() =>
      store.createClassGrant({ identity: "id-1", backend: "github", safetyClass: "PRODUCTION" })
    ).toThrow(/not allowed for safety class PRODUCTION/);
    expect(store.listGrants()).toHaveLength(0);
  });
});
