import type { Provider, ProviderCapabilities, ProviderContext, TokenBundle } from '@hermes/broker';
import {
  ConditionalAccessChallengeError,
  classifyConditionalAccessPage,
  readKeychainPassword,
  readTotpSeedFromKeychain,
  makeTotpSupplier,
  captureDebugState as defaultCaptureDebugState,
  runSsoLoop,
  withManagedBrowser,
  loadSessionState,
  saveSessionState,
  invalidateSessionState,
  type TotpInput,
  type CaptureDebugStateOptions,
  type CaptureDebugStateResult,
} from '@hermes/auth-core';
import { DynatraceConfigSchema, SCHEMES, appsUrl, liveUrl } from './config.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';

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

/** Dynatrace SSO session cookies last ~4 hours. Refresh at 3.5h. */
const SESSION_LIFETIME_MS = 4 * 60 * 60 * 1000;
const REFRESH_MARGIN_MS = 30 * 60 * 1000;

/** API tokens don't expire unless revoked; re-validate in 24h. */
const API_TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000;

const DYNATRACE_CAPABILITIES: ProviderCapabilities = {
  headless: true,
  schemes: [
    {
      scheme: 'session',
      credentialSource: 'cookie-session',
      refreshStrategy: 'reacquire',
      supportsRefresh: true,
      supportsValidation: true,
      validationStrategy: 'service-probe',
    },
    {
      scheme: 'api-token',
      credentialSource: 'api-token',
      refreshStrategy: 'reacquire',
      supportsRefresh: true,
      supportsValidation: true,
      validationStrategy: 'http',
    },
  ],
  remediation: {
    acquire: 'For session, run hermes acquire dynatrace; for api-token, seed apiToken in the service config from Dynatrace token management.',
    refresh: 'Session refresh is a headless re-acquire; api-token refresh re-reads configured apiToken and cannot fix a revoked token.',
    validate: '401/403 means the session or apiToken is invalid; 5xx/network should be treated as service reachability before rotating credentials.',
  },
};

export interface DynatraceProviderDeps {
  now: () => number;
  httpFetch?: (url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean; status: number }>;
  captureDebugState?: (opts: CaptureDebugStateOptions) => Promise<CaptureDebugStateResult>;
}

export class DynatraceProvider implements Provider {
  readonly name = 'dynatrace';
  readonly schemes = SCHEMES;
  readonly capabilities = DYNATRACE_CAPABILITIES;

  constructor(private readonly deps: DynatraceProviderDeps) {}

