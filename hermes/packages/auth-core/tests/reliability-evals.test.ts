import { describe, expect, it, vi } from 'vitest';
import { defaultFetcher, RefreshTokenExpiredError } from '../src/refresh.js';

describe('auth reliability evals', () => {
  it('classifies historical AADSTS700084 SPA refresh-token expiry as terminal reauth-required evidence', async () => {
    const mockResponse = {
      ok: false,
      status: 400,
      text: async () => JSON.stringify({
        error: 'invalid_grant',
        error_description: 'AADSTS700084: The refresh token was issued to a single page app (SPA), and therefore has a fixed, limited lifetime.',
      }),
    } as unknown as Response;
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse);

    const err = await defaultFetcher('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      method: 'POST',
      headers: {},
      body: 'grant_type=refresh_token',
    }).catch((e) => e);

    expect(err).toBeInstanceOf(RefreshTokenExpiredError);
    expect(err).toMatchObject({
      aadstsCode: 'AADSTS700084',
      retryable: false,
      category: 'human-action-required',
    });
    vi.restoreAllMocks();
  });
});
