import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { scheduleStoredTokenRefreshes, scheduleTokenRefresh, scheduleFailureRetry, clearFailureBackoff, resetAllFailureBackoff } from '../src/lifecycle.js';
import type { ConnectivityGateLike } from '../src/connectivity.js';
import { HermesError, HermesErrorCode } from '../src/errors.js';
import { LifecycleStateStore } from '../src/lifecycle-state.js';
import type { Logger } from '../src/logger.js';
import type { ServiceRegistry } from '../src/registry.js';
import type { RefreshScheduler } from '../src/scheduler.js';
import type { TokenStorage } from '../src/storage.js';
import type { Provider, TokenBundle } from '../src/types.js';

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: vi.fn(),
  error: () => undefined,
  child: () => logger,
} as unknown as Logger;

const bundle = (overrides: Partial<TokenBundle> = {}): TokenBundle => ({
  service: 'ms365',
  scheme: 'graph',
  accessToken: 'access-token',
  tokenType: 'Bearer',
  expiresAt: 1_700_003_600_000,
  acquiredAt: 1_700_000_000_000,
  ...overrides,
});

const testDirs: string[] = [];
function testDataDir(): string {
  const dir = path.join(process.cwd(), '.test-data', `lifecycle-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  testDirs.push(dir);
  return dir;
}

function registry(provider?: Provider): ServiceRegistry {
  return {
    getService: vi.fn((name: string) => name === 'ms365' ? { name: 'ms365', providerName: 'ms365' } : undefined),
    getProvider: vi.fn(() => provider),
  } as unknown as ServiceRegistry;
}

describe('lifecycle scheduling', () => {
  afterEach(() => {
    while (testDirs.length > 0) rmSync(testDirs.pop()!, { recursive: true, force: true });
  });

  it('schedules a token using the provider nextRefreshAt value', async () => {
    const when = new Date(1_700_003_000_000);
    const provider = { nextRefreshAt: vi.fn(() => when) } as unknown as Provider;
    const scheduler = { schedule: vi.fn() } as unknown as RefreshScheduler;

    await expect(scheduleTokenRefresh(registry(provider), scheduler, bundle(), logger)).resolves.toBe(true);
    expect(scheduler.schedule).toHaveBeenCalledWith('ms365:graph', when);
  });

  it('does not schedule tokens for missing providers', async () => {
    const scheduler = { schedule: vi.fn() } as unknown as RefreshScheduler;

    await expect(scheduleTokenRefresh(registry(undefined), scheduler, bundle(), logger)).resolves.toBe(false);
    expect(scheduler.schedule).not.toHaveBeenCalled();
  });

  it('persists the next scheduled refresh when a lifecycle store is provided', async () => {
    const when = new Date(1_700_003_000_000);
    const provider = { nextRefreshAt: vi.fn(() => when) } as unknown as Provider;
    const scheduler = { schedule: vi.fn() } as unknown as RefreshScheduler;
    const lifecycleStore = new LifecycleStateStore(testDataDir());

    await expect(scheduleTokenRefresh(registry(provider), scheduler, bundle(), logger, undefined, lifecycleStore)).resolves.toBe(true);

    expect(await lifecycleStore.get('ms365', 'graph')).toMatchObject({
      service: 'ms365',
      scheme: 'graph',
      nextScheduledRefreshAt: when.getTime(),
    });
  });

  it('schedules all stored tokens that have installed providers', async () => {
    const when = new Date(1_700_003_000_000);
    const provider = { nextRefreshAt: vi.fn(() => when) } as unknown as Provider;
    const scheduler = { schedule: vi.fn() } as unknown as RefreshScheduler;
    const storage = { list: vi.fn(async () => [bundle(), bundle({ scheme: 'teams' })]) } as unknown as TokenStorage;

    const lifecycleStore = new LifecycleStateStore(testDataDir());
    const count = await scheduleStoredTokenRefreshes(storage, registry(provider), scheduler, logger, {
      now: () => 1_700_000_000_000,
      lifecycleStore,
    });

    expect(count).toBe(2);
    expect(scheduler.schedule).toHaveBeenCalledWith('ms365:graph', when);
    expect(scheduler.schedule).toHaveBeenCalledWith('ms365:teams', when);
    expect(await lifecycleStore.get('ms365', 'teams')).toMatchObject({ nextScheduledRefreshAt: when.getTime() });
  });

  it('staggers overdue stored tokens on startup', async () => {
    const provider = { nextRefreshAt: vi.fn(() => new Date(1_700_000_000_000)) } as unknown as Provider;
    const scheduler = { schedule: vi.fn() } as unknown as RefreshScheduler;
    const storage = { list: vi.fn(async () => [bundle(), bundle({ scheme: 'teams' })]) } as unknown as TokenStorage;

    await scheduleStoredTokenRefreshes(storage, registry(provider), scheduler, logger, {
      now: () => 1_700_001_000_000,
      overdueDelayMs: 60_000,
      overdueStaggerMs: 15_000,
    });

    expect(scheduler.schedule).toHaveBeenCalledWith('ms365:graph', new Date(1_700_001_060_000));
    expect(scheduler.schedule).toHaveBeenCalledWith('ms365:teams', new Date(1_700_001_075_000));
  });

  it('recovery pass: folds jitterMs into the overdue stagger; healthy tokens keep nextRefreshAt', async () => {
    const now = 1_700_001_000_000;
    // graph + teams overdue (nextRefreshAt in the past), healthy in the future.
    const provider = {
      nextRefreshAt: vi.fn((b: TokenBundle) => b.scheme === 'healthy' ? new Date(now + 1_800_000) : new Date(now - 1)),
    } as unknown as Provider;
    const scheduler = { schedule: vi.fn() } as unknown as RefreshScheduler;
    const storage = { list: vi.fn(async () => [bundle(), bundle({ scheme: 'teams' }), bundle({ scheme: 'healthy' })]) } as unknown as TokenStorage;

    const count = await scheduleStoredTokenRefreshes(storage, registry(provider), scheduler, logger, {
      now: () => now,
      overdueDelayMs: 30_000,
      overdueStaggerMs: 10_000,
      jitterMs: 5_000,
      random: () => 0.5, // deterministic jitter = 2500
    });

    expect(count).toBe(3);
    // Overdue keys: staggered + jittered — no thundering herd.
    expect(scheduler.schedule).toHaveBeenCalledWith('ms365:graph', new Date(now + 30_000 + 0 + 2_500));
    expect(scheduler.schedule).toHaveBeenCalledWith('ms365:teams', new Date(now + 30_000 + 10_000 + 2_500));
    // Healthy key: scheduled at its own nextRefreshAt — untouched by the stagger.
    expect(scheduler.schedule).toHaveBeenCalledWith('ms365:healthy', new Date(now + 1_800_000));
  });

  it('does not fail broker startup when stored token inventory cannot be loaded', async () => {
    const scheduler = { schedule: vi.fn() } as unknown as RefreshScheduler;
    const storage = { list: vi.fn(async () => { throw new Error('vault is temporarily locked'); }) } as unknown as TokenStorage;

    await expect(scheduleStoredTokenRefreshes(storage, registry(undefined), scheduler, logger)).resolves.toBe(0);
    expect(scheduler.schedule).not.toHaveBeenCalled();
  });
});

describe('scheduleFailureRetry classification', () => {
  afterEach(() => clearFailureBackoff('ms365', 'graph'));

  it('does NOT schedule a retry for REFRESH_IN_PROGRESS (the in-flight acquire re-arms)', () => {
    const scheduler = { schedule: vi.fn() } as unknown as RefreshScheduler;
    const err = new HermesError(HermesErrorCode.REFRESH_IN_PROGRESS, 'acquire in flight');
    scheduleFailureRetry(scheduler, 'ms365', 'graph', err, logger);
    expect(scheduler.schedule).not.toHaveBeenCalled();
  });

  it('uses the 30-minute auth heartbeat for INTERACTIVE_AUTH_REQUIRED (dead RT after fix)', () => {
    const scheduler = { schedule: vi.fn() } as unknown as RefreshScheduler;
    const err = new HermesError(HermesErrorCode.INTERACTIVE_AUTH_REQUIRED, 'reauth needed');
    scheduleFailureRetry(scheduler, 'ms365', 'graph', err, logger);
    expect(scheduler.schedule).toHaveBeenCalledTimes(1);
    const when = (scheduler.schedule as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as Date;
    const delayMs = when.getTime() - Date.now();
    expect(delayMs).toBeGreaterThan(25 * 60_000);
    expect(delayMs).toBeLessThanOrEqual(30 * 60_000 + 1_000);
  });

  it('uses the 30-minute auth heartbeat for ACQUIRE_REQUIRED', () => {
    const scheduler = { schedule: vi.fn() } as unknown as RefreshScheduler;
    const err = new HermesError(HermesErrorCode.ACQUIRE_REQUIRED, 'acquire needed');
    scheduleFailureRetry(scheduler, 'ms365', 'graph', err, logger);
    const when = (scheduler.schedule as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as Date;
    expect(when.getTime() - Date.now()).toBeGreaterThan(25 * 60_000);
  });

  it('honors a transient retryAfterMs (floored at 30s) for REFRESH_FAILED', () => {
    const scheduler = { schedule: vi.fn() } as unknown as RefreshScheduler;
    const err = new HermesError(HermesErrorCode.REFRESH_FAILED, 'transient', { retryAfterMs: 30_000, retryable: true });
    scheduleFailureRetry(scheduler, 'ms365', 'graph', err, logger);
    const when = (scheduler.schedule as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as Date;
    const delayMs = when.getTime() - Date.now();
    expect(delayMs).toBeGreaterThanOrEqual(25_000);
    expect(delayMs).toBeLessThan(60_000);
  });

  it('re-arms at a FIXED cadence for OFFLINE errors without escalating backoff', () => {
    const scheduler = { schedule: vi.fn() } as unknown as RefreshScheduler;
    const offlineErr = new HermesError(HermesErrorCode.OFFLINE, 'no network path', { retryAfterMs: 30_000 });
    // Three consecutive offline re-arms — all at the same fixed cadence.
    for (let i = 0; i < 3; i++) {
      scheduleFailureRetry(scheduler, 'ms365', 'graph', offlineErr, logger, { offlineRearmMs: 60_000, random: () => 0 });
    }
    expect(scheduler.schedule).toHaveBeenCalledTimes(3);
    for (const call of (scheduler.schedule as unknown as ReturnType<typeof vi.fn>).mock.calls) {
      const delayMs = (call[1] as Date).getTime() - Date.now();
      expect(delayMs).toBeGreaterThan(55_000);
      expect(delayMs).toBeLessThanOrEqual(60_000 + 1_000); // fixed, never escalated
    }
    // Offline time did NOT escalate the counter: the next ONLINE transient
    // failure starts at the 30s floor, not 30s * 2^3.
    const transient = new HermesError(HermesErrorCode.REFRESH_FAILED, 'transient', { retryable: true });
    scheduleFailureRetry(scheduler, 'ms365', 'graph', transient, logger);
    const when = (scheduler.schedule as unknown as ReturnType<typeof vi.fn>).mock.calls[3][1] as Date;
    expect(when.getTime() - Date.now()).toBeLessThan(45_000);
  });

  it('uses the offline re-arm path when the connectivity gate reports non-online (any error class)', () => {
    const scheduler = { schedule: vi.fn() } as unknown as RefreshScheduler;
    const gate: ConnectivityGateLike = { isOnline: async () => false, getState: () => 'offline' };
    const transient = new HermesError(HermesErrorCode.REFRESH_FAILED, 'ENOTFOUND login.microsoftonline.com', { retryable: true });
    scheduleFailureRetry(scheduler, 'ms365', 'graph', transient, logger, { connectivity: gate, offlineRearmMs: 60_000, random: () => 0 });
    const when = (scheduler.schedule as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as Date;
    const delayMs = when.getTime() - Date.now();
    expect(delayMs).toBeGreaterThan(55_000);
    expect(delayMs).toBeLessThanOrEqual(61_000);
    // No counter escalation: a subsequent online transient starts at the floor.
    scheduleFailureRetry(scheduler, 'ms365', 'graph', transient, logger);
    const when2 = (scheduler.schedule as unknown as ReturnType<typeof vi.fn>).mock.calls[1][1] as Date;
    expect(when2.getTime() - Date.now()).toBeLessThan(45_000);
  });

  it('stops re-arming after MAX consecutive failures (chronic loop → requires hermes acquire)', () => {
    const scheduler = { schedule: vi.fn() } as unknown as RefreshScheduler;
    const transient = new HermesError(HermesErrorCode.REFRESH_FAILED, 'No cookies captured', { retryable: true });
    // Five consecutive online failures: only the first re-arms; the cap stops the
    // rest, so the chronic reacquire/MFA-spam loop cannot run forever.
    for (let i = 0; i < 5; i++) {
      scheduleFailureRetry(scheduler, 'northwind-wsa', 'session', transient, logger);
    }
    expect(scheduler.schedule).toHaveBeenCalledTimes(1);
    clearFailureBackoff('northwind-wsa', 'session');
  });

  it('also caps the INTERACTIVE_AUTH_REQUIRED heartbeat (no endless 30-min MFA pings)', () => {
    const scheduler = { schedule: vi.fn() } as unknown as RefreshScheduler;
    const authErr = new HermesError(HermesErrorCode.INTERACTIVE_AUTH_REQUIRED, 'reauth needed');
    scheduleFailureRetry(scheduler, 'fabrikam', 'session', authErr, logger);
    scheduleFailureRetry(scheduler, 'fabrikam', 'session', authErr, logger);
    scheduleFailureRetry(scheduler, 'fabrikam', 'session', authErr, logger);
    expect(scheduler.schedule).toHaveBeenCalledTimes(1); // first heartbeat only, then capped
    clearFailureBackoff('fabrikam', 'session');
  });

  it('resetAllFailureBackoff clears the cap so the service can be retried again', () => {
    const scheduler = { schedule: vi.fn() } as unknown as RefreshScheduler;
    const transient = new HermesError(HermesErrorCode.REFRESH_FAILED, 'transient', { retryable: true });
    // First failure re-arms at the 30s floor; the second hits the cap (no re-arm).
    scheduleFailureRetry(scheduler, 'ms365', 'graph', transient, logger);
    scheduleFailureRetry(scheduler, 'ms365', 'graph', transient, logger);
    expect(scheduler.schedule).toHaveBeenCalledTimes(1);
    const first = (scheduler.schedule as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as Date;
    expect(first.getTime() - Date.now()).toBeLessThan(45_000);

    // A successful acquire (or post-offline recovery) clears the cap so retries resume.
    resetAllFailureBackoff();
    scheduleFailureRetry(scheduler, 'ms365', 'graph', transient, logger);
    expect(scheduler.schedule).toHaveBeenCalledTimes(2);
    const afterReset = (scheduler.schedule as unknown as ReturnType<typeof vi.fn>).mock.calls[1][1] as Date;
    expect(afterReset.getTime() - Date.now()).toBeLessThan(45_000);
  });

  it('does not bump the failure counter for REFRESH_IN_PROGRESS', () => {
    const scheduler = { schedule: vi.fn() } as unknown as RefreshScheduler;
    const inProgress = new HermesError(HermesErrorCode.REFRESH_IN_PROGRESS, 'in flight');
    // Two in-progress events then one real transient: backoff must start at the
    // first failure (30s), proving the in-progress events did not inflate it.
    scheduleFailureRetry(scheduler, 'ms365', 'graph', inProgress, logger);
    scheduleFailureRetry(scheduler, 'ms365', 'graph', inProgress, logger);
    const transient = new HermesError(HermesErrorCode.REFRESH_FAILED, 'transient', { retryable: true });
    scheduleFailureRetry(scheduler, 'ms365', 'graph', transient, logger);
    expect(scheduler.schedule).toHaveBeenCalledTimes(1);
    const when = (scheduler.schedule as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as Date;
    const delayMs = when.getTime() - Date.now();
    expect(delayMs).toBeLessThan(45_000); // first transient failure → ~30s, not exponentially inflated
  });
});
