/**
 * HermesVault — whole-file AES-256-GCM credential store.
 *
 * One encrypted file (`~/.hermes/vault.enc`) holds every entry, so entry and
 * service names never appear in cleartext to EDR/backup agents. The file is a
 * self-describing `HV1` envelope:
 *
 *     magic "HV1\0" (4) | nonce (12) | GCM tag (16) | ciphertext
 *
 * AAD = magic bytes + the constant label `hermes-vault-v1`, binding the
 * ciphertext to this format/purpose (an HV1 blob can never be decrypted as a
 * session-state file or a future HV2). The cipher key is HKDF-derived from the
 * master key (never the master key directly).
 *
 * Fail CLOSED: a missing file is an empty first-run vault; ANY other read,
 * parse, or auth-tag failure throws — the vault never silently returns `{}`
 * (which the previous FileStore did, destroying data on the next write).
 *
 * Concurrency: an in-process promise-chain queue serializes read-modify-write
 * on the memoized singleton; a cross-process `O_EXCL` lock file guards the same
 * cycle across processes. The lost-write defense is the fresh read UNDER the
 * lock: every mutation re-reads and re-decrypts the current on-disk payload
 * while holding the exclusive lock, so a writer always mutates the latest state
 * and can never clobber a concurrent writer's committed change. `rev` is a
 * monotonic revision counter (metadata/observability) — it is NOT a
 * compare-and-swap backstop; the lock plus fresh read is the actual guarantee.
 *
 * This is a LEAF package: it imports from neither `@hermes/auth-core` nor
 * `@hermes/broker`. It implements their store shapes structurally.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { acquireLock, type LockOptions } from './lock.js';
import { renameWithRetry } from './rename.js';
import { vaultFilePath, lockFilePath, IS_WINDOWS } from './paths.js';

const MAGIC = Buffer.from('HV1\0', 'latin1'); // 4 bytes: 0x48 0x56 0x31 0x00
const AAD = Buffer.concat([MAGIC, Buffer.from('hermes-vault-v1', 'utf8')]);
const NONCE_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const HEADER_LENGTH = MAGIC.length + NONCE_LENGTH + AUTH_TAG_LENGTH; // 32

interface VaultEntry {
  value: string;
  updatedAt: string;
}

interface VaultPayload {
  v: 1;
  rev: number;
  entries: Record<string, VaultEntry>;
}

const emptyPayload = (): VaultPayload => ({ v: 1, rev: 0, entries: {} });

/**
 * Structural mirror of the broker's `KeyringAdapter`. Broker calls these with
 * `service="hermes"`, `account="<svc>:<scheme>"`, so the stored key is
 * `"hermes::<svc>:<scheme>"` and `findCredentials("hermes")` returns every
 * entry under that prefix as `{ account: keyWithoutPrefix, password: value }`.
 */
export interface KeyringAdapterLike {
  setPassword(service: string, account: string, password: string): Promise<void>;
  getPassword(service: string, account: string): Promise<string | null>;
  deletePassword(service: string, account: string): Promise<boolean>;
  findCredentials(service: string): Promise<Array<{ account: string; password: string }>>;
}

/** Structural mirror of auth-core's `CredentialStore`; key `"<service>::<account>"`. */
export interface CredentialStoreLike {
  get(service: string, account: string): Promise<string | null>;
  set(service: string, account: string, value: string): Promise<void>;
  delete(service: string, account: string): Promise<boolean>;
}

export interface HermesVaultOptions {
  /** The 256-bit master key (from {@link resolveMasterKey}). */
  masterKey: Buffer;
  /** Explicit vault file path (tests). Defaults to `<hermesDir>/vault.enc`. */
  vaultPath?: string;
  /** Base `~/.hermes` dir override, used only when `vaultPath` is not given. */
  hermesDir?: string;
  /** Lock tuning (stale/timeout windows). */
  lock?: LockOptions;
}

export class HermesVault implements KeyringAdapterLike, CredentialStoreLike {
  private readonly vaultPath: string;
  private readonly lockPath: string;
  private readonly cipherKey: Buffer;
  private readonly lockOptions: LockOptions;
  /** In-process read-modify-write serializer (the memoized singleton is the barrier). */
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(options: HermesVaultOptions) {
    if (!Buffer.isBuffer(options.masterKey) || options.masterKey.length !== KEY_LENGTH) {
      throw new Error(`HermesVault requires a ${KEY_LENGTH}-byte master key`);
    }
    this.vaultPath = options.vaultPath ?? vaultFilePath(options.hermesDir);
    this.lockPath = lockFilePath(this.vaultPath);
    // Domain-separated cipher key — never the master key itself.
    this.cipherKey = Buffer.from(hkdfSync('sha256', options.masterKey, 'hermes-vault', 'vault-v1', KEY_LENGTH));
    this.lockOptions = options.lock ?? {};
  }

