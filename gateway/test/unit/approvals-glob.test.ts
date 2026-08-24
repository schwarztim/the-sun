/**
 * Phase 2 grant-glob unit suite (approvals.ts findGrant + createTrustGrant).
 *
 * The tool-glob dimension is deliberately minimal: exact match OR the single
 * literal "*" (backend-wide trust) — no general globbing. Covers:
 *  - exact grants still match exactly (pre-Phase-2 behavior unchanged)
 *  - a "*" grant matches every tool of its backend, including tools that
 *    did not exist when the grant was created ("future tools")
 *  - "*" never leaks across backend or identity boundaries
 *  - exact grant wins over "*" (so one-time exact approvals are the ones
 *    consumed, not silently shadowed by the wildcard)
 *  - createTrustGrant is standing (never one-time), TTL-capped when asked,
 *    and re-trusting replaces the previous wildcard instead of stacking
 *  - value-free persistence: approvals.json / grants.json NEVER contain
 *    argument values (grep the persisted files — Phase 2 acceptance)
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalStore, summarizeArgs } from "../../src/approvals.js";

let dir: string;
let store: ApprovalStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "approvals-glob-"));
  store = new ApprovalStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Park + approve to mint a grant through the same path production uses. */
function mintGrant(tool: string, opts: { standing?: boolean } = {}) {
  const pending = store.createPending({
    identity: "id-1",
    backend: "github",
    tool,
    argsSummary: summarizeArgs({ x: 1 }),
    safetyClass: "PRODUCTION",
  });
  const result = store.approve(pending.id, opts);
  if (!result) throw new Error("approve failed in fixture");
  return result.grant;
}

describe("findGrant tool-glob dimension", () => {
  it("exact grant matches only its own tool (unchanged pre-Phase-2 behavior)", () => {
    mintGrant("github_delete_repo", { standing: true });
    expect(store.findGrant("id-1", "github", "github_delete_repo")).toBeDefined();
    expect(store.findGrant("id-1", "github", "github_create_repo")).toBeUndefined();
  });

  it('a "*" trust grant matches every tool of the backend — including future tools', () => {
    store.createTrustGrant({ identity: "id-1", backend: "github" });
    // Tools that "exist" today:
    expect(store.findGrant("id-1", "github", "github_delete_repo")).toBeDefined();
    // A tool name invented AFTER the grant was created (future tool):
    expect(store.findGrant("id-1", "github", "github_tool_added_next_release")).toBeDefined();
  });

  it('"*" never crosses backend or identity boundaries', () => {
    store.createTrustGrant({ identity: "id-1", backend: "github" });
    expect(store.findGrant("id-1", "stash", "stash_delete_repo")).toBeUndefined();
    expect(store.findGrant("id-2", "github", "github_delete_repo")).toBeUndefined();
  });

  it('an exact grant wins over "*" so one-time exact approvals get consumed, and the wildcard still covers afterwards', () => {
    store.createTrustGrant({ identity: "id-1", backend: "github" });
    const oneTime = mintGrant("github_delete_repo"); // one-time exact (no standing)

    const found = store.findGrant("id-1", "github", "github_delete_repo");
    expect(found?.id).toBe(oneTime.id); // exact preferred
    expect(found?.oneTime).toBe(true);

    store.consumeIfOneTime(found!.id);
    // Exact one-time gone; the standing wildcard now answers.
    const after = store.findGrant("id-1", "github", "github_delete_repo");
    expect(after).toBeDefined();
    expect(after!.tool).toBe("*");
  });
});

describe("createTrustGrant", () => {
  it("is standing (never one-time) and TTL-capped when requested", () => {
    const g = store.createTrustGrant({ identity: "id-1", backend: "github", ttlMs: 60_000 });
    expect(g.tool).toBe("*");
    expect(g.oneTime).toBeUndefined();
    expect(g.expiresAt).toBeDefined();
    expect(new Date(g.expiresAt!).getTime()).toBeGreaterThan(Date.now());

    const noTtl = store.createTrustGrant({ identity: "id-1", backend: "stash" });
    expect(noTtl.expiresAt).toBeUndefined();
  });

  it("re-trusting the same identity×backend replaces the wildcard instead of stacking duplicates", () => {
    store.createTrustGrant({ identity: "id-1", backend: "github", ttlMs: 60_000 });
    store.createTrustGrant({ identity: "id-1", backend: "github" });
    const wildcards = store.listGrants().filter((g) => g.backend === "github" && g.tool === "*");
    expect(wildcards.length).toBe(1);
    expect(wildcards[0].expiresAt).toBeUndefined(); // the refresh won
  });

  it("does not disturb exact-tool grants for the same backend", () => {
    mintGrant("github_delete_repo", { standing: true });
    store.createTrustGrant({ identity: "id-1", backend: "github" });
    const tools = store.listGrants().map((g) => g.tool).sort();
    expect(tools).toEqual(["*", "github_delete_repo"]);
  });

  it("an expired trust grant stops matching", () => {
    store.createTrustGrant({ identity: "id-1", backend: "github", ttlMs: -1 });
    expect(store.findGrant("id-1", "github", "github_delete_repo")).toBeUndefined();
  });
});

describe("value-free persistence (Phase 2 acceptance: grep the disk files)", () => {
  it("approvals.json and grants.json contain ZERO argument values after park + trust + approve", () => {
    const secretValue = "hunter2-super-secret-VALUE-9137";
    const pending = store.createPending({
      identity: "id-1",
      backend: "github",
      tool: "github_delete_repo",
      argsSummary: summarizeArgs({ repo: secretValue, force: true, count: 42 }),
      safetyClass: "PRODUCTION",
    });
    store.createTrustGrant({ identity: "id-1", backend: "github", ttlMs: 60_000 });
    store.approve(pending.id, { standing: true });

    for (const file of ["approvals.json", "grants.json"]) {
      const raw = readFileSync(join(dir, file), "utf-8");
      expect(raw, `${file} must not contain the argument value`).not.toContain(secretValue);
      expect(raw, `${file} must not contain any fragment of the value`).not.toContain("hunter2");
    }
  });

  it("summarizeArgs stays type-tag-only (the invariant the disk files inherit)", () => {
    const s = summarizeArgs({ token: "ghp_abc123", n: 7, flag: false, list: [1], none: null });
    expect(s).not.toContain("ghp_abc123");
    expect(JSON.parse(s)).toEqual({
      token: "<string>",
      n: "<number>",
      flag: "<boolean>",
      list: "<array>",
      none: "<null>",
    });
  });
});
