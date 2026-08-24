import { describe, expect, it, vi } from 'vitest';
import { CookieSessionProvider } from '../src/provider.js';
import type { ProviderContext, TokenBundle } from '@hermes/broker';

const nullLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => nullLogger };

function ctx(config: Record<string, unknown>): ProviderContext {
  return {
    service: 'venafi',
    config,
    dataDir: `${process.cwd()}/.test-data/cookie-session-reliability`,
    logger: nullLogger,
  };
}

describe('cookie-session reliability evals', () => {
  it('validates sessionStorage API credentials as bearer tokens, never as cookie headers', async () => {
    const httpFetch = vi.fn(async () => ({ ok: true, status: 200 })) as any;
    const provider = new CookieSessionProvider({ now: () => 1_700_000_000_000, httpFetch });
    const bundle: TokenBundle = {
      service: 'venafi',
      scheme: 'session',
      accessToken: 'session-storage-api-key',
      tokenType: 'SessionStorageToken',
      expiresAt: 1_700_003_600_000,
      acquiredAt: 1_700_000_000_000,
      extra: { sessionStorage: { apiKey: 'session-storage-api-key' } },
    };

    await expect(provider.validate(ctx({
      baseUrl: 'https://venafi.example.com',
      loginHint: 'operator@example.com',
      validatePath: '/vedsdk/authorize',
      sessionStorageTokenKey: 'apiKey',
      captureSessionStorageKeys: ['apiKey'],
    }), bundle)).resolves.toBe(true);

    expect(httpFetch).toHaveBeenCalledWith(
      'https://venafi.example.com/vedsdk/authorize',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer session-storage-api-key',
          Accept: 'application/json',
        }),
      }),
    );
    expect(httpFetch.mock.calls[0][1].headers).not.toHaveProperty('Cookie');
  });
});
