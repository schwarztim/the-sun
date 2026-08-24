import { describe, it, expect, vi } from 'vitest';
import { Ms365Provider } from '../src/provider.js';
import type { BrowserAuth, BrowserAuthResult } from '@hermes/auth-core';
import type { TokenBundle, ProviderContext } from '@hermes/broker';

const nullLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
function ctx(config: Record<string, unknown>): ProviderContext {
  return { service: 'ms365', config, dataDir: '/tmp/hermes-test', logger: nullLogger };
}
function jwt(expSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url');
  return `${header}.${payload}.sig`;
}

const mockResult: BrowserAuthResult = {
  accessToken: jwt(Math.floor(Date.now() / 1000) + 3600),
  refreshToken: 'rt', expiresIn: 3600, scope: 'https://graph.microsoft.com/.default',
};

function mockBrowser(result: BrowserAuthResult | Error = mockResult): BrowserAuth {
  return {
    login: vi.fn(async () => { if (result instanceof Error) throw result; return result; }),
    loginAll: vi.fn(async () => new Map()),
    close: vi.fn(async () => {}),
  };
}

describe('Ms365Provider', () => {
  it('acquire returns TokenBundle', async () => {
    const browser = mockBrowser();
    const p = new Ms365Provider({ browser, fetcher: async () => mockResult as any, now: () => 1_000_000_000_000 });
    const bundle = await p.acquire(ctx({ loginHint: 'u@e.com' }), 'graph');
    expect(bundle.accessToken).toBe(mockResult.accessToken);
    expect(bundle.service).toBe('ms365');
    expect(bundle.scheme).toBe('graph');
    expect(bundle.expiresAt).toBe(1_000_000_000_000 + 3600_000);
    expect(bundle.extra?.refreshTokenAcquiredAt).toBe(1_000_000_000_000);
    expect(browser.login).toHaveBeenCalledWith(expect.objectContaining({ loginHint: 'u@e.com', scheme: 'graph' }));
  });
  it('exposes provider capabilities and remediation hints', () => {
    const p = new Ms365Provider({ browser: mockBrowser(), fetcher: async () => mockResult as any, now: () => Date.now() });
    expect(p.capabilities?.headless).toBe(true);
    expect(p.capabilities?.schemes).toEqual(expect.arrayContaining([
      expect.objectContaining({ scheme: 'graph', credentialSource: 'oauth', refreshStrategy: 'refresh-token', supportsValidation: true }),
      expect.objectContaining({ scheme: 'teams', credentialSource: 'oauth', refreshTokenMaxAgeMs: 24 * 60 * 60 * 1000 }),
    ]));
    expect(p.capabilities?.remediation.refresh).toContain('hermes acquire ms365');
  });
  it('acquire throws when config is missing loginHint', async () => {
    const p = new Ms365Provider({ browser: mockBrowser(), fetcher: async () => mockResult as any, now: () => 0 });
    await expect(p.acquire(ctx({}), 'graph')).rejects.toThrow(/loginHint/);
  });
  it('validate calls Graph /me and returns true on 200', async () => {
    const httpFetch = vi.fn(async () => ({ ok: true, status: 200 })) as any;
    const p = new Ms365Provider({ browser: mockBrowser(), fetcher: async () => mockResult as any, now: () => Date.now(), httpFetch });
    const bundle: TokenBundle = { service: 'ms365', scheme: 'graph', accessToken: 'abc', tokenType: 'Bearer', expiresAt: Date.now() + 3600_000, acquiredAt: Date.now() };
    expect(await p.validate(ctx({ loginHint: 'u@e.com' }), bundle)).toBe(true);
    expect(httpFetch).toHaveBeenCalledWith('https://graph.microsoft.com/v1.0/me', expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer abc' }) }));
  });
  it('validate returns false on 401', async () => {
    const httpFetch = vi.fn(async () => ({ ok: false, status: 401 })) as any;
    const p = new Ms365Provider({ browser: mockBrowser(), fetcher: async () => mockResult as any, now: () => Date.now(), httpFetch });
    const bundle: TokenBundle = { service: 'ms365', scheme: 'graph', accessToken: 'abc', tokenType: 'Bearer', expiresAt: Date.now() + 3600_000, acquiredAt: Date.now() };
    expect(await p.validate(ctx({ loginHint: 'u@e.com' }), bundle)).toBe(false);
  });
  it('nextRefreshAt reads JWT exp and applies safety margin', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const expSec = nowSec + 3600;
    const p = new Ms365Provider({ browser: mockBrowser(), fetcher: async () => mockResult as any, now: () => Date.now() });
    const bundle: TokenBundle = { service: 'ms365', scheme: 'graph', accessToken: jwt(expSec), tokenType: 'Bearer', expiresAt: expSec * 1000, acquiredAt: Date.now() };
    const next = p.nextRefreshAt(bundle);
    expect(next.getTime()).toBeLessThan(expSec * 1000);
    expect(expSec * 1000 - next.getTime()).toBeGreaterThanOrEqual(300_000);
  });
  it('refresh delegates to silentRefresh', async () => {
    const fetcher = vi.fn(async () => ({ access_token: 'refreshed', token_type: 'Bearer', expires_in: 3600, refresh_token: 'new-rt' }));
    const p = new Ms365Provider({ browser: mockBrowser(), fetcher: fetcher as any, now: () => Date.now() });
    const bundle: TokenBundle = { service: 'ms365', scheme: 'graph', accessToken: 'old', refreshToken: 'rt', tokenType: 'Bearer', expiresAt: Date.now() - 1000, acquiredAt: Date.now() - 3600_000 };
    const refreshed = await p.refresh(ctx({ loginHint: 'u@e.com' }), bundle);
    expect(refreshed.accessToken).toBe('refreshed');
    expect(refreshed.extra?.refreshTokenAcquiredAt).toBeTypeOf('number');
    expect(fetcher).toHaveBeenCalled();
  });
  it('refresh rejects stale refresh tokens before calling AAD', async () => {
    const fetcher = vi.fn(async () => ({ access_token: 'refreshed', token_type: 'Bearer', expires_in: 3600 }));
    const now = 1_000_000_000_000;
    const p = new Ms365Provider({ browser: mockBrowser(), fetcher: fetcher as any, now: () => now });
    const bundle: TokenBundle = {
      service: 'ms365', scheme: 'graph', accessToken: 'old', refreshToken: 'rt',
      tokenType: 'Bearer', expiresAt: now - 1000, acquiredAt: now - 25 * 60 * 60 * 1000,
    };
    await expect(p.refresh(ctx({ loginHint: 'u@e.com' }), bundle)).rejects.toThrow(/older than 24h.*hermes acquire ms365/s);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
