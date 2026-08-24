import { describe, it, expect } from 'vitest';
import { TokenValidator } from '../src/validator.js';
import type { Provider, TokenBundle } from '../src/types.js';

const now = () => Date.now();
const bundle = (overrides: Partial<TokenBundle> = {}): TokenBundle => ({
  service: 'ms365', scheme: 'graph', accessToken: 'x', tokenType: 'Bearer',
  expiresAt: now() + 3600_000, acquiredAt: now() - 60_000, ...overrides,
});

function mockProvider(validateResult: boolean | Error): Provider {
  return {
    name: 'ms365', schemes: ['graph'],
    acquire: async () => bundle(), refresh: async (_c, b) => b,
    validate: async () => { if (validateResult instanceof Error) throw validateResult; return validateResult; },
    nextRefreshAt: (b) => new Date(b.expiresAt - 300_000),
  };
}

function mockCookieSessionProvider(validateResult: boolean | Error): Provider {
  return {
    ...mockProvider(validateResult),
    name: 'servicenow',
    schemes: ['session'],
    capabilities: {
      headless: true,
      schemes: [{
        scheme: 'session',
        credentialSource: 'cookie-session',
        refreshStrategy: 'reacquire',
        supportsRefresh: true,
        supportsValidation: true,
        validationStrategy: 'service-probe',
      }],
      remediation: {
        acquire: 'hermes acquire servicenow',
        refresh: 'hermes acquire servicenow',
        validate: 'ServiceNow session_info and API probes',
      },
    },
  };
}

const ctx = { service: 'ms365', config: {}, dataDir: '/tmp/hermes', logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } };

describe('TokenValidator', () => {
  it('lazy policy returns true without calling validate on fresh cache', async () => {
    const v = new TokenValidator({ policy: 'lazy', safetyMarginSec: 300 });
    expect(await v.isFresh(mockProvider(false), ctx, bundle(), { cacheAge: 5 })).toBe(true);
  });
  it('eager policy calls validate after threshold', async () => {
    const v = new TokenValidator({ policy: 'eager', safetyMarginSec: 300 });
    expect(await v.isFresh(mockProvider(true), ctx, bundle(), { cacheAge: 120 })).toBe(true);
  });
  it('eager policy returns false when provider.validate returns false', async () => {
    const v = new TokenValidator({ policy: 'eager', safetyMarginSec: 300 });
    expect(await v.isFresh(mockProvider(false), ctx, bundle(), { cacheAge: 120 })).toBe(false);
  });
  it('paranoid policy validates even on fresh cache', async () => {
    const v = new TokenValidator({ policy: 'paranoid', safetyMarginSec: 300 });
    expect(await v.isFresh(mockProvider(true), ctx, bundle(), { cacheAge: 1 })).toBe(true);
  });
  it('eager policy validates cookie-session service probes even before the generic threshold', async () => {
    const v = new TokenValidator({ policy: 'eager', safetyMarginSec: 300 });
    const provider = mockCookieSessionProvider(false);
    const assessment = await v.assessFreshness(provider, ctx, bundle({ service: 'servicenow', scheme: 'session' }), { cacheAge: 1 });
    expect(assessment).toMatchObject({
      fresh: false,
      providerValidation: 'invalid',
    });
  });
  it('returns false when token is within safety margin regardless of policy', async () => {
    const v = new TokenValidator({ policy: 'lazy', safetyMarginSec: 300 });
    const expiring = bundle({ expiresAt: now() + 60_000 });
    expect(await v.isFresh(mockProvider(true), ctx, expiring, { cacheAge: 1 })).toBe(false);
  });
  it('treats provider.validate errors as invalid', async () => {
    const v = new TokenValidator({ policy: 'eager', safetyMarginSec: 300 });
    expect(await v.isFresh(mockProvider(new Error('net down')), ctx, bundle(), { cacheAge: 120 })).toBe(false);
  });

  it('treats retryable provider.validate errors as inconclusive/fresh to avoid auth storms', async () => {
    const err = Object.assign(new Error('VPN unavailable'), { retryable: true });
    const v = new TokenValidator({ policy: 'eager', safetyMarginSec: 300 });
    const assessment = await v.assessFreshness(mockProvider(err), ctx, bundle(), { cacheAge: 120 });
    expect(assessment).toMatchObject({
      fresh: true,
      accessTokenFresh: true,
      providerValidation: 'error',
      providerValidationError: 'VPN unavailable',
    });
  });

  it('reports provider validation detail for proof tier recording', async () => {
    const v = new TokenValidator({ policy: 'eager', safetyMarginSec: 300 });
    const assessment = await v.assessFreshness(mockProvider(true), ctx, bundle(), { cacheAge: 120 });
    expect(assessment).toMatchObject({
      fresh: true,
      accessTokenFresh: true,
      providerValidation: 'valid',
    });
    expect(assessment.msUntilExpiry).toBeGreaterThan(0);
  });
});
