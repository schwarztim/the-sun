import { describe, it, expect, vi } from 'vitest';
import { runAcquire } from '../src/acquire.js';
import type { Broker } from '../src/broker.js';

describe('runAcquire', () => {
  it('calls broker.getToken with force for every scheme', async () => {
    const getToken = vi.fn(async (_s: string, scheme: string) => ({
      service: 'ms365', scheme, accessToken: 'x', tokenType: 'Bearer',
      expiresAt: Date.now() + 3600_000, acquiredAt: Date.now(),
    }));
    const result = await runAcquire({ broker: { getToken } as unknown as Broker, service: 'ms365', schemes: ['graph', 'teams'] });
    expect(getToken).toHaveBeenCalledTimes(2);
    expect(getToken).toHaveBeenCalledWith('ms365', 'graph', { force: true, interactive: false });
    expect(getToken).toHaveBeenCalledWith('ms365', 'teams', { force: true, interactive: false });
    expect(result.acquired).toEqual(['graph', 'teams']);
    expect(result.failed).toEqual([]);
  });

  it('continues when one scheme fails and reports it', async () => {
    const getToken = vi.fn(async (_s: string, scheme: string) => {
      if (scheme === 'teams') throw new Error('MFA declined');
      return { service: 'ms365', scheme, accessToken: 'x', tokenType: 'Bearer', expiresAt: Date.now() + 3600_000, acquiredAt: Date.now() };
    });
    const result = await runAcquire({ broker: { getToken } as unknown as Broker, service: 'ms365', schemes: ['graph', 'teams'] });
    expect(result.acquired).toEqual(['graph']);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.scheme).toBe('teams');
  });
});
