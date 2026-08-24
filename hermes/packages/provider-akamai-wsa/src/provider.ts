import type { Provider, ProviderCapabilities, ProviderContext, TokenBundle } from '@hermes/broker';
import { trySelector, readKeychainPassword, readTotpSeedFromKeychain, makeTotpSupplier, resolveTotp, TotpRejectedError, captureDebugState as defaultCaptureDebugState, sanitizeUrl, withManagedBrowser, loadSessionState, saveSessionState, invalidateSessionState, type TotpInput, type CaptureDebugStateOptions, type CaptureDebugStateResult } from '@hermes/auth-core';
import { AkamaiWsaConfigSchema, SCHEMES } from './config.js';
import path from 'node:path';
import { promises as fs } from 'node:fs';

const SELECTORS = {
  emailInput: ['input[type="email"]', 'input[name="loginfmt"]', '#i0116',
    'input[placeholder="account email address"]', 'input[placeholder*="email address" i]'],
  passwordInput: ['#passwordInput', 'input[name="passwd"]:not(.moveOffScreen)',
    'input[type="password"]:visible', '#i0118'],
  submitButton: ['input[type="submit"]', '#idSIButton9', 'button[type="submit"]'],
  mfaCodeInput: ['input[name="otc"]', '#idTxtBx_SAOTCC_OTC'],
  mfaVerifyButton: ['#idSubmit_SAOTCC_Continue', 'input[type="submit"][value="Verify"]'],
  staySignedIn: ['#idBtn_Back', '#idSIButton9'],
  akamaiNextButton: ['button[name="next-btn"]:not([disabled])', 'button:has-text("Next"):not([disabled])', 'input[type="submit"]', 'button[type="submit"]'],
  // MFA method selection page: the row tile that switches to TOTP entry.
  // The Authenticator push page (data-value="PhoneAppNotification") is the default
  // selection but cannot be automated headlessly. Clicking "Use a verification code"
  // switches to the TOTP input screen, which CAN be automated.
  mfaUseTotpOption: [
    '[data-value="PhoneAppOTP"]',
    '[data-value="OneWaySMS"]',
    'div[data-bind*="text: display"]:has-text("Use a verification code")',
    'div:has-text("Use a verification code"):not(:has(*))',
  ],
};

const AKAMAI_WSA_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:150.0) Gecko/20100101 Firefox/150.0';

/** Akamai session: ~8 hours (credentials file says 4h conservatively). Refresh at 7h. */
const SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000;
const REFRESH_MARGIN_MS = 60 * 60 * 1000;

export interface AkamaiWsaProviderDeps {
  now: () => number;
  httpFetch?: (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number }>;
  captureDebugState?: (opts: CaptureDebugStateOptions) => Promise<CaptureDebugStateResult>;
}

const AKAMAI_WSA_CAPABILITIES: ProviderCapabilities = {
  headless: true,
  schemes: [{
    scheme: 'session',
    credentialSource: 'cookie-session',
    refreshStrategy: 'reacquire',
    supportsRefresh: true,
    supportsValidation: true,
    validationStrategy: 'service-probe',
  }],
  remediation: {
    acquire: 'Run hermes acquire akamai-wsa after confirming loginHint and host keychain credentials; do not relax headless mode.',
    refresh: 'Akamai WSA sessions cannot silently refresh; Hermes performs a headless full re-acquire.',
    validate: 'Heartbeat auth failures require re-acquire; persistent network failures should be checked before credential rotation.',
  },
};

export class AkamaiWsaProvider implements Provider {
  readonly name = 'akamai-wsa';
  readonly schemes = SCHEMES;
  readonly capabilities = AKAMAI_WSA_CAPABILITIES;

  constructor(private readonly deps: AkamaiWsaProviderDeps) {}

