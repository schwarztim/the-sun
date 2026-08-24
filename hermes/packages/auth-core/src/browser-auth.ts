import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { defaultFetcher, type OauthFetcher } from './refresh.js';
import { ConditionalAccessChallengeError, classifyConditionalAccessChallenge, classifyConditionalAccessPage } from './conditional-access.js';
import { withManagedBrowser, raceDeadline } from './managed-browser.js';
import { loadSessionState, saveSessionState, invalidateSessionState } from './session-state.js';
import { resolveTotp, TotpRejectedError, type TotpInput } from './totp.js';

export interface BrowserAuthParams {
  loginHint: string; tenant: string; clientId: string;
  scheme: string; headless: boolean;
  authTimeoutMs: number; profileDir: string; totp?: TotpInput; password?: string;
  scopes?: string[]; redirectUri?: string; fetcher?: OauthFetcher;
  service?: string; acquireCommand?: string;
}

export interface BrowserAuthResult {
  accessToken: string; refreshToken?: string; expiresIn: number; scope?: string;
}

export interface BrowserAuth {
  login(params: BrowserAuthParams): Promise<BrowserAuthResult>;
  loginAll(params: Omit<BrowserAuthParams, 'scheme'>): Promise<Map<string, BrowserAuthResult>>;
  close(): Promise<void>;
}

export async function clearProfileLock(profileDir: string): Promise<void> {
  for (const name of ['lock', '.parentlock', 'parent.lock']) {
    try { await fs.unlink(path.join(profileDir, name)); } catch { /* ignore */ }
  }
}

type TokenScheme = 'graph' | 'teams' | 'outlook';

interface CapturedToken {
  scheme: string;
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  scope?: string;
}

function classifyToken(scope?: string, resource?: string): TokenScheme | null {
  const combined = `${scope ?? ''} ${resource ?? ''}`.toLowerCase();
  if (combined.includes('graph.microsoft.com')) return 'graph';
  if (combined.includes('outlook.office.com')) return 'outlook';
  if (combined.includes('teams') || combined.includes('skype') ||
      combined.includes('chatsvcagg') || combined.includes('substrate')) return 'teams';
  return null;
}

interface MsalCachedToken {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  scope?: string;
  audience?: string;
}

/**
 * Read MSAL.js access tokens from the browser's localStorage. MSAL stores
 * tokens with keys containing 'accesstoken' and entries shaped like
 * { secret, target, realm, expiresOn, ... }. Outlook Web acquires tokens
 * via routes the network response listener can't always observe (URL fragment
 * or refresh-token grant), so this is the fallback capture path.
 *
 * Ported from ms365-mcp/src/browser-token-capture.ts:extractTokenFromMsalCache.
 */
