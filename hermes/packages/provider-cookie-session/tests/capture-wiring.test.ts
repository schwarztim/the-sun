/**
 * Tests for debug-state capture wiring in the CookieSessionProvider's inner SSO loop.
 *
 * These tests require module-level vi.mock for both 'patchright' and '@hermes/auth-core'
 * since vitest hoists vi.mock calls. A fake browser/page stack drives the SSO loop
 * without needing a real browser.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CaptureDebugStateOptions, CaptureDebugStateResult } from '@hermes/auth-core';
import type { ProviderContext } from '@hermes/broker';

const NOW = 1_700_000_000_000;
const BASE_URL = 'https://tufin.example.com';
const TARGET_HOST = 'tufin.example.com';
const LOGIN_URL = 'https://login.microsoftonline.com/auth';
const nullLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function ctx(config: Record<string, unknown> = {}): ProviderContext {
  return {
    service: 'tufin',
    config: { baseUrl: BASE_URL, loginHint: 'u@example.com', ...config },
    dataDir: `${process.cwd()}/.test-data/capture-wiring-cookie`,
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
  const captureDir = '/fake/diag/cookie-session-tufin/2026-01-01T00-00-00.000Z';
  const calls: CaptureDebugStateOptions[] = [];
  const fn = vi.fn(async (opts: CaptureDebugStateOptions): Promise<CaptureDebugStateResult> => {
    calls.push(opts);
    return { captureDir, files: {}, errors: [] };
  });
  return { fn, calls, captureDir };
}

// ---------------------------------------------------------------------------
// Fake Page / Browser factory
// ---------------------------------------------------------------------------

type FakePageOpts = {
  /** Static URL returned by every page.url() call (always stays on one URL = stall). */
  staticUrl?: string;
  /** Sequence of URLs returned by page.url() in order; last entry repeats. */
  urls?: string[];
  /** If true page.$$ returns a non-empty array (simulates a visible login form). */
  hasLoginForm?: boolean;
};

function makeFakePage(opts: FakePageOpts = {}) {
  const urlQueue: string[] = opts.urls ?? [opts.staticUrl ?? LOGIN_URL];
  let urlIdx = 0;

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
    evaluate: vi.fn().mockResolvedValue(null),
    // For CaptureablePage interface
    screenshot: vi.fn().mockResolvedValue(Buffer.from('')),
    content: vi.fn().mockResolvedValue('<html></html>'),
  };
  return page;
}

