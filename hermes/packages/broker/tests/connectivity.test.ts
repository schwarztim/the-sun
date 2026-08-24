import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConnectivityGate } from '../src/connectivity.js';
import type { Logger } from '../src/logger.js';

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
} as unknown as Logger;

const config = {
  probeHost: 'login.microsoftonline.com',
  probeTtlMs: 30_000,
  offlineRecheckMs: 30_000,
  failuresToOffline: 2,
  serveCachedWhileOffline: true,
};

describe('ConnectivityGate', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function gateWith(probeFn: () => Promise<boolean>): ConnectivityGate {
    const gate = new ConnectivityGate({ logger, config, probeFn, jitterFn: () => 0 });
    gate.start();
    return gate;
  }

  it('caches probe results for probeTtlMs (one probe per window)', async () => {
    const probeFn = vi.fn(async () => true);
    const gate = gateWith(probeFn);
    await expect(gate.isOnline()).resolves.toBe(true);
    await expect(gate.isOnline()).resolves.toBe(true);
    expect(probeFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(31_000);
    await expect(gate.isOnline()).resolves.toBe(true);
    expect(probeFn).toHaveBeenCalledTimes(2);
    gate.stop();
  });

  it('requires failuresToOffline CONSECUTIVE failures before transitioning offline', async () => {
    const probeFn = vi.fn(async () => false);
    const gate = gateWith(probeFn);
    const offlineEvents = vi.fn();
    gate.on('offline', offlineEvents);

    await expect(gate.isOnline()).resolves.toBe(false); // failure 1 — debounced
    expect(gate.getState()).toBe('online');
    expect(offlineEvents).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(31_000); // expire probe cache
    await expect(gate.isOnline()).resolves.toBe(false); // failure 2 → offline
    expect(gate.getState()).toBe('offline');
    expect(offlineEvents).toHaveBeenCalledTimes(1);
    gate.stop();
  });

  it('a success between failures resets the consecutive counter', async () => {
    const results = [false, true, false];
    const probeFn = vi.fn(async () => results.shift() ?? true);
    const gate = gateWith(probeFn);

    await gate.isOnline(); // fail (1)
    await vi.advanceTimersByTimeAsync(31_000);
    await gate.isOnline(); // success → counter reset
    await vi.advanceTimersByTimeAsync(31_000);
    await gate.isOnline(); // fail (1 again — NOT 2)
    expect(gate.getState()).toBe('online');
    gate.stop();
  });

  it('while offline, isOnline() returns false without probing; recheck loop recovers and emits online exactly once per episode', async () => {
    let result = false;
    const probeFn = vi.fn(async () => result);
    const gate = gateWith(probeFn);
    const onlineEvents = vi.fn();
    gate.on('online', onlineEvents);

    // Drive offline: two consecutive failures.
    await gate.isOnline();
    await vi.advanceTimersByTimeAsync(31_000);
    await gate.isOnline();
    expect(gate.getState()).toBe('offline');
    const probesAtOffline = probeFn.mock.calls.length;

    // isOnline while offline = false, no probe.
    await expect(gate.isOnline()).resolves.toBe(false);
    await expect(gate.isOnline()).resolves.toBe(false);
    expect(probeFn).toHaveBeenCalledTimes(probesAtOffline);

    // Recheck fires while still down — stays offline, re-arms.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(gate.getState()).toBe('offline');
    expect(onlineEvents).not.toHaveBeenCalled();

    // Network restored: next recheck flips to recovering + single 'online'.
    result = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(gate.getState()).toBe('recovering');
    expect(onlineEvents).toHaveBeenCalledTimes(1);

    // isOnline() in recovering returns true (cached success) — acquires may proceed.
    await expect(gate.isOnline()).resolves.toBe(true);

    // Orchestrator completes the transition.
    gate.markOnline();
    expect(gate.getState()).toBe('online');

    // Advancing more time does NOT double-fire the event.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(onlineEvents).toHaveBeenCalledTimes(1);

    // Second offline episode → second single event (one per transition).
    result = false;
    await gate.isOnline();
    await vi.advanceTimersByTimeAsync(31_000);
    await gate.isOnline();
    expect(gate.getState()).toBe('offline');
    result = true;
    await vi.advanceTimersByTimeAsync(35_000);
    expect(onlineEvents).toHaveBeenCalledTimes(2);
    gate.stop();
  });

  it('a throwing probeFn counts as a failure', async () => {
    const probeFn = vi.fn(async () => { throw new Error('probe exploded'); });
    const gate = gateWith(probeFn);
    await expect(gate.isOnline()).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(31_000);
    await expect(gate.isOnline()).resolves.toBe(false);
    expect(gate.getState()).toBe('offline');
    gate.stop();
  });

  it('stop() cancels the offline recheck timer', async () => {
    let result = false;
    const probeFn = vi.fn(async () => result);
    const gate = gateWith(probeFn);
    await gate.isOnline();
    await vi.advanceTimersByTimeAsync(31_000);
    await gate.isOnline();
    expect(gate.getState()).toBe('offline');
    gate.stop();
    result = true;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(gate.getState()).toBe('offline'); // no recheck ran
  });
});
