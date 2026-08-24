import type { Provider, ProviderCapabilities, ProviderContext, TokenBundle } from '@hermes/broker';
import { ConditionalAccessChallengeError, classifyConditionalAccessPage, trySelector, readKeychainPassword, readTotpSeedFromKeychain, makeTotpSupplier, resolveTotp, TotpRejectedError, captureDebugState as defaultCaptureDebugState, sanitizeUrl, withManagedBrowser, loadSessionState, saveSessionState, invalidateSessionState, type TotpInput, type CaptureDebugStateOptions, type CaptureDebugStateResult } from '@hermes/auth-core';
import { CookieSessionConfigSchema, SCHEMES } from './config.js';
import path from 'node:path';
import { promises as fs } from 'node:fs';

/**
 * Generic cookie-session provider — works for any service that uses Azure AD SSO
 * (or similar SAML/OIDC IdP with the same Microsoft selectors) and issues an HTTP
 * session cookie that the app accepts as auth.
 *
 * One provider, many services. Configure per-service via the registry; provider
 * binary code does not change between services.
 */

// Default selectors for an explicit "Sign in with SSO" button on the service's own
// login page. These are tried first; service-specific ones from config are appended.
const DEFAULT_SSO_BUTTON_SELECTORS = [
  'button:has-text("SSO")', 'a:has-text("SSO")',
  'button:has-text("Sign in with SSO")', 'a:has-text("Sign in with SSO")',
  '[data-testid="sso-button"]', '.sso-login', '#sso-login',
  'button:has-text("Azure")', 'a:has-text("Azure")',
  'button:has-text("Microsoft")', 'a:has-text("Microsoft")',
  'button:has-text("Enterprise")', 'a:has-text("Enterprise")',
  'button:has-text("Single Sign On")', 'a:has-text("Single Sign On")',
];

const EMAIL_SELECTORS = [
  'input[name="loginfmt"]', 'input[type="email"]', 'input[name="email"]',
  'input[name="username"]', 'input[name="user"]',
  // Venafi LOCAL login form uses title-cased name and class/id selectors
  'input#username_id', 'input.username', 'input[name="Username"]',
];
const PW_SELECTORS = [
  'input[name="passwd"]', 'input[type="password"]', 'input[name="password"]',
];
const TOTP_SELECTORS = [
  'input[name="otc"]', 'input#idTxtBx_SAOTCC_OTC', 'input[placeholder*="code"]',
];
const SUBMIT_SELECTORS = [
  'input[type="submit"]', 'button[type="submit"]', '#idSIButton9',
  'a#loginButton', '#loginButton',
];
const CONSENT_SELECTORS = [
  '#idSIButton9', '#idBtn_Back', '#acceptButton',
  'button:has-text("Yes")', 'button:has-text("Accept")', 'button:has-text("Continue")',
  'button:has-text("Stay signed in")', 'button:has-text("Approve")',
];
const MFA_VERIFY_SELECTORS = [
  '#idSubmit_SAOTCC_Continue', 'input[type="submit"][value="Verify"]',
];
const DEVICE_CODE_SWITCH_SELECTORS = [
  'a:has-text("I can\'t use my Microsoft Authenticator")',
  'a:has-text("sign in another way")',
  'a:has-text("Use a different")',
  'a:has-text("try another")',
  '#signInAnotherWay',
  '#idA_PWD_SwitchToCredPicker',
];

function isAzureLoginUrl(url: string): boolean {
  return url.includes('login.microsoftonline.com')
      || url.includes('login.microsoft.com')
      || url.includes('login.live.com')
      || url.includes('sts.windows.net')
      || url.includes('device.login.microsoftonline.com');
}

async function clickAnySelectorInPageOrFrames(page: any, selectors: string[]): Promise<boolean> {
  const targets = [page, ...(page.frames?.() ?? [])];
  for (const target of targets) {
    for (const sel of selectors) {
      const el = await target.$(sel).catch(() => null);
      if (el && await el.isVisible().catch(() => false)) {
        await el.click().catch(() => {});
        return true;
      }
    }
  }
  return false;
}

export interface CookieSessionProviderDeps {
  now: () => number;
  httpFetch?: (url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean; status: number }>;
  captureDebugState?: (opts: CaptureDebugStateOptions) => Promise<CaptureDebugStateResult>;
}