  private async _captureAndAnnotate(
    page: Parameters<typeof defaultCaptureDebugState>[0]['page'],
    reason: string,
    stepLog: ReadonlyArray<Record<string, unknown>>,
    ctx: ProviderContext,
  ): Promise<string> {
    const serviceKey = 'akamai-wsa';
    const doCapture = this.deps.captureDebugState ?? defaultCaptureDebugState;
    const result = await doCapture({ page, reason, service: serviceKey, baseDir: ctx.dataDir, stepLog });
    ctx.logger.warn('akamai-wsa debug state captured', { captureDir: result.captureDir, reason, service: serviceKey });
    if (result.errors.length > 0) {
      ctx.logger.warn('akamai-wsa debug capture partial failure', { captureErrors: result.errors });
    }
    return result.captureDir;
  }

  private async _resolveCredentials(ctx: ProviderContext) {
    const config = AkamaiWsaConfigSchema.parse(ctx.config);
    let password: string | undefined;
    if (config.passwordKeychainService && config.passwordKeychainAccount) {
      password = (await readKeychainPassword(config.passwordKeychainService, config.passwordKeychainAccount)) ?? undefined;
    }
    // Lazy TOTP: resolve the SEED here, generate codes at fill time via a
    // supplier so they are fresh when the MFA input appears.
    let totp: TotpInput | undefined;
    if (config.totpKeychainService && config.totpKeychainAccount) {
      const seed = await readTotpSeedFromKeychain(config.totpKeychainService, config.totpKeychainAccount);
      totp = seed ? makeTotpSupplier(ctx.service, seed) : undefined;
    }
    return { config, password, totp };
  }

  async acquire(ctx: ProviderContext, _scheme: string): Promise<TokenBundle> {
    const { config, password, totp } = await this._resolveCredentials(ctx);
    const profileDir = path.join(ctx.dataDir, 'akamai-wsa', 'profile');
    await fs.mkdir(profileDir, { recursive: true });

    let capturedXsrfToken: string | null = null;

    return withManagedBrowser({
      service: ctx.service,
      engine: 'firefox',
      launchOptions: {
        headless: config.headless,
        timeout: 30_000,
        firefoxUserPrefs: {
          'security.default_personal_cert': 'Select Automatically',
          'security.certerrors.permanentOverride': true,
        },
      },
      profileDir,
      maxLifetimeMs: config.authTimeoutMs + 60_000,
      logger: ctx.logger,
    }, async (browser) => {
      const storedSession = await loadSessionState(ctx.service, ctx.logger);
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent: AKAMAI_WSA_USER_AGENT,
        ignoreHTTPSErrors: true,
        ...(storedSession ? { storageState: storedSession } : {}),
      });
      try {
      const page = await context.newPage();

      // Intercept X-XSRF-TOKEN from outgoing requests
      page.on('request', (request) => {
        if (capturedXsrfToken) return;
        const url = request.url();
        if (!url.includes('control.akamai.com')) return;
        const xsrf = request.headers()['x-xsrf-token'];
        if (xsrf) {
          capturedXsrfToken = xsrf;
          ctx.logger.info('captured X-XSRF-TOKEN from request header');
        }
      });

      const targetUrl = `${config.baseUrl}${config.appPath}`;
      ctx.logger.info('navigating to Akamai Control Center', { url: targetUrl });
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });

      // Stall detection state for the outer SSO loop
      let lastFingerprint = '';
      let unchangedFor = 0;
      let stallCaptured = false;
      let totpSubmits = 0;
      const stepLog: Array<Record<string, unknown>> = [];

