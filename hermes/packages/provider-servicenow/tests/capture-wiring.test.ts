/**
 * Tests for debug-state capture wiring in the ServiceNow provider's inner SSO loop.
 *
 * These tests require module-level vi.mock for both 'patchright' and '@hermes/auth-core'
 * since vitest hoists vi.mock calls. A fake browser/page stack drives the SSO loop
 * without needing a real browser.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CaptureDebugStateOptions, CaptureDebugStateResult } from '@hermes/auth-core';
import type { ProviderContext } from '@hermes/broker';

const NOW = 1_700_000_000_000;
const INSTANCE_URL = 'https://acmeprod.service-now.com';
const TARGET_HOST = 'acmeprod.service-now.com';
const LOGIN_URL = 'https://login.microsoftonline.com/auth';
const nullLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function ctx(config: Record<string, unknown> = {}): ProviderContext {
  return {
    service: 'servicenow',
    config: { instanceUrl: INSTANCE_URL, loginHint: 'u@e.com', ...config },
    dataDir: `${process.cwd()}/.test-data/capture-wiring`,
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
  const captureDir = '/fake/diag/servicenow-acmeprod/2026-01-01T00-00-00.000Z';
  const calls: CaptureDebugStateOptions[] = [];
  const fn = vi.fn(async (opts: CaptureDebugStateOptions): Promise<CaptureDebugStateResult> => {
    calls.push(opts);
    return { captureDir, files: {}, errors: [] };
  });
  return { fn, calls, captureDir };
}

// ---------------------------------------------------------------------------
// Fake Page / Browser factory
// Each test resets `currentPage` and `currentContext` before acquire().
// ---------------------------------------------------------------------------

type FakePageOpts = {
  /** Static URL returned by every page.url() call (always stays on one URL = stall). */
  staticUrl?: string;
  /** Sequence of URLs returned by page.url() in order; last entry repeats. */
  urls?: string[];
  /** If true page.$$ returns a non-empty array (simulates a visible login form). */
  hasLoginForm?: boolean;
  /**
   * Values returned by page.evaluate() in call order.
   * [0] = globalThis.g_ck extraction (string, default '')
   * [1] = session_info fetch result
   * [2..] = subsequent evaluates
   * Last value repeats.
   */
  evaluateReturns?: unknown[];
};

function makeFakePage(opts: FakePageOpts = {}) {
  const urlQueue: string[] = opts.urls ?? [opts.staticUrl ?? LOGIN_URL];
  let urlIdx = 0;
  let evalIdx = 0;

  const page = {
    url: vi.fn(() => urlQueue[Math.min(urlIdx++, urlQueue.length - 1)]),
    $$: vi.fn().mockResolvedValue(opts.hasLoginForm ? [{}] : []),
    // locator().isVisible() — always false (no credential fields visible → no action → stall)
    locator: vi.fn().mockReturnValue({ isVisible: vi.fn().mockResolvedValue(false) }),
    $: vi.fn().mockResolvedValue(null),
    goto: vi.fn().mockResolvedValue(null),
    waitForNavigation: vi.fn().mockRejectedValue(new Error('timeout')),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    frames: vi.fn().mockReturnValue([]),
    evaluate: vi.fn().mockImplementation(async () => {
      const returns = opts.evaluateReturns ?? [''];
      const val = returns[Math.min(evalIdx, returns.length - 1)];
      evalIdx++;
      return val;
    }),
    // For CaptureablePage interface
    screenshot: vi.fn().mockResolvedValue(Buffer.from('')),
    content: vi.fn().mockResolvedValue('<html></html>'),
  };
  return page;
}

function makeFakeContext(page: ReturnType<typeof makeFakePage>) {
  return {
    newPage: vi.fn().mockResolvedValue(page),
    cookies: vi.fn().mockResolvedValue([]),
  };
}

// ---------------------------------------------------------------------------
// Module-level mocks — hoisted by vitest before any imports.
// We mock patchright and the auth-core functions that would call real DOM APIs.
// ---------------------------------------------------------------------------

