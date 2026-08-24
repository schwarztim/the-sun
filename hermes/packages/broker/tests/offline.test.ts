import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { Broker } from '../src/broker.js';
import { BrokerConfigSchema } from '../src/config.js';
import { HermesErrorCode } from '../src/errors.js';
import { TokenStorage, type KeyringAdapter } from '../src/storage.js';
import { ServiceRegistry } from '../src/registry.js';
import { TokenValidator } from '../src/validator.js';
import { LifecycleStateStore } from '../src/lifecycle-state.js';
import { createLogger } from '../src/logger.js';
import type { ConnectivityGateLike, ConnectivityState } from '../src/connectivity.js';
import type { Provider, ProviderContext, TokenBundle } from '../src/types.js';

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

function bundle(overrides: Partial<TokenBundle> = {}): TokenBundle {
  return {
    service: 'fake', scheme: 'main', accessToken: 'tok', tokenType: 'Bearer',
    expiresAt: Date.now() + 3600_000, acquiredAt: Date.now(), ...overrides,
  };
}

function spyProvider(): Provider {
  return {
    name: 'fake', schemes: ['main'],
    acquire: vi.fn(async (_c: ProviderContext, scheme: string) => bundle({ scheme, accessToken: `tok-${Date.now()}-${Math.random()}` })),
    refresh: vi.fn(async (_c: ProviderContext, b: TokenBundle) => ({ ...b, accessToken: `r-${Math.random()}` })),
    validate: vi.fn(async () => true),
    nextRefreshAt: (b: TokenBundle) => new Date(b.expiresAt - 300_000),
  };
}

class StubGate implements ConnectivityGateLike {
  constructor(public state: ConnectivityState = 'online') {}
  async isOnline(): Promise<boolean> { return this.state !== 'offline'; }
  getState(): ConnectivityState { return this.state; }
}

interface Harness {
  broker: Broker;
  storage: TokenStorage;
  provider: Provider;
  gate: StubGate;
  lifecycleStore: LifecycleStateStore;
  dir: string;
}

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function harness(opts: {
  gate?: StubGate;
  adBudget?: { maxAcquiresPerHour?: number; maxValidationsPerHour?: number };
  offlineOptions?: { serveCachedWhileOffline?: boolean; retryAfterMs?: number; safetyMarginMs?: number };
  reuse?: { dir: string; storage: TokenStorage; lifecycleStore: LifecycleStateStore; provider: Provider };
} = {}): Promise<Harness> {
  const dir = opts.reuse?.dir ?? mkdtempSync(path.join(tmpdir(), 'hermes-offline-'));
  if (!opts.reuse) dirs.push(dir);
  const storage = opts.reuse?.storage ?? new TokenStorage(new MemKeyring());
  const lifecycleStore = opts.reuse?.lifecycleStore ?? new LifecycleStateStore(dir);
  const registry = new ServiceRegistry(dir);
  const provider = opts.reuse?.provider ?? spyProvider();
  registry.installProvider(provider);
  await registry.registerService({ name: 'fake', providerName: 'fake', schemes: ['main'], config: {}, createdAt: Date.now() });
  const gate = opts.gate ?? new StubGate('online');
  const broker = new Broker({
    storage, registry,
    validator: new TokenValidator({ policy: 'lazy', safetyMarginSec: 300 }),
    logger, dataDir: dir, lifecycleStore,
    connectivity: gate,
    adBudget: opts.adBudget,
    offlineOptions: opts.offlineOptions,
  });
  return { broker, storage, provider, gate, lifecycleStore, dir };
}

describe('config defaults', () => {
  it('applies connectivity / adBudget / consumerRateLimit defaults', () => {
    const parsed = BrokerConfigSchema.parse({ dataDir: '/tmp/x' });
    expect(parsed.connectivity).toMatchObject({
      probeHost: 'login.microsoftonline.com',
      probeTtlMs: 30_000,
      offlineRecheckMs: 30_000,
      failuresToOffline: 2,
      serveCachedWhileOffline: true,
    });
    expect(parsed.adBudget).toEqual({ maxAcquiresPerHour: 4, maxValidationsPerHour: 12 });
    expect(parsed.consumerRateLimit).toEqual({ maxTokenRequestsPer10s: 20 });
  });
});