      const deadline = Date.now() + config.authTimeoutMs;
      let step = 0;
      while (Date.now() < deadline) {
        const url = page.url();

        // Compute visible credential-field types for stall fingerprint
        const visibleFields: string[] = [];
        // Akamai auth page email field
        const akamaiEmailVis = await page.locator(
          'input[placeholder="account email address"], input[placeholder*="email address" i], input[type="email"]',
        ).first().isVisible({ timeout: 100 }).catch(() => false);
        if (akamaiEmailVis) visibleFields.push('email');

        // Password field (Akamai or Azure AD)
        const pwVis = await page.locator(
          'input[name="password"], input[type="password"], #passwordInput, input[name="passwd"]:not(.moveOffScreen)',
        ).first().isVisible({ timeout: 100 }).catch(() => false);
        if (pwVis) visibleFields.push('password');

        // MFA field (Azure AD)
        const mfaVis = await page.locator('#idTxtBx_SAOTCC_OTC, input[name="otc"]').isVisible({ timeout: 100 }).catch(() => false);
        if (mfaVis) visibleFields.push('mfa');

        // Azure AD login name field
        const adEmailVis = await page.locator('input[name="loginfmt"], #i0116').isVisible({ timeout: 100 }).catch(() => false);
        if (adEmailVis && !visibleFields.includes('email')) visibleFields.push('email');

        const fingerprint = sanitizeUrl(url) + '|' + visibleFields.slice().sort().join(',');

        // Record step telemetry
        stepLog.push({
          step,
          url: sanitizeUrl(url),
          action: 'pending',
          visibleFields: [...visibleFields],
        });

        // Stall detection: no !acted guard (Phase 1 lesson)
        if (fingerprint === lastFingerprint) {
          unchangedFor += 1;
        } else {
          lastFingerprint = fingerprint;
          unchangedFor = 0;
        }

        if (unchangedFor === 3 && !stallCaptured) {
          stallCaptured = true;
          await this._captureAndAnnotate(page as unknown as Parameters<typeof defaultCaptureDebugState>[0]['page'], 'stall', stepLog, ctx);
        }

        // Handle Akamai's own auth page
        if (url.includes('/apps/auth')) {
          ctx.logger.debug('on Akamai auth page');
          await page.waitForTimeout(1500);
          const emailInput = page.locator('input[placeholder="account email address"], input[placeholder*="email address" i], input[type="email"]').first();
          const emailVisible = await emailInput.isVisible({ timeout: 2000 }).catch(() => false);
          if (emailVisible) {
            await emailInput.click();
            await emailInput.fill('');
            await emailInput.type(config.loginHint, { delay: 50 });
            ctx.logger.debug('typed email on Akamai auth page');
            await page.waitForTimeout(500);
          }

          const akamaiPassword = page.locator('input[name="password"], input[type="password"]').first();
          const akamaiPasswordVisible = await akamaiPassword.isVisible({ timeout: 2000 }).catch(() => false);
          if (password && akamaiPasswordVisible) {
            await akamaiPassword.click();
            await akamaiPassword.fill('');
            await akamaiPassword.type(password, { delay: 25 });
            ctx.logger.debug('entered password on Akamai auth page');
            await page.waitForTimeout(500);
          }

          if (emailVisible || akamaiPasswordVisible) {
            await trySelector(page, SELECTORS.akamaiNextButton, 'click');
            await page.waitForTimeout(3000);
          }
        }

        // Azure AD SSO
        if (url.includes('login.microsoftonline.com') || url.includes('login.microsoft.com') || url.includes('/saml2')) {
          ctx.logger.debug('on SSO login page');
          await page.waitForTimeout(1500);

          // Email
          if (await trySelector(page, SELECTORS.emailInput, 'fill', config.loginHint)) {
            await trySelector(page, SELECTORS.submitButton, 'click');
            await page.waitForTimeout(2000);
          }

          // Password (SAML flow uses #passwordInput)
          if (password) {
            const pwField = page.locator('#passwordInput, input[name="passwd"]:not(.moveOffScreen), input[type="password"]:visible').first();
            const pwVisible = await pwField.isVisible({ timeout: 3000 }).catch(() => false);
            if (pwVisible) {
              await pwField.click();
              await pwField.fill(password);
              ctx.logger.debug('entered password');
              await trySelector(page, SELECTORS.submitButton, 'click');
              await page.waitForTimeout(3000);
            } else if (await trySelector(page, SELECTORS.passwordInput, 'fill', password)) {
              await trySelector(page, SELECTORS.submitButton, 'click');
              await page.waitForTimeout(3000);
            }
          }

          // MFA method selection page: if the Authenticator push notification
          // screen is showing and the TOTP input is not yet visible, click
          // "Use a verification code" to switch to the TOTP entry screen.
          // Use page.evaluate(offsetParent check) rather than Playwright isVisible()
          // because the MFA tile divs render in the DOM but may not satisfy Playwright's
          // strict CSS-based visibility definition (no explicit dimensions, etc.).
          const mfaInputVisible = await page.locator('#idTxtBx_SAOTCC_OTC, input[name="otc"]').isVisible({ timeout: 500 }).catch(() => false);
          // eslint-disable-next-line @typescript-eslint/no-implied-eval
          const mfaSelectionVisible = await page.evaluate(
            new Function('return !!(document.querySelector(\'[data-value="PhoneAppNotification"]\') || document.querySelector(\'#idDiv_SAOTCS_Title\'))') as () => boolean,
          ).catch(() => false);
          if (!mfaInputVisible && mfaSelectionVisible && totp) {
            ctx.logger.info('MFA method selection page detected; clicking TOTP option');
            const clickedTotp = await trySelector(page, SELECTORS.mfaUseTotpOption, 'click');
            if (clickedTotp) {
              await page.waitForTimeout(2000);
            } else {
              ctx.logger.warn('could not click TOTP option on MFA selection page; Authenticator push may be required');
            }
          }

          // MFA / TOTP — code resolved at fill time (lazy supplier). Initial
          // submit + one regenerated retry max; a third sighting of the MFA
          // input means both codes were rejected (lockout risk — abort).
          const mfaVisible = await page.locator('#idTxtBx_SAOTCC_OTC, input[name="otc"]').isVisible({ timeout: 2000 }).catch(() => false);
          if (mfaVisible && totp) {
            if (totpSubmits >= 2) throw new TotpRejectedError();
            const code = await resolveTotp(totp);
            if (code && await trySelector(page, SELECTORS.mfaCodeInput, 'fill', code)) {
              totpSubmits += 1;
              await trySelector(page, SELECTORS.mfaVerifyButton, 'click');
              await page.waitForTimeout(3000);
            }
          }

          // Stay signed in
          await trySelector(page, SELECTORS.staySignedIn, 'click');
          await page.waitForTimeout(1000);
        }

        // Check if we reached Akamai Control Center (not the auth page)
        if (url.includes('control.akamai.com') && !url.includes('/apps/auth') && !url.includes('login.microsoftonline.com')) {
          ctx.logger.info('Akamai Control Center loaded, waiting for session init');
          await page.waitForTimeout(8000);
          // Trigger heartbeat
          try {
            await page.evaluate(() => fetch('/ids-sso/v2/session/heartbeat', {
              method: 'POST', body: '{}',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
            }).catch(() => {}));
          } catch { /* ignore */ }
          await page.waitForTimeout(2000);
          break;
        }

        await page.waitForTimeout(1000);
        step += 1;
      }

