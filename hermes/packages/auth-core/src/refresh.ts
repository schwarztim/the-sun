import { ConditionalAccessChallengeError, classifyConditionalAccessChallenge } from './conditional-access.js';

export interface TokenBundle {
  service: string;
  scheme: string;
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  expiresAt: number;
  acquiredAt: number;
  scope?: string;
  extra?: Record<string, unknown>;
}

export interface OauthTokenResponse {
  access_token: string; refresh_token?: string; token_type: string; expires_in: number; scope?: string;
}
export type OauthFetcher = (url: string, opts: { method: 'POST'; headers: Record<string, string>; body: string }) => Promise<OauthTokenResponse>;

export interface SilentRefreshOptions {
  fetcher: OauthFetcher;
  tenant: string;
  clientId: string;
  bundle: TokenBundle;
  scopes: string[];
}

export async function silentRefresh(opts: SilentRefreshOptions): Promise<TokenBundle> {
  const { fetcher, tenant, clientId, bundle, scopes } = opts;
  if (!bundle.refreshToken) throw new Error('no refresh_token in bundle');
  const params = new URLSearchParams();
  params.set('grant_type', 'refresh_token');
  params.set('refresh_token', bundle.refreshToken);
  params.set('client_id', clientId);
  params.set('scope', scopes.join(' '));
  const url = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
  const resp = await fetcher(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://login.microsoftonline.com' },
    body: params.toString(),
  });
  const now = Date.now();
  return {
    service: bundle.service, scheme: bundle.scheme, accessToken: resp.access_token,
    refreshToken: resp.refresh_token ?? bundle.refreshToken, tokenType: resp.token_type || 'Bearer',
    expiresAt: now + resp.expires_in * 1000, acquiredAt: now,
    ...(resp.scope ? { scope: resp.scope } : {}),
  };
}

const AADSTS_REFRESH_EXPIRED = /AADSTS(700003|700082|700084|70000|50173)/;
const TRANSIENT_HTTP_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export type RefreshFailureCategory = 'human-action-required' | 'transient' | 'terminal';

export class OAuthRefreshError extends Error {
  public readonly status: number;
  public readonly category: RefreshFailureCategory;
  public readonly retryable: boolean;
  public readonly retryAfterMs?: number;

  constructor(message: string, status: number, opts: { category: RefreshFailureCategory; retryable: boolean; retryAfterMs?: number }) {
    super(message);
    this.name = 'OAuthRefreshError';
    this.status = status;
    this.category = opts.category;
    this.retryable = opts.retryable;
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
  }
}

export class RefreshTokenExpiredError extends OAuthRefreshError {
  public readonly aadstsCode: string;
  constructor(status: number, aadstsCode: string) {
    super(`refresh token expired (${aadstsCode}): HTTP ${status}`, status, {
      category: 'human-action-required',
      retryable: false,
    });
    this.name = 'RefreshTokenExpiredError';
    this.aadstsCode = aadstsCode;
  }
}

/** Fixed lifetime of a Microsoft SPA refresh token. Cannot be extended by a
 *  refresh grant (AADSTS700084) — once past this age the only recovery is a
 *  fresh headless browser re-acquire. Shared by every SPA provider. */
export const SPA_REFRESH_TOKEN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Locally-detected "this refresh token cannot be used" — missing entirely, or
 * past the SPA 24h ceiling. Subclasses RefreshTokenExpiredError (and keeps that
 * name) so the broker's `isRefreshTokenExpired` predicate routes it to the
 * auto-reacquire / interactive-re-auth path instead of misclassifying it as a
 * transient refresh failure (which caused the 30s AD-slamming retry loop).
 * status 0 = no AAD round-trip occurred (detected before the network call).
 */
export class RefreshTokenUnusableError extends RefreshTokenExpiredError {
  constructor(message: string) {
    super(0, 'SPA_RT_UNUSABLE');
    this.name = 'RefreshTokenExpiredError';
    this.message = message;
  }
}

/** Resolve when the refresh token was acquired (extra.refreshTokenAcquiredAt),
 *  falling back to the bundle's acquiredAt. */
export function refreshTokenAcquiredAt(bundle: TokenBundle): number {
  const value = (bundle.extra as { refreshTokenAcquiredAt?: unknown } | undefined)?.refreshTokenAcquiredAt;
  return typeof value === 'number' ? value : bundle.acquiredAt;
}

/**
 * Throw a typed, broker-routable error if the bundle's refresh token is missing
 * or older than the SPA 24h ceiling. Callers pass the provider-specific
 * remediation messages so the operator-facing text stays accurate per service.
 * Runs BEFORE any network call, so a dead RT never hits the IdP.
 */
export function assertRefreshTokenUsable(
  bundle: TokenBundle,
  now: number,
  missingMsg: string,
  staleMsg: string,
): void {
  if (!bundle.refreshToken) throw new RefreshTokenUnusableError(missingMsg);
  if (now - refreshTokenAcquiredAt(bundle) >= SPA_REFRESH_TOKEN_MAX_AGE_MS) {
    throw new RefreshTokenUnusableError(staleMsg);
  }
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

export async function defaultFetcher(url: string, opts: { method: 'POST'; headers: Record<string, string>; body: string }): Promise<OauthTokenResponse> {
  const r = await fetch(url, opts);
  if (!r.ok) {
    const text = await r.text();
    const match = text.match(AADSTS_REFRESH_EXPIRED);
    if (match) throw new RefreshTokenExpiredError(r.status, match[0]);
    const retryAfterMs = parseRetryAfterMs(r.headers?.get('retry-after') ?? null);
    const challenge = classifyConditionalAccessChallenge({
      message: text,
      status: r.status,
      retryAfterMs,
    });
    if (challenge) throw new ConditionalAccessChallengeError(challenge);
    if (TRANSIENT_HTTP_STATUS.has(r.status)) {
      throw new OAuthRefreshError(`transient refresh failure: HTTP ${r.status}: ${text}`, r.status, {
        category: 'transient',
        retryable: true,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      });
    }
    throw new OAuthRefreshError(`HTTP ${r.status}: ${text}`, r.status, {
      category: 'terminal',
      retryable: false,
    });
  }
  return (await r.json()) as OauthTokenResponse;
}