function makeFakeBrowserContext(page: ReturnType<typeof makeFakePage>) {
  return {
    newPage: vi.fn().mockResolvedValue(page),
    cookies: vi.fn().mockResolvedValue([]),
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
    // Return null → no challenge → loop continues without throwing
    classifyConditionalAccessPage: vi.fn().mockResolvedValue(null),
  };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CookieSessionProvider — debug state capture wiring (inner SSO loop)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stall capture fires after 3 consecutive unchanged-fingerprint iterations', async () => {
    // Always stays on LOGIN_URL, no forms, no fields → nothing acts → stall
    _currentPage = makeFakePage({ staticUrl: LOGIN_URL, hasLoginForm: false });
    _currentBrowserContext = makeFakeBrowserContext(_currentPage);

    const { fn: captureDebugState, calls } = fakeCapture();
    const { CookieSessionProvider } = await import('../src/provider.js');
    const p = new CookieSessionProvider({ now: () => NOW, captureDebugState });

    await p.acquire(ctx(), 'session').catch(() => {});

    const stallCall = calls.find((c) => c.reason === 'stall');
    expect(stallCall).toBeDefined();
    expect(stallCall?.service).toContain('cookie-session-tufin');
    expect(stallCall?.stepLog).toBeDefined();
    expect((stallCall?.stepLog ?? []).length).toBeGreaterThan(0);
  });

  it('stall capture fires at most once per acquire even when loop stays stuck', async () => {
    _currentPage = makeFakePage({ staticUrl: LOGIN_URL, hasLoginForm: false });
    _currentBrowserContext = makeFakeBrowserContext(_currentPage);

    const { fn: captureDebugState, calls } = fakeCapture();
    const { CookieSessionProvider } = await import('../src/provider.js');
    const p = new CookieSessionProvider({ now: () => NOW, captureDebugState });

    await p.acquire(ctx(), 'session').catch(() => {});

    const stallCalls = calls.filter((c) => c.reason === 'stall');
    expect(stallCalls.length).toBeLessThanOrEqual(1);
  });

  it('stall capture does NOT fire when URL changes every iteration', async () => {
    // URL advances each step → fingerprint changes → unchangedFor never reaches 3
    const progressingUrls = Array.from({ length: 35 }, (_, i) => `${LOGIN_URL}/step${i}`);
    _currentPage = makeFakePage({ urls: progressingUrls, hasLoginForm: false });
    _currentBrowserContext = makeFakeBrowserContext(_currentPage);

    const { fn: captureDebugState, calls } = fakeCapture();
    const { CookieSessionProvider } = await import('../src/provider.js');
    const p = new CookieSessionProvider({ now: () => NOW, captureDebugState });

    await p.acquire(ctx(), 'session').catch(() => {});

    const stallCalls = calls.filter((c) => c.reason === 'stall');
    expect(stallCalls.length).toBe(0);
  });

  it('stall fires even when acted=true every iteration (no !acted guard)', async () => {
    // Reproduces the Phase 1 lesson: stall must NOT be gated on !acted.
    // URL stays constant → fingerprint stays constant → stall fires after 3 iterations,
    // regardless of whether the loop performed an action.
    const actedPage = {
      ...makeFakePage({ staticUrl: LOGIN_URL, hasLoginForm: false }),
      // evaluate returns true → isDomVisible=true → trySelector returns true → acted=true
      evaluate: vi.fn().mockResolvedValue(true),
      locator: vi.fn().mockReturnValue({
        isVisible: vi.fn().mockResolvedValue(false), // visibleFields stays empty → fingerprint stable
        first: vi.fn().mockReturnValue({
          fill: vi.fn().mockResolvedValue(undefined),
          click: vi.fn().mockResolvedValue(undefined),
        }),
      }),
    };
    _currentPage = actedPage as unknown as ReturnType<typeof makeFakePage>;
    _currentBrowserContext = makeFakeBrowserContext(_currentPage);

    const { fn: captureDebugState, calls } = fakeCapture();
    const { CookieSessionProvider } = await import('../src/provider.js');
    const p = new CookieSessionProvider({ now: () => NOW, captureDebugState });

    await p.acquire(ctx(), 'session').catch(() => {});

    const stallCall = calls.find((c) => c.reason === 'stall');
    expect(stallCall).toBeDefined();
  });

  it('terminal-failure capture fires with reason sso_did_not_land', async () => {
    _currentPage = makeFakePage({ staticUrl: LOGIN_URL, hasLoginForm: false });
    _currentBrowserContext = makeFakeBrowserContext(_currentPage);

    const { fn: captureDebugState, calls } = fakeCapture();
    const { CookieSessionProvider } = await import('../src/provider.js');
    const p = new CookieSessionProvider({ now: () => NOW, captureDebugState });

    const err = await p.acquire(ctx(), 'session').catch((e: unknown) => e);

    const landCapture = calls.find((c) => c.reason === 'sso_did_not_land');
    expect(landCapture).toBeDefined();
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('[debug capture:');
  });

  it('error message contains the exact captureDir from the injected fake', async () => {
    _currentPage = makeFakePage({ staticUrl: LOGIN_URL, hasLoginForm: false });
    _currentBrowserContext = makeFakeBrowserContext(_currentPage);

    const customCaptureDir = '/my/custom/capture/dir';
    const captureDebugState = vi.fn(async (): Promise<CaptureDebugStateResult> => ({
      captureDir: customCaptureDir,
      files: {},
      errors: [],
    }));
    const { CookieSessionProvider } = await import('../src/provider.js');
    const p = new CookieSessionProvider({ now: () => NOW, captureDebugState });

    const err = await p.acquire(ctx(), 'session').catch((e: unknown) => e);

    expect((err as Error).message).toContain(`[debug capture: ${customCaptureDir}]`);
  });

  it('ConditionalAccessChallenge throws include captureDir in message', async () => {
    _currentPage = makeFakePage({ staticUrl: LOGIN_URL, hasLoginForm: false });
    _currentBrowserContext = makeFakeBrowserContext(_currentPage);

    const { fn: captureDebugState, captureDir } = fakeCapture();

    // Override classifyConditionalAccessPage to return a challenge
    const { classifyConditionalAccessPage } = await import('@hermes/auth-core');
    vi.mocked(classifyConditionalAccessPage).mockResolvedValueOnce({
      state: 'mfa_or_totp_required',
      service: 'tufin',
      message: 'MFA required',
      acquireCommand: 'hermes acquire tufin',
      retryHint: 'configure TOTP',
    } as any);

    const { CookieSessionProvider } = await import('../src/provider.js');
    const p = new CookieSessionProvider({ now: () => NOW, captureDebugState });

    const err = await p.acquire(ctx(), 'session').catch((e: unknown) => e);

    // The challenge message should be annotated with the captureDir
    expect((err as Error).message).toContain(`[debug capture: ${captureDir}]`);
  });

  it('stepLog entries contain step / action / url / visibleFields fields', async () => {
    _currentPage = makeFakePage({ staticUrl: LOGIN_URL, hasLoginForm: false });
    _currentBrowserContext = makeFakeBrowserContext(_currentPage);

    const { fn: captureDebugState, calls } = fakeCapture();
    const { CookieSessionProvider } = await import('../src/provider.js');
    const p = new CookieSessionProvider({ now: () => NOW, captureDebugState });

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

  it('service key in capture uses ctx.service (consuming service name)', async () => {
    // ctx.service = 'tufin' → serviceKey should be 'cookie-session-tufin'
    _currentPage = makeFakePage({ staticUrl: LOGIN_URL, hasLoginForm: false });
    _currentBrowserContext = makeFakeBrowserContext(_currentPage);

    const { fn: captureDebugState, calls } = fakeCapture();
    const { CookieSessionProvider } = await import('../src/provider.js');
    const p = new CookieSessionProvider({ now: () => NOW, captureDebugState });

    await p.acquire(ctx(), 'session').catch(() => {});

    const anyCapture = calls[0];
    expect(anyCapture?.service).toBe('cookie-session-tufin');
  });

  it('SSO landing on target host succeeds without triggering capture', async () => {
    // Immediately on target, no login form → loop breaks, no capture fires
    _currentPage = makeFakePage({
      urls: [`https://${TARGET_HOST}/`],
      hasLoginForm: false,
    });
    _currentBrowserContext = makeFakeBrowserContext(_currentPage);
    // cookies() must return something for the cookie collection step
    _currentBrowserContext.cookies = vi.fn().mockResolvedValue([]);

    const { fn: captureDebugState, calls } = fakeCapture();
    const { CookieSessionProvider } = await import('../src/provider.js');
    const p = new CookieSessionProvider({ now: () => NOW, captureDebugState });

    await p.acquire(ctx(), 'session').catch(() => {});

    // No captures should have fired
    expect(calls.length).toBe(0);
  });
});
