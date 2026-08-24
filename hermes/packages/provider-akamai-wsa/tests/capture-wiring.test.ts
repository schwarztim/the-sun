/**
 * Tests for debug-state capture wiring in AkamaiWsaProvider's SSO loop.
 *
 * These tests require module-level vi.mock for both 'patchright' and '@hermes/auth-core'
 * since vitest hoists vi.mock calls. A fake browser/page stack drives the SSO loop
 * without needing a real browser.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CaptureDebugStateOptions, CaptureDebugStateResult } from '@hermes/auth-core';
import type { ProviderContext } from '@hermes/broker';

const NOW = 1_700_000_000_000;
// Minimum allowed by AkamaiWsaConfigSchema (5000ms). We use fake timers to advance
// Date.now() past the deadline after the stall has fired, keeping tests fast.
const AUTH_TIMEOUT_MS = 5_000;

const AKAMAI_AUTH_URL = 'https://control.akamai.com/apps/auth';
const AKAMAI_CC_URL = 'https://control.akamai.com/apps/security-analytics';
const SSO_URL = 'https://login.microsoftonline.com/auth';

const nullLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function ctx(config: Record<string, unknown> = {}): ProviderContext {
  return {
    service: 'akamai-wsa',
    config: {
      loginHint: 'u@example.com',
      authTimeoutMs: AUTH_TIMEOUT_MS,
      wafConfigId: 12345,
      ...config,
    },
    dataDir: `${process.cwd()}/.test-data/capture-wiring-akamai`,
    logger: nullLogger,
  };
}

// ---------------------------------------------------------------------------
// Fake capture dep helper
// ---------------------------------------------------------------------------

function fakeCapture(): {
  fn: (opts: CaptureDebugStateOptions) => Promise<CaptureDebugStateResult>;
  calls: CaptureDebugStateOptions[];
  captureDir: string;
} {
  const captureDir = '/fake/diag/akamai-wsa/2026-01-01T00-00-00.000Z';
  const calls: CaptureDebugStateOptions[] = [];
  const fn = vi.fn(async (opts: CaptureDebugStateOptions): Promise<CaptureDebugStateResult> => {
    calls.push(opts);
    return { captureDir, files: {}, errors: [] };
  });
  return { fn, calls, captureDir };
}

// ---------------------------------------------------------------------------
// Fake Page / Browser Context factory
// ---------------------------------------------------------------------------

type FakePageOpts = {
  /** Sequence of URLs returned by page.url() in order; last entry repeats. */
  urls?: string[];
  /** If true, isVisible() always returns true for locator calls (simulates visible fields). */
  allFieldsVisible?: boolean;
};

function makeFakePage(opts: FakePageOpts = {}) {
  const urlQueue: string[] = opts.urls ?? [AKAMAI_AUTH_URL];
  let urlIdx = 0;

  const isVisibleResult = opts.allFieldsVisible ?? false;
  const locatorObj = {
    isVisible: vi.fn().mockResolvedValue(isVisibleResult),
    first: vi.fn().mockReturnThis(),
    click: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    type: vi.fn().mockResolvedValue(undefined),
  };
  // Make locator().first() return the same obj (chaining)
  locatorObj.first.mockReturnValue(locatorObj);

  const page = {
    url: vi.fn(() => urlQueue[Math.min(urlIdx++, urlQueue.length - 1)]),
    // locator — all isVisible return false by default (no credential fields → no action → stall)
    locator: vi.fn().mockReturnValue(locatorObj),
    on: vi.fn(),
    goto: vi.fn().mockResolvedValue(null),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(null),
    // For CaptureablePage interface
    screenshot: vi.fn().mockResolvedValue(Buffer.from('')),
    content: vi.fn().mockResolvedValue('<html></html>'),
  };
  return page;
}

type FakeContextOpts = {
  /** Cookies returned by context.cookies(). Defaults to empty (triggers no_session_cookies). */
  cookies?: Array<{ name: string; value: string; domain: string }>;
};

function makeFakeBrowserContext(page: ReturnType<typeof makeFakePage>, opts: FakeContextOpts = {}) {
  const cookiesList = opts.cookies ?? [];
  return {
    newPage: vi.fn().mockResolvedValue(page),
    cookies: vi.fn().mockResolvedValue(cookiesList),
  };
}

