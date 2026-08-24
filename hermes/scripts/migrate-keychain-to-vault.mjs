#!/usr/bin/env node
/**
 * One-time migration: copy hermes keychain tokens to Isaac vault.
 * Run BEFORE switching to VaultStore.
 */
import keytar from 'keytar';
import { VaultStore } from 'node-vault-mcp';

const store = new VaultStore();
const SERVICE = 'hermes';

const creds = await keytar.findCredentials(SERVICE);
console.log(`Found ${creds.length} hermes credentials in keychain`);

let migrated = 0;
for (const { account, password } of creds) {
  const existing = await store.getPassword(SERVICE, account);
  if (existing) {
    console.log(`  ⊘ ${account} (already in vault)`);
    continue;
  }
  await store.setPassword(SERVICE, account, password);
  console.log(`  ✓ ${account} (${password.length} chars)`);
  migrated++;
}

console.log(`\nMigrated ${migrated} hermes credentials to vault.`);
