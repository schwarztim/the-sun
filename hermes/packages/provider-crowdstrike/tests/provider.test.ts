import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CrowdStrikeProvider } from '../src/provider.js';
import { CrowdStrikeConfigSchema } from '../src/config.js';
import type { TokenBundle, ProviderContext } from '@hermes/broker';

const nullLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
function ctx(config: Record<string, unknown>): ProviderContext {
  return { service: 'crowdstrike', config, dataDir: '/tmp/hermes-test', logger: nullLogger };
}

describe('CrowdStrikeProvider', () => {
  it('has correct name and schemes', () => {
    const p = new CrowdStrikeProvider({ now: () => Date.now() });
    expect(p.name).toBe('crowdstrike');
    expect(p.schemes).toEqual(['browser-proxy']);
  });

  it('exposes browser-proxy capabilities and remediation hints', () => {
    const p = new CrowdStrikeProvider({ now: () => Date.now() });
    expect(p.capabilities?.headless).toBe(true);
    expect(p.capabilities?.schemes[0]).toMatchObject({
      scheme: 'browser-proxy',
      credentialSource: 'browser-proxy',
      refreshStrategy: 'self-maintained',
      validationStrategy: 'proxy-health',
    });
    expect(p.capabilities?.remediation.validate).toContain('Proxy health');
  });

  it('validate returns true when proxy health check succeeds', async () => {
    const httpFetch = vi.fn(async () => ({ ok: true, status: 200 }));
    const p = new CrowdStrikeProvider({ now: () => Date.now(), httpFetch });
    const bundle: TokenBundle = {
      service: 'crowdstrike', scheme: 'browser-proxy',
      accessToken: 'http://127.0.0.1:9999',
      tokenType: 'ProxyURL', expiresAt: Date.now() + 86400_000, acquiredAt: Date.now(),
      extra: { proxyPort: 9999, proxyUrl: 'http://127.0.0.1:9999' },
    };
    expect(await p.validate(ctx({ loginHint: 'u@e.com' }), bundle)).toBe(true);
    expect(httpFetch).toHaveBeenCalledWith('http://127.0.0.1:9999/__health');
  });

  it('validate returns false when proxy is unreachable', async () => {
    const httpFetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const p = new CrowdStrikeProvider({ now: () => Date.now(), httpFetch });
    const bundle: TokenBundle = {
      service: 'crowdstrike', scheme: 'browser-proxy',
      accessToken: 'http://127.0.0.1:9999',
      tokenType: 'ProxyURL', expiresAt: Date.now() + 86400_000, acquiredAt: Date.now(),
      extra: { proxyPort: 9999, proxyUrl: 'http://127.0.0.1:9999' },
    };
    expect(await p.validate(ctx({ loginHint: 'u@e.com' }), bundle)).toBe(false);
  });

  it('validate returns false when proxyUrl missing from extra', async () => {
    const p = new CrowdStrikeProvider({ now: () => Date.now() });
    const bundle: TokenBundle = {
      service: 'crowdstrike', scheme: 'browser-proxy',
      accessToken: 'http://127.0.0.1:9999',
      tokenType: 'ProxyURL', expiresAt: Date.now() + 86400_000, acquiredAt: Date.now(),
    };
    expect(await p.validate(ctx({ loginHint: 'u@e.com' }), bundle)).toBe(false);
  });

  it('validate returns false on non-ok response', async () => {
    const httpFetch = vi.fn(async () => ({ ok: false, status: 503 }));
    const p = new CrowdStrikeProvider({ now: () => Date.now(), httpFetch });
    const bundle: TokenBundle = {
      service: 'crowdstrike', scheme: 'browser-proxy',
      accessToken: 'http://127.0.0.1:9999',
      tokenType: 'ProxyURL', expiresAt: Date.now() + 86400_000, acquiredAt: Date.now(),
      extra: { proxyPort: 9999, proxyUrl: 'http://127.0.0.1:9999' },
    };
    expect(await p.validate(ctx({ loginHint: 'u@e.com' }), bundle)).toBe(false);
  });

  it('refresh returns the same bundle (no-op)', async () => {
    const p = new CrowdStrikeProvider({ now: () => Date.now() });
    const bundle: TokenBundle = {
      service: 'crowdstrike', scheme: 'browser-proxy',
      accessToken: 'http://127.0.0.1:9999',
      tokenType: 'ProxyURL', expiresAt: Date.now() + 86400_000, acquiredAt: Date.now(),
      extra: { proxyPort: 9999, proxyUrl: 'http://127.0.0.1:9999' },
    };
    const result = await p.refresh(ctx({ loginHint: 'u@e.com' }), bundle);
    expect(result).toBe(bundle);
  });

  it('nextRefreshAt returns far-future date', () => {
    const now = Date.now();
    const p = new CrowdStrikeProvider({ now: () => now });
    const bundle: TokenBundle = {
      service: 'crowdstrike', scheme: 'browser-proxy',
      accessToken: 'http://127.0.0.1:9999',
      tokenType: 'ProxyURL', expiresAt: now + 86400_000, acquiredAt: now,
    };
    const next = p.nextRefreshAt(bundle);
    expect(next.getTime()).toBeGreaterThan(now + 23 * 60 * 60 * 1000);
  });

  it('acquire throws when config is missing loginHint', async () => {
    const p = new CrowdStrikeProvider({ now: () => 0 });
    await expect(p.acquire(ctx({}), 'browser-proxy')).rejects.toThrow();
  });

  it('dispose is safe to call multiple times', async () => {
    const p = new CrowdStrikeProvider({ now: () => Date.now() });
    await p.dispose();
    await p.dispose();
  });

  it('rejects headless: false in config', () => {
    expect(() => CrowdStrikeConfigSchema.parse({ loginHint: 'u@e.com', headless: false })).toThrow();
  });
});
