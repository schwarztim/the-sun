import { sanitizeUrl } from './url-sanitizer.js';
import { captureDebugState as defaultCaptureDebugState } from './capture-debug-state.js';
import type { CaptureDebugStateOptions, CaptureDebugStateResult } from './capture-debug-state.js';
import { resolveTotp, TotpRejectedError, type TotpInput } from './totp.js';

// ---------------------------------------------------------------------------
// Page abstraction — minimal subset of Playwright's Page interface
// ---------------------------------------------------------------------------

export interface SsoLocator {
  isVisible(opts?: { timeout?: number }): Promise<boolean>;
  fill(value: string, opts?: { timeout?: number }): Promise<void>;
  click(opts?: { timeout?: number }): Promise<void>;
}

export interface SsoPage {
  url(): string;
  waitForTimeout(ms: number): Promise<void>;
  locator(selector: string): SsoLocator;
  screenshot(opts: { path: string; fullPage?: boolean }): Promise<Buffer | void>;
  content(): Promise<string>;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type { CaptureDebugStateOptions, CaptureDebugStateResult };

export interface SsoLoopLogger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

export interface SsoLoopSelectors {
  email: readonly string[];
  password: readonly string[];
  totp: readonly string[];
  submit: readonly string[];
  consent: readonly string[];
  mfaVerify: readonly string[];
}

export interface SsoLoopOptions {
  /** Service key used in capture path, e.g., 'servicenow-prod' */
  service: string;
  /** Base dir for capture (typically ctx.dataDir) */
  baseDir: string;
  /** User identifier for filling email/loginfmt */
  loginHint: string;
  /** Optional password (provider may not have it for the loop) */
  password?: string;
  /**
   * Optional TOTP code or lazy supplier; if defined, TOTP step is checked
   * FIRST every iteration. Suppliers are resolved at fill time (only when a
   * TOTP field is actually visible) so codes are fresh and never replayed.
   */
  totp?: TotpInput;
  /** Selector arrays — providers pass their own; defaults available */
  selectors: SsoLoopSelectors;
  /** Max loop iterations, default 25 */
  maxSteps?: number;
  /** Absolute deadline in ms (Date.now() comparison); loop exits when exceeded */
  deadline?: number;
  /** Logger from provider's ctx */
  logger: SsoLoopLogger;
  /** Inject captureDebugState (matches Phase 1 pattern for test fakery) */
  captureDebugState?: (opts: CaptureDebugStateOptions) => Promise<CaptureDebugStateResult>;
  /** Per-iteration: tells the loop when to exit cleanly (landed on target). REQUIRED. */
  shouldExit: (page: SsoPage) => boolean | Promise<boolean>;
  /** Optional hook fired after each iteration; useful for provider telemetry */
  onAction?: (info: {
    step: number;
    action: SsoLoopAction;
    url: string;
    visibleFields: readonly string[];
  }) => void;
  /**
   * Optional hook called in the !acted branch — provider may throw
   * ConditionalAccessChallengeError here. Receives the live stepLog.
   * If this throws, runSsoLoop propagates the throw.
   */
  onConditionalAccess?: (
    page: SsoPage,
    stepLog: ReadonlyArray<Record<string, unknown>>,
  ) => Promise<void>;
}

export type SsoLoopAction =
  | 'totp'
  | 'email_password'
  | 'email'
  | 'password'
  | 'consent'
  | 'none';

export interface SsoLoopResult {
  /** Accumulated step log */
  stepLog: ReadonlyArray<Record<string, unknown>>;
  /** Step at which loop exited */
  exitedAtStep: number;
  /** Why the loop exited */
  exitReason: 'should_exit' | 'deadline' | 'max_steps';
  /** Stall capture metadata (if a stall capture was taken in this run) */
  stallCapture?: { captureDir: string; reason: 'stall' };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Detect which credential field CATEGORIES are currently visible on the page.
 * Returns an array of category names (e.g. ['email', 'password']) for any
 * category that has at least one visible selector match.
 */
async function detectVisibleFields(
  page: SsoPage,
  selectors: SsoLoopSelectors,
): Promise<string[]> {
  const checks: Array<{ name: string; sels: readonly string[] }> = [
    { name: 'email', sels: selectors.email },
    { name: 'password', sels: selectors.password },
    { name: 'totp', sels: selectors.totp },
  ];
  const visible: string[] = [];
  for (const { name, sels } of checks) {
    for (const sel of sels) {
      const found = await page.locator(sel).isVisible({ timeout: 100 }).catch(() => false);
      if (found) {
        visible.push(name);
        break;
      }
    }
  }
  return visible;
}

/**
 * Try to fill the first visible selector in the array.
 * Returns true if any selector was filled.
 */
async function trySelectorFill(
  page: SsoPage,
  selectors: readonly string[],
  value: string,
): Promise<boolean> {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel);
      const visible = await loc.isVisible({ timeout: 100 }).catch(() => false);
      if (!visible) continue;
      await loc.fill(value, { timeout: 5000 });
      return true;
    } catch {
      // try next selector
    }
  }
  return false;
}

/**
 * Try to click the first visible selector in the array.
 * Returns true if any selector was clicked.
 */
