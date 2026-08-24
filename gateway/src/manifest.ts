import { z } from "zod";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import type { Logger } from "./logger.js";
import {
  applyEscalation,
  compileEscalationPolicy,
  type EscalationConfig,
  type EscalationPolicy,
} from "./escalation.js";

// ─── Safety classification types ──────────────────────────────────────────────

/**
 * Every safety class a manifest author may DECLARE, and the single runtime
 * source of truth for that vocabulary: the zod enum below and SAFETY_CLASSES
 * both derive from this array, so the declarable set cannot drift from the type.
 */
export const MANIFEST_SAFETY_CLASSES = [
  "READ",
  "WRITE",
  "SIDE_EFFECT",
  "HUMAN_OUTBOUND",
  "PRODUCTION",
  "VAULT_VALUE",
] as const;

/**
 * The gateway's COMPLETE safety-class vocabulary: the declarable classes plus
 * UNCLASSIFIED, which is synthetic (assigned to a tool with no manifest entry
 * and no write-verb match, so it is never written in a manifest file).
 *
 * test/unit/safety-class-coverage.test.ts walks this array and requires every
 * member to have a declared enforcement path. Adding a class here without
 * wiring its enforcement fails that test by construction, which is the point:
 * PRODUCTION was already in the manifest vocabulary while the only thing
 * telling operators to treat it as production was a YAML comment.
 */
export const SAFETY_CLASSES = [...MANIFEST_SAFETY_CLASSES, "UNCLASSIFIED"] as const;

export type SafetyClass = (typeof SAFETY_CLASSES)[number];

export interface SafetyClassification {
  safetyClass: SafetyClass;
  tags: string[];
  writeGuard?: string;
  confirmationMapsToDownstream: boolean;
  locality?: string;
  source: "manifest" | "name-pattern" | "unclassified";
  /**
   * HTTP method backing this tool, when known from a manifest capability. Carried
   * through so the escalation overlay (escalation.ts) can route DELETE-backed
   * tools to Tier-B. Absent for name-pattern / unclassified tools (no manifest).
   */
  httpMethod?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /**
   * Name of the single argument that selects the operation on an
   * action-multiplexed tool, copied verbatim from the manifest capability.
   * Present only when that capability also declares readActions.
   */
  actionParam?: string;
  /**
   * Action values that make ONE CALL read-safe on an otherwise gated tool.
   * Consumed by refineForArgs at dispatch time; see its doc comment for why
   * this is sound only for a closed enum.
   */
  readActions?: readonly string[];
}

// ─── Manifest file format (isaac-router-manifest/v1) ─────────────────────────

export const ManifestCapabilitySchema = z.object({
  tool: z.string(),
  safety_class: z.enum(MANIFEST_SAFETY_CLASSES),
  locality: z.string().optional(),
  tags: z.array(z.string()).default([]),
  write_guard: z.string().optional(),
  confirmation_maps_to_downstream: z.boolean().default(false),
  /**
   * Optional HTTP method backing this capability. When present, it takes
   * priority over the WRITE_VERB_REGEX name heuristic in
   * validateManifestSemantics — a GET-backed tool is legitimately READ even
   * if its name contains a write-verb segment (e.g. "shodan_dns_resolve").
   * Non-GET methods do not get this exemption; the name heuristic still
   * applies to them.
   */
  http_method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
  /**
   * Name of the argument that selects the operation on an action-multiplexed
   * tool (an orchestrator's tools all call it "action"; another backend may not). The
   * gateway NEVER infers this: a manifest author who wants the carve-out below
   * must name the parameter they actually audited. Required whenever
   * read_actions is non-empty (ACTION_PARAM_MISSING).
   */
  action_param: z.string().optional(),
  /**
   * Per-action READ carve-out for an action-multiplexed tool: when the call's
   * `action_param` argument is one of these values, THAT CALL classifies READ
   * instead of safety_class. Every other value, and any call the gateway cannot
   * read the argument from, keeps safety_class (fail closed).
   *
   * ONLY SOUND FOR A CLOSED ENUM. The mechanism exists because a tool like
   * orchestrator_memory multiplexes 19 named operations behind one MCP tool, so its
   * declared class is pinned to the most dangerous one and every read pays a
   * confirmation. It is NOT a general argument-conditional escape hatch, and it
   * must NEVER be applied to an open-ended executor: akamai_raw_request
   * dispatches any of 1145 catalogued operations by name (blast radius = the
   * whole Akamai API, including live CDN activation), so the set of values its
   * argument can take is neither closed nor auditable, and it stays PRODUCTION
   * with no carve-outs. Two structural guards enforce that shape: a capability
   * whose class is Tier-B (PRODUCTION / VAULT_VALUE / HUMAN_OUTBOUND) or that
   * declares a write_guard may not declare read_actions at all
   * (ACTION_READ_ON_TIER_B, rejected at load), and refineForArgs refuses the
   * same cases again at dispatch.
   *
   * Before adding a value here, read what that action DOES. A read left gated
   * is an annoyance; a write that stopped asking is an incident.
   */
  read_actions: z.array(z.string()).default([]),
});

