import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { SafetyClass, SafetyClassification } from "./manifest.js";

/**
 * Policy snapshot writer (Phase 1b — the client hook layer's single source of
 * truth).
 *
 * The universal client-side hook (packaging/hooks/) must NOT re-implement
 * classification. Instead the gateway writes this snapshot into THESUN_HOME on
 * startup and on every config reload: a flat map of gateway tool name →
 * {tier, class, rule?}, derived from the EXACT classify + escalation pipeline
 * that gates dispatch (manifest.ts classify() → escalation.ts applyEscalation()).
 * The hook reads the snapshot locally — no network on the hot path, deterministic,
 * and structurally incapable of disagreeing with the gateway about what is
 * dangerous.
 *
 * This module owns ONLY the pure snapshot shape + an atomic writer. It performs
 * no classification itself; the caller (gateway.ts, wired separately) walks its
 * already-classified ManifestRegistry and hands the classifications here. It is
 * intentionally decoupled from approvals.ts / manifest.ts internals: it imports
 * only the SafetyClass/SafetyClassification *types* and never touches the store
 * or the dispatch path.
 */

// ─── Snapshot shape (mirrored, as plain JSON, in packaging/hooks/core.mjs) ─────

/** Tier-A = model-self-confirmable (the hook human-gates it); Tier-B = gateway park. */
export type PolicyTier = "A" | "B";

export interface PolicySnapshotTool {
  /** Friction tier: "A" (self-confirm, hook-gated) or "B" (gateway out-of-band park). */
  tier: PolicyTier;
  /** The resolved safety class after escalation (READ never appears — see build()). */
  class: SafetyClass;
  /**
   * The escalation rule that produced a Tier-B writeGuard, when applicable
   * (e.g. "policy:delete-method"). Absent for manifest-declared Tier-B classes
   * and for plain Tier-A tools.
   */
  rule?: string;
}

export interface PolicySnapshot {
  /** Snapshot schema version — bump on any shape change the hook must know about. */
  version: 1;
  /**
   * gateway tool name (the namespacedName exposed to clients, i.e. the `<tool>`
   * segment of `mcp__mcp-gateway__<tool>`) → policy entry. READ / unclassified-safe
   * tools are omitted entirely: the hook treats an unlisted tool as a silent pass,
   * so the snapshot only needs to carry the gated (Tier-A + Tier-B) surface.
   */
  tools: Record<string, PolicySnapshotTool>;
  /**
   * The gateway's own base URL (e.g. "http://127.0.0.1:3100/mcp"), when known.
   * The client hook uses it to reach the gateway's loopback admin routes — today
   * the shift-left dep-scan endpoint (POST <gatewayUrl base>/dep-scan). Absent
   * when the gateway URL is not resolvable; the hook then skips those checks
   * (fail-open) unless THESUN_DEPSCAN_URL is set in the hook's environment.
   */
  gatewayUrl?: string;
}

/** Optional snapshot-wide fields the builder/writer can stamp. */
export interface PolicySnapshotOpts {
  gatewayUrl?: string;
}

/** One (tool, classification) pair the caller feeds the builder. */
export interface PolicySnapshotInput {
  /** The gateway namespacedName exposed to clients (the snapshot key). */
  tool: string;
  classification: SafetyClassification | undefined;
}

// ─── Tier derivation (mirrors approvals.ts isTierBClass — deliberately duplicated) ─

/**
 * Tier for the snapshot. Mirrors approvals.ts isTierBClass so the hook and the
 * gateway agree byte-for-byte on what is Tier-B: PRODUCTION / VAULT_VALUE /
 * HUMAN_OUTBOUND, or any non-empty writeGuard, are Tier-B; every other gated
 * class is Tier-A. Duplicated (not imported) to keep this module free of any
 * dependency on the store module owned elsewhere.
 */
export function snapshotTier(safety: SafetyClassification): PolicyTier {
  if (
    safety.safetyClass === "PRODUCTION" ||
    safety.safetyClass === "VAULT_VALUE" ||
    safety.safetyClass === "HUMAN_OUTBOUND"
  ) {
    return "B";
  }
  return safety.writeGuard ? "B" : "A";
}

// ─── Build ─────────────────────────────────────────────────────────────────────

/**
 * Build the snapshot from already-classified tools. READ tools (the friction-free
 * 80%) are dropped — the hook passes anything unlisted through silently, so
 * carrying them would only bloat the file and slow the hook's lookup. Tools with
 * no classification (undefined) are likewise omitted: the gateway proceeds on
 * them (decideGate returns proceed for undefined), so the hook must too.
 */
export function buildPolicySnapshot(
  inputs: PolicySnapshotInput[],
  opts: PolicySnapshotOpts = {}
): PolicySnapshot {
  const tools: Record<string, PolicySnapshotTool> = {};
  for (const { tool, classification } of inputs) {
    if (!classification) continue;
    if (classification.safetyClass === "READ") continue;
    const entry: PolicySnapshotTool = {
      tier: snapshotTier(classification),
      class: classification.safetyClass,
    };
    if (classification.writeGuard && classification.writeGuard.startsWith("policy:")) {
      entry.rule = classification.writeGuard;
    }
    tools[tool] = entry;
  }
  const snapshot: PolicySnapshot = { version: 1, tools };
  if (opts.gatewayUrl) snapshot.gatewayUrl = opts.gatewayUrl;
  return snapshot;
}

// ─── Write (atomic; mirrors approvals.ts persistence: 0700 dir, 0600 file) ──────

/** Canonical snapshot filename inside THESUN_HOME. */
export const POLICY_SNAPSHOT_FILENAME = "policy-snapshot.json";

/**
 * Write the snapshot atomically (tmp + rename) into `dir` (THESUN_HOME) and
 * return the full path written. Same file discipline as the approval store:
 * 0700 directory, 0600 file, crash-safe rename. Accepts either the already-built
 * PolicySnapshot or the raw inputs (built here) so callers can use whichever is
 * handier.
 */
export function writePolicySnapshot(
  entries: PolicySnapshot | PolicySnapshotInput[],
  dir: string,
  opts: PolicySnapshotOpts = {}
): string {
  const snapshot = Array.isArray(entries) ? buildPolicySnapshot(entries, opts) : entries;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, POLICY_SNAPSHOT_FILENAME);
  const tmp = `${path}.tmp-${randomUUID()}`;
  writeFileSync(tmp, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
  return path;
}
