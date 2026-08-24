#!/usr/bin/env node
/**
 * One-time migration: copy the SSO password + TOTP-seed credentials from the
 * macOS `secure-tools.keychain-db` into the Isaac vault, keyed `service::account`
 * (the form VaultStore.get(service, account) resolves).
 *
 * WHY: Hermes providers used to read these via the `security` CLI on every
 * re-acquire, which prompts a macOS keychain UNLOCK every time the keychain is
 * locked. After this migration, auth-core's readKeychainPassword resolves them
 * from the vault (master.key file → never prompts). This is the "authenticate
 * once" step: reading from the keychain here may trigger ONE unlock; afterwards
 * the keychain is never read again.
 *
 * SECURITY: secret values flow keychain → vault inside this process only. They
 * are NEVER passed as CLI args and NEVER printed (only char-counts). Run it in
 * your own terminal:  node scripts/migrate-sso-keychain-to-vault.mjs
 *
 * Idempotent: pairs already present in the vault are skipped.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { VaultStore } from 'node-vault-mcp';

const KEYCHAIN = join(homedir(), 'Library', 'Keychains', 'secure-tools.keychain-db');

// Derive the (service, account) pairs the providers request directly from the
// live services.json — no hardcoded account identifiers, portable across hosts,
// and automatically covers any newly-added service.
const SERVICES_JSON = join(homedir(), '.hermes', 'services.json');
const { services } = JSON.parse(readFileSync(SERVICES_JSON, 'utf8'));
const pairMap = new Map();
for (const s of services) {
  const c = s.config ?? {};
  if (c.passwordKeychainService && c.passwordKeychainAccount)
    pairMap.set(`${c.passwordKeychainService}::${c.passwordKeychainAccount}`, { service: c.passwordKeychainService, account: c.passwordKeychainAccount });
  if (c.totpKeychainService && c.totpKeychainAccount)
    pairMap.set(`${c.totpKeychainService}::${c.totpKeychainAccount}`, { service: c.totpKeychainService, account: c.totpKeychainAccount });
}
const PAIRS = [...pairMap.values()];

function readKeychain(service, account) {
  try {
    // -w prints ONLY the password to stdout; captured into memory, never echoed.
    return execFileSync('security',
      ['find-generic-password', '-s', service, '-a', account, '-w', KEYCHAIN],
      { encoding: 'utf8' }).replace(/\n$/, '');
  } catch {
    return null; // not in this keychain
  }
}

const store = new VaultStore();
let migrated = 0, skipped = 0, missing = 0;

for (const { service, account } of PAIRS) {
  const existing = await store.get(service, account);
  if (existing) { console.log(`  ⊘ ${service}::${account} (already in vault)`); skipped++; continue; }

  const value = readKeychain(service, account);
  if (!value) { console.log(`  ⚠ ${service}::${account} (NOT FOUND in keychain — skipping)`); missing++; continue; }

  await store.set(service, account, value);
  console.log(`  ✓ ${service}::${account} (${value.length} chars)`);
  migrated++;
}

console.log(`\nDone. migrated=${migrated} skipped=${skipped} missing=${missing}`);
if (missing > 0) {
  console.log('Missing pairs are not in secure-tools.keychain-db — add them to the vault manually with secrets.py set if those services need them.');
}