export const ManifestFileSchema = z.object({
  manifest: z.literal("isaac-router-manifest/v1"),
  backend: z.string(),
  capabilities: z.array(ManifestCapabilitySchema),
});

type ManifestCapability = z.infer<typeof ManifestCapabilitySchema>;
export type ManifestFile = z.infer<typeof ManifestFileSchema>;

// ─── Verb-set regex (fail-closed: unclassified write-like names → WRITE) ──────

/**
 * Write/destructive verb segments. A tool whose originalName or namespacedName
 * contains one of these verbs as a word segment (preceded by start-of-string or
 * `_`, and followed by `_` or end-of-string) defaults to WRITE when not
 * explicitly classified in a manifest.
 *
 * Exported so contract audits and tests can reuse the same regex.
 */
export const WRITE_VERB_REGEX =
  /(?:^|_)(?:create|update|delete|send|reply|upload|move|copy|archive|set|add|remove|patch|post|purge|execute|run|trigger|invoke|revoke|approve|merge|deploy|restart|kill|terminate|publish|assign|transition|resolve|close|escalate)(?:_|$)/i;

// ─── Gate decision helper ─────────────────────────────────────────────────────

export type GateDecision =
  | { action: "proceed" }
  | { action: "warn"; safetyClass: SafetyClass; source: "manifest" | "name-pattern" | "unclassified" }
  | { action: "block"; safetyClass: SafetyClass; source: "manifest" | "name-pattern" | "unclassified" };

/**
 * Pure function: given a safety classification, confirmed flag, and enforce
 * mode, decide what the gate should do. Extracted for unit testing.
 *
 * UNCLASSIFIED is gated (fail-closed inversion, 2026-06-10): a tool the
 * gateway cannot classify is treated like a write until a manifest says
 * otherwise. Backends staged for manifest burn-down can opt back into the
 * legacy READ default via safety.unmanifested_read_allowlist, which is
 * applied at classification time (ManifestRegistry.classify), not here.
 *
 * A non-empty write_guard on the manifest entry forces gating regardless of
 * safety class — the manifest author's explicit guard intent wins even on a
 * READ-classed tool.
 */
export function decideGate(
  safety: SafetyClassification | undefined,
  confirmed: boolean,
  enforce: "advisory" | "blocking"
): GateDecision {
  if (!safety) {
    return { action: "proceed" };
  }
  const gated = isGatedClass(safety.safetyClass) || Boolean(safety.writeGuard);
  if (!gated) {
    return { action: "proceed" };
  }
  if (confirmed) {
    return { action: "proceed" };
  }
  if (enforce === "advisory") {
    return { action: "warn", safetyClass: safety.safetyClass, source: safety.source };
  }
  return { action: "block", safetyClass: safety.safetyClass, source: safety.source };
}

// ─── Gated-class predicate ────────────────────────────────────────────────────

/** Returns true for every safety class that requires confirmation (i.e., not READ). */
export function isGatedClass(c: SafetyClass): boolean {
  return c !== "READ";
}

// ─── Per-action refinement (closed-enum multiplexed tools only) ───────────────

