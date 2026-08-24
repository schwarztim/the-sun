import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { Broker } from '../src/broker.js';
import { buildHttpServer } from '../src/http-server.js';
import { createLogger } from '../src/logger.js';
import { LifecycleStateStore } from '../src/lifecycle-state.js';
import { classifyListenerState } from '../src/runtime-doctor.js';
import { ServiceRegistry } from '../src/registry.js';
import { TokenStorage, type KeyringAdapter } from '../src/storage.js';
import { propagateTokenToToolHive } from '../src/token-propagation.js';
import { proofEventsFromPropagation, summarizeProof } from '../src/proof-probes.js';
import { TokenValidator } from '../src/validator.js';
import { HermesErrorCode } from '../src/errors.js';
import type { Provider, ServiceRegistration, TokenBundle } from '../src/types.js';

class MemKeyring implements KeyringAdapter {
  private readonly m = new Map<string, string>();
  async setPassword(service: string, account: string, password: string) { this.m.set(`${service}:${account}`, password); }
  async getPassword(service: string, account: string) { return this.m.get(`${service}:${account}`) ?? null; }
  async deletePassword(service: string, account: string) { return this.m.delete(`${service}:${account}`); }
  async findCredentials(service: string) {
    return Array.from(this.m.entries())
      .filter(([key]) => key.startsWith(`${service}:`))
      .map(([key, password]) => ({ account: key.slice(service.length + 1), password }));
  }
}

const nullSink = new Writable({ write(_c, _e, cb) { cb(); } });
const logger = createLogger({ level: 'error', stream: nullSink, pretty: false });
const testDirs: string[] = [];
let app: FastifyInstance | undefined;