describe('broker offline behavior', () => {
  it('serves a cached unexpired token with ZERO provider calls while offline', async () => {
    const h = await harness({ gate: new StubGate('offline') });
    const cached = bundle({ expiresAt: Date.now() + 3600_000 });
    await h.storage.set(cached);

    const result = await h.broker.getToken('fake', 'main');
    expect(result.accessToken).toBe(cached.accessToken);
    expect(result.extra?.hermesOfflineGrace).toBeUndefined(); // well outside margin
    expect(h.provider.acquire).not.toHaveBeenCalled();
    expect(h.provider.refresh).not.toHaveBeenCalled();
    expect(h.provider.validate).not.toHaveBeenCalled();
  });

  it('grace-flags a cached token inside the safety margin (copy only — storage untouched)', async () => {
    const h = await harness({ gate: new StubGate('offline') });
    const cached = bundle({ expiresAt: Date.now() + 100_000 }); // < 300s margin
    await h.storage.set(cached);

    const result = await h.broker.getToken('fake', 'main');
    expect(result.extra?.hermesOfflineGrace).toBe(true);
    const stored = await h.storage.get('fake', 'main');
    expect(stored?.extra?.hermesOfflineGrace).toBeUndefined();
    expect(h.provider.refresh).not.toHaveBeenCalled();
    expect(h.provider.acquire).not.toHaveBeenCalled();
  });

  it('NEVER serves a token past expiresAt — throws OFFLINE with retryAfterMs', async () => {
    const h = await harness({ gate: new StubGate('offline') });
    await h.storage.set(bundle({ expiresAt: Date.now() - 1_000 }));

    await expect(h.broker.getToken('fake', 'main')).rejects.toMatchObject({
      code: HermesErrorCode.OFFLINE,
      retryable: true,
      retryAfterMs: 30_000,
    });
    expect(h.provider.acquire).not.toHaveBeenCalled();
    expect(h.provider.refresh).not.toHaveBeenCalled();
  });

  it('force: true (health-monitor path) throws OFFLINE even with a valid cache — no browser', async () => {
    const h = await harness({ gate: new StubGate('offline') });
    await h.storage.set(bundle({ expiresAt: Date.now() + 3600_000 }));

    await expect(h.broker.getToken('fake', 'main', { force: true })).rejects.toMatchObject({ code: HermesErrorCode.OFFLINE });
    expect(h.provider.acquire).not.toHaveBeenCalled();
    expect(h.provider.refresh).not.toHaveBeenCalled();
    expect(h.provider.validate).not.toHaveBeenCalled();
  });

  it('scheduler refresh path (refresh: true) serves cache offline without provider.refresh', async () => {
    const h = await harness({ gate: new StubGate('offline') });
    const cached = bundle({ expiresAt: Date.now() + 3600_000 });
    await h.storage.set(cached);

    const result = await h.broker.getToken('fake', 'main', { refresh: true });
    expect(result.accessToken).toBe(cached.accessToken);
    expect(h.provider.refresh).not.toHaveBeenCalled();
    expect(h.provider.acquire).not.toHaveBeenCalled();
  });

  it('throws OFFLINE with no cache at all', async () => {
    const h = await harness({ gate: new StubGate('offline') });
    await expect(h.broker.getToken('fake', 'main')).rejects.toMatchObject({ code: HermesErrorCode.OFFLINE });
    expect(h.provider.acquire).not.toHaveBeenCalled();
  });

  it('serveCachedWhileOffline: false disables cache serving', async () => {
    const h = await harness({ gate: new StubGate('offline'), offlineOptions: { serveCachedWhileOffline: false } });
    await h.storage.set(bundle({ expiresAt: Date.now() + 3600_000 }));
    await expect(h.broker.getToken('fake', 'main')).rejects.toMatchObject({ code: HermesErrorCode.OFFLINE });
  });

  it('recovers normal acquire behavior when the gate flips back online', async () => {
    const gate = new StubGate('offline');
    const h = await harness({ gate });
    await expect(h.broker.getToken('fake', 'main')).rejects.toMatchObject({ code: HermesErrorCode.OFFLINE });
    gate.state = 'online';
    const result = await h.broker.getToken('fake', 'main');
    expect(result.accessToken).toMatch(/^tok-/);
    expect(h.provider.acquire).toHaveBeenCalledTimes(1);
  });
});

