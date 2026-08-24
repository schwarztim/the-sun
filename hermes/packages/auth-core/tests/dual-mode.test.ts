import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getToken, type DualModeAuthOptions } from '../src/dual-mode.js';

vi.mock('@hermes/client', () => ({
  HermesClient: vi.fn().mockImplementation(() => ({
    getToken: vi.fn().mockResolvedValue({ accessToken: 'hermes-token', expiresAt: Date.now() + 3600_000 }),
  })),
}));

describe('getToken (dual-mode)', () => {
  const standalone = vi.fn(async () => ({ accessToken: 'standalone-token', expiresAt: Date.now() + 3600_000 }));

  beforeEach(() => {
    delete process.env['HERMES_URL'];
    delete process.env['HERMES_CLIENT_TOKEN'];
    standalone.mockClear();
  });

  afterEach(() => {
    delete process.env['HERMES_URL'];
    delete process.env['HERMES_CLIENT_TOKEN'];
  });

  it('uses standalone when no hermes env vars', async () => {
    const token = await getToken({ service: 'svc', scheme: 'graph', standaloneAcquire: standalone });
    expect(token).toBe('standalone-token');
    expect(standalone).toHaveBeenCalledOnce();
  });

  it('uses hermes client when env vars are set', async () => {
    process.env['HERMES_URL'] = 'http://localhost:9999';
    process.env['HERMES_CLIENT_TOKEN'] = 'client-tok';
    const token = await getToken({ service: 'svc', scheme: 'graph', standaloneAcquire: standalone });
    expect(token).toBe('hermes-token');
    expect(standalone).not.toHaveBeenCalled();
  });

  it('uses explicit opts over env vars', async () => {
    process.env['HERMES_URL'] = 'http://wrong';
    process.env['HERMES_CLIENT_TOKEN'] = 'wrong-tok';
    const token = await getToken({
      service: 'svc', scheme: 'graph',
      hermesUrl: 'http://localhost:9999', hermesToken: 'explicit-tok',
      standaloneAcquire: standalone,
    });
    expect(token).toBe('hermes-token');
  });

  it('falls back to standalone if only url is set (no token)', async () => {
    process.env['HERMES_URL'] = 'http://localhost:9999';
    const token = await getToken({ service: 'svc', scheme: 'graph', standaloneAcquire: standalone });
    expect(token).toBe('standalone-token');
  });
});
