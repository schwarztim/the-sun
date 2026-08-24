/**
 * Encrypted per-service Playwright storageState persistence.
 *
 * Persisting storageState (Entra SSO cookies like ESTSAUTH/ESTSAUTHPERSISTENT
 * plus MSAL localStorage cache) between acquisitions turns every reacquire
 * into a silent SSO redirect instead of a full AD login + CA + MFA replay.
 *
 * Storage backend: AES-256-GCM encrypted file per service under
 * `~/.hermes/session-state/<service>.json.enc` (override the directory with
 * HERMES_SESSION_STATE_DIR). These tens-of-KB storageState blobs are kept in
 * their own per-service files, deliberately SEPARATE from the Hermes credential
 * vault (`@hermes/vault`, a single whole-file store for small token/credential
 * entries): rewriting a large blob on every successful acquire would churn — and
 * race writers of — the single vault file. A dedicated encrypted file per
 * service has none of those hazards.
 *
 * Key material comes from the shared Hermes master key resolved by
 * `@hermes/vault`'s `resolveMasterKey()` (HERMES_MASTER_KEY env ->
 * ~/.hermes/master.key -> OS keychain -> generate-on-first-use). A per-purpose
 * subkey is derived via HKDF-SHA256 (salt `hermes-session-state`) so the master
 * key is never used directly as a cipher key and never collides with the vault's
 * own subkey. Cookies NEVER touch disk in plaintext: files are mode 0600 and
 * written atomically (tmp + rename).
 *
 * Kill switch: HERMES_SESSION_PERSIST=0 disables load/save/invalidate
 * entirely (cold-start behavior).
 *
 * All functions are fail-soft — persistence problems must never fail an
 * auth flow. Errors degrade to cold-start behavior with a logger warning.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { resolveMasterKey as resolveVaultMasterKey, renameWithRetry } from '@hermes/vault';

/** Exact shape returned by Playwright's `BrowserContext.storageState()`. */
export type SessionState = Awaited<ReturnType<import('patchright').BrowserContext['storageState']>>;

/** Minimal logger surface — ProviderLogger and pino-style loggers satisfy it. */
export interface SessionStateLogger {
  warn(msg: string, fields?: Record<string, unknown>): void;
}

const FORMAT_MAGIC = Buffer.from('HSS1'); // Hermes Session State v1
const NONCE_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const HKDF_SALT = 'hermes-session-state';

function persistEnabled(): boolean {
  return process.env['HERMES_SESSION_PERSIST'] !== '0';
}

function stateDir(): string {
  return process.env['HERMES_SESSION_STATE_DIR'] ?? path.join(os.homedir(), '.hermes', 'session-state');
}

/** Restrict service names to a filesystem-safe charset (path-traversal guard). */
function sanitizeService(service: string): string {
  const safe = service.replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!safe || /^\.+$/.test(safe)) throw new Error(`invalid service name for session state: ${JSON.stringify(service)}`);
  return safe;
}

function stateFilePath(service: string): string {
  return path.join(stateDir(), `${sanitizeService(service)}.json.enc`);
}

/**
 * Resolve the master key from the shared Hermes vault cascade
 * (`@hermes/vault` — HERMES_MASTER_KEY env → ~/.hermes/master.key → OS keychain
 * → generate-on-first-use). Fail-soft: session-state degrades to cold-start on
 * ANY failure and never throws, so a missing/rotated key can never fail an auth
 * flow. The vault's `resolveMasterKey` returns a 32-byte Buffer or throws; this
 * wrapper converts a throw into `null`.
 */
async function resolveMasterKey(): Promise<Buffer | null> {
  try {
    // generate:false — the broker's credential vault owns generation-on-first-use;
    // session-state only *uses* an existing key, otherwise degrades to cold-start.
    return await resolveVaultMasterKey({ generate: false });
  } catch {
    return null;
  }
}

/** Derive a session-state-specific subkey; the service name binds the key per service. */
function deriveKey(master: Buffer, service: string): Buffer {
  return Buffer.from(hkdfSync('sha256', master, HKDF_SALT, sanitizeService(service), KEY_LENGTH));
}

/**
 * Load the persisted storageState for `service`. Returns undefined on any
 * miss (no file, no key, kill switch, corrupt/tampered ciphertext) so the
 * caller falls back to a cold-start context.
 */
export async function loadSessionState(service: string, logger?: SessionStateLogger): Promise<SessionState | undefined> {
  if (!persistEnabled()) return undefined;
  try {
    const master = await resolveMasterKey();
    if (!master) return undefined;
    const raw = await fs.readFile(stateFilePath(service));
    const headerLen = FORMAT_MAGIC.length + NONCE_LENGTH + AUTH_TAG_LENGTH;
    if (raw.length <= headerLen || !raw.subarray(0, FORMAT_MAGIC.length).equals(FORMAT_MAGIC)) return undefined;
    const nonce = raw.subarray(FORMAT_MAGIC.length, FORMAT_MAGIC.length + NONCE_LENGTH);
    const tag = raw.subarray(FORMAT_MAGIC.length + NONCE_LENGTH, headerLen);
    const ciphertext = raw.subarray(headerLen);
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(master, service), nonce);
    decipher.setAAD(Buffer.from(sanitizeService(service), 'utf8'));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8')) as SessionState;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger?.warn('failed to load session state; falling back to cold start', { service, error: (err as Error).message });
    }
    return undefined;
  }
}

/**
 * Encrypt and persist `state` for `service` (atomic tmp + rename, mode 0600).
 * Fail-soft: a persistence failure logs a warning and returns — it never
 * fails the auth flow that produced the state.
 */
export async function saveSessionState(service: string, state: SessionState, logger?: SessionStateLogger): Promise<void> {
  if (!persistEnabled()) return;
  try {
    const master = await resolveMasterKey();
    if (!master) {
      logger?.warn('no master key available; session state not persisted', { service });
      return;
    }
    const nonce = randomBytes(NONCE_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', deriveKey(master, service), nonce);
    cipher.setAAD(Buffer.from(sanitizeService(service), 'utf8'));
    const plaintext = Buffer.from(JSON.stringify(state), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const payload = Buffer.concat([FORMAT_MAGIC, nonce, cipher.getAuthTag(), ciphertext]);

    const file = stateFilePath(service);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(tmp, payload, { mode: 0o600 });
    await renameWithRetry(tmp, file); // retry transient EPERM/EBUSY/EACCES (Windows AV handle contention)
    await fs.chmod(file, 0o600);
  } catch (err) {
    logger?.warn('failed to persist session state', { service, error: (err as Error).message });
  }
}

/**
 * Remove the persisted storageState for `service`. Called on auth failure /
 * ConditionalAccessChallengeError — a stale or revoked session must not be
 * retried. Fail-soft; missing file is a no-op.
 */
export async function invalidateSessionState(service: string, logger?: SessionStateLogger): Promise<void> {
  if (!persistEnabled()) return;
  try {
    await fs.unlink(stateFilePath(service));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger?.warn('failed to invalidate session state', { service, error: (err as Error).message });
    }
  }
}