async function extractMsalTokens(page: import('patchright').Page): Promise<MsalCachedToken[]> {
  try {
    const raw = await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const win = globalThis as any;
      const out: Array<{ accessToken: string; refreshToken?: string; expiresOn?: number; target?: string; aud?: string }> = [];
      const stores = [win.localStorage, win.sessionStorage].filter(Boolean);
      for (const store of stores) {
        for (let i = 0; i < store.length; i++) {
          const key = store.key(i);
          if (!key) continue;
          const lower = key.toLowerCase();
          if (!lower.includes('accesstoken') && !lower.includes('access_token') && !lower.includes('msal') && !lower.includes('token')) continue;
          const value = store.getItem(key);
          if (!value) continue;
          try {
            const parsed = JSON.parse(value);
            // MSAL 2.x: top-level secret field
            if (typeof parsed.secret === 'string' && parsed.secret.split('.').length === 3) {
              out.push({
                accessToken: parsed.secret,
                expiresOn: parsed.expiresOn ? parseInt(parsed.expiresOn) : undefined,
                target: parsed.target || parsed.scopes,
              });
              continue;
            }
            // Standard OAuth shape
            if (typeof parsed.access_token === 'string') {
              out.push({
                accessToken: parsed.access_token,
                refreshToken: typeof parsed.refresh_token === 'string' ? parsed.refresh_token : undefined,
                expiresOn: typeof parsed.expires_in === 'number' ? Math.floor(Date.now() / 1000) + parsed.expires_in : undefined,
                target: parsed.scope,
              });
              continue;
            }
            // Nested object containing tokens
            if (typeof parsed === 'object' && parsed !== null) {
              for (const inner of Object.values(parsed) as unknown[]) {
                if (typeof inner !== 'object' || inner === null) continue;
                const it = inner as { secret?: unknown; expiresOn?: unknown; target?: unknown };
                if (typeof it.secret === 'string' && it.secret.split('.').length === 3) {
                  out.push({
                    accessToken: it.secret,
                    expiresOn: typeof it.expiresOn === 'string' ? parseInt(it.expiresOn) : (typeof it.expiresOn === 'number' ? it.expiresOn : undefined),
                    target: typeof it.target === 'string' ? it.target : undefined,
                  });
                }
              }
            }
          } catch { /* not JSON */ }
        }
      }
      return out;
    });

    // Decode JWT audience for proper classification
    const result: MsalCachedToken[] = [];
    for (const t of raw) {
      let audience: string | undefined;
      try {
        const parts = t.accessToken.split('.');
        const payloadPart = parts[1];
        if (parts.length >= 2 && payloadPart) {
          // base64url-decode the payload (browser/node)
          const pad = payloadPart.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - payloadPart.length % 4) % 4);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const buf = (globalThis as any).Buffer ? (globalThis as any).Buffer.from(pad, 'base64') : null;
          if (buf) {
            const payload = JSON.parse(buf.toString());
            audience = typeof payload.aud === 'string' ? payload.aud : undefined;
          }
        }
      } catch { /* skip */ }
      const now = Math.floor(Date.now() / 1000);
      const expiresIn = t.expiresOn ? Math.max(60, t.expiresOn - now) : 3600;
      result.push({
        accessToken: t.accessToken,
        refreshToken: t.refreshToken,
        expiresIn,
        scope: t.target,
        audience,
      });
    }
    return result;
  } catch {
    return [];
  }
}

async function isDomVisible(page: import('patchright').Page, selector: string): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- runs in browser context
  return page.evaluate(new Function('sel', 'var el = document.querySelector(sel); return !!(el && el.offsetParent !== null)') as (sel: string) => boolean, selector).catch(() => false);
}

export async function trySelector(
  page: import('patchright').Page,
  selectors: string[],
  action: 'fill' | 'click',
  value?: string,
): Promise<boolean> {
  for (const sel of selectors) {
    try {
      const visible = await isDomVisible(page, sel);
      if (!visible) continue;
      const el = page.locator(sel).first();
      if (action === 'fill' && value !== undefined) { await el.fill(value, { timeout: 5000 }); return true; }
      if (action === 'click') { await el.click({ timeout: 5000 }); return true; }
    } catch { /* next selector */ }
  }
  return false;
}

async function isVisible(page: import('patchright').Page, selectors: string[]): Promise<boolean> {
  for (const sel of selectors) {
    if (await isDomVisible(page, sel)) return true;
  }
  return false;
}

function browserDebug(message: string): void {
  if (process.env['HERMES_DEBUG_BROWSER']) console.log(`[hermes:browser] ${message}`);
}

function redactBrowserUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return rawUrl;
  }
}

async function classifyCurrentPage(
  page: import('patchright').Page,
  params: Omit<BrowserAuthParams, 'scheme'>,
  unknownLoginRoute = false,
): Promise<void> {
  const challenge = await classifyConditionalAccessPage(page, {
    service: params.service,
    acquireCommand: params.acquireCommand,
    totpConfigured: Boolean(params.totp),
    unknownLoginRoute,
  });
  if (challenge) throw new ConditionalAccessChallengeError(challenge);
}

export function parseOAuthRedirect(currentUrl: string, redirectUri: string, expectedState: string): { code: string } | { error: string } | null {
  let current: URL;
  let redirect: URL;
  try {
    current = new URL(currentUrl);
    redirect = new URL(redirectUri);
  } catch {
    return null;
  }

  if (current.origin !== redirect.origin || current.pathname !== redirect.pathname) return null;

  const hashParams = current.hash ? new URLSearchParams(current.hash.slice(1)) : undefined;
  const getParam = (name: string) => current.searchParams.get(name) ?? hashParams?.get(name) ?? null;

  const returnedState = getParam('state');
  if (!returnedState) return null;
  if (returnedState !== expectedState) return { error: 'OAuth state mismatch during browser auth' };

  const error = getParam('error');
  if (error) {
    const description = getParam('error_description');
    return { error: description ? `${error}: ${description}` : error };
  }

  const code = getParam('code');
  return code ? { code } : null;
}

