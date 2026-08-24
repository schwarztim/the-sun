import { describe, it, expect, vi } from 'vitest';
import { AkamaiWsaProvider } from '../src/provider.js';
import { AkamaiWsaConfigSchema } from '../src/config.js';
import type { TokenBundle, ProviderContext } from '@hermes/broker';

const nullLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
function ctx(config: Record<string, unknown>): ProviderContext {
  return { service: 'akamai-wsa', config, dataDir: '/tmp/hermes-test', logger: nullLogger };
}

describe('AkamaiWsaProvider', () => {
  it('has correct name and schemes', () => {
    const p = new AkamaiWsaProvider({ now: () => Date.now() });
    expect(p.name).toBe('akamai-wsa');
    expect(p.schemes).toEqual(['session']);
  });

  it('exposes session capabilities and remediation hints', () => {
    const p = new AkamaiWsaProvider({ now: () => Date.now() });
    expect(p.capabilities?.headless).toBe(true);
    expect(p.capabilities?.schemes[0]).toMatchObject({
      scheme: 'session',
      credentialSource: 'cookie-session',
      refreshStrategy: 'reacquire',
      validationStrategy: 'service-probe',
    });
    expect(p.capabilities?.remediation.refresh).toContain('re-acquire');
  });

  it('validate calls heartbeat and returns true on 200', async () => {
    const httpFetch = vi.fn(async () => ({ ok: true, status: 200 })) as any;
    const p = new AkamaiWsaProvider({ now: () => Date.now(), httpFetch });
    const bundle: TokenBundle = {
      service: 'akamai-wsa', scheme: 'session',
      accessToken: 'xsrf-token-value',
      tokenType: 'XSRF', expiresAt: Date.now() + 3600_000, acquiredAt: Date.now(),
      extra: {
        cookies: 'AKASSO=abc; XSRF-TOKEN=def',
        xsrfToken: 'xsrf-token-value',
        baseUrl: 'https://control.akamai.com',
      },
    };
    expect(await p.validate(ctx({ loginHint: 'u@e.com' }), bundle)).toBe(true);
    expect(httpFetch).toHaveBeenCalledWith(
      'https://control.akamai.com/ids-sso/v2/session/heartbeat',
      expect.objectContaining({
        method: 'POST',
        body: '{}',
        headers: expect.objectContaining({
          Cookie: 'AKASSO=abc; XSRF-TOKEN=def',
          'X-XSRF-TOKEN': 'xsrf-token-value',
          'Content-Type': 'application/json',
        }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('validate returns false on 401', async () => {
    const httpFetch = vi.fn(async () => ({ ok: false, status: 401 })) as any;
    const p = new AkamaiWsaProvider({ now: () => Date.now(), httpFetch });
    const bundle: TokenBundle = {
      service: 'akamai-wsa', scheme: 'session',
      accessToken: 'expired',
      tokenType: 'XSRF', expiresAt: Date.now() - 1000, acquiredAt: Date.now() - 3600_000,
      extra: { cookies: 'expired', xsrfToken: 'expired' },
    };
    expect(await p.validate(ctx({ loginHint: 'u@e.com' }), bundle)).toBe(false);
  });

  it('validate returns false when cookies missing from extra', async () => {
    const p = new AkamaiWsaProvider({ now: () => Date.now() });
    const bundle: TokenBundle = {
      service: 'akamai-wsa', scheme: 'session',
      accessToken: 'xsrf',
      tokenType: 'XSRF', expiresAt: Date.now() + 3600_000, acquiredAt: Date.now(),
    };
    expect(await p.validate(ctx({ loginHint: 'u@e.com' }), bundle)).toBe(false);
  });

  it('validate returns false for locale-only cookies captured before auth completes', async () => {
    const httpFetch = vi.fn(async () => ({ ok: true, status: 200 })) as any;
    const p = new AkamaiWsaProvider({ now: () => Date.now(), httpFetch });
    const bundle: TokenBundle = {
      service: 'akamai-wsa', scheme: 'session',
      accessToken: '',
      tokenType: 'XSRF', expiresAt: Date.now() + 3600_000, acquiredAt: Date.now(),
      extra: { cookies: 'AKALOCALE=en_US', xsrfToken: '' },
    };

    expect(await p.validate(ctx({ loginHint: 'u@e.com' }), bundle)).toBe(false);
    expect(httpFetch).not.toHaveBeenCalled();
  });

  it('validate returns false on network error', async () => {
    const httpFetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as any;
    const p = new AkamaiWsaProvider({ now: () => Date.now(), httpFetch });
    const bundle: TokenBundle = {
      service: 'akamai-wsa', scheme: 'session',
      accessToken: 'xsrf',
      tokenType: 'XSRF', expiresAt: Date.now() + 3600_000, acquiredAt: Date.now(),
      extra: { cookies: 'AKASSO=abc', xsrfToken: 'xsrf' },
    };
    expect(await p.validate(ctx({ loginHint: 'u@e.com' }), bundle)).toBe(false);
  });

  it('nextRefreshAt returns 1 hour before expiry', () => {
    const p = new AkamaiWsaProvider({ now: () => Date.now() });
    const expiresAt = Date.now() + 8 * 60 * 60 * 1000;
    const bundle: TokenBundle = {
      service: 'akamai-wsa', scheme: 'session',
      accessToken: 'xsrf', tokenType: 'XSRF',
      expiresAt, acquiredAt: Date.now(),
    };
    const next = p.nextRefreshAt(bundle);
    expect(next.getTime()).toBe(expiresAt - 60 * 60 * 1000);
  });

  it('acquire throws when config is missing loginHint', async () => {
    const p = new AkamaiWsaProvider({ now: () => 0 });
    await expect(p.acquire(ctx({}), 'session')).rejects.toThrow();
  });

  it('rejects headless: false in config', () => {
    expect(() => AkamaiWsaConfigSchema.parse({ loginHint: 'u@e.com', headless: false })).toThrow();
  });
});