  private entryKey(service: string, account: string): string {
    return `${service}::${account}`;
  }

  // --- envelope crypto ---------------------------------------------------

  private encrypt(payload: VaultPayload): Buffer {
    const nonce = randomBytes(NONCE_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', this.cipherKey, nonce);
    cipher.setAAD(AAD);
    const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([MAGIC, nonce, cipher.getAuthTag(), ciphertext]);
  }

  private decrypt(raw: Buffer): VaultPayload {
    if (raw.length < HEADER_LENGTH || !raw.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new Error(`vault file ${this.vaultPath} is not a valid HV1 envelope (corrupt or wrong format)`);
    }
    const nonce = raw.subarray(MAGIC.length, MAGIC.length + NONCE_LENGTH);
    const tag = raw.subarray(MAGIC.length + NONCE_LENGTH, HEADER_LENGTH);
    const ciphertext = raw.subarray(HEADER_LENGTH);
    const decipher = createDecipheriv('aes-256-gcm', this.cipherKey, nonce);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    // Auth-tag / AAD mismatch throws here — propagate (fail CLOSED; never `{}`).
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    let parsed: unknown;
    try {
      parsed = JSON.parse(plaintext.toString('utf8'));
    } catch (cause) {
      throw new Error(`vault file ${this.vaultPath} decrypted to invalid JSON`, { cause });
    }
    return normalizePayload(parsed);
  }

  /** Read + decrypt. `ENOENT` → empty first-run vault; any other error → throw. */
  private async readPayload(): Promise<VaultPayload> {
    let raw: Buffer;
    try {
      raw = await fs.readFile(this.vaultPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyPayload();
      throw err;
    }
    return this.decrypt(raw);
  }

  // --- atomic durable write ---------------------------------------------

  private async writePayload(payload: VaultPayload): Promise<void> {
    const data = this.encrypt(payload);
    const dir = path.dirname(this.vaultPath);
    await fs.mkdir(dir, { recursive: true });
    if (!IS_WINDOWS) { try { await fs.chmod(dir, 0o700); } catch { /* dir perms best-effort */ } }

    const tmp = `${this.vaultPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    const fh = await fs.open(tmp, 'wx', 0o600); // 'wx' = O_EXCL — defense-in-depth vs. symlink pre-plant
    try {
      await fh.writeFile(data);
      await fh.sync(); // fsync file contents before the rename
    } finally {
      await fh.close();
    }
    if (!IS_WINDOWS) { try { await fs.chmod(tmp, 0o600); } catch { /* file perms best-effort */ } }

    await renameWithRetry(tmp, this.vaultPath);
    if (!IS_WINDOWS) {
      try { await fs.chmod(this.vaultPath, 0o600); } catch { /* file perms best-effort */ }
      await fsyncDir(dir); // durably persist the rename (best-effort; rename is already atomic)
    }
  }

  // --- serialized read-modify-write -------------------------------------

  /**
   * Run `mutator` against a fresh copy of the payload under both the in-process
   * queue and the cross-process lock. `mutator` returns the caller's result plus
   * whether it changed anything — an unchanged run (e.g. deleting a missing key)
   * writes nothing, so it never creates or churns the file.
   */
  private async mutate<T>(mutator: (payload: VaultPayload) => { value: T; changed: boolean }): Promise<T> {
    const run = async (): Promise<T> => {
      const release = await acquireLock(this.lockPath, this.lockOptions);
      try {
        const payload = await this.readPayload(); // fresh read UNDER the lock → on-disk state is authoritative
        const { value, changed } = mutator(payload);
        if (changed) {
          payload.rev += 1; // monotonic revision counter (metadata); the lock + fresh read is the real defense
          payload.v = 1;
          await this.writePayload(payload);
        }
        return value;
      } finally {
        await release();
      }
    };
    // Chain onto the queue (continue even if a prior mutation rejected), and keep
    // the shared chain from carrying this call's result/rejection to the next.
    const chained = this.writeChain.then(run, run);
    this.writeChain = chained.then(() => undefined, () => undefined);
    return chained;
  }

  // --- KeyringAdapter + CredentialStore (shared entries, key `service::account`) ---

  async setPassword(service: string, account: string, password: string): Promise<void> {
    await this.mutate((payload) => {
      payload.entries[this.entryKey(service, account)] = { value: password, updatedAt: new Date().toISOString() };
      return { value: undefined, changed: true };
    });
  }

  async set(service: string, account: string, value: string): Promise<void> {
    await this.setPassword(service, account, value);
  }

  async getPassword(service: string, account: string): Promise<string | null> {
    const payload = await this.readPayload();
    return payload.entries[this.entryKey(service, account)]?.value ?? null;
  }

  async get(service: string, account: string): Promise<string | null> {
    return this.getPassword(service, account);
  }

  async deletePassword(service: string, account: string): Promise<boolean> {
    return this.mutate((payload) => {
      const key = this.entryKey(service, account);
      if (!(key in payload.entries)) return { value: false, changed: false };
      delete payload.entries[key];
      return { value: true, changed: true };
    });
  }

  async delete(service: string, account: string): Promise<boolean> {
    return this.deletePassword(service, account);
  }

  async findCredentials(service: string): Promise<Array<{ account: string; password: string }>> {
    const prefix = `${service}::`;
    const payload = await this.readPayload();
    return Object.keys(payload.entries)
      .filter((key) => key.startsWith(prefix))
      .sort()
      .map((key) => ({ account: key.slice(prefix.length), password: payload.entries[key]!.value }));
  }

  // --- cross-service, values-free enumeration (for `thesun secrets`) -----

  /**
   * Every distinct service prefix with at least one stored entry. Decrypts the
   * payload once; never returns values. `findCredentials` is scoped to a single
   * service (the caller must already know its name) — this is the cross-service
   * counterpart that makes "list everything" possible.
   */
  async listServices(): Promise<string[]> {
    const payload = await this.readPayload();
    const services = new Set<string>();
    for (const key of Object.keys(payload.entries)) {
      const sep = key.indexOf('::');
      if (sep > 0) services.add(key.slice(0, sep));
    }
    return Array.from(services).sort();
  }

  /**
   * Non-secret metadata (service, account, updatedAt) for every entry, or only
   * those under one service when `service` is given. Never returns values —
   * this is `findCredentials` plus `updatedAt`, and without the single-service
   * scoping restriction.
   */
  async listEntries(service?: string): Promise<VaultEntryMeta[]> {
    const payload = await this.readPayload();
    const out: VaultEntryMeta[] = [];
    for (const [key, entry] of Object.entries(payload.entries)) {
      const sep = key.indexOf('::');
      if (sep <= 0) continue;
      const svc = key.slice(0, sep);
      if (service && svc !== service) continue;
      out.push({ service: svc, account: key.slice(sep + 2), updatedAt: entry.updatedAt });
    }
    out.sort((a, b) => (a.service === b.service ? a.account.localeCompare(b.account) : a.service.localeCompare(b.service)));
    return out;
  }
}

/** Non-secret metadata for one vault entry — the value is never included. */
export interface VaultEntryMeta {
  service: string;
  account: string;
  updatedAt: string;
}

/** Coerce arbitrary decrypted JSON into a well-formed payload, dropping junk entries. */
function normalizePayload(parsed: unknown): VaultPayload {
  if (!parsed || typeof parsed !== 'object') throw new Error('vault payload is not a JSON object');
  const obj = parsed as Record<string, unknown>;
  const revRaw = obj['rev'];
  const rev = typeof revRaw === 'number' && Number.isFinite(revRaw) ? revRaw : 0;
  const entriesRaw = obj['entries'];
  const source = entriesRaw && typeof entriesRaw === 'object' ? (entriesRaw as Record<string, unknown>) : {};
  const entries: Record<string, VaultEntry> = {};
  for (const [key, raw] of Object.entries(source)) {
    if (raw && typeof raw === 'object' && typeof (raw as { value?: unknown }).value === 'string') {
      const value = (raw as { value: string }).value;
      const updatedAtRaw = (raw as { updatedAt?: unknown }).updatedAt;
      const updatedAt = typeof updatedAtRaw === 'string' ? updatedAtRaw : new Date().toISOString();
      entries[key] = { value, updatedAt };
    }
  }
  return { v: 1, rev, entries };
}

/** fsync a directory so the rename is durable. Best-effort: unsupported FS → ignored. */
async function fsyncDir(dir: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(dir, 'r');
    await handle.sync();
  } catch {
    /* directory fsync is a durability nicety; the rename already provides atomicity */
  } finally {
    if (handle) {
      try { await handle.close(); } catch { /* already closed */ }
    }
  }
}
