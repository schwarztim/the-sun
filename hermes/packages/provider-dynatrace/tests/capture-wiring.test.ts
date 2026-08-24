/**
 * Tests for debug-state capture wiring in the DynatraceProvider SSO loop.
 *
 * These tests require module-level vi.mock for 'patchright' and '@hermes/auth-core'
 * since vitest hoists vi.mock calls. A fake browser/page stack drives runSsoLoop
 * without needing a real browser.
 *
 * runSsoLoop is exercised with the real implementation (not mocked) so stall
 * detection, shouldExit, and onConditionalAccess wiring are all exercised.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CaptureDebugStateOptions, CaptureDebugStateResult } from '@hermes/auth-core';
import type { ProviderContext } from '@hermes/broker';

const NOW = 1_700_000_000_000;
const ENV_ID = 'adk00977';
const APPS_URL = `https://${ENV_ID}.apps.dynatrace.com`;
const LOGIN_URL = 'https://login.microsoftonline.com/auth';
const SSO_URL = 'https://sso.dynatrace.com/auth';

const nullLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function ctx(config: Record<string, unknown> = {}): ProviderContext {
  return {
    service: 'dynatrace',
    config: { environmentId: ENV_ID, loginHint: 'u@e.com', ...config },
    dataDir: `${process.cwd()}/.test-data/dynatrace-capture-wiring`,
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
  const captureDir = `/fake/diag/dynatrace-${ENV_ID}/2026-01-01T00-00-00.000Z`;
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
  /** If set, cookies() returns these */
  cookies?: unknown[];
};

function makeFakePage(opts: FakePageOpts = {}) {
  const urlQueue: string[] = opts.urls ?? [opts.staticUrl ?? LOGIN_URL];
  let urlIdx = 0;

  const page = {
    url: vi.fn(() => urlQueue[Math.min(urlIdx++, urlQueue.length - 1)]),
    // locator().isVisible() — always false (no credential fields visible → no action → stall)
    locator: vi.fn().mockReturnValue({ isVisible: vi.fn().mockResolvedValue(false) }),
    $: vi.fn().mockResolvedValue(null),
    $$: vi.fn().mockResolvedValue([]),
    goto: vi.fn().mockResolvedValue(null),
    waitForNavigation: vi.fn().mockRejectedValue(new Error('timeout')),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    frames: vi.fn().mockReturnValue([]),
    evaluate: vi.fn().mockResolvedValue(''),
    on: vi.fn(),
    // For CaptureablePage interface
    screenshot: vi.fn().mockResolvedValue(Buffer.from('')),
    content: vi.fn().mockResolvedValue('<html></html>'),
  };
  return page;
}

function makeFakeContext(page: ReturnType<typeof makeFakePage>, cookieOverrides?: unknown[]) {
  return {
    newPage: vi.fn().mockResolvedValue(page),
    cookies: vi.fn().mockResolvedValue(cookieOverrides ?? []),
  };
}

// ---------------------------------------------------------------------------
// Module-level mocks — hoisted by vitest before any imports.
// We mock patchright; we keep runSsoLoop real (from auth-core) so stall
// detection is exercised end-to-end. classifyConditionalAccessPage returns
// null (no challenge) so the loop doesn't throw on conditional access.
// ---------------------------------------------------------------------------

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

