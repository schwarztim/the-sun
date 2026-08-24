import { describe, it, expect } from 'vitest';
import { MemoryStore, FileStore } from '../src/credential-store.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

describe('MemoryStore', () => {
  it('returns null for missing credentials', async () => {
    const store = new MemoryStore();
    expect(await store.get('svc', 'acct')).toBeNull();
  });

  it('stores and retrieves credentials', async () => {
    const store = new MemoryStore();
    await store.set('svc', 'acct', 'secret123');
    expect(await store.get('svc', 'acct')).toBe('secret123');
  });

  it('overwrites existing credentials', async () => {
    const store = new MemoryStore();
    await store.set('svc', 'acct', 'v1');
    await store.set('svc', 'acct', 'v2');
    expect(await store.get('svc', 'acct')).toBe('v2');
  });

  it('deletes credentials', async () => {
    const store = new MemoryStore();
    await store.set('svc', 'acct', 'val');
    expect(await store.delete('svc', 'acct')).toBe(true);
    expect(await store.get('svc', 'acct')).toBeNull();
  });

  it('returns false when deleting nonexistent credential', async () => {
    const store = new MemoryStore();
    expect(await store.delete('svc', 'acct')).toBe(false);
  });

  it('isolates different service/account pairs', async () => {
    const store = new MemoryStore();
    await store.set('svc1', 'acct', 'a');
    await store.set('svc2', 'acct', 'b');
    expect(await store.get('svc1', 'acct')).toBe('a');
    expect(await store.get('svc2', 'acct')).toBe('b');
  });
});

describe('FileStore', () => {
  function makeTempStore() {
    const dir = mkdtempSync(path.join(tmpdir(), 'hermes-vault-'));
    return new FileStore(path.join(dir, 'vault.enc'), 'test-passphrase');
  }

  it('returns null for empty vault', async () => {
    const store = makeTempStore();
    expect(await store.get('svc', 'acct')).toBeNull();
  });

  it('round-trips encrypted credentials', async () => {
    const store = makeTempStore();
    await store.set('svc', 'acct', 'encrypted-secret');
    expect(await store.get('svc', 'acct')).toBe('encrypted-secret');
  });

  it('stores multiple credentials', async () => {
    const store = makeTempStore();
    await store.set('s1', 'a1', 'v1');
    await store.set('s2', 'a2', 'v2');
    expect(await store.get('s1', 'a1')).toBe('v1');
    expect(await store.get('s2', 'a2')).toBe('v2');
  });

  it('deletes credentials from vault', async () => {
    const store = makeTempStore();
    await store.set('svc', 'acct', 'val');
    expect(await store.delete('svc', 'acct')).toBe(true);
    expect(await store.get('svc', 'acct')).toBeNull();
  });

  it('returns false when deleting nonexistent credential', async () => {
    const store = makeTempStore();
    expect(await store.delete('svc', 'acct')).toBe(false);
  });

  it('throws when no passphrase is available', () => {
    const origKey = process.env['HERMES_VAULT_KEY'];
    delete process.env['HERMES_VAULT_KEY'];
    try {
      expect(() => new FileStore('/tmp/test-vault.enc', undefined)).toThrow(/HERMES_VAULT_KEY/);
    } finally {
      if (origKey !== undefined) process.env['HERMES_VAULT_KEY'] = origKey;
    }
  });
});
