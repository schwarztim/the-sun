import { describe, it, expect, vi, beforeEach } from 'vitest';
import { silentRefresh, defaultFetcher, OAuthRefreshError, RefreshTokenExpiredError, RefreshTokenUnusableError, assertRefreshTokenUsable, SPA_REFRESH_TOKEN_MAX_AGE_MS, type OauthFetcher, type TokenBundle } from '../src/refresh.js';

const bundle = (refreshToken: string | undefined, scheme = 'graph'): TokenBundle => ({
  service: 'ms365', scheme, accessToken: 'old', refreshToken, tokenType: 'Bearer',
  expiresAt: Date.now() - 60_000, acquiredAt: Date.now() - 3600_000,
});

describe('silentRefresh', () => {
  let fetcher: OauthFetcher;
  const scopes = ['https://graph.microsoft.com/.default', 'offline_access'];

  beforeEach(() => {
    fetcher = vi.fn(async () => ({
      access_token: 'new-token', refresh_token: 'new-refresh', token_type: 'Bearer',
      expires_in: 3600, scope: 'https://graph.microsoft.com/.default',
    }));
  });

  it('posts form body with refresh_token grant', async () => {
    await silentRefresh({ fetcher, tenant: 'common', clientId: 'cid', bundle: bundle('rt'), scopes });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, opts] = (fetcher as any).mock.calls[0];
    expect(url).toContain('common/oauth2/v2.0/token');
    expect(opts.body).toContain('grant_type=refresh_token');
    expect(opts.body).toContain('refresh_token=rt');
    expect(opts.body).toContain('client_id=cid');
  });

  it('returns new TokenBundle with computed expiresAt', async () => {
    const result = await silentRefresh({ fetcher, tenant: 'common', clientId: 'cid', bundle: bundle('rt'), scopes });
    expect(result.accessToken).toBe('new-token');
    expect(result.refreshToken).toBe('new-refresh');
    expect(result.expiresAt).toBeGreaterThan(Date.now() + 3_500_000);
    expect(result.service).toBe('ms365');
    expect(result.scheme).toBe('graph');
  });

  it('throws when bundle has no refresh_token', async () => {
    await expect(silentRefresh({ fetcher, tenant: 'common', clientId: 'cid', bundle: bundle(undefined), scopes })).rejects.toThrow(/no refresh_token/);
  });

  it('throws when fetcher returns error', async () => {
    fetcher = vi.fn(async () => { throw new Error('HTTP 400: invalid_grant'); });
    await expect(silentRefresh({ fetcher, tenant: 'common', clientId: 'cid', bundle: bundle('rt'), scopes })).rejects.toThrow(/invalid_grant/);
  });
});

