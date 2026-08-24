import { getHermesVault } from '@hermes/vault';
import { HermesError, HermesErrorCode } from './errors.js';
import { type TokenBundle, TokenBundleSchema } from './types.js';

const SERVICE = 'hermes';

export interface KeyringAdapter {
  setPassword(service: string, account: string, password: string): Promise<void>;
  getPassword(service: string, account: string): Promise<string | null>;
  deletePassword(service: string, account: string): Promise<boolean>;
  findCredentials(service: string): Promise<Array<{ account: string; password: string }>>;
}

export class TokenStorage {
  constructor(private readonly keyring: KeyringAdapter) {}
  private account(service: string, scheme: string): string { return `${service}:${scheme}`; }

  async get(service: string, scheme: string): Promise<TokenBundle | null> {
    const raw = await this.keyring.getPassword(SERVICE, this.account(service, scheme));
    if (raw === null) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch (cause) {
      throw new HermesError(HermesErrorCode.STORAGE_ERROR, `corrupt token data for ${service}:${scheme}`, { cause, remediation: 'delete the stored credential and re-acquire' });
    }
    const result = TokenBundleSchema.safeParse(parsed);
    if (!result.success) throw new HermesError(HermesErrorCode.STORAGE_ERROR, `invalid token shape for ${service}:${scheme}: ${result.error.message}`);
    return result.data;
  }

  async set(bundle: TokenBundle): Promise<void> {
    const validated = TokenBundleSchema.parse(bundle);
    await this.keyring.setPassword(SERVICE, this.account(bundle.service, bundle.scheme), JSON.stringify(validated));
  }

  async delete(service: string, scheme: string): Promise<boolean> {
    return this.keyring.deletePassword(SERVICE, this.account(service, scheme));
  }

  async list(): Promise<TokenBundle[]> {
    const creds = await this.keyring.findCredentials(SERVICE);
    const out: TokenBundle[] = [];
    for (const { password } of creds) {
      try {
        const parsed = JSON.parse(password);
        const result = TokenBundleSchema.safeParse(parsed);
        if (result.success) out.push(result.data);
      } catch { /* skip corrupt */ }
    }
    return out;
  }
}

export async function createKeytarAdapter(): Promise<KeyringAdapter> {
  // Hermes's own built-in vault (@hermes/vault). The memoized singleton is the
  // write-serialization point; it structurally implements KeyringAdapter.
  return getHermesVault();
}
