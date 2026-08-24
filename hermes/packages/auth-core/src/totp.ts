import { createHmac } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32ToBytes(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const c of clean) {
    const idx = BASE32.indexOf(c);
    if (idx >= 0) bits += idx.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

export function generateTotp(secret: string, timeMs: number = Date.now()): string {
  const key = base32ToBytes(secret);
  const time = Math.floor(timeMs / 30_000);
  const timeBuffer = Buffer.alloc(8);
  timeBuffer.writeUInt32BE(Math.floor(time / 0x100000000), 0);
  timeBuffer.writeUInt32BE(time & 0xffffffff, 4);
  const hmac = createHmac('sha1', key).update(timeBuffer).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const code =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return (code % 1_000_000).toString().padStart(6, '0');
}

// In-process cache of resolved credentials. SSO password/TOTP-seed material is
// static for the broker's lifetime, so this avoids re-decrypting the vault on
// every read; broker restart clears it. Keyed `service::account`. Caches the
// resolved value AND a null miss (so a miss doesn't re-hit the vault+keychain).
const _credCache = new Map<string, string | null>();

/**
 * Resolve a credential (password or TOTP seed) the providers reference by
 * (service, account). Reads the Hermes vault FIRST (`@hermes/vault`, via
 * createCredentialStore) — it resolves its master key from ~/.hermes/master.key
 * (or the master-key cascade) and NEVER triggers an interactive keychain unlock
 * prompt. Falls back to the legacy macOS keychain (secure-tools, macOS only) on
 * a vault miss/error, so an un-migrated credential still works. The function
 * name is kept for caller stability; in steady state (creds stored in the vault
 * as `service::account`) the `security` CLI is never invoked → no prompts.
 */
export async function readKeychainPassword(service: string, account: string): Promise<string | null> {
  const cacheKey = `${service}::${account}`;
  if (_credCache.has(cacheKey)) return _credCache.get(cacheKey)!;

  const trace = process.env['HERMES_CRED_TRACE'];
  // 1. Vault first (no prompt). Lazy import avoids any module-load-time vault
  //    construction and any future circular dependency with credential-store.
  try {
    const { createCredentialStore } = await import('./credential-store.js');
    const store = await createCredentialStore();
    const fromVault = await store.get(service, account);
    if (fromVault) {
      if (trace) console.error(`[cred] service=${service} account=${account} source=vault`);
      _credCache.set(cacheKey, fromVault);
      return fromVault;
    }
  } catch { /* fall through to keychain */ }

  // 2. Legacy macOS keychain fallback (may prompt if locked — only reached for
  //    a credential not yet present in the vault). macOS-only: `security` is a
  //    Darwin CLI, so on Windows/Linux we skip straight to a cached miss instead
  //    of spawning a nonexistent binary.
  if (process.platform === 'darwin') {
    try {
      const keychainPath = `${process.env['HOME']}/Library/Keychains/secure-tools.keychain-db`;
      const { stdout } = await execFileAsync('security', [
        'find-generic-password', '-s', service, '-a', account, '-w', keychainPath,
      ], { timeout: 5_000 });
      const value = stdout.trim() || null;
      if (trace) console.error(`[cred] service=${service} account=${account} source=keychain`);
      _credCache.set(cacheKey, value);
      return value;
    } catch {
      _credCache.set(cacheKey, null);
      return null;
    }
  }

  _credCache.set(cacheKey, null);
  return null;
}

/**
 * Extract the bare base32 secret from either a raw secret string or an
 * otpauth:// URI (e.g. otpauth://totp/Example%2c+Inc.%3auser%40example.com?secret=JBSWY3DP&issuer=Example).
 */
export function extractTotpSecret(input: string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith('otpauth://')) {
    const url = new URL(trimmed);
    const secret = url.searchParams.get('secret');
    if (!secret) throw new Error('otpauth:// URI missing secret parameter');
    return secret;
  }
  return trimmed;
}

export async function readTotpFromKeychain(service: string, account: string): Promise<string | null> {
  const raw = await readKeychainPassword(service, account);
  if (!raw) return null;
  return generateTotp(extractTotpSecret(raw));
}

/**
 * Resolve the base32 TOTP SEED (not a code) from the vault/keychain. Used by
 * providers to build a lazy supplier so codes are generated at FILL TIME —
 * generating at acquire() start freezes a code that is expired by the time
 * the MFA input appears 30-120s later.
 */
export async function readTotpSeedFromKeychain(service: string, account: string): Promise<string | null> {
  const raw = await readKeychainPassword(service, account);
  if (!raw) return null;
  return extractTotpSecret(raw);
}

// ---------------------------------------------------------------------------
// Lazy TOTP supply: fill-time generation + freshness guard + anti-replay
// ---------------------------------------------------------------------------

/** Lazy code generator resolved at fill time. */
export type TotpSupplier = () => Promise<string>;
/** Backward-compatible TOTP plumbing type: a frozen code or a lazy supplier. */
export type TotpInput = string | TotpSupplier;

/**
 * Thrown when the IdP rejects a submitted TOTP twice (initial + one
 * regenerated retry in a later window). Further submissions risk an Entra
 * OATH lockout, which removes TOTP from the MFA picker entirely.
 */
export class TotpRejectedError extends Error {
  constructor() {
    super('TOTP rejected twice — verify the seed in the vault matches the IdP registration (sso-totp)');
    this.name = 'TotpRejectedError';
  }
}

const TOTP_WINDOW_MS = 30_000;
/** If fewer than this many ms remain in the window, wait for the next one. */
const TOTP_MIN_REMAINING_MS = 5_000;

/**
 * Host-wide anti-replay registry: service → last 30s window for which a code
 * was handed out. TOTP codes are single-use at Entra; two concurrent acquires
 * submitting the same window's code guarantees one MFA failure.
 */
const _suppliedWindows = new Map<string, number>();

/** Test-only: clear the anti-replay registry between tests. */
export function resetTotpReplayRegistryForTests(): void {
  _suppliedWindows.clear();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Generate a fresh code for `service` from `seed`, honoring:
 *  - freshness: if <5s remain in the current 30s window, wait for the boundary
 *  - anti-replay: if this window's code was already supplied for this service
 *    (host-wide, across concurrent acquires), wait for the next window
 */
export async function supplyFreshTotp(service: string, seed: string): Promise<string> {
  for (;;) {
    const now = Date.now();
    const intoWindow = now % TOTP_WINDOW_MS;
    if (TOTP_WINDOW_MS - intoWindow < TOTP_MIN_REMAINING_MS) {
      await sleep(TOTP_WINDOW_MS - intoWindow);
      continue;
    }
    const window = Math.floor(now / TOTP_WINDOW_MS);
    const last = _suppliedWindows.get(service);
    if (last !== undefined && last >= window) {
      await sleep(TOTP_WINDOW_MS - intoWindow);
      continue;
    }
    // Synchronous check+set between awaits — atomic on the event loop, so two
    // concurrent suppliers for the same service cannot claim the same window.
    _suppliedWindows.set(service, window);
    return generateTotp(seed, now);
  }
}

/** Build the lazy supplier providers pass through the auth plumbing. */
export function makeTotpSupplier(service: string, seed: string): TotpSupplier {
  return () => supplyFreshTotp(service, seed);
}

/** Resolve a TotpInput right before filling. Strings pass through (back-compat). */
export async function resolveTotp(totp: TotpInput | undefined): Promise<string | undefined> {
  if (totp === undefined) return undefined;
  return typeof totp === 'function' ? await totp() : totp;
}
