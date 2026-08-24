/**
 * policy.ts — turn per-package scan results into a decision.
 *
 *   VETO  iff (bad-name / typosquat) OR (vulnerable AND (has safeVersion OR DEP_SCAN_ENFORCE=1))
 *   WARN  if vulnerable with no fix available (soft — a warn can never block)
 *   null  otherwise (clean / unknown / not-checked)
 *
 * DEP_SCAN_DISABLE=1 short-circuits to null. The veto message is prescriptive
 * and agent-readable so the calling hook can act on it directly.
 */
import type { Decision, Ecosystem, PkgResult, Severity, VulnInfo } from "./types.js";

const SEV_RANK: Record<Severity, number> = {
  unknown: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

function registryLabel(ecosystem: Ecosystem): string {
  return ecosystem; // ecosystem names double as human-readable registry labels
}

/** Highest severity across a package's vulns. */
function highestSeverity(vulns: VulnInfo[]): Severity {
  let best: Severity = "unknown";
  for (const v of vulns) if (SEV_RANK[v.severity] > SEV_RANK[best]) best = v.severity;
  return best;
}

/** Prefer a CVE/GHSA alias from the worst vuln; else its id. */
function bestIdentifier(vulns: VulnInfo[]): string {
  if (vulns.length === 0) return "advisory";
  const worst = [...vulns].sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity])[0];
  const alias = worst.aliases.find((a) => /^(CVE|GHSA)/i.test(a));
  return alias ?? worst.aliases[0] ?? worst.id;
}

/** Version label for a bullet: prefer the resolved version, else the raw spec. */
function versionLabel(r: PkgResult): string {
  if (r.scannedVersion) return `@${r.scannedVersion}`;
  if (r.versionSpec) return `@${r.versionSpec}`;
  return "";
}

function vetoBullet(r: PkgResult): string {
  if (r.notFound) {
    return `  • ${r.name} — not found in the ${registryLabel(r.ecosystem)} registry (possible typosquat) → verify the package name`;
  }
  const sev = highestSeverity(r.vulns);
  const id = bestIdentifier(r.vulns);
  if (r.safeVersion) {
    return `  • ${r.name}${versionLabel(r)} — known ${sev} vulnerability [${id}] → use >=${r.safeVersion} instead`;
  }
  return `  • ${r.name}${versionLabel(r)} — known ${sev} vulnerability [${id}] → no fixed version available; blocked by policy`;
}

function warnBullet(r: PkgResult): string {
  const sev = highestSeverity(r.vulns);
  const id = bestIdentifier(r.vulns);
  return `  • ${r.name}${versionLabel(r)} — known ${sev} vulnerability [${id}] (no fixed version published yet)`;
}

function formatVeto(vetoes: PkgResult[]): string {
  const lines = [
    "🔒 Dependency guard — install blocked (shift-left vulnerability check):",
    ...vetoes.map(vetoBullet),
    "Re-run the install with the safe version(s) above.",
  ];
  return lines.join("\n");
}

function formatWarn(warns: PkgResult[]): string {
  const lines = [
    "⚠️ Dependency guard — vulnerable dependency, no fixed version available:",
    ...warns.map(warnBullet),
    "No safe version is published yet — proceed with caution.",
  ];
  return lines.join("\n");
}

/**
 * Assess per-package results into a decision. `env` is injectable for tests.
 */
export function assessScanResults(
  results: PkgResult[],
  env: NodeJS.ProcessEnv = process.env
): Decision {
  if (env.DEP_SCAN_DISABLE === "1") return null;
  const enforce = env.DEP_SCAN_ENFORCE === "1";

  const vetoes: PkgResult[] = [];
  const warns: PkgResult[] = [];

  for (const r of results) {
    if (r.notFound) {
      vetoes.push(r);
      continue;
    }
    if (r.status === "vulnerable" && r.vulns.length > 0) {
      if (r.safeVersion || enforce) vetoes.push(r);
      else warns.push(r);
    }
  }

  if (vetoes.length > 0) return { action: "veto", message: formatVeto(vetoes) };
  if (warns.length > 0) return { action: "warn", message: formatWarn(warns) };
  return null;
}
