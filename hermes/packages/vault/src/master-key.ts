/**
 * Master-key resolution cascade for the Hermes vault.
 *
 * One 256-bit CSPRNG key roots every derived cipher key (the vault and the
 * separate session-state store each HKDF a distinct subkey from it, never
 * using the master directly). Resolution order (first hit wins):
 *
 *   1) HERMES_MASTER_KEY env    — base64, must decode to exactly 32 bytes
 *   2) key file ~/.hermes/master.key (raw 32 bytes)
 *   3) OS keychain               — @napi-rs/keyring, service="hermes"/account="master-key"
 *   4) generate-on-first-use     — randomBytes(32) → key file (0600, EXCLUSIVE) + keychain (best effort)
 *   5) fail closed               — throw
 *
 * The key FILE (step 2) is checked BEFORE the keychain (step 3) so an
 * unattended daemon (launchd/systemd/Task Scheduler) starts without triggering
 * an interactive keychain-unlock prompt.
 *
 * Generation (step 4) is the cross-process danger point: two cold-starting
 * processes each mint a DIFFERENT candidate key, and if both were allowed to
 * persist, the vault could end up encrypted under a key that is then clobbered —
 * permanently unrecoverable on the next restart. The key file is therefore an
 * EXCLUSIVE, race-arbitrating artifact: the first writer wins and every other
 * caller adopts THAT key. See {@link persistMasterKeyFile}.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { hermesDir, masterKeyFilePath, IS_WINDOWS } from './paths.js';
import { renameWithRetry } from './rename.js';

const KEY_LENGTH = 32;
const KEYCHAIN_SERVICE = 'hermes';
const KEYCHAIN_ACCOUNT = 'master-key';

/** Minimal keychain surface. Injectable so tests never touch the real OS keychain. */
export interface KeychainBackend {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
}

export interface ResolveMasterKeyOptions {
  /** Base `~/.hermes` dir. Defaults to `HERMES_DIR` env or `~/.hermes`. Tests pass a temp dir. */
  hermesDir?: string;
  /**
   * Keychain backend for cascade steps 3/4.
   *  - `undefined` (default): lazy-load the optional `@napi-rs/keyring` native module.
   *  - `null`: skip the keychain entirely (headless Linux, tests).
   *  - a backend object: use it directly (tests inject a stub).
   */
  keychain?: KeychainBackend | null;
  /** Generate-on-first-use (step 4). Default `true`; `false` forces fail-closed at step 5. */
  generate?: boolean;
}

/**
 * Lazily load `@napi-rs/keyring` and adapt its synchronous `Entry` API to the
 * async {@link KeychainBackend} surface. Returns `null` when the optional native
 * module is absent or fails to load, so the cascade continues instead of crashing.
 *
 * The specifier is read from a `string`-typed variable so `tsc` treats the
 * dynamic import as `any` and does not hard-fail when the optional dependency
 * is not installed.
 */
async function loadNapiKeychain(): Promise<KeychainBackend | null> {
  const spec: string = '@napi-rs/keyring';
  let mod: { Entry?: new (service: string, account: string) => { getPassword(): string | null; setPassword(pw: string): void } };
  try {
    mod = (await import(spec)) as typeof mod;
  } catch {
    return null; // optional dependency not installed / native load failed
  }
  const Entry = mod?.Entry;
  if (typeof Entry !== 'function') return null;
  return {
    async getPassword(service, account) {
      // napi-rs throws when no matching entry exists — treat as a miss.
      try { return new Entry(service, account).getPassword() ?? null; }
      catch { return null; }
    },
    async setPassword(service, account, password) {
      new Entry(service, account).setPassword(password);
    },
  };
}

/**
 * Decode a base64 string to exactly a 32-byte key, REJECTING garbled input that
 * only coincidentally decodes to 32 bytes. Node's base64 decoder silently drops
 * non-alphabet characters, so a corrupted value can still yield 32 bytes and then
 * surface much later as a bogus "corrupt vault" auth-tag failure. We require the
 * decoded bytes to re-encode to the same base64 the caller supplied (normalizing
 * whitespace, padding, and the base64url alphabet) so malformation is caught here.
 */
function decodeBase64Key(value: string): Buffer | null {
  const key = Buffer.from(value, 'base64');
  if (key.length !== KEY_LENGTH) return null;
  const normalize = (s: string): string =>
    s.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  return normalize(key.toString('base64')) === normalize(value) ? key : null;
}

/**
 * Persist the raw 32-byte key file EXCLUSIVELY and return the key that is
 * actually on disk afterward.
 *
 * The invariant: **the key a caller returns MUST equal the key persisted on
 * disk.** Cold-starting processes can each generate a different candidate, so
 * the key file is the cross-process arbiter — whichever process publishes it
 * first wins, and every other caller adopts that key.
 *
 * Publish uses `fs.link()` from a fully-written, fsync'd temp file:
 *   - link() is atomic and fails with EEXIST if another process already won, so
 *     it is an O_EXCL-grade exclusive create (a plain rename is last-writer-wins
 *     and would let two writers clobber each other);
 *   - the linked entry points at an inode whose 32 bytes were written and
 *     fsync'd BEFORE the link, so a loser that reads the file can never observe
 *     partial content (unlike open('wx') + write, which briefly exposes an empty
 *     file to a racing reader and would make the loser throw instead of adopting
 *     the winner's key).
 *
 * On EEXIST we re-read the winner's key and return it. On a filesystem without
 * hard-link support we fall back to a rename publish and re-read, still honoring
 * the return==on-disk invariant.
 */
