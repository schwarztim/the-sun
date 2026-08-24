/**
 * OpenAPI / Swagger to discovery-result converter (GEN-4).
 *
 * The deterministic `--lang go` path (see `runGoGeneration` in
 * `src/cli/index.ts`) consumes either a hand-assembled `GoServerConfig` or a
 * thesun "discovery-result" object (top-level metadata plus an `endpoints[]`
 * array whose parameters carry an `in` field). This module lets that same path
 * accept a raw OpenAPI 3.x or Swagger 2.0 document directly, by converting the
 * spec into the discovery-result shape that `runGoGeneration` already handles.
 *
 * The emitted `endpoints[]` match exactly what `endpointsFromDiscovery` in
 * `go-generator.ts` consumes:
 *   { path, method, operationId?, summary?, description?,
 *     parameters?: { name, in, required?, description? }[] }
 * where `endpointsFromDiscovery` only reads `in === "path"` and `in === "query"`
 * parameters (header and cookie params are dropped here on purpose; see below).
 */

/**
 * A single discovery-result endpoint, shaped exactly as `endpointsFromDiscovery`
 * (go-generator.ts) expects.
 */
export interface DiscoveryEndpoint {
  path: string;
  method: string;
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: Array<{ name: string; in: string; required?: boolean; description?: string }>;
}

/**
 * Top-level discovery-result object that `runGoGeneration` reads. Only the
 * fields the Go path actually consumes are modelled here; extra fields are
 * harmless.
 */
export interface DiscoveryResult {
  name: string;
  version?: string;
  baseUrl: string;
  authScheme: 'bearer' | 'api_key' | 'basic' | 'hermes-token' | 'cookie-session' | 'none';
  authEnvPrefix?: string;
  apiKeyHeader?: string;
  apiKeyQueryParam?: string;
  rateLimitRPS?: number;
  rateLimitBurst?: number;
  endpoints: DiscoveryEndpoint[];
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

/**
 * True when `raw` looks like an OpenAPI 3.x (`openapi`) or Swagger 2.0
 * (`swagger`) document AND carries a `paths` object. Used by the CLI to decide
 * whether to run this converter before the existing discovery-shape detection.
 */
export function isOpenApiDocument(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const doc = raw as Record<string, unknown>;
  const hasVersion = typeof doc.openapi === 'string' || typeof doc.swagger === 'string';
  const hasPaths = typeof doc.paths === 'object' && doc.paths !== null;
  return hasVersion && hasPaths;
}

/** Lowercase a title into an alphanumeric-hyphen slug (leading/trailing hyphens stripped). */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Turn a URL path template like `/pets/{petId}/toys` into a slug for a fallback tool name. */
function pathSlug(path: string): string {
  return (
    path
      .replace(/\{([^}]+)\}/g, '$1') // {petId} -> petId
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toLowerCase() || 'root'
  );
}

/**
 * Resolve a LOCAL `$ref` (e.g. `#/components/parameters/Foo` or
 * `#/parameters/Foo`) against the root document. Returns null when the ref is
 * remote (does not start with `#/`) or cannot be resolved locally; callers skip
 * unresolvable refs rather than crashing.
 */
function resolveLocalRef(root: Record<string, unknown>, ref: string): Record<string, unknown> | null {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return null; // remote/unsupported ref
  const segments = ref
    .slice(2)
    .split('/')
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~')); // JSON Pointer unescape
  let node: unknown = root;
  for (const seg of segments) {
    if (!node || typeof node !== 'object') return null;
    node = (node as Record<string, unknown>)[seg];
  }
  return node && typeof node === 'object' ? (node as Record<string, unknown>) : null;
}

type RawParam = Record<string, unknown>;

/**
 * Normalize a single parameter object (already $ref-resolved) into the
 * discovery parameter shape, or null when it should be dropped (unknown/empty
 * name, or an `in` that the Go adapter does not consume: header, cookie, body,
 * formData). Only `path` and `query` survive, matching `endpointsFromDiscovery`.
 */
function normalizeParam(p: RawParam): { name: string; in: string; required?: boolean; description?: string } | null {
  const name = typeof p.name === 'string' ? p.name : '';
  const location = typeof p.in === 'string' ? p.in : '';
  if (!name || (location !== 'path' && location !== 'query')) return null;
  return {
    name,
    in: location,
    // Path params are always required per the OpenAPI/Swagger spec.
    required: location === 'path' ? true : p.required === true,
    description: typeof p.description === 'string' ? p.description : undefined,
  };
}

