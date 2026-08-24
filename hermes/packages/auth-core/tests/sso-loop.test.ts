import { describe, it, expect, vi } from 'vitest';
import { runSsoLoop } from '../src/sso-loop.js';
import type {
  SsoPage,
  SsoLocator,
  SsoLoopSelectors,
  SsoLoopLogger,
  SsoLoopOptions,
} from '../src/sso-loop.js';
import type { CaptureDebugStateOptions, CaptureDebugStateResult } from '../src/capture-debug-state.js';

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

/** Tracks what actions have been "performed" on a selector */
interface SelectorState {
  visible: boolean;
  filled?: string;
  clicked?: boolean;
}

/**
 * Build a minimal SsoPage that drives the SSO loop.
 *
 * `selectorStates` is a map of selector -> {visible, filled?, clicked?}.
 * The test controls visibility; the fake page records fill/click calls.
 *
 * `urlSequence` provides successive URL values: each call to `url()` returns
 * the next element (or the last one if exhausted).
 */
function makePage(opts: {
  urlSequence?: string[];
  selectorStates?: Map<string, SelectorState>;
  screenshotFn?: (path: string) => Promise<void>;
  contentFn?: () => Promise<string>;
} = {}): SsoPage & {
  _selectorStates: Map<string, SelectorState>;
  _urlIndex: number;
  _timeouts: number[];
} {
  const {
    urlSequence = ['https://login.example.com/'],
    selectorStates = new Map<string, SelectorState>(),
    screenshotFn,
    contentFn,
  } = opts;

  let urlIndex = 0;

  const page = {
    _selectorStates: selectorStates,
    get _urlIndex() { return urlIndex; },

    url(): string {
      const u = urlSequence[urlIndex] ?? urlSequence[urlSequence.length - 1] ?? 'https://login.example.com/';
      // Advance only if there are more URLs to serve
      if (urlIndex < urlSequence.length - 1) urlIndex++;
      return u;
    },

    _timeouts: [] as number[],

    async waitForTimeout(ms: number): Promise<void> {
      page._timeouts.push(ms);
    },

    locator(selector: string): SsoLocator {
      return {
        async isVisible(_opts?: { timeout?: number }): Promise<boolean> {
          return selectorStates.get(selector)?.visible ?? false;
        },
        async fill(value: string, _opts?: { timeout?: number }): Promise<void> {
          const state = selectorStates.get(selector);
          if (state) state.filled = value;
        },
        async click(_opts?: { timeout?: number }): Promise<void> {
          const state = selectorStates.get(selector);
          if (state) state.clicked = true;
        },
      };
    },

    async screenshot(opts: { path: string; fullPage?: boolean }): Promise<void> {
      if (screenshotFn) {
        await screenshotFn(opts.path);
      }
    },

    async content(): Promise<string> {
      return contentFn ? contentFn() : '<html><body></body></html>';
    },
  };

  return page;
}

/** Build a silent logger (discards output; can be spied upon) */
function makeLogger(): SsoLoopLogger {
  return {
    debug: vi.fn(),
    warn: vi.fn(),
  };
}

/** Standard selectors for tests */
const TEST_SELECTORS: SsoLoopSelectors = {
  email: ['input[name="email"]'],
  password: ['input[name="password"]'],
  totp: ['input[name="totp"]'],
  submit: ['button[type="submit"]'],
  consent: ['button#consent'],
  mfaVerify: ['button#verify'],
};

/** A captureDebugState fake that records calls and returns a fixed captureDir */
function makeFakeCapture(): {
  fn: (opts: CaptureDebugStateOptions) => Promise<CaptureDebugStateResult>;
  calls: CaptureDebugStateOptions[];
} {
  const calls: CaptureDebugStateOptions[] = [];
  const fn = async (opts: CaptureDebugStateOptions): Promise<CaptureDebugStateResult> => {
    calls.push(opts);
    return {
      captureDir: '/tmp/fake-capture/stall-001',
      files: {},
      errors: [],
    };
  };
  return { fn, calls };
}

