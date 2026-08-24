import { describe, it, expect, vi } from 'vitest';
import { AzureKeyVaultProvider } from '../src/provider.js';
import type { ProviderContext, TokenBundle } from '@hermes/broker';

const nullLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
function ctx(config: Record<string, unknown>): ProviderContext {
  return { service: 'azure-key-vault', config, dataDir: '/tmp/hermes-test', logger: nullLogger };
}
function jwt(expSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url');
  return `${header}.${payload}.sig`;
}

const FIXED_NOW = 1_000_000_000_000;
const EXPIRES_IN = 3600;

function makeTokenResponse(accessToken: string) {
  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: EXPIRES_IN,
  };
}

function mockFetch(responseBody: unknown, ok = true, status = 200) {
  return vi.fn(async () => ({
    ok,
    status,
    json: async () => responseBody,
  })) as any;
}

const baseConfig = {
  tenantId: 'tenant-abc',
  clientId: 'client-xyz',
  clientSecret: 'my-secret',
};

describe('AzureKeyVaultProvider', () => {
  it('exposes client-credentials capabilities and remediation hints', () => {
    const p = new AzureKeyVaultProvider({ now: () => FIXED_NOW });
    expect(p.capabilities?.headless).toBe(true);
    expect(p.capabilities?.schemes).toEqual(expect.arrayContaining([
      expect.objectContaining({ scheme: 'management', credentialSource: 'client-credentials', refreshStrategy: 'client-credentials' }),
      expect.objectContaining({ scheme: 'vault', validationStrategy: 'jwt-exp' }),
    ]));
    expect(p.capabilities?.remediation.refresh).toContain('client_credentials');
  });

  it('acquire returns TokenBundle with extra payload populated for management scope', async () => {
    const accessToken = jwt(Math.floor(FIXED_NOW / 1000) + EXPIRES_IN);
    const httpFetch = mockFetch(makeTokenResponse(accessToken));
    const p = new AzureKeyVaultProvider({ now: () => FIXED_NOW, httpFetch });

    const bundle = await p.acquire(ctx(baseConfig), 'management');

    expect(bundle.accessToken).toBe(accessToken);
    expect(bundle.service).toBe('azure-key-vault');
    expect(bundle.scheme).toBe('management');
    expect(bundle.scope).toBe('https://management.azure.com/.default');
    expect(bundle.expiresAt).toBe(FIXED_NOW + EXPIRES_IN * 1000);
    expect(bundle.extra).toBeDefined();
    expect(bundle.extra!.accessToken).toBe(accessToken);
    expect(bundle.extra!.tenantId).toBe('tenant-abc');
    expect(bundle.extra!.expiresAt).toBe(FIXED_NOW + EXPIRES_IN * 1000);
  });

  it('acquire returns TokenBundle for vault scope', async () => {
    const accessToken = jwt(Math.floor(FIXED_NOW / 1000) + EXPIRES_IN);
    const httpFetch = mockFetch(makeTokenResponse(accessToken));
    const p = new AzureKeyVaultProvider({ now: () => FIXED_NOW, httpFetch });

    const bundle = await p.acquire(ctx(baseConfig), 'vault');

    expect(bundle.scheme).toBe('vault');
    expect(bundle.scope).toBe('https://vault.azure.net/.default');
    expect(bundle.extra!.accessToken).toBe(accessToken);
  });

  it('acquire calls token endpoint with correct form body for management scope', async () => {
    const httpFetch = mockFetch(makeTokenResponse('tok'));
    const p = new AzureKeyVaultProvider({ now: () => FIXED_NOW, httpFetch });

    await p.acquire(ctx(baseConfig), 'management');

    expect(httpFetch).toHaveBeenCalledOnce();
    const [url, init] = httpFetch.mock.calls[0] as [string, { method: string; headers: Record<string, string>; body: string }];
    expect(url).toBe('https://login.microsoftonline.com/tenant-abc/oauth2/v2.0/token');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    const params = new URLSearchParams(init.body);
    expect(params.get('grant_type')).toBe('client_credentials');
    expect(params.get('client_id')).toBe('client-xyz');
    expect(params.get('client_secret')).toBe('my-secret');
    expect(params.get('scope')).toBe('https://management.azure.com/.default');
  });

  it('acquire pulls clientSecret from keychain when only keychain refs are set', async () => {
    const readKeychain = vi.fn(async () => 'keychain-secret');
    const httpFetch = mockFetch(makeTokenResponse('tok'));
    const p = new AzureKeyVaultProvider({ now: () => FIXED_NOW, httpFetch, readKeychain });

    const keychainConfig = {
      tenantId: 'tenant-abc',
      clientId: 'client-xyz',
      clientSecretKeychainService: 'my-service',
      clientSecretKeychainAccount: 'my-account',
    };
    await p.acquire(ctx(keychainConfig), 'management');

    expect(readKeychain).toHaveBeenCalledWith('my-service', 'my-account');
    const [, init] = httpFetch.mock.calls[0] as [string, { body: string }];
    const params = new URLSearchParams(init.body);
    expect(params.get('client_secret')).toBe('keychain-secret');
  });

  it('acquire throws when neither clientSecret nor keychain refs present', async () => {
    const httpFetch = mockFetch(makeTokenResponse('tok'));
    const p = new AzureKeyVaultProvider({ now: () => FIXED_NOW, httpFetch });

    const noSecretConfig = { tenantId: 'tenant-abc', clientId: 'client-xyz' };
    await expect(p.acquire(ctx(noSecretConfig), 'management')).rejects.toThrow(/clientSecret|keychain/i);
  });

  it('acquire throws when token endpoint returns 401', async () => {
    const errorBody = { error: 'invalid_client', error_description: 'AADSTS70011: The provided value for scope is not valid.' };
    const httpFetch = mockFetch(errorBody, false, 401);
    const p = new AzureKeyVaultProvider({ now: () => FIXED_NOW, httpFetch });

    await expect(p.acquire(ctx(baseConfig), 'management')).rejects.toThrow(/AADSTS70011/);
  });

  it('acquire rejects unsupported schemes before calling token endpoint', async () => {
    const httpFetch = mockFetch(makeTokenResponse('tok'));
    const p = new AzureKeyVaultProvider({ now: () => FIXED_NOW, httpFetch });
    await expect(p.acquire(ctx(baseConfig), 'bogus')).rejects.toThrow(/unsupported azure-keyvault scheme.*Remediation/);
    expect(httpFetch).not.toHaveBeenCalled();
  });

  it('acquire rejects malformed token endpoint success responses with remediation', async () => {
    const httpFetch = mockFetch({ token_type: 'Bearer', expires_in: EXPIRES_IN });
    const p = new AzureKeyVaultProvider({ now: () => FIXED_NOW, httpFetch });
    await expect(p.acquire(ctx(baseConfig), 'management')).rejects.toThrow(/missing access_token.*Remediation/);
  });

  it('refresh re-acquires with same scheme', async () => {
    const accessToken = jwt(Math.floor(FIXED_NOW / 1000) + EXPIRES_IN);
    const httpFetch = mockFetch(makeTokenResponse(accessToken));
    const p = new AzureKeyVaultProvider({ now: () => FIXED_NOW, httpFetch });

    const existingBundle: TokenBundle = {
      service: 'azure-key-vault', scheme: 'vault',
      accessToken: 'old-token', tokenType: 'Bearer',
      expiresAt: FIXED_NOW - 1000, acquiredAt: FIXED_NOW - 3600_000,
    };
    const refreshed = await p.refresh(ctx(baseConfig), existingBundle);

    expect(httpFetch).toHaveBeenCalledOnce();
    const [, init] = httpFetch.mock.calls[0] as [string, { body: string }];
    const params = new URLSearchParams(init.body);
    expect(params.get('scope')).toBe('https://vault.azure.net/.default');
    expect(refreshed.scheme).toBe('vault');
    expect(refreshed.accessToken).toBe(accessToken);
  });

  it('validate returns true for non-expired JWT', async () => {
    const nowSec = Math.floor(FIXED_NOW / 1000);
    const expSec = nowSec + 3600;
    const p = new AzureKeyVaultProvider({ now: () => FIXED_NOW });

    const bundle: TokenBundle = {
      service: 'azure-key-vault', scheme: 'management',
      accessToken: jwt(expSec), tokenType: 'Bearer',
      expiresAt: expSec * 1000, acquiredAt: FIXED_NOW,
    };
    expect(await p.validate(ctx(baseConfig), bundle)).toBe(true);
  });

  it('validate returns false for expired JWT', async () => {
    const nowSec = Math.floor(FIXED_NOW / 1000);
    const expSec = nowSec - 60; // already expired
    const p = new AzureKeyVaultProvider({ now: () => FIXED_NOW });

    const bundle: TokenBundle = {
      service: 'azure-key-vault', scheme: 'management',
      accessToken: jwt(expSec), tokenType: 'Bearer',
      expiresAt: expSec * 1000, acquiredAt: FIXED_NOW - 3600_000,
    };
    expect(await p.validate(ctx(baseConfig), bundle)).toBe(false);
  });

  it('nextRefreshAt is at least 5 minutes before exp', () => {
    const nowSec = Math.floor(FIXED_NOW / 1000);
    const expSec = nowSec + 3600;
    const p = new AzureKeyVaultProvider({ now: () => FIXED_NOW });

    const bundle: TokenBundle = {
      service: 'azure-key-vault', scheme: 'management',
      accessToken: jwt(expSec), tokenType: 'Bearer',
      expiresAt: expSec * 1000, acquiredAt: FIXED_NOW,
    };
    const next = p.nextRefreshAt(bundle);
    expect(next.getTime()).toBeLessThan(expSec * 1000);
    expect(expSec * 1000 - next.getTime()).toBeGreaterThanOrEqual(300_000);
  });

  it('extra includes subscriptionId when configured', async () => {
    const httpFetch = mockFetch(makeTokenResponse('tok'));
    const p = new AzureKeyVaultProvider({ now: () => FIXED_NOW, httpFetch });

    const configWithSub = { ...baseConfig, subscriptionId: 'sub-999' };
    const bundle = await p.acquire(ctx(configWithSub), 'management');

    expect(bundle.extra!.subscriptionId).toBe('sub-999');
  });
});