/**
 * Storm floor. No single stray cookie or bogus sessionStorage value may drive the
 * derived lifetime below this — a too-short lifetime burns the AD/SSO budget and
 * risks MFA lockout on a proactive-refresh storm. A too-long lifetime degrades
 * gracefully (401 → re-acquire), so we bias toward the safe (longer) side.
 */
const MIN_DERIVED_LIFETIME_MS = 15 * 60 * 1000;

/**
 * Parse a captured session-expiry value into epoch milliseconds. Accepts epoch
 * seconds, epoch milliseconds, a numeric string, or an ISO/date string. Returns
 * undefined for anything unparseable so the caller falls back to cookie/config math.
 *
 * Magnitude heuristic: a positive value < 1e12 is treated as epoch SECONDS
 * (1e12 s ≈ year 33658), else epoch MILLISECONDS (1e12 ms ≈ year 2001).
 */
export function parseSessionExpiryValue(raw: unknown): number | undefined {
  let v: unknown = raw;
  if (v == null) return undefined;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '') return undefined;
    // Unwrap JSON-quoted strings (sessionStorage often stores JSON.stringify'd values).
    if (t.startsWith('"') && t.endsWith('"')) {
      try { v = JSON.parse(t); } catch { v = t; }
    } else {
      v = t;
    }
  }
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
  }
  if (typeof v === 'string') {
    const asNum = Number(v);
    if (Number.isFinite(asNum) && asNum > 0) {
      return asNum < 1e12 ? Math.round(asNum * 1000) : Math.round(asNum);
    }
    const parsed = Date.parse(v);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Derive the bundle's real `expiresAt` from the captured session rather than the
 * optimistic `sessionLifetimeMs` default. Precedence:
 *   1. SPA sessionStorage expiry (authoritative — e.g. Venafi Aperture `expires`).
 *   2. Earliest FINITE in-window service-domain cookie expiry (session-cookie death).
 *   3. Configured `sessionLifetimeMs` upper bound.
 *
 * Persistent (years-out) and session-only (-1) cookies are ignored so `min` of the
 * finite in-window expiries naturally selects the real session cookie. The refresh
 * margin is capped at 60% of the (possibly-short) real lifetime so `nextRefreshAt`
 * (= expiresAt - margin) fires at ~40% of life — before the real death, never a
 * tight loop when the real lifetime is far shorter than the configured margin.
 */
export function computeCookieSessionExpiry(
  now: number,
  opts: {
    cookies: ReadonlyArray<{ name: string; domain: string; expires?: number }>;
    serviceDomains: ReadonlyArray<string>;
    sessionStorageExpiryRaw?: unknown;
    config: { sessionLifetimeMs: number; refreshMarginMs: number };
  },
): { expiresAt: number; effectiveLifetimeMs: number; effectiveRefreshMarginMs: number; derivedFrom: 'sessionStorage' | 'cookie' | 'configuredLifetime' } {
  const { cookies, serviceDomains, sessionStorageExpiryRaw, config } = opts;
  const upperBound = now + config.sessionLifetimeMs;
  let rawExpiry: number | undefined;
  let derivedFrom: 'sessionStorage' | 'cookie' | 'configuredLifetime' = 'configuredLifetime';

  // 1. Authoritative: SPA sessionStorage expiry (the app's own view of session death).
  const ssExpiry = parseSessionExpiryValue(sessionStorageExpiryRaw);
  if (ssExpiry !== undefined && ssExpiry > now) {
    rawExpiry = ssExpiry;
    derivedFrom = 'sessionStorage';
  }

  // 2. Fallback: earliest finite in-window service-domain cookie expiry.
  if (rawExpiry === undefined) {
    const finiteInWindowMs = (c: { domain: string; expires?: number }): number | undefined => {
      if (!serviceDomains.some((d) => c.domain.includes(d))) return undefined;
      if (typeof c.expires !== 'number' || c.expires <= 0) return undefined; // -1 = session-only
      const ms = Math.round(c.expires * 1000);
      return ms > now && ms < upperBound ? ms : undefined; // drop persistent (years-out) cookies
    };
    const candidates = cookies
      .map(finiteInWindowMs)
      .filter((ms): ms is number => ms !== undefined);
    if (candidates.length) {
      rawExpiry = Math.min(...candidates);
      derivedFrom = 'cookie';
    }
  }

  // 3. Storm floor, then clamp to the configured upper bound.
  const flooredExpiry = rawExpiry !== undefined
    ? Math.max(rawExpiry, now + MIN_DERIVED_LIFETIME_MS)
    : undefined;
  const expiresAt = Math.min(flooredExpiry ?? upperBound, upperBound);
  const effectiveLifetimeMs = Math.max(0, expiresAt - now);
  const effectiveRefreshMarginMs = Math.min(
    config.refreshMarginMs,
    Math.floor(effectiveLifetimeMs * 0.6),
  );
  return { expiresAt, effectiveLifetimeMs, effectiveRefreshMarginMs, derivedFrom };
}

const COOKIE_SESSION_CAPABILITIES: ProviderCapabilities = {
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
    acquire: 'Run hermes acquire for the service after confirming loginHint, baseUrl, SSO selectors, and keychain-backed credentials.',
    refresh: 'Cookie sessions cannot silently refresh; Hermes performs a headless full re-acquire when validation or schedule requires it.',
    validate: '401/403 from validatePath means re-acquire; network/5xx is treated as inconclusive to avoid unnecessary SSO churn.',
  },
  conditionalAccessModes: [
    'mfa_or_totp_required',
    'device_certificate_required',
    'vpn_or_network_required',
    'consent_required',
    'password_expired',
    'browser_profile_locked',
    'prompt_loop',
    'policy_blocks_headless',
    'unknown_login_route',
  ],
  requiresDeviceContext: false,
  supportsTotp: true,
  supportsDeviceCodeFallback: false,
  browserProfileStrategy: 'service-scoped-persistent',
};

