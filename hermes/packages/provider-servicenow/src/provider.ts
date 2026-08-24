import type { Provider, ProviderCapabilities, ProviderContext, TokenBundle } from '@hermes/broker';
import { ConditionalAccessChallengeError, classifyConditionalAccessPage, readKeychainPassword, readTotpSeedFromKeychain, makeTotpSupplier, captureDebugState as defaultCaptureDebugState, runSsoLoop, withManagedBrowser, loadSessionState, saveSessionState, invalidateSessionState, type SsoPage, type TotpInput, type CaptureDebugStateOptions, type CaptureDebugStateResult } from '@hermes/auth-core';
import { DEFAULT_REFRESH_MARGIN_MS, DEFAULT_SESSION_LIFETIME_MS, ServiceNowConfigSchema, SCHEMES, type ServiceNowConfig } from './config.js';
import path from 'node:path';
import { promises as fs } from 'node:fs';

const EMAIL_SELECTORS = [
  'input[name="loginfmt"]', 'input[type="email"]', 'input[name="email"]',
  'input[name="username"]', 'input[name="user"]',
];
const PW_SELECTORS = [
  'input[name="passwd"]', 'input[type="password"]', 'input[name="password"]',
];
const TOTP_SELECTORS = [
  'input[name="otc"]', 'input#idTxtBx_SAOTCC_OTC', 'input[placeholder*="code"]',
];
const SUBMIT_SELECTORS = [
  'input[type="submit"]', 'button[type="submit"]', '#idSIButton9',
];
const CONSENT_SELECTORS = [
  '#idSIButton9', '#idBtn_Back', '#acceptButton',
  'button:has-text("Yes")', 'button:has-text("Accept")', 'button:has-text("Continue")',
  'button:has-text("Stay signed in")', 'button:has-text("Approve")',
];
const MFA_VERIFY_SELECTORS = [
  '#idSubmit_SAOTCC_Continue', 'input[type="submit"][value="Verify"]',
];

// NOTE: the configured 4h sessionLifetimeMs is only an UPPER BOUND. The real
// production ServiceNow session dies at ~60min (the glide_session_store cookie
// TTL); the true expiry is derived per-capture in computeServiceNowSessionExpiry
// and the proactive refresh is scheduled from that, NOT from the 4h config.
const PROFILE_LOCK_BACKOFF_MS = 10_000;

export type ServiceNowSessionFailureCode =
  | 'cookie_expired'
  | 'missing_or_invalid_g_ck'
  | 'csrf_invalid'
  | 'api_unauthorized'
  | 'api_forbidden'
  | 'session_info_unavailable'
  | 'instance_redirect_or_login_route_changed'
  | 'network_or_vpn_unreachable'
  | 'browser_profile_locked';

export interface ServiceNowSessionFailureClassification {
  code: ServiceNowSessionFailureCode;
  category: 'auth' | 'configuration' | 'transient';
  authFailure: boolean;
  retryable: boolean;
  retryAfterMs?: number;
  remediation: string;
}

export class ServiceNowSessionError extends Error {
  public readonly code: ServiceNowSessionFailureCode;
  public readonly classification: ServiceNowSessionFailureClassification;
  public readonly retryable: boolean;
  public readonly retryAfterMs?: number;

  constructor(classification: ServiceNowSessionFailureClassification, message?: string) {
    super(message ?? `${classification.code}: ${classification.remediation}`);
    this.name = 'ServiceNowSessionError';
    this.code = classification.code;
    this.classification = classification;
    this.retryable = classification.retryable;
    this.retryAfterMs = classification.retryAfterMs;
  }
}

