import { describe, it, expect, vi } from 'vitest';
import { DynatraceProvider } from '../src/provider.js';
import { DynatraceConfigSchema } from '../src/config.js';
import type { TokenBundle, ProviderContext } from '@hermes/broker';

const nullLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
function ctx(config: Record<string, unknown>): ProviderContext {
  return { service: 'dynatrace', config, dataDir: '/tmp/hermes-test', logger: nullLogger };
}

describe('DynatraceProvider', () => {
  it('has correct name and schemes', () => {
    const p = new DynatraceProvider({ now: () => Date.now() });
    expect(p.name).toBe('dynatrace');
    expect(p.schemes).toEqual(['session', 'api-token']);
  });

  it('exposes per-scheme capabilities for session and api-token sources', () => {
    const p = new DynatraceProvider({ now: () => Date.now() });
    expect(p.capabilities?.headless).toBe(true);
    expect(p.capabilities?.schemes).toEqual(expect.arrayContaining([
      expect.objectContaining({ scheme: 'session', credentialSource: 'cookie-session', refreshStrategy: 'reacquire' }),
      expect.objectContaining({ scheme: 'api-token', credentialSource: 'api-token', validationStrategy: 'http' }),
    ]));
    expect(p.capabilities?.remediation.acquire).toContain('apiToken');
  });

  // --- api-token scheme ---

  it('acquire returns static token for api-token scheme', async () => {
    const now = 1700000000000;
    const p = new DynatraceProvider({ now: () => now });
    const bundle = await p.acquire(
      ctx({ environmentId: 'adk00977', apiToken: 'dt0c01.FAKE_TOKEN' }),
      'api-token',
    );
    expect(bundle.scheme).toBe('api-token');
    expect(bundle.accessToken).toBe('dt0c01.FAKE_TOKEN');
    expect(bundle.tokenType).toBe('Api-Token');
    expect(bundle.acquiredAt).toBe(now);
    expect(bundle.expiresAt).toBe(now + 24 * 60 * 60 * 1000);
    expect((bundle.extra as Record<string, unknown>)?.environmentId).toBe('adk00977');
  });

  it('acquire throws when apiToken missing for api-token scheme', async () => {
    const p = new DynatraceProvider({ now: () => 0 });
    await expect(
      p.acquire(ctx({ environmentId: 'adk00977' }), 'api-token'),
    ).rejects.toThrow('apiToken is required');
  });

  // --- validate (api-token) ---

  it('validate calls entities API with Api-Token header on api-token scheme', async () => {
    const httpFetch = vi.fn(async () => ({ ok: true, status: 200 })) as any;
    const p = new DynatraceProvider({ now: () => Date.now(), httpFetch });
    const bundle: TokenBundle = {
      service: 'dynatrace', scheme: 'api-token',
      accessToken: 'dt0c01.FAKE', tokenType: 'Api-Token',
      expiresAt: Date.now() + 86400_000, acquiredAt: Date.now(),
      extra: { environmentId: 'adk00977' },
    };
    expect(await p.validate(ctx({ environmentId: 'adk00977' }), bundle)).toBe(true);
    expect(httpFetch).toHaveBeenCalledWith(
      'https://adk00977.apps.dynatrace.com/platform/classic/environment-api/v2/entities?pageSize=1&entitySelector=type("SERVICE")',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Api-Token dt0c01.FAKE' }),
      }),
    );
  });

  it('validate returns false on 401 for api-token', async () => {
    const httpFetch = vi.fn(async () => ({ ok: false, status: 401 })) as any;
    const p = new DynatraceProvider({ now: () => Date.now(), httpFetch });
    const bundle: TokenBundle = {
      service: 'dynatrace', scheme: 'api-token',
      accessToken: 'revoked-token', tokenType: 'Api-Token',
      expiresAt: Date.now() + 86400_000, acquiredAt: Date.now(),
    };
    expect(await p.validate(ctx({ environmentId: 'adk00977' }), bundle)).toBe(false);
  });

  it('validate treats api-token 5xx and network errors as inconclusive but usable', async () => {
    const p5xx = new DynatraceProvider({
      now: () => Date.now(),
      httpFetch: vi.fn(async () => ({ ok: false, status: 503 })) as any,
    });
    const pNetwork = new DynatraceProvider({
      now: () => Date.now(),
      httpFetch: vi.fn(async () => { throw new Error('ECONNRESET'); }) as any,
    });
    const bundle: TokenBundle = {
      service: 'dynatrace', scheme: 'api-token',
      accessToken: 'dt0c01.FAKE', tokenType: 'Api-Token',
      expiresAt: Date.now() + 86400_000, acquiredAt: Date.now(),
    };
    expect(await p5xx.validate(ctx({ environmentId: 'adk00977' }), bundle)).toBe(true);
    expect(await pNetwork.validate(ctx({ environmentId: 'adk00977' }), bundle)).toBe(true);
  });

  it('acquire rejects unsupported schemes with remediation', async () => {
    const p = new DynatraceProvider({ now: () => 0 });
    await expect(p.acquire(ctx({ environmentId: 'adk00977' }), 'bogus')).rejects.toThrow(/unsupported dynatrace scheme.*Remediation/);
  });

  // --- validate (session) ---

  it('validate calls entities API with Cookie + XSRF on session scheme', async () => {
    const httpFetch = vi.fn(async () => ({ ok: true, status: 200 })) as any;
    const p = new DynatraceProvider({ now: () => Date.now(), httpFetch });
    const bundle: TokenBundle = {
      service: 'dynatrace', scheme: 'session',
      accessToken: 'SESSION-prod102-abc=xyz',
      tokenType: 'Cookie',
      expiresAt: Date.now() + 3600_000, acquiredAt: Date.now(),
      extra: { xsrfToken: 'xsrf-123', environmentId: 'adk00977' },
    };
    expect(await p.validate(ctx({ environmentId: 'adk00977' }), bundle)).toBe(true);
    expect(httpFetch).toHaveBeenCalledWith(
      'https://adk00977.apps.dynatrace.com/platform/classic/environment-api/v2/entities?pageSize=1&entitySelector=type("SERVICE")',
      expect.objectContaining({
        headers: expect.objectContaining({
          Cookie: 'SESSION-prod102-abc=xyz',
          'X-XSRF-TOKEN': 'xsrf-123',
        }),
      }),
    );
  });

  it('validate returns false on network error for session', async () => {
    const httpFetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as any;
    const p = new DynatraceProvider({ now: () => Date.now(), httpFetch });
    const bundle: TokenBundle = {
      service: 'dynatrace', scheme: 'session',
      accessToken: 'cookie',
      tokenType: 'Cookie', expiresAt: Date.now() + 3600_000, acquiredAt: Date.now(),
    };
    expect(await p.validate(ctx({ environmentId: 'adk00977' }), bundle)).toBe(false);
  });

  // --- nextRefreshAt ---

  it('nextRefreshAt returns 30 min before expiry for session', () => {
    const p = new DynatraceProvider({ now: () => Date.now() });
    const expiresAt = Date.now() + 4 * 60 * 60 * 1000;
    const bundle: TokenBundle = {
      service: 'dynatrace', scheme: 'session',
      accessToken: 'cookie', tokenType: 'Cookie',
      expiresAt, acquiredAt: Date.now(),
    };
    expect(p.nextRefreshAt(bundle).getTime()).toBe(expiresAt - 30 * 60 * 1000);
  });

  it('nextRefreshAt returns 1 hour before expiry for api-token', () => {
    const p = new DynatraceProvider({ now: () => Date.now() });
    const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
    const bundle: TokenBundle = {
      service: 'dynatrace', scheme: 'api-token',
      accessToken: 'token', tokenType: 'Api-Token',
      expiresAt, acquiredAt: Date.now(),
    };
    expect(p.nextRefreshAt(bundle).getTime()).toBe(expiresAt - 60 * 60 * 1000);
  });

  // --- config validation ---

  it('acquire throws when config is missing environmentId', async () => {
    const p = new DynatraceProvider({ now: () => 0 });
    await expect(p.acquire(ctx({}), 'session')).rejects.toThrow();
  });

  it('rejects headless: false in config', () => {
    expect(() => DynatraceConfigSchema.parse({ environmentId: 'adk00977', headless: false })).toThrow();
  });
});
