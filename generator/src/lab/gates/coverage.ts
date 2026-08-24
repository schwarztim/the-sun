/**
 * Gate 8 — Coverage.
 *
 * Pure filesystem check: reads `<serverDir>/coverage.json` (produced by
 * the detection agent — Stage 5) and default-fails on unjustified `null`
 * tool mappings, per the plan's coverage manifest schema:
 *   { basis, coverage_pct, ops: [{ path, method, tool: string|null, justification? }] }
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { CoverageManifest, GateFinding } from "../types.js";

const VALID_BASES = new Set(["spec", "observed", "observed-only"]);

// How many percentage points the manifest's self-reported coverage_pct may
// diverge from the value recomputed from ops[] before the gate fails. Not 0:
// a detection agent may round differently (e.g. 33.3% vs 33%); this still
// catches a materially wrong/fabricated percentage (see runCoverageGate).
const COVERAGE_PCT_TOLERANCE = 1;

export async function runCoverageGate(serverDir: string): Promise<GateFinding> {
  const manifestPath = path.join(serverDir, "coverage.json");
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, "utf-8");
  } catch {
    return {
      gate: "coverage",
      passed: false,
      message: `no coverage.json manifest found at ${manifestPath}`,
    };
  }

  let manifest: CoverageManifest;
  try {
    manifest = JSON.parse(raw) as CoverageManifest;
  } catch (error) {
    return {
      gate: "coverage",
      passed: false,
      message: `coverage.json is not valid JSON: ${(error as Error).message}`,
    };
  }

  const problems: string[] = [];
  if (!VALID_BASES.has(manifest.basis)) {
    problems.push(`unknown basis "${String(manifest.basis)}"`);
  }
  if (typeof manifest.coverage_pct !== "number") {
    problems.push("coverage_pct is not a number");
  }
  if (!Array.isArray(manifest.ops)) {
    problems.push("ops is not an array");
  } else {
    const unjustifiedNulls = manifest.ops.filter(
      (op) =>
        op.tool === null &&
        !(typeof op.justification === "string" && op.justification.trim().length > 0),
    );
    if (unjustifiedNulls.length > 0) {
      problems.push(
        `${unjustifiedNulls.length} op(s) with tool=null and no justification: ${unjustifiedNulls
          .slice(0, 5)
          .map((o) => `${o.method} ${o.path}`)
          .join(", ")}${unjustifiedNulls.length > 5 ? ", ..." : ""}`,
      );
    }

    // Never trust the self-reported coverage_pct at face value -- recompute
    // it from ops[] and fail if the manifest materially disagrees (e.g. a
    // manifest claiming 100% while half its ops map to tool=null).
    if (typeof manifest.coverage_pct === "number") {
      const mapped = manifest.ops.filter((op) => op.tool !== null).length;
      const recomputed = manifest.ops.length === 0 ? 0 : (mapped / manifest.ops.length) * 100;
      const delta = Math.abs(recomputed - manifest.coverage_pct);
      if (delta > COVERAGE_PCT_TOLERANCE) {
        problems.push(
          `coverage_pct (${manifest.coverage_pct}%) disagrees with the value recomputed from ops[] ` +
            `(${recomputed.toFixed(1)}% = ${mapped}/${manifest.ops.length} mapped) by more than ` +
            `${COVERAGE_PCT_TOLERANCE} point(s)`,
        );
      }
    }
  }

  return {
    gate: "coverage",
    passed: problems.length === 0,
    message:
      problems.length === 0
        ? `coverage manifest valid (${manifest.coverage_pct}% coverage, basis=${manifest.basis}, ${manifest.ops.length} op(s))`
        : problems.join("; "),
    detail: manifest,
  };
}
