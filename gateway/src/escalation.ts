import type { SafetyClassification } from "./manifest.js";

// ─── Escalation policy overlay (facts → friction tier) ────────────────────────
//
// The generator emits only READ | WRITE safety classes (derived from GET/HEAD vs
// everything else). It never emits PRODUCTION / VAULT_VALUE / HUMAN_OUTBOUND or a
// write_guard — so, without this overlay, every generated mutating tool lands in
// Tier-A (the model-self-confirmable gate), and the Tier-B out-of-band-approval
// machinery — the only control that holds against a full-auto, hook-less client —
// protects zero generated tools.
//
// This overlay closes that gap at the Policy Enforcement Point: manifests declare
// facts (safety class, tool name, http method), the gateway declares POLICY. When
// a rule matches, the overlay escalates a Tier-A classification into Tier-B, using
// the two existing Tier-B levers and NOTHING else:
//   - rewrite the safety class to HUMAN_OUTBOUND / PRODUCTION (both Tier-B by
//     class via isTierBClass), or
//   - inject a synthetic writeGuard value ("policy:<rule>") — isTierBClass returns
//     true for any non-empty writeGuard, so the tool routes through the existing
//     dispatchTierB path with zero changes to approvals.ts / decideGate.
//
// The overlay is strictly MONOTONIC: it only ever escalates Tier-A
// (WRITE / SIDE_EFFECT / UNCLASSIFIED, with no writeGuard) up to Tier-B. It never
// touches READ (a read-safe tool stays friction-free) and never overrides an
// already-Tier-B classification the manifest author declared explicitly.

/** Operator-tunable escalation policy (mirrors config.ts safety.escalation). */
export interface EscalationConfig {
  enabled: boolean;
  delete_method_to_tier_b: boolean;
  destructive_verbs: string[];
  outbound_verbs: string[];
  production_backends: string[];
  exempt: string[];
}

/** Compiled, ready-to-evaluate form of an EscalationConfig. */
export interface EscalationPolicy {
  enabled: boolean;
  deleteMethod: boolean;
  destructiveRe: RegExp | null;
  outboundRe: RegExp | null;
  productionGlobs: RegExp[];
  exempt: Set<string>;
}

/** Facts about the tool being classified, used to evaluate the rules. */
export interface EscalationFacts {
  backendName: string;
  /** The tool's ORIGINAL (un-namespaced) name — the semantic verb signal. */
  toolName: string;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a word-segment verb regex from a list of verbs, matching the same
 * segment convention as manifest.ts's WRITE_VERB_REGEX: a verb bounded by
 * start-of-string or `_` and by `_` or end-of-string. An empty list yields null
 * (matches nothing) so an operator can disable a rule by clearing its list.
 */
function verbRegex(verbs: string[]): RegExp | null {
  const cleaned = verbs.map((v) => v.trim().toLowerCase()).filter(Boolean);
  if (cleaned.length === 0) return null;
  const alt = cleaned.map(escapeRegex).join("|");
  return new RegExp(`(?:^|_)(?:${alt})(?:_|$)`, "i");
}

/** Convert a simple backend glob (`prod-*`, `*-prod`, exact) into an anchored regex. */
function globRegex(glob: string): RegExp {
  const esc = glob.trim().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${esc}$`, "i");
}

export function compileEscalationPolicy(cfg: EscalationConfig): EscalationPolicy {
  return {
    enabled: cfg.enabled,
    deleteMethod: cfg.delete_method_to_tier_b,
    destructiveRe: verbRegex(cfg.destructive_verbs),
    outboundRe: verbRegex(cfg.outbound_verbs),
    productionGlobs: cfg.production_backends
      .map((g) => g.trim())
      .filter(Boolean)
      .map(globRegex),
    exempt: new Set(cfg.exempt.map((e) => e.trim()).filter(Boolean)),
  };
}

/**
 * Apply the escalation policy to a base classification. Pure and monotonic:
 * READ and already-Tier-B classifications pass through unchanged; only Tier-A
 * (WRITE / SIDE_EFFECT / UNCLASSIFIED without a writeGuard) is a candidate for
 * escalation. Rule precedence (first match wins): exempt → outbound-verb →
 * production-backend → delete-method → destructive-verb. Outbound precedes
 * production so an outbound tool on a production backend keeps HUMAN_OUTBOUND
 * (which additionally engages the content-guard PCI/SSN arg block), rather than
 * being flattened to PRODUCTION.
 */
export function applyEscalation(
  cls: SafetyClassification,
  facts: EscalationFacts,
  policy: EscalationPolicy | null
): SafetyClassification {
  if (!policy || !policy.enabled) return cls;

  const c = cls.safetyClass;
  // READ stays friction-free; already-Tier-B (by class or explicit guard) is the
  // manifest author's deliberate call and is left untouched.
  if (c === "READ" || c === "PRODUCTION" || c === "VAULT_VALUE" || c === "HUMAN_OUTBOUND") {
    return cls;
  }
  if (cls.writeGuard) return cls;

  // Operator opt-out for a specific tool that the heuristics misclassify.
  if (policy.exempt.has(`${facts.backendName}.${facts.toolName}`)) return cls;

  // c ∈ { WRITE, SIDE_EFFECT, UNCLASSIFIED } with no writeGuard — a Tier-A tool.
  if (policy.outboundRe && policy.outboundRe.test(facts.toolName)) {
    return { ...cls, safetyClass: "HUMAN_OUTBOUND" };
  }
  if (policy.productionGlobs.some((re) => re.test(facts.backendName))) {
    return { ...cls, safetyClass: "PRODUCTION" };
  }
  if (policy.deleteMethod && cls.httpMethod === "DELETE") {
    return { ...cls, writeGuard: "policy:delete-method" };
  }
  if (policy.destructiveRe && policy.destructiveRe.test(facts.toolName)) {
    return { ...cls, writeGuard: "policy:destructive-verb" };
  }
  return cls;
}
