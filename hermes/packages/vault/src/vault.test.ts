import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { HermesVault } from './vault.js';

function tempVaultPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'hermes-vault-'));
  return path.join(dir, 'vault.enc');
}

function makeVault(vaultPath = tempVaultPath(), masterKey = randomBytes(32)): HermesVault {
  return new HermesVault({ masterKey, vaultPath });
}

describe('HermesVault construction', () => {
  it('rejects a non-32-byte master key', () => {
    expect(() => new HermesVault({ masterKey: randomBytes(16), vaultPath: tempVaultPath() })).toThrow(/32-byte/);
  });
});

describe('HermesVault — CredentialStore interface', () => {
  it('returns null for a missing entry (empty vault, no file created on read)', async () => {
    const vaultPath = tempVaultPath();
    const vault = makeVault(vaultPath);
    expect(await vault.get('svc', 'acct')).toBeNull();
    expect(existsSync(vaultPath)).toBe(false); // reads never create the file
  });

  it('round-trips set/get/delete', async () => {
    const vault = makeVault();
    await vault.set('svc', 'acct', 'secret-value');
    expect(await vault.get('svc', 'acct')).toBe('secret-value');
    expect(await vault.delete('svc', 'acct')).toBe(true);
    expect(await vault.get('svc', 'acct')).toBeNull();
  });

  it('overwrites an existing value', async () => {
    const vault = makeVault();
    await vault.set('svc', 'acct', 'v1');
    await vault.set('svc', 'acct', 'v2');
    expect(await vault.get('svc', 'acct')).toBe('v2');
  });

  it('delete of a missing key returns false and creates no file', async () => {
    const vaultPath = tempVaultPath();
    const vault = makeVault(vaultPath);
    expect(await vault.delete('svc', 'nope')).toBe(false);
    expect(existsSync(vaultPath)).toBe(false);
  });
});

describe('HermesVault — KeyringAdapter interface', () => {
  it('round-trips setPassword/getPassword/deletePassword', async () => {
    const vault = makeVault();
    await vault.setPassword('hermes', 'ms365:oauth2', 'token-bundle-json');
    expect(await vault.getPassword('hermes', 'ms365:oauth2')).toBe('token-bundle-json');
    expect(await vault.deletePassword('hermes', 'ms365:oauth2')).toBe(true);
    expect(await vault.getPassword('hermes', 'ms365:oauth2')).toBeNull();
  });

  it('findCredentials returns every entry under the service prefix as {account,password}', async () => {
    const vault = makeVault();
    await vault.setPassword('hermes', 'ms365:oauth2', 'a');
    await vault.setPassword('hermes', 'servicenow:cookie', 'b');
    await vault.setPassword('other', 'x:y', 'c'); // different service prefix — excluded
    const found = await vault.findCredentials('hermes');
    expect(found).toEqual([
      { account: 'ms365:oauth2', password: 'a' },
      { account: 'servicenow:cookie', password: 'b' },
    ]);
  });

  it('KeyringAdapter and CredentialStore share the same entries map', async () => {
    const vault = makeVault();
    await vault.set('hermes', 'k', 'via-credentialstore');
    expect(await vault.getPassword('hermes', 'k')).toBe('via-credentialstore');
    await vault.setPassword('hermes', 'k', 'via-keyring');
    expect(await vault.get('hermes', 'k')).toBe('via-keyring');
  });
});

describe('HermesVault — cross-service enumeration (values-free)', () => {
  it('listServices returns every distinct service prefix, sorted, deduplicated', async () => {
    const vault = makeVault();
    await vault.set('tufin', 'acct1', 'v1');
    await vault.set('tufin', 'acct2', 'v2');
    await vault.set('venafi', 'svc-acct', 'v3');
    expect(await vault.listServices()).toEqual(['tufin', 'venafi']);
  });

  it('listServices returns [] for an empty (never-written) vault', async () => {
    const vault = makeVault();
    expect(await vault.listServices()).toEqual([]);
  });

  it('listEntries with no filter returns metadata for every entry across all services, never the value', async () => {
    const vault = makeVault();
    await vault.set('tufin', 'acct1', 'secret-value');
    await vault.set('venafi', 'svc-acct', 'other-secret');
    const entries = await vault.listEntries();
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => ({ service: e.service, account: e.account }))).toEqual([
      { service: 'tufin', account: 'acct1' },
      { service: 'venafi', account: 'svc-acct' },
    ]);
    for (const e of entries) {
      expect(typeof e.updatedAt).toBe('string');
      expect(e).not.toHaveProperty('value');
      expect(e).not.toHaveProperty('password');
    }
  });

  it('listEntries(service) scopes to one service, same as findCredentials but with updatedAt', async () => {
    const vault = makeVault();
    await vault.set('tufin', 'acct1', 'v1');
    await vault.set('venafi', 'svc-acct', 'v2');
    const scoped = await vault.listEntries('tufin');
    expect(scoped).toEqual([{ service: 'tufin', account: 'acct1', updatedAt: scoped[0]!.updatedAt }]);
  });
});