function testDataDir(name = 'reliability'): string {
  const dir = path.join(process.cwd(), '.test-data', `${name}-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  testDirs.push(dir);
  return dir;
}

function bundle(overrides: Partial<TokenBundle> = {}): TokenBundle {
  return {
    service: 'ms365',
    scheme: 'graph',
    accessToken: 'old-access-token',
    refreshToken: 'old-refresh-token',
    tokenType: 'Bearer',
    expiresAt: Date.now() + 3_600_000,
    acquiredAt: Date.now() - 120_000,
    ...overrides,
  };
}

function fakeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    name: 'ms365',
    schemes: ['graph'],
    capabilities: {
      headless: true,
      schemes: [{
        scheme: 'graph',
        credentialSource: 'oauth',
        refreshStrategy: 'refresh-token',
        supportsRefresh: true,
        supportsValidation: true,
        validationStrategy: 'service-probe',
      }],
      remediation: { acquire: 'hermes acquire ms365', refresh: 'retry refresh', validate: 'validate token' },
    },
    acquire: vi.fn(async () => bundle({ accessToken: 'acquired-access-token', acquiredAt: Date.now() })),
    refresh: vi.fn(async (_ctx, cached) => ({ ...cached, accessToken: `${cached.accessToken}:refreshed`, acquiredAt: Date.now() })),
    validate: vi.fn(async () => false),
    nextRefreshAt: (b) => new Date(b.expiresAt - 300_000),
    ...overrides,
  };
}

async function makeBroker(provider: Provider, registration: Partial<ServiceRegistration> = {}) {
  const dir = testDataDir('broker-reliability');
  const storage = new TokenStorage(new MemKeyring());
  const registry = new ServiceRegistry(dir);
  const lifecycleStore = new LifecycleStateStore(dir);
  registry.installProvider(provider);
  await registry.registerService({
    name: 'ms365',
    providerName: 'ms365',
    schemes: ['graph'],
    config: {},
    createdAt: Date.now(),
    autoReacquire: false,
    ...registration,
  });
  const validator = new TokenValidator({ policy: 'eager', safetyMarginSec: 300 });
  const broker = new Broker({ storage, registry, validator, logger, dataDir: dir, lifecycleStore });
  return { broker, storage, registry, lifecycleStore };
}

function refreshTokenExpired(aadstsCode = 'AADSTS700084'): Error {
  const err = new Error(`${aadstsCode}: SPA refresh token fixed lifetime elapsed`);
  Object.defineProperty(err, 'name', { value: 'RefreshTokenExpiredError' });
  Object.defineProperty(err, 'aadstsCode', { value: aadstsCode });
  return err;
}

describe('Hermes historical auth reliability evals', () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    if (app) {
      await app.close();
      app = undefined;
    }
    while (testDirs.length > 0) rmSync(testDirs.pop()!, { recursive: true, force: true });
  });

  it('classifies expired SPA refresh tokens as auth-required, records cooldown, and does not reacquire', async () => {
    const provider = fakeProvider({ refresh: vi.fn(async () => { throw refreshTokenExpired('AADSTS700084'); }) });
    const { broker, storage, lifecycleStore } = await makeBroker(provider);
    // Use expired AT so cooldown fires (cached-valid-AT path bypasses cooldown).
    await storage.set(bundle({ expiresAt: Date.now() - 1000 }));

    await expect(broker.getToken('ms365', 'graph')).rejects.toMatchObject({
      code: HermesErrorCode.INTERACTIVE_AUTH_REQUIRED,
      category: 'auth-required',
      retryable: false,
      remediationCommands: ['hermes acquire ms365'],
    });
    expect(provider.acquire).not.toHaveBeenCalled();
    expect(await lifecycleStore.get('ms365', 'graph')).toMatchObject({
      lastErrorCode: HermesErrorCode.INTERACTIVE_AUTH_REQUIRED,
      lastErrorMessage: expect.stringContaining('AADSTS700084'),
      cooldownUntil: expect.any(Number),
    });
    await expect(broker.getToken('ms365', 'graph')).rejects.toThrow('cooldown active');
    expect(provider.refresh).toHaveBeenCalledTimes(1);
  });

  it('puts identical refresh credentials into auth-required cooldown with exact remediation', async () => {
    const provider = fakeProvider({ refresh: vi.fn(async (_ctx, cached) => ({ ...cached })) });
    const { broker, storage, lifecycleStore } = await makeBroker(provider);
    await storage.set(bundle({ expiresAt: Date.now() - 1000 }));

    await expect(broker.getToken('ms365', 'graph')).rejects.toMatchObject({
      code: HermesErrorCode.INTERACTIVE_AUTH_REQUIRED,
      message: expect.stringContaining('identical credentials'),
      remediationCommands: ['hermes acquire ms365'],
    });
    expect(provider.acquire).not.toHaveBeenCalled();
    expect((await lifecycleStore.get('ms365', 'graph'))?.cooldownUntil).toBeGreaterThan(Date.now());
    await expect(broker.getToken('ms365', 'graph')).rejects.toThrow('cooldown active');
  });

  it('treats scheduled refresh failures as retryable and never falls back to acquire/browser storms', async () => {
    const provider = fakeProvider({ refresh: vi.fn(async () => { throw new Error('scheduled refresh upstream timeout'); }) });
    const { broker, storage, lifecycleStore } = await makeBroker(provider);
    await storage.set(bundle());

    await expect(broker.getToken('ms365', 'graph', { refresh: true })).rejects.toMatchObject({
      code: HermesErrorCode.REFRESH_FAILED,
      category: 'transient',
      retryable: true,
    });
    expect(provider.acquire).not.toHaveBeenCalled();
    expect(await lifecycleStore.get('ms365', 'graph')).toMatchObject({
      lastErrorCode: HermesErrorCode.REFRESH_FAILED,
      lastErrorMessage: expect.stringContaining('scheduled refresh failed'),
    });
  });

  it('marks ToolHive/gateway drift and downstream MCP smoke failures as degraded propagation proof', async () => {
    const provider = fakeProvider();
    const { lifecycleStore, registry } = await makeBroker(provider, {
      thvSecretPrefix: 'MS365',
      thvContainerName: 'ms365-mcp',
    });
    const fleetSync = {
      syncNow: vi.fn(async () => ({
        changed: false,
        backends: 1,
        configHash: 'same-hash',
        configPath: '.test-data/config.generated.json',
        containerNames: ['ms365-mcp'],
        gatewayReload: { status: 'non_ok' as const, at: 1_700_000_004_000, httpStatus: 503 },
      })),
    };
    const smokeProbe = vi.fn(async () => ({
      initialized: true,
      sessionEstablished: true,
      toolsListed: false,
      toolCount: 0,
    }));

    const result = await propagateTokenToToolHive(bundle({ accessToken: 'secret-access-token' }), {
      registry,
      lifecycleStore,
      logger,
      thvStorage: {
        writeToken: vi.fn(async (secretName, token) => ({
          secretName,
          writtenAt: 1_700_000_001_000,
          tokenType: token.tokenType,
          expiresAt: token.expiresAt,
          hasRefreshToken: Boolean(token.refreshToken),
        })),
        restartContainer: vi.fn(async (containerName) => ({
          containerName,
          restartedAt: 1_700_000_002_000,
          readyAt: 1_700_000_003_000,
          url: 'http://127.0.0.1:4444/mcp',
        })),
      },
      fleetSync,
      smokeProbe,
      now: () => 1_700_000_005_000,
    });

    expect(result.status).toBe('degraded');
    expect(fleetSync.syncNow).toHaveBeenCalledWith({ forceReload: true });
    expect(smokeProbe).toHaveBeenCalledWith('http://127.0.0.1:4444/mcp');
    const state = await lifecycleStore.get('ms365', 'graph');
    expect(state).toMatchObject({
      propagationStatus: 'degraded',
      proofTier: 'propagated',
      proofState: 'degraded',
      propagationEvents: expect.arrayContaining([
        expect.objectContaining({ step: 'gateway_reload', status: 'degraded', metadata: expect.objectContaining({ httpStatus: 503 }) }),
        expect.objectContaining({ step: 'downstream_smoke_probe', status: 'degraded', metadata: expect.objectContaining({ toolsListed: false }) }),
        expect.objectContaining({ step: 'downstream_auth_probe', status: 'skipped' }),
      ]),
    });
    expect(JSON.stringify(state)).not.toContain('secret-access-token');
  });

  it('serves stateless MCP tools/list and degraded auth summary after broker restart/session loss', async () => {
    const lifecycleState = {
      service: 'ms365',
      scheme: 'graph',
      propagationStatus: 'degraded' as const,
      proofTier: 'mcp_validated' as const,
      proofState: 'degraded' as const,
      lastPropagationAt: 1_700_000_000_000,
      propagationEvents: [{ step: 'gateway_reload' as const, status: 'degraded' as const, at: 1_700_000_000_000 }],
    };
    const lifecycleStore = {
      list: vi.fn(async () => [lifecycleState]),
      get: vi.fn(async () => lifecycleState),
    } as unknown as LifecycleStateStore;
    app = buildHttpServer({
      broker: { listServices: vi.fn(async () => ['ms365']) } as unknown as Broker,
      registry: { listProviders: () => [], listServices: () => [] } as unknown as ServiceRegistry,
      clientToken: 'not-used-for-mcp',
      logger,
      lifecycleStore,
    });

    const list = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().result.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'hermes_auth_summary' }),
      expect.objectContaining({ name: 'hermes_token_health' }),
    ]));

    const summary = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      payload: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'hermes_auth_summary', arguments: {} } }),
    });
    const parsedSummary = JSON.parse(summary.json().result.content[0].text);
    expect(parsedSummary).toMatchObject({
      status: 'degraded',
      degradedServices: [expect.objectContaining({ service: 'ms365', propagationStatus: 'degraded' })],
    });

    const tokenHealth = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      payload: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'hermes_token_health', arguments: {} } }),
    });
    const parsedHealth = JSON.parse(tokenHealth.json().result.content[0].text);
    expect(parsedHealth).toMatchObject({
      status: 'degraded',
      tokens: [expect.objectContaining({ service: 'ms365', status: 'unknown' })],
      operator: expect.objectContaining({ status: 'degraded' }),
    });
  });

  it('classifies broker restart orphan listeners without touching credentials', () => {
    const state = classifyListenerState([
      { pid: 9876, ppid: 1, command: 'node /Users/testuser/Projects/hermes/packages/broker/dist/cli.js start' },
    ]);
    expect(state).toMatchObject({
      classification: 'hermes-orphan',
      orphanPids: [9876],
    });
  });

  it('summarizes proof tiers without overclaiming downstream MCP failures', () => {
    const summary = summarizeProof(proofEventsFromPropagation('degraded', [
      { step: 'secret_write', status: 'ok', at: 1 },
      { step: 'container_readiness', status: 'ok', at: 2 },
      { step: 'fleet_sync', status: 'ok', at: 3 },
      { step: 'gateway_reload', status: 'ok', at: 4 },
      { step: 'downstream_smoke_probe', status: 'degraded', at: 5, error: 'tools/list HTTP 500' },
    ], 6));

    expect(summary).toMatchObject({
      currentTier: 'propagated',
      state: 'degraded',
    });
  });
});
