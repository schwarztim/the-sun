import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { resolveMasterKey, type KeychainBackend } from './master-key.js';

let dir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'hermes-mk-'));
  for (const k of ['HERMES_MASTER_KEY', 'HERMES_DIR']) saved[k] = process.env[k];
  delete process.env['HERMES_MASTER_KEY'];
  delete process.env['HERMES_DIR'];
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** In-memory keychain stub — never touches the real OS keychain. */
function stubKeychain(initial?: { key: Buffer }): KeychainBackend & { store: Map<string, string>; setCalls: number } {
  const store = new Map<string, string>();
  if (initial) store.set('hermes::master-key', initial.key.toString('base64'));
  return {
    store,
    setCalls: 0,
    async getPassword(service, account) { return store.get(`${service}::${account}`) ?? null; },
    async setPassword(service, account, password) { this.setCalls++; store.set(`${service}::${account}`, password); },
  };
}

describe('resolveMasterKey cascade', () => {
  it('1) uses HERMES_MASTER_KEY env (base64, 32 bytes)', async () => {
    const key = randomBytes(32);
    process.env['HERMES_MASTER_KEY'] = key.toString('base64');
    const resolved = await resolveMasterKey({ hermesDir: dir, keychain: null });
    expect(resolved.equals(key)).toBe(true);
  });

  it('throws when HERMES_MASTER_KEY is set but not 32 bytes', async () => {
    process.env['HERMES_MASTER_KEY'] = randomBytes(16).toString('base64');
    await expect(resolveMasterKey({ hermesDir: dir, keychain: null })).rejects.toThrow(/32 bytes/);
  });

  it('2) uses the ~/.hermes/master.key file when no env', async () => {
    const key = randomBytes(32);
    writeFileSync(path.join(dir, 'master.key'), key);
    const resolved = await resolveMasterKey({ hermesDir: dir, keychain: null });
    expect(resolved.equals(key)).toBe(true);
  });

  it('throws on a present-but-wrong-length key file (fail closed, never regenerate)', async () => {
    writeFileSync(path.join(dir, 'master.key'), randomBytes(31));
    await expect(resolveMasterKey({ hermesDir: dir, keychain: null })).rejects.toThrow(/expected exactly 32/);
  });

  it('file (step 2) wins over the keychain (step 3) — daemon-safe ordering', async () => {
    const fileKey = randomBytes(32);
    const keychainKey = randomBytes(32);
    writeFileSync(path.join(dir, 'master.key'), fileKey);
    const kc = stubKeychain({ key: keychainKey });
    const resolved = await resolveMasterKey({ hermesDir: dir, keychain: kc });
    expect(resolved.equals(fileKey)).toBe(true);
  });

  it('3) uses the keychain when env + file are absent', async () => {
    const keychainKey = randomBytes(32);
    const kc = stubKeychain({ key: keychainKey });
    const resolved = await resolveMasterKey({ hermesDir: dir, keychain: kc });
    expect(resolved.equals(keychainKey)).toBe(true);
    expect(existsSync(path.join(dir, 'master.key'))).toBe(false); // did not regenerate
  });

  it('4) generates on first use → returns a 32-byte key, writes the key file and stores to keychain', async () => {
    const kc = stubKeychain();
    const resolved = await resolveMasterKey({ hermesDir: dir, keychain: kc });
    expect(resolved).toHaveLength(32);
    const onDisk = readFileSync(path.join(dir, 'master.key'));
    expect(onDisk.equals(resolved)).toBe(true);
    expect(kc.setCalls).toBe(1);
    expect(kc.store.get('hermes::master-key')).toBe(resolved.toString('base64'));
  });

  it('4) generated key persists — a second resolve reads the same key from the file', async () => {
    const first = await resolveMasterKey({ hermesDir: dir, keychain: null });
    const second = await resolveMasterKey({ hermesDir: dir, keychain: null });
    expect(second.equals(first)).toBe(true);
  });

  it('5) fails closed when every source is absent and generation is disabled', async () => {
    await expect(
      resolveMasterKey({ hermesDir: dir, keychain: null, generate: false }),
    ).rejects.toThrow(/no Hermes master key available/);
  });

  it('resolves in order: env beats file beats keychain', async () => {
    const envKey = randomBytes(32);
    const fileKey = randomBytes(32);
    const kcKey = randomBytes(32);
    process.env['HERMES_MASTER_KEY'] = envKey.toString('base64');
    writeFileSync(path.join(dir, 'master.key'), fileKey);
    const resolved = await resolveMasterKey({ hermesDir: dir, keychain: stubKeychain({ key: kcKey }) });
    expect(resolved.equals(envKey)).toBe(true);
  });
});

describe('resolveMasterKey — concurrent generation (no divergent keys)', () => {
  it('N concurrent in-process cold starts converge on ONE key equal to the persisted file', async () => {
    // Mirrors /tmp/mk-race-repro.mjs: without EXCLUSIVE publication two callers mint
    // different keys and one is silently clobbered → an unrecoverable vault on restart.
    const TRIALS = 40;
    const CONCURRENCY = 4;
    let divergent = 0;
    for (let t = 0; t < TRIALS; t++) {
      const raceDir = mkdtempSync(path.join(tmpdir(), 'hermes-mkrace-'));
      const keys = await Promise.all(
        Array.from({ length: CONCURRENCY }, () => resolveMasterKey({ hermesDir: raceDir, keychain: null })),
      );
      const onDisk = readFileSync(path.join(raceDir, 'master.key'));
      const allEqualDisk = keys.every((k) => k.equals(onDisk));
      const allEqualEachOther = keys.every((k) => k.equals(keys[0]!));
      if (!allEqualDisk || !allEqualEachOther) divergent++;
    }
    expect(divergent).toBe(0);
  }, 30_000);

  it('adopts the winner: two racing resolves return the same key, and it equals the key file', async () => {
    const raceDir = mkdtempSync(path.join(tmpdir(), 'hermes-mkwin-'));
    const [a, b] = await Promise.all([
      resolveMasterKey({ hermesDir: raceDir, keychain: null }),
      resolveMasterKey({ hermesDir: raceDir, keychain: null }),
    ]);
    const onDisk = readFileSync(path.join(raceDir, 'master.key'));
    expect(a.equals(b)).toBe(true);
    expect(a.equals(onDisk)).toBe(true);
  });
});

describe('resolveMasterKey — malformed HERMES_MASTER_KEY (base64 round-trip validation)', () => {
  it('rejects garbled base64 that only coincidentally decodes to 32 bytes', async () => {
    // A canonical 32-byte base64 with an illegal char injected: Node silently drops
    // the illegal char and still decodes to 32 bytes, but the round-trip check catches it.
    const canonical = randomBytes(32).toString('base64');
    const garbled = `${canonical.slice(0, 20)}#${canonical.slice(20)}`;
    process.env['HERMES_MASTER_KEY'] = garbled;
    await expect(resolveMasterKey({ hermesDir: dir, keychain: null })).rejects.toThrow(/malformed/);
  });

  it('accepts a base64url-encoded key (normalization tolerates - and _ and missing padding)', async () => {
    const key = randomBytes(32);
    const b64url = key.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    process.env['HERMES_MASTER_KEY'] = b64url;
    const resolved = await resolveMasterKey({ hermesDir: dir, keychain: null });
    expect(resolved.equals(key)).toBe(true);
  });
});
