import type { Provider, ProviderCapabilities, ProviderContext, TokenBundle } from '@hermes/broker';
import { OAuth2ConfigSchema } from './config.js';
import {
  silentRefresh, type OauthFetcher,
  clearProfileLock, type BrowserAuth, type BrowserAuthResult,
  readTotpSeedFromKeychain, makeTotpSupplier, type TotpInput, readKeychainPassword,
  assertRefreshTokenUsable, refreshTokenAcquiredAt, SPA_REFRESH_TOKEN_MAX_AGE_MS,
} from '@hermes/auth-core';
import path from 'node:path';

export interface OAuth2ProviderDeps {
  browser: BrowserAuth;
  fetcher: OauthFetcher;
  now: () => number;
  httpFetch?: (url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean; status: number }>;
}

const OAUTH2_CAPABILITIES: ProviderCapabilities = {
  headless: true,
  schemes: [{
    scheme: 'token',
    credentialSource: 'oauth',
    refreshStrategy: 'refresh-token',
    supportsRefresh: true,
    supportsValidation: true,
    validationStrategy: 'http',
    refreshTokenMaxAgeMs: SPA_REFRESH_TOKEN_MAX_AGE_MS,
  }],
  remediation: {
    acquire: 'Run hermes acquire for the service after confirming loginHint, clientId, scopes, and keychain-backed credentials are valid.',
    refresh: 'Refresh requires a valid SPA refresh token; if it is missing or older than 24h, run hermes acquire for the service.',
    validate: 'Configure validateUrl for an authoritative service probe; 401/403 means re-acquire the service credential.',
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

function assertOAuth2RefreshTokenUsable(bundle: TokenBundle, now: number): void {
  assertRefreshTokenUsable(
    bundle, now,
    'OAuth2 refresh requires refreshToken. Remediation: run hermes acquire for this service.',
    `OAuth2 refresh token is older than ${Math.floor(SPA_REFRESH_TOKEN_MAX_AGE_MS / 3600_000)}h. ` +
    'Remediation: run hermes acquire for this service to seed a fresh headless browser session.',
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

export class OAuth2Provider implements Provider {
  readonly name = 'oauth2';
  readonly schemes = ['token'] as const;
  readonly capabilities = OAUTH2_CAPABILITIES;
  constructor(private readonly deps: OAuth2ProviderDeps) {}

  private async _resolveAuthParams(ctx: ProviderContext) {
    const config = OAuth2ConfigSchema.parse(ctx.config);
    const profileDir = path.join(ctx.dataDir, 'oauth2', 'profile');
    await clearProfileLock(profileDir);
    // Lazy TOTP: resolve the SEED here, generate codes at fill time via a
    // supplier — a code generated at acquire() start is expired by the time
    // the MFA input appears 30-120s into the browser flow.
    let totp: TotpInput | undefined;
    if (config.totpKeychainService && config.totpKeychainAccount) {
      const seed = await readTotpSeedFromKeychain(config.totpKeychainService, config.totpKeychainAccount);
      totp = seed ? makeTotpSupplier(ctx.service, seed) : undefined;
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
      loginHint: config.loginHint, tenant: config.tenant, clientId: config.clientId,
      scheme, headless: config.headless, authTimeoutMs: config.authTimeoutMs, profileDir, totp, password,
      scopes: config.scopes, redirectUri: config.redirectUri, fetcher: this.deps.fetcher,
      service: ctx.service, acquireCommand: `hermes acquire ${ctx.service}`,
    });
    const now = this.deps.now();
    return {
      service: ctx.service, scheme, accessToken: result.accessToken,
      ...(result.refreshToken ? { refreshToken: result.refreshToken } : {}),
      tokenType: 'Bearer', expiresAt: now + result.expiresIn * 1000, acquiredAt: now,
      ...(result.scope ? { scope: result.scope } : {}),
      ...(result.refreshToken ? { extra: { refreshTokenAcquiredAt: now } } : {}),
    };
  }

  async refresh(ctx: ProviderContext, bundle: TokenBundle): Promise<TokenBundle> {
    const config = OAuth2ConfigSchema.parse(ctx.config);
    const now = this.deps.now();
    assertOAuth2RefreshTokenUsable(bundle, now);
    const refreshed = await silentRefresh({ fetcher: this.deps.fetcher, tenant: config.tenant, clientId: config.clientId, bundle, scopes: config.scopes });
    return withRefreshTokenAge(refreshed, bundle, now);
  }

  async validate(ctx: ProviderContext, bundle: TokenBundle): Promise<boolean> {
    const config = OAuth2ConfigSchema.parse(ctx.config);
    if (config.validateUrl) {
      const doFetch = this.deps.httpFetch ?? (async (url: string, init: { headers: Record<string, string> }) => {
        const r = await globalThis.fetch(url, init);
        return { ok: r.ok, status: r.status };
      });
      try {
        const resp = await doFetch(config.validateUrl, { headers: { Authorization: `Bearer ${bundle.accessToken}` } });
        return resp.ok;
      } catch (err) {
        ctx.logger.warn('oauth2 validate fetch failed', { error: (err as Error).message });
        return false;
      }
    }
    const jwt = decodeJwt(bundle.accessToken);
    if (!jwt?.exp) return false;
    return (jwt.exp as number) * 1000 > this.deps.now();
  }

  nextRefreshAt(bundle: TokenBundle): Date {
    const jwt = decodeJwt(bundle.accessToken);
    const expMs = (jwt?.exp as number) ? (jwt!.exp as number) * 1000 : bundle.expiresAt;
    const lifetime = expMs - bundle.acquiredAt;
    const margin = Math.max(300_000, Math.floor(lifetime * 0.2));
    return new Date(expMs - margin);
  }
}
