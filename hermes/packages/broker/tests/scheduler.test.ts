import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Writable } from 'node:stream';
import { RefreshScheduler } from '../src/scheduler.js';
import { createLogger } from '../src/logger.js';

const nullSink = new Writable({ write(_c, _e, cb) { cb(); } });
const logger = createLogger({ level: 'error', stream: nullSink, pretty: false });

describe('RefreshScheduler', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('invokes refresh at the scheduled time', async () => {
    const refresh = vi.fn(async () => {});
    const s = new RefreshScheduler({ logger, refresh });
    s.schedule('ms365:graph', new Date(Date.now() + 1000));
    await vi.advanceTimersByTimeAsync(1100);
    expect(refresh).toHaveBeenCalledWith('ms365', 'graph');
  });
  it('replaces existing schedule for same key', async () => {
    const refresh = vi.fn(async () => {});
    const s = new RefreshScheduler({ logger, refresh });
    s.schedule('ms365:graph', new Date(Date.now() + 10_000));
    s.schedule('ms365:graph', new Date(Date.now() + 500));
    await vi.advanceTimersByTimeAsync(600);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
  it('cancels a scheduled refresh', async () => {
    const refresh = vi.fn(async () => {});
    const s = new RefreshScheduler({ logger, refresh });
    s.schedule('ms365:graph', new Date(Date.now() + 500));
    s.cancel('ms365:graph');
    await vi.advanceTimersByTimeAsync(1000);
    expect(refresh).not.toHaveBeenCalled();
  });
  // Timer-input guards. Both of these previously produced an IMMEDIATE fire,
  // and because provider.refresh is not behind acquireGate and the disarm
  // counter only counts failures, a refresh that kept SUCCEEDING would loop
  // against the IdP at full speed with nothing to stop it.
  it('refuses to schedule on a non-finite refresh time instead of firing immediately', async () => {
    const refresh = vi.fn(async () => {});
    const s = new RefreshScheduler({ logger, refresh });
    s.schedule('ms365:graph', new Date(Number.NaN));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).not.toHaveBeenCalled();
    expect(s.pendingKeys()).not.toContain('ms365:graph');
  });

  it('clears any armed timer when a later schedule call passes an invalid date', async () => {
    const refresh = vi.fn(async () => {});
    const s = new RefreshScheduler({ logger, refresh });
    s.schedule('ms365:graph', new Date(Date.now() + 500));
    s.schedule('ms365:graph', new Date(Number.NaN));
    await vi.advanceTimersByTimeAsync(1000);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('re-arms in chunks past the setTimeout max instead of overflowing to an immediate fire', async () => {
    const refresh = vi.fn(async () => {});
    const s = new RefreshScheduler({ logger, refresh });
    const TIMEOUT_MAX_MS = 2_147_483_647;
    const beyondMax = TIMEOUT_MAX_MS + 5_000;
    s.schedule('ms365:graph', new Date(Date.now() + beyondMax));

    // A raw setTimeout(beyondMax) would have fired about now.
    await vi.advanceTimersByTimeAsync(TIMEOUT_MAX_MS);
    expect(refresh).not.toHaveBeenCalled();
    expect(s.pendingKeys()).toContain('ms365:graph');

    // The remainder is armed as a second hop and fires at the real target.
    await vi.advanceTimersByTimeAsync(5_100);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith('ms365', 'graph');
  });

  it('logs and continues on refresh errors', async () => {
    const refresh = vi.fn(async () => { throw new Error('boom'); });
    const s = new RefreshScheduler({ logger, refresh });
    s.schedule('ms365:graph', new Date(Date.now() + 100));
    await vi.advanceTimersByTimeAsync(200);
    expect(refresh).toHaveBeenCalledTimes(1);
    s.schedule('ms365:graph', new Date(Date.now() + 100));
    await vi.advanceTimersByTimeAsync(200);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