export class CookieSessionProvider implements Provider {
  readonly name = 'cookie-session';
  readonly schemes = SCHEMES;
  readonly capabilities = COOKIE_SESSION_CAPABILITIES;

  constructor(private readonly deps: CookieSessionProviderDeps) {}

  private async _captureAndAnnotate(
    page: Parameters<typeof defaultCaptureDebugState>[0]['page'],
    reason: string,
    stepLog: ReadonlyArray<Record<string, unknown>>,
    ctx: ProviderContext,
  ): Promise<string> {
    const config = CookieSessionConfigSchema.parse(ctx.config);
    const targetHost = new URL(config.baseUrl).hostname;
    const serviceName = config.serviceName ?? (targetHost.split('.')[0] || 'service');
    const serviceKey = `cookie-session-${ctx.service !== 'cookie-session' ? ctx.service : serviceName}`;
    const doCapture = this.deps.captureDebugState ?? defaultCaptureDebugState;
    const result = await doCapture({ page, reason, service: serviceKey, baseDir: ctx.dataDir, stepLog });
    ctx.logger.warn('cookie-session debug state captured', { captureDir: result.captureDir, reason, service: serviceKey });
    if (result.errors.length > 0) {
      ctx.logger.warn('cookie-session debug capture partial failure', { captureErrors: result.errors });
    }
    return result.captureDir;
  }

  private async _throwIfClassifiedChallenge(
    page: Parameters<typeof classifyConditionalAccessPage>[0],
    ctx: ProviderContext,
    totp: TotpInput | undefined,
    unknownLoginRoute = false,
    stepLog?: ReadonlyArray<Record<string, unknown>>,
  ): Promise<void> {
    const challenge = await classifyConditionalAccessPage(page, {
      service: ctx.service,
      acquireCommand: `hermes acquire ${ctx.service}`,
      totpConfigured: Boolean(totp),
      unknownLoginRoute,
    });
    if (challenge) {
      if (stepLog !== undefined) {
        const captureDir = await this._captureAndAnnotate(
          page as unknown as Parameters<typeof defaultCaptureDebugState>[0]['page'],
          `conditional_access_${challenge.state}`,
          stepLog,
          ctx,
        );
        challenge.message = `${challenge.message} [debug capture: ${captureDir}]`;
      }
      throw new ConditionalAccessChallengeError(challenge);
    }
  }

