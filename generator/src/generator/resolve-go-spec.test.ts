import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { resolveGoSpecFromName } from './resolve-go-spec.js';
import { endpointsFromDiscovery, generateGoServer, GoServerConfig } from './go-generator.js';

// ---------------------------------------------------------------------------
// Fixtures (inline; served via nock so NO live network is touched)
// ---------------------------------------------------------------------------

const APIS_GURU = 'https://api.apis.guru';
const SPEC_HOST = 'https://specs.example.com';
const SPEC_PATH = '/petstore/openapi.json';

const openapi3Petstore = {
  openapi: '3.0.0',
  info: { title: 'Petstore Public', version: '1.0.0' },
  servers: [{ url: 'https://api.petstore.example/v1' }],
  components: {
    securitySchemes: { key: { type: 'apiKey', in: 'header', name: 'X-API-Key' } },
  },
  paths: {
    '/pets': {
      get: {
        operationId: 'listPets',
        parameters: [{ name: 'limit', in: 'query', required: false }],
      },
    },
    '/pets/{petId}': {
      parameters: [{ name: 'petId', in: 'path', required: true }],
      get: { operationId: 'getPet' },
    },
  },
};

/** Wire up the two-step apis.guru lookup for a provider that matches `name`. */
function mockApisGuruHit(providerDomain: string, swaggerUrl: string, otherProviders: string[] = []) {
  nock(APIS_GURU)
    .get('/v2/providers.json')
    .reply(200, { data: [...otherProviders, providerDomain] });
  nock(APIS_GURU)
    .get(`/v2/${providerDomain}.json`)
    .reply(200, { apis: { 'v1': { swaggerUrl, openapiVer: '3.0.0' } } });
}