/**
 * Merge path-level and operation-level parameters, resolving local $refs and
 * dropping unresolvable refs / non-path-non-query params. Later (operation)
 * entries win over earlier (path-level) ones on a (name, in) collision.
 */
function collectParameters(
  root: Record<string, unknown>,
  pathLevel: unknown,
  opLevel: unknown,
): Array<{ name: string; in: string; required?: boolean; description?: string }> {
  const merged = new Map<string, { name: string; in: string; required?: boolean; description?: string }>();
  for (const source of [pathLevel, opLevel]) {
    if (!Array.isArray(source)) continue;
    for (const entry of source) {
      if (!entry || typeof entry !== 'object') continue;
      let param = entry as RawParam;
      if (typeof param.$ref === 'string') {
        const resolved = resolveLocalRef(root, param.$ref);
        if (!resolved) continue; // unresolvable (remote or missing) ref: skip, do not crash
        param = resolved;
      }
      const normalized = normalizeParam(param);
      if (!normalized) continue;
      merged.set(`${normalized.in}:${normalized.name}`, normalized);
    }
  }
  return Array.from(merged.values());
}

/** Derive the base URL for an OpenAPI 3.x document from `servers[0].url`. */
function baseUrlFromOpenApi3(doc: Record<string, unknown>): string {
  const servers = doc.servers;
  if (Array.isArray(servers) && servers.length > 0 && servers[0] && typeof servers[0] === 'object') {
    const url = (servers[0] as Record<string, unknown>).url;
    if (typeof url === 'string' && url.trim()) {
      // Relative or templated ({var}) URLs are left as-is; generateGoServer
      // requires an https:// URL, so a relative/templated server surfaces there
      // as a clear error rather than being silently rewritten here.
      return url.replace(/\/+$/, '');
    }
  }
  return '';
}

/** Derive the base URL for a Swagger 2.0 document from schemes + host + basePath. */
function baseUrlFromSwagger2(doc: Record<string, unknown>): string {
  const host = typeof doc.host === 'string' ? doc.host : '';
  if (!host) return '';
  const schemes = Array.isArray(doc.schemes) ? doc.schemes.filter((s) => typeof s === 'string') : [];
  const scheme = (schemes[0] as string) || 'https';
  const basePath = typeof doc.basePath === 'string' ? doc.basePath : '';
  return `${scheme}://${host}${basePath}`.replace(/\/+$/, '');
}

/**
 * Auth-scheme mapping (first defined security scheme wins; the choice is
 * documented via the returned fields). Mapping table:
 *   OpenAPI 3 components.securitySchemes / Swagger 2 securityDefinitions
 *   ----------------------------------------------------------------------
 *   http + scheme=bearer            -> 'bearer'
 *   http + scheme=basic             -> 'basic'  (Swagger 2 type=basic too)
 *   apiKey + in=header              -> 'api_key' (apiKeyHeader = name)
 *   apiKey + in=query               -> 'api_key' (apiKeyQueryParam = name)
 *   oauth2 / openIdConnect          -> 'bearer' (token via Authorization)
 *   (none present / all unmappable) -> 'none'
 */
function mapAuth(schemes: Record<string, unknown> | undefined): {
  authScheme: DiscoveryResult['authScheme'];
  apiKeyHeader?: string;
  apiKeyQueryParam?: string;
} {
  if (!schemes || typeof schemes !== 'object') return { authScheme: 'none' };
  // Iterate in declaration order; the FIRST scheme that maps to a supported
  // outbound credential type is chosen.
  for (const value of Object.values(schemes)) {
    if (!value || typeof value !== 'object') continue;
    const s = value as Record<string, unknown>;
    const type = typeof s.type === 'string' ? s.type.toLowerCase() : '';
    const scheme = typeof s.scheme === 'string' ? s.scheme.toLowerCase() : '';
    const location = typeof s.in === 'string' ? s.in.toLowerCase() : '';
    const name = typeof s.name === 'string' ? s.name : '';

    if (type === 'http' && scheme === 'bearer') return { authScheme: 'bearer' };
    if (type === 'http' && scheme === 'basic') return { authScheme: 'basic' };
    if (type === 'basic') return { authScheme: 'basic' }; // Swagger 2 basic
    if (type === 'apikey' && name) {
      if (location === 'header') return { authScheme: 'api_key', apiKeyHeader: name };
      if (location === 'query') return { authScheme: 'api_key', apiKeyQueryParam: name };
    }
    if (type === 'oauth2' || type === 'openidconnect') return { authScheme: 'bearer' };
  }
  return { authScheme: 'none' };
}

