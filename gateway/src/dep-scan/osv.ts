/**
 * osv.ts — scan a single package version for known vulnerabilities.
 *
 * Source order: snyk-local → osv-scanner-local → OSV HTTP API → advisory-skip.
 * Local scanners are optional accelerators (injectable); for a bare single
 * package they are not definitive, so they fall through to the OSV HTTP API,
 * which is the reliable floor. The OSV HTTP API returns the same advisory data
 * the local osv-scanner would, so falling through loses no coverage.
 *
 * ABSOLUTE INVARIANT: scanOne never throws. Any HTTP / parse / network failure
 * yields verdict "unknown".
 */
import type { Ecosystem, FetchLike, ScanVerdict, Severity, VulnInfo } from "./types.js";
import { fetchWithTimeout } from "./fetch-timeout.js";

const OSV_QUERY_URL = "https://api.osv.dev/v1/query";

/** A local-scanner accelerator: returns a definitive verdict, or null to fall through. */
export type LocalScanner = (
  ecosystem: Ecosystem,
  name: string,
  version?: string
) => Promise<ScanVerdict | null>;

export interface ScanOptions {
  fetchFn?: FetchLike;
  /** Ordered local accelerators (snyk, osv-scanner). Default: none. */
  localScanners?: LocalScanner[];
}

const SEV_RANK: Record<Severity, number> = {
  unknown: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

function higher(a: Severity, b: Severity): Severity {
  return SEV_RANK[b] > SEV_RANK[a] ? b : a;
}

/** Bucket a numeric CVSS base score. */
function bucketFromScore(score: number): Severity {
  if (score >= 9) return "critical";
  if (score >= 7) return "high";
  if (score >= 4) return "medium";
  return "low";
}

/** Map a database_specific severity string; `moderate` → medium. */
function bucketFromString(s: string): Severity | undefined {
  switch (s.toLowerCase()) {
    case "critical":
      return "critical";
    case "high":
      return "high";
    case "moderate":
    case "medium":
      return "medium";
    case "low":
      return "low";
    default:
      return undefined;
  }
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Normalize one raw OSV vuln record into VulnInfo. Defensive against any shape. */
function parseVuln(raw: unknown): VulnInfo {
  const v = (raw ?? {}) as Record<string, unknown>;
  const id = asString(v.id) ?? "UNKNOWN";
  const aliases = asArray(v.aliases).filter((x): x is string => typeof x === "string");
  const summary = asString(v.summary) ?? asString(v.details);

  let severity: Severity = "unknown";

  // 1) severity[] with numeric CVSS base scores (CVSS vector strings parse to NaN → skipped).
  for (const sev of asArray(v.severity)) {
    const score = parseFloat(String((sev as Record<string, unknown>)?.score));
    if (Number.isFinite(score)) severity = higher(severity, bucketFromScore(score));
  }

  // 2) database_specific.severity string at the vuln level.
  const dbSpecific = v.database_specific as Record<string, unknown> | undefined;
  const dbSev = asString(dbSpecific?.severity);
  if (dbSev) {
    const mapped = bucketFromString(dbSev);
    if (mapped) severity = higher(severity, mapped);
  }

  // 3) fixed versions + affected-level severity strings.
  const fixedVersions: string[] = [];
  for (const aff of asArray(v.affected)) {
    const affObj = (aff ?? {}) as Record<string, unknown>;
    const affDb = affObj.database_specific as Record<string, unknown> | undefined;
    const affSev = asString(affDb?.severity);
    if (affSev) {
      const mapped = bucketFromString(affSev);
      if (mapped) severity = higher(severity, mapped);
    }
    for (const rng of asArray(affObj.ranges)) {
      for (const ev of asArray((rng as Record<string, unknown>)?.events)) {
        const fixed = asString((ev as Record<string, unknown>)?.fixed);
        if (fixed) fixedVersions.push(fixed);
      }
    }
  }

  return { id, aliases, summary, severity, fixedVersions };
}

/**
 * Scan a single package version. Never throws — returns "unknown" on any error.
 */
export async function scanOne(
  ecosystem: Ecosystem,
  name: string,
  version?: string,
  opts: ScanOptions = {}
): Promise<ScanVerdict> {
  const fetchFn = opts.fetchFn ?? (fetch as unknown as FetchLike);
  try {
    // Source order: local accelerators first; fall through when not definitive.
    for (const scan of opts.localScanners ?? []) {
      const local = await scan(ecosystem, name, version);
      if (local) return local;
    }

    // OSV HTTP API floor.
    const body: { package: { ecosystem: Ecosystem; name: string }; version?: string } = {
      package: { ecosystem, name },
    };
    if (version) body.version = version;

    const resp = await fetchWithTimeout(fetchFn, OSV_QUERY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp || !resp.ok) return { status: "unknown", vulns: [], scannedVersion: version };

    const data = (await resp.json()) as Record<string, unknown>;
    const rawVulns = asArray(data?.vulns);
    if (rawVulns.length === 0) return { status: "clean", vulns: [], scannedVersion: version };

    return { status: "vulnerable", vulns: rawVulns.map(parseVuln), scannedVersion: version };
  } catch {
    // advisory-skip: any failure is indeterminate, never a hard block.
    return { status: "unknown", vulns: [], scannedVersion: version };
  }
}