/**
 * Refine a tool's STATIC classification for ONE call, using the single
 * closed-enum argument its manifest capability named in `action_param`.
 *
 * Why this exists: an action-multiplexed tool (orchestrator_memory has 19 actions,
 * orchestrator_job 21) can only be classified as a whole, so its class is pinned to
 * the most dangerous action it can reach and every read pays a confirmation.
 * An operator asking the orchestrator for a job's status was challenged twice for a
 * pure read; that is what this fixes.
 *
 * Why it is not a general escape hatch: it is sound only because those actions
 * come from a KNOWN, FINITE enum whose members can each be read and audited
 * one at a time. It must never be applied to an open-ended executor that
 * dispatches an arbitrary named operation (akamai_raw_request reaches 1145 of
 * them, including live CDN activation) — there is no finite set to audit
 * there, so the tool's own class is the only honest answer. read_actions on a
 * Tier-B capability is rejected at manifest load (ACTION_READ_ON_TIER_B) and
 * refused again below, so no manifest edit can open that door.
 *
 * FAIL CLOSED, in every branch: the declared class is returned unchanged
 * unless the capability came from a manifest, declares both a parameter name
 * and a non-empty read-action list, is not Tier-B, and the call's arguments
 * carry that parameter as a string that is EXACTLY one of the declared values.
 * Absent, non-string, unknown, differently-cased, or unreadable arguments all
 * keep the base class. The only rewrite this function can perform is one
 * class → READ; it can never raise privilege in the other direction, and a
 * caller passing a write action keeps the write class.
 *
 * Pure: returns the same object when nothing applies, a shallow copy tagged
 * `action-read:<value>` when the carve-out fires.
 */
export function refineForArgs(
  safety: SafetyClassification | undefined,
  args: unknown
): SafetyClassification | undefined {
  if (!safety) return safety;

  // Only a manifest author can declare a carve-out; name-pattern and
  // unclassified fallbacks never carry one.
  if (safety.source !== "manifest") return safety;

  const param = safety.actionParam;
  const reads = safety.readActions;
  if (typeof param !== "string" || param.trim() === "") return safety;
  if (!Array.isArray(reads) || reads.length === 0) return safety;

  // Nothing to lower, and nothing that MAY be lowered. The Tier-B test mirrors
  // approvals.ts isTierBClass (duplicated deliberately, as policy-snapshot.ts
  // does, to keep this module dependency-free): a class or write_guard that
  // routes to out-of-band human approval is never downgraded by an argument,
  // including one the escalation overlay promoted after the manifest was read.
  if (safety.safetyClass === "READ") return safety;
  if (
    safety.safetyClass === "PRODUCTION" ||
    safety.safetyClass === "VAULT_VALUE" ||
    safety.safetyClass === "HUMAN_OUTBOUND" ||
    Boolean(safety.writeGuard)
  ) {
    return safety;
  }

  if (typeof args !== "object" || args === null || Array.isArray(args)) return safety;
  // OWN property only: an inherited one is not an argument the caller sent.
  if (!Object.prototype.hasOwnProperty.call(args, param)) return safety;
  const value = (args as Record<string, unknown>)[param];
  if (typeof value !== "string") return safety;
  if (!reads.includes(value)) return safety;

  return {
    ...safety,
    safetyClass: "READ",
    tags: [...safety.tags, `action-read:${value}`],
  };
}

// ─── Semantic manifest validation ─────────────────────────────────────────────

export interface ManifestSemanticViolation {
  tool?: string;
  rule: string;
  detail: string;
}