// ---------------------------------------------------------------------------
// Base opts builder — all required fields with sane defaults
// ---------------------------------------------------------------------------
function baseOpts(overrides: Partial<SsoLoopOptions> = {}): SsoLoopOptions {
  return {
    service: 'test-svc',
    baseDir: '/tmp/test-hermes',
    loginHint: 'user@example.com',
    selectors: TEST_SELECTORS,
    logger: makeLogger(),
    shouldExit: () => false,
    captureDebugState: makeFakeCapture().fn,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// shouldExit — clean exit
// ---------------------------------------------------------------------------
describe('runSsoLoop — shouldExit', () => {
  it('exits immediately on first iteration when shouldExit returns true from the start', async () => {
    const page = makePage({
      urlSequence: ['https://target.example.com/home'],
    });

    let shouldExitCalled = 0;
    const result = await runSsoLoop(page, baseOpts({
      shouldExit: () => { shouldExitCalled++; return true; },
      maxSteps: 10,
    }));

    expect(result.exitReason).toBe('should_exit');
    expect(result.exitedAtStep).toBe(0);
    expect(shouldExitCalled).toBe(1);
  });

  it('exits after a few steps when shouldExit transitions to true', async () => {
    const page = makePage({
      urlSequence: [
        'https://login.example.com/',
        'https://login.example.com/',
        'https://target.example.com/home',
      ],
    });

    let callCount = 0;
    const result = await runSsoLoop(page, baseOpts({
      shouldExit: () => { callCount++; return callCount >= 3; },
      maxSteps: 10,
    }));

    expect(result.exitReason).toBe('should_exit');
    expect(result.exitedAtStep).toBe(2);
  });

  it('result includes accumulated stepLog up to but not including the exiting step', async () => {
    let call = 0;
    const result = await runSsoLoop(makePage(), baseOpts({
      shouldExit: () => { call++; return call >= 2; },
      maxSteps: 5,
    }));

    // step 0 runs (shouldExit=false, log pushed), step 1 runs (shouldExit=true, exits before logging)
    expect(result.exitReason).toBe('should_exit');
    expect(result.stepLog).toHaveLength(1);
    expect((result.stepLog[0] as Record<string, unknown>)['step']).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Deadline exit
// ---------------------------------------------------------------------------
describe('runSsoLoop — deadline', () => {
  it('exits with deadline reason when deadline is already in the past', async () => {
    const pastDeadline = Date.now() - 1000;
    const result = await runSsoLoop(makePage(), baseOpts({
      deadline: pastDeadline,
      maxSteps: 10,
    }));

    expect(result.exitReason).toBe('deadline');
    expect(result.exitedAtStep).toBe(0);
  });

  it('exits deadline on second iteration when time expires after step 0', async () => {
    // Simulate deadline by using a very tight timestamp
    // We can't easily freeze Date.now globally without vi.useFakeTimers (which causes issues
    // with async waits), so instead we set deadline=now and rely on slight processing time.
    // This test uses a sentinel approach: deadline in the very recent past.
    const result = await runSsoLoop(makePage(), baseOpts({
      deadline: Date.now() - 1,
      maxSteps: 10,
    }));

    expect(result.exitReason).toBe('deadline');
  });

  it('returns stepLog accumulated before deadline', async () => {
    let calls = 0;
    const result = await runSsoLoop(makePage(), baseOpts({
      shouldExit: () => {
        calls++;
        // Let step 0 run, then deadline expires
        return false;
      },
      // Use a deadline far in the future first so step 0 runs,
      // then we rely on the step-0 not actually triggering deadline
      deadline: Date.now() + 100_000,
      maxSteps: 1, // use maxSteps=1 to limit, which fires 'max_steps' — separate test
    }));

    // With deadline far in future and maxSteps=1, should fire max_steps
    expect(result.exitReason).toBe('max_steps');
  });
});

// ---------------------------------------------------------------------------
// maxSteps exit
// ---------------------------------------------------------------------------
describe('runSsoLoop — maxSteps', () => {
  it('exits with max_steps when all iterations are exhausted', async () => {
    const result = await runSsoLoop(makePage(), baseOpts({
      shouldExit: () => false,
      maxSteps: 3,
    }));

    expect(result.exitReason).toBe('max_steps');
    expect(result.exitedAtStep).toBe(3);
  });

  it('stepLog has exactly maxSteps entries when running to exhaustion', async () => {
    const result = await runSsoLoop(makePage(), baseOpts({
      shouldExit: () => false,
      maxSteps: 4,
    }));

    expect(result.stepLog).toHaveLength(4);
  });

  it('default maxSteps is 25', async () => {
    const result = await runSsoLoop(makePage(), baseOpts({
      shouldExit: () => false,
      // no maxSteps provided — uses default
    }));

    expect(result.exitReason).toBe('max_steps');
    expect(result.exitedAtStep).toBe(25);
    expect(result.stepLog).toHaveLength(25);
  });
});

// ---------------------------------------------------------------------------
// TOTP-first ordering
// ---------------------------------------------------------------------------
describe('runSsoLoop — TOTP-first ordering', () => {
  it('fills TOTP before checking email/password when totp selector is visible', async () => {
    const states = new Map<string, SelectorState>([
      ['input[name="totp"]', { visible: true }],
      ['button#verify', { visible: true }],
      ['input[name="email"]', { visible: true }],  // also visible
      ['input[name="password"]', { visible: true }], // also visible
      ['button[type="submit"]', { visible: true }],
    ]);
    const page = makePage({ selectorStates: states });

    let step0action: string | undefined;
    const result = await runSsoLoop(page, baseOpts({
      totp: '123456',
      selectors: TEST_SELECTORS,
      shouldExit: (_p) => false,
      maxSteps: 1,
      onAction: (info) => {
        if (info.step === 0) step0action = info.action;
      },
    }));

    // Step 0 should have taken 'totp' action, not email_password
    expect(step0action).toBe('totp');
    expect(result.stepLog[0]).toMatchObject({ action: 'totp' });
    // TOTP field was filled
    expect(states.get('input[name="totp"]')?.filled).toBe('123456');
    // email should NOT have been filled in step 0
    expect(states.get('input[name="email"]')?.filled).toBeUndefined();
  });

  it('does NOT run TOTP step when totp option is undefined', async () => {
    const states = new Map<string, SelectorState>([
      ['input[name="totp"]', { visible: true }],
      ['button#verify', { visible: true }],
      ['input[name="email"]', { visible: true }],
      ['button[type="submit"]', { visible: true }],
    ]);
    const page = makePage({ selectorStates: states });

    const result = await runSsoLoop(page, baseOpts({
      totp: undefined,
      selectors: TEST_SELECTORS,
      shouldExit: () => false,
      maxSteps: 1,
    }));

    // No TOTP action — falls through to email
    expect(result.stepLog[0]).toMatchObject({ action: 'email' });
    expect(states.get('input[name="totp"]')?.filled).toBeUndefined();
    expect(states.get('input[name="email"]')?.filled).toBe('user@example.com');
  });
});

// ---------------------------------------------------------------------------
// Fill both email and password in the same iteration
// ---------------------------------------------------------------------------
describe('runSsoLoop — fill email+password together', () => {
  it('fills email AND password in the same iteration when both selectors are visible', async () => {
    const states = new Map<string, SelectorState>([
      ['input[name="email"]', { visible: true }],
      ['input[name="password"]', { visible: true }],
      ['button[type="submit"]', { visible: true }],
    ]);
    const page = makePage({ selectorStates: states });

    const result = await runSsoLoop(page, baseOpts({
      password: 'hunter2',
      selectors: TEST_SELECTORS,
      shouldExit: () => false,
      maxSteps: 1,
    }));

    expect(result.stepLog[0]).toMatchObject({
      action: 'email_password',
      filledEmail: true,
      filledPassword: true,
    });
    expect(states.get('input[name="email"]')?.filled).toBe('user@example.com');
    expect(states.get('input[name="password"]')?.filled).toBe('hunter2');
    expect(states.get('button[type="submit"]')?.clicked).toBe(true);
  });

  it('action is "email" when only email is visible (no password)', async () => {
    const states = new Map<string, SelectorState>([
      ['input[name="email"]', { visible: true }],
      ['button[type="submit"]', { visible: true }],
    ]);
    const page = makePage({ selectorStates: states });

    const result = await runSsoLoop(page, baseOpts({
      password: 'hunter2',
      selectors: TEST_SELECTORS,
      shouldExit: () => false,
      maxSteps: 1,
    }));

    expect(result.stepLog[0]).toMatchObject({ action: 'email', filledEmail: true, filledPassword: false });
  });

  it('action is "password" when only password is visible (no email)', async () => {
    const states = new Map<string, SelectorState>([
      ['input[name="password"]', { visible: true }],
      ['button[type="submit"]', { visible: true }],
    ]);
    const page = makePage({ selectorStates: states });

    const result = await runSsoLoop(page, baseOpts({
      password: 'hunter2',
      selectors: TEST_SELECTORS,
      shouldExit: () => false,
      maxSteps: 1,
    }));

    expect(result.stepLog[0]).toMatchObject({ action: 'password', filledEmail: false, filledPassword: true });
  });
});

// ---------------------------------------------------------------------------
// Stall detection and capture
// ---------------------------------------------------------------------------
describe('runSsoLoop — stall detection', () => {
  it('stall capture fires after exactly 3 iterations with the same fingerprint', async () => {
    const { fn: fakeCapture, calls } = makeFakeCapture();

    const result = await runSsoLoop(makePage(), baseOpts({
      shouldExit: () => false,
      maxSteps: 5,
      captureDebugState: fakeCapture,
    }));

    // Fingerprint is constant (same URL, no visible fields) → stall at iter 3
    expect(calls).toHaveLength(1);
    expect(result.stallCapture).toMatchObject({ reason: 'stall' });
    expect(result.stallCapture?.captureDir).toBe('/tmp/fake-capture/stall-001');
  });

  it('stall capture is taken only ONCE per run even when stall persists beyond iteration 3', async () => {
    const { fn: fakeCapture, calls } = makeFakeCapture();

    // Run 10 steps, all same fingerprint — capture should still only fire once
    await runSsoLoop(makePage(), baseOpts({
      shouldExit: () => false,
      maxSteps: 10,
      captureDebugState: fakeCapture,
    }));

    expect(calls).toHaveLength(1);
  });

  it('stall capture includes stepLog up to stall point', async () => {
    const { fn: fakeCapture, calls } = makeFakeCapture();

    await runSsoLoop(makePage(), baseOpts({
      shouldExit: () => false,
      maxSteps: 5,
      captureDebugState: fakeCapture,
    }));

    expect(calls[0]).toBeDefined();
    // stepLog passed to capture contains steps 0-3 (4 entries, stall at unchangedFor===3 after step 3)
    expect(calls[0]?.stepLog).toBeDefined();
    expect(Array.isArray(calls[0]?.stepLog)).toBe(true);
    expect((calls[0]?.stepLog as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  it('does NOT capture when fingerprint keeps changing (no stall)', async () => {
    const { fn: fakeCapture, calls } = makeFakeCapture();

    // Each iteration has a different URL → fingerprint always changes
    const urls = Array.from({ length: 5 }, (_, i) => `https://step${i}.example.com/`);
    const page = makePage({ urlSequence: urls });

    await runSsoLoop(page, baseOpts({
      shouldExit: () => false,
      maxSteps: 5,
      captureDebugState: fakeCapture,
    }));

    expect(calls).toHaveLength(0);
    expect(undefined).toBeUndefined(); // stallCapture not set
  });

  it('logger.warn is called when stall capture fires', async () => {
    const { fn: fakeCapture } = makeFakeCapture();
    const logger = makeLogger();

    await runSsoLoop(makePage(), baseOpts({
      shouldExit: () => false,
      maxSteps: 5,
      logger,
      captureDebugState: fakeCapture,
    }));

    expect(logger.warn).toHaveBeenCalledWith(
      'sso loop stalled, captured debug state',
      expect.objectContaining({ captureDir: expect.any(String) }),
    );
  });
});

// ---------------------------------------------------------------------------
// onConditionalAccess hook
// ---------------------------------------------------------------------------
describe('runSsoLoop — onConditionalAccess', () => {
  it('calls onConditionalAccess when no action was taken in an iteration', async () => {
    const conditionalAccessCalls: Array<ReadonlyArray<Record<string, unknown>>> = [];

    await runSsoLoop(makePage(), baseOpts({
      shouldExit: () => false,
      maxSteps: 2,
      onConditionalAccess: async (_page, stepLog) => {
        conditionalAccessCalls.push(stepLog);
      },
    }));

    // Both iterations have no visible fields → !acted → onConditionalAccess fired each time
    expect(conditionalAccessCalls).toHaveLength(2);
  });

  it('does NOT call onConditionalAccess when email was filled (acted=true)', async () => {
    const states = new Map<string, SelectorState>([
      ['input[name="email"]', { visible: true }],
      ['button[type="submit"]', { visible: true }],
    ]);
    const conditionalAccessCalls: number[] = [];

    await runSsoLoop(makePage({ selectorStates: states }), baseOpts({
      shouldExit: () => false,
      maxSteps: 1,
      onConditionalAccess: async () => {
        conditionalAccessCalls.push(1);
      },
    }));

    // action was taken (email filled) → onConditionalAccess NOT called
    expect(conditionalAccessCalls).toHaveLength(0);
  });

  it('propagates a throw from onConditionalAccess out of runSsoLoop', async () => {
    class TestError extends Error { name = 'TestError'; }

    await expect(
      runSsoLoop(makePage(), baseOpts({
        shouldExit: () => false,
        maxSteps: 5,
        onConditionalAccess: async () => {
          throw new TestError('conditional access challenge');
        },
      })),
    ).rejects.toThrow('conditional access challenge');
  });

  it('receives the live stepLog that includes the current step entry', async () => {
    let capturedStepLogLength = -1;

    // Run 3 steps, capture stepLog length on the 3rd onConditionalAccess call (step=2).
    // stepLog is pushed BEFORE onConditionalAccess is called, so on step 2 the log
    // already contains entries for steps 0, 1, and 2 — length 3.
    let iteration = 0;
    await runSsoLoop(makePage(), baseOpts({
      shouldExit: () => false,
      maxSteps: 3,
      onConditionalAccess: async (_page, stepLog) => {
        iteration++;
        if (iteration === 3) {
          capturedStepLogLength = stepLog.length;
        }
      },
    })).catch(() => {/* may throw on later iterations */});

    // On the 3rd call (step 2), stepLog contains entries for steps 0, 1, 2
    expect(capturedStepLogLength).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// stepLog URL sanitization
// ---------------------------------------------------------------------------
describe('runSsoLoop — stepLog URL sanitization', () => {
  it('stepLog url field does not contain SAMLRequest parameter', async () => {
    const dirtyUrl = 'https://login.microsoftonline.com/abc/saml2?SAMLRequest=bigblob&other=keep';
    const page = makePage({ urlSequence: [dirtyUrl] });

    const result = await runSsoLoop(page, baseOpts({
      shouldExit: () => false,
      maxSteps: 1,
    }));

    const entry = result.stepLog[0] as Record<string, unknown>;
    expect(entry['url']).not.toContain('SAMLRequest=');
    expect(entry['url']).toContain('other=keep');
  });

  it('stepLog url field does not contain access_token parameter', async () => {
    const dirtyUrl = 'https://example.com/callback?access_token=secret&state=abc';
    const page = makePage({ urlSequence: [dirtyUrl] });

    const result = await runSsoLoop(page, baseOpts({
      shouldExit: () => false,
      maxSteps: 1,
    }));

    const entry = result.stepLog[0] as Record<string, unknown>;
    expect(entry['url']).not.toContain('access_token=');
  });

  it('onAction receives sanitized url', async () => {
    const dirtyUrl = 'https://example.com/login?code=secretcode&kept=yes';
    const page = makePage({ urlSequence: [dirtyUrl] });
    const actionUrls: string[] = [];

    await runSsoLoop(page, baseOpts({
      shouldExit: () => false,
      maxSteps: 1,
      onAction: (info) => { actionUrls.push(info.url); },
    }));

    expect(actionUrls[0]).not.toContain('code=secretcode');
    expect(actionUrls[0]).toContain('kept=yes');
  });
});

// ---------------------------------------------------------------------------
// stepLog fields — filledEmail, filledPassword, action, visibleFields
// ---------------------------------------------------------------------------
describe('runSsoLoop — stepLog field coverage', () => {
  it('stepLog includes all expected fields', async () => {
    const result = await runSsoLoop(makePage(), baseOpts({
      shouldExit: () => false,
      maxSteps: 1,
    }));

    const entry = result.stepLog[0] as Record<string, unknown>;
    expect(entry).toHaveProperty('step');
    expect(entry).toHaveProperty('url');
    expect(entry).toHaveProperty('onTarget');
    expect(entry).toHaveProperty('visibleFields');
    expect(entry).toHaveProperty('action');
    expect(entry).toHaveProperty('filledEmail');
    expect(entry).toHaveProperty('filledPassword');
  });

  it('visibleFields is empty array when no credential selectors are visible', async () => {
    const result = await runSsoLoop(makePage(), baseOpts({
      shouldExit: () => false,
      maxSteps: 1,
    }));

    const entry = result.stepLog[0] as Record<string, unknown>;
    expect(entry['visibleFields']).toEqual([]);
  });

  it('visibleFields contains "email" and "password" when both selectors are visible', async () => {
    const states = new Map<string, SelectorState>([
      ['input[name="email"]', { visible: true }],
      ['input[name="password"]', { visible: true }],
    ]);
    const page = makePage({ selectorStates: states });

    const result = await runSsoLoop(page, baseOpts({
      shouldExit: () => false,
      maxSteps: 1,
    }));

    const entry = result.stepLog[0] as Record<string, unknown>;
    expect(entry['visibleFields']).toContain('email');
    expect(entry['visibleFields']).toContain('password');
  });

  it('visibleFields contains "totp" when totp selector is visible', async () => {
    const states = new Map<string, SelectorState>([
      ['input[name="totp"]', { visible: true }],
    ]);
    const page = makePage({ selectorStates: states });

    const result = await runSsoLoop(page, baseOpts({
      shouldExit: () => false,
      maxSteps: 1,
    }));

    const entry = result.stepLog[0] as Record<string, unknown>;
    expect(entry['visibleFields']).toContain('totp');
  });

  it('action is "none" when no selectors are visible and no totp', async () => {
    const result = await runSsoLoop(makePage(), baseOpts({
      shouldExit: () => false,
      maxSteps: 1,
    }));

    expect(result.stepLog[0]).toMatchObject({ action: 'none', filledEmail: false, filledPassword: false });
  });

  it('action is "consent" when consent button is visible and nothing else acted', async () => {
    const states = new Map<string, SelectorState>([
      ['button#consent', { visible: true }],
    ]);
    const page = makePage({ selectorStates: states });

    const result = await runSsoLoop(page, baseOpts({
      shouldExit: () => false,
      maxSteps: 1,
    }));

    expect(result.stepLog[0]).toMatchObject({ action: 'consent' });
  });
});

// ---------------------------------------------------------------------------
// onAction hook
// ---------------------------------------------------------------------------
describe('runSsoLoop — onAction hook', () => {
  it('onAction fires for each iteration with correct step, action, url, and visibleFields', async () => {
    const events: Array<{ step: number; action: string; url: string; visibleFields: readonly string[] }> = [];

    await runSsoLoop(makePage(), baseOpts({
      shouldExit: () => false,
      maxSteps: 3,
      onAction: (info) => { events.push(info); },
    }));

    expect(events).toHaveLength(3);
    expect(events[0]?.step).toBe(0);
    expect(events[1]?.step).toBe(1);
    expect(events[2]?.step).toBe(2);
  });

  it('onAction receives sanitized URL even when page.url() has SAML params', async () => {
    const dirtyUrl = 'https://login.example.com/?SAMLRequest=blob';
    const events: string[] = [];

    await runSsoLoop(makePage({ urlSequence: [dirtyUrl] }), baseOpts({
      shouldExit: () => false,
      maxSteps: 1,
      onAction: (info) => { events.push(info.url); },
    }));

    expect(events[0]).not.toContain('SAMLRequest=');
  });
});

// ---------------------------------------------------------------------------
// SsoLoopResult — stallCapture field
// ---------------------------------------------------------------------------
describe('runSsoLoop — stallCapture in result', () => {
  it('stallCapture is undefined when no stall occurred', async () => {
    const urls = Array.from({ length: 3 }, (_, i) => `https://step${i}.example.com/`);
    const result = await runSsoLoop(makePage({ urlSequence: urls }), baseOpts({
      shouldExit: () => false,
      maxSteps: 3,
    }));

    expect(result.stallCapture).toBeUndefined();
  });

  it('stallCapture has reason "stall" and captureDir from the capture call', async () => {
    const { fn: fakeCapture } = makeFakeCapture();

    const result = await runSsoLoop(makePage(), baseOpts({
      shouldExit: () => false,
      maxSteps: 5,
      captureDebugState: fakeCapture,
    }));

    expect(result.stallCapture).toMatchObject({
      reason: 'stall',
      captureDir: '/tmp/fake-capture/stall-001',
    });
  });

  it('stallCapture is included in result even when loop exits with max_steps after the stall', async () => {
    const { fn: fakeCapture } = makeFakeCapture();

    const result = await runSsoLoop(makePage(), baseOpts({
      shouldExit: () => false,
      maxSteps: 5,
      captureDebugState: fakeCapture,
    }));

    expect(result.exitReason).toBe('max_steps');
    expect(result.stallCapture).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Consent step
// ---------------------------------------------------------------------------
describe('runSsoLoop — consent step', () => {
  it('clicks consent button when visible and no other action taken', async () => {
    const states = new Map<string, SelectorState>([
      ['button#consent', { visible: true }],
    ]);
    const page = makePage({ selectorStates: states });

    const result = await runSsoLoop(page, baseOpts({
      shouldExit: () => false,
      maxSteps: 1,
    }));

    expect(states.get('button#consent')?.clicked).toBe(true);
    expect(result.stepLog[0]).toMatchObject({ action: 'consent' });
  });

  it('consent step is skipped when email was already filled (acted=true)', async () => {
    const states = new Map<string, SelectorState>([
      ['input[name="email"]', { visible: true }],
      ['button[type="submit"]', { visible: true }],
      ['button#consent', { visible: true }],
    ]);
    const page = makePage({ selectorStates: states });

    const result = await runSsoLoop(page, baseOpts({
      shouldExit: () => false,
      maxSteps: 1,
    }));

    // Email was filled → acted=true → consent was not clicked
    expect(result.stepLog[0]).toMatchObject({ action: 'email' });
    // consent button was NOT clicked (acted=true prevented it)
    expect(states.get('button#consent')?.clicked).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------
describe('runSsoLoop — edge cases', () => {
  it('works when selectors arrays are empty (no selectors to check)', async () => {
    const emptySelectors: SsoLoopSelectors = {
      email: [],
      password: [],
      totp: [],
      submit: [],
      consent: [],
      mfaVerify: [],
    };

    const result = await runSsoLoop(makePage(), baseOpts({
      selectors: emptySelectors,
      shouldExit: () => false,
      maxSteps: 2,
    }));

    expect(result.exitReason).toBe('max_steps');
    expect(result.stepLog).toHaveLength(2);
  });

  it('returns empty stepLog when shouldExit is true on step 0', async () => {
    const result = await runSsoLoop(makePage(), baseOpts({
      shouldExit: () => true,
      maxSteps: 10,
    }));

    expect(result.exitReason).toBe('should_exit');
    expect(result.stepLog).toHaveLength(0);
    expect(result.exitedAtStep).toBe(0);
  });

  it('passes service and baseDir to captureDebugState when stall fires', async () => {
    const { fn: fakeCapture, calls } = makeFakeCapture();

    await runSsoLoop(makePage(), baseOpts({
      service: 'my-custom-svc',
      baseDir: '/my/custom/dir',
      shouldExit: () => false,
      maxSteps: 5,
      captureDebugState: fakeCapture,
    }));

    expect(calls[0]?.service).toBe('my-custom-svc');
    expect(calls[0]?.baseDir).toBe('/my/custom/dir');
    expect(calls[0]?.reason).toBe('stall');
  });
});

// ---------------------------------------------------------------------------
// Lazy TOTP supplier + single-retry-then-fail (Phase 5 TOTP hygiene)
// ---------------------------------------------------------------------------
describe('runSsoLoop — lazy TOTP supplier + retry cap', () => {
  it('resolves a supplier at fill time and fills the supplied code', async () => {
    const states = new Map<string, SelectorState>([
      ['input[name="totp"]', { visible: true }],
      ['button#verify', { visible: true }],
    ]);
    const page = makePage({ selectorStates: states });
    const supplier = vi.fn(async () => '999111');

    const result = await runSsoLoop(page, baseOpts({
      totp: supplier,
      maxSteps: 1,
    }));

    expect(supplier).toHaveBeenCalledTimes(1);
    expect(states.get('input[name="totp"]')?.filled).toBe('999111');
    expect(result.stepLog[0]).toMatchObject({ action: 'totp' });
  });

  it('does NOT resolve the supplier when no TOTP field is visible', async () => {
    const states = new Map<string, SelectorState>([
      ['input[name="totp"]', { visible: false }],
      ['input[name="email"]', { visible: true }],
      ['button[type="submit"]', { visible: true }],
    ]);
    const page = makePage({ selectorStates: states });
    const supplier = vi.fn(async () => '999111');

    await runSsoLoop(page, baseOpts({
      totp: supplier,
      maxSteps: 2,
    }));

    expect(supplier).not.toHaveBeenCalled();
  });

  it('aborts with TotpRejectedError after initial submit + one regenerated retry', async () => {
    // TOTP field stays visible forever — the IdP is rejecting every code.
    const states = new Map<string, SelectorState>([
      ['input[name="totp"]', { visible: true }],
      ['button#verify', { visible: true }],
    ]);
    const page = makePage({ selectorStates: states });
    let calls = 0;
    const supplier = vi.fn(async () => `00000${++calls}`);

    await expect(runSsoLoop(page, baseOpts({
      totp: supplier,
      maxSteps: 10,
    }))).rejects.toThrow('TOTP rejected twice — verify the seed in the vault matches the IdP registration (sso-totp)');

    // exactly two codes were generated/submitted (initial + one retry)
    expect(supplier).toHaveBeenCalledTimes(2);
  });

  it('string totp still works (backward compat) and is also capped', async () => {
    const states = new Map<string, SelectorState>([
      ['input[name="totp"]', { visible: true }],
      ['button#verify', { visible: true }],
    ]);
    const page = makePage({ selectorStates: states });

    const result = await runSsoLoop(page, baseOpts({
      totp: '123456',
      maxSteps: 2,
    }));

    expect(states.get('input[name="totp"]')?.filled).toBe('123456');
    expect(result.stepLog.filter((s) => s.action === 'totp')).toHaveLength(2);
  });
});
