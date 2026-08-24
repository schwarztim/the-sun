import type { Provider, ProviderCapabilities, ProviderContext, TokenBundle } from '@hermes/broker';
import { trySelector, readKeychainPassword, readTotpSeedFromKeychain, makeTotpSupplier, resolveTotp, TotpRejectedError, browserRegistry, forceCloseBrowser, BrowserAuthTimeoutError, snapshotPlaywrightChildPids, diffNewPlaywrightChildPid, loadSessionState, saveSessionState, invalidateSessionState, type TotpInput } from '@hermes/auth-core';
import { CrowdStrikeConfigSchema, SCHEMES } from './config.js';
import { startProxyServer, type ProxyHandle } from './proxy-server.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PW = typeof import('patchright');

const SELECTORS = {
  emailInput: ['input[type="email"]', 'input[name="loginfmt"]', '#i0116'],
  passwordInput: ['#passwordInput', 'input[name="passwd"]:not(.moveOffScreen)', 'input[type="password"]:visible', '#i0118'],
  submitButton: ['input[type="submit"]', '#idSIButton9', 'button[type="submit"]'],
  mfaCodeInput: ['input[name="otc"]', '#idTxtBx_SAOTCC_OTC'],
  mfaVerifyButton: ['#idSubmit_SAOTCC_Continue', 'input[type="submit"][value="Verify"]'],
  staySignedIn: ['#idBtn_Back', '#idSIButton9'],
};

/** Far-future: proxy self-maintains session via keepalive. */
const PROXY_LIFETIME_MS = 24 * 60 * 60 * 1000;

export interface CrowdStrikeProviderDeps {
  now: () => number;
  httpFetch?: (url: string) => Promise<{ ok: boolean; status: number }>;
}

const CROWDSTRIKE_CAPABILITIES: ProviderCapabilities = {
  headless: true,
  schemes: [{
    scheme: 'browser-proxy',
    credentialSource: 'browser-proxy',
    refreshStrategy: 'self-maintained',
    supportsRefresh: true,
    supportsValidation: true,
    validationStrategy: 'proxy-health',
  }],
  remediation: {
    acquire: 'Run hermes acquire crowdstrike after confirming falconUrl, loginHint, and keychain-backed credentials.',
    refresh: 'The browser proxy self-maintains via keepalive; if health fails, dispose and run hermes acquire crowdstrike.',
    validate: 'Proxy health failure means the local browser/proxy is unavailable and should be re-acquired, not token-rotated.',
  },
};

export class CrowdStrikeProvider implements Provider {
  readonly name = 'crowdstrike';
  readonly schemes = SCHEMES;
  readonly capabilities = CROWDSTRIKE_CAPABILITIES;

  private proxy: ProxyHandle | null = null;
  private browser: import('patchright').Browser | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private unregisterBrowser: (() => void) | null = null;
  private browserPid: number | undefined;

  constructor(private readonly deps: CrowdStrikeProviderDeps) {}