describe('AD acquire budget (sliding 1h window per service:scheme)', () => {
  it('allows maxAcquiresPerHour attempts then suppresses with REFRESH_IN_PROGRESS + retryAfterMs; window relaxes after 1h', async () => {
    vi.useFakeTimers({ now: new Date('2026-06-11T12:00:00Z') });
    const h = await harness({ adBudget: { maxAcquiresPerHour: 4 } });

    // Mixed triggers all funnel through acquireAndStore's acquireGate:
    // consumer force, health-monitor force, scheduler fallback are identical
    // at the provider.acquire call site.
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(60_000);
      await h.broker.getToken('fake', 'main', { force: true });
    }
    expect(h.provider.acquire).toHaveBeenCalledTimes(4);

    const err = await h.broker.getToken('fake', 'main', { force: true }).catch((e) => e);
    expect(err).toMatchObject({ code: HermesErrorCode.REFRESH_IN_PROGRESS, retryable: true });
    expect(err.retryAfterMs).toBeGreaterThan(0);
    expect(err.retryAfterMs).toBeLessThanOrEqual(3600_000);
    expect(h.provider.acquire).toHaveBeenCalledTimes(4); // 5th attempt never reached AD

    expect(h.broker.canAttemptAcquire('fake', 'main')).toMatchObject({ ok: false, reason: 'ad-budget' });

    // Advance past the window — oldest attempts age out, acquires allowed again.
    vi.advanceTimersByTime(3600_001);
    await h.broker.getToken('fake', 'main', { force: true });
    expect(h.provider.acquire).toHaveBeenCalledTimes(5);
    expect(h.broker.canAttemptAcquire('fake', 'main').ok).toBe(true);
  });

  it('canAttemptAcquire reports offline before any budget reasoning', async () => {
    const h = await harness({ gate: new StubGate('offline') });
    expect(h.broker.canAttemptAcquire('fake', 'main')).toMatchObject({ ok: false, reason: 'offline' });
  });
});

describe('validation gate / budget', () => {
  it('validationGate counts validations and suppresses past maxValidationsPerHour', async () => {
    const h = await harness({ adBudget: { maxValidationsPerHour: 2 } });
    expect(h.broker.validationGate('fake', 'main')).toBe('ok');
    expect(h.broker.validationGate('fake', 'main')).toBe('ok');
    expect(h.broker.validationGate('fake', 'main')).toBe('budget');
  });

  it('validationGate reports offline when the gate is not online', async () => {
    const h = await harness({ gate: new StubGate('offline') });
    expect(h.broker.validationGate('fake', 'main')).toBe('offline');
  });

  it('TokenValidator skips provider.validate when the gate vetoes, reporting not-run + fresh by expiry', async () => {
    const provider = spyProvider();
    const validator = new TokenValidator({
      policy: 'paranoid', safetyMarginSec: 300,
      validationGate: () => 'offline',
    });
    const ctx = { service: 'fake', config: {}, dataDir: '/tmp', logger } as unknown as ProviderContext;
    const assessment = await validator.assessFreshness(provider, ctx, bundle({ expiresAt: Date.now() + 3600_000 }), { cacheAge: 120 });
    expect(assessment).toMatchObject({ fresh: true, providerValidation: 'not-run' });
    expect(provider.validate).not.toHaveBeenCalled();
  });

  it('TokenValidator still validates when the gate says ok', async () => {
    const provider = spyProvider();
    const gateFn = vi.fn(() => 'ok' as const);
    const validator = new TokenValidator({ policy: 'paranoid', safetyMarginSec: 300, validationGate: gateFn });
    const ctx = { service: 'fake', config: {}, dataDir: '/tmp', logger } as unknown as ProviderContext;
    const assessment = await validator.assessFreshness(provider, ctx, bundle({ expiresAt: Date.now() + 3600_000 }), { cacheAge: 120 });
    expect(assessment.providerValidation).toBe('valid');
    expect(provider.validate).toHaveBeenCalledTimes(1);
    expect(gateFn).toHaveBeenCalledWith('fake', 'main');
  });
});

