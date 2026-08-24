/**
 * safe-version.ts — the payoff: given the vulnerabilities found and the version
 * that would be installed, compute the safe version to recommend.
 *
 * Take the MAX fixed version across every range of every vuln (highest, not
 * lowest — the lowest fix can itself be re-vetoed, causing bounce thrash; the
 * highest converges in a single bounce). Only return it if it is strictly newer
 * than the scanned version; otherwise there is no usable fix.
 */
import type { VulnInfo } from "./types.js";

/**
 * Compare two dotted versions. Numeric segments compare numerically; any
 * non-numeric segment falls back to lexical comparison for that position.
 * Missing segments are treated as 0. Returns -1, 0, or 1.
 */
export function compareVersions(a: string, b: string): number {
  const as = a.split(".");
  const bs = b.split(".");
  const n = Math.max(as.length, bs.length);
  for (let i = 0; i < n; i++) {
    const x = as[i] ?? "0";
    const y = bs[i] ?? "0";
    const nx = Number(x);
    const ny = Number(y);
    const bothNumeric =
      Number.isInteger(nx) && Number.isInteger(ny) && String(nx) === x && String(ny) === y;
    if (bothNumeric) {
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Compute the safe version to recommend, or undefined if none applies.
 *
 * @param vulns          all vulnerabilities found for the package
 * @param scannedVersion the version that would be installed (may be undefined)
 */
export function computeSafeVersion(
  vulns: VulnInfo[],
  scannedVersion?: string
): string | undefined {
  const allFixed: string[] = [];
  for (const v of vulns) allFixed.push(...v.fixedVersions);
  if (allFixed.length === 0) return undefined;

  // MAX fixed across every vuln.
  const maxFixed = allFixed.reduce((best, cur) =>
    compareVersions(cur, best) > 0 ? cur : best
  );

  // With no known scanned version we cannot compare — recommend the fix anyway.
  if (!scannedVersion) return maxFixed;

  // Only useful if strictly newer than what would be installed.
  return compareVersions(maxFixed, scannedVersion) > 0 ? maxFixed : undefined;
}