export class PlaywrightBrowserAuth implements BrowserAuth {
  private browser: import('patchright').Browser | null = null;

  private async _handleLoginPage(page: import('patchright').Page, params: Omit<BrowserAuthParams, 'scheme'>, totpState: { submits: number } = { submits: 0 }): Promise<void> {
    const passwordSelectors = ['input[type="password"]', '#i0118', 'input[name="passwd"]'];
    const emailSelectors = ['input[type="email"]', 'input[name="loginfmt"]', '#i0116'];
    const totpSelectors = ['input[name="otc"]', '#idTxtBx_SAOTCC_OTC'];
    const submitSelectors = ['input[type="submit"]', '#idSIButton9', 'button[type="submit"]'];
    const errorBannerSelectors = '#passwordError, #usernameError, #idSpan_SAOTCC_Error_OTC, .alert-error, [role="alert"]';
    const staySignedIn = await page.locator('text=/Stay signed in/i').isVisible({ timeout: 500 }).catch(() => false);
    const errorBanner = await page.locator(errorBannerSelectors).first().isVisible({ timeout: 500 }).catch(() => false);
    const errorText = errorBanner ? await page.locator(errorBannerSelectors).first().textContent().catch(() => '') : '';
    browserDebug(`login state url=${redactBrowserUrl(page.url())} passwordInput=${await isVisible(page, passwordSelectors)} emailInput=${await isVisible(page, emailSelectors)} totpInput=${await isVisible(page, totpSelectors)} staySignedIn=${staySignedIn} error=${errorText || 'none'} passwordConfigured=${Boolean(params.password ?? process.env['HERMES_MS365_PASSWORD'])} totpConfigured=${Boolean(params.totp)}`);

    if (errorBanner && errorText) {
      browserDebug(`login error detected: ${errorText}`);
    }

    // Password step: login_hint pre-fills email, so Azure AD often skips straight to password.
    const password = params.password ?? process.env['HERMES_MS365_PASSWORD'] ?? '';
    if (password) {
      const filledPassword = await trySelector(page, passwordSelectors, 'fill', password);
      if (filledPassword) {
        browserDebug('filled password, clicking submit');
        await page.waitForTimeout(500);
        await trySelector(page, submitSelectors, 'click');
        browserDebug('submit clicked, waiting for navigation');
        await page.waitForTimeout(3000);
        browserDebug(`post-submit url=${redactBrowserUrl(page.url())}`);
        return;
      }
    }

    // Fill email (fallback if password field isn't visible yet)
    const filledEmail = await trySelector(page, emailSelectors, 'fill', params.loginHint);
    if (filledEmail) {
      browserDebug('filled login hint and submitted');
      await trySelector(page, submitSelectors, 'click');
      await page.waitForTimeout(2000);
      return;
    }

    // Account picker ("Pick an account"): a persistent profile holding a
    // remembered-but-revoked session opens HERE, and this page has no email
    // input at all, so every selector above misses and the login loop spins
    // until the acquire times out. That is exactly how 2026-08-20 played out:
    // the tenant CA re-evaluation revoked sessions, this handler met the
    // picker for the first time, and ms365 cold-acquires sat "in flight"
    // forever (the az-teams sibling failed 8/8 the same way). Click the
    // remembered tile; fall back to the first tile, then to "Use another
    // account", which re-enters the email path on the next iteration.
    if (params.loginHint) {
      const named = page.locator(`div[role="button"]:has-text("${params.loginHint}")`).first();
      if (await named.isVisible({ timeout: 500 }).catch(() => false)) {
        await named.click().catch(() => {});
        browserDebug('clicked remembered account tile');
        await page.waitForTimeout(2000);
        return;
      }
    }
    const tileSelectors = ['#tilesHolder div.table[role="button"]', 'div[data-test-id="accountTile"]'];
    if (await isVisible(page, tileSelectors)) {
      if (await trySelector(page, tileSelectors, 'click')) {
        browserDebug('clicked first account tile');
        await page.waitForTimeout(2000);
        return;
      }
    }
    if (await trySelector(page, ['#otherTile', '#otherTileText'], 'click')) {
      browserDebug('chose "Use another account"');
      await page.waitForTimeout(1500);
      return;
    }

    // TOTP MFA — codes are generated at fill time (lazy supplier) so they are
    // fresh when the MFA input appears, never refilled while a submission is
    // pending, and retried at most once (in a later window) after a rejection.
    if (params.totp) {
      const totpFieldVisible = await isVisible(page, totpSelectors);
      if (totpFieldVisible) {
        if (totpState.submits >= 2) {
          if (errorBanner) throw new TotpRejectedError();
          browserDebug('TOTP retry already submitted; awaiting navigation');
          return;
        }
        if (totpState.submits === 1 && !errorBanner) {
          // A code was submitted and no rejection banner is showing — the IdP
          // is processing. Refilling here is the duplicate-code lockout bug.
          browserDebug('TOTP already submitted; awaiting navigation');
          return;
        }
        // submits === 0 (initial) or submits === 1 with a rejection banner
        // (single regenerated retry — anti-replay forces a later window).
        const code = await resolveTotp(params.totp);
        if (code) {
          const filledTotp = await trySelector(page, totpSelectors, 'fill', code);
          if (filledTotp) {
            totpState.submits += 1;
            browserDebug(`filled TOTP and submitted (attempt ${totpState.submits})`);
            await trySelector(page, ['#idSubmit_SAOTCC_Continue', 'input[type="submit"][value="Verify"]'], 'click');
            await page.waitForTimeout(2000);
            return;
          }
        }
      }
    }

    // Consent prompts can appear on first use of a new resource scope.
    await trySelector(page, [
      '#idBtn_Accept',
      'input[type="submit"][value="Accept"]',
      'button:has-text("Accept")',
      'input[type="submit"][value="Continue"]',
      'button:has-text("Continue")',
    ], 'click');

    if (staySignedIn) {
      browserDebug('answered Stay signed in prompt');
      await trySelector(page, ['#idBtn_Back', 'button:has-text("No")'], 'click');
    }
  }