describe('acquire governor persistence (restart survival)', () => {
  it('AD budget suppression survives a broker restart via LifecycleStateStore hydration', async () => {
    const h = await harness({ adBudget: { maxAcquiresPerHour: 2 } });
    await h.broker.getToken('fake', 'main', { force: true });
    await h.broker.getToken('fake', 'main', { force: true });
    await expect(h.broker.getToken('fake', 'main', { force: true })).rejects.toMatchObject({ code: HermesErrorCode.REFRESH_IN_PROGRESS });

    // "Restart": new Broker over the same dataDir + storage + lifecycle store.
    const h2 = await harness({
      adBudget: { maxAcquiresPerHour: 2 },
      reuse: { dir: h.dir, storage: h.storage, lifecycleStore: h.lifecycleStore, provider: spyProvider() },
    });
    await h2.broker.init();
    expect(h2.broker.canAttemptAcquire('fake', 'main')).toMatchObject({ ok: false, reason: 'ad-budget' });
    await expect(h2.broker.getToken('fake', 'main', { force: true })).rejects.toMatchObject({ code: HermesErrorCode.REFRESH_IN_PROGRESS });
    expect(h2.provider.acquire).not.toHaveBeenCalled();
  });

  it('autoReacquire failure window + lastAcquireFailure survive a restart', async () => {
    const h = await harness({});
    const now = Date.now();
    await h.lifecycleStore.recordAcquireGovernorState('fake', 'main', {
      autoReacquireFailureTimes: [now - 60_000, now - 30_000],
      lastAcquireFailure: { isCa: false, at: now - 30_000, message: 'transient acquire failure' },
      cooldownIsCa: false,
    });

    const h2 = await harness({ reuse: { dir: h.dir, storage: h.storage, lifecycleStore: h.lifecycleStore, provider: spyProvider() } });
    await h2.broker.init();
    expect(h2.broker.canAttemptAcquire('fake', 'main')).toMatchObject({ ok: false, reason: 'auto-reacquire-suppressed' });
  });

  it('lifecycle-state round-trips the new governor fields (atomic tmp+rename file)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hermes-state-'));
    dirs.push(dir);
    const store = new LifecycleStateStore(dir);
    const now = Date.now();
    await store.recordAcquireGovernorState('svc', 'main', {
      autoReacquireFailureTimes: [now - 1000, now],
      lastAcquireFailure: { isCa: true, at: now, message: 'CA wall Bearer abc.def.ghi' },
      cooldownIsCa: true,
      adAcquireTimes: [now - 500],
    });
    // Fresh store instance (re-reads the file from disk).
    const reread = new LifecycleStateStore(dir);
    const state = await reread.get('svc', 'main');
    expect(state?.autoReacquireFailureTimes).toEqual([now - 1000, now]);
    expect(state?.lastAcquireFailure).toMatchObject({ isCa: true, at: now });
    expect(state?.lastAcquireFailure?.message).toContain('Bearer [redacted]'); // sanitized
    expect(state?.cooldownIsCa).toBe(true);
    expect(state?.adAcquireTimes).toEqual([now - 500]);
  });

  it('init() drops timestamps that have aged out of their windows', async () => {
    const h = await harness({});
    const stale = Date.now() - 2 * 3600_000;
    await h.lifecycleStore.recordAcquireGovernorState('fake', 'main', {
      autoReacquireFailureTimes: [stale],
      adAcquireTimes: [stale],
    });
    const h2 = await harness({ reuse: { dir: h.dir, storage: h.storage, lifecycleStore: h.lifecycleStore, provider: spyProvider() } });
    await h2.broker.init();
    expect(h2.broker.canAttemptAcquire('fake', 'main').ok).toBe(true);
  });
});
