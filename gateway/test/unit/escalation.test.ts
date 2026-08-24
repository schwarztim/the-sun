import { describe, it, expect } from "vitest";
import {
  compileEscalationPolicy,
  applyEscalation,
  type EscalationConfig,
} from "../../src/escalation.js";
import { isTierBClass } from "../../src/approvals.js";
import type { SafetyClassification } from "../../src/manifest.js";

// Shipped defaults (mirrors config.ts safety.escalation).
const CFG: EscalationConfig = {
  enabled: true,
  delete_method_to_tier_b: true,
  destructive_verbs: [
    "delete", "remove", "purge", "destroy", "drop", "terminate", "kill",
    "revoke", "wipe", "erase", "shutdown", "deprovision", "force",
  ],
  outbound_verbs: ["send", "reply", "email", "notify", "broadcast", "publish", "comment", "message"],
  production_backends: [],
  exempt: [],
};

const policy = (over: Partial<EscalationConfig> = {}) =>
  compileEscalationPolicy({ ...CFG, ...over });

function cls(over: Partial<SafetyClassification>): SafetyClassification {
  return {
    safetyClass: "WRITE",
    tags: [],
    confirmationMapsToDownstream: false,
    source: "name-pattern",
    ...over,
  };
}

const facts = (toolName: string, backendName = "svc") => ({ backendName, toolName });

describe("applyEscalation — monotonic Tier-A → Tier-B overlay", () => {
  it("is a no-op when the policy is disabled", () => {
    const input = cls({ safetyClass: "WRITE", httpMethod: "DELETE" });
    const out = applyEscalation(input, facts("delete_thing"), policy({ enabled: false }));
    expect(out).toBe(input); // unchanged reference
  });

  it("is a no-op when policy is null (registry constructed without escalation)", () => {
    const input = cls({ safetyClass: "WRITE" });
    expect(applyEscalation(input, facts("delete_thing"), null)).toBe(input);
  });

  it("never escalates a READ tool, even with a destructive name or GET delete-lookup", () => {
    const read = cls({ safetyClass: "READ", httpMethod: "GET", source: "manifest" });
    const out = applyEscalation(read, facts("domain_delete_check"), policy());
    expect(out).toBe(read);
    expect(isTierBClass(out)).toBe(false);
  });

  it("leaves an already-Tier-B class untouched (manifest author's explicit call)", () => {
    for (const c of ["PRODUCTION", "VAULT_VALUE", "HUMAN_OUTBOUND"] as const) {
      const tierB = cls({ safetyClass: c, source: "manifest" });
      expect(applyEscalation(tierB, facts("send_email"), policy())).toBe(tierB);
    }
  });

  it("does not clobber an explicit manifest write_guard", () => {
    const guarded = cls({ safetyClass: "WRITE", writeGuard: "twofactor", source: "manifest" });
    const out = applyEscalation(guarded, facts("delete_thing"), policy());
    expect(out).toBe(guarded);
    expect(out.writeGuard).toBe("twofactor");
  });

  it("R1 delete-method: http_method DELETE injects writeGuard policy:delete-method → Tier-B", () => {
    const out = applyEscalation(
      cls({ safetyClass: "WRITE", httpMethod: "DELETE", source: "manifest" }),
      facts("items_delete"),
      policy()
    );
    expect(out.writeGuard).toBe("policy:delete-method");
    expect(out.safetyClass).toBe("WRITE"); // class unchanged; the writeGuard is the Tier-B lever
    expect(isTierBClass(out)).toBe(true);
  });

  it("R2 destructive-verb: a destructive name (no http_method) injects policy:destructive-verb → Tier-B", () => {
    const out = applyEscalation(cls({ safetyClass: "WRITE" }), facts("cache_purge"), policy());
    expect(out.writeGuard).toBe("policy:destructive-verb");
    expect(isTierBClass(out)).toBe(true);
  });

  it("R1 takes precedence over R2 when both match", () => {
    const out = applyEscalation(
      cls({ safetyClass: "WRITE", httpMethod: "DELETE" }),
      facts("thing_delete"),
      policy()
    );
    expect(out.writeGuard).toBe("policy:delete-method");
  });

  it("R3 outbound-verb: rewrites class to HUMAN_OUTBOUND → Tier-B (+ engages PCI/SSN arg guard)", () => {
    const out = applyEscalation(cls({ safetyClass: "WRITE" }), facts("send_message"), policy());
    expect(out.safetyClass).toBe("HUMAN_OUTBOUND");
    expect(isTierBClass(out)).toBe(true);
  });

  it("R4 production-backend: non-READ tools of a matched backend become PRODUCTION → Tier-B", () => {
    const out = applyEscalation(
      cls({ safetyClass: "WRITE" }),
      facts("item_update", "prod-billing"),
      policy({ production_backends: ["prod-*"] })
    );
    expect(out.safetyClass).toBe("PRODUCTION");
    expect(isTierBClass(out)).toBe(true);
  });

  it("outbound precedes production (keeps HUMAN_OUTBOUND so the PCI arg guard still fires)", () => {
    const out = applyEscalation(
      cls({ safetyClass: "WRITE" }),
      facts("notify_customer", "prod-billing"),
      policy({ production_backends: ["prod-*"] })
    );
    expect(out.safetyClass).toBe("HUMAN_OUTBOUND");
  });

  it("benign write (create/update/POST) stays Tier-A — the non-annoying 80%", () => {
    for (const name of ["item_create", "record_update", "widget_add", "config_set"]) {
      const out = applyEscalation(cls({ safetyClass: "WRITE" }), facts(name), policy());
      expect(out.safetyClass).toBe("WRITE");
      expect(out.writeGuard).toBeUndefined();
      expect(isTierBClass(out)).toBe(false);
    }
  });

  it("UNCLASSIFIED with a destructive name escalates to Tier-B", () => {
    const out = applyEscalation(cls({ safetyClass: "UNCLASSIFIED", source: "unclassified" }), facts("wipe_all"), policy());
    expect(out.writeGuard).toBe("policy:destructive-verb");
    expect(isTierBClass(out)).toBe(true);
  });

  it("exempt list opts a specific tool out of escalation (stays Tier-A)", () => {
    const out = applyEscalation(
      cls({ safetyClass: "WRITE", httpMethod: "DELETE" }),
      facts("noop_delete", "svc"),
      policy({ exempt: ["svc.noop_delete"] })
    );
    expect(out.safetyClass).toBe("WRITE");
    expect(out.writeGuard).toBeUndefined();
    expect(isTierBClass(out)).toBe(false);
  });

  it("clearing a verb list disables that rule (operator knob, not a code change)", () => {
    const out = applyEscalation(
      cls({ safetyClass: "WRITE" }),
      facts("thing_delete"),
      policy({ destructive_verbs: [] })
    );
    expect(out.writeGuard).toBeUndefined();
    expect(isTierBClass(out)).toBe(false);
  });

  it("matches verbs only as whole segments, not substrings (no false positive on 'undeletable')", () => {
    const out = applyEscalation(cls({ safetyClass: "WRITE" }), facts("mark_undeletable"), policy());
    expect(out.writeGuard).toBeUndefined();
    expect(out.safetyClass).toBe("WRITE");
  });
});
