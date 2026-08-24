/**
 * Verifies the ServiceNow provider routes its browser through the managed
 * lifecycle wrapper with the contract lifetime ceiling:
 * maxLifetimeMs = authTimeoutMs + 60s.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProviderContext } from '@hermes/broker';

const { withManagedBrowserMock } = vi.hoisted(() => ({
  withManagedBrowserMock: vi.fn(async (): Promise<never> => {
    throw new Error('halt-after-wiring-check');
  }),
}));

vi.mock('@hermes/auth-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hermes/auth-core')>();
  return { ...actual, withManagedBrowser: withManagedBrowserMock };
});

import { ServiceNowProvider } from '../src/provider.js';

const INSTANCE_URL = 'https://wiringtest.service-now.com';
const nullLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function ctx(config: Record<string, unknown> = {}): ProviderContext {
  return {
    service: 'servicenow',
    config: { instanceUrl: INSTANCE_URL, loginHint: 'u@e.com', ...config },
    dataDir: `${process.cwd()}/.test-data/provider-servicenow-wiring`,
    logger: nullLogger,
  };
}

describe('ServiceNowProvider managed-browser wiring', () => {
  beforeEach(() => {
    withManagedBrowserMock.mockClear();
  });

  it('calls withManagedBrowser with maxLifetimeMs = authTimeoutMs + 60_000', async () => {
    const provider = new ServiceNowProvider({ now: () => Date.now() });
    await expect(provider.acquire(ctx({ authTimeoutMs: 90_000 }), 'session'))
      .rejects.toThrow('halt-after-wiring-check');

    expect(withManagedBrowserMock).toHaveBeenCalledTimes(1);
    expect(withManagedBrowserMock).toHaveBeenCalledWith(
      expect.objectContaining({
        service: 'servicenow',
        engine: 'firefox',
        maxLifetimeMs: 90_000 + 60_000,
        profileDir: expect.stringContaining('servicenow'),
        logger: nullLogger,
      }),
      expect.any(Function),
    );
  });

  it('applies the default authTimeoutMs (120s) when not configured', async () => {
    const provider = new ServiceNowProvider({ now: () => Date.now() });
    await expect(provider.acquire(ctx(), 'session')).rejects.toThrow('halt-after-wiring-check');
    expect(withManagedBrowserMock).toHaveBeenCalledWith(
      expect.objectContaining({ maxLifetimeMs: 120_000 + 60_000 }),
      expect.any(Function),
    );
  });
});
