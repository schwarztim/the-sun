import { describe, it, expect, vi } from 'vitest';
import { OAuth2Provider } from '../src/provider.js';
import { OAuth2ConfigSchema } from '../src/config.js';
import type { BrowserAuth, BrowserAuthResult } from '@hermes/auth-core';
import type { TokenBundle, ProviderContext } from '@hermes/broker';

const nullLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
function ctx(config: Record<string, unknown>): ProviderContext {
  return { service: 'azure-devops', config, dataDir: '/tmp/hermes-test', logger: nullLogger };
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

const baseConfig = {
  loginHint: 'u@e.com',
  clientId: 'test-client-id',
  scopes: ['https://graph.microsoft.com/.default', 'offline_access'],
};

describe('OAuth2Provider', () => {
  it('acquire returns TokenBundle from mock browser', async () => {
    const browser = mockBrowser();
    const p = new OAuth2Provider({ browser, fetcher: async () => mockResult as any, now: () => 1_000_000_000_000 });
    const bundle = await p.acquire(ctx(baseConfig), 'token');
    expect(bundle.accessToken).toBe(mockResult.accessToken);
    expect(bundle.service).toBe('azure-devops');
    expect(bundle.scheme).toBe('token');
    expect(bundle.expiresAt).toBe(1_000_000_000_000 + 3600_000);
    expect(bundle.extra?.refreshTokenAcquiredAt).toBe(1_000_000_000_000);
    expect(browser.login).toHaveBeenCalledWith(expect.objectContaining({
      loginHint: 'u@e.com',
      scheme: 'token',
      scopes: baseConfig.scopes,
      redirectUri: 'https://login.microsoftonline.com/common/oauth2/nativeclient',
    }));
  });

  it('exposes provider capabilities and remediation hints', () => {
    const p = new OAuth2Provider({ browser: mockBrowser(), fetcher: async () => mockResult as any, now: () => Date.now() });
    expect(p.capabilities?.headless).toBe(true);
    expect(p.capabilities?.schemes[0]).toMatchObject({
      scheme: 'token',
      credentialSource: 'oauth',
      refreshStrategy: 'refresh-token',
      supportsValidation: true,
    });
    expect(p.capabilities?.schemes[0]?.refreshTokenMaxAgeMs).toBe(24 * 60 * 60 * 1000);
    expect(p.capabilities?.remediation.refresh).toContain('hermes acquire');
  });

  it('refresh calls silentRefresh with correct scopes', async () => {
    const fetcher = vi.fn(async () => ({ access_token: 'refreshed', token_type: 'Bearer', expires_in: 3600, refresh_token: 'new-rt' }));
    const p = new OAuth2Provider({ browser: mockBrowser(), fetcher: fetcher as any, now: () => Date.now() });
    const bundle: TokenBundle = {
      service: 'azure-devops', scheme: 'token', accessToken: 'old', refreshToken: 'rt',
      tokenType: 'Bearer', expiresAt: Date.now() - 1000, acquiredAt: Date.now() - 3600_000,
    };
    const refreshed = await p.refresh(ctx(baseConfig), bundle);
    expect(refreshed.accessToken).toBe('refreshed');
    expect(refreshed.extra?.refreshTokenAcquiredAt).toBeTypeOf('number');
    expect(fetcher).toHaveBeenCalled();
  });

  it('refresh rejects stale SPA refresh tokens with remediation before calling token endpoint', async () => {
    const fetcher = vi.fn(async () => ({ access_token: 'refreshed', token_type: 'Bearer', expires_in: 3600 }));
    const now = 1_000_000_000_000;
    const p = new OAuth2Provider({ browser: mockBrowser(), fetcher: fetcher as any, now: () => now });
    const bundle: TokenBundle = {
      service: 'azure-devops', scheme: 'token', accessToken: 'old', refreshToken: 'rt',
      tokenType: 'Bearer', expiresAt: now - 1000, acquiredAt: now - 25 * 60 * 60 * 1000,
    };
    await expect(p.refresh(ctx(baseConfig), bundle)).rejects.toThrow(/older than 24h.*hermes acquire/s);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('validate hits validateUrl and returns true on 200', async () => {
    const httpFetch = vi.fn(async () => ({ ok: true, status: 200 })) as any;
    const p = new OAuth2Provider({ browser: mockBrowser(), fetcher: async () => mockResult as any, now: () => Date.now(), httpFetch });
    const bundle: TokenBundle = {
      service: 'azure-devops', scheme: 'token', accessToken: 'abc',
      tokenType: 'Bearer', expiresAt: Date.now() + 3600_000, acquiredAt: Date.now(),
    };
    const config = { ...baseConfig, validateUrl: 'https://dev.azure.com/_apis/connectionData' };
    expect(await p.validate(ctx(config), bundle)).toBe(true);
    expect(httpFetch).toHaveBeenCalledWith('https://dev.azure.com/_apis/connectionData', expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer abc' }) }));
  });

  it('validate returns false when validateUrl returns 401', async () => {
    const httpFetch = vi.fn(async () => ({ ok: false, status: 401 })) as any;
    const p = new OAuth2Provider({ browser: mockBrowser(), fetcher: async () => mockResult as any, now: () => Date.now(), httpFetch });
    const bundle: TokenBundle = {
      service: 'azure-devops', scheme: 'token', accessToken: 'abc',
      tokenType: 'Bearer', expiresAt: Date.now() + 3600_000, acquiredAt: Date.now(),
    };
    const config = { ...baseConfig, validateUrl: 'https://dev.azure.com/_apis/connectionData' };
    expect(await p.validate(ctx(config), bundle)).toBe(false);
  });

  it('validate falls back to JWT exp check when no validateUrl', async () => {
    const nowMs = Date.now();
    const futureExp = Math.floor(nowMs / 1000) + 3600;
    const p = new OAuth2Provider({ browser: mockBrowser(), fetcher: async () => mockResult as any, now: () => nowMs });
    const bundle: TokenBundle = {
      service: 'azure-devops', scheme: 'token', accessToken: jwt(futureExp),
      tokenType: 'Bearer', expiresAt: futureExp * 1000, acquiredAt: nowMs,
    };
    expect(await p.validate(ctx(baseConfig), bundle)).toBe(true);
  });

  it('validate returns false for expired JWT when no validateUrl', async () => {
    const nowMs = Date.now();
    const pastExp = Math.floor(nowMs / 1000) - 60;
    const p = new OAuth2Provider({ browser: mockBrowser(), fetcher: async () => mockResult as any, now: () => nowMs });
    const bundle: TokenBundle = {
      service: 'azure-devops', scheme: 'token', accessToken: jwt(pastExp),
      tokenType: 'Bearer', expiresAt: pastExp * 1000, acquiredAt: nowMs - 3600_000,
    };
    expect(await p.validate(ctx(baseConfig), bundle)).toBe(false);
  });

  it('nextRefreshAt reads JWT exp and applies safety margin', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const expSec = nowSec + 3600;
    const p = new OAuth2Provider({ browser: mockBrowser(), fetcher: async () => mockResult as any, now: () => Date.now() });
    const bundle: TokenBundle = {
      service: 'azure-devops', scheme: 'token', accessToken: jwt(expSec),
      tokenType: 'Bearer', expiresAt: expSec * 1000, acquiredAt: Date.now(),
    };
    const next = p.nextRefreshAt(bundle);
    expect(next.getTime()).toBeLessThan(expSec * 1000);
    expect(expSec * 1000 - next.getTime()).toBeGreaterThanOrEqual(300_000);
  });

  it('rejects headless: false in config', () => {
    expect(() => OAuth2ConfigSchema.parse({ loginHint: 'u@e.com', clientId: 'test-client-id', scopes: ['https://graph.microsoft.com/.default'], headless: false })).toThrow();
  });
});
