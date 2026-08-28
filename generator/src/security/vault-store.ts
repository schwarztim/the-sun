/**
 * Encrypted credential store (AES-256-GCM), vendored into thesun.
 *
 * Vendored deliberately: this was previously an external dependency resolved
 * through a local filesystem path outside the repository, which made the
 * generator subsystem impossible to install from a clean checkout (`npm ci`
 * could not resolve it). The module is self-contained and has no dependencies
 * of its own, so carrying the source here removes the only thing that was
 * unavailable to anyone other than the original author.
 *
 * Keep the public surface keytar-compatible (getPassword / setPassword /
 * deletePassword / findCredentials): generated servers are emitted against it.
 */

import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface KeyringAdapter {
  setPassword(service: string, account: string, password: string): Promise<void>;
  getPassword(service: string, account: string): Promise<string | null>;
  deletePassword(service: string, account: string): Promise<boolean>;
  findCredentials(service: string): Promise<Array<{ account: string; password: string }>>;
}

export interface CredentialStore {
  get(service: string, account: string): Promise<string | null>;
  set(service: string, account: string, value: string): Promise<void>;
  delete(service: string, account: string): Promise<boolean>;
}

export interface VaultStoreOptions {
  vaultPath?: string;
  masterKeyPath?: string;
}

type JsonObject = Record<string, unknown>;

type EncryptedVaultEntry = {
  nonce: string;
  ciphertext: string;
};

type VaultFile = {
  meta?: {
    version?: string;
    algo?: string;
    key_source?: string;
  };
  entries?: Record<string, EncryptedVaultEntry>;
};

// thesun keeps its own credentials under its own home. The store previously
// defaulted into ~/.claude, an unrelated tool's directory, which meant a fresh
// install wrote credentials somewhere it did not own and failed on the first
// write for anyone without ~/.claude/master.key.
//
// The legacy directory is still honoured when it already holds a vault, so an
// existing install keeps reading the credentials it already has instead of
// silently starting empty and orphaning them. Both files are chosen as a pair:
// a vault is only readable with the key it was encrypted under, so mixing the
// new key with the old vault would fail every decrypt.
const DEFAULT_DIR = "~/.thesun";
const LEGACY_DIR = "~/.claude";
const VAULT_FILE = "secrets.vault";
const MASTER_KEY_FILE = "master.key";
// Windows is a supported target. Three POSIX-only operations below have to be
// skipped there, matching how the Hermes vault handles the same write path:
//   - chmod: no POSIX mode bits on NTFS, so 0o600 conveys nothing.
//   - fsync of the parent directory: opening a directory needs
//     FILE_FLAG_BACKUP_SEMANTICS, which Node does not set, so the open fails
//     outright rather than degrading. It is a durability optimization on top of
//     an already-atomic rename, so skipping it costs correctness nothing.
const IS_WINDOWS = process.platform === "win32";
const NONCE_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;

export class VaultStore implements KeyringAdapter, CredentialStore {
  private readonly vaultPath: string;
  private readonly masterKeyPath: string;
  // In-process async mutex serializing the read-modify-write cycle. Prevents
  // two concurrent setPassword/deletePassword calls in the same Node process
  // from racing on read-then-write (which would silently drop one writer's
  // changes — the corruption case is already prevented by unique temp paths
  // in writeVault, but lost-write is a separate hazard solved only by serial-
  // izing the full RMW cycle). Cross-process safety against the Python CLI
  // is NOT covered; see commit message + secrets.py for the Python side.
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(options: VaultStoreOptions = {}) {
    const dir = defaultStoreDir();
    this.vaultPath = resolvePath(options.vaultPath ?? join(dir, VAULT_FILE));
    this.masterKeyPath = resolvePath(options.masterKeyPath ?? join(dir, MASTER_KEY_FILE));
  }

  async setPassword(service: string, account: string, password: string): Promise<void> {
    return this.withWriteLock(async () => {
      const entries = await this.readVault();
      entries[this.toEntryKey(service, account)] = { value: password };
      await this.writeVault(entries);
    });
  }

  async getPassword(service: string, account: string): Promise<string | null> {
    const entries = await this.readVault();
    return getStoredValue(entries[this.toEntryKey(service, account)]);
  }

  async deletePassword(service: string, account: string): Promise<boolean> {
    return this.withWriteLock(async () => {
      const entries = await this.readVault();
      const entryKey = this.toEntryKey(service, account);
      if (!(entryKey in entries)) {
        return false;
      }

      delete entries[entryKey];
      await this.writeVault(entries);
      return true;
    });
  }