      // Wait for session cookies (AKASSO, AKATOKEN)
      ctx.logger.info('waiting for session cookies');
      let akamaiCookies: Awaited<ReturnType<typeof context.cookies>> = [];
      const cookieWaitStart = Date.now();
      while (Date.now() - cookieWaitStart < 15_000) {
        const allCookies = await context.cookies();
        akamaiCookies = allCookies.filter(c =>
          c.domain.endsWith('.akamai.com') || c.domain === 'akamai.com' ||
          c.domain === 'control.akamai.com' || c.domain === '.control.akamai.com',
        );
        const hasSession = akamaiCookies.some(c => c.name === 'AKASSO' || c.name === 'AKATOKEN');
        if (hasSession) break;
        await page.waitForTimeout(1000);
      }

      const hasSession = akamaiCookies.some(c => c.name === 'AKASSO' || c.name === 'AKATOKEN');
      if (!hasSession) {
        const captureDir = await this._captureAndAnnotate(
          page as unknown as Parameters<typeof defaultCaptureDebugState>[0]['page'],
          'no_session_cookies',
          stepLog,
          ctx,
        );
        throw new Error(`No Akamai session cookies captured. Authentication may have failed. [debug capture: ${captureDir}]`);
      }

      const cookieString = akamaiCookies.map(c => `${c.name}=${c.value}`).join('; ');
      const xsrfCookieValue = akamaiCookies.find(c => c.name === 'XSRF-TOKEN')?.value;
      const xsrfToken = capturedXsrfToken || (xsrfCookieValue ? decodeURIComponent(xsrfCookieValue) : '');