// ---------------------------------------------------------------------------
// Module-level mocks — hoisted by vitest before any imports.
// ---------------------------------------------------------------------------

let _currentPage: ReturnType<typeof makeFakePage> = makeFakePage();
let _currentBrowserContext: ReturnType<typeof makeFakeBrowserContext> = makeFakeBrowserContext(_currentPage);

vi.mock('patchright', () => ({
  firefox: {
    launch: vi.fn().mockImplementation(async () => ({
      newContext: vi.fn().mockImplementation(async () => _currentBrowserContext),
      close: vi.fn().mockResolvedValue(undefined),
    })),
  },
}));

// Mock auth-core: keep real implementations for most; override only what drives real DOM.
vi.mock('@hermes/auth-core', async (importOriginal) => {
  const original = await importOriginal<typeof import('@hermes/auth-core')>();
  return {
    ...original,
    // trySelector — return false (no form interactions)
    trySelector: vi.fn().mockResolvedValue(false),
    // withManagedBrowser — bypass the real lifecycle wrapper. Its internals make
    // additional Date.now() calls (registry timestamps), which would shift the
    // call-count-based Date.now() advancer below and break the deadline phases.
    withManagedBrowser: vi.fn(async (_opts: unknown, fn: (browser: unknown) => Promise<unknown>) =>
      fn({
        newContext: vi.fn().mockImplementation(async () => _currentBrowserContext),
        close: vi.fn().mockResolvedValue(undefined),
      })),
  };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Fake timer helper — controls Date.now() to drive the deadline-bounded loops.
//
// The outer SSO loop condition: Date.now() < deadline (deadline = start + 5000ms).
// The cookie-polling loop condition: Date.now() - cookieWaitStart < 15_000ms.
//
// Strategy:
//   Phase 1 — calls 1..6: advance by 1001ms each.
//     deadline = call-1 result + 5000 = BASE + 5000.
//     Calls 1-5: BASE, BASE+1001, BASE+2002, BASE+3003, BASE+4004 — all < deadline.
//     Call 6:    BASE+5005 — exceeds deadline → outer loop exits.
//     This gives exactly 5 outer-loop iterations, which is enough for stall to fire
//     at iteration 4 (unchangedFor reaches 3 after iterations 1-4: set, 1, 2, 3).
//
//   Phase 2 — calls 7+: return BASE + 30_000.
//     cookieWaitStart = ~BASE+6006. Then Date.now() - cookieWaitStart = ~24000 > 15000
//     → cookie polling exits immediately after the first check.
// ---------------------------------------------------------------------------

function makeDeadlineAdvancer() {
  const BASE = 1_700_000_000_000;
  // Phase 1 (calls 1-6): advance by 1001ms each, driving outer SSO loop.
  //   Call 1: BASE         → deadline setup. deadline = BASE + AUTH_TIMEOUT_MS.
  //   Call 2: BASE+1001    → outer-loop condition iter 0 → enters (stall: unch=0)
  //   Call 3: BASE+2002    → outer-loop condition iter 1 → enters (stall: unch=1)
  //   Call 4: BASE+3003    → outer-loop condition iter 2 → enters (stall: unch=2)
  //   Call 5: BASE+4004    → outer-loop condition iter 3 → enters (stall: unch=3 → FIRES)
  //   Call 6: BASE+5005    → outer-loop condition iter 4 → >= deadline → EXITS outer loop
  //
  // Phase 2 (call 7): cookieWaitStart = BASE+5005 (reuse same value; cheap)
  //
  // Phase 3 (call 8): cookie-loop condition check 1: BASE+5006 → diff=1 < 15000 → runs body
  //   Body executes context.cookies() — gets whatever is in the fake context.
  //   If hasSession → break (for AKASSO tests)
  //   If no break → continues to call 9.
  //
  // Phase 4 (call 9+): BASE+5005+20000 → diff=20000 >= 15000 → exits cookie loop
  let call = 0;
  const COOKIE_WAIT_START = BASE + 5005;
  return vi.spyOn(Date, 'now').mockImplementation(() => {
    call += 1;
    if (call <= 6) return BASE + (call - 1) * 1001; // 0, 1001, 2002, 3003, 4004, 5005
    if (call === 7) return COOKIE_WAIT_START;        // cookieWaitStart
    if (call === 8) return COOKIE_WAIT_START + 1;    // first body check passes
    return COOKIE_WAIT_START + 20_000;               // exits cookie loop
  });
}

describe('AkamaiWsaProvider — debug state capture wiring', () => {
  let dateNowSpy: ReturnType<typeof makeDeadlineAdvancer> | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    dateNowSpy = makeDeadlineAdvancer();
  });

  afterEach(() => {
    dateNowSpy?.mockRestore();
    dateNowSpy = undefined;
  });

  it('stall capture fires after 3 consecutive unchanged-fingerprint iterations', async () => {
    // URL stays constant on Akamai auth page, no visible fields → fingerprint never changes → stall
    _currentPage = makeFakePage({ urls: [AKAMAI_AUTH_URL] });
    _currentBrowserContext = makeFakeBrowserContext(_currentPage);

    const { fn: captureDebugState, calls } = fakeCapture();
    const { AkamaiWsaProvider } = await import('../src/provider.js');
    const p = new AkamaiWsaProvider({ now: () => NOW, captureDebugState });

    await p.acquire(ctx(), 'session').catch(() => {});

    const stallCall = calls.find((c) => c.reason === 'stall');
    expect(stallCall).toBeDefined();
    expect(stallCall?.service).toBe('akamai-wsa');
    expect(stallCall?.stepLog).toBeDefined();
    expect((stallCall?.stepLog ?? []).length).toBeGreaterThan(0);
  });

  it('stall capture fires at most once per acquire even when loop stays stuck', async () => {
    _currentPage = makeFakePage({ urls: [AKAMAI_AUTH_URL] });
    _currentBrowserContext = makeFakeBrowserContext(_currentPage);

    const { fn: captureDebugState, calls } = fakeCapture();
    const { AkamaiWsaProvider } = await import('../src/provider.js');
    const p = new AkamaiWsaProvider({ now: () => NOW, captureDebugState });

    await p.acquire(ctx(), 'session').catch(() => {});

    const stallCalls = calls.filter((c) => c.reason === 'stall');
    expect(stallCalls.length).toBeLessThanOrEqual(1);
  });

  it('stall capture does NOT fire when URL changes every iteration', async () => {
    // URL advances each step → fingerprint changes → unchangedFor never reaches 3
    const progressingUrls = Array.from({ length: 15 }, (_, i) => `${AKAMAI_AUTH_URL}?step=${i}`);
    _currentPage = makeFakePage({ urls: progressingUrls });
    _currentBrowserContext = makeFakeBrowserContext(_currentPage);

    const { fn: captureDebugState, calls } = fakeCapture();
    const { AkamaiWsaProvider } = await import('../src/provider.js');
    const p = new AkamaiWsaProvider({ now: () => NOW, captureDebugState });

    await p.acquire(ctx(), 'session').catch(() => {});

    const stallCalls = calls.filter((c) => c.reason === 'stall');
    expect(stallCalls.length).toBe(0);
  });

  it('stall fires even when loop iterates without credential actions (no !acted guard)', async () => {
    // URL stays constant, no visible fields → loop does nothing each iteration → stall fires
    // This verifies the absence of a "!acted" guard (Phase 1 lesson).
    _currentPage = makeFakePage({ urls: [SSO_URL] });
    _currentBrowserContext = makeFakeBrowserContext(_currentPage);

    const { fn: captureDebugState, calls } = fakeCapture();
    const { AkamaiWsaProvider } = await import('../src/provider.js');
    const p = new AkamaiWsaProvider({ now: () => NOW, captureDebugState });

    await p.acquire(ctx(), 'session').catch(() => {});

    const stallCall = calls.find((c) => c.reason === 'stall');
    expect(stallCall).toBeDefined();
  });

  it('no_session_cookies capture fires and error message embeds captureDir', async () => {
    // Loop exits (timeout), cookie-polling returns no session cookies → capture + throw
    _currentPage = makeFakePage({ urls: [AKAMAI_AUTH_URL] });
    // Return no akamai session cookies (empty list)
    _currentBrowserContext = makeFakeBrowserContext(_currentPage, { cookies: [] });

    const { fn: captureDebugState, calls, captureDir } = fakeCapture();
    const { AkamaiWsaProvider } = await import('../src/provider.js');
    const p = new AkamaiWsaProvider({ now: () => NOW, captureDebugState });

    const err = await p.acquire(ctx(), 'session').catch((e: unknown) => e);

    const noSessionCall = calls.find((c) => c.reason === 'no_session_cookies');
    expect(noSessionCall).toBeDefined();
    expect(noSessionCall?.service).toBe('akamai-wsa');
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('No Akamai session cookies captured');
    expect((err as Error).message).toContain(`[debug capture: ${captureDir}]`);
  });

  it('missing_xsrf_token capture fires and replaces silent return when AKASSO present but no XSRF', async () => {
    // Session cookies present (AKASSO) but no XSRF-TOKEN cookie and no intercepted header
    // → capture + throw instead of returning a broken bundle
    _currentPage = makeFakePage({ urls: [AKAMAI_AUTH_URL] });
    _currentBrowserContext = makeFakeBrowserContext(_currentPage, {
      cookies: [
        { name: 'AKASSO', value: 'session-value', domain: 'control.akamai.com' },
        // No XSRF-TOKEN cookie, no intercepted header
      ],
    });

    const { fn: captureDebugState, calls, captureDir } = fakeCapture();
    const { AkamaiWsaProvider } = await import('../src/provider.js');
    const p = new AkamaiWsaProvider({ now: () => NOW, captureDebugState });

    const err = await p.acquire(ctx(), 'session').catch((e: unknown) => e);

    const xsrfCall = calls.find((c) => c.reason === 'missing_xsrf_token');
    expect(xsrfCall).toBeDefined();
    expect(xsrfCall?.service).toBe('akamai-wsa');
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('no XSRF token captured');
    expect((err as Error).message).toContain(`[debug capture: ${captureDir}]`);
  });

  it('stepLog entries contain step / action / url / visibleFields fields', async () => {
    _currentPage = makeFakePage({ urls: [AKAMAI_AUTH_URL] });
    _currentBrowserContext = makeFakeBrowserContext(_currentPage);

    const { fn: captureDebugState, calls } = fakeCapture();
    const { AkamaiWsaProvider } = await import('../src/provider.js');
    const p = new AkamaiWsaProvider({ now: () => NOW, captureDebugState });

    await p.acquire(ctx(), 'session').catch(() => {});

    const anyCapture = calls[0];
    if (anyCapture) {
      const log = anyCapture.stepLog ?? [];
      expect(log.length).toBeGreaterThan(0);
      const firstEntry = log[0] as Record<string, unknown>;
      expect(firstEntry).toHaveProperty('step');
      expect(firstEntry).toHaveProperty('action');
      expect(firstEntry).toHaveProperty('url');
      expect(firstEntry).toHaveProperty('visibleFields');
    }
  });

  it('service key in all captures is akamai-wsa', async () => {
    _currentPage = makeFakePage({ urls: [AKAMAI_AUTH_URL] });
    _currentBrowserContext = makeFakeBrowserContext(_currentPage);

    const { fn: captureDebugState, calls } = fakeCapture();
    const { AkamaiWsaProvider } = await import('../src/provider.js');
    const p = new AkamaiWsaProvider({ now: () => NOW, captureDebugState });

    await p.acquire(ctx(), 'session').catch(() => {});

    for (const call of calls) {
      expect(call.service).toBe('akamai-wsa');
    }
  });

  it('MFA method selection page: trySelector called with mfaUseTotpOption selectors when PhoneAppNotification visible and TOTP input absent', async () => {
    // Arrange: SSO URL so the SSO block runs.
    //   - page.evaluate() → true (simulates document.querySelector finding PhoneAppNotification)
    //   - page.locator().isVisible() → false for all selectors (TOTP input absent, no other fields)
    //   - all other selectors → false → stall fires, deadline exits loop

    // URL starts at SSO, then repeats AKAMAI_AUTH_URL (stall triggers, deadline hit)
    const urlQueue = [SSO_URL, ...Array(10).fill(AKAMAI_AUTH_URL)];
    let urlIdx = 0;
    const locatorObj = {
      isVisible: vi.fn().mockResolvedValue(false),
      click: vi.fn().mockResolvedValue(undefined),
      fill: vi.fn().mockResolvedValue(undefined),
      type: vi.fn().mockResolvedValue(undefined),
      first: vi.fn(),
    };
    locatorObj.first.mockReturnValue(locatorObj);

    const page = {
      url: vi.fn(() => urlQueue[Math.min(urlIdx++, urlQueue.length - 1)]),
      locator: vi.fn().mockReturnValue(locatorObj),
      on: vi.fn(),
      goto: vi.fn().mockResolvedValue(null),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      // evaluate() called for MFA selection check: return true to simulate PhoneAppNotification present
      evaluate: vi.fn().mockResolvedValue(true),
      screenshot: vi.fn().mockResolvedValue(Buffer.from('')),
      content: vi.fn().mockResolvedValue('<html><title>Verify your identity</title></html>'),
    };

    _currentPage = page as any;
    _currentBrowserContext = makeFakeBrowserContext(_currentPage as any, { cookies: [] });

    // Make readTotpSeedFromKeychain return a fake SEED so totp (now a lazy
    // supplier) is truthy in the branch check. The supplier is never resolved
    // in this test because the TOTP input stays invisible.
    const authCore = await import('@hermes/auth-core');
    const readTotpSpy = vi.spyOn(authCore, 'readTotpSeedFromKeychain' as keyof typeof authCore).mockResolvedValue('JBSWY3DPEHPK3PXP' as any);

    const trySelectorMock = vi.mocked(authCore.trySelector);
    trySelectorMock.mockResolvedValue(false); // all interactions fail → stall captures

    const { fn: captureDebugState } = fakeCapture();
    const { AkamaiWsaProvider } = await import('../src/provider.js');
    const p = new AkamaiWsaProvider({ now: () => NOW, captureDebugState });

    // totpKeychainService + account causes _resolveCredentials to call readTotpFromKeychain
    await p.acquire(
      ctx({ authTimeoutMs: AUTH_TIMEOUT_MS, totpKeychainService: 'test-svc', totpKeychainAccount: 'test-acc' }),
      'session',
    ).catch(() => {});

    readTotpSpy.mockRestore();

    // Assert: trySelector was called at least once with the mfaUseTotpOption selector array.
    // SELECTORS.mfaUseTotpOption starts with '[data-value="PhoneAppOTP"]'.
    const callSelectors = trySelectorMock.mock.calls.map((args) => args[1]);
    const mfaTotpCallFound = callSelectors.some(
      (selectors) =>
        Array.isArray(selectors) &&
        selectors.some((s) => typeof s === 'string' && s.includes('PhoneAppOTP')),
    );
    expect(mfaTotpCallFound).toBe(true);
  });

  it('successful auth with AKASSO + XSRF-TOKEN does not trigger any capture', async () => {
    // Simulate: outer loop exits quickly (no matching URL patterns → deadline hit),
    // then cookie-polling returns session + XSRF → acquire succeeds with no capture.
    // Use a very short timeout so the loop exits after a couple iterations.
    _currentPage = makeFakePage({ urls: [AKAMAI_CC_URL] }); // CC url → breaks outer loop immediately
    _currentBrowserContext = makeFakeBrowserContext(_currentPage, {
      cookies: [
        { name: 'AKASSO', value: 'session-value', domain: 'control.akamai.com' },
        { name: 'XSRF-TOKEN', value: encodeURIComponent('xsrf-value'), domain: 'control.akamai.com' },
      ],
    });

    const { fn: captureDebugState, calls } = fakeCapture();
    const { AkamaiWsaProvider } = await import('../src/provider.js');
    const p = new AkamaiWsaProvider({ now: () => NOW, captureDebugState });

    await p.acquire(ctx(), 'session').catch(() => {});

    // Stall, no_session_cookies, and missing_xsrf_token captures must NOT fire
    const badCalls = calls.filter((c) =>
      c.reason === 'stall' || c.reason === 'no_session_cookies' || c.reason === 'missing_xsrf_token',
    );
    expect(badCalls.length).toBe(0);
  });
});