  private async withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.writeChain;
    let release!: () => void;
    this.writeChain = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      return await fn();
    } finally {
      release();
    }
  }

  async findCredentials(service: string): Promise<Array<{ account: string; password: string }>> {
    const prefix = `${service}::`;
    const entries = await this.readVault();

    return Object.keys(entries)
      .filter((key) => key.startsWith(prefix))
      .sort()
      .flatMap((key) => {
        const password = getStoredValue(entries[key]);
        if (password === null) {
          return [];
        }

        return [{ account: key.slice(prefix.length), password }];
      });
  }

  async get(service: string, account: string): Promise<string | null> {
    return this.getPassword(service, account);
  }

  async set(service: string, account: string, value: string): Promise<void> {
    await this.setPassword(service, account, value);
  }

  async delete(service: string, account: string): Promise<boolean> {
    return this.deletePassword(service, account);
  }

  private async readVault(): Promise<Record<string, JsonObject>> {
    let fileText: string;

    try {
      fileText = await readFile(this.vaultPath, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) {
        return {};
      }
      throw error;
    }

    if (fileText.trim() === "") {
      return {};
    }

    const rawVault = parseVaultFile(fileText);
    const version = rawVault.meta?.version ?? "2";
    if (version !== "2") {
      throw new Error(`Unsupported vault version: ${version}`);
    }

    const key = await this.readMasterKey();
    const decryptedEntries: Record<string, JsonObject> = {};

    for (const [serviceName, encryptedEntry] of Object.entries(rawVault.entries ?? {})) {
      const nonce = Buffer.from(encryptedEntry.nonce, "base64");
      if (nonce.length !== NONCE_LENGTH) {
        throw new Error(`Invalid nonce length for ${serviceName}`);
      }

      const combinedCiphertext = Buffer.from(encryptedEntry.ciphertext, "base64");
      if (combinedCiphertext.length < AUTH_TAG_LENGTH) {
        throw new Error(`Invalid ciphertext length for ${serviceName}`);
      }

      const ciphertext = combinedCiphertext.subarray(0, combinedCiphertext.length - AUTH_TAG_LENGTH);
      const authTag = combinedCiphertext.subarray(combinedCiphertext.length - AUTH_TAG_LENGTH);
      const decipher = createDecipheriv("aes-256-gcm", key, nonce);
      decipher.setAAD(Buffer.from(serviceName, "utf8"));
      decipher.setAuthTag(authTag);

      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
      const parsed = JSON.parse(plaintext) as unknown;
      if (!isPlainObject(parsed)) {
        throw new Error(`Decrypted entry for ${serviceName} must be a JSON object`);
      }

      decryptedEntries[serviceName] = parsed;
    }

    return decryptedEntries;
  }

  private async writeVault(entries: Record<string, JsonObject>): Promise<void> {
    const key = await this.readMasterKey();
    const encryptedEntries: Record<string, EncryptedVaultEntry> = {};

    for (const serviceName of Object.keys(entries).sort()) {
      const nonce = randomBytes(NONCE_LENGTH);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(Buffer.from(serviceName, "utf8"));

      const plaintext = Buffer.from(JSON.stringify(entries[serviceName]), "utf8");
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const authTag = cipher.getAuthTag();

      encryptedEntries[serviceName] = {
        nonce: nonce.toString("base64"),
        ciphertext: Buffer.concat([ciphertext, authTag]).toString("base64"),
      };
    }

    const payload = JSON.stringify(
      {
        meta: { version: "2", algo: "AES-256-GCM", key_source: "file" },
        entries: encryptedEntries,
      },
      null,
      2,
    );

    const parentDir = dirname(this.vaultPath);
    await mkdir(parentDir, { recursive: true });

    const tempPath = `${this.vaultPath}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
    // fsync(tmp) BEFORE rename: ensures payload bytes are durable on disk
    // before the rename commits. Without this, the OS can crash post-rename
    // with the new content still in page cache → vault becomes truncated.
    const tempHandle = await open(tempPath, "w", 0o600);
    try {
      await tempHandle.writeFile(payload, { encoding: "utf8" });
      if (!IS_WINDOWS) {
        await tempHandle.chmod(0o600);
      }
      await tempHandle.sync();
    } finally {
      await tempHandle.close();
    }
    await rename(tempPath, this.vaultPath);
    if (!IS_WINDOWS) {
      await chmod(this.vaultPath, 0o600);
      // fsync(parent dir) AFTER rename: ensures the rename entry itself is
      // durable. Without this, the OS can crash post-rename with the directory
      // entry still in metadata cache → vault stays at the old content.
      const dirHandle = await open(parentDir, "r");
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close();
      }
    }
  }

  private async readMasterKey(): Promise<Buffer> {
    const key = await readFile(this.masterKeyPath);
    if (key.length !== KEY_LENGTH) {
      throw new Error(`Master key must be exactly ${KEY_LENGTH} bytes, got ${key.length}`);
    }

    return key;
  }

  private toEntryKey(service: string, account: string): string {
    return `${service}::${account}`;
  }
}

/**
 * Pick the directory the default vault and master key live in.
 *
 * thesun's own home wins for anything new. The legacy directory is returned
 * only when it already holds a vault and thesun's does not, so an install that
 * predates this change keeps reading the credentials it already wrote rather
 * than silently starting from an empty store.
 */
function defaultStoreDir(): string {
  const preferred = resolvePath(DEFAULT_DIR);
  if (existsSync(join(preferred, VAULT_FILE))) {
    return preferred;
  }
  const legacy = resolvePath(LEGACY_DIR);
  if (existsSync(join(legacy, VAULT_FILE))) {
    return legacy;
  }
  return preferred;
}

function resolvePath(pathValue: string): string {
  if (pathValue === "~") {
    return homedir();
  }

  if (pathValue.startsWith("~/")) {
    return join(homedir(), pathValue.slice(2));
  }

  return pathValue;
}

function parseVaultFile(fileText: string): VaultFile {
  const parsed = JSON.parse(fileText) as unknown;
  if (!isPlainObject(parsed)) {
    throw new Error("Vault file must contain a JSON object");
  }

  if (parsed.entries !== undefined && !isPlainObject(parsed.entries)) {
    throw new Error("Vault entries must be an object");
  }

  return parsed as VaultFile;
}

function getStoredValue(entry: JsonObject | undefined): string | null {
  if (!entry) {
    return null;
  }

  const value = entry.value;
  return typeof value === "string" ? value : null;
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export default VaultStore;