export interface ServiceNowHttpResponse {
  ok: boolean;
  status: number;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface ServiceNowProviderDeps {
  now: () => number;
  httpFetch?: (url: string, init: { headers: Record<string, string> }) => Promise<ServiceNowHttpResponse>;
  acquireSession?: (
    ctx: ProviderContext,
    scheme: string,
    resolved: { config: ServiceNowConfig; password?: string; totp?: TotpInput },
  ) => Promise<TokenBundle>;
  captureDebugState?: (opts: CaptureDebugStateOptions) => Promise<CaptureDebugStateResult>;
}

const SERVICENOW_CAPABILITIES: ProviderCapabilities = {
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
    acquire: 'Run hermes acquire servicenow after confirming instanceUrl, loginHint, keychain-backed credentials, VPN, and ServiceNow login route selectors.',
    refresh: 'ServiceNow cookie sessions cannot silently refresh; Hermes performs a headless full re-acquire and coalesces concurrent requests.',
    validate: 'ServiceNow cookie/g_ck/CSRF/API 401/403 failures require re-acquire; network/VPN/5xx failures are degraded/retryable and should not trigger credential deletion or rotation.',
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
  requiresDeviceContext: true,
  supportsTotp: true,
  supportsDeviceCodeFallback: false,
  browserProfileStrategy: 'service-scoped-persistent',
};

function serviceNowUrl(instanceUrl: string, relativePath: string): string {
  return new URL(relativePath, instanceUrl).toString();
}

function normalizeHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => { out[key.toLowerCase()] = value; });
  return out;
}

function bodyText(resp: ServiceNowHttpResponse): string {
  return resp.body ?? '';
}

function responseContentType(resp: ServiceNowHttpResponse): string {
  return resp.headers?.['content-type'] ?? resp.headers?.['Content-Type'] ?? '';
}

function looksLikeLoginRoute(urlOrBody: string): boolean {
  return /(?:login|logout|navpage|welcome|sso|saml|oauth|signin|signon|microsoftonline\.com|microsoft\.com)/i.test(urlOrBody)
    || /<form[^>]+(?:login|signin|signon)|type=["']password["']|User name|Sign in/i.test(urlOrBody);
}

function looksLikeNetworkFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network|fetch failed|aborted|timeout|VPN|proxy|tunnel|Netskope|Zscaler/i.test(message);
}

function looksLikeCsrfFailure(text: string): boolean {
  return /csrf|xsrf|g_ck|x-usertoken|user.?token|invalid.?token|security token|Invalid Glide Session|User Not Authenticated/i.test(text);
}

function extractGck(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { result?: { g_ck?: unknown } };
    const gCk = parsed.result?.g_ck;
    return typeof gCk === 'string' && gCk.trim() ? gCk : undefined;
  } catch {
    return undefined;
  }
}

function failureClassification(
  code: ServiceNowSessionFailureCode,
  opts: { retryAfterMs?: number } = {},
): ServiceNowSessionFailureClassification {
  switch (code) {
    case 'cookie_expired':
      return {
        code,
        category: 'auth',
        authFailure: true,
        retryable: true,
        remediation: 'ServiceNow cookie session is expired or inside the conservative refresh window; mark the credential suspect and re-acquire headlessly.',
      };
    case 'missing_or_invalid_g_ck':
      return {
        code,
        category: 'auth',
        authFailure: true,
        retryable: true,
        remediation: 'The ServiceNow session is missing a usable g_ck/X-UserToken CSRF token; re-acquire the cookie session instead of rotating stored credentials.',
      };
    case 'csrf_invalid':
      return {
        code,
        category: 'auth',
        authFailure: true,
        retryable: true,
        remediation: 'ServiceNow rejected the CSRF/X-UserToken token; mark the session suspect and re-acquire cookies plus g_ck.',
      };
    case 'api_unauthorized':
      return {
        code,
        category: 'auth',
        authFailure: true,
        retryable: true,
        remediation: 'ServiceNow API returned 401 User Not Authenticated; mark the session suspect and re-acquire headlessly.',
      };
    case 'api_forbidden':
      return {
        code,
        category: 'auth',
        authFailure: true,
        retryable: true,
        remediation: 'ServiceNow API returned 403 for the current cookie session; re-acquire before suspecting network or deleting credentials.',
      };
    case 'session_info_unavailable':
      return {
        code,
        category: 'configuration',
        authFailure: true,
        retryable: true,
        remediation: 'ServiceNow session_info did not return a usable g_ck; verify the instance route and re-acquire the session.',
      };
    case 'instance_redirect_or_login_route_changed':
      return {
        code,
        category: 'configuration',
        authFailure: true,
        retryable: false,
        remediation: 'ServiceNow validation reached a login/redirect route instead of the API; update the instance URL or login route handling before retrying.',
      };
    case 'browser_profile_locked':
      return {
        code,
        category: 'transient',
        authFailure: false,
        retryable: true,
        retryAfterMs: opts.retryAfterMs ?? PROFILE_LOCK_BACKOFF_MS,
        remediation: 'A headless browser profile appears locked or already in use; retry after the backoff window and do not rotate credentials.',
      };
    case 'network_or_vpn_unreachable':
      return {
        code,
        category: 'transient',
        authFailure: false,
        retryable: true,
        retryAfterMs: opts.retryAfterMs ?? 30_000,
        remediation: 'ServiceNow is unreachable or blocked by VPN/proxy/network path; retry after reconnecting network access and do not rotate/delete credentials.',
      };
  }
}