      if (!xsrfToken) {
        const captureDir = await this._captureAndAnnotate(
          page as unknown as Parameters<typeof defaultCaptureDebugState>[0]['page'],
          'missing_xsrf_token',
          stepLog,
          ctx,
        );
        throw new Error(`Akamai authenticated but no XSRF token captured; downstream API calls will fail. [debug capture: ${captureDir}]`);
      }

      const now = this.deps.now();

      ctx.logger.info('Akamai WSA auth captured', {
        cookieCount: akamaiCookies.length,
        hasXsrf: !!xsrfToken,
      });

      const sessionState = await context.storageState().catch(() => undefined);
      if (sessionState) await saveSessionState(ctx.service, sessionState, ctx.logger);

      return {
        service: 'akamai-wsa',
        scheme: 'session',
        accessToken: xsrfToken,
        tokenType: 'XSRF',
        expiresAt: now + SESSION_LIFETIME_MS,
        acquiredAt: now,
        extra: {
          cookies: cookieString,
          xsrfToken,
          baseUrl: config.baseUrl,
          wafConfigId: config.wafConfigId,
        },
      };
      } catch (err) {
        // Stale/revoked SSO state must not be retried (covers auth failures
        // and conditional-access challenges alike).
        await invalidateSessionState(ctx.service, ctx.logger);
        throw err;
      }
    });
  }

  async refresh(ctx: ProviderContext, _bundle: TokenBundle): Promise<TokenBundle> {
    // Akamai sessions require full re-acquire
    return this.acquire(ctx, 'session');
  }

  async validate(ctx: ProviderContext, bundle: TokenBundle): Promise<boolean> {
    const extra = bundle.extra as Record<string, unknown> | undefined;
    const cookies = extra?.cookies;
    const xsrfToken = extra?.xsrfToken;
    const baseUrl = (extra?.baseUrl as string) || 'https://control.akamai.com';

    if (typeof cookies !== 'string' || !cookies) return false;
    if (!/(^|;\s*)(AKASSO|AKATOKEN)=/.test(cookies)) return false;
    if (typeof xsrfToken !== 'string' || !xsrfToken) return false;

    const headers: Record<string, string> = {
      Cookie: cookies,
      Accept: 'application/json',
      'User-Agent': AKAMAI_WSA_USER_AGENT,
    };
    if (typeof xsrfToken === 'string' && xsrfToken) {
      headers['X-XSRF-TOKEN'] = xsrfToken;
    }

    const doFetch = this.deps.httpFetch ?? (async (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => {
      const r = await globalThis.fetch(url, init);
      return { ok: r.ok, status: r.status };
    });

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        const resp = await doFetch(`${baseUrl}/ids-sso/v2/session/heartbeat`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: '{}',
          signal: controller.signal,
        });
        return resp.ok;
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      ctx.logger.warn('akamai-wsa validate failed', { error: (err as Error).message });
      return false;
    }
  }

  nextRefreshAt(bundle: TokenBundle): Date {
    return new Date(bundle.expiresAt - REFRESH_MARGIN_MS);
  }
}
