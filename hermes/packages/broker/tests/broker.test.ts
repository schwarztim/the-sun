import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Writable } from 'node:stream';
import { Broker } from '../src/broker.js';
import { TokenStorage, type KeyringAdapter } from '../src/storage.js';
import { TokenValidator } from '../src/validator.js';
import { ServiceRegistry } from '../src/registry.js';
import { createLogger } from '../src/logger.js';
import { HermesErrorCode } from '../src/errors.js';
import { LifecycleStateStore } from '../src/lifecycle-state.js';
import type { Provider, ServiceRegistration, TokenBundle } from '../src/types.js';
import { ConditionalAccessChallengeError, classifyConditionalAccessChallenge } from '@hermes/auth-core';

class MemKeyring implements KeyringAdapter {
  m = new Map<string, string>();
  async setPassword(s: string, a: string, p: string) { this.m.set(`${s}:${a}`, p); }
  async getPassword(s: string, a: string) { return this.m.get(`${s}:${a}`) ?? null; }
  async deletePassword(s: string, a: string) { return this.m.delete(`${s}:${a}`); }
  async findCredentials(s: string) {
    return Array.from(this.m.entries()).filter(([k]) => k.startsWith(`${s}:`))
      .map(([k, password]) => ({ account: k.slice(s.length + 1), password }));
  }
}

const nullSink = new Writable({ write(_c, _e, cb) { cb(); } });
const logger = createLogger({ level: 'error', stream: nullSink, pretty: false });

const fakeBundle = (overrides: Partial<TokenBundle> = {}): TokenBundle => ({
  service: 'ms365', scheme: 'graph', accessToken: 'abc', tokenType: 'Bearer',
  expiresAt: Date.now() + 3600_000, acquiredAt: Date.now(), ...overrides,
});

