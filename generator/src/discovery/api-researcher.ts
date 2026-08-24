/**
 * API Researcher
 *
 * Exhaustively discovers all APIs for a tool before MCP generation.
 * Uses multiple strategies:
 * 1. Web search for existing MCPs and documentation
 * 2. Official vendor API documentation
 * 3. OpenAPI/Swagger spec fetching
 * 4. Endpoint enumeration and validation
 * 5. Gap analysis against reference implementations
 */

import axios from 'axios';
import { logger } from '../observability/logger.js';
import { PatternEngine } from '../patterns/pattern-engine.js';
import {
  ToolSpec,
  DiscoveryResult,
  DiscoveredEndpoint,
  DiscoveredEndpointSchema,
} from '../types/index.js';

/**
 * Research result from web search
 */
export interface WebResearchResult {
  existingMcps: Array<{
    url: string;
    name: string;
    stars?: number;
    lastUpdated?: string;
  }>;
  officialDocs: Array<{
    url: string;
    title: string;
    type: 'api_reference' | 'guide' | 'changelog' | 'other';
  }>;
  openApiSpecs: Array<{
    url: string;
    version: string;
    format: 'openapi3' | 'openapi2' | 'swagger' | 'other';
  }>;
  communityResources: Array<{
    url: string;
    type: 'blog' | 'tutorial' | 'forum' | 'github';
  }>;
  /**
   * Non-fatal discovery gaps (failed lookups, no matches found). searchWeb
   * is a hint layer only — it never throws — so this is the visibility
   * mechanism for "we looked and found nothing" vs "we didn't look."
   */
  warnings: string[];
}

/**
 * API Researcher class
 */
export class ApiResearcher {
  private httpClient = axios.create({
    timeout: 30000,
    headers: {
      'User-Agent': 'thesun-api-researcher/1.0',
    },
  });

  private patternEngine = new PatternEngine();

  /** apis.guru is a free, keyless, community-maintained directory of
   *  OpenAPI specs (github.com/APIs-guru/openapi-directory). Used as a
   *  real (non-simulated) web-doc discovery source — verified endpoint
   *  shapes: GET /v2/providers.json -> { data: string[] } (provider
   *  domains), GET /v2/{provider}.json -> { apis: { [key]: { swaggerUrl,
   *  openapiVer, ... } } }. */
  private static readonly APIS_GURU_BASE = 'https://api.apis.guru/v2';

  /** Matches "N requests per second/minute/hour/day" style rate-limit text
   *  in spec descriptions (e.g. a documented 429 response). */
  private static readonly RATE_LIMIT_TEXT_PATTERN =
    /(\d+)\s*(?:requests?|reqs?|calls?|queries)?\s*(?:per|\/)\s*(second|sec|s|minute|min|m|hour|hr|h|day|d)\b/i;

