/**
 * resolveScanVersion — determine the concrete version to scan.
 *
 * A pinned exact spec is normalized and used directly. Anything fuzzy (range,
 * caret, tilde, dist-tag, or no spec at all) triggers a best-effort "latest"
 * lookup against the ecosystem registry. Any failure → undefined (the caller
 * then scans name-only). NEVER throws.
 */
import type { Ecosystem, FetchLike, PkgSpec } from "./types.js";
import { fetchWithTimeout } from "./fetch-timeout.js";

/** npm registry needs `/` escaped for scoped names; `@` is left intact. */
function npmEncode(name: string): string {
  return name.replace(/\//g, "%2f");
}

/**
 * If the spec pins an exact version (1.2.3 / ==1.2.3 / ===1.2.3 / v1.2.3),
 * return the normalized version. Otherwise null (→ best-effort latest).
 */
function pinnedExact(versionSpec: string | undefined): string | null {
  if (!versionSpec) return null;
  const normalized = versionSpec.replace(/^===?/, "").replace(/^v/, "").trim();
  // Pure dotted-numeric core, optionally with a pre-release / build suffix.
  if (/^\d+(\.\d+)*([-+][0-9A-Za-z.-]+)?$/.test(normalized)) return normalized;
  return null;
}

async function fetchJson(url: string, fetchFn: FetchLike): Promise<unknown | undefined> {
  const resp = await fetchWithTimeout(fetchFn, url, { method: "GET" });
  if (!resp || !resp.ok) return undefined;
  return await resp.json();
}

function get(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/**
 * Resolve the version to scan for a package. Returns undefined on any failure
 * (network, parse, unsupported ecosystem) so the scan proceeds name-only.
 */
export async function resolveScanVersion(
  ecosystem: Ecosystem,
  pkg: PkgSpec,
  fetchFn: FetchLike = fetch as unknown as FetchLike
): Promise<string | undefined> {
  try {
    const pinned = pinnedExact(pkg.versionSpec);
    if (pinned) return pinned;

    const name = pkg.name;
    let url: string | undefined;
    let path: string[] = [];

    switch (ecosystem) {
      case "npm":
        url = `https://registry.npmjs.org/${npmEncode(name)}/latest`;
        path = ["version"];
        break;
      case "PyPI":
        url = `https://pypi.org/pypi/${encodeURIComponent(name)}/json`;
        path = ["info", "version"];
        break;
      case "crates.io":
        url = `https://crates.io/api/v1/crates/${encodeURIComponent(name)}`;
        path = ["crate", "max_stable_version"];
        break;
      case "RubyGems":
        url = `https://rubygems.org/api/v1/gems/${encodeURIComponent(name)}.json`;
        path = ["version"];
        break;
      case "Go":
        // No simple latest endpoint — scan name-only.
        return undefined;
    }

    if (!url) return undefined;
    const data = await fetchJson(url, fetchFn);
    const version = get(data, path);
    return typeof version === "string" && version.length > 0 ? version : undefined;
  } catch {
    return undefined;
  }
}