  private _buildAuthorizeUrl(params: BrowserAuthParams, state: string, codeChallenge: string): string {
    const redirectUri = params.redirectUri ?? 'https://login.microsoftonline.com/common/oauth2/nativeclient';
    if (!params.scopes?.length) throw new Error('OAuth2 browser auth requires at least one scope');

    const url = new URL(`https://login.microsoftonline.com/${params.tenant}/oauth2/v2.0/authorize`);
    url.searchParams.set('client_id', params.clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_mode', 'query');
    url.searchParams.set('scope', params.scopes.join(' '));
    url.searchParams.set('login_hint', params.loginHint);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  }

  private async _exchangeAuthorizationCode(params: BrowserAuthParams, code: string, codeVerifier: string): Promise<CapturedToken> {
    if (!params.scopes?.length) throw new Error('OAuth2 browser auth requires at least one scope');
    const redirectUri = params.redirectUri ?? 'https://login.microsoftonline.com/common/oauth2/nativeclient';
    const body = new URLSearchParams();
    body.set('grant_type', 'authorization_code');
    body.set('client_id', params.clientId);
    body.set('code', code);
    body.set('redirect_uri', redirectUri);
    body.set('scope', params.scopes.join(' '));
    body.set('code_verifier', codeVerifier);

    const resp = await (params.fetcher ?? defaultFetcher)(`https://login.microsoftonline.com/${params.tenant}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    return {
      scheme: params.scheme,
      accessToken: resp.access_token,
      refreshToken: resp.refresh_token,
      expiresIn: resp.expires_in,
      scope: resp.scope,
    };
  }

  private _createPkcePair(): { verifier: string; challenge: string } {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
  }

  private async _runOAuth2AuthCode(params: BrowserAuthParams): Promise<CapturedToken> {
    if (!params.headless) {
      throw new Error('HEADLESS_REQUIRED: Hermes does not support foreground browser sessions. All authentication must be headless.');
    }
    const timeout = params.authTimeoutMs || 120_000;
    const redirectUri = params.redirectUri ?? 'https://login.microsoftonline.com/common/oauth2/nativeclient';
    const state = randomBytes(16).toString('hex');
    const pkce = this._createPkcePair();
    const authorizeUrl = this._buildAuthorizeUrl(params, state, pkce.challenge);
    const sessionService = params.service ?? 'ms365';

    return withManagedBrowser({
      service: sessionService,
      engine: 'chromium',
      profileDir: params.profileDir,
      maxLifetimeMs: timeout + 60_000,
      launchOptions: {
        headless: params.headless,
        timeout: 30_000,
        args: params.headless ? ['--headless=new'] : [],
      },
    }, async (browser) => {
      this.browser = browser;
      const storedSession = await loadSessionState(sessionService);
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        ignoreHTTPSErrors: true,
        ...(storedSession ? { storageState: storedSession } : {}),
      });
      try {
      const page = await context.newPage();
      let capturedRedirect: { code: string } | { error: string } | null = null;
      const captureRedirect = (url: string) => {
        if (capturedRedirect) return;
        capturedRedirect = parseOAuthRedirect(url, redirectUri, state);
      };
      page.on('request', (request) => captureRedirect(request.url()));
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) captureRedirect(frame.url());
      });

      console.log('[hermes] navigating to OAuth2 authorization endpoint...');
      await page.goto(authorizeUrl, { timeout: 30_000, waitUntil: 'domcontentloaded' });

      const totpState = { submits: 0 };
      const deadline = Date.now() + timeout;
      const watchdogAt = deadline + 30_000;
      while (Date.now() < deadline) {
        await page.waitForTimeout(1500);

        await raceDeadline(classifyCurrentPage(page, params), watchdogAt, 'classifyCurrentPage(oauth2 loop)');

        const redirect = capturedRedirect ?? parseOAuthRedirect(page.url(), redirectUri, state);
        if (redirect) {
          if ('error' in redirect) {
            const challenge = classifyConditionalAccessChallenge({
              message: redirect.error,
              url: page.url(),
              service: params.service,
              acquireCommand: params.acquireCommand,
            });
            if (challenge) throw new ConditionalAccessChallengeError(challenge);
            throw new Error(redirect.error);
          }
          console.log('[hermes] authorization code captured, exchanging for token...');
          const token = await this._exchangeAuthorizationCode(params, redirect.code, pkce.verifier);
          const sessionState = await context.storageState().catch(() => undefined);
          if (sessionState) await saveSessionState(sessionService, sessionState);
          return token;
        }

        const currentUrl = page.url();
        const onLogin = currentUrl.includes('login.microsoftonline.com') || currentUrl.includes('login.microsoft.com');
        if (onLogin) {
          const urlPath = new URL(currentUrl).pathname;
          const pageTitle = await raceDeadline(page.title().catch(() => ''), watchdogAt, 'page.title(oauth2 loop)');
          console.log(`[hermes] on login page, continuing OAuth2 flow... path=${urlPath} title=${pageTitle.substring(0, 60)}`);
          await fs.mkdir(params.profileDir, { recursive: true }).catch(() => {});
          await page.screenshot({ path: path.join(params.profileDir, `hermes-oauth2-${Date.now()}.png`) }).catch(() => {});
          await this._handleLoginPage(page, params, totpState);
          await raceDeadline(classifyCurrentPage(page, params), watchdogAt, 'classifyCurrentPage(oauth2 post-login)');
        }
      }

      await raceDeadline(classifyCurrentPage(page, params, true), watchdogAt, 'classifyCurrentPage(oauth2 final)');
      throw new Error('Browser auth timed out waiting for OAuth2 authorization code');
      } catch (err) {
        // Stale/revoked SSO state must not be retried (covers
        // ConditionalAccessChallengeError and all other auth failures).
        await invalidateSessionState(sessionService);
        throw err;
      }
    }).finally(() => { this.browser = null; });
  }

  private async _runAuth(params: Omit<BrowserAuthParams, 'scheme'>): Promise<Map<TokenScheme, CapturedToken>> {
    if (!params.headless) {
      throw new Error('HEADLESS_REQUIRED: Hermes does not support foreground browser sessions. All authentication must be headless.');
    }
    const tokens = new Map<TokenScheme, CapturedToken>();
    const timeout = params.authTimeoutMs || 120_000;
    const sessionService = params.service ?? 'ms365';

    return withManagedBrowser({
      service: sessionService,
      engine: 'chromium',
      profileDir: params.profileDir,
      maxLifetimeMs: timeout + 60_000,
      launchOptions: {
        headless: params.headless,
        timeout: 30_000,
        args: params.headless ? ['--headless=new'] : [],
      },
    }, async (browser) => {
      this.browser = browser;
      const storedSession = await loadSessionState(sessionService);
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        ignoreHTTPSErrors: true,
        ...(storedSession ? { storageState: storedSession } : {}),
      });
      try {
      const page = await context.newPage();

      // Intercept OAuth token responses
      page.on('response', async (resp) => {
        try {
          const url = resp.url();
          if (!url.includes('/oauth2/v2.0/token') && !url.includes('/oauth2/token')) return;
          const ct = resp.headers()['content-type'] ?? '';
          if (!ct.includes('application/json')) return;
          const body = await resp.json() as Record<string, unknown>;
          const at = body['access_token'];
          if (typeof at !== 'string') return;
          const scope = body['scope'] as string | undefined;
          const resource = body['resource'] as string | undefined;
          const scheme = classifyToken(scope, resource);
          console.log(`[hermes] oauth response: scheme=${scheme ?? 'null'} scope=${(scope ?? '').substring(0, 80)} resource=${resource ?? 'none'}`);
          if (!scheme) return;
          console.log(`[hermes] captured ${scheme} token`);
          tokens.set(scheme, {
            scheme,
            accessToken: at,
            refreshToken: typeof body['refresh_token'] === 'string' ? body['refresh_token'] as string : undefined,
            expiresIn: typeof body['expires_in'] === 'number' ? body['expires_in'] as number : 3600,
            scope: typeof body['scope'] === 'string' ? body['scope'] as string : undefined,
          });
        } catch { /* ignore parse errors */ }
      });

      // Navigate to Outlook to trigger Graph/Outlook tokens
      console.log('[hermes] navigating to Outlook...');
      await page.goto('https://outlook.office.com/mail/', { timeout: 30_000, waitUntil: 'domcontentloaded' });

      const totpState = { submits: 0 };
      const deadline = Date.now() + timeout;
      const watchdogAt = deadline + 30_000;
      let authenticated = false;

      while (!authenticated && Date.now() < deadline) {
        await page.waitForTimeout(1500);
        const currentUrl = page.url();

        await raceDeadline(classifyCurrentPage(page, params), watchdogAt, 'classifyCurrentPage(login loop)');

        const onLogin = currentUrl.includes('login.microsoftonline.com') || currentUrl.includes('login.microsoft.com');
        if (onLogin) {
          console.log('[hermes] on login page, filling credentials...');
          await this._handleLoginPage(page, params, totpState);
          await raceDeadline(classifyCurrentPage(page, params), watchdogAt, 'classifyCurrentPage(post-login)');
        }

        // Check if authenticated
        const nowUrl = page.url();
        if (nowUrl.includes('outlook.office.com/mail') && !nowUrl.includes('login.microsoftonline.com')) {
          authenticated = true;
        }
      }

      if (!authenticated) {
        await raceDeadline(classifyCurrentPage(page, params, true), watchdogAt, 'classifyCurrentPage(auth final)');
        throw new Error('Browser auth timed out waiting for login');
      }
      console.log('[hermes] authenticated; waiting for Outlook MSAL cache to populate...');

      // Wait briefly for Outlook's MSAL.js to populate its cache and possibly
      // issue /oauth2 token calls. Outlook Web stores tokens in localStorage —
      // the network response listener may miss them if MSAL uses the URL fragment
      // (implicit flow) or refresh-token grant outside the watched endpoint.
      const outlookDeadline = Date.now() + 15_000;
      while ((!tokens.has('outlook') || !tokens.has('graph')) && Date.now() < outlookDeadline) {
        await page.waitForTimeout(2000);
      }

      // Extract any tokens MSAL.js stashed in localStorage (Outlook/Graph
      // sometimes acquire via routes the response listener can't see).
      const msalTokens = await raceDeadline(extractMsalTokens(page), watchdogAt, 'extractMsalTokens(outlook)');
      console.log(`[hermes] MSAL cache: ${msalTokens.length} tokens found`);
      for (const t of msalTokens) {
        const scheme = classifyToken(t.scope, t.audience);
        console.log(`[hermes]   MSAL token: scheme=${scheme ?? 'null'} scope=${(t.scope ?? '').substring(0, 80)} audience=${t.audience ?? 'none'}`);
        if (!scheme || tokens.has(scheme)) continue;
        console.log(`[hermes] captured ${scheme} token from MSAL cache (audience=${t.audience ?? 'unknown'})`);
        tokens.set(scheme, {
          scheme,
          accessToken: t.accessToken,
          refreshToken: t.refreshToken,
          expiresIn: t.expiresIn,
          scope: t.scope,
        });
      }

      // Outlook Web no longer requests graph.microsoft.com tokens during page load.
      // Navigate to OneDrive which triggers a Graph-scoped MSAL token acquisition.
      if (!tokens.has('graph')) {
        console.log('[hermes] graph token not captured from Outlook, navigating to Office portal...');
        const navOk = await page.goto('https://www.office.com/', { timeout: 30_000, waitUntil: 'domcontentloaded' })
          .then(() => true, (err: unknown) => {
            console.log(`[hermes] Office portal navigation failed: ${(err as Error).message}; skipping graph poll on dead page`);
            return false;
          });
        if (navOk) {
          const graphDeadline = Date.now() + 15_000;
          while (!tokens.has('graph') && Date.now() < graphDeadline) {
            await page.waitForTimeout(2000);
          }
          if (!tokens.has('graph')) {
            const msalGraph = await raceDeadline(extractMsalTokens(page), watchdogAt, 'extractMsalTokens(office portal)');
            for (const t of msalGraph) {
              const scheme = classifyToken(t.scope, t.audience);
              if (scheme === 'graph' && !tokens.has('graph')) {
                console.log(`[hermes] captured graph token from Office portal MSAL cache`);
                tokens.set('graph', { scheme: 'graph', accessToken: t.accessToken, refreshToken: t.refreshToken, expiresIn: t.expiresIn, scope: t.scope });
              }
            }
          }
        }
        if (!tokens.has('graph')) {
          console.log('[hermes] warning: graph token not captured from Office portal either');
        }
      }

      // Always navigate to Teams to capture Teams token
      if (!tokens.has('teams')) {
        console.log('[hermes] navigating to Teams to capture teams token...');
        await page.goto('https://teams.microsoft.com/', { timeout: 30_000, waitUntil: 'domcontentloaded' });
        const teamsDeadline = Date.now() + 45_000;
        while (!tokens.has('teams') && Date.now() < teamsDeadline) {
          await page.waitForTimeout(2000);
        }
        if (!tokens.has('teams')) {
          console.log('[hermes] warning: teams token not captured within 45s');
        }
      }

      console.log(`[hermes] auth complete, captured tokens: ${[...tokens.keys()].join(', ')}`);
      const sessionState = await context.storageState().catch(() => undefined);
      if (sessionState) await saveSessionState(sessionService, sessionState);
      return tokens;
      } catch (err) {
        // Stale/revoked SSO state must not be retried (covers
        // ConditionalAccessChallengeError and all other auth failures).
        await invalidateSessionState(sessionService);
        throw err;
      }
    }).finally(() => { this.browser = null; });
  }

  async login(params: BrowserAuthParams): Promise<BrowserAuthResult> {
    if (params.scopes?.length) {
      const result = await this._runOAuth2AuthCode(params);
      return {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresIn: result.expiresIn,
        scope: result.scope,
      };
    }

    const tokens = await this._runAuth(params);
    const result = tokens.get(params.scheme as TokenScheme);
    if (!result) throw new Error(`No ${params.scheme} token captured during browser auth`);
    return {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresIn: result.expiresIn,
      scope: result.scope,
    };
  }

  async loginAll(params: Omit<BrowserAuthParams, 'scheme'>): Promise<Map<string, BrowserAuthResult>> {
    const tokens = await this._runAuth(params);
    const results = new Map<string, BrowserAuthResult>();
    for (const [scheme, captured] of tokens) {
      results.set(scheme, {
        accessToken: captured.accessToken,
        refreshToken: captured.refreshToken,
        expiresIn: captured.expiresIn,
        scope: captured.scope,
      });
    }
    return results;
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }
}