async function persistMasterKeyFile(keyFile: string, candidate: Buffer): Promise<Buffer> {
  const dir = path.dirname(keyFile);
  await fs.mkdir(dir, { recursive: true });
  if (!IS_WINDOWS) { try { await fs.chmod(dir, 0o700); } catch { /* dir perms best-effort */ } }

  const readOnDisk = async (): Promise<Buffer> => {
    const onDisk = await fs.readFile(keyFile);
    if (onDisk.length !== KEY_LENGTH) {
      throw new Error(`master key file ${keyFile} is ${onDisk.length} bytes; expected exactly ${KEY_LENGTH}`);
    }
    return onDisk;
  };

  // Write our candidate to a private temp file with full, durable content.
  const tmp = `${keyFile}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const fh = await fs.open(tmp, 'wx', 0o600); // 'wx' = O_EXCL, defense-in-depth vs. symlink pre-plant
  try {
    await fh.writeFile(candidate);
    await fh.sync(); // fsync content before publishing the link
  } finally {
    await fh.close();
  }

  try {
    await fs.link(tmp, keyFile); // atomic EXCLUSIVE publish — throws EEXIST if we lost the race
    if (!IS_WINDOWS) { try { await fs.chmod(keyFile, 0o600); } catch { /* file perms best-effort */ } }
    return candidate; // we won — our key is what is on disk
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return await readOnDisk(); // another process won — adopt its key
    // Filesystem without hard-link support (rare, e.g. some network/FAT mounts):
    // fall back to a rename publish, then re-read so the return still equals disk.
    if (code === 'ENOSYS' || code === 'EPERM' || code === 'EMLINK' || code === 'EOPNOTSUPP') {
      await renameWithRetry(tmp, keyFile);
      if (!IS_WINDOWS) { try { await fs.chmod(keyFile, 0o600); } catch { /* file perms best-effort */ } }
      return await readOnDisk();
    }
    throw err; // real error → fail closed
  } finally {
    // Remove the extra link/temp. On the rename path the temp is already gone (ENOENT).
    try { await fs.unlink(tmp); } catch { /* best-effort cleanup */ }
  }
}

/**
 * Resolve the vault master key via the documented cascade. Throws (fail closed)
 * on a present-but-malformed source (wrong-length/garbled env, wrong-length file)
 * and, when generation is disabled, when every source is absent.
 */
export async function resolveMasterKey(options: ResolveMasterKeyOptions = {}): Promise<Buffer> {
  const dir = hermesDir(options.hermesDir);
  const generate = options.generate ?? true;

  // 1) HERMES_MASTER_KEY env (base64 → exactly 32 bytes).
  const env = process.env['HERMES_MASTER_KEY'];
  if (env !== undefined && env !== '') {
    const key = decodeBase64Key(env);
    if (!key) throw new Error('HERMES_MASTER_KEY is malformed: must be valid base64 that decodes to exactly 32 bytes');
    return key;
  }

  // 2) Key file `~/.hermes/master.key` (raw 32 bytes) — before the keychain (daemon-safe).
  const keyFile = masterKeyFilePath(dir);
  try {
    const key = await fs.readFile(keyFile);
    if (key.length !== KEY_LENGTH) {
      throw new Error(`master key file ${keyFile} is ${key.length} bytes; expected exactly ${KEY_LENGTH}`);
    }
    return key;
  } catch (err) {
    // ENOENT → continue the cascade; any other error (corrupt/unreadable) → fail closed.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  // 3) OS keychain (optional + lazy). `null` opts out entirely.
  const keychain = options.keychain === undefined ? await loadNapiKeychain() : options.keychain;
  if (keychain) {
    try {
      const stored = await keychain.getPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
      if (stored) {
        const key = decodeBase64Key(stored);
        if (key) return key;
      }
    } catch { /* keychain miss/unavailable → continue the cascade */ }
  }

  // 4) Generate-on-first-use: fresh CSPRNG candidate → persist EXCLUSIVELY (the key
  //    file is the cross-process arbiter) → mirror the ACTUAL persisted key to the
  //    keychain (best effort). The persisted key — not necessarily our candidate — is
  //    what we return, so every racing cold start converges on exactly one key.
  if (generate) {
    const key = await persistMasterKeyFile(keyFile, randomBytes(KEY_LENGTH));
    if (keychain) {
      try { await keychain.setPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, key.toString('base64')); }
      catch { /* keychain write best-effort — the key file is the durable copy */ }
    }
    return key;
  }

  // 5) Fail closed.
  throw new Error('no Hermes master key available (env, key file, and keychain all absent) and generation is disabled');
}
