/**
 * Safety-class enforcement coverage.
 *
 * Why this file exists. `akamai_go_akamai_raw_request` is declared PRODUCTION,
 * a class whose whole meaning is "this reaches live production", and it
 * dispatched to the backend with no confirmation demand at all. The class was
 * in the manifest vocabulary, the classifier resolved it correctly, and the
 * audit log recorded PRODUCTION on every call; what was missing was any code
 * path that made the class MEAN something a grant could not quietly undo.
 *
 * So this suite does not test one class. It walks SAFETY_CLASSES, the single
 * runtime source of truth for the vocabulary, and requires every member to
 * declare its enforcement in EXPECTED below. A class added to the vocabulary
 * without a row here fails immediately, and a row that lies about the tier or
 * the standing-authority rule fails against the real predicates. There is no
 * way to add a class and leave its enforcement to a comment.
 *
 * Tiers:
 *  UNGATED  no confirmation (READ only)
 *  TIER_A   gated; a model-supplied confirmed:true authorizes it
 *  TIER_B   gated; confirmed:true is ignored, only out-of-band human approval
 *           authorizes it (gateway.ts dispatchTierB)
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MANIFEST_SAFETY_CLASSES,
  SAFETY_CLASSES,
  ManifestCapabilitySchema,
  decideGate,
  isGatedClass,
  type SafetyClass,
  type SafetyClassification,
} from "../../src/manifest.js";
import {
  ApprovalStore,
  NO_STANDING_GRANT_CLASSES,
  allowsStandingGrant,
  isTierBClass,
  type StandingGrant,
} from "../../src/approvals.js";

type Tier = "UNGATED" | "TIER_A" | "TIER_B";

interface Enforcement {
  tier: Tier;
  /**
   * May a call of this class be authorized by standing authority (a standing
   * per-tool grant, a class grant, or a backend-wide trust wildcard)? false
   * means every call needs its own fresh one-time human approval.
   */
  standingAllowed: boolean;
}

/**
 * The enforcement contract, one row per class.
 *
 * Record<SafetyClass, ...> makes a missing row a compile error for anyone
 * running tsc over the tests; the runtime checks below make it a test failure
 * regardless, because vitest strips types without checking them.
 */
const EXPECTED: Record<SafetyClass, Enforcement> = {
  READ: { tier: "UNGATED", standingAllowed: true },
  WRITE: { tier: "TIER_A", standingAllowed: true },
  SIDE_EFFECT: { tier: "TIER_A", standingAllowed: true },
  UNCLASSIFIED: { tier: "TIER_A", standingAllowed: true },
  HUMAN_OUTBOUND: { tier: "TIER_B", standingAllowed: true },
  VAULT_VALUE: { tier: "TIER_B", standingAllowed: true },
  PRODUCTION: { tier: "TIER_B", standingAllowed: false },
};

function classification(c: SafetyClass): SafetyClassification {
  return {
    safetyClass: c,
    tags: [],
    confirmationMapsToDownstream: false,
    source: c === "UNCLASSIFIED" ? "unclassified" : "manifest",
  };
}

// ─── The coverage gate itself ─────────────────────────────────────────────────

describe("every safety class in the vocabulary declares an enforcement path", () => {
  it("SAFETY_CLASSES has a row in EXPECTED for every member", () => {
    const missing = SAFETY_CLASSES.filter((c) => !(c in EXPECTED));
    expect(
      missing,
      `Safety class(es) ${missing.join(", ")} exist in SAFETY_CLASSES with no enforcement row. ` +
        `Adding a class to the vocabulary is not enough: decide its tier (UNGATED / TIER_A / TIER_B), ` +
        `wire it in manifest.ts isGatedClass and approvals.ts isTierBClass, decide whether standing ` +
        `grants may cover it (NO_STANDING_GRANT_CLASSES), then add the row here.`
    ).toEqual([]);
  });

  it("EXPECTED has no rows for classes that no longer exist", () => {
    const stale = Object.keys(EXPECTED).filter((c) => !SAFETY_CLASSES.includes(c as SafetyClass));
    expect(stale, `stale enforcement row(s): ${stale.join(", ")}`).toEqual([]);
  });

  it("the manifest schema accepts exactly the declarable classes", () => {
    for (const c of MANIFEST_SAFETY_CLASSES) {
      const parsed = ManifestCapabilitySchema.safeParse({ tool: "t", safety_class: c });
      expect(parsed.success, `manifest schema rejects declarable class ${c}`).toBe(true);
    }
    // UNCLASSIFIED is synthetic: the gateway assigns it, a manifest never
    // declares it. A class that becomes declarable must be added to
    // MANIFEST_SAFETY_CLASSES, which is what the schema is built from.
    expect(
      ManifestCapabilitySchema.safeParse({ tool: "t", safety_class: "UNCLASSIFIED" }).success
    ).toBe(false);
    const declarable = new Set<string>(MANIFEST_SAFETY_CLASSES);
    const undeclarable = SAFETY_CLASSES.filter((c) => !declarable.has(c));
    expect(undeclarable).toEqual(["UNCLASSIFIED"]);
  });
});

// ─── Each row is true of the real predicates ──────────────────────────────────

describe.each(SAFETY_CLASSES)("%s enforcement", (c) => {
  const expected = EXPECTED[c as SafetyClass];

  it("isGatedClass matches its tier", () => {
    expect(isGatedClass(c)).toBe(expected.tier !== "UNGATED");
  });

  it("an unconfirmed call is blocked unless the class is UNGATED", () => {
    const decision = decideGate(classification(c), false, "blocking");
    expect(decision.action).toBe(expected.tier === "UNGATED" ? "proceed" : "block");
  });

  it("isTierBClass matches its tier", () => {
    expect(isTierBClass(classification(c))).toBe(expected.tier === "TIER_B");
  });

  it("standing authority matches its row", () => {
    expect(allowsStandingGrant(c)).toBe(expected.standingAllowed);
  });
});