  private async _captureAndAnnotate(
    page: Parameters<typeof defaultCaptureDebugState>[0]['page'],
    reason: string,
    stepLog: ReadonlyArray<Record<string, unknown>>,
    ctx: ProviderContext,
  ): Promise<string> {
    const config = DynatraceConfigSchema.parse(ctx.config);
    const serviceKey = `dynatrace-${config.environmentId}`;
    const doCapture = this.deps.captureDebugState ?? defaultCaptureDebugState;
    const result = await doCapture({ page, reason, service: serviceKey, baseDir: ctx.dataDir, stepLog });
    ctx.logger.warn('dynatrace debug state captured', { captureDir: result.captureDir, reason, service: serviceKey });
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
    const config = DynatraceConfigSchema.parse(ctx.config);
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

  async acquire(ctx: ProviderContext, scheme: string): Promise<TokenBundle> {
    const config = DynatraceConfigSchema.parse(ctx.config);

    if (scheme === 'api-token') {
      return this._acquireApiToken(ctx, config.apiToken);
    }
    if (scheme !== 'session') {
      throw new Error(`unsupported dynatrace scheme "${scheme}". Remediation: use one of ${SCHEMES.join(', ')}.`);
    }
    return this._acquireSession(ctx);
  }

  private _acquireApiToken(ctx: ProviderContext, apiToken: string | undefined): TokenBundle {
    if (!apiToken) {
      throw new Error('apiToken is required for api-token scheme. Remediation: add a Dynatrace API token to service config.');
    }
    const config = DynatraceConfigSchema.parse(ctx.config);
    const now = this.deps.now();
    return {
      service: 'dynatrace',
      scheme: 'api-token',
      accessToken: apiToken,
      tokenType: 'Api-Token',
      expiresAt: now + API_TOKEN_LIFETIME_MS,
      acquiredAt: now,
      extra: {
        environmentId: config.environmentId,
        appsUrl: appsUrl(config.environmentId),
        liveUrl: liveUrl(config.environmentId),
      },
    };
  }

  private async _acquireSession(ctx: ProviderContext): Promise<TokenBundle> {
    const { config, password, totp } = await this._resolveCredentials(ctx);
    const envAppsUrl = appsUrl(config.environmentId);
    const envLiveUrl = liveUrl(config.environmentId);
    const profileDir = path.join(ctx.dataDir, 'dynatrace', 'profile');
    await fs.mkdir(profileDir, { recursive: true });

    let csrfToken: string | null = null;

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

      // Intercept X-CSRFToken for live.dynatrace.com (classic REST API)
      page.on('request', (req) => {
        const url = req.url();
        const headers = req.headers();
        if (url.includes('live.dynatrace.com') && headers['x-csrftoken']) {
          csrfToken = headers['x-csrftoken'];
        }
      });

      // Step 1: Navigate to apps.dynatrace.com -- triggers SSO
      ctx.logger.info('navigating to Dynatrace apps', { url: envAppsUrl });
      await page.goto(`${envAppsUrl}/ui/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForTimeout(3000);

      // SSO loop: handles sso.dynatrace.com → login.microsoftonline.com → apps.dynatrace.com
      // EMAIL_SELECTORS covers both the sso.dynatrace.com email form and the Microsoft loginfmt.
      // Behavioral note: waitForNavigation replaced by waitForTimeout(2000) per runSsoLoop contract.
      const serviceKey = `dynatrace-${config.environmentId}`;
      const loopResult = await runSsoLoop(page, {
        service: serviceKey,
        baseDir: ctx.dataDir,
        loginHint: config.loginHint ?? '',
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
          return url.includes('apps.dynatrace.com')
            && !url.includes('login.microsoftonline.com')
            && !url.includes('sso.dynatrace.com');
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

      // Verify we landed on Dynatrace apps
      if (!page.url().includes('apps.dynatrace.com')) {
        const captureDir = await this._captureAndAnnotate(
          page,
          'dynatrace_did_not_land',
          loopResult.stepLog,
          ctx,
        );
        throw new Error(`SSO did not land on Dynatrace apps; final URL: ${page.url().substring(0, 120)} [debug capture: ${captureDir}]`);
      }

      // Step 2: Navigate to classic services to trigger live.dynatrace.com session + CSRF
      ctx.logger.info('loading classic services app for live session + CSRF');
      await page.goto(
        `${envAppsUrl}/ui/apps/dynatrace.classic.services/#mainservice`,
        { waitUntil: 'domcontentloaded', timeout: 60_000 },
      );
      await page.waitForTimeout(10_000);

      // Step 3: Visit live.dynatrace.com directly to ensure cookies are set
      ctx.logger.info('visiting live.dynatrace.com directly');
      await page.goto(`${envLiveUrl}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForTimeout(5000);

      // Step 4: Retry classic if CSRF wasn't captured
      if (!csrfToken) {
        ctx.logger.debug('retrying classic services for CSRF capture');
        await page.goto(
          `${envAppsUrl}/ui/apps/dynatrace.classic.services/#mainservice`,
          { waitUntil: 'domcontentloaded', timeout: 60_000 },
        );
        await page.waitForTimeout(10_000);
      }

      // Capture cookies from both API surfaces
      const allCookies = await context.cookies();
      const dtCookies = allCookies.filter((c: { domain: string }) =>
        c.domain.includes('dynatrace') || c.domain.includes('microsoftonline'),
      );
      const appsCookies = dtCookies.filter((c: { domain: string }) => c.domain.includes('apps.dynatrace'));
      const liveCookies = dtCookies.filter((c: { domain: string }) => c.domain.includes('live.dynatrace'));

      const appsCookieHeader = appsCookies.map((c: { name: string; value: string }) => `${c.name}=${c.value}`).join('; ');
      const liveCookieHeader = liveCookies.map((c: { name: string; value: string }) => `${c.name}=${c.value}`).join('; ');
      const xsrfToken = appsCookies.find((c: { name: string }) => c.name === '__Host-XSRF-TOKEN')?.value || '';

      // CSRF token is required for classic API calls; absence after both attempts is a terminal failure.
      if (!csrfToken) {
        const captureDir = await this._captureAndAnnotate(
          page,
          'dynatrace_no_csrf_token',
          loopResult.stepLog,
          ctx,
        );
        throw new Error(`Dynatrace CSRF token was not captured after classic services navigation; re-acquire required. [debug capture: ${captureDir}]`);
      }

      const now = this.deps.now();

      ctx.logger.info('Dynatrace auth captured', {
        totalCookies: dtCookies.length,
        appsCookies: appsCookies.length,
        liveCookies: liveCookies.length,
        hasCsrf: !!csrfToken,
        hasXsrf: !!xsrfToken,
      });

      const sessionState = await context.storageState().catch(() => undefined);
      if (sessionState) await saveSessionState(ctx.service, sessionState, ctx.logger);

      return {
        service: 'dynatrace',
        scheme: 'session',
        accessToken: appsCookieHeader,
        tokenType: 'Cookie',
        expiresAt: now + SESSION_LIFETIME_MS,
        acquiredAt: now,
        extra: {
          environmentId: config.environmentId,
          appsUrl: envAppsUrl,
          liveUrl: envLiveUrl,
          appsCookieHeader,
          liveCookieHeader,
          xsrfToken,
          csrfToken: csrfToken ?? '',
          cookies: dtCookies.map((c: { name: string; value: string; domain: string; path: string; secure: boolean; httpOnly: boolean }) => ({
            name: c.name, value: c.value, domain: c.domain, path: c.path,
            secure: c.secure, httpOnly: c.httpOnly,
          })),
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

  async refresh(ctx: ProviderContext, bundle: TokenBundle): Promise<TokenBundle> {
    // SSO sessions cannot be silently refreshed -- full re-acquire required.
    return this.acquire(ctx, bundle.scheme);
  }

  async validate(ctx: ProviderContext, bundle: TokenBundle): Promise<boolean> {
    const config = DynatraceConfigSchema.parse(ctx.config);
    const envAppsUrl = appsUrl(config.environmentId);

    const doFetch = this.deps.httpFetch ?? (async (url: string, init: { headers: Record<string, string> }) => {
      const r = await globalThis.fetch(url, init);
      return { ok: r.ok, status: r.status };
    });

    if (bundle.scheme === 'api-token') {
      try {
        const resp = await doFetch(
          `${envAppsUrl}/platform/classic/environment-api/v2/entities?pageSize=1&entitySelector=type("SERVICE")`,
          { headers: { Authorization: `Api-Token ${bundle.accessToken}`, Accept: 'application/json' } },
        );
        if (resp.status === 401 || resp.status === 403) return false;
        return resp.ok || resp.status >= 500;
      } catch (err) {
        ctx.logger.warn('dynatrace api-token validate network error — assuming token usable', { error: (err as Error).message });
        return true;
      }
    }

    // Session scheme: validate using apps API with cookie + XSRF
    const headers: Record<string, string> = {
      Cookie: bundle.accessToken,
      Accept: 'application/json',
    };
    const extra = bundle.extra as Record<string, unknown> | undefined;
    const xsrf = extra?.xsrfToken;
    if (typeof xsrf === 'string' && xsrf) {
      headers['X-XSRF-TOKEN'] = xsrf;
    }

    try {
      const resp = await doFetch(
        `${envAppsUrl}/platform/classic/environment-api/v2/entities?pageSize=1&entitySelector=type("SERVICE")`,
        { headers },
      );
      return resp.ok;
    } catch (err) {
      ctx.logger.warn('dynatrace session validate failed', { error: (err as Error).message });
      return false;
    }
  }

  nextRefreshAt(bundle: TokenBundle): Date {
    if (bundle.scheme === 'api-token') {
      return new Date(bundle.expiresAt - 60 * 60 * 1000);
    }
    return new Date(bundle.expiresAt - REFRESH_MARGIN_MS);
  }
}
