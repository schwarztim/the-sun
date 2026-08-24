import type { Provider, ProviderCapabilities, ProviderContext, TokenBundle } from '@hermes/broker';
import { Ms365ConfigSchema, SCHEMES, SCOPES, type Ms365Scheme } from './config.js';
import {
  silentRefresh, type OauthFetcher,
  clearProfileLock, type BrowserAuth, type BrowserAuthResult,
  readTotpFromKeychain, readKeychainPassword,
  assertRefreshTokenUsable, refreshTokenAcquiredAt, SPA_REFRESH_TOKEN_MAX_AGE_MS,
} from '@hermes/auth-core';
import path from 'node:path';

const OAUTH2_CLIENT_ID = '04b07795-8ddb-461a-bbee-02f9e1bf7b46';

export interface Ms365ProviderDeps {
  browser: BrowserAuth; fetcher: OauthFetcher; now: () => number;
  httpFetch?: (url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean; status: number }>;
}

const MS365_CAPABILITIES: ProviderCapabilities = {
  headless: true,
  schemes: SCHEMES.map((scheme) => ({
    scheme,
    credentialSource: 'oauth' as const,
    refreshStrategy: 'refresh-token' as const,
    supportsRefresh: true,
    supportsValidation: true,
    validationStrategy: 'http' as const,
    refreshTokenMaxAgeMs: SPA_REFRESH_TOKEN_MAX_AGE_MS,
  })),
  remediation: {
    acquire: 'Run hermes acquire ms365 after confirming loginHint and keychain-backed password/TOTP material are available.',
    refresh: 'MS365 refresh requires a valid SPA refresh token; if missing, revoked, or older than 24h, run hermes acquire ms365.',
    validate: 'Graph validation failures usually require re-acquiring ms365; network failures should be checked before rotating credentials.',
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

function decodeJwt(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try { return JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')); } catch { return null; }
}

function assertMs365RefreshTokenUsable(bundle: TokenBundle, now: number): void {
  assertRefreshTokenUsable(
    bundle, now,
    `ms365:${bundle.scheme} refresh requires refreshToken. Remediation: run hermes acquire ms365.`,
    `ms365:${bundle.scheme} refresh token is older than ${Math.floor(SPA_REFRESH_TOKEN_MAX_AGE_MS / 3600_000)}h. ` +
    'Remediation: run hermes acquire ms365 to seed a fresh headless browser session.',
  );
}

function withRefreshTokenAge(refreshed: TokenBundle, previous: TokenBundle, now: number): TokenBundle {
  const oldRtAcquiredAt = refreshTokenAcquiredAt(previous);
  const refreshTokenChanged = !!refreshed.refreshToken && refreshed.refreshToken !== previous.refreshToken;
  return {
    ...refreshed,
    extra: {
      ...((previous.extra as Record<string, unknown> | undefined) ?? {}),
      refreshTokenAcquiredAt: refreshTokenChanged ? now : oldRtAcquiredAt,
    },
  };
}

export class Ms365Provider implements Provider {
  readonly name = 'ms365';
  readonly schemes = SCHEMES;
  readonly capabilities = MS365_CAPABILITIES;
  constructor(private readonly deps: Ms365ProviderDeps) {}

  private async _resolveAuthParams(ctx: ProviderContext) {
    const config = Ms365ConfigSchema.parse(ctx.config);
    const profileDir = path.join(ctx.dataDir, 'ms365', 'profile');
    await clearProfileLock(profileDir);
    let totp: string | undefined;
    if (config.totpKeychainService && config.totpKeychainAccount) {
      totp = (await readTotpFromKeychain(config.totpKeychainService, config.totpKeychainAccount)) ?? undefined;
    }
    let password: string | undefined;
    if (config.passwordKeychainService && config.passwordKeychainAccount) {
      password = (await readKeychainPassword(config.passwordKeychainService, config.passwordKeychainAccount)) ?? undefined;
    }
    return { config, profileDir, totp, password };
  }

  async acquire(ctx: ProviderContext, scheme: string): Promise<TokenBundle> {
    const { config, profileDir, totp, password } = await this._resolveAuthParams(ctx);
    const result: BrowserAuthResult = await this.deps.browser.login({
      loginHint: config.loginHint, tenant: config.tenant,
      // OAuth2 auth code flow: Microsoft Office client (d3590ed6) lacks
      // nativeclient redirect URI → use Azure CLI client (04b07795) instead
      clientId: OAUTH2_CLIENT_ID,
      scheme: scheme as Ms365Scheme, headless: config.headless, authTimeoutMs: config.authTimeoutMs, profileDir, totp, password,
      service: 'ms365', acquireCommand: 'hermes acquire ms365',
      scopes: SCOPES[scheme as Ms365Scheme] ?? SCOPES.graph,
    });
    const now = this.deps.now();
    return {
      service: 'ms365', scheme, accessToken: result.accessToken,
      ...(result.refreshToken ? { refreshToken: result.refreshToken } : {}),
      tokenType: 'Bearer', expiresAt: now + result.expiresIn * 1000, acquiredAt: now,
      ...(result.scope ? { scope: result.scope } : {}),
      ...(result.refreshToken ? { extra: { refreshTokenAcquiredAt: now } } : {}),
    };
  }

  async acquireAll(ctx: ProviderContext): Promise<TokenBundle[]> {
    const { config, profileDir, totp, password } = await this._resolveAuthParams(ctx);
    const allResults = await this.deps.browser.loginAll({
      loginHint: config.loginHint, tenant: config.tenant, clientId: config.clientId,
      headless: config.headless, authTimeoutMs: config.authTimeoutMs, profileDir, totp, password,
      service: 'ms365', acquireCommand: 'hermes acquire ms365',
    });
    const now = this.deps.now();
    return Array.from(allResults.entries()).map(([scheme, r]) => ({
      service: 'ms365', scheme, accessToken: r.accessToken,
      ...(r.refreshToken ? { refreshToken: r.refreshToken } : {}),
      tokenType: 'Bearer' as const, expiresAt: now + r.expiresIn * 1000, acquiredAt: now,
      ...(r.scope ? { scope: r.scope } : {}),
      ...(r.refreshToken ? { extra: { refreshTokenAcquiredAt: now } } : {}),
    }));
  }

  async refresh(ctx: ProviderContext, bundle: TokenBundle): Promise<TokenBundle> {
    const config = Ms365ConfigSchema.parse(ctx.config);
    const scheme = bundle.scheme as Ms365Scheme;
    const scopes = SCOPES[scheme] ?? SCOPES.graph;
    const now = this.deps.now();
    assertMs365RefreshTokenUsable(bundle, now);
    const refreshed = await silentRefresh({ fetcher: this.deps.fetcher, tenant: config.tenant, clientId: config.clientId, bundle, scopes });
    return withRefreshTokenAge(refreshed, bundle, now);
  }

  async validate(ctx: ProviderContext, bundle: TokenBundle): Promise<boolean> {
    const doFetch = this.deps.httpFetch ?? (async (url: string, init: { headers: Record<string, string> }) => {
      const r = await globalThis.fetch(url, init);
      return { ok: r.ok, status: r.status };
    });
    try {
      const resp = await doFetch('https://graph.microsoft.com/v1.0/me', { headers: { Authorization: `Bearer ${bundle.accessToken}` } });
      return resp.ok;
    } catch (err) { ctx.logger.warn('ms365 validate failed', { error: (err as Error).message }); return false; }
  }

  nextRefreshAt(bundle: TokenBundle): Date {
    const jwt = decodeJwt(bundle.accessToken);
    const expMs = (jwt?.exp as number) ? (jwt!.exp as number) * 1000 : bundle.expiresAt;
    const lifetime = expMs - bundle.acquiredAt;
    const margin = Math.max(300_000, Math.floor(lifetime * 0.2));
    const accessRefreshAt = expMs - margin;

    const rtAcquiredAt = refreshTokenAcquiredAt(bundle);
    const rtDeadline = rtAcquiredAt + SPA_REFRESH_TOKEN_MAX_AGE_MS;
    const REACQUIRE_MARGIN_MS = 2 * 60 * 60 * 1000;
    const rtReacquireAt = rtDeadline - REACQUIRE_MARGIN_MS;

    return new Date(Math.min(accessRefreshAt, rtReacquireAt));
  }
}