// Mutable references that tests swap out per-scenario
let _currentPage: ReturnType<typeof makeFakePage> = makeFakePage();
let _currentBrowserContext: ReturnType<typeof makeFakeContext> = makeFakeContext(_currentPage);

vi.mock('patchright', () => ({
  firefox: {
    launch: vi.fn().mockImplementation(async () => ({
      newContext: vi.fn().mockImplementation(async () => _currentBrowserContext),
      close: vi.fn().mockResolvedValue(undefined),
    })),
  },
}));

// Mock auth-core: keep trySelector/readKeychainPassword/readTotpFromKeychain/captureDebugState
// as passthrough, but make classifyConditionalAccessPage always return null (no challenge).
// ConditionalAccessChallengeError must still be a real class so instanceof checks work.
vi.mock('@hermes/auth-core', async (importOriginal) => {
  const original = await importOriginal<typeof import('@hermes/auth-core')>();
  return {
    ...original,
    // Return null → no challenge → loop continues without throwing
    classifyConditionalAccessPage: vi.fn().mockResolvedValue(null),
  };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ServiceNowProvider — debug state capture wiring (inner SSO loop)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stall capture fires after 3 consecutive unchanged iterations', async () => {
    // Always stays on LOGIN_URL, no forms, no fields → nothing acts → stall
    _currentPage = makeFakePage({ staticUrl: LOGIN_URL, hasLoginForm: false });
    _currentBrowserContext = makeFakeContext(_currentPage);

    const { fn: captureDebugState, calls } = fakeCapture();
    const { ServiceNowProvider } = await import('../src/provider.js');
    const p = new ServiceNowProvider({ now: () => NOW, captureDebugState });

    await p.acquire(ctx(), 'session').catch(() => {});

    const stallCall = calls.find((c) => c.reason === 'stall');
    expect(stallCall).toBeDefined();
    expect(stallCall?.service).toBe('servicenow-acmeprod');
    expect(stallCall?.stepLog).toBeDefined();
    expect((stallCall?.stepLog ?? []).length).toBeGreaterThan(0);
  });

  it('stall capture fires at most once per acquire even when loop stays stuck', async () => {
    _currentPage = makeFakePage({ staticUrl: LOGIN_URL, hasLoginForm: false });
    _currentBrowserContext = makeFakeContext(_currentPage);

    const { fn: captureDebugState, calls } = fakeCapture();
    const { ServiceNowProvider } = await import('../src/provider.js');
    const p = new ServiceNowProvider({ now: () => NOW, captureDebugState });

    await p.acquire(ctx(), 'session').catch(() => {});

    const stallCalls = calls.filter((c) => c.reason === 'stall');
    expect(stallCalls.length).toBeLessThanOrEqual(1);
  });

  it('stall capture does NOT fire when URL changes every iteration', async () => {
    // URL advances each step → fingerprint changes → unchangedFor never reaches 3.
    // runSsoLoop calls page.url() twice per iteration (once in shouldExit, once for
    // fingerprinting), so we need enough distinct URLs to cover 25 iterations × 2 calls.
    const progressingUrls = Array.from({ length: 60 }, (_, i) => `${LOGIN_URL}/step${i}`);
    _currentPage = makeFakePage({ urls: progressingUrls, hasLoginForm: false });
    _currentBrowserContext = makeFakeContext(_currentPage);

    const { fn: captureDebugState, calls } = fakeCapture();
    const { ServiceNowProvider } = await import('../src/provider.js');
    const p = new ServiceNowProvider({ now: () => NOW, captureDebugState });

    await p.acquire(ctx(), 'session').catch(() => {});

    const stallCalls = calls.filter((c) => c.reason === 'stall');
    expect(stallCalls.length).toBe(0);
  });

  it('terminal-failure capture fires with reason sso_did_not_land_on_servicenow', async () => {
    // Loop completes but URL never reaches ServiceNow → sso_did_not_land_on_servicenow
    _currentPage = makeFakePage({ staticUrl: LOGIN_URL, hasLoginForm: false });
    _currentBrowserContext = makeFakeContext(_currentPage);

    const { fn: captureDebugState, calls } = fakeCapture();
    const { ServiceNowProvider } = await import('../src/provider.js');
    const p = new ServiceNowProvider({ now: () => NOW, captureDebugState });

    const err = await p.acquire(ctx(), 'session').catch((e: unknown) => e);

    const landCapture = calls.find((c) => c.reason === 'sso_did_not_land_on_servicenow');
    expect(landCapture).toBeDefined();
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('[debug capture:');
  });

  it('terminal-failure capture fires when session_info fails after SSO lands on target', async () => {
    // First url() call: on target, no login form → loop breaks immediately (SSO complete)
    // Subsequent url() calls: on target (post-loop checks pass)
    // page.evaluate: [0] g_ck = '', [1] session_info returns 401 with no retry token
    //   → classifyServiceNowHttpFailure('session_info', {401}) = api_unauthorized
    //   → captureAndAnnotate('session_info_failed') fires before throw
    _currentPage = makeFakePage({
      urls: [
        `https://${TARGET_HOST}/`,    // loop iteration 0: onTarget + no loginForm → break
        `https://${TARGET_HOST}/`,    // post-loop check 1
        `https://${TARGET_HOST}/`,    // post-loop check 2
        `https://${TARGET_HOST}/`,    // additional safety
      ],
      hasLoginForm: false,
      evaluateReturns: [
        '',                                                             // [0] g_ck from page context
        { ok: false, status: 401, body: 'Unauthorized', userTokenResponse: '' }, // [1] session_info
        { ok: true, status: 200, body: '{}' },                         // [2] potential retry
      ],
    });
    _currentBrowserContext = makeFakeContext(_currentPage);

    const { fn: captureDebugState, calls } = fakeCapture();
    const { ServiceNowProvider } = await import('../src/provider.js');
    const p = new ServiceNowProvider({ now: () => NOW, captureDebugState });

    const err = await p.acquire(ctx(), 'session').catch((e: unknown) => e);

    const relevantCapture = calls.find(
      (c) => c.reason === 'session_info_failed' || c.reason === 'missing_g_ck',
    );
    expect(relevantCapture).toBeDefined();
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('[debug capture:');
  });

  it('error message contains the exact captureDir from the injected fake', async () => {
    _currentPage = makeFakePage({ staticUrl: LOGIN_URL, hasLoginForm: false });
    _currentBrowserContext = makeFakeContext(_currentPage);

    const customCaptureDir = '/my/custom/capture/dir';
    const captureDebugState = vi.fn(async (): Promise<CaptureDebugStateResult> => ({
      captureDir: customCaptureDir,
      files: {},
      errors: [],
    }));
    const { ServiceNowProvider } = await import('../src/provider.js');
    const p = new ServiceNowProvider({ now: () => NOW, captureDebugState });

    const err = await p.acquire(ctx(), 'session').catch((e: unknown) => e);

    expect((err as Error).message).toContain(`[debug capture: ${customCaptureDir}]`);
  });

  it('stepLog entries contain step / action / url fields', async () => {
    _currentPage = makeFakePage({ staticUrl: LOGIN_URL, hasLoginForm: false });
    _currentBrowserContext = makeFakeContext(_currentPage);

    const { fn: captureDebugState, calls } = fakeCapture();
    const { ServiceNowProvider } = await import('../src/provider.js');
    const p = new ServiceNowProvider({ now: () => NOW, captureDebugState });

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

  it('capture fires BEFORE page.goto in post-loop terminal path (stuck-state screenshot)', async () => {
    // The bug: capture ran AFTER page.goto, so screenshot showed the freshly-reloaded page.
    // Fix: capture the stuck state first, then attempt recovery goto.
    // This test asserts call ordering: captureDebugState index < page.goto index.
    _currentPage = makeFakePage({ staticUrl: LOGIN_URL, hasLoginForm: false });
    _currentBrowserContext = makeFakeContext(_currentPage);

    let order = 0;
    const captureCallOrder = { value: -1 };
    const gotoCallOrder = { value: -1 };

    // Override goto to record its call order
    _currentPage.goto = vi.fn().mockImplementation(async () => {
      gotoCallOrder.value = order++;
      return null;
    });

    // Wrap fakeCapture to record capture call order
    const { fn: baseFn, calls } = fakeCapture();
    const captureDebugState = vi.fn(async (opts: CaptureDebugStateOptions): Promise<CaptureDebugStateResult> => {
      if (opts.reason === 'sso_did_not_land_on_servicenow') {
        captureCallOrder.value = order++;
      }
      return baseFn(opts);
    });

    const { ServiceNowProvider } = await import('../src/provider.js');
    const p = new ServiceNowProvider({ now: () => NOW, captureDebugState });

    await p.acquire(ctx(), 'session').catch(() => {});

    // Capture for sso_did_not_land_on_servicenow must have fired
    const landCapture = calls.find((c) => c.reason === 'sso_did_not_land_on_servicenow');
    expect(landCapture).toBeDefined();

    // Capture must have happened BEFORE goto
    expect(captureCallOrder.value).toBeGreaterThanOrEqual(0);
    expect(gotoCallOrder.value).toBeGreaterThanOrEqual(0);
    expect(captureCallOrder.value).toBeLessThan(gotoCallOrder.value);
  });

  it('stall fires even when trySelector returns true every iteration (acted=true bug)', async () => {
    // Reproduces yesterday's failure: trySelector('fill') returns true every step because
    // isDomVisible (via page.evaluate) returns true for the email selector, but URL and
    // visibleFields never change. Before the fix (dropping !acted), unchangedFor never
    // incremented because acted was always true — stall never fired.
    // After the fix, fingerprint===lastFingerprint alone is sufficient to increment unchangedFor.

    // page.evaluate returns true for isDomVisible checks (making trySelector return true)
    // but URL stays constant → fingerprint stays constant → stall fires after 3 iterations.
    const actedPage = {
      ...makeFakePage({ staticUrl: LOGIN_URL, hasLoginForm: false }),
      // evaluate always returns true so isDomVisible→true→trySelector→true (acted=true every step)
      evaluate: vi.fn().mockResolvedValue(true),
      // locator needs first().fill() to succeed (called by trySelector after isDomVisible)
      locator: vi.fn().mockReturnValue({
        isVisible: vi.fn().mockResolvedValue(false), // visibleFields stays empty → fingerprint stable
        first: vi.fn().mockReturnValue({
          fill: vi.fn().mockResolvedValue(undefined),
          click: vi.fn().mockResolvedValue(undefined),
        }),
      }),
    };
    _currentPage = actedPage as unknown as ReturnType<typeof makeFakePage>;
    _currentBrowserContext = makeFakeContext(_currentPage);

    const { fn: captureDebugState, calls } = fakeCapture();
    const { ServiceNowProvider } = await import('../src/provider.js');
    const p = new ServiceNowProvider({ now: () => NOW, captureDebugState });

    await p.acquire(ctx(), 'session').catch(() => {});

    // stall MUST have fired — this is the test that would have caught yesterday's bug
    const stallCall = calls.find((c) => c.reason === 'stall');
    expect(stallCall).toBeDefined();

    // And stepLog entries must include filledEmail and filledPw fields (added in commit 6)
    const log = (stallCall?.stepLog ?? []) as Array<Record<string, unknown>>;
    expect(log.length).toBeGreaterThan(0);
    const firstEntry = log[0]!;
    expect(firstEntry).toHaveProperty('filledEmail');
    expect(firstEntry).toHaveProperty('filledPassword');
  });
});