/**
 * Convert a parsed OpenAPI 3.x or Swagger 2.0 document into the discovery-result
 * object that `runGoGeneration` consumes. Throws a clear Error on a
 * malformed/partial spec or when zero endpoints are produced (never emits a
 * silently-empty server).
 *
 * Known limitations (documented, not bugs):
 *  - Request bodies are NOT mapped to tool inputs: `endpointsFromDiscovery`
 *    only consumes path/query params, so body-schema -> input mapping is a TODO
 *    for the Go path. Body-only endpoints still generate (with path/query args).
 *  - Header and cookie parameters are dropped (the Go adapter injects auth
 *    headers itself and does not model arbitrary header/cookie tool inputs).
 *  - Only the FIRST server (OpenAPI 3) is used; multi-server specs ignore the
 *    rest. Remote ($ref to another file/URL) refs are skipped, not fetched.
 */
export function openApiToDiscovery(spec: unknown, opts?: { name?: string }): DiscoveryResult {
  if (!spec || typeof spec !== 'object') {
    throw new Error('openApiToDiscovery: spec is not an object.');
  }
  const doc = spec as Record<string, unknown>;
  const isV3 = typeof doc.openapi === 'string';
  const isV2 = typeof doc.swagger === 'string';
  if (!isV3 && !isV2) {
    throw new Error('openApiToDiscovery: not an OpenAPI 3.x or Swagger 2.0 document (no `openapi`/`swagger` field).');
  }

  const paths = doc.paths;
  if (!paths || typeof paths !== 'object') {
    throw new Error('openApiToDiscovery: spec has no `paths` object.');
  }

  const info = (doc.info && typeof doc.info === 'object' ? doc.info : {}) as Record<string, unknown>;
  const title = typeof info.title === 'string' ? info.title : '';
  const name = opts?.name?.trim() ? slugify(opts.name) : slugify(title) || 'service';
  const version = typeof info.version === 'string' ? info.version : 'dev';

  const baseUrl = isV3 ? baseUrlFromOpenApi3(doc) : baseUrlFromSwagger2(doc);

  const securitySchemes = isV3
    ? ((doc.components as Record<string, unknown> | undefined)?.securitySchemes as
        | Record<string, unknown>
        | undefined)
    : (doc.securityDefinitions as Record<string, unknown> | undefined);
  const auth = mapAuth(securitySchemes);

  const endpoints: DiscoveryEndpoint[] = [];
  for (const [rawPath, pathItemRaw] of Object.entries(paths as Record<string, unknown>)) {
    if (!pathItemRaw || typeof pathItemRaw !== 'object') continue;
    const pathItem = pathItemRaw as Record<string, unknown>;
    const pathLevelParams = pathItem.parameters;

    for (const method of HTTP_METHODS) {
      const opRaw = pathItem[method];
      if (!opRaw || typeof opRaw !== 'object') continue;
      const op = opRaw as Record<string, unknown>;

      const operationId = typeof op.operationId === 'string' && op.operationId.trim() ? op.operationId : undefined;
      const summary = typeof op.summary === 'string' ? op.summary : undefined;
      const opDescription = typeof op.description === 'string' ? op.description : undefined;

      const parameters = collectParameters(doc, pathLevelParams, op.parameters);

      endpoints.push({
        path: rawPath,
        method: method.toUpperCase(),
        operationId: operationId ?? `${method}_${pathSlug(rawPath)}`,
        summary,
        description: opDescription ?? summary,
        parameters,
      });
    }
  }

  if (endpoints.length === 0) {
    throw new Error(
      'openApiToDiscovery: no operations found in `paths` (no get/post/put/patch/delete). Refusing to emit an empty server.',
    );
  }

  return {
    name,
    version,
    baseUrl,
    authScheme: auth.authScheme,
    // Namespace generated env vars by the slug (uppercased): e.g. PETSTORE_API_KEY.
    authEnvPrefix: name.toUpperCase().replace(/-/g, '_'),
    apiKeyHeader: auth.apiKeyHeader,
    apiKeyQueryParam: auth.apiKeyQueryParam,
    endpoints,
  };
}
