/**
 * Bare-name to Go-spec resolver (GEN-5).
 *
 * Turns a bare service name (e.g. "stripe") into the discovery-result object
 * the deterministic Go path (`runGoGeneration` in `src/cli/index.ts`) consumes,
 * with no hand-written spec. It discovers a public OpenAPI/Swagger document via
 * apis.guru (free, keyless), fetches the raw spec, and converts it with the
 * tested GEN-4 `openApiToDiscovery` converter.
 *
 * DESIGN CHOICE: PATH B (hybrid), not PATH A.
 * `ApiResearcher.research()` parses endpoints but (a) never populates
 * `DiscoveryResult.baseUrl` (it stays undefined) and (b) derives `authSchemes`
 * from the caller's `toolSpec.authType` rather than the spec's real
 * `securitySchemes`. `generateGoServer` REQUIRES an https baseUrl and needs the
 * real auth scheme, so research()'s output alone cannot produce a compilable Go
 * server. Fetching the raw spec and running it through GEN-4
 * `openApiToDiscovery` recovers baseUrl (from servers/host), the real auth
 * scheme (from securitySchemes/securityDefinitions), and typed path/query
 * params in one step. The apis.guru lookup below mirrors the exact endpoint
 * shapes documented in `ApiResearcher.discoverApisGuruSpecs`
 * (GET /v2/providers.json -> { data: string[] };
 *  GET /v2/{provider}.json -> { apis: { [k]: { swaggerUrl, openapiVer } } });
 * that discovery helper is private, so the minimal two-step lookup is repeated
 * here rather than reached into.
 */

import axios, { AxiosInstance } from 'axios';
import { parse as parseYaml } from 'yaml';
import { openApiToDiscovery, isOpenApiDocument, DiscoveryResult } from './openapi-to-discovery.js';

/** apis.guru is a free, keyless directory of public OpenAPI specs. */
const APIS_GURU_BASE = 'https://api.apis.guru/v2';

export interface ResolveGoSpecResult {
  /** The Go-path discovery-result, or null when nothing usable was found. */
  discovery: DiscoveryResult | null;
  /** Non-fatal notes (no match, fetch/convert failures). Always surfaced. */
  warnings: string[];
  /** The spec URL that produced `discovery`, when one did. */
  specUrl?: string;
}

export interface ResolveGoSpecOptions {
  /** Override the apis.guru base (tests). Defaults to the public instance. */
  apisGuruBase?: string;
  /** Inject an axios instance (tests/timeouts). Defaults to a fresh client. */
  httpClient?: AxiosInstance;
  /** Cap on providers inspected (kept small so this stays a hint, not a scan). */
  maxProviders?: number;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Two-step apis.guru lookup returning candidate raw-spec URLs for a name.
 * Mirrors `ApiResearcher.discoverApisGuruSpecs` endpoint shapes exactly. Never
 * throws for a per-provider failure; a top-level failure (providers.json
 * unreachable) propagates to the caller, which records it as a warning.
 */
async function discoverSpecUrls(
  http: AxiosInstance,
  base: string,
  name: string,
  maxProviders: number,
  warnings: string[],
): Promise<string[]> {
  const providersResp = await http.get<{ data: string[] }>(`${base}/providers.json`, { timeout: 8000 });
  const providers = Array.isArray(providersResp.data?.data) ? providersResp.data.data : [];
  const lower = name.toLowerCase();
  const matches = providers.filter((p) => typeof p === 'string' && lower.length > 0 && p.toLowerCase().includes(lower));

  const urls: string[] = [];
  for (const provider of matches.slice(0, maxProviders)) {
    try {
      const specResp = await http.get<{
        apis: Record<string, { swaggerUrl?: string; openapiVer?: string }>;
      }>(`${base}/${provider}.json`, { timeout: 8000 });
      for (const entry of Object.values(specResp.data?.apis ?? {})) {
        if (entry && typeof entry.swaggerUrl === 'string' && entry.swaggerUrl) {
          if (!urls.includes(entry.swaggerUrl)) urls.push(entry.swaggerUrl);
        }
      }
    } catch (e) {
      warnings.push(`apis.guru: no usable spec metadata for provider ${provider} (${errMsg(e)})`);
    }
  }
  return urls;
}

/**
 * Fetch a raw spec URL and parse it into an object. Handles both JSON and YAML
 * (apis.guru serves either): the response is taken as raw text and parsed as
 * JSON first, then YAML on failure. Returns the parsed object (unknown shape).
 */
async function fetchSpec(http: AxiosInstance, url: string): Promise<unknown> {
  const resp = await http.get(url, {
    timeout: 15000,
    // Take the body verbatim so JSON and YAML are handled uniformly below,
    // rather than letting axios auto-JSON-parse only some content types.
    transformResponse: [(d) => d],
  });
  const data = resp.data;
  if (data && typeof data === 'object') return data; // already parsed (defensive)
  if (typeof data !== 'string') return data;
  try {
    return JSON.parse(data);
  } catch {
    return parseYaml(data);
  }
}

/**
 * Resolve a bare service/API name into a Go-path discovery-result.
 *
 * Returns `{ discovery, warnings, specUrl }`. `discovery` is null (never a
 * thrown error, never an empty-endpoint server) when no public spec with usable
 * endpoints is found; the caller prints the fallback guidance and exits
 * non-zero. All non-fatal issues are accumulated in `warnings`.
 */
export async function resolveGoSpecFromName(
  name: string,
  opts?: ResolveGoSpecOptions,
): Promise<ResolveGoSpecResult> {
  const warnings: string[] = [];
  const trimmed = (name ?? '').trim();
  if (!trimmed) {
    warnings.push('resolveGoSpecFromName: empty name.');
    return { discovery: null, warnings };
  }

  const base = opts?.apisGuruBase ?? APIS_GURU_BASE;
  const maxProviders = opts?.maxProviders ?? 5;
  const http =
    opts?.httpClient ??
    axios.create({ timeout: 30000, headers: { 'User-Agent': 'thesun-resolve-go-spec/1.0' } });

  let specUrls: string[] = [];
  try {
    specUrls = await discoverSpecUrls(http, base, trimmed, maxProviders, warnings);
  } catch (e) {
    warnings.push(`apis.guru lookup failed: ${errMsg(e)}`);
  }

  if (specUrls.length === 0) {
    warnings.push(`apis.guru: no OpenAPI spec found for ${trimmed}`);
    return { discovery: null, warnings };
  }

  // Try each candidate until one yields usable (non-empty) endpoints.
  for (const url of specUrls) {
    try {
      const raw = await fetchSpec(http, url);
      if (!isOpenApiDocument(raw)) {
        warnings.push(`Fetched ${url} but it is not an OpenAPI/Swagger document; skipping.`);
        continue;
      }
      const discovery = openApiToDiscovery(raw, { name: trimmed });
      if (discovery.endpoints.length > 0) {
        return { discovery, warnings, specUrl: url };
      }
      warnings.push(`Spec at ${url} produced no endpoints; skipping.`);
    } catch (e) {
      warnings.push(`Failed to fetch or convert ${url}: ${errMsg(e)}`);
    }
  }

  warnings.push(`No usable endpoints resolved from ${specUrls.length} candidate spec(s) for ${trimmed}.`);
  return { discovery: null, warnings };
}
