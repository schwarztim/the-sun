import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getHermesVault } from '@hermes/vault';

const execFileAsync = promisify(execFile);

export interface CredentialStore {
  get(service: string, account: string): Promise<string | null>;
  set(service: string, account: string, value: string): Promise<void>;
  delete(service: string, account: string): Promise<boolean>;
}

/**
 * @deprecated Superseded by `@hermes/vault` (`getHermesVault()`), the built-in
 * cross-platform vault. macOS-only; kept for one transition release. Do not wire
 * into new code.
 */
export class MacKeychainStore implements CredentialStore {
  private readonly keychainPath: string;

  constructor(keychainPath?: string) {
    this.keychainPath = keychainPath ?? `${process.env['HOME']}/Library/Keychains/secure-tools.keychain-db`;
  }

  async get(service: string, account: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync('security', [
        'find-generic-password', '-s', service, '-a', account, '-w', this.keychainPath,
      ], { timeout: 5_000 });
      const value = stdout.trim();
      return value || null;
    } catch {
      return null;
    }
  }

  async set(service: string, account: string, value: string): Promise<void> {
    // Delete existing entry first (ignore errors if not found)
    try {
      await execFileAsync('security', [
        'delete-generic-password', '-s', service, '-a', account, this.keychainPath,
      ], { timeout: 5_000 });
    } catch { /* not found, ok */ }

    await execFileAsync('security', [
      'add-generic-password', '-s', service, '-a', account, '-w', value, this.keychainPath,
    ], { timeout: 5_000 });
  }

  async delete(service: string, account: string): Promise<boolean> {
    try {
      await execFileAsync('security', [
        'delete-generic-password', '-s', service, '-a', account, this.keychainPath,
      ], { timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * @deprecated Superseded by `@hermes/vault` (`getHermesVault()`). Kept for one
 * transition release; do not wire into new code.
 */
export class KeytarStore implements CredentialStore {
  constructor(private readonly keytar: { getPassword: (s: string, a: string) => Promise<string | null>; setPassword: (s: string, a: string, v: string) => Promise<void>; deletePassword: (s: string, a: string) => Promise<boolean> }) {}

  async get(service: string, account: string): Promise<string | null> {
    return this.keytar.getPassword(service, account);
  }

  async set(service: string, account: string, value: string): Promise<void> {
    await this.keytar.setPassword(service, account, value);
  }

  async delete(service: string, account: string): Promise<boolean> {
    return this.keytar.deletePassword(service, account);
  }
}

interface VaultData { [key: string]: string }

/**
 * @deprecated Superseded by `@hermes/vault` (`getHermesVault()`). This store has
 * known defects (static-salt scrypt key, fail-open decrypt that can destroy the
 * vault, no concurrency control) that the built-in vault fixes. Kept for one
 * transition release; do not wire into new code.
 */
export class FileStore implements CredentialStore {
  private readonly vaultPath: string;
  private readonly passphrase: string;

  constructor(vaultPath?: string, passphrase?: string) {
    this.vaultPath = vaultPath ?? path.join(process.env['HOME'] ?? '~', '.hermes', 'vault.enc');
    const key = passphrase ?? process.env['HERMES_VAULT_KEY'];
    if (!key) throw new Error('HERMES_VAULT_KEY env var required for file-based credential store');
    this.passphrase = key;
  }

  private deriveKey(): Buffer {
    return scryptSync(this.passphrase, 'hermes-vault-salt', 32);
  }

  private async readVault(): Promise<VaultData> {
    try {
      const raw = await fs.readFile(this.vaultPath);
      // Format: 12-byte IV + 16-byte auth tag + ciphertext
      if (raw.length < 28) return {};
      const iv = raw.subarray(0, 12);
      const tag = raw.subarray(12, 28);
      const ciphertext = raw.subarray(28);
      const decipher = createDecipheriv('aes-256-gcm', this.deriveKey(), iv);
      decipher.setAuthTag(tag);
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return JSON.parse(decrypted.toString('utf8')) as VaultData;
    } catch {
      return {};
    }
  }

  private async writeVault(data: VaultData): Promise<void> {
    await fs.mkdir(path.dirname(this.vaultPath), { recursive: true });
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.deriveKey(), iv);
    const json = JSON.stringify(data);
    const encrypted = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    await fs.writeFile(this.vaultPath, Buffer.concat([iv, tag, encrypted]), { mode: 0o600 });
  }

  private key(service: string, account: string): string {
    return `${service}::${account}`;
  }

  async get(service: string, account: string): Promise<string | null> {
    const data = await this.readVault();
    return data[this.key(service, account)] ?? null;
  }

  async set(service: string, account: string, value: string): Promise<void> {
    const data = await this.readVault();
    data[this.key(service, account)] = value;
    await this.writeVault(data);
  }

  async delete(service: string, account: string): Promise<boolean> {
    const data = await this.readVault();
    const k = this.key(service, account);
    if (!(k in data)) return false;
    delete data[k];
    await this.writeVault(data);
    return true;
  }
}

export class MemoryStore implements CredentialStore {
  private readonly store = new Map<string, string>();

  async get(service: string, account: string): Promise<string | null> {
    return this.store.get(`${service}::${account}`) ?? null;
  }

  async set(service: string, account: string, value: string): Promise<void> {
    this.store.set(`${service}::${account}`, value);
  }

  async delete(service: string, account: string): Promise<boolean> {
    return this.store.delete(`${service}::${account}`);
  }
}

export async function createCredentialStore(): Promise<CredentialStore> {
  // Hermes's own built-in vault (@hermes/vault). The memoized singleton is the
  // write-serialization point; it structurally implements CredentialStore.
  return getHermesVault();
}