export function classifyServiceNowHttpFailure(stage: 'session_info' | 'api_probe', resp: ServiceNowHttpResponse): ServiceNowSessionFailureClassification | undefined {
  const text = bodyText(resp);
  const url = resp.url ?? '';
  if ([301, 302, 303, 307, 308].includes(resp.status) || looksLikeLoginRoute(url) || (responseContentType(resp).includes('text/html') && looksLikeLoginRoute(text))) {
    return failureClassification('instance_redirect_or_login_route_changed');
  }
  if (resp.ok) return undefined;
  if (resp.status === 407 || resp.status === 408 || resp.status === 429 || resp.status === 511 || resp.status >= 500) {
    return failureClassification('network_or_vpn_unreachable');
  }
  if (resp.status === 401) return failureClassification('api_unauthorized');
  if (resp.status === 403) return failureClassification(looksLikeCsrfFailure(text) ? 'csrf_invalid' : 'api_forbidden');
  if (stage === 'session_info' || resp.status === 404) return failureClassification('session_info_unavailable');
  return undefined;
}

/**
 * Derive the true session lifetime from the captured ServiceNow cookies.
 *
 * ServiceNow gates the REST session on a short-lived session-store cookie
 * (`glide_session_store`, ~60min in production) — once it expires the API returns
 * 401 "User is not authenticated" even though the persistent cookies
 * (`glide_user_route`/`glide_sso_id`, years out) and `JSESSIONID` are still
 * present. Playwright's `cookie.expires` is a unix time in SECONDS (or -1 for a
 * session-only cookie). We take the earliest FINITE `service-now.com` cookie
 * expiry that falls inside the configured upper bound — persistent (years out)
 * and session-only (-1) cookies are not session-death signals, so `min` of the
 * in-window finite expiries naturally selects `glide_session_store`.
 *
 * The refresh margin is capped at 60% of the (possibly-short) real lifetime so
 * `nextRefreshAt` (= expiresAt - refreshMargin) always lands comfortably in the
 * future — a re-acquire fires at ~40% of the session's life, well before the
 * real death, and never degenerates into a tight refresh loop when the cookie
 * lifetime is far shorter than the configured 1h margin.
 */
/** The ServiceNow cookie that gates the REST session (its expiry IS the session death). */
const SESSION_STORE_COOKIE = 'glide_session_store';
/**
 * Storm floor. No single stray cookie may drive the derived lifetime below this,
 * so a short-lived `service-now.com` cookie (a CSRF/analytics/F5 cookie ServiceNow
 * might add) can never push the proactive-refresh cadence into a silent-SSO storm.
 * A too-long lifetime degrades gracefully (401 → container re-pull); a too-short
 * one burns the AD budget and risks MFA — so we bias toward the safe side.
 */
const MIN_DERIVED_LIFETIME_MS = 15 * 60 * 1000;