// ─── Cross-cutting invariants ─────────────────────────────────────────────────

describe("enforcement invariants", () => {
  it("READ is the only ungated class", () => {
    const ungated = SAFETY_CLASSES.filter((c) => EXPECTED[c as SafetyClass].tier === "UNGATED");
    expect(ungated).toEqual(["READ"]);
  });

  it("a no-standing class is always Tier-B", () => {
    // Tier-A never consults grants at all (a model self-confirms), so a
    // no-standing Tier-A class would be a rule with nowhere to apply.
    for (const c of NO_STANDING_GRANT_CLASSES) {
      expect(EXPECTED[c].tier, `${c} forbids standing grants but is not Tier-B`).toBe("TIER_B");
    }
  });

  it("NO_STANDING_GRANT_CLASSES and the table agree", () => {
    const fromTable = SAFETY_CLASSES.filter((c) => !EXPECTED[c as SafetyClass].standingAllowed);
    expect([...NO_STANDING_GRANT_CLASSES].sort()).toEqual([...fromTable].sort());
  });

  it("PRODUCTION is at least as strict as SIDE_EFFECT", () => {
    // The regression that started this: PRODUCTION must never be authorized by
    // anything weaker than what a SIDE_EFFECT call needs.
    expect(isGatedClass("PRODUCTION")).toBe(true);
    expect(isTierBClass(classification("PRODUCTION"))).toBe(true);
    expect(isTierBClass(classification("SIDE_EFFECT"))).toBe(false);
    expect(allowsStandingGrant("PRODUCTION")).toBe(false);
    expect(allowsStandingGrant("SIDE_EFFECT")).toBe(true);
  });
});

// ─── The store enforces the standing rule on real grants ──────────────────────

describe("ApprovalStore refuses standing authority for a no-standing class", () => {
  let dir: string;
  let store: ApprovalStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "safety-class-coverage-"));
    store = new ApprovalStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Park + approve through the production path, exactly as a human would. */
  function mint(tool: string, safetyClass: SafetyClass, standing: boolean): StandingGrant {
    const pending = store.createPending({
      identity: "id-1",
      backend: "akamai-go",
      tool,
      argsSummary: "{}",
      safetyClass,
    });
    const approved = store.approve(pending.id, { standing });
    expect(approved).toBeDefined();
    return approved!.grant;
  }

  it("a --always approval of a PRODUCTION tool is recorded one-time, not standing", () => {
    const grant = mint("akamai_go_akamai_raw_request", "PRODUCTION", true);
    expect(grant.oneTime).toBe(true);
  });

  it("a standing grant already on disk does not authorize a PRODUCTION call", () => {
    // The measured incident: a never-expiring standing grant minted on
    // 2026-08-07 that kept authorizing the universal executor forever. Written
    // straight to the store so the test covers grants that predate the rule.
    const legacy: StandingGrant[] = [
      {
        id: "legacy-standing",
        identity: "id-1",
        backend: "akamai-go",
        tool: "akamai_go_akamai_raw_request",
        createdAt: new Date(0).toISOString(),
        oneTime: false,
      },
    ];
    writeFileSync(join(dir, "grants.json"), JSON.stringify(legacy, null, 2), { mode: 0o600 });
    expect(
      store.findAndConsume("id-1", "akamai-go", "akamai_go_akamai_raw_request", "PRODUCTION")
    ).toBeUndefined();
    expect(
      store.findGrant("id-1", "akamai-go", "akamai_go_akamai_raw_request", "PRODUCTION")
    ).toBeUndefined();
    // Still on disk and still inert: the guarantee does not depend on cleanup.
    expect(store.listGrants()).toHaveLength(1);
  });

  it("a backend-wide trust wildcard does not authorize a PRODUCTION call", () => {
    store.createTrustGrant({ identity: "id-1", backend: "akamai-go" });
    expect(
      store.findAndConsume("id-1", "akamai-go", "akamai_go_akamai_raw_request", "PRODUCTION")
    ).toBeUndefined();
  });

  it("a class grant for a no-standing class is refused outright", () => {
    expect(() =>
      store.createClassGrant({ identity: "id-1", backend: "akamai-go", safetyClass: "PRODUCTION" })
    ).toThrow(/not allowed for safety class PRODUCTION/);
  });

  it("a fresh one-time approval DOES authorize exactly one PRODUCTION call", () => {
    mint("akamai_go_akamai_raw_request", "PRODUCTION", false);
    expect(
      store.findAndConsume("id-1", "akamai-go", "akamai_go_akamai_raw_request", "PRODUCTION")
    ).toBeDefined();
    // Consumed: the next call re-parks.
    expect(
      store.findAndConsume("id-1", "akamai-go", "akamai_go_akamai_raw_request", "PRODUCTION")
    ).toBeUndefined();
  });

  it("the rule is class-scoped: a standing HUMAN_OUTBOUND grant still works", () => {
    // TimBot posts to Teams under exactly this shape. Narrowing PRODUCTION must
    // not quietly break the standing grants that are legitimately in use.
    const grant = mint("az_teams_teams_message", "HUMAN_OUTBOUND", true);
    expect(grant.oneTime).toBe(false);
    expect(store.findAndConsume("id-1", "akamai-go", "az_teams_teams_message", "HUMAN_OUTBOUND")).toBeDefined();
    expect(store.findAndConsume("id-1", "akamai-go", "az_teams_teams_message", "HUMAN_OUTBOUND")).toBeDefined();
  });
});
