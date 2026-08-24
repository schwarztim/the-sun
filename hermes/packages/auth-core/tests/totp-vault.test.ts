import { describe, it, expect, vi, beforeEach } from 'vitest';

// readKeychainPassword must resolve credentials from the Isaac vault FIRST
// (master.key file → never prompts the macOS keychain) and only fall back to the
// `security` CLI on a vault miss/error. These tests lock that contract: a vault
// hit must NEVER invoke `security` (the source of the keychain unlock prompts).

// promisify(execFile) expects a callback-style fn: (file, args, opts, cb).
function execFileReturning(stdout: string) {
  return vi.fn((_file: string, _args: string[], _opts: unknown, cb: (e: unknown, r: unknown) => void) =>
    cb(null, { stdout, stderr: '' }));
}

beforeEach(() => {
  vi.resetModules();   // fresh module → fresh in-process _credCache
  vi.clearAllMocks();
});

describe('readKeychainPassword — vault-first', () => {
  it('returns the vault value and NEVER invokes security', async () => {
    const execFile = vi.fn();
    vi.doMock('node:child_process', () => ({ execFile }));
    vi.doMock('../src/credential-store.js', () => ({
      createCredentialStore: async () => ({ get: async (s: string, a: string) => (s === 'sso' && a === 'password' ? 's3cr3t' : null) }),
    }));
    const { readKeychainPassword } = await import('../src/totp.js');

    expect(await readKeychainPassword('sso', 'password')).toBe('s3cr3t');
    expect(execFile).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform !== 'darwin')('falls back to the keychain on a vault miss', async () => {
    const execFile = execFileReturning('from-keychain\n');
    vi.doMock('node:child_process', () => ({ execFile }));
    vi.doMock('../src/credential-store.js', () => ({
      createCredentialStore: async () => ({ get: async () => null }),  // vault miss
    }));
    const { readKeychainPassword } = await import('../src/totp.js');

    expect(await readKeychainPassword('sso', 'password')).toBe('from-keychain');
    expect(execFile).toHaveBeenCalledOnce();
  });

  it.skipIf(process.platform !== 'darwin')('falls back to the keychain when the vault throws', async () => {
    const execFile = execFileReturning('from-keychain\n');
    vi.doMock('node:child_process', () => ({ execFile }));
    vi.doMock('../src/credential-store.js', () => ({
      createCredentialStore: async () => { throw new Error('vault unavailable'); },
    }));
    const { readKeychainPassword } = await import('../src/totp.js');

    expect(await readKeychainPassword('sso', 'password')).toBe('from-keychain');
    expect(execFile).toHaveBeenCalledOnce();
  });

  it('caches the resolved value — second call does not re-read the vault', async () => {
    const get = vi.fn(async () => 'cached-secret');
    vi.doMock('node:child_process', () => ({ execFile: vi.fn() }));
    vi.doMock('../src/credential-store.js', () => ({ createCredentialStore: async () => ({ get }) }));
    const { readKeychainPassword } = await import('../src/totp.js');

    await readKeychainPassword('sso', 'password');
    await readKeychainPassword('sso', 'password');
    expect(get).toHaveBeenCalledOnce();
  });

  it('TOTP path is also prompt-free: seed from vault, no security call', async () => {
    const execFile = vi.fn();
    vi.doMock('node:child_process', () => ({ execFile }));
    vi.doMock('../src/credential-store.js', () => ({
      createCredentialStore: async () => ({ get: async () => 'JBSWY3DPEHPK3PXP' }),  // base32 seed
    }));
    const { readTotpFromKeychain } = await import('../src/totp.js');

    const code = await readTotpFromKeychain('sso-totp', 'user@example.com');
    expect(code).toMatch(/^\d{6}$/);
    expect(execFile).not.toHaveBeenCalled();
  });
});
