import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { openApiToDiscovery, isOpenApiDocument } from './openapi-to-discovery.js';
import { endpointsFromDiscovery, generateGoServer, GoServerConfig } from './go-generator.js';

// ---------------------------------------------------------------------------
// Fixtures (inline, deterministic, no network)
// ---------------------------------------------------------------------------

const openapi3Petstore = {
  openapi: '3.0.3',
  info: { title: 'Petstore API', version: '1.2.3' },
  servers: [{ url: 'https://api.petstore.example/v1/' }],
  components: {
    securitySchemes: {
      apiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
    },
    parameters: {
      LimitParam: { name: 'limit', in: 'query', required: false, description: 'max items' },
    },
  },
  paths: {
    '/pets': {
      get: {
        operationId: 'listPets',
        summary: 'List pets',
        parameters: [{ $ref: '#/components/parameters/LimitParam' }],
      },
      post: { operationId: 'createPet', summary: 'Create a pet' },
    },
    '/pets/{petId}': {
      parameters: [{ name: 'petId', in: 'path', required: true, description: 'pet id' }],
      get: { operationId: 'getPet', summary: 'Get a pet' },
      delete: { summary: 'Delete a pet' }, // no operationId -> synthesized name
    },
  },
};

const swagger2Spec = {
  swagger: '2.0',
  info: { title: 'Widget Service', version: '1.0.0' },
  host: 'widgets.example.com',
  basePath: '/api',
  schemes: ['https'],
  securityDefinitions: {
    bearerToken: { type: 'apiKey', name: 'Authorization', in: 'header' },
  },
  paths: {
    '/widgets': {
      get: {
        operationId: 'listWidgets',
        parameters: [{ name: 'q', in: 'query', required: false }],
      },
    },
  },
};

// ---------------------------------------------------------------------------
// isOpenApiDocument
// ---------------------------------------------------------------------------

