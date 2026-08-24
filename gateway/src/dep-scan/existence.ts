/**
 * existence.ts — registry 404-only existence check for typosquat detection.
 *
 * A definitive 404 means the package name does not exist in its registry — a
 * likely typosquat, worth blocking. Any other status or a network error is
 * fail-open (treated as "exists") so a flaky registry never blocks an install.
 */
import type { Ecosystem, FetchLike } from "./types.js";
import { fetchWithTimeout } from "./fetch-timeout.js";

function npmEncode(name: string): string {
  return name.replace(/\//g, "%2f");
}

/** Build the registry URL whose 404 is authoritative for non-existence. */
function registryUrl(ecosystem: Ecosystem, name: string): string | undefined {
  switch (ecosystem) {
    case "npm":
      return `https://registry.npmjs.org/${npmEncode(name)}`;
    case "PyPI":
      return `https://pypi.org/pypi/${encodeURIComponent(name)}/json`;
    case "crates.io":
      return `https://crates.io/api/v1/crates/${encodeURIComponent(name)}`;
    case "RubyGems":
      return `https://rubygems.org/api/v1/gems/${encodeURIComponent(name)}.json`;
    case "Go":
      return undefined; // no simple 404 endpoint — skip
  }
}

export interface ExistenceResult {
  /** False ONLY on a definitive 404. */
  exists: boolean;
  /** Whether the check actually ran and was conclusive. */
  checked: boolean;
}

/**
 * Check whether a package name exists in its registry. Fail-open: only a 404
 * yields { exists: false }. Never throws.
 */
export async function checkExistence(
  ecosystem: Ecosystem,
  name: string,
  fetchFn: FetchLike = fetch as unknown as FetchLike
): Promise<ExistenceResult> {
  const url = registryUrl(ecosystem, name);
  if (!url) return { exists: true, checked: false };
  try {
    const resp = await fetchWithTimeout(fetchFn, url, { method: "GET" });
    if (resp && resp.status === 404) return { exists: false, checked: true };
    return { exists: true, checked: true };
  } catch {
    return { exists: true, checked: false }; // network error ≠ not-found
  }
}