/**
 * Per-manifest semantic checks, shared by the offline contract audit
 * (scripts/audit-contracts.ts) and the load-time gate (ManifestRegistry.loadDir).
 * A manifest that fails any of these is LYING about safety — its labels must
 * not be honored. Single source of truth for both consumers.
 *
 *  RISKY_AS_READ      — a tool whose name matches WRITE_VERB_REGEX may not be
 *                       classified READ (write-verb tool mislabeled read-safe),
 *                       UNLESS the capability declares http_method: "GET" —
 *                       an HTTP GET is legitimately read-safe regardless of
 *                       what the tool's name looks like (e.g.
 *                       "shodan_dns_resolve" contains the write-verb segment
 *                       "resolve" but is a GET lookup). A capability with a
 *                       non-GET http_method (or none declared) still gets the
 *                       full name-heuristic check.
 *  WRITE_GUARD_EMPTY  — a declared write_guard must be non-empty.
 *  DUPLICATE_TOOL     — a tool name may not appear twice in one backend.
 *  ACTION_PARAM_MISSING  — read_actions without action_param: the gateway
 *                       never guesses which argument to inspect, so the
 *                       carve-out would silently never fire (or, worse, fire
 *                       on a parameter nobody audited).
 *  ACTION_READ_BLANK  — a blank read-action value would carve out an empty
 *                       string, which no closed enum contains.
 *  ACTION_READ_ON_TIER_B — read_actions on a PRODUCTION / VAULT_VALUE /
 *                       HUMAN_OUTBOUND capability, or on one with a
 *                       write_guard. This is the structural guarantee that the
 *                       mechanism cannot be pointed at an open-ended executor
 *                       (see read_actions in ManifestCapabilitySchema): those
 *                       tools require out-of-band human approval, and no
 *                       argument may buy a way past it.
 */
export function validateManifestSemantics(
  manifest: ManifestFile
): ManifestSemanticViolation[] {
  const violations: ManifestSemanticViolation[] = [];
  const toolsSeen = new Set<string>();

  for (const cap of manifest.capabilities) {
    const { tool, safety_class, write_guard, http_method, action_param, read_actions } = cap;

    if (write_guard !== undefined && write_guard.trim() === "") {
      violations.push({
        tool,
        rule: "WRITE_GUARD_EMPTY",
        detail: `Capability "${tool}" (${safety_class}) declares write_guard but the value is empty`,
      });
    }

    if (read_actions.length > 0) {
      if (action_param === undefined || action_param.trim() === "") {
        violations.push({
          tool,
          rule: "ACTION_PARAM_MISSING",
          detail: `Capability "${tool}" declares read_actions but no action_param naming the argument to inspect`,
        });
      }
      if (read_actions.some((a) => a.trim() === "")) {
        violations.push({
          tool,
          rule: "ACTION_READ_BLANK",
          detail: `Capability "${tool}" declares a blank read_actions value`,
        });
      }
      const tierB =
        safety_class === "PRODUCTION" ||
        safety_class === "VAULT_VALUE" ||
        safety_class === "HUMAN_OUTBOUND" ||
        (write_guard !== undefined && write_guard.trim() !== "");
      if (tierB) {
        violations.push({
          tool,
          rule: "ACTION_READ_ON_TIER_B",
          detail: `Capability "${tool}" (${safety_class}) requires out-of-band approval; a per-action READ carve-out may not be declared on it`,
        });
      }
    }

    const isGetBacked = http_method === "GET";
    if (safety_class === "READ" && WRITE_VERB_REGEX.test(tool) && !isGetBacked) {
      violations.push({
        tool,
        rule: "RISKY_AS_READ",
        detail: `Tool "${tool}" contains a write verb but is classified READ — likely mislabeled`,
      });
    }

    if (toolsSeen.has(tool)) {
      violations.push({
        tool,
        rule: "DUPLICATE_TOOL",
        detail: `Tool "${tool}" appears more than once in backend "${manifest.backend}"`,
      });
    } else {
      toolsSeen.add(tool);
    }
  }

  return violations;
}

// ─── Manifest registry ────────────────────────────────────────────────────────

export class ManifestRegistry {
  private logger: Logger;
  /** Map from backend name → tool name → capability entry */
  private index = new Map<string, Map<string, ManifestCapability>>();
  /** Backends opted back into the legacy READ default for unmanifested verb-less tools. */
  private unmanifestedReadAllowlist: Set<string>;
  /** Compiled default-conservative escalation policy, or null when disabled/absent. */
  private escalationPolicy: EscalationPolicy | null;
  /** Resolved manifests directory, retained so reload() can re-read it. */
  private manifestDir: string;