describe('defaultFetcher AADSTS detection', () => {
  it('throws RefreshTokenExpiredError for AADSTS70000', async () => {
    const mockResponse = {
      ok: false,
      status: 400,
      text: async () => '{"error":"invalid_grant","error_description":"AADSTS70000: The refresh token has expired."}',
    } as unknown as Response;
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse);

    const err = await defaultFetcher('https://example.com/token', {
      method: 'POST', headers: {}, body: '',
    }).catch((e) => e);

    expect(err).toBeInstanceOf(RefreshTokenExpiredError);
    expect(err.aadstsCode).toBe('AADSTS70000');
    expect(err.message).toContain('refresh token expired');
    vi.restoreAllMocks();
  });

  it('throws RefreshTokenExpiredError for AADSTS700003', async () => {
    const mockResponse = {
      ok: false,
      status: 400,
      text: async () => '{"error":"invalid_grant","error_description":"AADSTS700003: Token expired."}',
    } as unknown as Response;
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse);

    const err = await defaultFetcher('https://example.com/token', {
      method: 'POST', headers: {}, body: '',
    }).catch((e) => e);

    expect(err).toBeInstanceOf(RefreshTokenExpiredError);
    expect(err.aadstsCode).toBe('AADSTS700003');
    vi.restoreAllMocks();
  });

  it('throws RefreshTokenExpiredError for AADSTS700084 SPA refresh token expiry', async () => {
    const mockResponse = {
      ok: false,
      status: 400,
      text: async () => '{"error":"invalid_grant","error_description":"AADSTS700084: The refresh token was issued to a single page app (SPA), and therefore has a fixed, limited lifetime."}',
    } as unknown as Response;
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse);

    const err = await defaultFetcher('https://example.com/token', {
      method: 'POST', headers: {}, body: '',
    }).catch((e) => e);

    expect(err).toBeInstanceOf(RefreshTokenExpiredError);
    expect(err.aadstsCode).toBe('AADSTS700084');
    vi.restoreAllMocks();
  });

  it('throws generic Error for non-AADSTS failures', async () => {
    const mockResponse = {
      ok: false,
      status: 500,
      text: async () => 'internal server error',
    } as unknown as Response;
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse);

    const err = await defaultFetcher('https://example.com/token', {
      method: 'POST', headers: {}, body: '',
    }).catch((e) => e);

    expect(err).not.toBeInstanceOf(RefreshTokenExpiredError);
    expect(err).toBeInstanceOf(OAuthRefreshError);
    expect(err.retryable).toBe(true);
    expect(err.category).toBe('transient');
    expect(err.message).toContain('HTTP 500');
    vi.restoreAllMocks();
  });

  it('classifies 429 as retryable with retry-after metadata', async () => {
    const mockResponse = {
      ok: false,
      status: 429,
      headers: { get: (name: string) => (name.toLowerCase() === 'retry-after' ? '2' : null) },
      text: async () => 'rate limited',
    } as unknown as Response;
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse);

    const err = await defaultFetcher('https://example.com/token', {
      method: 'POST', headers: {}, body: '',
    }).catch((e) => e);

    expect(err).toBeInstanceOf(OAuthRefreshError);
    expect(err.category).toBe('transient');
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBe(2000);
    vi.restoreAllMocks();
  });

  it('classifies non-expiry invalid_grant as terminal', async () => {
    const mockResponse = {
      ok: false,
      status: 400,
      text: async () => '{"error":"invalid_grant","error_description":"not an expiry code"}',
    } as unknown as Response;
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse);

    const err = await defaultFetcher('https://example.com/token', {
      method: 'POST', headers: {}, body: '',
    }).catch((e) => e);

    expect(err).toBeInstanceOf(OAuthRefreshError);
    expect(err.category).toBe('terminal');
    expect(err.retryable).toBe(false);
    vi.restoreAllMocks();
  });

  it('throws ConditionalAccessChallengeError for classifiable AADSTS auth challenges', async () => {
    const mockResponse = {
      ok: false,
      status: 400,
      headers: { get: () => null },
      text: async () => '{"error":"interaction_required","error_description":"AADSTS50076: multi-factor authentication is required."}',
    } as unknown as Response;
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse);

    const err = await defaultFetcher('https://example.com/token', {
      method: 'POST', headers: {}, body: '',
    }).catch((e) => e);

    expect(err.name).toBe('ConditionalAccessChallengeError');
    expect(err.challenge).toMatchObject({
      state: 'mfa_or_totp_required',
      remediationCommands: [],
    });
    vi.restoreAllMocks();
  });
});

// Mirrors broker.ts:14 isRefreshTokenExpired. The fix hinges on the dead-RT
// assert error satisfying this so the broker routes it to recovery, not the
// transient 30s retry loop.
function isRefreshTokenExpired(err: unknown): boolean {
  return err instanceof Error && err.name === 'RefreshTokenExpiredError' && 'aadstsCode' in err;
}

const rtBundle = (overrides: Partial<TokenBundle> = {}): TokenBundle => ({
  service: 'ms365', scheme: 'graph', accessToken: 'at', refreshToken: 'rt',
  tokenType: 'Bearer', expiresAt: 0, acquiredAt: 0, ...overrides,
});

describe('assertRefreshTokenUsable', () => {
  const now = 1_700_000_000_000;

  it('does not throw for a fresh refresh token within the 24h window', () => {
    const b = rtBundle({ extra: { refreshTokenAcquiredAt: now - 60_000 } });
    expect(() => assertRefreshTokenUsable(b, now, 'missing', 'stale')).not.toThrow();
  });

  it('throws a broker-routable error when the refresh token is MISSING', () => {
    const b = rtBundle({ refreshToken: undefined });
    let caught: unknown;
    try { assertRefreshTokenUsable(b, now, 'no-rt remediation', 'stale'); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(RefreshTokenUnusableError);
    expect(isRefreshTokenExpired(caught)).toBe(true);            // load-bearing invariant
    expect((caught as Error).message).toBe('no-rt remediation'); // provider message preserved
  });

  it('throws a broker-routable error when the refresh token is older than 24h', () => {
    const b = rtBundle({ extra: { refreshTokenAcquiredAt: now - SPA_REFRESH_TOKEN_MAX_AGE_MS - 1 } });
    let caught: unknown;
    try { assertRefreshTokenUsable(b, now, 'missing', '>24h remediation'); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(RefreshTokenUnusableError);
    expect(isRefreshTokenExpired(caught)).toBe(true);
    expect((caught as Error).message).toBe('>24h remediation');
  });

  it('RefreshTokenUnusableError is also a RefreshTokenExpiredError (status 0, no AAD round-trip)', () => {
    const err = new RefreshTokenUnusableError('x');
    expect(err).toBeInstanceOf(RefreshTokenExpiredError);
    expect(err.status).toBe(0);
    expect(err.aadstsCode).toBe('SPA_RT_UNUSABLE');
    expect(err.retryable).toBe(false);
  });
});