  private async _resolveCredentials(ctx: ProviderContext) {
    const config = CookieSessionConfigSchema.parse(ctx.config);
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
    const targetHost = new URL(config.baseUrl).hostname;
    const serviceName = config.serviceName ?? (targetHost.split('.')[0] || 'service');
    const profileDir = path.join(ctx.dataDir, 'cookie-session', serviceName, 'profile');
    await fs.mkdir(profileDir, { recursive: true });

    const ssoSelectors = [...DEFAULT_SSO_BUTTON_SELECTORS, ...config.ssoButtonSelectors];
    const cookieDomainPatterns = [targetHost, ...config.extraCookieDomains];

    return withManagedBrowser({
      service: ctx.service,
      engine: 'firefox',
      launchOptions: {
        headless: config.headless,
        firefoxUserPrefs: { 'security.default_personal_cert': 'Select Automatically' },
      },
      profileDir,
      maxLifetimeMs: config.authTimeoutMs + 60_000,
      logger: ctx.logger,
    }, async (browser) => {
      const storedSession = await loadSessionState(ctx.service, ctx.logger);
      const browserContext = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        ignoreHTTPSErrors: true,
        ...(storedSession ? { storageState: storedSession } : {}),
      });
      try {
      const page = await browserContext.newPage();

      ctx.logger.info('cookie-session: navigating to service', { service: serviceName, url: config.baseUrl });
      await page.goto(config.baseUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForTimeout(2000);

      // Optional explicit SSO button click (no-op if service auto-redirects).
      try {
        const clicked = await clickAnySelectorInPageOrFrames(page, ssoSelectors)
          || await trySelector(page, ssoSelectors, 'click');
        if (clicked) {
          ctx.logger.debug('cookie-session: clicked explicit SSO button');
          await page.waitForTimeout(2000);
        }
      } catch { /* ignore */ }

      // Stall detection state
      let lastFingerprint = '';
      let unchangedFor = 0;
      let stallCaptured = false;
      let totpSubmits = 0;
      const stepLog: Array<Record<string, unknown>> = [];

      const deadline = Date.now() + config.authTimeoutMs;
      for (let step = 0; step < 30 && Date.now() < deadline; step++) {
        const url = page.url();
        const onTarget = url.includes(targetHost) && !isAzureLoginUrl(url);
        const hasLoginForm = await page.$$('input[type="email"]:visible, input[type="password"]:visible, input[name="loginfmt"]:visible, input[name="passwd"]:visible, input[name="otc"]:visible, input#username_id:visible, input.username:visible, input[name="Username"]:visible');

        if (onTarget && hasLoginForm.length === 0) {
          ctx.logger.info('cookie-session: SSO complete, landed on service', { service: serviceName });
          break;
        }

        // Compute which credential-field types are currently visible (for stall fingerprint)
        const visibleFields: string[] = [];
        for (const sel of EMAIL_SELECTORS) {
          if (await page.locator(sel).isVisible({ timeout: 100 }).catch(() => false)) {
            visibleFields.push('email');
            break;
          }
        }
        for (const sel of PW_SELECTORS) {
          if (await page.locator(sel).isVisible({ timeout: 100 }).catch(() => false)) {
            visibleFields.push('password');
            break;
          }
        }
        for (const sel of TOTP_SELECTORS) {
          if (await page.locator(sel).isVisible({ timeout: 100 }).catch(() => false)) {
            visibleFields.push('totp');
            break;
          }
        }

        const fingerprint = url + '|' + visibleFields.slice().sort().join(',');

        let acted = false;
        let actionTaken = 'none';

        // Some service login pages host the SSO button in an iframe.
        if (await clickAnySelectorInPageOrFrames(page, ssoSelectors)) {
          ctx.logger.debug('cookie-session: clicked explicit SSO button');
          await page.waitForTimeout(2000);
          acted = true;
          actionTaken = 'sso-button';
        }

        // Combined single-page username+password form (e.g. Venafi local login):
        // fill BOTH fields before submitting — submitting after only the username fails.
        if (!acted && password && visibleFields.includes('email') && visibleFields.includes('password')) {
          const filledUser = await trySelector(page, EMAIL_SELECTORS, 'fill', config.loginHint);
          const filledPass = await trySelector(page, PW_SELECTORS, 'fill', password);
          if (filledUser && filledPass) {
            if (totp && visibleFields.includes('totp')) {
              const code = await resolveTotp(totp);
              if (code && await trySelector(page, TOTP_SELECTORS, 'fill', code)) totpSubmits += 1;
            }
            await trySelector(page, SUBMIT_SELECTORS, 'click');
            await page.waitForNavigation({ timeout: 8000 }).catch(() => {});
            await page.waitForTimeout(2000);
            acted = true;
            actionTaken = 'combined-login';
          }
        }

        // Email step
        if (!acted && await trySelector(page, EMAIL_SELECTORS, 'fill', config.loginHint)) {
          ctx.logger.debug('cookie-session: filled email');
          await trySelector(page, SUBMIT_SELECTORS, 'click');
          await page.waitForNavigation({ timeout: 8000 }).catch(() => {});
          await page.waitForTimeout(2000);
          acted = true;
          actionTaken = 'email';
        }

        // Password step
        if (!acted && password) {
          if (await trySelector(page, PW_SELECTORS, 'fill', password)) {
            ctx.logger.debug('cookie-session: filled password');
            await trySelector(page, SUBMIT_SELECTORS, 'click');
            await page.waitForNavigation({ timeout: 8000 }).catch(() => {});
            await page.waitForTimeout(2000);
            acted = true;
            actionTaken = 'password';
          }
        }

        // TOTP step (avoid phone-push when possible) — code resolved at fill
        // time (lazy supplier). Initial submit + one regenerated retry max; a
        // third sighting means both codes were rejected (lockout risk — abort).
        if (!acted && totp && visibleFields.includes('totp')) {
          if (totpSubmits >= 2) throw new TotpRejectedError();
          const code = await resolveTotp(totp);
          if (code && await trySelector(page, TOTP_SELECTORS, 'fill', code)) {
            totpSubmits += 1;
            ctx.logger.debug('cookie-session: filled TOTP', { attempt: totpSubmits });
            await trySelector(page, MFA_VERIFY_SELECTORS, 'click');
            await page.waitForNavigation({ timeout: 8000 }).catch(() => {});
            await page.waitForTimeout(2000);
            acted = true;
            actionTaken = 'totp';
          }
        }

        // Device-code MFA — try to switch to TOTP code entry
        if (!acted && url.includes('device.login.microsoftonline.com')) {
          for (const sel of DEVICE_CODE_SWITCH_SELECTORS) {
            const el = await page.$(sel).catch(() => null);
            if (el && await el.isVisible().catch(() => false)) {
              await el.click().catch(() => {});
              await page.waitForTimeout(2000);
              acted = true;
              actionTaken = 'device-code-switch';
              break;
            }
          }
        }

        // Consent / Stay signed in
        if (!acted) {
          for (const sel of CONSENT_SELECTORS) {
            const btn = await page.$(sel).catch(() => null);
            if (btn && await btn.isVisible().catch(() => false)) {
              await btn.click().catch(() => {});
              await page.waitForTimeout(3000);
              acted = true;
              actionTaken = 'consent';
              break;
            }
          }
        }

        // Record step telemetry (sanitize URL to strip OAuth/SAML params)
        stepLog.push({ step, url: sanitizeUrl(url), onTarget, hasLoginForm: hasLoginForm.length, visibleFields, action: actionTaken });

        // Stall detection: fingerprint = url + visible field types; if unchanged increment counter
        if (fingerprint === lastFingerprint) {
          unchangedFor += 1;
        } else {
          lastFingerprint = fingerprint;
          unchangedFor = 0;
        }

        if (unchangedFor === 3 && !stallCaptured) {
          stallCaptured = true;
          await this._captureAndAnnotate(page, 'stall', stepLog, ctx);
        }

        if (!acted) {
          await this._throwIfClassifiedChallenge(page, ctx, totp, false, stepLog);
          await page.waitForTimeout(5000);
        }
      }

      if (!page.url().includes(targetHost) || isAzureLoginUrl(page.url())) {
        await this._throwIfClassifiedChallenge(page, ctx, totp, true, stepLog);
        const captureDir = await this._captureAndAnnotate(page, 'sso_did_not_land', stepLog, ctx);
        throw new Error(`SSO did not land on ${serviceName}; final URL: ${page.url().substring(0, 120)} [debug capture: ${captureDir}]`);
      }

      // Probe to ensure the API session is alive (skipped if not configured)
      if (config.validatePath) {
        let probeStatus: number | undefined;
        try {
          const probePath = config.validatePath;
          probeStatus = await page.evaluate(async (p: string) => {
            const resp = await fetch(p, {
              credentials: 'same-origin',
              headers: { Accept: 'application/json' },
            });
            return resp.status;
          }, probePath);
          if (config.requireValidateSuccess && (probeStatus === 401 || probeStatus === 403 || probeStatus >= 500)) {
            const captureDir = await this._captureAndAnnotate(page, 'validate_probe_failed', stepLog, ctx);
            throw new Error(`validate probe failed with status ${probeStatus} [debug capture: ${captureDir}]`);
          }
        } catch (e) {
          if (config.requireValidateSuccess) {
            const debugCookies = await browserContext.cookies().catch(() => []);
            const serviceCookieNames = debugCookies
              .filter((c: { domain: string }) => c.domain.includes(targetHost))
              .map((c: { name: string }) => c.name);
            ctx.logger.warn('cookie-session: validate probe failed', {
              service: serviceName,
              status: probeStatus,
              finalUrl: page.url(),
              serviceCookieNames,
            });
            throw e;
          }
          /* ignore — captured cookies still valid */
        }
      }

      const allCookies = await browserContext.cookies();
      const matchedCookies = allCookies.filter((c: { domain: string }) =>
        cookieDomainPatterns.some((pattern) => c.domain.includes(pattern)) ||
        (config.includeMicrosoftCookies && c.domain.includes('microsoftonline.com')),
      );

      const serviceCookies = matchedCookies.filter((c: { domain: string }) =>
        cookieDomainPatterns.some((pattern) => c.domain.includes(pattern)),
      );
      const cookieHeader = serviceCookies
        .map((c: { name: string; value: string }) => `${c.name}=${c.value}`)
        .join('; ');

      // Capture sessionStorage keys if configured (e.g. Venafi apiKey, transferToken)
      let sessionStorageData: Record<string, string> = {};
      if (config.captureSessionStorageKeys.length > 0) {
        try {
          sessionStorageData = await page.evaluate((keys: string[]) => {
            const result: Record<string, string> = {};
            const browserSessionStorage = (globalThis as unknown as {
              sessionStorage: { getItem(key: string): string | null };
            }).sessionStorage;
            for (const key of keys) {
              const val = browserSessionStorage.getItem(key);
              if (val !== null) result[key] = val;
            }
            return result;
          }, config.captureSessionStorageKeys);
          ctx.logger.info('cookie-session: captured sessionStorage', {
            service: serviceName,
            keys: Object.keys(sessionStorageData),
          });
        } catch (e) {
          ctx.logger.warn('cookie-session: failed to read sessionStorage', { error: String(e) });
        }
      }

      // Determine accessToken: sessionStorage token overrides cookie header
      let accessToken = cookieHeader;
      let tokenType = 'Cookie';
      if (config.sessionStorageTokenKey && sessionStorageData[config.sessionStorageTokenKey]) {
        let tokenValue = sessionStorageData[config.sessionStorageTokenKey]!;
        // Unwrap JSON-stringified values (e.g. sessionStorage.setItem(key, JSON.stringify(value))).
        // If the raw string is a JSON-quoted string, parse it to recover the bare value.
        if (typeof tokenValue === 'string') {
          const trimmed = tokenValue.trim();
          if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
            try {
              const parsed = JSON.parse(trimmed);
              if (typeof parsed === 'string') tokenValue = parsed;
            } catch { /* not JSON-quoted; keep raw */ }
          }
        }
        accessToken = tokenValue;
        tokenType = 'SessionStorageToken';
        ctx.logger.info('cookie-session: using sessionStorage token as accessToken', {
          service: serviceName,
          key: config.sessionStorageTokenKey,
        });
      }

      const now = this.deps.now();

      // Derive the REAL session expiry from the captured session (SPA sessionStorage
      // expiry or the earliest finite service cookie) instead of the optimistic
      // sessionLifetimeMs default — so Hermes never serves a dead session as 200.
      const expiryRaw = sessionStorageData[config.sessionStorageExpiryKey ?? 'expires'];
      const { expiresAt, effectiveLifetimeMs, effectiveRefreshMarginMs, derivedFrom } =
        computeCookieSessionExpiry(now, {
          cookies: matchedCookies,
          serviceDomains: cookieDomainPatterns,
          sessionStorageExpiryRaw: expiryRaw,
          config: { sessionLifetimeMs: config.sessionLifetimeMs, refreshMarginMs: config.refreshMarginMs },
        });

      ctx.logger.info('cookie-session: auth captured', {
        service: serviceName,
        targetHost,
        serviceCookieCount: serviceCookies.length,
        totalCookieCount: matchedCookies.length,
        sessionStorageKeys: Object.keys(sessionStorageData).length,
        expiryDerivedFrom: derivedFrom,
        effectiveLifetimeMin: Math.round(effectiveLifetimeMs / 60_000),
        cookieDerived: derivedFrom !== 'configuredLifetime',
      });

      const sessionState = await browserContext.storageState().catch(() => undefined);
      if (sessionState) await saveSessionState(ctx.service, sessionState, ctx.logger);

      return {
        service: serviceName,
        scheme: 'session',
        accessToken,
        tokenType,
        expiresAt,
        acquiredAt: now,
        extra: {
          baseUrl: config.baseUrl,
          targetHost,
          serviceName,
          cookies: matchedCookies.map((c: { name: string; value: string; domain: string; path: string; secure: boolean; httpOnly: boolean }) => ({
            name: c.name, value: c.value, domain: c.domain, path: c.path,
            secure: c.secure, httpOnly: c.httpOnly,
          })),
          sessionStorage: Object.keys(sessionStorageData).length > 0 ? sessionStorageData : undefined,
          refreshMarginMs: effectiveRefreshMarginMs,
          sessionLifetimeMs: effectiveLifetimeMs,
        },
      };
      } catch (err) {
        // Stale/revoked SSO state must not be retried (covers
        // ConditionalAccessChallengeError and all other auth failures).
        await invalidateSessionState(ctx.service, ctx.logger);
        throw err;
      }
    });
  }

  async refresh(ctx: ProviderContext, _bundle: TokenBundle): Promise<TokenBundle> {
    // Cookie sessions cannot be silently refreshed — full re-acquire.
    return this.acquire(ctx, 'session');
  }

  async validate(ctx: ProviderContext, bundle: TokenBundle): Promise<boolean> {
    const config = CookieSessionConfigSchema.parse(ctx.config);
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(bundle.tokenType === 'SessionStorageToken'
        ? config.sessionStorageTokenHeader
          ? { [config.sessionStorageTokenHeader]: bundle.accessToken }
          : { Authorization: `Bearer ${bundle.accessToken}` }
        : { Cookie: bundle.accessToken }),
    };

    const doFetch = this.deps.httpFetch ?? (async (url: string, init: { headers: Record<string, string> }) => {
      const r = await globalThis.fetch(url, init);
      return { ok: r.ok, status: r.status };
    });

    const probeUrl = config.validatePath
      ? `${config.baseUrl}${config.validatePath}`
      : config.baseUrl;

    try {
      const resp = await doFetch(probeUrl, { headers });
      // Definite auth failure — token is invalid, refresh.
      if (resp.status === 401 || resp.status === 403) {
        ctx.logger.info('cookie-session: validate received auth failure', {
          service: config.serviceName ?? 'unknown',
          status: resp.status,
        });
        return false;
      }
      // 2xx — token is good.
      if (resp.ok) return true;
      // Anything else (5xx, redirects, etc.) — service issue, not auth issue.
      // Assume token is still valid; let the next consumer-side 401 trigger refresh.
      ctx.logger.debug('cookie-session: validate inconclusive (non-auth status)', {
        service: config.serviceName ?? 'unknown',
        status: resp.status,
      });
      return true;
    } catch (err) {
      // Network failure — service unreachable from broker (e.g. broker Node fetch
      // bypasses system proxy that Firefox uses, or the host is off VPN entirely).
      // Refusing to validate would force a re-auth on every poll. Instead, assume
      // the cached token is still valid and let consumer 401s drive refresh.
      ctx.logger.warn('cookie-session: validate network error — assuming token valid', {
        service: config.serviceName ?? 'unknown',
        error: (err as Error).message,
      });
      return true;
    }
  }

  nextRefreshAt(bundle: TokenBundle): Date {
    // The bundle's expiresAt was set using config.sessionLifetimeMs; subtract the
    // configured refresh margin (default 1h). Fallback margin if extra is missing.
    const refreshMarginMs = (bundle.extra as { refreshMarginMs?: unknown } | undefined)?.refreshMarginMs;
    const margin = typeof refreshMarginMs === 'number' ? refreshMarginMs : 60 * 60 * 1000;
    return new Date(bundle.expiresAt - margin);
  }
}