describe('isOpenApiDocument', () => {
  it('is true for an OpenAPI 3.x document with paths', () => {
    expect(isOpenApiDocument(openapi3Petstore)).toBe(true);
  });

  it('is true for a Swagger 2.0 document with paths', () => {
    expect(isOpenApiDocument(swagger2Spec)).toBe(true);
  });

  it('is false for a version field without paths', () => {
    expect(isOpenApiDocument({ openapi: '3.0.0' })).toBe(false);
  });

  it('is false for a discovery-result (regression guard: converter not applied)', () => {
    const discoveryResult = {
      name: 'shodan',
      baseUrl: 'https://api.shodan.io',
      authScheme: 'api_key',
      endpoints: [{ method: 'GET', path: '/api-info', parameters: [{ name: 'key', in: 'query' }] }],
    };
    expect(isOpenApiDocument(discoveryResult)).toBe(false);
  });

  it('is false for a GoServerConfig (regression guard: converter not applied)', () => {
    const goConfig = {
      name: 'shodan',
      baseUrl: 'https://api.shodan.io',
      authScheme: 'api_key',
      apiKeyQueryParam: 'key',
      endpoints: [{ method: 'GET', path: '/api-info', operationId: 'apiInfo' }],
    };
    expect(isOpenApiDocument(goConfig)).toBe(false);
  });

  it('is false for null / non-object input', () => {
    expect(isOpenApiDocument(null)).toBe(false);
    expect(isOpenApiDocument('openapi')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// openApiToDiscovery — OpenAPI 3.x
// ---------------------------------------------------------------------------

describe('openApiToDiscovery — OpenAPI 3.x', () => {
  const result = openApiToDiscovery(openapi3Petstore);

  it('slugs the name from info.title', () => {
    expect(result.name).toBe('petstore-api');
  });

  it('derives baseUrl from servers[0].url with the trailing slash stripped', () => {
    expect(result.baseUrl).toBe('https://api.petstore.example/v1');
  });

  it('maps an apiKey-in-header scheme to api_key + apiKeyHeader', () => {
    expect(result.authScheme).toBe('api_key');
    expect(result.apiKeyHeader).toBe('X-API-Key');
    expect(result.apiKeyQueryParam).toBeUndefined();
  });

  it('sets a namespaced authEnvPrefix from the slug', () => {
    expect(result.authEnvPrefix).toBe('PETSTORE_API');
  });

  it('emits one endpoint per (path, method) for supported methods', () => {
    // /pets GET, /pets POST, /pets/{petId} GET, /pets/{petId} DELETE = 4
    expect(result.endpoints).toHaveLength(4);
    const keys = result.endpoints.map((e) => `${e.method} ${e.path}`).sort();
    expect(keys).toEqual(['DELETE /pets/{petId}', 'GET /pets', 'GET /pets/{petId}', 'POST /pets']);
  });

  it('prefers operationId and synthesizes a name when missing', () => {
    const del = result.endpoints.find((e) => e.method === 'DELETE')!;
    expect(del.operationId).toBe('delete_pets_petid');
    const list = result.endpoints.find((e) => e.operationId === 'listPets')!;
    expect(list).toBeDefined();
  });

  it('resolves a local $ref query parameter', () => {
    const list = result.endpoints.find((e) => e.operationId === 'listPets')!;
    const limit = list.parameters!.find((p) => p.name === 'limit')!;
    expect(limit).toMatchObject({ name: 'limit', in: 'query', required: false });
  });

  it('merges path-level params into each operation and marks path params required', () => {
    const getPet = result.endpoints.find((e) => e.operationId === 'getPet')!;
    const petId = getPet.parameters!.find((p) => p.name === 'petId')!;
    expect(petId).toMatchObject({ name: 'petId', in: 'path', required: true });
  });

  it('carries `in` values of only path/query (header/cookie dropped)', () => {
    for (const ep of result.endpoints) {
      for (const p of ep.parameters ?? []) {
        expect(['path', 'query']).toContain(p.in);
      }
    }
  });

  it('honors an explicit opts.name override', () => {
    const named = openApiToDiscovery(openapi3Petstore, { name: 'My Pets!' });
    expect(named.name).toBe('my-pets');
    expect(named.authEnvPrefix).toBe('MY_PETS');
  });
});

// ---------------------------------------------------------------------------
// openApiToDiscovery — Swagger 2.0
// ---------------------------------------------------------------------------

describe('openApiToDiscovery — Swagger 2.0', () => {
  const result = openApiToDiscovery(swagger2Spec);

  it('derives baseUrl from schemes + host + basePath', () => {
    expect(result.baseUrl).toBe('https://widgets.example.com/api');
  });

  it('maps an apiKey-in-header securityDefinition to api_key + apiKeyHeader', () => {
    expect(result.authScheme).toBe('api_key');
    expect(result.apiKeyHeader).toBe('Authorization');
  });

  it('emits the single widgets endpoint with its query param', () => {
    expect(result.endpoints).toHaveLength(1);
    const ep = result.endpoints[0];
    expect(ep).toMatchObject({ method: 'GET', path: '/widgets', operationId: 'listWidgets' });
    expect(ep.parameters).toEqual([{ name: 'q', in: 'query', required: false, description: undefined }]);
  });
});

// ---------------------------------------------------------------------------
// Auth mapping variants
// ---------------------------------------------------------------------------

describe('openApiToDiscovery — auth scheme mapping', () => {
  const baseSpec = (securitySchemes: Record<string, unknown>) => ({
    openapi: '3.0.0',
    info: { title: 'x', version: '1' },
    servers: [{ url: 'https://x.example' }],
    components: { securitySchemes },
    paths: { '/ping': { get: { operationId: 'ping' } } },
  });

  it('maps http+bearer to bearer', () => {
    expect(openApiToDiscovery(baseSpec({ b: { type: 'http', scheme: 'bearer' } })).authScheme).toBe('bearer');
  });

  it('maps http+basic to basic', () => {
    expect(openApiToDiscovery(baseSpec({ b: { type: 'http', scheme: 'basic' } })).authScheme).toBe('basic');
  });

  it('maps apiKey-in-query to api_key + apiKeyQueryParam', () => {
    const r = openApiToDiscovery(baseSpec({ k: { type: 'apiKey', in: 'query', name: 'api_key' } }));
    expect(r.authScheme).toBe('api_key');
    expect(r.apiKeyQueryParam).toBe('api_key');
    expect(r.apiKeyHeader).toBeUndefined();
  });

  it('maps oauth2 to bearer', () => {
    expect(openApiToDiscovery(baseSpec({ o: { type: 'oauth2', flows: {} } })).authScheme).toBe('bearer');
  });

  it('defaults to none when no security schemes are present', () => {
    const r = openApiToDiscovery({
      openapi: '3.0.0',
      info: { title: 'x', version: '1' },
      servers: [{ url: 'https://x.example' }],
      paths: { '/ping': { get: { operationId: 'ping' } } },
    });
    expect(r.authScheme).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// Defensive behavior
// ---------------------------------------------------------------------------

describe('openApiToDiscovery — defensive', () => {
  it('skips an unresolvable $ref parameter without crashing', () => {
    const spec = {
      openapi: '3.0.0',
      info: { title: 'x', version: '1' },
      servers: [{ url: 'https://x.example' }],
      paths: {
        '/thing': {
          get: {
            operationId: 'getThing',
            parameters: [
              { $ref: '#/components/parameters/DoesNotExist' },
              { name: 'ok', in: 'query', required: false },
            ],
          },
        },
      },
    };
    const r = openApiToDiscovery(spec);
    const ep = r.endpoints[0];
    // The unresolvable ref is skipped; the valid param survives.
    expect(ep.parameters).toEqual([{ name: 'ok', in: 'query', required: false, description: undefined }]);
  });

  it('throws on a spec with no operations', () => {
    expect(() =>
      openApiToDiscovery({
        openapi: '3.0.0',
        info: { title: 'empty', version: '1' },
        servers: [{ url: 'https://x.example' }],
        paths: { '/thing': {} },
      }),
    ).toThrow(/no operations/i);
  });

  it('throws on a non-OpenAPI object', () => {
    expect(() => openApiToDiscovery({ foo: 'bar' })).toThrow(/OpenAPI|Swagger/);
  });

  it('throws on a non-object spec', () => {
    expect(() => openApiToDiscovery(null)).toThrow(/not an object/i);
  });
});

// ---------------------------------------------------------------------------
// YAML parsing (the format OpenAPI specs are usually shipped in)
// ---------------------------------------------------------------------------

describe('openApiToDiscovery — YAML input', () => {
  const yamlSpec = `
openapi: 3.0.0
info:
  title: YAML Sample
  version: "1.0"
servers:
  - url: https://yaml.example.com
paths:
  /items:
    get:
      operationId: listItems
      parameters:
        - name: page
          in: query
          required: false
`;

  it('parses a YAML spec string and converts it', () => {
    const parsed = parseYaml(yamlSpec);
    expect(isOpenApiDocument(parsed)).toBe(true);
    const r = openApiToDiscovery(parsed);
    expect(r.name).toBe('yaml-sample');
    expect(r.baseUrl).toBe('https://yaml.example.com');
    expect(r.endpoints).toHaveLength(1);
    expect(r.endpoints[0]).toMatchObject({ method: 'GET', path: '/items', operationId: 'listItems' });
  });
});

// ---------------------------------------------------------------------------
// End-to-end: converted output feeds the SAME path the CLI uses
// ---------------------------------------------------------------------------

describe('openApiToDiscovery — end-to-end into the Go generator', () => {
  it('endpointsFromDiscovery accepts the converted endpoints and yields the expected count', () => {
    const result = openApiToDiscovery(openapi3Petstore);
    const goEndpoints = endpointsFromDiscovery(result.endpoints);
    expect(goEndpoints).toHaveLength(4);

    // Path params surface as pathParams; query params as queryParams objects.
    const getPet = goEndpoints.find((e) => e.operationId === 'getPet')!;
    expect(getPet.pathParams).toEqual(['petId']);
    const listPets = goEndpoints.find((e) => e.operationId === 'listPets')!;
    expect(listPets.queryParams).toEqual([{ name: 'limit', required: false, description: 'max items' }]);
  });

  it('generateGoServer produces a non-empty main.go + go.mod from the converted spec', () => {
    // Mirror exactly what runGoGeneration does with a discovery-result input.
    const result = openApiToDiscovery(openapi3Petstore);
    const config: GoServerConfig = {
      name: result.name,
      version: result.version ?? 'dev',
      baseUrl: result.baseUrl,
      // Petstore fixture baseUrl already includes a path; ensure https for the generator.
      authScheme: result.authScheme,
      authEnvPrefix: result.authEnvPrefix,
      apiKeyHeader: result.apiKeyHeader,
      apiKeyQueryParam: result.apiKeyQueryParam,
      endpoints: endpointsFromDiscovery(result.endpoints),
    };
    const { files } = generateGoServer(config);
    expect(files['main.go']).toBeTruthy();
    expect(files['main.go'].length).toBeGreaterThan(100);
    expect(files['go.mod']).toContain('module');
    // One tool registered per endpoint (4).
    expect((files['main.go'].match(/AddTool/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });
});