async function trySelectorClick(
  page: SsoPage,
  selectors: readonly string[],
): Promise<boolean> {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel);
      const visible = await loc.isVisible({ timeout: 100 }).catch(() => false);
      if (!visible) continue;
      await loc.click({ timeout: 5000 });
      return true;
    } catch {
      // try next selector
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Main exported function
// ---------------------------------------------------------------------------

export async function runSsoLoop(page: SsoPage, opts: SsoLoopOptions): Promise<SsoLoopResult> {
  const {
    service,
    baseDir,
    loginHint,
    password,
    totp,
    selectors,
    maxSteps = 25,
    deadline,
    logger,
    shouldExit,
    onAction,
    onConditionalAccess,
  } = opts;

  const capture = opts.captureDebugState ?? defaultCaptureDebugState;

  const stepLog: Array<Record<string, unknown>> = [];
  let lastFingerprint = '';
  let unchangedFor = 0;
  let stallCaptured = false;
  let stallCaptureResult: { captureDir: string; reason: 'stall' } | undefined;
  // Per-run TOTP submit counter: initial submit + one regenerated retry max.
  // A TOTP field still visible after two submits means the IdP rejected both —
  // continuing risks an Entra OATH lockout.
  let totpSubmits = 0;

  for (let step = 0; step < maxSteps; step++) {
    // Deadline check at top of iteration
    if (deadline !== undefined && Date.now() >= deadline) {
      return {
        stepLog,
        exitedAtStep: step,
        exitReason: 'deadline',
        stallCapture: stallCaptureResult,
      };
    }

    // Should-exit check
    const onTarget = await shouldExit(page);
    if (onTarget) {
      return {
        stepLog,
        exitedAtStep: step,
        exitReason: 'should_exit',
        stallCapture: stallCaptureResult,
      };
    }

    // Compute visible fields for fingerprint
    const visibleFields = await detectVisibleFields(page, selectors);
    const url = page.url();
    const fingerprint = `${url}|${visibleFields.slice().sort().join(',')}`;

    let acted = false;
    let action: SsoLoopAction = 'none';
    let filledEmail = false;
    let filledPassword = false;

    // TOTP step — highest priority: check before email/password. The code is
    // resolved at FILL TIME (lazy supplier) and only when a TOTP field is
    // actually visible, so it is fresh and never replays a used window.
    if (totp !== undefined && totp !== '' && visibleFields.includes('totp')) {
      if (totpSubmits >= 2) {
        throw new TotpRejectedError();
      }
      const code = await resolveTotp(totp);
      // The supplier may have waited for a window boundary — re-verify the
      // field is still there via trySelectorFill's own visibility check.
      const filledTotp = code ? await trySelectorFill(page, selectors.totp, code) : false;
      if (filledTotp) {
        totpSubmits += 1;
        logger.debug('filled TOTP', { attempt: totpSubmits });
        await trySelectorClick(page, selectors.mfaVerify);
        await page.waitForTimeout(2000);
        acted = true;
        action = 'totp';
      }
    }

    // Fill all visible credential fields before submitting — handles both
    // combined (email+password on one page) and split login flows.
    if (!acted) {
      filledEmail = await trySelectorFill(page, selectors.email, loginHint);
      filledPassword = password
        ? await trySelectorFill(page, selectors.password, password)
        : false;
      if (filledEmail) logger.debug('filled email');
      if (filledPassword) logger.debug('filled password');
      if (filledEmail || filledPassword) {
        await trySelectorClick(page, selectors.submit);
        await page.waitForTimeout(2000);
        acted = true;
        action = filledEmail && filledPassword
          ? 'email_password'
          : filledEmail
            ? 'email'
            : 'password';
      }
    }

    // Consent / Stay signed in
    if (!acted) {
      for (const sel of selectors.consent) {
        try {
          const loc = page.locator(sel);
          const visible = await loc.isVisible({ timeout: 100 }).catch(() => false);
          if (visible) {
            await loc.click({ timeout: 5000 });
            await page.waitForTimeout(3000);
            acted = true;
            action = 'consent';
            break;
          }
        } catch {
          // try next selector
        }
      }
    }

    // Record step telemetry
    stepLog.push({
      step,
      url: sanitizeUrl(url),
      onTarget,
      visibleFields,
      action,
      filledEmail,
      filledPassword,
    });

    // Stall detection: fingerprint = url + visible field types
    if (fingerprint === lastFingerprint) {
      unchangedFor += 1;
    } else {
      lastFingerprint = fingerprint;
      unchangedFor = 0;
    }

    // Stall capture (once per run) — after 3 unchanged iterations
    if (unchangedFor === 3 && !stallCaptured) {
      stallCaptured = true;
      const captureResult = await capture({
        page,
        reason: 'stall',
        service,
        baseDir,
        stepLog: [...stepLog],
      });
      stallCaptureResult = { captureDir: captureResult.captureDir, reason: 'stall' };
      logger.warn('sso loop stalled, captured debug state', {
        captureDir: captureResult.captureDir,
      });
    }

    // !acted branch: call conditional access hook, then wait
    if (!acted) {
      if (onConditionalAccess !== undefined) {
        // Propagates throw if provider throws (e.g., ConditionalAccessChallengeError)
        await onConditionalAccess(page, stepLog);
      }
      await page.waitForTimeout(5000);
    }

    // Fire telemetry hook after action resolution
    if (onAction !== undefined) {
      onAction({ step, action, url: sanitizeUrl(url), visibleFields });
    }
  }

  // Exhausted maxSteps
  return {
    stepLog,
    exitedAtStep: maxSteps,
    exitReason: 'max_steps',
    stallCapture: stallCaptureResult,
  };
}