describe('resolveGoSpecFromName', () => {
  beforeEach(() => nock.cleanAll());
  afterEach(() => nock.cleanAll());

  it('resolves a bare name to a discovery-result via apis.guru + spec fetch', async () => {
    mockApisGuruHit('petstore.example.com', `${SPEC_HOST}${SPEC_PATH}`);
    nock(SPEC_HOST)
      .get(SPEC_PATH)
      .reply(200, JSON.stringify(openapi3Petstore), { 'Content-Type': 'application/json' });

    const { discovery, warnings, specUrl } = await resolveGoSpecFromName('petstore');

    expect(discovery).not.toBeNull();
    expect(specUrl).toBe(`${SPEC_HOST}${SPEC_PATH}`);
    expect(discovery!.baseUrl).toBe('https://api.petstore.example/v1');
    expect(discovery!.authScheme).toBe('api_key');
    expect(discovery!.apiKeyHeader).toBe('X-API-Key');
    expect(discovery!.endpoints).toHaveLength(2);

    // Endpoints carry per-param `in` (path/query), so the Go path consumes them.
    const getPet = discovery!.endpoints.find((e) => e.operationId === 'getPet')!;
    expect(getPet.parameters!.some((p) => p.name === 'petId' && p.in === 'path')).toBe(true);
    // No fatal warnings on the happy path.
    expect(warnings.join(' ')).not.toMatch(/no OpenAPI spec found/i);
  });

  it('feeds the resolved discovery-result through the SAME Go path (compilable output)', async () => {
    mockApisGuruHit('petstore.example.com', `${SPEC_HOST}${SPEC_PATH}`);
    nock(SPEC_HOST)
      .get(SPEC_PATH)
      .reply(200, JSON.stringify(openapi3Petstore), { 'Content-Type': 'application/json' });

    const { discovery } = await resolveGoSpecFromName('petstore');
    expect(discovery).not.toBeNull();

    // Mirror exactly what emitGoServer does with a discovery-result input.
    const goEndpoints = endpointsFromDiscovery(discovery!.endpoints);
    expect(goEndpoints).toHaveLength(2);

    const config: GoServerConfig = {
      name: discovery!.name,
      version: discovery!.version ?? 'dev',
      baseUrl: discovery!.baseUrl,
      authScheme: discovery!.authScheme,
      authEnvPrefix: discovery!.authEnvPrefix,
      apiKeyHeader: discovery!.apiKeyHeader,
      apiKeyQueryParam: discovery!.apiKeyQueryParam,
      endpoints: goEndpoints,
    };
    const { files } = generateGoServer(config);
    expect(files['main.go']).toBeTruthy();
    expect(files['main.go'].length).toBeGreaterThan(100);
    expect(files['go.mod']).toContain('module');
    expect((files['main.go'].match(/AddTool/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('parses a YAML spec served by apis.guru', async () => {
    const yamlSpec = [
      'openapi: 3.0.0',
      'info:',
      '  title: YAML Widgets',
      '  version: "1.0"',
      'servers:',
      '  - url: https://api.widgets.example',
      'paths:',
      '  /widgets:',
      '    get:',
      '      operationId: listWidgets',
    ].join('\n');
    mockApisGuruHit('widgets.example.com', `${SPEC_HOST}/widgets.yaml`);
    nock(SPEC_HOST)
      .get('/widgets.yaml')
      .reply(200, yamlSpec, { 'Content-Type': 'application/yaml' });

    const { discovery } = await resolveGoSpecFromName('widgets');
    expect(discovery).not.toBeNull();
    expect(discovery!.name).toBe('widgets');
    expect(discovery!.baseUrl).toBe('https://api.widgets.example');
    expect(discovery!.endpoints).toHaveLength(1);
  });

  it('returns discovery=null with a graceful message when apis.guru has no match', async () => {
    nock(APIS_GURU)
      .get('/v2/providers.json')
      .reply(200, { data: ['github.com', 'stripe.com'] });

    const { discovery, warnings } = await resolveGoSpecFromName('zzznotarealapi');

    expect(discovery).toBeNull();
    expect(warnings.join(' ')).toMatch(/no OpenAPI spec found for zzznotarealapi/i);
  });

  it('returns discovery=null (no empty server) when the matched spec is not an OpenAPI doc', async () => {
    mockApisGuruHit('junk.example.com', `${SPEC_HOST}/junk.json`);
    nock(SPEC_HOST)
      .get('/junk.json')
      .reply(200, JSON.stringify({ foo: 'bar' }), { 'Content-Type': 'application/json' });

    const { discovery, warnings } = await resolveGoSpecFromName('junk');

    expect(discovery).toBeNull();
    expect(warnings.join(' ')).toMatch(/not an OpenAPI\/Swagger document|No usable endpoints/i);
  });

  it('records a warning and returns null when the spec fetch fails', async () => {
    mockApisGuruHit('broken.example.com', `${SPEC_HOST}/broken.json`);
    nock(SPEC_HOST).get('/broken.json').reply(500);

    const { discovery, warnings } = await resolveGoSpecFromName('broken');

    expect(discovery).toBeNull();
    expect(warnings.join(' ')).toMatch(/Failed to fetch or convert|No usable endpoints/i);
  });

  it('returns null on an empty name without touching the network', async () => {
    const { discovery, warnings } = await resolveGoSpecFromName('   ');
    expect(discovery).toBeNull();
    expect(warnings.join(' ')).toMatch(/empty name/i);
  });
});

// ---------------------------------------------------------------------------
// Regression: the --file path (GEN-4) is unaffected by the GEN-5 refactor.
// Runs the compiled CLI against a local discovery-result JSON with --dry-run.
// Fully offline (no name discovery, no network).
// ---------------------------------------------------------------------------

describe('CLI --file path regression (offline)', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '..', '..');
  const cliEntry = path.join(repoRoot, 'dist', 'cli', 'index.js');
  let tmpDir: string;
  let specFile: string;

  beforeAll(() => {
    // tsc is offline; ensure the compiled CLI exists for the subprocess.
    execFileSync('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'pipe' });
  }, 120_000);

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen5-file-regression-'));
    specFile = path.join(tmpDir, 'discovery.json');
    fs.writeFileSync(
      specFile,
      JSON.stringify({
        name: 'shodan',
        baseUrl: 'https://api.shodan.io',
        authScheme: 'api_key',
        apiKeyQueryParam: 'key',
        endpoints: [
          {
            method: 'GET',
            path: '/api-info',
            operationId: 'apiInfo',
            parameters: [{ name: 'key', in: 'query', required: true }],
          },
        ],
      }),
    );
  });

  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('still generates from a discovery-result --file (dry-run), no network', () => {
    const out = execFileSync('node', [cliEntry, 'generate', '--lang', 'go', '--file', specFile, '--dry-run'], {
      cwd: tmpDir,
      encoding: 'utf-8',
    });
    expect(out).toMatch(/Go target: shodan-mcp/);
    expect(out).toMatch(/Endpoints → tools: 1/);
    expect(out).toMatch(/main\.go/);
  });
});
