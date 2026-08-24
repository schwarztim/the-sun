import { describe, it, expect, vi, afterEach } from 'vitest';
import { Writable } from 'node:stream';
import { TokenHealthMonitor, type TokenHealth } from '../src/health-monitor.js';
import { createLogger } from '../src/logger.js';
import { LifecycleStateStore } from '../src/lifecycle-state.js';
import type { TokenStorage } from '../src/storage.js';
import type { TokenBundle } from '../src/types.js';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const nullSink = new Writable({ write(_c, _e, cb) { cb(); } });
const logger = createLogger({ level: 'error', stream: nullSink, pretty: false });
const testDirs: string[] = [];

const bundle = (overrides: Partial<TokenBundle> = {}): TokenBundle => ({
  service: 'ms365', scheme: 'graph', accessToken: 'abc', tokenType: 'Bearer',
  expiresAt: Date.now() + 3600_000, acquiredAt: Date.now(),
  refreshToken: 'rt-valid',
  ...overrides,
});

function stubStorage(bundles: TokenBundle[]): TokenStorage {
  return { list: vi.fn(async () => bundles) } as unknown as TokenStorage;
}

function testDataDir(): string {
  const dir = path.join(process.cwd(), '.test-data', `health-monitor-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  testDirs.push(dir);
  return dir;
}

describe('TokenHealthMonitor', () => {
  let monitor: TokenHealthMonitor;
  afterEach(() => {
    monitor?.stop();
    while (testDirs.length > 0) rmSync(testDirs.pop()!, { recursive: true, force: true });
  });

  it('reports healthy for fresh tokens', async () => {
    const storage = stubStorage([bundle()]);
    monitor = new TokenHealthMonitor({ storage, logger });
    const results = await monitor.runCheck();
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('healthy');
    expect(results[0].refreshTokenAge).toBeLessThan(60_000);
  });

  it('reports no-refresh-token when missing', async () => {
    const storage = stubStorage([bundle({ refreshToken: undefined })]);
    monitor = new TokenHealthMonitor({ storage, logger });
    const results = await monitor.runCheck();
    expect(results[0].status).toBe('no-refresh-token');
    expect(results[0].refreshTokenAge).toBeNull();
  });

  it('reports expiring when approaching max age', async () => {
    const storage = stubStorage([bundle({ acquiredAt: Date.now() - 21 * 3600_000 })]);
    monitor = new TokenHealthMonitor({ storage, logger });
    const results = await monitor.runCheck();
    expect(results[0].status).toBe('expiring');
  });

  it('reports expired when past max age', async () => {
    const storage = stubStorage([bundle({ acquiredAt: Date.now() - 25 * 3600_000 })]);
    monitor = new TokenHealthMonitor({ storage, logger });
    const results = await monitor.runCheck();
    expect(results[0].status).toBe('expired');
  });

  it('calls onWarning for expiring tokens', async () => {
    const warnings: TokenHealth[] = [];
    const storage = stubStorage([bundle({ acquiredAt: Date.now() - 21 * 3600_000 })]);
    monitor = new TokenHealthMonitor({ storage, logger, onWarning: (h) => warnings.push(h) });
    await monitor.runCheck();
    expect(warnings).toHaveLength(1);
    expect(warnings[0].status).toBe('expiring');
  });

  it('calls onWarning for expired tokens', async () => {
    const warnings: TokenHealth[] = [];
    const storage = stubStorage([bundle({ acquiredAt: Date.now() - 25 * 3600_000 })]);
    monitor = new TokenHealthMonitor({ storage, logger, onWarning: (h) => warnings.push(h) });
    await monitor.runCheck();
    expect(warnings).toHaveLength(1);
    expect(warnings[0].status).toBe('expired');
  });

  it('does not call onWarning for healthy tokens', async () => {
    const warnings: TokenHealth[] = [];
    const storage = stubStorage([bundle()]);
    monitor = new TokenHealthMonitor({ storage, logger, onWarning: (h) => warnings.push(h) });
    await monitor.runCheck();
    expect(warnings).toHaveLength(0);
  });

  it('status() returns last check results', async () => {
    const storage = stubStorage([bundle()]);
    monitor = new TokenHealthMonitor({ storage, logger });
    expect(monitor.status()).toEqual([]);
    await monitor.runCheck();
    expect(monitor.status()).toHaveLength(1);
  });

  it('respects custom thresholds', async () => {
    const storage = stubStorage([bundle({ acquiredAt: Date.now() - 2 * 3600_000 })]);
    monitor = new TokenHealthMonitor({
      storage, logger,
      refreshTokenMaxAgeMs: 4 * 3600_000,
      warningThresholdMs: 1 * 3600_000,
    });
    const results = await monitor.runCheck();
    expect(results[0].status).toBe('expiring');
  });

  it('assess works with explicit now parameter', () => {
    const storage = stubStorage([]);
    monitor = new TokenHealthMonitor({ storage, logger, refreshTokenMaxAgeMs: 10_000, warningThresholdMs: 5_000 });
    const b = bundle({ acquiredAt: 1000 });
    expect(monitor.assess(b, 4000).status).toBe('healthy');
    expect(monitor.assess(b, 7000).status).toBe('expiring');
    expect(monitor.assess(b, 12000).status).toBe('expired');
  });

  it('records stored/fresh proof tiers in lifecycle state', async () => {
    const lifecycleStore = new LifecycleStateStore(testDataDir());
    const storage = stubStorage([bundle({ expiresAt: Date.now() + 3600_000, acquiredAt: Date.now() })]);
    monitor = new TokenHealthMonitor({ storage, logger, lifecycleStore, accessTokenFreshMarginMs: 300_000 });

    const results = await monitor.runCheck();

    expect(results[0].proof).toMatchObject({
      highestValidTier: 'fresh',
      currentTier: 'fresh',
      state: 'valid',
    });
    expect(await lifecycleStore.get('ms365', 'graph')).toMatchObject({
      proofTier: 'fresh',
      proofState: 'valid',
      proofEvents: [
        expect.objectContaining({ tier: 'stored', status: 'valid' }),
        expect.objectContaining({ tier: 'fresh', status: 'valid' }),
      ],
    });
  });

  it('keeps freshness as highest valid tier when synthetic provider validation degrades', async () => {
    const lifecycleStore = new LifecycleStateStore(testDataDir());
    const storage = stubStorage([bundle({ expiresAt: Date.now() + 3600_000, acquiredAt: Date.now() })]);
    monitor = new TokenHealthMonitor({
      storage,
      logger,
      lifecycleStore,
      providerValidationProbe: vi.fn(async () => ({
        tier: 'provider_validated',
        status: 'degraded',
        at: 1_700_000_001_000,
        error: 'synthetic validation unavailable',
      })),
    });

    const [result] = await monitor.runCheck();

    expect(result?.proof).toMatchObject({
      highestValidTier: 'fresh',
      currentTier: 'provider_validated',
      state: 'degraded',
    });
    expect(await lifecycleStore.get('ms365', 'graph')).toMatchObject({
      proofTier: 'fresh',
      proofState: 'degraded',
      proofEvents: expect.arrayContaining([
        expect.objectContaining({ tier: 'provider_validated', status: 'degraded', error: 'synthetic validation unavailable' }),
      ]),
    });
  });
});
