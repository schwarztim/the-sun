import { describe, it, expect, beforeEach } from 'vitest';
import { TokenStorage, type KeyringAdapter } from '../src/storage.js';
import type { TokenBundle } from '../src/types.js';

class MemKeyring implements KeyringAdapter {
  private m = new Map<string, string>();
  async setPassword(s: string, a: string, p: string) { this.m.set(`${s}:${a}`, p); }
  async getPassword(s: string, a: string) { return this.m.get(`${s}:${a}`) ?? null; }
  async deletePassword(s: string, a: string) { return this.m.delete(`${s}:${a}`); }
  async findCredentials(s: string) {
    return Array.from(this.m.entries())
      .filter(([k]) => k.startsWith(`${s}:`))
      .map(([k, password]) => ({ account: k.slice(s.length + 1), password }));
  }
}

const bundle: TokenBundle = {
  service: 'ms365', scheme: 'graph', accessToken: 'abc', tokenType: 'Bearer',
  expiresAt: Date.now() + 3600_000, acquiredAt: Date.now(),
};

describe('TokenStorage', () => {
  let kr: MemKeyring;
  let s: TokenStorage;
  beforeEach(() => { kr = new MemKeyring(); s = new TokenStorage(kr); });

  it('returns null when nothing is stored', async () => {
    expect(await s.get('ms365', 'graph')).toBeNull();
  });
  it('round-trips a TokenBundle', async () => {
    await s.set(bundle);
    expect(await s.get('ms365', 'graph')).toEqual(bundle);
  });
  it('overwrites on set', async () => {
    await s.set(bundle);
    await s.set({ ...bundle, accessToken: 'xyz' });
    expect((await s.get('ms365', 'graph'))?.accessToken).toBe('xyz');
  });
  it('deletes a stored bundle', async () => {
    await s.set(bundle);
    expect(await s.delete('ms365', 'graph')).toBe(true);
    expect(await s.get('ms365', 'graph')).toBeNull();
  });
  it('lists all stored bundles', async () => {
    await s.set(bundle);
    await s.set({ ...bundle, scheme: 'teams', accessToken: 'def' });
    const all = await s.list();
    expect(all.map((b) => b.scheme).sort()).toEqual(['graph', 'teams']);
  });
  it('rejects corrupt stored JSON with a clear error', async () => {
    await kr.setPassword('hermes', 'ms365:graph', '{not json');
    await expect(s.get('ms365', 'graph')).rejects.toThrow(/corrupt/i);
  });
});
