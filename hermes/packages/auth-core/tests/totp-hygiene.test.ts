import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  generateTotp,
  makeTotpSupplier,
  supplyFreshTotp,
  resolveTotp,
  resetTotpReplayRegistryForTests,
  TotpRejectedError,
} from '../src/totp.js';

const SEED = 'JBSWY3DPEHPK3PXP';
const WINDOW_MS = 30_000;

function atWindow(windowIndex: number, offsetMs = 0): number {
  return windowIndex * WINDOW_MS + offsetMs;
}

beforeEach(() => {
  vi.useFakeTimers();
  resetTotpReplayRegistryForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('supplyFreshTotp — fill-time generation', () => {
  it('generates the code for the CURRENT window, not the acquire-time window', async () => {
    vi.setSystemTime(atWindow(1000, 1_000));
    const supplier = makeTotpSupplier('svc', SEED); // "acquire" happens here
    const acquireTimeCode = generateTotp(SEED, atWindow(1000, 1_000));

    // 90s of browser flow pass before the MFA input appears (3 windows later)
    vi.setSystemTime(atWindow(1003, 1_000));
    const code = await supplier();

    expect(code).toBe(generateTotp(SEED, atWindow(1003, 1_000)));
    expect(code).not.toBe(acquireTimeCode);
  });

  it('returns immediately when the window is fresh and unused', async () => {
    vi.setSystemTime(atWindow(2000, 10_000));
    const code = await supplyFreshTotp('svc', SEED);
    expect(code).toBe(generateTotp(SEED, atWindow(2000, 10_000)));
  });
});

describe('supplyFreshTotp — window-edge freshness guard', () => {
  it('waits for the next window boundary when <5s remain', async () => {
    vi.setSystemTime(atWindow(3000, 26_000)); // 4s remaining — too stale to submit
    let resolved: string | undefined;
    const pending = supplyFreshTotp('svc', SEED).then((c) => { resolved = c; });

    await vi.advanceTimersByTimeAsync(3_999);
    expect(resolved).toBeUndefined(); // still waiting for the boundary

    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(resolved).toBe(generateTotp(SEED, atWindow(3001, 0)));
  });

  it('does not wait when exactly 5s remain', async () => {
    vi.setSystemTime(atWindow(3010, 25_000)); // exactly 5s remaining — allowed
    const code = await supplyFreshTotp('svc', SEED);
    expect(code).toBe(generateTotp(SEED, atWindow(3010, 25_000)));
  });
});

describe('supplyFreshTotp — anti-replay across concurrent acquires', () => {
  it('second concurrent supply for the same service waits for the next window', async () => {
    vi.setSystemTime(atWindow(4000, 2_000));
    // Two concurrent acquires for the same service — separate supplier closures,
    // shared host-wide registry.
    const s1 = makeTotpSupplier('az-teams', SEED);
    const s2 = makeTotpSupplier('az-teams', SEED);

    const c1 = await s1();
    expect(c1).toBe(generateTotp(SEED, atWindow(4000, 2_000)));

    let c2: string | undefined;
    const pending = s2().then((c) => { c2 = c; });
    await vi.advanceTimersByTimeAsync(27_999);
    expect(c2).toBeUndefined(); // same window already used — waiting

    await vi.advanceTimersByTimeAsync(1); // crosses into window 4001
    await pending;
    expect(c2).toBe(generateTotp(SEED, atWindow(4001, 0)));
    expect(c2).not.toBe(c1);
  });

  it('different services do not block each other within the same window', async () => {
    vi.setSystemTime(atWindow(5000, 2_000));
    const codeA = await supplyFreshTotp('svc-a', SEED);
    const codeB = await supplyFreshTotp('svc-b', SEED);
    // Same window, same seed — same code; the point is neither had to wait.
    expect(codeA).toBe(generateTotp(SEED, atWindow(5000, 2_000)));
    expect(codeB).toBe(codeA);
  });

  it('reset helper clears the registry (same window becomes usable again)', async () => {
    vi.setSystemTime(atWindow(6000, 2_000));
    await supplyFreshTotp('svc', SEED);
    resetTotpReplayRegistryForTests();
    const again = await supplyFreshTotp('svc', SEED); // no wait needed
    expect(again).toBe(generateTotp(SEED, atWindow(6000, 2_000)));
  });
});

describe('resolveTotp — backward compatibility', () => {
  it('passes a plain string code through unchanged', async () => {
    expect(await resolveTotp('123456')).toBe('123456');
  });

  it('returns undefined for undefined input', async () => {
    expect(await resolveTotp(undefined)).toBeUndefined();
  });

  it('invokes a supplier at resolve time', async () => {
    vi.setSystemTime(atWindow(7000, 2_000));
    const supplier = makeTotpSupplier('svc', SEED);
    expect(await resolveTotp(supplier)).toBe(generateTotp(SEED, atWindow(7000, 2_000)));
  });
});

describe('TotpRejectedError', () => {
  it('names the remediation in its message', () => {
    const err = new TotpRejectedError();
    expect(err.name).toBe('TotpRejectedError');
    expect(err.message).toBe('TOTP rejected twice — verify the seed in the vault matches the IdP registration (sso-totp)');
  });
});