const testDirs: string[] = [];
function testDataDir(): string {
  const dir = path.join(process.cwd(), '.test-data', `broker-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  testDirs.push(dir);
  return dir;
}

function fakeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    name: 'ms365', schemes: ['graph'],
    acquire: vi.fn(async () => fakeBundle()),
    refresh: vi.fn(async (_c, b) => ({ ...b, accessToken: b.accessToken + '+refreshed' })),
    validate: vi.fn(async () => true),
    nextRefreshAt: (b) => new Date(b.expiresAt - 300_000),
    ...overrides,
  };
}

async function makeBroker(provider: Provider, overrides: Partial<ServiceRegistration> = {}) {
  const dir = testDataDir();
  const storage = new TokenStorage(new MemKeyring());
  const registry = new ServiceRegistry(dir);
  registry.installProvider(provider);
  await registry.registerService({ name: 'ms365', providerName: 'ms365', schemes: ['graph'], config: {}, createdAt: Date.now(), ...overrides });
  const validator = new TokenValidator({ policy: 'eager', safetyMarginSec: 300 });
  return { broker: new Broker({ storage, registry, validator, logger, dataDir: dir }), storage };
}

async function makeBrokerFor(service: string, scheme: string, provider: Provider, registration: Partial<ServiceRegistration> = {}) {
  const dir = testDataDir();
  const lifecycleStore = new LifecycleStateStore(dir);
  const storage = new TokenStorage(new MemKeyring());
  const registry = new ServiceRegistry(dir);
  registry.installProvider(provider);
  await registry.registerService({ name: service, providerName: provider.name, schemes: [scheme], config: {}, createdAt: Date.now(), ...registration });
  const validator = new TokenValidator({ policy: 'eager', safetyMarginSec: 300 });
  const broker = new Broker({ storage, registry, validator, logger, dataDir: dir, lifecycleStore });
  return { broker, storage, lifecycleStore };
}

describe('Broker.getToken', () => {
  afterEach(() => {
    while (testDirs.length > 0) rmSync(testDirs.pop()!, { recursive: true, force: true });
  });

  it('acquires when nothing is cached', async () => {
    const p = fakeProvider();
    const { broker } = await makeBroker(p);
    const token = await broker.getToken('ms365', 'graph');
    expect(token.accessToken).toBe('abc');
    expect(p.acquire).toHaveBeenCalledOnce();
  });

  it('wraps provider Conditional Access challenges with structured remediation', async () => {
    const challenge = classifyConditionalAccessChallenge({
      text: 'You cannot access this right now',
      service: 'ms365',
      acquireCommand: 'hermes acquire ms365',
    });
    expect(challenge).toBeDefined();
    const p = fakeProvider({
      acquire: vi.fn(async () => { throw new ConditionalAccessChallengeError(challenge!); }),
    });
    const { broker } = await makeBroker(p);

    await expect(broker.getToken('ms365', 'graph')).rejects.toMatchObject({
      code: HermesErrorCode.ACQUIRE_REQUIRED,
      remediationCommands: ['hermes acquire ms365'],
      conditionalAccessChallenge: expect.objectContaining({
        state: 'policy_blocks_headless',
      }),
    });
  });

  it('returns cached token when fresh and valid', async () => {
    const p = fakeProvider();
    const { broker } = await makeBroker(p);
    await broker.getToken('ms365', 'graph');
    await broker.getToken('ms365', 'graph');
    expect(p.acquire).toHaveBeenCalledOnce();
  });
  it('refreshes when validate returns false', async () => {
    let call = 0;
    const p = fakeProvider({ validate: vi.fn(async () => { call++; return call > 1; }) });
    const { broker, storage } = await makeBroker(p);
    await storage.set(fakeBundle({ acquiredAt: Date.now() - 120_000, expiresAt: Date.now() - 1000 }));
    const token = await broker.getToken('ms365', 'graph');
    expect(p.refresh).toHaveBeenCalledOnce();
    expect(token.accessToken).toContain('refreshed');
  });
  it('refreshes cached tokens when refresh option is set even if validate would pass', async () => {
    const p = fakeProvider({ validate: vi.fn(async () => true) });
    const { broker, storage } = await makeBroker(p);
    await storage.set(fakeBundle({ acquiredAt: Date.now() - 120_000, expiresAt: Date.now() - 1000 }));
    const token = await broker.getToken('ms365', 'graph', { refresh: true });
    expect(p.validate).not.toHaveBeenCalled();
    expect(p.refresh).toHaveBeenCalledOnce();
    expect(token.accessToken).toContain('refreshed');
  });
  it('falls back to acquire when refresh throws', async () => {
    const p = fakeProvider({
      validate: vi.fn(async () => false),
      refresh: vi.fn(async () => { throw new Error('refresh dead'); }),
    });
    const { broker, storage } = await makeBroker(p);
    await storage.set(fakeBundle({ acquiredAt: Date.now() - 120_000, expiresAt: Date.now() - 1000 }));
    const token = await broker.getToken('ms365', 'graph');
    expect(p.acquire).toHaveBeenCalledOnce();
    expect(token.accessToken).toBe('abc');
  });
  it('does not fall back to acquire when scheduled refresh throws', async () => {
    const p = fakeProvider({
      validate: vi.fn(async () => true),
      refresh: vi.fn(async () => { throw new Error('refresh dead'); }),
    });
    const { broker, storage } = await makeBroker(p);
    await storage.set(fakeBundle({ acquiredAt: Date.now() - 120_000, expiresAt: Date.now() - 1000 }));
    await expect(broker.getToken('ms365', 'graph', { refresh: true })).rejects.toThrow('scheduled refresh failed');
    expect(p.acquire).not.toHaveBeenCalled();
  });
  // BUG B: a fresh capture must never be discarded / mislabeled as a failure
  // because an OPTIONAL downstream propagation (onTokenRefreshed side-effect)
  // throws. The broker stores the refreshed bundle BEFORE invoking the callback,
  // so the fresh session is always persisted, AND the broker now swallows a
  // throwing callback itself, so the refresh also SETTLES as success (re-arm, no
  // disarm bump) regardless of which downstream failed. The cli.ts wrapper
  // covers the ToolHive push specifically; the broker guarantee is general.
  it('BUG B: broker persists the fresh refresh BEFORE onTokenRefreshed runs', async () => {
    const refreshed = fakeBundle({ accessToken: 'fresh-and-valid', acquiredAt: Date.now() });
    const p = fakeProvider({ validate: vi.fn(async () => true), refresh: vi.fn(async () => refreshed) });
    const dir = testDataDir();
    const storage = new TokenStorage(new MemKeyring());
    const registry = new ServiceRegistry(dir);
    registry.installProvider(p);
    await registry.registerService({ name: 'ms365', providerName: 'ms365', schemes: ['graph'], config: {}, createdAt: Date.now() });
    const validator = new TokenValidator({ policy: 'eager', safetyMarginSec: 300 });
    let storedAtCallbackTime: TokenBundle | null = null;
    // Simulate the optional ToolHive push THROWING (thv unreachable in launchd).
    const onTokenRefreshed = vi.fn(async () => {
      storedAtCallbackTime = await storage.get('ms365', 'graph');
      throw new Error('Command failed: thv start ms365');
    });
    const broker = new Broker({ storage, registry, validator, logger, dataDir: dir, onTokenRefreshed });
    await storage.set(fakeBundle({ acquiredAt: Date.now() - 120_000, expiresAt: Date.now() - 1000 }));

    // The throwing push no longer fails the refresh: the broker runs the
    // callback outside the capture's success path, so the scheduled refresh
    // settles as SUCCESS and returns the fresh token.
    const token = await broker.getToken('ms365', 'graph', { refresh: true });
    expect(token.accessToken).toBe('fresh-and-valid');
    // The fresh capture was already stored before the callback ran, so it is
    // never lost even if propagation dies mid-flight.
    expect(storedAtCallbackTime).toMatchObject({ accessToken: 'fresh-and-valid' });
    const persisted = await storage.get('ms365', 'graph');
    expect(persisted?.accessToken).toBe('fresh-and-valid');
  });

  it('BUG B: a throwing propagation does not fail an acquire, mark it suspect, or activate a cooldown', async () => {
    const acquired = fakeBundle({ accessToken: 'acquired-and-valid', acquiredAt: Date.now() });
    const p = fakeProvider({ acquire: vi.fn(async () => acquired) });
    const dir = testDataDir();
    const storage = new TokenStorage(new MemKeyring());
    const registry = new ServiceRegistry(dir);
    registry.installProvider(p);
    await registry.registerService({ name: 'ms365', providerName: 'ms365', schemes: ['graph'], config: {}, createdAt: Date.now() });
    const validator = new TokenValidator({ policy: 'eager', safetyMarginSec: 300 });
    const onTokenRefreshed = vi.fn(async () => { throw new Error('downstream propagation exploded'); });
    const broker = new Broker({ storage, registry, validator, logger, dataDir: dir, onTokenRefreshed });

    // Cold acquire (nothing stored) with a propagation that throws.
    const token = await broker.getToken('ms365', 'graph');
    expect(token.accessToken).toBe('acquired-and-valid');
    expect(onTokenRefreshed).toHaveBeenCalledOnce();
    expect((await storage.get('ms365', 'graph'))?.accessToken).toBe('acquired-and-valid');
    // No cooldown was activated, so the very next call is not gated.
    expect(broker.canAttemptAcquire('ms365', 'graph')).toMatchObject({ ok: true });
  });

  it('BUG B: re-arming still happens when a LATER step of the propagation callback throws', async () => {
    const refreshed = fakeBundle({ accessToken: 'fresh-and-valid', acquiredAt: Date.now() });
    const p = fakeProvider({ validate: vi.fn(async () => true), refresh: vi.fn(async () => refreshed) });
    const dir = testDataDir();
    const storage = new TokenStorage(new MemKeyring());
    const registry = new ServiceRegistry(dir);
    registry.installProvider(p);
    await registry.registerService({ name: 'ms365', providerName: 'ms365', schemes: ['graph'], config: {}, createdAt: Date.now() });
    const validator = new TokenValidator({ policy: 'eager', safetyMarginSec: 300 });
    // Mirrors the real cli.ts callback shape: re-arm FIRST, then the optional
    // downstream push. The push throwing must not undo the re-arm.
    const rearmed: string[] = [];
    const onTokenRefreshed = vi.fn(async (b: TokenBundle) => {
      rearmed.push(`${b.service}:${b.scheme}`);
      throw new Error('optional downstream push failed after re-arm');
    });
    const broker = new Broker({ storage, registry, validator, logger, dataDir: dir, onTokenRefreshed });
    await storage.set(fakeBundle({ acquiredAt: Date.now() - 120_000, expiresAt: Date.now() - 1000 }));

    const token = await broker.getToken('ms365', 'graph', { refresh: true });
    expect(token.accessToken).toBe('fresh-and-valid');
    expect(rearmed).toEqual(['ms365:graph']);
  });

  it('BUG B: a non-throwing onTokenRefreshed lets a stored-fresh refresh settle as success', async () => {
    const refreshed = fakeBundle({ accessToken: 'fresh-and-valid', acquiredAt: Date.now() });
    const p = fakeProvider({ validate: vi.fn(async () => true), refresh: vi.fn(async () => refreshed) });
    const dir = testDataDir();
    const storage = new TokenStorage(new MemKeyring());
    const registry = new ServiceRegistry(dir);
    registry.installProvider(p);
    await registry.registerService({ name: 'ms365', providerName: 'ms365', schemes: ['graph'], config: {}, createdAt: Date.now() });
    const validator = new TokenValidator({ policy: 'eager', safetyMarginSec: 300 });
    // The fixed cli.ts wrapper swallows push failures → callback never throws.
    const onTokenRefreshed = vi.fn(async () => { /* optional push failed but was swallowed */ });
    const broker = new Broker({ storage, registry, validator, logger, dataDir: dir, onTokenRefreshed });
    await storage.set(fakeBundle({ acquiredAt: Date.now() - 120_000, expiresAt: Date.now() - 1000 }));

    const token = await broker.getToken('ms365', 'graph', { refresh: true });
    expect(token.accessToken).toBe('fresh-and-valid');
    expect(onTokenRefreshed).toHaveBeenCalledOnce();
  });

  it('coalesces concurrent getToken calls', async () => {
    let acquires = 0;
    const p = fakeProvider({
      acquire: vi.fn(async () => { acquires++; await new Promise((r) => setTimeout(r, 30)); return fakeBundle(); }),
    });
    const { broker } = await makeBroker(p);
    await Promise.all([broker.getToken('ms365', 'graph'), broker.getToken('ms365', 'graph'), broker.getToken('ms365', 'graph')]);
    expect(acquires).toBe(1);
  });
  it('throws SERVICE_NOT_REGISTERED for unknown service', async () => {
    const { broker } = await makeBroker(fakeProvider());
    await expect(broker.getToken('nope', 'graph')).rejects.toThrow(/SERVICE_NOT_REGISTERED/);
  });

  it('calls onTokenRefreshed after acquire', async () => {
    const refreshed: TokenBundle[] = [];
    const p = fakeProvider();
    const dir = testDataDir();
    const storage = new TokenStorage(new MemKeyring());
    const registry = new ServiceRegistry(dir);
    registry.installProvider(p);
    await registry.registerService({ name: 'ms365', providerName: 'ms365', schemes: ['graph'], config: {}, createdAt: Date.now() });
    const validator = new TokenValidator({ policy: 'eager', safetyMarginSec: 300 });
    const broker = new Broker({ storage, registry, validator, logger, dataDir: dir, onTokenRefreshed: async (b) => { refreshed.push(b); } });
    await broker.getToken('ms365', 'graph');
    expect(refreshed).toHaveLength(1);
    expect(refreshed[0].service).toBe('ms365');
  });

  it('records acquire attempts and successes in lifecycle state', async () => {
    const p = fakeProvider();
    const dir = testDataDir();
    const lifecycleStore = new LifecycleStateStore(dir);
    const storage = new TokenStorage(new MemKeyring());
    const registry = new ServiceRegistry(dir);
    registry.installProvider(p);
    await registry.registerService({ name: 'ms365', providerName: 'ms365', schemes: ['graph'], config: {}, createdAt: Date.now() });
    const validator = new TokenValidator({ policy: 'eager', safetyMarginSec: 300 });
    const broker = new Broker({ storage, registry, validator, logger, dataDir: dir, lifecycleStore });

    await broker.getToken('ms365', 'graph');

    expect(await lifecycleStore.get('ms365', 'graph')).toMatchObject({
      service: 'ms365',
      scheme: 'graph',
      lastAcquireAttemptAt: expect.any(Number),
      lastAcquireSuccessAt: expect.any(Number),
    });
  });

  it('calls onTokenRefreshed after refresh', async () => {
    const refreshed: TokenBundle[] = [];
    let call = 0;
    const p = fakeProvider({ validate: vi.fn(async () => { call++; return call > 1; }) });
    const dir = testDataDir();
    const keyring = new MemKeyring();
    const storage = new TokenStorage(keyring);
    const registry = new ServiceRegistry(dir);
    registry.installProvider(p);
    await registry.registerService({ name: 'ms365', providerName: 'ms365', schemes: ['graph'], config: {}, createdAt: Date.now() });
    const validator = new TokenValidator({ policy: 'eager', safetyMarginSec: 300 });
    const broker = new Broker({ storage, registry, validator, logger, dataDir: dir, onTokenRefreshed: async (b) => { refreshed.push(b); } });
    await storage.set(fakeBundle({ acquiredAt: Date.now() - 120_000, expiresAt: Date.now() - 1000 }));
    await broker.getToken('ms365', 'graph');
    expect(refreshed).toHaveLength(1);
    expect(refreshed[0].accessToken).toContain('refreshed');
  });

  it('throws INTERACTIVE_AUTH_REQUIRED when refresh token is expired (autoReacquire off)', async () => {
    const expiredError = new Error('refresh token expired (AADSTS70000): HTTP 400');
    Object.defineProperty(expiredError, 'name', { value: 'RefreshTokenExpiredError' });
    Object.defineProperty(expiredError, 'aadstsCode', { value: 'AADSTS70000' });
    const p = fakeProvider({
      validate: vi.fn(async () => false),
      refresh: vi.fn(async () => { throw expiredError; }),
    });
    const { broker, storage } = await makeBroker(p, { autoReacquire: false });
    await storage.set(fakeBundle({ acquiredAt: Date.now() - 120_000, expiresAt: Date.now() - 1000 }));
    try {
      await broker.getToken('ms365', 'graph');
      expect.unreachable('should have thrown');
    } catch (err: unknown) {
      const herr = err as { code: string; remediation?: string; message: string };
      expect(herr.code).toBe(HermesErrorCode.INTERACTIVE_AUTH_REQUIRED);
      expect(herr.message).toContain('AADSTS70000');
      expect(herr.remediation).toBe('run: hermes acquire ms365');
      expect((err as { remediationCommands?: string[] }).remediationCommands).toEqual(['hermes acquire ms365']);
    }
  });

  it('blocks rapid retry within 60s cooldown after expired refresh token failure (autoReacquire off)', async () => {
    const expiredError = new Error('refresh token expired (AADSTS70000): HTTP 400');
    Object.defineProperty(expiredError, 'name', { value: 'RefreshTokenExpiredError' });
    Object.defineProperty(expiredError, 'aadstsCode', { value: 'AADSTS70000' });
    const p = fakeProvider({
      validate: vi.fn(async () => false),
      refresh: vi.fn(async () => { throw expiredError; }),
    });
    const { broker, storage } = await makeBroker(p, { autoReacquire: false });
    await storage.set(fakeBundle({ acquiredAt: Date.now() - 120_000, expiresAt: Date.now() - 1000 }));
    await expect(broker.getToken('ms365', 'graph')).rejects.toThrow('refresh token expired');
    await expect(broker.getToken('ms365', 'graph')).rejects.toThrow('cooldown active');
  });

  it('falls back to acquire for non-AADSTS refresh failures', async () => {
    const p = fakeProvider({
      validate: vi.fn(async () => false),
      refresh: vi.fn(async () => { throw new Error('network timeout'); }),
    });
    const { broker, storage } = await makeBroker(p);
    await storage.set(fakeBundle({ acquiredAt: Date.now() - 120_000, expiresAt: Date.now() - 1000 }));
    const token = await broker.getToken('ms365', 'graph');
    expect(p.acquire).toHaveBeenCalledOnce();
    expect(token.accessToken).toBe('abc');
  });

  it('does not fall back to acquire for retryable refresh failures', async () => {
    const transient = new Error('HTTP 503: upstream unavailable') as Error & { retryable: true; retryAfterMs: number };
    transient.retryable = true;
    transient.retryAfterMs = 2000;
    const p = fakeProvider({
      validate: vi.fn(async () => false),
      refresh: vi.fn(async () => { throw transient; }),
    });
    const { broker, storage } = await makeBroker(p);
    await storage.set(fakeBundle({ acquiredAt: Date.now() - 120_000, expiresAt: Date.now() - 1000 }));

    await expect(broker.getToken('ms365', 'graph')).rejects.toMatchObject({
      code: HermesErrorCode.REFRESH_FAILED,
      category: 'transient',
      retryable: true,
      retryAfterMs: 2000,
    });
    expect(p.acquire).not.toHaveBeenCalled();
  });

  it('detects identical-hash refresh and throws INTERACTIVE_AUTH_REQUIRED (autoReacquire off)', async () => {
    const staleBundle = fakeBundle({ acquiredAt: Date.now() - 120_000, expiresAt: Date.now() - 1000 });
    const p = fakeProvider({
      validate: vi.fn(async () => false),
      refresh: vi.fn(async (_c, b) => ({ ...b })), // returns identical bundle
    });
    const { broker, storage } = await makeBroker(p, { autoReacquire: false });
    await storage.set(staleBundle);
    try {
      await broker.getToken('ms365', 'graph');
      expect.unreachable('should have thrown');
    } catch (err: unknown) {
      const herr = err as { code: string; message: string };
      expect(herr.code).toBe(HermesErrorCode.INTERACTIVE_AUTH_REQUIRED);
      expect(herr.message).toContain('identical credentials');
    }
  });

  it('blocks rapid retry within 60s cooldown after identical-hash failure (autoReacquire off)', async () => {
    const staleBundle = fakeBundle({ acquiredAt: Date.now() - 120_000, expiresAt: Date.now() - 1000 });
    const p = fakeProvider({
      validate: vi.fn(async () => false),
      refresh: vi.fn(async (_c, b) => ({ ...b })),
    });
    const { broker, storage } = await makeBroker(p, { autoReacquire: false });
    await storage.set(staleBundle);
    // First call triggers hash-compare failure
    await expect(broker.getToken('ms365', 'graph')).rejects.toThrow('identical credentials');
    // Second call within cooldown should be blocked
    await expect(broker.getToken('ms365', 'graph')).rejects.toThrow('cooldown active');
  });

  it('records refresh attempts, failures, and REFRESH_FAILED lifecycle state', async () => {
    const p = fakeProvider({
      validate: vi.fn(async () => true),
      refresh: vi.fn(async () => { throw new Error('refresh dead'); }),
    });
    const dir = testDataDir();
    const lifecycleStore = new LifecycleStateStore(dir);
    const storage = new TokenStorage(new MemKeyring());
    const registry = new ServiceRegistry(dir);
    registry.installProvider(p);
    await registry.registerService({ name: 'ms365', providerName: 'ms365', schemes: ['graph'], config: {}, createdAt: Date.now() });
    const validator = new TokenValidator({ policy: 'eager', safetyMarginSec: 300 });
    const broker = new Broker({ storage, registry, validator, logger, dataDir: dir, lifecycleStore });
    await storage.set(fakeBundle({ acquiredAt: Date.now() - 120_000, expiresAt: Date.now() - 1000 }));

    await expect(broker.getToken('ms365', 'graph', { refresh: true })).rejects.toThrow('scheduled refresh failed');

    const state = await lifecycleStore.get('ms365', 'graph');
    expect(state).toMatchObject({
      service: 'ms365',
      scheme: 'graph',
      lastRefreshAttemptAt: expect.any(Number),
      lastErrorCode: HermesErrorCode.REFRESH_FAILED,
      lastErrorMessage: expect.stringContaining('scheduled refresh failed'),
      lastErrorAt: expect.any(Number),
      proofState: 'degraded',
      proofEvents: expect.arrayContaining([
        expect.objectContaining({
          tier: 'provider_validated',
          status: 'degraded',
          error: expect.stringContaining('scheduled refresh failed'),
          metadata: { phase: 'refresh' },
        }),
      ]),
    });
    expect(p.acquire).not.toHaveBeenCalled();
  });

  it('records failed proof events when acquire cannot produce credentials', async () => {
    const p = fakeProvider({
      acquire: vi.fn(async () => { throw new Error('browser profile locked'); }),
    });
    const { broker, lifecycleStore } = await makeBrokerFor('ms365', 'graph', p);

    await expect(broker.getToken('ms365', 'graph')).rejects.toMatchObject({
      code: HermesErrorCode.ACQUIRE_REQUIRED,
    });

    expect(await lifecycleStore.get('ms365', 'graph')).toMatchObject({
      lastAcquireAttemptAt: expect.any(Number),
      lastErrorCode: HermesErrorCode.ACQUIRE_REQUIRED,
      proofTier: 'provider_validated',
      proofState: 'failed',
      proofEvents: expect.arrayContaining([
        expect.objectContaining({
          tier: 'stored',
          status: 'failed',
        }),
        expect.objectContaining({
          tier: 'provider_validated',
          status: 'failed',
          error: expect.stringContaining('browser profile locked'),
          metadata: { phase: 'acquire' },
        }),
      ]),
    });
  });

  it('persists auth-required cooldown across broker instances', async () => {
    const expiredError = new Error('refresh token expired (AADSTS70000): HTTP 400');
    Object.defineProperty(expiredError, 'name', { value: 'RefreshTokenExpiredError' });
    Object.defineProperty(expiredError, 'aadstsCode', { value: 'AADSTS70000' });
    const p = fakeProvider({
      validate: vi.fn(async () => false),
      refresh: vi.fn(async () => { throw expiredError; }),
    });
    const dir = testDataDir();
    const storage = new TokenStorage(new MemKeyring());
    const registry = new ServiceRegistry(dir);
    registry.installProvider(p);
    await registry.registerService({ name: 'ms365', providerName: 'ms365', schemes: ['graph'], config: {}, createdAt: Date.now(), autoReacquire: false });
    const validator = new TokenValidator({ policy: 'eager', safetyMarginSec: 300 });
    const firstStore = new LifecycleStateStore(dir);
    const firstBroker = new Broker({ storage, registry, validator, logger, dataDir: dir, lifecycleStore: firstStore });
    await storage.set(fakeBundle({ acquiredAt: Date.now() - 120_000, expiresAt: Date.now() - 1000 }));

    await expect(firstBroker.getToken('ms365', 'graph')).rejects.toThrow('refresh token expired');
    const persisted = await firstStore.get('ms365', 'graph');
    expect(persisted?.cooldownUntil).toBeGreaterThan(Date.now());

    const restartedBroker = new Broker({
      storage,
      registry,
      validator,
      logger,
      dataDir: dir,
      lifecycleStore: new LifecycleStateStore(dir),
    });
    await expect(restartedBroker.getToken('ms365', 'graph')).rejects.toThrow('cooldown active');
    expect(p.refresh).toHaveBeenCalledTimes(1);
  });

  it('cooldown gate: autoReacquire ON + non-CA failure surfaces REFRESH_IN_PROGRESS (self-recoverable)', async () => {
    // The reauth cooldown gate sits in front of tryAutoReacquire. When the
    // service can self-recover (autoReacquire enabled, failure was non-CA),
    // the cooldown is a self-expiring window the broker will recover within,
    // so the gate surfaces REFRESH_IN_PROGRESS (503, retryable) instead of
    // INTERACTIVE_AUTH_REQUIRED (409). Prevents the daemon dead-end timbot
    // flagged on 2026-05-28 (ms365/graph "reauth cooldown active" 409s for a
    // self-expiring window).
    const expiredError = new Error('refresh token expired (AADSTS700084)');
    Object.defineProperty(expiredError, 'name', { value: 'RefreshTokenExpiredError' });
    Object.defineProperty(expiredError, 'aadstsCode', { value: 'AADSTS700084' });
    const p = fakeProvider({
      validate: vi.fn(async () => false),
      refresh: vi.fn(async () => { throw expiredError; }),
      acquire: vi.fn(async () => { throw new Error('acquire failed fast — non-CA'); }),
    });
    const dir = testDataDir();
    const storage = new TokenStorage(new MemKeyring());
    const registry = new ServiceRegistry(dir);
    registry.installProvider(p);
    await registry.registerService({
      name: 'ms365', providerName: 'ms365', schemes: ['graph'],
      config: {}, createdAt: Date.now(), autoReacquire: true,
    });
    const validator = new TokenValidator({ policy: 'eager', safetyMarginSec: 300 });
    const broker = new Broker({ storage, registry, validator, logger, dataDir: dir, lifecycleStore: new LifecycleStateStore(dir) });
    // Expired cached token so the cooldown gate's cachedStillValid check fails.
    await storage.set(fakeBundle({ acquiredAt: Date.now() - 120_000, expiresAt: Date.now() - 1000 }));

    // Call 1: refresh fails (RT expired, non-CA) -> cooldown activated -> tryAutoReacquire
    // fails fast -> non-CA -> REFRESH_IN_PROGRESS.
    await expect(broker.getToken('ms365', 'graph')).rejects.toMatchObject({ code: HermesErrorCode.REFRESH_IN_PROGRESS });

    // Call 2: cooldown is now active. The gate classifies: autoReacquire ON +
    // non-CA reason -> self-recoverable -> REFRESH_IN_PROGRESS (NOT 409).
    await expect(broker.getToken('ms365', 'graph')).rejects.toMatchObject({
      code: HermesErrorCode.REFRESH_IN_PROGRESS,
      retryHint: 'retry-after',
    });
  });

  it('cooldown gate: autoReacquire OFF keeps INTERACTIVE_AUTH_REQUIRED (broker cannot self-recover)', async () => {
    // Counterpart to the above: with autoReacquire disabled, the broker will
    // NOT recover on its own — a 503 retryable would cause an infinite retry
    // loop. The gate must keep 409 so the consumer surfaces the operator
    // action (`hermes acquire`).
    const expiredError = new Error('refresh token expired (AADSTS700084)');
    Object.defineProperty(expiredError, 'name', { value: 'RefreshTokenExpiredError' });
    Object.defineProperty(expiredError, 'aadstsCode', { value: 'AADSTS700084' });
    const p = fakeProvider({
      validate: vi.fn(async () => false),
      refresh: vi.fn(async () => { throw expiredError; }),
    });
    const dir = testDataDir();
    const storage = new TokenStorage(new MemKeyring());
    const registry = new ServiceRegistry(dir);
    registry.installProvider(p);
    await registry.registerService({
      name: 'ms365', providerName: 'ms365', schemes: ['graph'],
      config: {}, createdAt: Date.now(), autoReacquire: false,
    });
    const validator = new TokenValidator({ policy: 'eager', safetyMarginSec: 300 });
    const broker = new Broker({ storage, registry, validator, logger, dataDir: dir, lifecycleStore: new LifecycleStateStore(dir) });
    await storage.set(fakeBundle({ acquiredAt: Date.now() - 120_000, expiresAt: Date.now() - 1000 }));

    // Call 1: refresh fails -> cooldown activated. autoReacquire off, so the
    // original 409 bubbles up (no tryAutoReacquire recovery path).
    await expect(broker.getToken('ms365', 'graph')).rejects.toMatchObject({ code: HermesErrorCode.INTERACTIVE_AUTH_REQUIRED });

    // Call 2: cooldown gate -> autoReacquire off -> 409 (operator must act).
    await expect(broker.getToken('ms365', 'graph')).rejects.toMatchObject({ code: HermesErrorCode.INTERACTIVE_AUTH_REQUIRED });
  });

  it('records a ServiceNow-like 401 report, redacts evidence, and refreshes on the next request', async () => {
    const p = fakeProvider({
      name: 'servicenow',
      schemes: ['session'],
      validate: vi.fn(async () => true),
      refresh: vi.fn(async (_c, b) => ({ ...b, accessToken: 'fresh-session-token', acquiredAt: Date.now() })),
      acquire: vi.fn(async () => fakeBundle({ service: 'servicenow', scheme: 'session', accessToken: 'acquired-session-token' })),
    });
    const { broker, storage, lifecycleStore } = await makeBrokerFor('servicenow', 'session', p);
    await storage.set(fakeBundle({ service: 'servicenow', scheme: 'session', accessToken: 'stale-session-token', acquiredAt: Date.now() }));

    const result = await broker.reportAuthFailure({
      service: 'servicenow',
      scheme: 'session',
      httpStatus: 401,
      backend: 'servicenow-mcp',
      tool: 'incident.list',
      endpointClass: 'table-api',
      correlationId: 'corr-401',
      message: 'User Not Authenticated',
      errorEvidence: {
        authorization: 'Bearer super-secret-token',
        cookie: 'JSESSIONID=secret-cookie',
        body: 'User Not Authenticated access_token=raw-secret',
      },
    });

    expect(result).toMatchObject({
      status: 'recorded',
      classification: 'auth_recovery',
      forceRecovery: true,
      credentialStatus: 'suspect',
      guidance: {
        retryable: true,
        retryAfterMs: 0,
        nextAction: 'request_fresh_token_then_retry_downstream',
      },
    });
    const suspectState = await lifecycleStore.get('servicenow', 'session');
    expect(suspectState).toMatchObject({
      credentialStatus: 'suspect',
      lastErrorCode: 'CONSUMER_AUTH_FAILURE',
      proofState: 'failed',
      consumerAuthFailures: [expect.objectContaining({
        httpStatus: 401,
        backend: 'servicenow-mcp',
        tool: 'incident.list',
        endpointClass: 'table-api',
        correlationId: 'corr-401',
      })],
    });
    expect(JSON.stringify(suspectState)).not.toContain('super-secret-token');
    expect(JSON.stringify(suspectState)).not.toContain('secret-cookie');
    expect(JSON.stringify(suspectState)).not.toContain('raw-secret');

    const token = await broker.getToken('servicenow', 'session');
    expect(token.accessToken).toBe('fresh-session-token');
    expect(p.validate).not.toHaveBeenCalled();
    expect(p.refresh).toHaveBeenCalledOnce();
    expect(await lifecycleStore.get('servicenow', 'session')).toMatchObject({ credentialStatus: 'valid' });
  });

  it('routes ToolHive container auth failure reports to the canonical service', async () => {
    const p = fakeProvider({
      name: 'ms365',
      schemes: ['graph'],
    });
    const { broker, lifecycleStore } = await makeBrokerFor('ms365', 'graph', p, {
      thvContainerName: 'ms365-thv',
    });

    const result = await broker.reportAuthFailure({
      service: 'ms365-thv',
      scheme: 'graph',
      httpStatus: 401,
      backend: 'ms365-thv',
      tool: 'graph.users.list',
    });

    expect(result).toMatchObject({
      status: 'recorded',
      service: 'ms365',
      report: { service: 'ms365', backend: 'ms365-thv' },
      classification: 'auth_recovery',
    });
    expect(await lifecycleStore.get('ms365', 'graph')).toMatchObject({
      credentialStatus: 'suspect',
      consumerAuthFailures: [expect.objectContaining({ backend: 'ms365-thv' })],
    });
  });

  it('routes explicit service aliases in auth failure reports to the canonical service', async () => {
    const p = fakeProvider({ name: 'ms365', schemes: ['graph'] });
    const { broker, lifecycleStore } = await makeBrokerFor('ms365', 'graph', p, {
      serviceAliases: ['microsoft-365'],
      gatewayBackendAliases: ['gateway-ms365'],
    });

    const result = await broker.reportAuthFailure({
      service: 'gateway-ms365',
      scheme: 'graph',
      failureCode: 'invalid_session',
    });

    expect(result.service).toBe('ms365');
    expect(result.report.service).toBe('ms365');
    expect(await lifecycleStore.get('ms365', 'graph')).toMatchObject({
      lastErrorCode: 'CONSUMER_AUTH_FAILURE',
    });
  });

  it('keeps unknown auth failure report services rejected', async () => {
    const p = fakeProvider({ name: 'ms365', schemes: ['graph'] });
    const { broker } = await makeBrokerFor('ms365', 'graph', p);

    await expect(broker.reportAuthFailure({
      service: 'ms365-thv',
      scheme: 'graph',
      httpStatus: 401,
    })).rejects.toThrow(/SERVICE_NOT_REGISTERED/);
  });

  it('records 5xx consumer failures as transient without forcing reauth', async () => {
    const p = fakeProvider({
      name: 'servicenow',
      schemes: ['session'],
      refresh: vi.fn(async (_c, b) => ({ ...b, accessToken: 'should-not-use' })),
    });
    const { broker, storage, lifecycleStore } = await makeBrokerFor('servicenow', 'session', p);
    await storage.set(fakeBundle({ service: 'servicenow', scheme: 'session', accessToken: 'cached-session-token', acquiredAt: Date.now() }));

    const result = await broker.reportAuthFailure({
      service: 'servicenow',
      scheme: 'session',
      httpStatus: 503,
      failureCode: 'transient',
      backend: 'servicenow-mcp',
    });

    expect(result).toMatchObject({
      classification: 'transient',
      forceRecovery: false,
      credentialStatus: 'degraded',
      guidance: {
        retryable: true,
        nextAction: 'retry_downstream_without_reauth',
      },
    });
    expect(await lifecycleStore.get('servicenow', 'session')).toMatchObject({
      credentialStatus: 'degraded',
      lastErrorCode: 'CONSUMER_TRANSIENT_FAILURE',
      proofState: 'degraded',
    });
    expect((await broker.getToken('servicenow', 'session')).accessToken).toBe('cached-session-token');
    expect(p.refresh).not.toHaveBeenCalled();
  });

  it('maps ServiceNow-specific auth failure codes to suspect credentials without needing HTTP status', async () => {
    const p = fakeProvider({ name: 'servicenow', schemes: ['session'] });
    const { broker, lifecycleStore } = await makeBrokerFor('servicenow', 'session', p);

    const result = await broker.reportAuthFailure({
      service: 'servicenow',
      scheme: 'session',
      failureCode: 'missing_or_invalid_g_ck',
      message: 'ServiceNow g_ck missing after session propagation',
    });

    expect(result).toMatchObject({
      classification: 'auth_recovery',
      forceRecovery: true,
      credentialStatus: 'suspect',
    });
    expect(await lifecycleStore.get('servicenow', 'session')).toMatchObject({
      credentialStatus: 'suspect',
      lastErrorCode: 'CONSUMER_AUTH_FAILURE',
    });
  });

  it('maps ServiceNow network/VPN failure codes to degraded retry guidance without reauth', async () => {
    const p = fakeProvider({ name: 'servicenow', schemes: ['session'] });
    const { broker, lifecycleStore } = await makeBrokerFor('servicenow', 'session', p);

    const result = await broker.reportAuthFailure({
      service: 'servicenow',
      scheme: 'session',
      failureCode: 'network_or_vpn_unreachable',
      message: 'ServiceNow host unreachable from MCP container',
    });

    expect(result).toMatchObject({
      classification: 'transient',
      forceRecovery: false,
      credentialStatus: 'degraded',
      guidance: { nextAction: 'retry_downstream_without_reauth' },
    });
    expect(await lifecycleStore.get('servicenow', 'session')).toMatchObject({
      credentialStatus: 'degraded',
      lastErrorCode: 'CONSUMER_TRANSIENT_FAILURE',
    });
  });

  it('coalesces concurrent recovery token requests after auth failure reports', async () => {
    const p = fakeProvider({
      name: 'servicenow',
      schemes: ['session'],
      refresh: vi.fn(async (_c, b) => {
        await new Promise((r) => setTimeout(r, 30));
        return { ...b, accessToken: 'fresh-after-coalesced-recovery', acquiredAt: Date.now() };
      }),
    });
    const { broker, storage } = await makeBrokerFor('servicenow', 'session', p);
    await storage.set(fakeBundle({ service: 'servicenow', scheme: 'session', accessToken: 'stale', acquiredAt: Date.now() }));
    await Promise.all([
      broker.reportAuthFailure({ service: 'servicenow', scheme: 'session', failureCode: 'invalid_session' }),
      broker.reportAuthFailure({ service: 'servicenow', scheme: 'session', failureCode: 'invalid_session' }),
    ]);

    const tokens = await Promise.all([
      broker.getToken('servicenow', 'session'),
      broker.getToken('servicenow', 'session'),
      broker.getToken('servicenow', 'session'),
    ]);
    expect(tokens.map((t) => t.accessToken)).toEqual([
      'fresh-after-coalesced-recovery',
      'fresh-after-coalesced-recovery',
      'fresh-after-coalesced-recovery',
    ]);
    expect(p.refresh).toHaveBeenCalledOnce();
  });
});

describe('Broker — autoReacquire', () => {
  afterEach(() => {
    while (testDirs.length > 0) rmSync(testDirs.pop()!, { recursive: true, force: true });
  });

  // Helper: make a broker where the service has autoReacquire set as specified.
  async function makeAutoReacquireBroker(
    provider: Provider,
    autoReacquire: boolean,
    extraSchemes: string[] = [],
    onRefreshFailed?: (service: string, scheme: string, error: Error) => void,
  ) {
    const dir = testDataDir();
    const lifecycleStore = new LifecycleStateStore(dir);
    const storage = new TokenStorage(new MemKeyring());
    const registry = new ServiceRegistry(dir);
    registry.installProvider(provider);
    const schemes = ['graph', ...extraSchemes];
    await registry.registerService({
      name: 'ms365', providerName: provider.name, schemes,
      config: {}, createdAt: Date.now(),
      autoReacquire,
    });
    const validator = new TokenValidator({ policy: 'eager', safetyMarginSec: 300 });
    const broker = new Broker({ storage, registry, validator, logger, dataDir: dir, lifecycleStore, ...(onRefreshFailed ? { onRefreshFailed } : {}) });
    return { broker, storage, lifecycleStore };
  }

  it('autoReacquire disabled: refresh failure returns INTERACTIVE_AUTH_REQUIRED without calling acquire', async () => {
    const expiredError = new Error('refresh token expired (AADSTS70000)');
    Object.defineProperty(expiredError, 'name', { value: 'RefreshTokenExpiredError' });
    Object.defineProperty(expiredError, 'aadstsCode', { value: 'AADSTS70000' });
    const p = fakeProvider({
      validate: vi.fn(async () => false),
      refresh: vi.fn(async () => { throw expiredError; }),
    });
    const { broker, storage } = await makeAutoReacquireBroker(p, false);
    await storage.set(fakeBundle({ acquiredAt: Date.now() - 120_000, expiresAt: Date.now() - 1000 }));

    await expect(broker.getToken('ms365', 'graph')).rejects.toMatchObject({
      code: HermesErrorCode.INTERACTIVE_AUTH_REQUIRED,
    });
    expect(p.acquire).not.toHaveBeenCalled();
  });

  it('autoReacquire enabled + acquire succeeds: returns fresh bundle without surfacing INTERACTIVE_AUTH_REQUIRED', async () => {
    const expiredError = new Error('refresh token expired (AADSTS70000)');
    Object.defineProperty(expiredError, 'name', { value: 'RefreshTokenExpiredError' });
    Object.defineProperty(expiredError, 'aadstsCode', { value: 'AADSTS70000' });
    const freshBundle = fakeBundle({ accessToken: 'fresh-via-auto-reacquire' });
    const p = fakeProvider({
      validate: vi.fn(async () => false),
      refresh: vi.fn(async () => { throw expiredError; }),
      acquire: vi.fn(async () => freshBundle),
    });
    const { broker, storage } = await makeAutoReacquireBroker(p, true);
    await storage.set(fakeBundle({ acquiredAt: Date.now() - 120_000, expiresAt: Date.now() - 1000 }));

    const result = await broker.getToken('ms365', 'graph');
    expect(result.accessToken).toBe('fresh-via-auto-reacquire');
    expect(p.acquire).toHaveBeenCalledOnce();
  });

  it('autoReacquire enabled + refresh raises CA challenge: surfaces INTERACTIVE_AUTH_REQUIRED without calling acquire', async () => {
    const challenge = classifyConditionalAccessChallenge({
      text: 'You cannot access this right now',
      service: 'ms365',
      acquireCommand: 'hermes acquire ms365',
    });
    const p = fakeProvider({
      validate: vi.fn(async () => false),
      refresh: vi.fn(async () => { throw new ConditionalAccessChallengeError(challenge!); }),
    });
    const { broker, storage } = await makeAutoReacquireBroker(p, true);
    await storage.set(fakeBundle({ acquiredAt: Date.now() - 120_000, expiresAt: Date.now() - 1000 }));

    await expect(broker.getToken('ms365', 'graph')).rejects.toMatchObject({
      code: HermesErrorCode.INTERACTIVE_AUTH_REQUIRED,
    });
    // acquire must NOT be called — CA challenge requires operator
    expect(p.acquire).not.toHaveBeenCalled();
  });

  it('autoReacquire enabled + acquire throws non-CA error: surfaces REFRESH_IN_PROGRESS (transient, will retry)', async () => {
    // Semantic refinement (post-timbot/az-teams 2026-05-27 observation):
    // non-CA acquire failures are likely transient (cold-start race,
    // Playwright stall, IdP timeout). The broker now surfaces REFRESH_IN_PROGRESS
    // so consumers don't mistake them for "operator must act" — only CA
    // challenges preserve the original INTERACTIVE_AUTH_REQUIRED path.
    const expiredError = new Error('refresh token expired (AADSTS70000)');
    Object.defineProperty(expiredError, 'name', { value: 'RefreshTokenExpiredError' });
    Object.defineProperty(expiredError, 'aadstsCode', { value: 'AADSTS70000' });
    const p = fakeProvider({
      validate: vi.fn(async () => false),
      refresh: vi.fn(async () => { throw expiredError; }),
      acquire: vi.fn(async () => { throw new Error('browser profile locked — non-CA failure'); }),
    });
    const { broker, storage } = await makeAutoReacquireBroker(p, true);
    await storage.set(fakeBundle({ acquiredAt: Date.now() - 120_000, expiresAt: Date.now() - 1000 }));

    // acquire is called (autoReacquire=true, non-CA), fails transiently -> REFRESH_IN_PROGRESS
    await expect(broker.getToken('ms365', 'graph')).rejects.toMatchObject({
      code: HermesErrorCode.REFRESH_IN_PROGRESS,
      retryHint: 'retry-after',
    });
    expect(p.acquire).toHaveBeenCalledOnce();
  });

  it('background acquire failure re-arms the scheduler via onRefreshFailed (no silent disarm)', async () => {
    // With REFRESH_IN_PROGRESS no longer scheduling a retry, the failed
    // background acquire is the only re-arm for the failure path. It must fire
    // onRefreshFailed so the scheduler stays armed (fcc2493 invariant).
    const expiredError = new Error('refresh token expired (AADSTS70000)');
    Object.defineProperty(expiredError, 'name', { value: 'RefreshTokenExpiredError' });
    Object.defineProperty(expiredError, 'aadstsCode', { value: 'AADSTS70000' });
    const p = fakeProvider({
      validate: vi.fn(async () => false),
      refresh: vi.fn(async () => { throw expiredError; }),
      acquire: vi.fn(async () => { throw new Error('browser profile locked — non-CA failure'); }),
    });
    const onRefreshFailed = vi.fn();
    const { broker, storage } = await makeAutoReacquireBroker(p, true, [], onRefreshFailed);
    await storage.set(fakeBundle({ acquiredAt: Date.now() - 120_000, expiresAt: Date.now() - 1000 }));

    await expect(broker.getToken('ms365', 'graph')).rejects.toMatchObject({ code: HermesErrorCode.REFRESH_IN_PROGRESS });
    await new Promise((r) => setTimeout(r, 10)); // let the background IIFE settle
    expect(onRefreshFailed).toHaveBeenCalledWith('ms365', 'graph', expect.objectContaining({ code: HermesErrorCode.REFRESH_FAILED }));
  });

  it('bounded-retry: 2 consecutive failures within 10 min suppress the third attempt', async () => {
    const expiredError = new Error('refresh token expired (AADSTS70000)');
    Object.defineProperty(expiredError, 'name', { value: 'RefreshTokenExpiredError' });
    Object.defineProperty(expiredError, 'aadstsCode', { value: 'AADSTS70000' });
    const p = fakeProvider({
      validate: vi.fn(async () => false),
      refresh: vi.fn(async () => { throw expiredError; }),
      acquire: vi.fn(async () => { throw new Error('acquire failed'); }),
    });
    const { broker, storage } = await makeAutoReacquireBroker(p, true);

    // Use expiresAt in the near future (< 5min safety margin = stale) but > 0 so
    // activateCooldown skips the cooldown gate and lets subsequent calls through.
    const nearFutureExpiry = () => fakeBundle({ acquiredAt: Date.now() - 120_000, expiresAt: Date.now() + 200_000 });

    // First call: refresh fails -> autoReacquire tries -> acquire fails (failure 1)
    // Non-CA failure now surfaces REFRESH_IN_PROGRESS (transient, retryable).
    await storage.set(nearFutureExpiry());
    await expect(broker.getToken('ms365', 'graph')).rejects.toMatchObject({ code: HermesErrorCode.REFRESH_IN_PROGRESS });
    expect(p.acquire).toHaveBeenCalledTimes(1);

    // Second call: acquire fails again (failure 2)
    await storage.set(nearFutureExpiry());
    await expect(broker.getToken('ms365', 'graph')).rejects.toMatchObject({ code: HermesErrorCode.REFRESH_IN_PROGRESS });
    expect(p.acquire).toHaveBeenCalledTimes(2);

    // Third call: bounded-retry suppresses, acquire must NOT be called.
    // Suppression also surfaces REFRESH_IN_PROGRESS with retry_after =
    // window remaining (matches the last-failure-was-non-CA classification).
    await storage.set(nearFutureExpiry());
    await expect(broker.getToken('ms365', 'graph')).rejects.toMatchObject({ code: HermesErrorCode.REFRESH_IN_PROGRESS });
    expect(p.acquire).toHaveBeenCalledTimes(2); // unchanged
  });

  it('bounded-retry: failure older than 10 min does NOT count toward the limit', async () => {
    const expiredError = new Error('refresh token expired (AADSTS70000)');
    Object.defineProperty(expiredError, 'name', { value: 'RefreshTokenExpiredError' });
    Object.defineProperty(expiredError, 'aadstsCode', { value: 'AADSTS70000' });
    const freshBundle2 = fakeBundle({ accessToken: 'fresh-after-old-failure-expired' });
    let acquireCount = 0;
    const p = fakeProvider({
      validate: vi.fn(async () => false),
      refresh: vi.fn(async () => { throw expiredError; }),
      acquire: vi.fn(async () => {
        acquireCount++;
        if (acquireCount === 1) throw new Error('acquire failed');
        return freshBundle2;
      }),
    });
    const { broker, storage } = await makeAutoReacquireBroker(p, true);

    // Use near-future expiry so activateCooldown skips the cooldown gate
    const nearFutureExpiry = () => fakeBundle({ acquiredAt: Date.now() - 120_000, expiresAt: Date.now() + 200_000 });

    // First call: acquire fails (failure 1 recorded). Non-CA → REFRESH_IN_PROGRESS.
    await storage.set(nearFutureExpiry());
    await expect(broker.getToken('ms365', 'graph')).rejects.toMatchObject({ code: HermesErrorCode.REFRESH_IN_PROGRESS });

    // Backdate the recorded failure to 11 min ago so it falls outside the window
    const arMap = (broker as unknown as { autoReacquireFailures: Map<string, number[]> }).autoReacquireFailures;
    const current = arMap.get('ms365:graph') ?? [];
    arMap.set('ms365:graph', current.map(() => Date.now() - 11 * 60_000));

    // Second call: the old failure is outside the 10-min window, so acquire runs and succeeds
    await storage.set(nearFutureExpiry());
    const result = await broker.getToken('ms365', 'graph');
    expect(result.accessToken).toBe('fresh-after-old-failure-expired');
    expect(p.acquire).toHaveBeenCalledTimes(2);
  });

  it('per-(service,scheme) independence: failure for one scheme does not suppress another', async () => {
    const expiredError = new Error('refresh token expired (AADSTS70000)');
    Object.defineProperty(expiredError, 'name', { value: 'RefreshTokenExpiredError' });
    Object.defineProperty(expiredError, 'aadstsCode', { value: 'AADSTS70000' });
    const freshSkype = fakeBundle({ scheme: 'skype', accessToken: 'fresh-skype' });
    // graph scheme: acquire always fails; skype scheme: acquire always succeeds
    const p = fakeProvider({
      name: 'ms365',
      schemes: ['graph', 'skype'],
      validate: vi.fn(async () => false),
      refresh: vi.fn(async () => { throw expiredError; }),
      acquire: vi.fn(async (_ctx: unknown, scheme: string) => {
        if (scheme === 'graph') throw new Error('graph acquire failed');
        return { ...freshSkype, scheme };
      }),
    });
    const { broker, storage } = await makeAutoReacquireBroker(p, true, ['skype']);

    // Use near-future expiry so activateCooldown skips the cooldown gate
    const nearFutureExpiry = (scheme: string) => fakeBundle({ scheme, acquiredAt: Date.now() - 120_000, expiresAt: Date.now() + 200_000 });

    // Exhaust bounded-retry for ms365:graph (2 failures). Non-CA → REFRESH_IN_PROGRESS.
    for (let i = 0; i < 2; i++) {
      await storage.set(nearFutureExpiry('graph'));
      await expect(broker.getToken('ms365', 'graph')).rejects.toMatchObject({ code: HermesErrorCode.REFRESH_IN_PROGRESS });
    }

    // ms365:skype should still auto-reacquire successfully (independent tracker)
    await storage.set(nearFutureExpiry('skype'));
    const result = await broker.getToken('ms365', 'skype');
    expect(result.accessToken).toBe('fresh-skype');
  });

  it('successful acquire clears the failure tracker for that (service, scheme)', async () => {
    const expiredError = new Error('refresh token expired (AADSTS70000)');
    Object.defineProperty(expiredError, 'name', { value: 'RefreshTokenExpiredError' });
    Object.defineProperty(expiredError, 'aadstsCode', { value: 'AADSTS70000' });
    const freshBundle3 = fakeBundle({ accessToken: 'fresh-after-clear' });
    let acquireCount = 0;
    const p = fakeProvider({
      validate: vi.fn(async () => false),
      refresh: vi.fn(async () => { throw expiredError; }),
      acquire: vi.fn(async () => {
        acquireCount++;
        if (acquireCount === 1) throw new Error('first acquire fails');
        return freshBundle3;
      }),
    });
    const { broker, storage } = await makeAutoReacquireBroker(p, true);

    // Use near-future expiry so activateCooldown skips the cooldown gate
    const nearFutureExpiry = () => fakeBundle({ acquiredAt: Date.now() - 120_000, expiresAt: Date.now() + 200_000 });

    // Failure 1 — failure recorded. Non-CA → REFRESH_IN_PROGRESS.
    await storage.set(nearFutureExpiry());
    await expect(broker.getToken('ms365', 'graph')).rejects.toMatchObject({ code: HermesErrorCode.REFRESH_IN_PROGRESS });
    expect(p.acquire).toHaveBeenCalledTimes(1);

    // Success on second call — clears the tracker
    await storage.set(nearFutureExpiry());
    const result = await broker.getToken('ms365', 'graph');
    expect(result.accessToken).toBe('fresh-after-clear');

    // Tracker should be cleared — verify via private map
    const arMap = (broker as unknown as { autoReacquireFailures: Map<string, number[]> }).autoReacquireFailures;
    expect(arMap.get('ms365:graph')).toBeUndefined();

    // A subsequent call should also succeed (counter reset, not suppressed)
    await storage.set(nearFutureExpiry());
    const result2 = await broker.getToken('ms365', 'graph');
    expect(result2.accessToken).toBe('fresh-after-clear');
    expect(p.acquire).toHaveBeenCalledTimes(3); // 1 fail + 2 success
  });

  it('autoReacquire slow acquire exceeds wait budget: throws REFRESH_IN_PROGRESS and continues acquire in background', async () => {
    // Regression: prior behavior was for /token to block synchronously for the
    // full duration of a slow Playwright/SSO acquire (30-90s in practice),
    // causing daemon-side timeouts that got surfaced as misleading
    // "no token (network or broker error)" messages. The fix is a bounded
    // wait + REFRESH_IN_PROGRESS structured error so consumers can back off
    // cleanly. The background acquire still completes and stores the bundle.
    const expiredError = new Error('refresh token expired (AADSTS70000)');
    Object.defineProperty(expiredError, 'name', { value: 'RefreshTokenExpiredError' });
    Object.defineProperty(expiredError, 'aadstsCode', { value: 'AADSTS70000' });
    const freshBundle = fakeBundle({ accessToken: 'fresh-eventually' });

    // Slow provider: acquire takes 300ms (well over our 50ms test budget).
    let acquireResolved = false;
    const p = fakeProvider({
      validate: vi.fn(async () => false),
      refresh: vi.fn(async () => { throw expiredError; }),
      acquire: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 300));
        acquireResolved = true;
        return freshBundle;
      }),
    });

    // Build broker with a tight 50ms budget so the test runs fast.
    const dir = testDataDir();
    const lifecycleStore = new LifecycleStateStore(dir);
    const storage = new TokenStorage(new MemKeyring());
    const registry = new ServiceRegistry(dir);
    registry.installProvider(p);
    await registry.registerService({
      name: 'ms365', providerName: p.name, schemes: ['graph'],
      config: {}, createdAt: Date.now(),
      autoReacquire: true,
    });
    const validator = new TokenValidator({ policy: 'eager', safetyMarginSec: 300 });
    const broker = new Broker({
      storage, registry, validator, logger, dataDir: dir, lifecycleStore,
      acquireWaitBudgetMs: 50,
    });
    await storage.set(fakeBundle({ acquiredAt: Date.now() - 120_000, expiresAt: Date.now() - 1000 }));

    // First /token call: refresh fails -> autoReacquire kicks off slow acquire
    // -> wait budget elapses -> throws REFRESH_IN_PROGRESS
    await expect(broker.getToken('ms365', 'graph')).rejects.toMatchObject({
      code: HermesErrorCode.REFRESH_IN_PROGRESS,
      retryHint: 'retry-after',
    });
    expect(p.acquire).toHaveBeenCalledTimes(1);
    expect(acquireResolved).toBe(false); // background acquire still running

    // Wait for the background acquire to complete + clear in-flight map
    await new Promise((r) => setTimeout(r, 350));
    expect(acquireResolved).toBe(true);

    // Next /token call: cache now has the fresh bundle from the completed
    // background acquire, returns it inline. No new acquire triggered.
    const result = await broker.getToken('ms365', 'graph');
    expect(result.accessToken).toBe('fresh-eventually');
    expect(p.acquire).toHaveBeenCalledTimes(1); // still 1, dedup'd
  });

  it('autoReacquire CA-challenge failures preserve INTERACTIVE_AUTH_REQUIRED (operator-action signal not lost)', async () => {
    // Semantic contract: non-CA acquire failures surface as REFRESH_IN_PROGRESS
    // (transient, retryable). CA-challenge failures preserve the original
    // INTERACTIVE_AUTH_REQUIRED so the consumer surfaces a clean
    // operator-action signal with remediation. This regression test exists
    // so future refactors don't accidentally collapse both into REFRESH_IN_PROGRESS,
    // which would hide genuine reauth-needed states behind transient retries.
    const expiredError = new Error('refresh token expired (AADSTS70000)');
    Object.defineProperty(expiredError, 'name', { value: 'RefreshTokenExpiredError' });
    Object.defineProperty(expiredError, 'aadstsCode', { value: 'AADSTS70000' });
    // Acquire throws a CA-challenge-shaped error. The detector looks for
    // err.challenge (not err.conditionalAccessChallenge) — see broker.ts:20.
    const caError = Object.assign(new Error('conditional access challenge'), {
      challenge: {
        state: 'device-cert-required',
        category: 'authentication',
        message: 'device certificate required for sign-in',
        retryable: false,
        retryHint: 'human-action-required',
        remediation: 'enroll your device certificate via the operator workstation',
        remediationCommands: ['hermes acquire ms365'],
      },
    });
    const p = fakeProvider({
      validate: vi.fn(async () => false),
      refresh: vi.fn(async () => { throw expiredError; }),
      acquire: vi.fn(async () => { throw caError; }),
    });
    const { broker, storage } = await makeAutoReacquireBroker(p, true);
    await storage.set(fakeBundle({ acquiredAt: Date.now() - 120_000, expiresAt: Date.now() - 1000 }));

    // First call: refresh fails -> autoReacquire -> CA challenge -> preserve 409
    await expect(broker.getToken('ms365', 'graph')).rejects.toMatchObject({
      code: HermesErrorCode.INTERACTIVE_AUTH_REQUIRED,
    });
    // Sanity: the failure was tracked as CA so suppression preserves 409 too.
    // Push a second failure to exhaust the bounded-retry limit.
    await storage.set(fakeBundle({ acquiredAt: Date.now() - 120_000, expiresAt: Date.now() + 200_000 }));
    await expect(broker.getToken('ms365', 'graph')).rejects.toMatchObject({
      code: HermesErrorCode.INTERACTIVE_AUTH_REQUIRED,
    });
    // Third call: bounded-retry suppression engaged. Last failure was CA →
    // suppression preserves the 409 (operator-action signal) instead of
    // disguising it as REFRESH_IN_PROGRESS.
    await storage.set(fakeBundle({ acquiredAt: Date.now() - 120_000, expiresAt: Date.now() + 200_000 }));
    await expect(broker.getToken('ms365', 'graph')).rejects.toMatchObject({
      code: HermesErrorCode.INTERACTIVE_AUTH_REQUIRED,
    });
    expect(p.acquire).toHaveBeenCalledTimes(2); // 3rd suppressed
  });

  it('autoReacquire concurrent /token calls during slow acquire: all return REFRESH_IN_PROGRESS without triggering duplicate acquires', async () => {
    // Three concurrent callers should all hit the in-flight dedup and get
    // REFRESH_IN_PROGRESS, with only ONE provider.acquire call total.
    const expiredError = new Error('refresh token expired (AADSTS70000)');
    Object.defineProperty(expiredError, 'name', { value: 'RefreshTokenExpiredError' });
    Object.defineProperty(expiredError, 'aadstsCode', { value: 'AADSTS70000' });
    const freshBundle = fakeBundle({ accessToken: 'fresh-deduped' });
    const p = fakeProvider({
      validate: vi.fn(async () => false),
      refresh: vi.fn(async () => { throw expiredError; }),
      acquire: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 200));
        return freshBundle;
      }),
    });

    const dir = testDataDir();
    const lifecycleStore = new LifecycleStateStore(dir);
    const storage = new TokenStorage(new MemKeyring());
    const registry = new ServiceRegistry(dir);
    registry.installProvider(p);
    await registry.registerService({
      name: 'ms365', providerName: p.name, schemes: ['graph'],
      config: {}, createdAt: Date.now(),
      autoReacquire: true,
    });
    const validator = new TokenValidator({ policy: 'eager', safetyMarginSec: 300 });
    const broker = new Broker({
      storage, registry, validator, logger, dataDir: dir, lifecycleStore,
      acquireWaitBudgetMs: 50,
    });
    // Three separate cached bundles so each getToken call is independent
    // (no in-process mutex collision on the same stored bundle).
    await storage.set(fakeBundle({ acquiredAt: Date.now() - 120_000, expiresAt: Date.now() - 1000 }));

    const results = await Promise.allSettled([
      broker.getToken('ms365', 'graph'),
      broker.getToken('ms365', 'graph'),
      broker.getToken('ms365', 'graph'),
    ]);
    for (const r of results) {
      expect(r.status).toBe('rejected');
      if (r.status === 'rejected') {
        expect(r.reason.code).toBe(HermesErrorCode.REFRESH_IN_PROGRESS);
      }
    }
    // Critical assertion: dedup worked, only one acquire fired despite 3 callers
    expect(p.acquire).toHaveBeenCalledTimes(1);
  });
});