  /**
   * Perform comprehensive research for a tool
   */
  async research(toolSpec: ToolSpec): Promise<DiscoveryResult> {
    const startTime = Date.now();
    logger.info(`Starting API research for ${toolSpec.name}`, { tool: toolSpec.name });

    const result: DiscoveryResult = {
      toolName: toolSpec.name,
      timestamp: new Date(),
      endpoints: [],
      authSchemes: [],
      globalParameters: [],
    };

    try {
      // Step 1: Search for existing implementations
      const webResearch = await this.searchWeb(toolSpec);

      // Step 2: Analyze existing MCPs for reference
      if (webResearch.existingMcps.length > 0) {
        const mcpAnalysis = await this.analyzeExistingMcps(webResearch.existingMcps);
        result.existingMcpAnalysis = mcpAnalysis;
      }

      // Step 3: Fetch and parse OpenAPI specs
      const endpoints = await this.fetchAndParseSpecs(toolSpec, webResearch);
      result.endpoints = endpoints;

      // Step 4: Extract auth schemes
      result.authSchemes = await this.extractAuthSchemes(toolSpec, webResearch);

      // Step 5: Determine rate limits
      result.rateLimits = await this.determineRateLimits(toolSpec, webResearch, result.endpoints);

      // Step 6: Gap analysis
      if (result.existingMcpAnalysis?.found) {
        const gaps = await this.identifyGaps(result.endpoints, result.existingMcpAnalysis);
        result.existingMcpAnalysis.gaps = gaps;
      }

      const duration = Date.now() - startTime;
      logger.info(`API research completed for ${toolSpec.name}`, {
        tool: toolSpec.name,
        endpointCount: result.endpoints.length,
        durationMs: duration,
      });

      return result;
    } catch (error) {
      logger.error(`API research failed for ${toolSpec.name}`, {
        tool: toolSpec.name,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Search web for existing resources.
   *
   * This is a HINT LAYER ONLY — never a build gate. Every network step below
   * is independently non-fatal: a failure just means fewer hints, recorded
   * in `warnings`, never a thrown error. If discovery here is inconclusive,
   * callers proceed against whatever the spec/observed set already provides
   * (see fetchAndParseSpecs' commonPaths probe and the coverage manifest's
   * `basis` field in src/coverage/manifest.ts).
   */
  private async searchWeb(toolSpec: ToolSpec): Promise<WebResearchResult> {
    logger.debug(`Searching web for ${toolSpec.name} resources`);

    const result: WebResearchResult = {
      existingMcps: [],
      officialDocs: [],
      openApiSpecs: [],
      communityResources: [],
      warnings: [],
    };

    // Add known spec sources from tool spec (operator-declared — authoritative)
    if (toolSpec.specSources) {
      for (const source of toolSpec.specSources) {
        if (source.url) {
          result.openApiSpecs.push({
            url: source.url,
            version: 'unknown',
            format: source.type === 'openapi' ? 'openapi3' : 'other',
          });
        }
      }
    }

    // Add known doc URLs
    if (toolSpec.docUrls) {
      for (const url of toolSpec.docUrls) {
        result.officialDocs.push({
          url,
          title: 'Official Documentation',
          type: 'api_reference',
        });
      }
    }

    // Add known existing MCPs
    if (toolSpec.existingMcps) {
      for (const url of toolSpec.existingMcps) {
        result.existingMcps.push({
          url,
          name: `${toolSpec.name}-mcp`,
        });
      }
    }

    // Real web-doc discovery, layered on top of operator-declared sources.
    const nameCandidates = [toolSpec.vendor, toolSpec.name].filter(
      (v): v is string => Boolean(v && v.trim())
    );

    if (result.openApiSpecs.length === 0 && nameCandidates.length > 0) {
      try {
        const discovered = await this.discoverApisGuruSpecs(nameCandidates);
        for (const spec of discovered) {
          if (!result.openApiSpecs.some((s) => s.url === spec.url)) {
            result.openApiSpecs.push(spec);
          }
        }
        if (discovered.length === 0) {
          result.warnings.push(
            `apis.guru: no OpenAPI spec found for ${nameCandidates.join('/')}`
          );
        }
      } catch (error) {
        result.warnings.push(
          `apis.guru lookup failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    if (toolSpec.vendor) {
      try {
        const probed = await this.probeDocUrls(toolSpec.vendor);
        for (const doc of probed) {
          if (!result.officialDocs.some((d) => d.url === doc.url)) {
            result.officialDocs.push(doc);
          }
        }
        if (probed.length === 0) {
          result.warnings.push(
            `No documentation site found by common-path probing for ${toolSpec.vendor}`
          );
        }
      } catch (error) {
        result.warnings.push(
          `Doc URL probing failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    return result;
  }

  /**
   * Look up OpenAPI specs for the given candidate names via apis.guru
   * (github.com/APIs-guru/openapi-directory) — a free, keyless registry of
   * public API specs. Two-step lookup keeps the request cheap: fetch the
   * lightweight provider domain list once, then fetch full spec metadata
   * only for matching providers (capped, to stay a hint, not a scan).
   */
  private async discoverApisGuruSpecs(
    candidates: string[]
  ): Promise<WebResearchResult['openApiSpecs']> {
    const found: WebResearchResult['openApiSpecs'] = [];

    const providersResp = await this.httpClient.get<{ data: string[] }>(
      `${ApiResearcher.APIS_GURU_BASE}/providers.json`,
      { timeout: 8000 }
    );
    const providers = Array.isArray(providersResp.data?.data) ? providersResp.data.data : [];
    const lowerCandidates = candidates.map((c) => c.toLowerCase());
    const matches = providers.filter((provider) =>
      lowerCandidates.some((c) => c.length > 0 && provider.toLowerCase().includes(c))
    );

    for (const provider of matches.slice(0, 5)) {
      try {
        const specResp = await this.httpClient.get<{
          apis: Record<string, { swaggerUrl?: string; openapiVer?: string }>;
        }>(`${ApiResearcher.APIS_GURU_BASE}/${provider}.json`, { timeout: 8000 });

        for (const entry of Object.values(specResp.data?.apis ?? {})) {
          if (entry?.swaggerUrl) {
            const ver = entry.openapiVer ?? '';
            found.push({
              url: entry.swaggerUrl,
              version: ver || 'unknown',
              format: ver.startsWith('2') ? 'swagger' : ver.startsWith('3') ? 'openapi3' : 'other',
            });
          }
        }
      } catch (error) {
        logger.debug(`apis.guru: no usable spec for provider ${provider} (non-fatal)`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return found;
  }

  /**
   * Probe common documentation URL patterns for a vendor via lightweight
   * HEAD (falling back to GET when HEAD isn't supported) requests. Only
   * URLs that actually resolve (2xx/3xx) are reported.
   */
  private async probeDocUrls(vendor: string): Promise<WebResearchResult['officialDocs']> {
    const v = vendor.toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (!v) return [];

    const candidates = [
      `https://developer.${v}.com`,
      `https://developers.${v}.com`,
      `https://docs.${v}.com`,
      `https://${v}.com/docs`,
      `https://${v}.com/developers`,
      `https://${v}.com/api`,
      `https://api.${v}.com/docs`,
    ];

    const settled = await Promise.allSettled(
      candidates.map(async (url) => ((await this.probeUrlExists(url)) ? url : null))
    );

    return settled
      .filter(
        (r): r is PromiseFulfilledResult<string | null> =>
          r.status === 'fulfilled' && r.value !== null
      )
      .map((r) => ({
        url: r.value as string,
        title: 'Official Documentation',
        type: 'api_reference' as const,
      }));
  }

  /**
   * Check whether a URL resolves to a real page. HEAD first (cheap); if the
   * server rejects HEAD (405/501 — surprisingly common), retry with GET.
   * Never throws — returns false on any network failure.
   */
  private async probeUrlExists(url: string): Promise<boolean> {
    try {
      const head = await this.httpClient.head(url, {
        timeout: 5000,
        validateStatus: () => true,
      });
      if (head.status >= 200 && head.status < 400) return true;
      if (head.status === 405 || head.status === 501) {
        const get = await this.httpClient.get(url, {
          timeout: 5000,
          validateStatus: () => true,
          maxRedirects: 3,
        });
        return get.status >= 200 && get.status < 400;
      }
      return false;
    } catch (error) {
      logger.debug(`Doc URL probe failed for ${url} (non-fatal)`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Analyze existing MCP implementations
   */
  private async analyzeExistingMcps(
    mcps: WebResearchResult['existingMcps']
  ): Promise<DiscoveryResult['existingMcpAnalysis']> {
    if (mcps.length === 0) {
      return { found: false };
    }

    // In production, this would actually fetch and analyze the MCP code
    const bestMcp = mcps[0];

    return {
      found: true,
      url: bestMcp.url,
      coverage: undefined, // Would be calculated from analysis
      gaps: [],
    };
  }

  /**
   * Fetch and parse OpenAPI specifications
   */
  private async fetchAndParseSpecs(
    toolSpec: ToolSpec,
    webResearch: WebResearchResult
  ): Promise<DiscoveredEndpoint[]> {
    const endpoints: DiscoveredEndpoint[] = [];

    for (const spec of webResearch.openApiSpecs) {
      try {
        logger.debug(`Fetching OpenAPI spec from ${spec.url}`);
        const response = await this.httpClient.get(spec.url);
        const parsed = await this.parseOpenApiSpec(response.data);
        endpoints.push(...parsed);
      } catch (error) {
        logger.warn(`Failed to fetch spec from ${spec.url}`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Also try common spec paths if no specs found
    if (endpoints.length === 0 && toolSpec.vendor) {
      const commonPaths = [
        `/api/v1/openapi.json`,
        `/api/openapi.yaml`,
        `/swagger.json`,
        `/api-docs`,
      ];

      for (const path of commonPaths) {
        try {
          const url = `https://api.${toolSpec.vendor.toLowerCase()}.com${path}`;
          const response = await this.httpClient.get(url);
          const parsed = await this.parseOpenApiSpec(response.data);
          if (parsed.length > 0) {
            endpoints.push(...parsed);
            break;
          }
        } catch {
          // Expected to fail for most paths
        }
      }
    }

    return endpoints;
  }

  /**
   * Parse OpenAPI specification into endpoints.
   *
   * Rich IR: merges path-item-level parameters with operation-level ones
   * (operation overrides on name+in conflict), resolves $ref pointers
   * against components.schemas/parameters/requestBodies/responses (surfacing
   * enums that were previously hidden behind a $ref), and resolves
   * op.security (falling back to the spec's global `security`) against
   * components.securitySchemes so each security requirement carries its
   * actual scheme definition, not just a bare scope list.
   */
  private async parseOpenApiSpec(spec: unknown): Promise<DiscoveredEndpoint[]> {
    const endpoints: DiscoveredEndpoint[] = [];

    if (!spec || typeof spec !== 'object') {
      return endpoints;
    }

    const specObj = spec as Record<string, unknown>;
    const paths = specObj.paths as Record<string, unknown> | undefined;

    if (!paths) {
      return endpoints;
    }

    const components = specObj.components as Record<string, unknown> | undefined;
    const securitySchemes = components?.securitySchemes as Record<string, unknown> | undefined;
    const globalSecurity = Array.isArray(specObj.security)
      ? (specObj.security as unknown[])
      : undefined;

    for (const [path, pathItem] of Object.entries(paths)) {
      if (!pathItem || typeof pathItem !== 'object') continue;

      const pathItemObj = pathItem as Record<string, unknown>;
      const pathLevelParams = Array.isArray(pathItemObj.parameters)
        ? (pathItemObj.parameters as unknown[])
        : [];

      const methods = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options'] as const;

      for (const method of methods) {
        const operation = pathItemObj[method];
        if (!operation || typeof operation !== 'object') continue;

        const op = operation as Record<string, unknown>;
        const opLevelParams = Array.isArray(op.parameters) ? (op.parameters as unknown[]) : [];
        const mergedParams = this.mergeParameters(pathLevelParams, opLevelParams, specObj);

        const rawSecurity = Array.isArray(op.security)
          ? (op.security as unknown[])
          : globalSecurity;

        const endpoint: DiscoveredEndpoint = {
          path,
          method: method.toUpperCase() as DiscoveredEndpoint['method'],
          operationId: op.operationId as string | undefined,
          summary: op.summary as string | undefined,
          description: op.description as string | undefined,
          tags: (op.tags as string[]) ?? [],
          parameters: mergedParams,
          requestBody: op.requestBody
            ? this.deepResolveRefs(op.requestBody, specObj)
            : undefined,
          responses: op.responses
            ? (this.deepResolveRefs(op.responses, specObj) as Record<string, unknown>)
            : undefined,
          security: this.resolveSecurityRequirements(rawSecurity, securitySchemes),
          pagination: this.detectPagination(mergedParams),
        };

        // Validate with Zod
        const parsed = DiscoveredEndpointSchema.safeParse(endpoint);
        if (parsed.success) {
          endpoints.push(parsed.data);
        } else {
          logger.debug(`Discarded malformed endpoint ${method.toUpperCase()} ${path}`, {
            error: parsed.error.message,
          });
        }
      }
    }

    logger.debug(`Parsed ${endpoints.length} endpoints from OpenAPI spec`);
    return endpoints;
  }

  /**
   * Resolve a local JSON-pointer $ref (e.g. "#/components/schemas/User")
   * against the root OpenAPI document. Returns undefined if the pointer
   * can't be resolved (including external/remote $refs, which this — a
   * hint-layer parser, not a full resolver — doesn't fetch).
   */
  private resolveJsonPointer(root: Record<string, unknown>, ref: string): unknown {
    if (!ref.startsWith('#/')) return undefined;

    const segments = ref
      .slice(2)
      .split('/')
      .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));

    let node: unknown = root;
    for (const segment of segments) {
      if (node === null || typeof node !== 'object') return undefined;
      node = (node as Record<string, unknown>)[segment];
    }
    return node;
  }

  /**
   * Recursively resolve every $ref inside a node against the root spec.
   * Guards against circular references (common in recursive schemas, e.g. a
   * TreeNode referencing itself) with a per-branch visited-ref set plus a
   * depth cap, so a cyclic schema degrades to a visible `{ $ref, circular:
   * true }` marker instead of a stack overflow.
   */
  private deepResolveRefs(
    node: unknown,
    root: Record<string, unknown>,
    seen: Set<string> = new Set(),
    depth = 0
  ): unknown {
    if (depth > 25 || node === null || typeof node !== 'object') {
      return node;
    }

    if (Array.isArray(node)) {
      return node.map((item) => this.deepResolveRefs(item, root, seen, depth + 1));
    }

    const obj = node as Record<string, unknown>;
    const ref = obj.$ref;
    if (typeof ref === 'string') {
      if (seen.has(ref)) {
        return { $ref: ref, circular: true };
      }
      const resolved = this.resolveJsonPointer(root, ref);
      if (resolved === undefined) {
        return obj; // unresolved/external ref — leave the pointer visible
      }
      const nextSeen = new Set(seen);
      nextSeen.add(ref);
      return this.deepResolveRefs(resolved, root, nextSeen, depth + 1);
    }

    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      out[key] = this.deepResolveRefs(value, root, seen, depth + 1);
    }
    return out;
  }

  /**
   * Resolve op.security (or the spec's global security, when the operation
   * declares none) against components.securitySchemes, so each requirement
   * carries its actual scheme definition alongside its scopes.
   */
  private resolveSecurityRequirements(
    requirements: unknown[] | undefined,
    schemes: Record<string, unknown> | undefined
  ): unknown[] | undefined {
    if (!requirements) return undefined;

    return requirements.map((req) => {
      if (!req || typeof req !== 'object') return req;
      const entries = Object.entries(req as Record<string, unknown>).map(
        ([schemeName, scopes]) => [
          schemeName,
          {
            scopes: Array.isArray(scopes) ? scopes : [],
            scheme: schemes?.[schemeName] ?? null,
          },
        ]
      );
      return Object.fromEntries(entries);
    });
  }

  /**
   * Merge path-item-level parameters with operation-level parameters
   * (operation-level wins on a name+in conflict — this is the OpenAPI
   * override rule), resolving $refs on both.
   */
  private mergeParameters(
    pathLevel: unknown[],
    opLevel: unknown[],
    root: Record<string, unknown>
  ): DiscoveredEndpoint['parameters'] {
    const resolvedPathLevel = this.parseParameters(pathLevel, root);
    const resolvedOpLevel = this.parseParameters(opLevel, root);

    const byKey = new Map<string, DiscoveredEndpoint['parameters'][number]>();
    for (const p of resolvedPathLevel) byKey.set(`${p.in}:${p.name}`, p);
    for (const p of resolvedOpLevel) byKey.set(`${p.in}:${p.name}`, p);
    return Array.from(byKey.values());
  }

  /**
   * Parse parameters from an OpenAPI operation (or path item), resolving
   * $ref'd parameter objects and $ref'd parameter schemas.
   */
  private parseParameters(
    params: unknown[] | undefined,
    root: Record<string, unknown>
  ): DiscoveredEndpoint['parameters'] {
    if (!params || !Array.isArray(params)) {
      return [];
    }

    return params
      .map((p) => this.deepResolveRefs(p, root))
      .filter((p): p is Record<string, unknown> => p !== null && typeof p === 'object')
      .map((p) => ({
        name: String(p.name ?? ''),
        in: (p.in as 'path' | 'query' | 'header' | 'cookie') ?? 'query',
        required: Boolean(p.required),
        schema: p.schema ? this.deepResolveRefs(p.schema, root) : p.schema,
      }));
  }

  /**
   * Detect pagination support from an endpoint's already-merged, deref'd
   * parameter list.
   */
  private detectPagination(
    parameters: DiscoveredEndpoint['parameters']
  ): DiscoveredEndpoint['pagination'] {
    const paramNames = (parameters ?? []).map((p) => p.name.toLowerCase());

    // Check for common pagination patterns
    const hasOffset = paramNames.some((n) => n.includes('offset') || n.includes('skip'));
    const hasLimit = paramNames.some(
      (n) => n.includes('limit') || n.includes('size') || n.includes('count')
    );
    const hasPage = paramNames.some((n) => n.includes('page'));
    const hasCursor = paramNames.some(
      (n) => n.includes('cursor') || n.includes('token') || n.includes('after')
    );

    if (hasCursor) {
      return {
        supported: true,
        style: 'cursor',
        params: paramNames.filter(
          (n) => n.includes('cursor') || n.includes('token') || n.includes('after')
        ),
      };
    }

    if (hasPage) {
      return {
        supported: true,
        style: 'page',
        params: paramNames.filter((n) => n.includes('page')),
      };
    }

    if (hasOffset && hasLimit) {
      return {
        supported: true,
        style: 'offset',
        params: paramNames.filter((n) => n.includes('offset') || n.includes('limit')),
      };
    }

    return { supported: false };
  }

  /**
   * Extract authentication schemes
   */
  private async extractAuthSchemes(
    toolSpec: ToolSpec,
    _webResearch: WebResearchResult
  ): Promise<DiscoveryResult['authSchemes']> {
    // Map from tool auth type to detailed schemes
    const schemes: DiscoveryResult['authSchemes'] = [];

    switch (toolSpec.authType) {
      case 'oauth2':
        schemes.push({
          type: 'oauth2',
          name: 'OAuth 2.0',
          description: 'OAuth 2.0 authentication flow',
        });
        break;
      case 'api_key':
        schemes.push({
          type: 'apiKey',
          name: 'API Key',
          description: 'API key authentication (header or query parameter)',
        });
        break;
      case 'bearer':
        schemes.push({
          type: 'http',
          name: 'Bearer Token',
          description: 'HTTP Bearer authentication',
        });
        break;
      case 'basic':
        schemes.push({
          type: 'http',
          name: 'Basic Auth',
          description: 'HTTP Basic authentication',
        });
        break;
      case 'custom':
        schemes.push({
          type: 'custom',
          name: 'Custom Authentication',
          description: 'Vendor-specific authentication (see documentation)',
        });
        break;
    }

    return schemes;
  }

  /**
   * Determine rate limits from documentation, spec extensions, live response
   * headers, and known API patterns.
   *
   * Priority (highest confidence first):
   *   1. Spec-declared: response `headers` schema examples on a
   *      `x-ratelimit-*`-shaped header, or a numeric hint parsed from a
   *      documented 429 response's text.
   *   2. Live probe: one harmless, read-only GET against a plausible base
   *      URL, matched against PatternEngine.detectRateLimiting's known
   *      header names.
   *   3. Known-vendor pattern (PatternEngine.matchKnownPattern /
   *      KNOWN_PATTERNS) — confirms rate limiting exists even when no
   *      concrete numbers can be recovered from it.
   *   4. Conservative default (unchanged from the original stub) when
   *      nothing above yields information, so ratelimit.py generation stays
   *      safe for fully undocumented, unprobable targets.
   */
  private async determineRateLimits(
    toolSpec: ToolSpec,
    webResearch: WebResearchResult,
    endpoints: DiscoveredEndpoint[]
  ): Promise<DiscoveryResult['rateLimits']> {
    const specLimits = this.extractSpecRateLimits(endpoints);
    if (specLimits) {
      logger.debug(`Rate limits detected from OpenAPI spec for ${toolSpec.name}`, specLimits);
      return specLimits;
    }

    const probedLimits = await this.probeLiveRateLimitHeaders(toolSpec, webResearch);
    if (probedLimits) {
      logger.debug(`Rate limits detected from live probe for ${toolSpec.name}`, probedLimits);
      return probedLimits;
    }

    const candidateNames = [toolSpec.vendor, toolSpec.name].filter(
      (v): v is string => Boolean(v && v.trim())
    );
    for (const name of candidateNames) {
      const matched = this.patternEngine.matchKnownPattern(name);
      if (matched?.rateLimiting.hasRateLimiting) {
        logger.debug(
          `${toolSpec.name} matches known rate-limited pattern "${matched.name}" — ` +
            `no numeric limits recoverable from the pattern, falling back to conservative defaults`
        );
        break;
      }
    }

    return {
      requestsPerSecond: 10,
      requestsPerMinute: 100,
    };
  }

  /**
   * Scan discovered endpoints for spec-declared rate-limit information:
   * first a documented response `headers` entry shaped like a rate-limit
   * ceiling header (schema example/default), then free-text hints in a
   * documented 429 response's description.
   */
  private extractSpecRateLimits(
    endpoints: DiscoveredEndpoint[]
  ): DiscoveryResult['rateLimits'] | null {
    for (const endpoint of endpoints) {
      const responses = endpoint.responses as Record<string, unknown> | undefined;
      if (!responses) continue;
      const fromHeaders = this.extractRateLimitFromResponseHeaders(responses);
      if (fromHeaders) return fromHeaders;
    }

    for (const endpoint of endpoints) {
      const responses = endpoint.responses as Record<string, unknown> | undefined;
      const rateLimited = responses?.['429'] as Record<string, unknown> | undefined;
      const description = [rateLimited?.description, endpoint.description, endpoint.summary]
        .filter((v): v is string => typeof v === 'string')
        .join(' ');

      const fromText = this.parseRateLimitText(description);
      if (fromText) return fromText;
    }

    return null;
  }

  /**
   * Look for a documented response header shaped like a rate-limit ceiling
   * (e.g. `X-RateLimit-Limit`) whose OpenAPI header definition carries a
   * concrete example/default value. The window (second/minute/day) isn't
   * stated by the header name alone; per-minute is the convention most
   * documented APIs (GitHub, Shopify, Datadog) use for this header shape —
   * that assumption is deliberate and documented here, not hidden.
   */
  private extractRateLimitFromResponseHeaders(
    responses: Record<string, unknown>
  ): DiscoveryResult['rateLimits'] | null {
    for (const response of Object.values(responses)) {
      if (!response || typeof response !== 'object') continue;
      const headers = (response as Record<string, unknown>).headers as
        | Record<string, unknown>
        | undefined;
      if (!headers) continue;

      for (const [headerName, headerDef] of Object.entries(headers)) {
        if (!/rate-?limit/i.test(headerName)) continue;
        if (/remaining|reset/i.test(headerName)) continue; // want the ceiling, not a live counter

        if (!headerDef || typeof headerDef !== 'object') continue;
        const headerDefObj = headerDef as Record<string, unknown>;
        const schema = headerDefObj.schema as Record<string, unknown> | undefined;
        const example = headerDefObj.example ?? schema?.example ?? schema?.default;
        const value = Number(example);
        if (Number.isFinite(value) && value > 0) {
          return { requestsPerMinute: value };
        }
      }
    }
    return null;
  }

  private parseRateLimitText(text: string): DiscoveryResult['rateLimits'] | null {
    const match = text.match(ApiResearcher.RATE_LIMIT_TEXT_PATTERN);
    if (!match) return null;

    const value = Number(match[1]);
    if (!Number.isFinite(value) || value <= 0) return null;

    const unit = match[2].toLowerCase();
    if (unit.startsWith('s')) {
      return {
        requestsPerSecond: value,
        requestsPerMinute: value * 60,
        requestsPerDay: value * 86400,
      };
    }
    if (unit.startsWith('m')) {
      return {
        requestsPerMinute: value,
        ...(value >= 60 ? { requestsPerSecond: Math.floor(value / 60) } : {}),
        requestsPerDay: value * 1440,
      };
    }
    if (unit.startsWith('h')) {
      return {
        requestsPerMinute: Math.max(1, Math.floor(value / 60)),
        requestsPerDay: value * 24,
      };
    }
    if (unit.startsWith('d')) {
      return {
        requestsPerMinute: Math.max(1, Math.floor(value / 1440)),
        requestsPerDay: value,
      };
    }
    return null;
  }

  /**
   * Fire one harmless, read-only GET against a plausible base URL and
   * inspect the response headers for rate-limit indicators. Never fatal —
   * a failed probe (network error, no candidate URL) just returns null so
   * the caller falls through to the next detection stage.
   */
  private async probeLiveRateLimitHeaders(
    toolSpec: ToolSpec,
    webResearch: WebResearchResult
  ): Promise<DiscoveryResult['rateLimits'] | null> {
    const candidateUrl = this.guessProbeUrl(toolSpec, webResearch);
    if (!candidateUrl) return null;

    try {
      const response = await this.httpClient.get(candidateUrl, {
        timeout: 5000,
        validateStatus: () => true, // even 401/403 responses carry rate-limit headers
      });

      const headers = Object.fromEntries(
        Object.entries(response.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])
      );

      const detected = this.patternEngine.detectRateLimiting(headers);
      if (!detected.hasRateLimiting) return null;

      const limitValue = detected.limitHeader
        ? Number(headers[detected.limitHeader.toLowerCase()])
        : NaN;
      if (Number.isFinite(limitValue) && limitValue > 0) {
        // As with the spec-header case, per-minute is the most common
        // documented convention for this header shape.
        return { requestsPerMinute: limitValue };
      }

      // Rate limiting is confirmed but no numeric ceiling could be read from
      // the header value. The RateLimits schema has no boolean-only field to
      // record "confirmed, no numbers" — return null so stage 3 (known
      // pattern) still runs, since ratelimit.py needs actual numbers.
      return null;
    } catch (error) {
      logger.debug(`Live rate-limit probe failed for ${candidateUrl} (non-fatal)`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private guessProbeUrl(toolSpec: ToolSpec, webResearch: WebResearchResult): string | null {
    if (webResearch.officialDocs.length > 0) {
      return webResearch.officialDocs[0].url;
    }
    if (toolSpec.vendor) {
      return `https://api.${toolSpec.vendor.toLowerCase()}.com`;
    }
    return null;
  }

  /**
   * Identify gaps between discovered endpoints and existing MCP
   */
  private async identifyGaps(
    endpoints: DiscoveredEndpoint[],
    existingMcp: NonNullable<DiscoveryResult['existingMcpAnalysis']>
  ): Promise<string[]> {
    const gaps: string[] = [];

    // In production, this would compare discovered endpoints against
    // the tools exposed by the existing MCP

    if (endpoints.length === 0) {
      gaps.push('No endpoints discovered - manual spec analysis required');
    }

    // Check for common missing features
    const hasPagination = endpoints.some((e) => e.pagination?.supported);
    if (!hasPagination) {
      gaps.push('No pagination support detected - may need manual implementation');
    }

    return gaps;
  }
}

// Singleton instance
let defaultResearcher: ApiResearcher | null = null;

export function getApiResearcher(): ApiResearcher {
  if (!defaultResearcher) {
    defaultResearcher = new ApiResearcher();
  }
  return defaultResearcher;
}