  private async _resolveCredentials(ctx: ProviderContext) {
    const config = CrowdStrikeConfigSchema.parse(ctx.config);
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
    // Clean up any previous session
    await this.dispose();

    const { config, password, totp } = await this._resolveCredentials(ctx);

    const pw: PW = await import('patchright');
    const pidsBefore = snapshotPlaywrightChildPids();
    this.browser = await pw.firefox.launch({
      headless: config.headless,
      timeout: 30_000,
      firefoxUserPrefs: {
        'security.default_personal_cert': 'Select Automatically',
        'security.certerrors.permanentOverride': true,
      },
    });
    this.browserPid = diffNewPlaywrightChildPid(pidsBefore);
    // Persistent browser: outlives acquire() to back the proxy + keepalive.
    // Registered so shutdown killAll() can reap it; the age-based reaper skips it.
    this.unregisterBrowser = browserRegistry.register(this.browser, {
      service: ctx.service,
      persistent: true,
      pid: this.browserPid,
    });

    const storedSession = await loadSessionState(ctx.service, ctx.logger);
    const context = await this.browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:147.0) Gecko/20100101 Firefox/147.0',
      ignoreHTTPSErrors: true,
      ...(storedSession ? { storageState: storedSession } : {}),
    });
    const page = await context.newPage();

    // CRITICAL: Capture CSRF from the SPA's own API requests via interception.
    // Never call /api2/auth/csrf directly -- it invalidates the session.
    let csrfToken = '';
    // addInitScript runs in browser context; use string form to avoid TS DOM type issues.
    await page.addInitScript(`
      (() => {
        const origFetch = globalThis.fetch;
        globalThis.__csrfToken = '';
        globalThis.fetch = async function (...args) {
          const resp = await origFetch.apply(this, args);
          const csrf = resp.headers.get('x-csrf-token') || resp.headers.get('x-csrftoken');
          if (csrf) globalThis.__csrfToken = csrf;
          return resp;
        };
      })();
    `);

    ctx.logger.info('navigating to CrowdStrike Falcon', { url: config.falconUrl });

    // Bound ONLY the acquire (SSO) phase — the browser itself is persistent and
    // intentionally outlives acquire() for the proxy + keepalive. A hung SSO page
    // must not park the browser forever: on timeout, dispose and surface a
    // retryable BrowserAuthTimeoutError.
    const authLimitMs = config.authTimeoutMs + 60_000;
    let totpSubmits = 0;
    const authPhase = (async () => {
      await page.goto(config.falconUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });

      const deadline = Date.now() + config.authTimeoutMs;
      while (Date.now() < deadline) {
      const url = page.url();

      // Azure AD SSO flow
      if (url.includes('login.microsoftonline.com') || url.includes('login.microsoft.com')) {
        ctx.logger.debug('on SSO login page');
        await page.waitForTimeout(1500);

        if (await trySelector(page, SELECTORS.emailInput, 'fill', config.loginHint)) {
          await trySelector(page, SELECTORS.submitButton, 'click');
          await page.waitForTimeout(2000);
        }

        if (password) {
          if (await trySelector(page, SELECTORS.passwordInput, 'fill', password)) {
            await trySelector(page, SELECTORS.submitButton, 'click');
            await page.waitForTimeout(3000);
          }
        }

        // MFA / TOTP — code resolved at fill time (lazy supplier). Initial
        // submit + one regenerated retry max; a third sighting of the MFA
        // input means both codes were rejected (lockout risk — abort).
        const mfaVis = await page.locator('#idTxtBx_SAOTCC_OTC, input[name="otc"]').isVisible({ timeout: 2000 }).catch(() => false);
        if (mfaVis && totp) {
          if (totpSubmits >= 2) throw new TotpRejectedError();
          const code = await resolveTotp(totp);
          if (code && await trySelector(page, SELECTORS.mfaCodeInput, 'fill', code)) {
            totpSubmits += 1;
            await trySelector(page, SELECTORS.mfaVerifyButton, 'click');
            await page.waitForTimeout(3000);
          }
        }

        await trySelector(page, SELECTORS.staySignedIn, 'click');
        await page.waitForTimeout(1000);
      }

      // Check if we reached Falcon dashboard
      if (url.includes('falcon.') && !url.includes('/login') && !url.includes('/oauth') &&
          !url.includes('login.microsoftonline.com') && !url.includes('login.microsoft.com')) {
        ctx.logger.info('CrowdStrike Falcon loaded, waiting for session init');
        await page.waitForTimeout(5000);
        break;
      }

      await page.waitForTimeout(1000);
      }

      // Grab CSRF token from intercepted requests
      csrfToken = await page.evaluate('globalThis.__csrfToken || ""').catch(() => '') as string;
      ctx.logger.info('CSRF token captured', { hasCsrf: !!csrfToken });
    })();

    let authTimer: ReturnType<typeof setTimeout> | undefined;
    const authTimeout = new Promise<'timeout'>((resolve) => { authTimer = setTimeout(() => resolve('timeout'), authLimitMs); });
    const authOutcome = await Promise.race([
      authPhase.then(() => 'done' as const, (err: unknown) => ({ err })),
      authTimeout,
    ]);
    if (authTimer) clearTimeout(authTimer);
    if (authOutcome === 'timeout') {
      // The auth phase may still settle after dispose — suppress unhandled rejection.
      void authPhase.catch(() => {});
      ctx.logger.warn('crowdstrike SSO phase exceeded lifetime ceiling; disposing browser', { limitMs: authLimitMs });
      await invalidateSessionState(ctx.service, ctx.logger);
      await this.dispose();
      throw new BrowserAuthTimeoutError(ctx.service, authLimitMs, 'auth');
    }
    if (authOutcome !== 'done') {
      // Stale/revoked SSO state must not be retried.
      await invalidateSessionState(ctx.service, ctx.logger);
      throw authOutcome.err;
    }

    const sessionState = await context.storageState().catch(() => undefined);
    if (sessionState) await saveSessionState(ctx.service, sessionState, ctx.logger);

    // Start the proxy server
    this.proxy = await startProxyServer(page, config.proxyPort);
    ctx.logger.info('proxy server started', { port: this.proxy.port, url: this.proxy.url });

    // Start keepalive interval
    this.keepaliveTimer = setInterval(async () => {
      try {
        await page.evaluate(() => fetch('/api2/status', { credentials: 'same-origin' }).catch(() => {}));
      } catch { /* browser may have closed */ }
    }, config.keepaliveIntervalMs);

    const now = this.deps.now();
    return {
      service: 'crowdstrike',
      scheme: 'browser-proxy',
      accessToken: this.proxy.url,
      tokenType: 'ProxyURL',
      expiresAt: now + PROXY_LIFETIME_MS,
      acquiredAt: now,
      extra: {
        proxyPort: this.proxy.port,
        proxyUrl: this.proxy.url,
        csrfToken,
        falconUrl: config.falconUrl,
      },
    };
  }

  async refresh(ctx: ProviderContext, bundle: TokenBundle): Promise<TokenBundle> {
    // Browser proxy self-maintains session via keepalive.
    // If validate() fails, broker will call acquire() for full re-auth.
    return bundle;
  }

  async validate(ctx: ProviderContext, bundle: TokenBundle): Promise<boolean> {
    const extra = bundle.extra as Record<string, unknown> | undefined;
    const proxyUrl = extra?.proxyUrl as string | undefined;
    if (!proxyUrl) return false;

    const doFetch = this.deps.httpFetch ?? (async (url: string) => {
      const r = await globalThis.fetch(url);
      return { ok: r.ok, status: r.status };
    });

    try {
      const resp = await doFetch(`${proxyUrl}/__health`);
      return resp.ok;
    } catch (err) {
      ctx.logger.warn('crowdstrike proxy health check failed', { error: (err as Error).message });
      return false;
    }
  }

  nextRefreshAt(_bundle: TokenBundle): Date {
    // Far future -- proxy self-maintains via keepalive
    return new Date(Date.now() + PROXY_LIFETIME_MS);
  }

  async dispose(): Promise<void> {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    if (this.proxy) {
      await this.proxy.close();
      this.proxy = null;
    }
    if (this.unregisterBrowser) {
      this.unregisterBrowser();
      this.unregisterBrowser = null;
    }
    if (this.browser) {
      await forceCloseBrowser(this.browser, undefined, this.browserPid);
      this.browser = null;
      this.browserPid = undefined;
    }
  }
}