  constructor(
    logger: Logger,
    manifestDir?: string,
    options?: { unmanifestedReadAllowlist?: string[]; escalation?: EscalationConfig }
  ) {
    this.logger = logger;
    this.unmanifestedReadAllowlist = new Set(options?.unmanifestedReadAllowlist ?? []);
    this.escalationPolicy = options?.escalation
      ? compileEscalationPolicy(options.escalation)
      : null;
    this.manifestDir = manifestDir
      ? resolve(manifestDir)
      : resolve(process.cwd(), "manifests");

    this.loadDir(this.manifestDir);
  }

  /** The resolved manifests directory (so the gateway can watch it for edits). */
  getManifestDir(): string {
    return this.manifestDir;
  }

  /**
   * Constructor/startup load: tolerate a missing directory (expected on first
   * boot) and skip individual malformed manifests so one bad file never breaks
   * startup.
   */
  private loadDir(dir: string): void {
    try {
      this.readManifestsInto(this.index, dir, /* strict */ false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Missing manifests dir is expected on first boot — log info, not warn.
      this.logger.info(`ManifestRegistry: manifests directory not found or unreadable (${dir}): ${msg}. All tools will fall back to name-pattern classification.`);
    }
  }

  /**
   * Hot-reload all manifests from disk WITHOUT a gateway restart, so an edited
   * or newly added safety manifest takes effect on the next reload.
   *
   * Fail-safe: manifests are read into a FRESH index and only swapped in on a
   * clean read. If the directory is unreadable OR any manifest fails to parse
   * (strict mode), the prior good index is kept and the error is logged; a bad
   * manifest on reload never throws into the reload path and never crashes the
   * gateway. Semantically-invalid manifests (labels that lie) are still skipped
   * fail-closed, exactly as at startup.
   */
  reload(): void {
    const fresh = new Map<string, Map<string, ManifestCapability>>();
    try {
      this.readManifestsInto(fresh, this.manifestDir, /* strict */ true);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `ManifestRegistry.reload: keeping prior manifests, reload failed (${msg})`
      );
      return;
    }
    this.index = fresh;
    this.logger.info(
      `ManifestRegistry: reloaded manifests from ${this.manifestDir} (${fresh.size} backend(s))`
    );
  }