export function computeServiceNowSessionExpiry(
  now: number,
  cookies: ReadonlyArray<{ name: string; domain: string; expires?: number }>,
  config: { sessionLifetimeMs: number; refreshMarginMs: number },
): { expiresAt: number; effectiveLifetimeMs: number; effectiveRefreshMarginMs: number } {
  const upperBound = now + config.sessionLifetimeMs;
  const snCookies = cookies.filter((c) => /service-now\.com/i.test(c.domain));
  const finiteInWindowMs = (c: { expires?: number }): number | undefined => {
    if (typeof c.expires !== 'number' || c.expires <= 0) return undefined; // -1 = session-only
    const ms = Math.round(c.expires * 1000);
    return ms > now && ms < upperBound ? ms : undefined; // drop persistent (years-out) cookies
  };

  // 1. Prefer the known session-death cookie BY NAME — robust to ServiceNow
  //    adding other short-lived cookies (which `min` would wrongly pick).
  const named = snCookies.find((c) => c.name === SESSION_STORE_COOKIE);
  let rawExpiry = named ? finiteInWindowMs(named) : undefined;

  // 2. Fallback: if the named cookie is absent/renamed, use the earliest finite
  //    in-window SN cookie. Safe-by-construction — a rename yields an over-long
  //    lifetime that degrades to a 401+re-pull, never a storm.
  if (rawExpiry === undefined) {
    const candidates = snCookies
      .map(finiteInWindowMs)
      .filter((ms): ms is number => ms !== undefined);
    rawExpiry = candidates.length ? Math.min(...candidates) : undefined;
  }

  // 3. Storm floor: never derive a lifetime shorter than MIN_DERIVED_LIFETIME_MS.
  const cookieExpiry = rawExpiry !== undefined
    ? Math.max(rawExpiry, now + MIN_DERIVED_LIFETIME_MS)
    : undefined;

  const expiresAt = Math.min(cookieExpiry ?? upperBound, upperBound);
  const effectiveLifetimeMs = Math.max(0, expiresAt - now);
  const effectiveRefreshMarginMs = Math.min(
    config.refreshMarginMs,
    Math.floor(effectiveLifetimeMs * 0.6),
  );
  return { expiresAt, effectiveLifetimeMs, effectiveRefreshMarginMs };
}

export class ServiceNowProvider implements Provider {
  readonly name = 'servicenow';
  readonly schemes = SCHEMES;
  readonly capabilities = SERVICENOW_CAPABILITIES;
  private static readonly inflightAcquire = new Map<string, Promise<TokenBundle>>();
  private static readonly acquireBackoffUntil = new Map<string, number>();

  constructor(private readonly deps: ServiceNowProviderDeps) {}

