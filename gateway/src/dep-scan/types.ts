/**
 * Shared types for the shift-left dependency-vulnerability install guard.
 *
 * The engine is a pure, fail-open pipeline: parse an install command → resolve
 * the version that would actually be installed → scan it against OSV → compute
 * the safe upgrade target → decide veto/warn/allow. Every stage is designed so
 * that any failure degrades to "allow" (null) or "unknown", never a throw.
 */

/** Package ecosystems, named to match the OSV `package.ecosystem` field exactly. */
export type Ecosystem = "npm" | "PyPI" | "crates.io" | "Go" | "RubyGems";

/** Bucketed severity. `unknown` when no parseable severity signal is present. */
export type Severity = "critical" | "high" | "medium" | "low" | "unknown";

/** A single package extracted from an install command. */
export interface PkgSpec {
  name: string;
  /** The raw version spec as written (e.g. "4.17.20", ">=2.0", "^1.2", "latest"). */
  versionSpec?: string;
}

/** Result of parsing an install command. */
export interface ParsedInstall {
  ecosystem: Ecosystem;
  packages: PkgSpec[];
}

/** One vulnerability, normalized from an OSV record. */
export interface VulnInfo {
  id: string;
  aliases: string[];
  summary?: string;
  severity: Severity;
  /** Every `fixed` version found across all affected ranges. */
  fixedVersions: string[];
}

/** Outcome of scanning a single package version. */
export interface ScanVerdict {
  status: "clean" | "vulnerable" | "unknown";
  vulns: VulnInfo[];
  scannedVersion?: string;
}

/** Per-package result carried into the policy stage. */
export interface PkgResult {
  ecosystem: Ecosystem;
  name: string;
  versionSpec?: string;
  scannedVersion?: string;
  status: ScanVerdict["status"];
  vulns: VulnInfo[];
  /** Highest published fix strictly newer than the scanned version, if any. */
  safeVersion?: string;
  /** True only when a registry returned a definitive 404 for this name. */
  notFound?: boolean;
}

/** The engine's decision. `null` always means "allow". */
export type Decision = { action: "veto" | "warn"; message: string } | null;

/** Minimal injectable fetch — a subset of the global `fetch` we depend on. */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    /**
     * Abort signal (OPS-5). Every outbound call is wrapped with a timeout so a
     * hung endpoint aborts instead of hanging the install-gating request; a real
     * fetch rejects when the signal fires, degrading via the existing fail-open
     * catch. Optional so hand-built stub fetches in tests need not honor it.
     */
    signal?: AbortSignal;
  }
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;