describe('HermesVault — fail-closed crypto', () => {
  it('never leaks plaintext to disk', async () => {
    const vaultPath = tempVaultPath();
    const vault = makeVault(vaultPath);
    await vault.set('hermes', 'ms365:oauth2', 'SUPER-SECRET-TOKEN-abc123');
    const raw = readFileSync(vaultPath);
    expect(raw.subarray(0, 4).toString('latin1')).toBe('HV1\0');
    expect(raw.includes(Buffer.from('SUPER-SECRET-TOKEN-abc123', 'utf8'))).toBe(false);
    expect(raw.toString('latin1')).not.toContain('ms365:oauth2'); // entry names hidden too
    expect(raw.toString('latin1')).not.toContain('"entries"');
  });

  it('throws (never returns {}) on tampered ciphertext', async () => {
    const vaultPath = tempVaultPath();
    const vault = makeVault(vaultPath);
    await vault.set('svc', 'acct', 'val');
    const raw = readFileSync(vaultPath);
    raw[raw.length - 1] = raw[raw.length - 1]! ^ 0xff; // flip a ciphertext bit
    writeFileSync(vaultPath, raw);
    await expect(vault.get('svc', 'acct')).rejects.toThrow();
  });

  it('throws on a tampered auth tag', async () => {
    const vaultPath = tempVaultPath();
    const vault = makeVault(vaultPath);
    await vault.set('svc', 'acct', 'val');
    const raw = readFileSync(vaultPath);
    raw[20] = raw[20]! ^ 0xff; // a tag byte (magic 4 + nonce 12 = offset 16..31)
    writeFileSync(vaultPath, raw);
    await expect(vault.get('svc', 'acct')).rejects.toThrow();
  });

  it('throws on a bad magic / wrong-format envelope', async () => {
    const vaultPath = tempVaultPath();
    const vault = makeVault(vaultPath);
    await vault.set('svc', 'acct', 'val');
    const raw = readFileSync(vaultPath);
    raw[0] = raw[0]! ^ 0xff; // corrupt the magic
    writeFileSync(vaultPath, raw);
    await expect(vault.get('svc', 'acct')).rejects.toThrow(/HV1|corrupt|format/i);
  });

  it('throws when decrypting with the wrong master key (AAD+key binding)', async () => {
    const vaultPath = tempVaultPath();
    await makeVault(vaultPath, randomBytes(32)).set('svc', 'acct', 'val');
    const otherVault = new HermesVault({ masterKey: randomBytes(32), vaultPath });
    await expect(otherVault.get('svc', 'acct')).rejects.toThrow();
  });
});

describe('HermesVault — concurrency (no lost writes)', () => {
  it('serializes N concurrent set() on one instance (in-process queue)', async () => {
    const vault = makeVault();
    const N = 25;
    await Promise.all(
      Array.from({ length: N }, (_, i) => vault.setPassword('hermes', `svc-${i}:scheme`, `value-${i}`)),
    );
    const found = await vault.findCredentials('hermes');
    expect(found).toHaveLength(N);
    for (let i = 0; i < N; i++) {
      expect(await vault.getPassword('hermes', `svc-${i}:scheme`)).toBe(`value-${i}`);
    }
  });

  it('serializes concurrent writers across TWO instances (cross-process O_EXCL lock)', async () => {
    const vaultPath = tempVaultPath();
    const key = randomBytes(32);
    const a = new HermesVault({ masterKey: key, vaultPath });
    const b = new HermesVault({ masterKey: key, vaultPath });
    const perInstance = 6;
    await Promise.all([
      ...Array.from({ length: perInstance }, (_, i) => a.setPassword('hermes', `a-${i}:s`, `av-${i}`)),
      ...Array.from({ length: perInstance }, (_, i) => b.setPassword('hermes', `b-${i}:s`, `bv-${i}`)),
    ]);
    const found = await a.findCredentials('hermes');
    expect(found).toHaveLength(perInstance * 2); // no writer clobbered another
  });
});

describe('HermesVault — file hygiene (POSIX)', () => {
  it.skipIf(process.platform === 'win32')('writes the vault file 0600 and leaves no tmp files', async () => {
    const vaultPath = tempVaultPath();
    const vault = makeVault(vaultPath);
    await vault.set('svc', 'acct', 'val');
    expect(statSync(vaultPath).mode & 0o777).toBe(0o600);
    const { readdirSync } = await import('node:fs');
    const leftovers = readdirSync(path.dirname(vaultPath)).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });
});
