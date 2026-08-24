/**
 * `@hermes/vault` — Hermes's self-contained, cross-platform credential vault.
 *
 * Public contract:
 *   - {@link HermesVault}       whole-file AES-256-GCM store implementing both the
 *                               broker's KeyringAdapter and auth-core's CredentialStore shapes.
 *   - {@link getHermesVault}    memoized singleton (the write-serialization point).
 *   - {@link resolveMasterKey}  the master-key resolution cascade (shared with session-state).
 */
import { HermesVault } from './vault.js';
import { resolveMasterKey } from './master-key.js';

export { HermesVault } from './vault.js';
export type { HermesVaultOptions, KeyringAdapterLike, CredentialStoreLike, VaultEntryMeta } from './vault.js';
export { resolveMasterKey } from './master-key.js';
export type { ResolveMasterKeyOptions, KeychainBackend } from './master-key.js';
export { renameWithRetry } from './rename.js';

let singleton: Promise<HermesVault> | undefined;

/**
 * Memoized {@link HermesVault} singleton. The single instance's in-process write
 * queue is the serialization point that prevents same-process lost writes; the
 * cross-process lock covers the rest. Vault location honors `HERMES_DIR`, and the
 * master key is resolved once via {@link resolveMasterKey}.
 */
export async function getHermesVault(): Promise<HermesVault> {
  if (!singleton) {
    const pending = (async () => {
      const masterKey = await resolveMasterKey();
      return new HermesVault({ masterKey });
    })();
    // Do not permanently cache a rejected resolution — let the next call retry.
    pending.catch(() => { if (singleton === pending) singleton = undefined; });
    singleton = pending;
  }
  return singleton;
}

/** Test-only: drop the memoized singleton so a changed env/config takes effect. */
export function __resetHermesVaultForTests(): void {
  singleton = undefined;
}