  private async _captureAndAnnotate(
    page: Parameters<typeof defaultCaptureDebugState>[0]['page'],
    reason: string,
    stepLog: ReadonlyArray<Record<string, unknown>>,
    ctx: ProviderContext,
  ): Promise<string> {
    const config = ServiceNowConfigSchema.parse(ctx.config);
    const serviceKey = `servicenow-${new URL(config.instanceUrl).hostname.split('.')[0]}`;
    const doCapture = this.deps.captureDebugState ?? defaultCaptureDebugState;
    const result = await doCapture({ page, reason, service: serviceKey, baseDir: ctx.dataDir, stepLog });
    ctx.logger.warn('servicenow debug state captured', { captureDir: result.captureDir, reason, service: serviceKey });
    if (result.errors.length > 0) {
      ctx.logger.warn('debug capture partial failure', { captureErrors: result.errors });
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
    const config = ServiceNowConfigSchema.parse(ctx.config);
    let password: string | undefined;
    if (config.passwordKeychainService && config.passwordKeychainAccount) {
      password = (await readKeychainPassword(config.passwordKeychainService, config.passwordKeychainAccount)) ?? undefined;
    }
    // Lazy TOTP: resolve the SEED here, but generate the code at fill time via
    // a supplier — a code generated now is expired by the time the MFA input
    // appears 30-120s into the browser flow.
    let totp: TotpInput | undefined;
    if (config.totpKeychainService && config.totpKeychainAccount) {
      const seed = await readTotpSeedFromKeychain(config.totpKeychainService, config.totpKeychainAccount);
      totp = seed ? makeTotpSupplier(ctx.service, seed) : undefined;
    }
    return { config, password, totp };
  }

  async acquire(ctx: ProviderContext, scheme: string): Promise<TokenBundle> {
    const resolved = await this._resolveCredentials(ctx);
    const key = this.acquireKey(ctx, resolved.config);
    const now = this.deps.now();
    const backoffUntil = ServiceNowProvider.acquireBackoffUntil.get(key) ?? 0;
    if (backoffUntil > now) {
      throw new ServiceNowSessionError(failureClassification('browser_profile_locked', { retryAfterMs: backoffUntil - now }));
    }

    const existing = ServiceNowProvider.inflightAcquire.get(key);
    if (existing) {
      ctx.logger.info('servicenow acquire already in progress; coalescing concurrent request', { service: ctx.service });
      return existing;
    }

    const promise = this._acquireResolved(ctx, scheme, resolved)
      .catch((err) => {
        if (err instanceof ServiceNowSessionError && err.code === 'browser_profile_locked') {
          ServiceNowProvider.acquireBackoffUntil.set(key, this.deps.now() + (err.retryAfterMs ?? PROFILE_LOCK_BACKOFF_MS));
        } else if (err instanceof Error && /browser profile.*lock|profile.*in use|singletonlock|parent\.lock|\bELOCKED\b/i.test(err.message)) {
          ServiceNowProvider.acquireBackoffUntil.set(key, this.deps.now() + PROFILE_LOCK_BACKOFF_MS);
          throw new ServiceNowSessionError(failureClassification('browser_profile_locked'), err.message);
        }
        throw err;
      })
      .finally(() => {
        ServiceNowProvider.inflightAcquire.delete(key);
      });
    ServiceNowProvider.inflightAcquire.set(key, promise);
    return promise;
  }

  private acquireKey(ctx: ProviderContext, config: ServiceNowConfig): string {
    return `${path.resolve(ctx.dataDir)}:${ctx.service}:${new URL(config.instanceUrl).hostname}`;
  }

  private async _acquireResolved(
    ctx: ProviderContext,
    _scheme: string,
    resolved: { config: ServiceNowConfig; password?: string; totp?: TotpInput },
  ): Promise<TokenBundle> {
    if (this.deps.acquireSession) return this.deps.acquireSession(ctx, 'session', resolved);

    const { config, password, totp } = resolved;
    const targetHost = new URL(config.instanceUrl).hostname;
    const profileDir = path.join(ctx.dataDir, 'servicenow', 'profile');
    await fs.mkdir(profileDir, { recursive: true });

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
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        ignoreHTTPSErrors: true,
        ...(storedSession ? { storageState: storedSession } : {}),
      });
      try {
      const page = await context.newPage();

      ctx.logger.info('navigating to ServiceNow', { url: config.instanceUrl });
      await page.goto(config.instanceUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForTimeout(3000);

      const serviceKey = `servicenow-${new URL(config.instanceUrl).hostname.split('.')[0]}`;
      const loopResult = await runSsoLoop(page as unknown as SsoPage, {
        service: serviceKey,
        baseDir: ctx.dataDir,
        loginHint: config.loginHint,
        password,
        totp,
        selectors: {
          email: EMAIL_SELECTORS,
          password: PW_SELECTORS,
          totp: TOTP_SELECTORS,
          submit: SUBMIT_SELECTORS,
          consent: CONSENT_SELECTORS,
          mfaVerify: MFA_VERIFY_SELECTORS,
        },
        maxSteps: 25,
        deadline: Date.now() + config.authTimeoutMs,
        logger: ctx.logger,
        captureDebugState: this.deps.captureDebugState,
        shouldExit: (p) => {
          const url = p.url();
          return url.includes(targetHost) && !url.includes('login.microsoftonline.com');
        },
        onConditionalAccess: async (p, stepLog) => {
          await this._throwIfClassifiedChallenge(
            p as unknown as Parameters<typeof classifyConditionalAccessPage>[0],
            ctx,
            totp,
            false,
            stepLog,
          );
        },
      });

      ctx.logger.info('SSO loop complete', {
        exitReason: loopResult.exitReason,
        exitedAtStep: loopResult.exitedAtStep,
        stallCapture: loopResult.stallCapture?.captureDir,
      });

      const stepLog = loopResult.stepLog;

      // Ensure we're on ServiceNow
      let captureDir: string | undefined;
      if (!page.url().includes(targetHost)) {
        // Capture the stuck state BEFORE attempting recovery so the screenshot shows
        // the actual stuck page, not the freshly-reloaded ServiceNow page.
        captureDir = await this._captureAndAnnotate(page, 'sso_did_not_land_on_servicenow', stepLog, ctx);
        await page.goto(config.instanceUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page.waitForTimeout(5000);
      }
      if (!page.url().includes(targetHost) || page.url().includes('login.microsoftonline.com') || page.url().includes('login.microsoft.com')) {
        await this._throwIfClassifiedChallenge(page, ctx, totp, true, stepLog);
        // captureDir is already set from the prior block; if for some reason it isn't, capture now
        if (!captureDir) {
          captureDir = await this._captureAndAnnotate(page, 'sso_did_not_land_on_servicenow', stepLog, ctx);
        }
        throw new ServiceNowSessionError(failureClassification('instance_redirect_or_login_route_changed'), `SSO did not land on ServiceNow; final URL: ${page.url().substring(0, 120)} [debug capture: ${captureDir}]`);
      }

      // Get g_ck token — try page JavaScript context first, then session_info API.
      // ServiceNow REST APIs require X-UserToken (g_ck) for CSRF protection,
      // including session_info itself, so we extract it from the page context
      // where ServiceNow sets it as a global variable after SSO.
      let gCk = '';
      let sessionInfoStatus: number | undefined;
      let sessionInfoCapturedAt: number | undefined;

      // Try main frame and child frames for g_ck global
      try {
        gCk = await page.evaluate(() => (globalThis as Record<string, unknown>).g_ck as string || '');
      } catch { /* evaluate failed */ }
      if (!gCk) {
        for (const frame of page.frames()) {
          try {
            gCk = await frame.evaluate(() => (globalThis as Record<string, unknown>).g_ck as string || '');
            if (gCk) break;
          } catch { /* cross-origin */ }
        }
      }

      // Call session_info with X-UserToken to activate the REST API session
      // and validate the g_ck. Falls back to x-usertoken-response header if
      // the page context g_ck is not available.
      try {
        const tokenForRequest = gCk;
        const sessionInfo = await page.evaluate(async (token: string) => {
          const headers: Record<string, string> = { Accept: 'application/json' };
          if (token) headers['X-UserToken'] = token;
          const r = await fetch('/api/now/ui/user/session_info', {
            credentials: 'same-origin',
            headers,
          });
          return {
            ok: r.ok,
            status: r.status,
            body: await r.text().catch(() => ''),
            userTokenResponse: r.headers.get('x-usertoken-response') ?? '',
          };
        }, tokenForRequest);
        sessionInfoStatus = sessionInfo.status;
        sessionInfoCapturedAt = this.deps.now();

        if (sessionInfo.ok) {
          const bodyGck = extractGck(sessionInfo.body);
          if (bodyGck) gCk = bodyGck;
        } else if (sessionInfo.status === 401 && sessionInfo.userTokenResponse && !tokenForRequest) {
          // Retry with the token from the 401 response header
          ctx.logger.info('session_info returned 401 with x-usertoken-response, retrying');
          gCk = sessionInfo.userTokenResponse;
          const retry = await page.evaluate(async (token: string) => {
            const r = await fetch('/api/now/ui/user/session_info', {
              credentials: 'same-origin',
              headers: { Accept: 'application/json', 'X-UserToken': token },
            });
            return { ok: r.ok, status: r.status, body: await r.text().catch(() => '') };
          }, gCk);
          sessionInfoStatus = retry.status;
          sessionInfoCapturedAt = this.deps.now();
          if (retry.ok) {
            const bodyGck = extractGck(retry.body);
            if (bodyGck) gCk = bodyGck;
          } else {
            const classification = classifyServiceNowHttpFailure('session_info', retry);
            if (classification) {
              const captureDir = await this._captureAndAnnotate(page, 'session_info_failed', stepLog, ctx);
              throw new ServiceNowSessionError(classification, `ServiceNow session_info retry failed with HTTP ${retry.status} [debug capture: ${captureDir}]`);
            }
          }
        } else if (!sessionInfo.ok) {
          const classification = classifyServiceNowHttpFailure('session_info', sessionInfo);
          if (classification) {
            const captureDir = await this._captureAndAnnotate(page, 'session_info_failed', stepLog, ctx);
            throw new ServiceNowSessionError(classification, `ServiceNow session_info failed with HTTP ${sessionInfo.status} [debug capture: ${captureDir}]`);
          }
        }
      } catch (e) {
        if (e instanceof ServiceNowSessionError) throw e;
        ctx.logger.warn('could not get g_ck from session_info', { error: (e as Error).message });
      }

      if (!gCk) {
        const captureDir = await this._captureAndAnnotate(page, 'missing_g_ck', stepLog, ctx);
        throw new ServiceNowSessionError(failureClassification('missing_or_invalid_g_ck'), `missing_or_invalid_g_ck: The ServiceNow session is missing a usable g_ck/X-UserToken CSRF token; re-acquire the cookie session instead of rotating stored credentials. [debug capture: ${captureDir}]`);
      }

      // Make a REST call to ensure API session is active and the g_ck token works.
      const apiProbe = await page.evaluate(async (token: string) => {
        const r = await fetch('/api/now/table/sys_user?sysparm_limit=1&sysparm_fields=sys_id', {
          credentials: 'same-origin',
          headers: { Accept: 'application/json', 'X-UserToken': token },
        });
        return { ok: r.ok, status: r.status, body: await r.text().catch(() => ''), url: r.url };
      }, gCk).catch((err: unknown) => {
        throw new ServiceNowSessionError(failureClassification(looksLikeNetworkFailure(err) ? 'network_or_vpn_unreachable' : 'session_info_unavailable'), (err as Error).message);
      });
      const apiClassification = classifyServiceNowHttpFailure('api_probe', apiProbe);
      if (apiClassification) throw new ServiceNowSessionError(apiClassification, `ServiceNow API probe failed with HTTP ${apiProbe.status}`);

      // Capture cookies
      const allCookies = await context.cookies();
      const snCookies = allCookies.filter((c: { domain: string }) =>
        c.domain.includes(targetHost) ||
        c.domain.includes('service-now.com') ||
        c.domain.includes('microsoftonline.com'),
      );

      const cookieHeader = snCookies.map((c: { name: string; value: string }) => `${c.name}=${c.value}`).join('; ');
      const now = this.deps.now();
      const cookieNames = snCookies.map((c: { name: string }) => c.name);

      ctx.logger.info('ServiceNow auth captured', { cookieCount: snCookies.length, hasGck: !!gCk, sessionInfoStatus });

      // Pin the bundle lifetime to the REAL ServiceNow session death, not a
      // static 4h guess. ServiceNow issues a short-lived session-store cookie
      // (`glide_session_store`, ~60min in production) that gates the REST session:
      // once it expires ServiceNow returns 401 "User is not authenticated"
      // even though the long-lived cookies (glide_user_route/glide_sso_id,
      // 2027) and JSESSIONID are still present. Serving a bundle for 4h when
      // the underlying session dies in ~60min means /token hands consumers a
      // dead cookie for most of every cycle. Derive the true expiry from the
      // captured cookies so the bundle expires exactly when ServiceNow kills
      // the session, and the proactive-refresh schedule (nextRefreshAt =
      // expiresAt - refreshMargin) re-acquires with a healthy lead before it.
      const { expiresAt, effectiveLifetimeMs, effectiveRefreshMarginMs } =
        computeServiceNowSessionExpiry(now, snCookies, config);

      const sessionState = await context.storageState().catch(() => undefined);
      if (sessionState) await saveSessionState(ctx.service, sessionState, ctx.logger);

      ctx.logger.info('ServiceNow session lifetime derived from cookies', {
        effectiveLifetimeMinutes: Math.round(effectiveLifetimeMs / 60_000),
        refreshInMinutes: Math.round((effectiveLifetimeMs - effectiveRefreshMarginMs) / 60_000),
        cookieDerived: effectiveLifetimeMs < config.sessionLifetimeMs,
      });

      return {
        service: 'servicenow',
        scheme: 'session',
        accessToken: cookieHeader,
        tokenType: 'Cookie',
        expiresAt,
        acquiredAt: now,
        extra: {
          g_ck: gCk,
          gCkCapturedAt: sessionInfoCapturedAt ?? now,
          cookies: snCookies,
          cookieNames,
          cookieCount: snCookies.length,
          instanceUrl: config.instanceUrl,
          targetHost,
          sessionInfoStatus,
          sessionLifetimeMs: effectiveLifetimeMs,
          refreshMarginMs: effectiveRefreshMarginMs,
          conservativeRefreshAfterMs: effectiveLifetimeMs - effectiveRefreshMarginMs,
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
    // ServiceNow cookie sessions cannot be silently refreshed.
    // Full re-acquire is required; acquire() coalesces concurrent refresh/reacquire calls.
    return this.acquire(ctx, 'session');
  }

  async validate(ctx: ProviderContext, bundle: TokenBundle): Promise<boolean> {
    const config = ServiceNowConfigSchema.parse(ctx.config);
    const classification = this.preflightBundleClassification(bundle, config);
    if (classification) {
      this.logValidationClassification(ctx, classification, 'preflight');
      return false;
    }

    const gCk = (bundle.extra as Record<string, unknown> | undefined)?.g_ck;
    const headers: Record<string, string> = {
      Cookie: bundle.accessToken,
      Accept: 'application/json',
      'X-UserToken': String(gCk),
    };

    const doFetch = this.deps.httpFetch ?? (async (url: string, init: { headers: Record<string, string> }) => {
      const r = await globalThis.fetch(url, init);
      return { ok: r.ok, status: r.status, url: r.url, headers: normalizeHeaders(r.headers), body: await r.text().catch(() => '') };
    });

    try {
      const sessionInfo = await doFetch(serviceNowUrl(config.instanceUrl, '/api/now/ui/user/session_info'), {
        headers: { Cookie: bundle.accessToken, Accept: 'application/json' },
      });
      const sessionInfoClassification = classifyServiceNowHttpFailure('session_info', sessionInfo);
      if (sessionInfoClassification) return this.validationResult(ctx, sessionInfoClassification, 'session_info');
      const liveGck = extractGck(bodyText(sessionInfo));
      if (!liveGck) return this.validationResult(ctx, failureClassification('session_info_unavailable'), 'session_info');
      if (liveGck !== gCk) return this.validationResult(ctx, failureClassification('missing_or_invalid_g_ck'), 'session_info');

      const resp = await doFetch(
        serviceNowUrl(config.instanceUrl, '/api/now/table/sys_user?sysparm_limit=1&sysparm_fields=sys_id'),
        { headers },
      );
      const apiClassification = classifyServiceNowHttpFailure('api_probe', resp);
      if (apiClassification) return this.validationResult(ctx, apiClassification, 'api_probe');
      return resp.ok;
    } catch (err) {
      const network = failureClassification('network_or_vpn_unreachable');
      this.logValidationClassification(ctx, network, 'network', { error: (err as Error).message });
      throw new ServiceNowSessionError(network, (err as Error).message);
    }
  }

  private preflightBundleClassification(bundle: TokenBundle, config: ServiceNowConfig): ServiceNowSessionFailureClassification | undefined {
    const now = this.deps.now();
    const ageMs = Math.max(0, now - bundle.acquiredAt);
    const lifetimeMs = numberExtra(bundle, 'sessionLifetimeMs') ?? config.sessionLifetimeMs ?? DEFAULT_SESSION_LIFETIME_MS;
    const refreshMarginMs = numberExtra(bundle, 'refreshMarginMs') ?? config.refreshMarginMs ?? DEFAULT_REFRESH_MARGIN_MS;
    if (!bundle.accessToken || bundle.expiresAt <= now || ageMs >= Math.max(0, lifetimeMs - refreshMarginMs)) {
      return failureClassification('cookie_expired');
    }
    const gCk = (bundle.extra as Record<string, unknown> | undefined)?.g_ck;
    if (typeof gCk !== 'string' || !gCk.trim()) return failureClassification('missing_or_invalid_g_ck');
    return undefined;
  }

  private validationResult(ctx: ProviderContext, classification: ServiceNowSessionFailureClassification, stage: string): boolean {
    this.logValidationClassification(ctx, classification, stage);
    if (!classification.authFailure) throw new ServiceNowSessionError(classification);
    return !classification.authFailure;
  }

  private logValidationClassification(ctx: ProviderContext, classification: ServiceNowSessionFailureClassification, stage: string, extra: Record<string, unknown> = {}): void {
    const fields = { service: ctx.service, stage, code: classification.code, category: classification.category, retryable: classification.retryable, ...extra };
    if (classification.authFailure) {
      ctx.logger.info('servicenow validate classified auth/session failure', fields);
    } else {
      ctx.logger.warn('servicenow validate classified transient network/service failure', fields);
    }
  }

  nextRefreshAt(bundle: TokenBundle): Date {
    const refreshMarginMs = numberExtra(bundle, 'refreshMarginMs') ?? DEFAULT_REFRESH_MARGIN_MS;
    return new Date(bundle.expiresAt - refreshMarginMs);
  }
}

function numberExtra(bundle: TokenBundle, key: string): number | undefined {
  const value = (bundle.extra as Record<string, unknown> | undefined)?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