// Keep runSsoLoop real; only mock classifyConditionalAccessPage so conditional
// access doesn't interfere, and readKeychainPassword/readTotpFromKeychain so
// the provider doesn't try keychain access in CI.
vi.mock('@hermes/auth-core', async (importOriginal) => {
  const original = await importOriginal<typeof import('@hermes/auth-core')>();
  return {
    ...original,
    classifyConditionalAccessPage: vi.fn().mockResolvedValue(null),
    readKeychainPassword: vi.fn().mockResolvedValue(null),
    readTotpFromKeychain: vi.fn().mockResolvedValue(null),
  };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DynatraceProvider — debug state capture wiring (SSO loop)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stall capture fires after 3 consecutive unchanged iterations', async () => {
    // Always stays on LOGIN_URL, no locators visible → nothing acts → stall
    _currentPage = makeFakePage({ staticUrl: LOGIN_URL });
    _currentBrowserContext = makeFakeContext(_currentPage);

    const { fn: captureDebugState, calls } = fakeCapture();
    const { DynatraceProvider } = await import('../src/provider.js');
    const p = new DynatraceProvider({ now: () => NOW, captureDebugState });

    await p.acquire(ctx(), 'session').catch(() => {});

    const stallCall = calls.find((c) => c.reason === 'stall');
    expect(stallCall).toBeDefined();
    expect(stallCall?.service).toBe(`dynatrace-${ENV_ID}`);
    expect(stallCall?.stepLog).toBeDefined();
    expect((stallCall?.stepLog ?? []).length).toBeGreaterThan(0);
  });

  it('stall capture fires at most once per acquire even when loop stays stuck', async () => {
    _currentPage = makeFakePage({ staticUrl: LOGIN_URL });
    _currentBrowserContext = makeFakeContext(_currentPage);

    const { fn: captureDebugState, calls } = fakeCapture();
    const { DynatraceProvider } = await import('../src/provider.js');
    const p = new DynatraceProvider({ now: () => NOW, captureDebugState });

    await p.acquire(ctx(), 'session').catch(() => {});

    const stallCalls = calls.filter((c) => c.reason === 'stall');
    expect(stallCalls.length).toBeLessThanOrEqual(1);
  });

  it('stall capture does NOT fire when URL changes every iteration', async () => {
    // runSsoLoop calls page.url() twice per iteration (shouldExit + fingerprint), so
    // we need at least 2 × maxSteps unique URLs to prevent the sequence from wrapping
    // and stabilizing. 60 URLs covers 25 iterations with margin.
    const progressingUrls = Array.from({ length: 60 }, (_, i) => `${LOGIN_URL}/step${i}`);
    _currentPage = makeFakePage({ urls: progressingUrls });
    _currentBrowserContext = makeFakeContext(_currentPage);

    const { fn: captureDebugState, calls } = fakeCapture();
    const { DynatraceProvider } = await import('../src/provider.js');
    const p = new DynatraceProvider({ now: () => NOW, captureDebugState });

    await p.acquire(ctx(), 'session').catch(() => {});

    const stallCalls = calls.filter((c) => c.reason === 'stall');
    expect(stallCalls.length).toBe(0);
  });

  it('terminal-failure capture fires with reason dynatrace_did_not_land', async () => {
    // Loop completes but URL never reaches apps.dynatrace.com → terminal capture
    _currentPage = makeFakePage({ staticUrl: LOGIN_URL });
    _currentBrowserContext = makeFakeContext(_currentPage);

    const { fn: captureDebugState, calls } = fakeCapture();
    const { DynatraceProvider } = await import('../src/provider.js');
    const p = new DynatraceProvider({ now: () => NOW, captureDebugState });

    const err = await p.acquire(ctx(), 'session').catch((e: unknown) => e);

    const landCapture = calls.find((c) => c.reason === 'dynatrace_did_not_land');
    expect(landCapture).toBeDefined();
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('[debug capture:');
    expect((err as Error).message).toContain('SSO did not land on Dynatrace apps');
  });

  it('error message contains the exact captureDir from the injected fake', async () => {
    _currentPage = makeFakePage({ staticUrl: LOGIN_URL });
    _currentBrowserContext = makeFakeContext(_currentPage);

    const customCaptureDir = '/my/custom/dynatrace/capture/dir';
    const captureDebugState = vi.fn(async (): Promise<CaptureDebugStateResult> => ({
      captureDir: customCaptureDir,
      files: {},
      errors: [],
    }));
    const { DynatraceProvider } = await import('../src/provider.js');
    const p = new DynatraceProvider({ now: () => NOW, captureDebugState });

    const err = await p.acquire(ctx(), 'session').catch((e: unknown) => e);

    expect((err as Error).message).toContain(`[debug capture: ${customCaptureDir}]`);
  });

  it('stepLog entries contain step / action / url / visibleFields fields', async () => {
    _currentPage = makeFakePage({ staticUrl: LOGIN_URL });
    _currentBrowserContext = makeFakeContext(_currentPage);

    const { fn: captureDebugState, calls } = fakeCapture();
    const { DynatraceProvider } = await import('../src/provider.js');
    const p = new DynatraceProvider({ now: () => NOW, captureDebugState });

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

  it('no-csrf-token: capture fires and throws when CSRF was never captured', async () => {
    // URL sequence: starts on SSO, transitions to apps.dynatrace.com so the loop exits,
    // then stays on apps for all post-loop URL checks.
    // The page.on('request') interceptor never fires in tests, so csrfToken stays null.
    const appsUrls = Array.from({ length: 40 }, () => `${APPS_URL}/ui/`);
    _currentPage = makeFakePage({ urls: [`${SSO_URL}/`, ...appsUrls] });
    // No cookies — avoids real cookie processing
    _currentBrowserContext = makeFakeContext(_currentPage, []);

    const { fn: captureDebugState, calls } = fakeCapture();
    const { DynatraceProvider } = await import('../src/provider.js');
    const p = new DynatraceProvider({ now: () => NOW, captureDebugState });

    const err = await p.acquire(ctx(), 'session').catch((e: unknown) => e);

    const csrfCapture = calls.find((c) => c.reason === 'dynatrace_no_csrf_token');
    expect(csrfCapture).toBeDefined();
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('[debug capture:');
    expect((err as Error).message).toContain('CSRF token was not captured');
  });

  it('ConditionalAccessChallengeError from onConditionalAccess includes captureDir in message', async () => {
    // Override classifyConditionalAccessPage to return a challenge so
    // _throwIfClassifiedChallenge fires and annotates the message.
    const { classifyConditionalAccessPage, ConditionalAccessChallengeError } =
      await import('@hermes/auth-core');
    vi.mocked(classifyConditionalAccessPage).mockResolvedValueOnce({
      state: 'mfa_or_totp_required',
      category: 'auth-required',
      message: 'MFA required',
      retryable: false,
      retryHint: 'human-action-required',
      remediation: 'Configure TOTP or satisfy MFA',
      remediationCommands: ['hermes acquire dynatrace'],
      evidence: {},
    });

    _currentPage = makeFakePage({ staticUrl: LOGIN_URL });
    _currentBrowserContext = makeFakeContext(_currentPage);

    const { fn: captureDebugState } = fakeCapture();
    const { DynatraceProvider } = await import('../src/provider.js');
    const p = new DynatraceProvider({ now: () => NOW, captureDebugState });

    const err = await p.acquire(ctx(), 'session').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConditionalAccessChallengeError);
    expect((err as Error).message).toContain('[debug capture:');
  });
});