  /**
   * Read + validate every *.json manifest in `dir` into `target`.
   *
   * A missing/unreadable directory throws (the caller decides how to handle).
   * Per-file PARSE errors (bad JSON / schema): skipped in non-strict mode (a
   * single bad file must not break startup); rethrown in strict mode so the
   * reload caller keeps the prior good index instead of swapping in a partial
   * one. SEMANTIC violations (a manifest whose labels lie) always skip that
   * backend fail-closed in both modes.
   */
  private readManifestsInto(
    target: Map<string, Map<string, ManifestCapability>>,
    dir: string,
    strict: boolean
  ): void {
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));

    this.logger.info(`ManifestRegistry: loading ${files.length} manifest file(s) from ${dir}`);

    for (const file of files) {
      const filePath = join(dir, file);
      let manifest: ManifestFile;
      try {
        const raw = readFileSync(filePath, "utf-8");
        const parsed: unknown = JSON.parse(raw);
        manifest = ManifestFileSchema.parse(parsed);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (strict) {
          // Reload: abort the swap so the prior good index is retained.
          throw new Error(`malformed manifest ${filePath}: ${msg}`);
        }
        // Startup: one bad manifest must not break boot.
        this.logger.warn(`ManifestRegistry: skipping malformed manifest ${filePath}: ${msg}`);
        continue;
      }

      // Load-time semantic gate (2026-06-10): a manifest that mislabels a
      // write-verb tool as READ (or otherwise fails semantic checks) is
      // REJECTED — honoring its labels would launder destructive tools past
      // the gate. Rejection is fail-closed: the backend's tools fall back to
      // classification without a manifest, which gates them (UNCLASSIFIED).
      const semanticViolations = validateManifestSemantics(manifest);
      if (semanticViolations.length > 0) {
        for (const v of semanticViolations) {
          this.logger.error(
            `ManifestRegistry: REJECTED manifest ${filePath} [${v.rule}] ${v.tool ?? ""}: ${v.detail}`
          );
        }
        this.logger.error(
          `ManifestRegistry: backend "${manifest.backend}" labels ignored (${semanticViolations.length} semantic violation(s)) — its tools fall back to fail-closed classification. Run \`npm run audit:contracts\` and fix the manifest.`
        );
        continue;
      }

      this.indexManifestInto(target, manifest);
      this.logger.info(`ManifestRegistry: loaded manifest for backend "${manifest.backend}" (${manifest.capabilities.length} capabilities)`);
    }
  }

  private indexManifestInto(
    target: Map<string, Map<string, ManifestCapability>>,
    manifest: ManifestFile
  ): void {
    let backendMap = target.get(manifest.backend);
    if (!backendMap) {
      backendMap = new Map<string, ManifestCapability>();
      target.set(manifest.backend, backendMap);
    }
    for (const cap of manifest.capabilities) {
      backendMap.set(cap.tool, cap);
    }
  }

  /**
   * Classify a tool by backend name + original tool name.
   *
   * Priority:
   *  1. Manifest entry (source: "manifest") — exact match on backendName + originalName.
   *  2. Graduated fallback for tools with no manifest entry:
   *     - If originalName or namespacedName contains a write verb → WRITE
   *       (source: "name-pattern", fail-closed).
   *     - Otherwise → UNCLASSIFIED (source: "unclassified"), which is GATED
   *       (fail-closed inversion, 2026-06-10). A backend listed in
   *       safety.unmanifested_read_allowlist keeps the legacy READ default
   *       during manifest burn-down — explicit, per-backend, visible in the
   *       decision log via the allowlist tag.
   */
  classify(
    backendName: string,
    originalName: string,
    namespacedName: string
  ): SafetyClassification {
    const base = this.classifyBase(backendName, originalName, namespacedName);
    return applyEscalation(
      base,
      { backendName, toolName: originalName },
      this.escalationPolicy
    );
  }

  /**
   * Base classification (manifest → name-pattern → UNCLASSIFIED), before the
   * default-conservative escalation overlay is applied by classify(). Kept
   * separate so the overlay (escalation.ts) is a single, unit-testable seam.
   */
  private classifyBase(
    backendName: string,
    originalName: string,
    namespacedName: string
  ): SafetyClassification {
    const backendMap = this.index.get(backendName);
    if (backendMap) {
      const cap = backendMap.get(originalName);
      if (cap) {
        return {
          safetyClass: cap.safety_class as SafetyClass,
          tags: cap.tags,
          writeGuard: cap.write_guard,
          confirmationMapsToDownstream: cap.confirmation_maps_to_downstream,
          locality: cap.locality,
          source: "manifest",
          httpMethod: cap.http_method,
          // Only carried when the capability actually declares a carve-out;
          // load-time validation guarantees action_param is present with it.
          ...(cap.read_actions.length > 0
            ? { actionParam: cap.action_param, readActions: cap.read_actions }
            : {}),
        };
      }
    }

    // Name-pattern fallback (fail-closed: missing coverage → WRITE if verb matches)
    const isWrite =
      WRITE_VERB_REGEX.test(originalName) || WRITE_VERB_REGEX.test(namespacedName);

    if (isWrite) {
      return {
        safetyClass: "WRITE",
        tags: [],
        confirmationMapsToDownstream: false,
        source: "name-pattern",
      };
    }

    // Verb-less and unmanifested. Allowlisted backends keep the legacy READ
    // default during burn-down; everything else is UNCLASSIFIED and gated.
    if (this.unmanifestedReadAllowlist.has(backendName)) {
      return {
        safetyClass: "READ",
        tags: ["unmanifested-read-allowlist"],
        confirmationMapsToDownstream: false,
        source: "unclassified",
      };
    }

    return {
      safetyClass: "UNCLASSIFIED",
      tags: [],
      confirmationMapsToDownstream: false,
      source: "unclassified",
    };
  }
}
