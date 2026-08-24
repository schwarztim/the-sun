import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPolicySnapshot,
  snapshotTier,
  writePolicySnapshot,
  POLICY_SNAPSHOT_FILENAME,
  type PolicySnapshot,
} from "../../src/policy-snapshot.js";
import type { SafetyClassification } from "../../src/manifest.js";

function cls(partial: Partial<SafetyClassification> & { safetyClass: SafetyClassification["safetyClass"] }): SafetyClassification {
  return {
    tags: [],
    confirmationMapsToDownstream: false,
    source: "manifest",
    ...partial,
  };
}

describe("snapshotTier — mirrors approvals.isTierBClass", () => {
  it("PRODUCTION / VAULT_VALUE / HUMAN_OUTBOUND are Tier-B by class", () => {
    expect(snapshotTier(cls({ safetyClass: "PRODUCTION" }))).toBe("B");
    expect(snapshotTier(cls({ safetyClass: "VAULT_VALUE" }))).toBe("B");
    expect(snapshotTier(cls({ safetyClass: "HUMAN_OUTBOUND" }))).toBe("B");
  });

  it("any non-empty writeGuard forces Tier-B regardless of class", () => {
    expect(snapshotTier(cls({ safetyClass: "WRITE", writeGuard: "policy:delete-method" }))).toBe("B");
    expect(snapshotTier(cls({ safetyClass: "UNCLASSIFIED", writeGuard: "manual" }))).toBe("B");
  });

  it("plain WRITE / SIDE_EFFECT / UNCLASSIFIED with no guard are Tier-A", () => {
    expect(snapshotTier(cls({ safetyClass: "WRITE" }))).toBe("A");
    expect(snapshotTier(cls({ safetyClass: "SIDE_EFFECT" }))).toBe("A");
    expect(snapshotTier(cls({ safetyClass: "UNCLASSIFIED" }))).toBe("A");
  });
});

describe("buildPolicySnapshot", () => {
  it("omits READ and undefined-classification tools (silent-pass surface)", () => {
    const snap = buildPolicySnapshot([
      { tool: "gh_get_repo", classification: cls({ safetyClass: "READ" }) },
      { tool: "gh_unknown", classification: undefined },
      { tool: "gh_update_issue", classification: cls({ safetyClass: "WRITE" }) },
    ]);
    expect(snap.tools).not.toHaveProperty("gh_get_repo");
    expect(snap.tools).not.toHaveProperty("gh_unknown");
    expect(snap.tools).toHaveProperty("gh_update_issue");
    expect(snap.version).toBe(1);
  });

  it("records tier=A for benign writes and tier=B + rule for escalated tools", () => {
    const snap = buildPolicySnapshot([
      { tool: "gh_update_issue", classification: cls({ safetyClass: "WRITE" }) },
      { tool: "gh_delete_repo", classification: cls({ safetyClass: "WRITE", writeGuard: "policy:delete-method" }) },
      { tool: "sn_send_email", classification: cls({ safetyClass: "HUMAN_OUTBOUND" }) },
    ]);
    expect(snap.tools.gh_update_issue).toEqual({ tier: "A", class: "WRITE" });
    expect(snap.tools.gh_delete_repo).toEqual({ tier: "B", class: "WRITE", rule: "policy:delete-method" });
    expect(snap.tools.sn_send_email).toEqual({ tier: "B", class: "HUMAN_OUTBOUND" });
  });

  it("only surfaces policy:* writeGuards as rule, not manifest-authored guards", () => {
    const snap = buildPolicySnapshot([
      { tool: "x_tool", classification: cls({ safetyClass: "WRITE", writeGuard: "hand-authored" }) },
    ]);
    expect(snap.tools.x_tool).toEqual({ tier: "B", class: "WRITE" });
    expect(snap.tools.x_tool.rule).toBeUndefined();
  });
});

describe("writePolicySnapshot", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "thesun-snap-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes policy-snapshot.json atomically with 0600 perms and returns the path", () => {
    const path = writePolicySnapshot(
      [{ tool: "gh_delete_repo", classification: cls({ safetyClass: "WRITE", writeGuard: "policy:delete-method" }) }],
      dir
    );
    expect(path).toBe(join(dir, POLICY_SNAPSHOT_FILENAME));
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as PolicySnapshot;
    expect(parsed.tools.gh_delete_repo.tier).toBe("B");
    // 0600 file mode (owner rw only) — lower 9 bits.
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  });

  it("accepts a prebuilt PolicySnapshot as well as raw inputs", () => {
    const prebuilt: PolicySnapshot = { version: 1, tools: { a_tool: { tier: "A", class: "WRITE" } } };
    const path = writePolicySnapshot(prebuilt, dir);
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as PolicySnapshot;
    expect(parsed.tools.a_tool).toEqual({ tier: "A", class: "WRITE" });
  });
});
