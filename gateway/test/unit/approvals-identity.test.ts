/**
 * Store-level unit tests for the Phase-4 client-scoped grant identity option
 * (approvals.identity_scope = "install" | "install+client").
 *
 * The ApprovalStore itself is scope-agnostic — it matches identity strings
 * exactly — so scoping is entirely decided by composeGrantIdentity(). These
 * tests prove (a) the composition rules and (b) the store-level consequence:
 * a grant issued under client A never matches a lookup under client B.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalStore, composeGrantIdentity } from "../../src/approvals.js";

describe("composeGrantIdentity", () => {
  it('scope "install" ignores the client name (default — preserves existing grants)', () => {
    expect(composeGrantIdentity("install-abc", "install", "claude-code")).toBe("install-abc");
    expect(composeGrantIdentity("install-abc", "install", undefined)).toBe("install-abc");
  });

  it('scope "install+client" appends the client name', () => {
    expect(composeGrantIdentity("install-abc", "install+client", "claude-code")).toBe(
      "install-abc+client:claude-code"
    );
  });

  it('scope "install+client" falls back to install scope when the client name is unavailable (stateless transport)', () => {
    expect(composeGrantIdentity("install-abc", "install+client", undefined)).toBe("install-abc");
    expect(composeGrantIdentity("install-abc", "install+client", "  ")).toBe("install-abc");
  });

  it("different clients compose different identities", () => {
    const a = composeGrantIdentity("install-abc", "install+client", "claude-code");
    const b = composeGrantIdentity("install-abc", "install+client", "codex");
    expect(a).not.toBe(b);
  });
});

describe("ApprovalStore — client-scoped grants (install+client)", () => {
  let dir: string;
  let store: ApprovalStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gw-approvals-identity-"));
    store = new ApprovalStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("a grant issued under client A does NOT authorize the same tool for client B", () => {
    const base = "install-test";
    const idA = composeGrantIdentity(base, "install+client", "claude-code");
    const idB = composeGrantIdentity(base, "install+client", "codex");

    // Park + approve under client A (standing grant).
    const pending = store.createPending({
      identity: idA,
      backend: "prodbe",
      tool: "prodbe_deploy_release",
      argsSummary: '{"env":"<string>"}',
      safetyClass: "PRODUCTION",
    });
    const approved = store.approve(pending.id, { standing: true });
    expect(approved).toBeDefined();

    // Client A is authorized; client B and the bare install identity are not.
    expect(store.findGrant(idA, "prodbe", "prodbe_deploy_release")).toBeDefined();
    expect(store.findGrant(idB, "prodbe", "prodbe_deploy_release")).toBeUndefined();
    expect(store.findGrant(base, "prodbe", "prodbe_deploy_release")).toBeUndefined();
  });

  it('under scope "install", both clients resolve to the same identity and share the grant', () => {
    const base = "install-test";
    const idA = composeGrantIdentity(base, "install", "claude-code");
    const idB = composeGrantIdentity(base, "install", "codex");
    expect(idA).toBe(idB);

    const pending = store.createPending({
      identity: idA,
      backend: "prodbe",
      tool: "prodbe_deploy_release",
      argsSummary: "{}",
      safetyClass: "PRODUCTION",
    });
    expect(store.approve(pending.id, { standing: true })).toBeDefined();
    expect(store.findGrant(idB, "prodbe", "prodbe_deploy_release")).toBeDefined();
  });
});
