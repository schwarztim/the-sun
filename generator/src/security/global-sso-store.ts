/**
 * Global SSO Credential Store
 *
 * Centralized storage for SSO credentials that can be shared across
 * multiple MCPs. When a user authenticates to an organization's SSO once,
 * all related MCPs can reuse those credentials.
 *
 * Storage:
 * - Metadata: ~/.thesun/sso/credentials.json
 * - Passwords: VaultStore secure storage
 *
 * Features:
 * - Realm-based credential lookup (e.g., example.com, example.net)
 * - VaultStore integration for secure password storage
 * - MFA script paths for automated TOTP
 * - Last-used tracking for credential freshness
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { VaultStore } from "./vault-store.js";
import {
  GlobalSsoCredential,
  GlobalSsoStore as GlobalSsoStoreType,
  SsoIdpType,
} from "../types/index.js";
import { logger } from "../observability/logger.js";

const SSO_DIR = join(homedir(), ".thesun", "sso");
const CREDENTIALS_FILE = join(SSO_DIR, "credentials.json");
const KEYCHAIN_SERVICE = "thesun-sso";
const store = new VaultStore();

/**
 * Global SSO Credential Store
 */
export class GlobalSsoStore {
  private store: GlobalSsoStoreType;

  constructor() {
    this.store = this.load();
  }

  /**
   * Load credentials from disk
   */
  private load(): GlobalSsoStoreType {
    try {
      if (existsSync(CREDENTIALS_FILE)) {
        const data = readFileSync(CREDENTIALS_FILE, "utf-8");
        const parsed = JSON.parse(data);
        return {
          version: parsed.version || 1,
          credentials: (parsed.credentials || []).map((c: any) => ({
            ...c,
            createdAt: new Date(c.createdAt),
            lastUsed: new Date(c.lastUsed),
          })),
          updatedAt: new Date(parsed.updatedAt),
        };
      }
    } catch (error) {
      logger.warn("Failed to load global SSO store", { error });
    }

    return {
      version: 1,
      credentials: [],
      updatedAt: new Date(),
    };
  }

  /**
   * Persist store to disk
   */
  private persist(): void {
    try {
      if (!existsSync(SSO_DIR)) {
        mkdirSync(SSO_DIR, { recursive: true });
      }

      this.store.updatedAt = new Date();
      writeFileSync(CREDENTIALS_FILE, JSON.stringify(this.store, null, 2));
      logger.debug("Global SSO store saved");
    } catch (error) {
      logger.error("Failed to save global SSO store", { error });
      throw error;
    }
  }

  /**
   * Get credential for a specific realm
   */
  async getForRealm(realm: string): Promise<GlobalSsoCredential | null> {
    const normalizedRealm = realm.toLowerCase();
    const cred = this.store.credentials.find(
      (c) => c.realm.toLowerCase() === normalizedRealm,
    );

    if (!cred) {
      return null;
    }

    // Update last used timestamp
    cred.lastUsed = new Date();
    this.persist();

    return cred;
  }

  /**
   * Get credential by email address
   */
  async getByEmail(email: string): Promise<GlobalSsoCredential | null> {
    const normalizedEmail = email.toLowerCase();
    const cred = this.store.credentials.find(
      (c) => c.email.toLowerCase() === normalizedEmail,
    );

    if (!cred) {
      return null;
    }

    cred.lastUsed = new Date();
    this.persist();

    return cred;
  }

  /**
   * Extract realm from email address
   */
  static extractRealm(email: string): string | null {
    const atIndex = email.indexOf("@");
    if (atIndex === -1) return null;
    return email.substring(atIndex + 1).toLowerCase();
  }

  /**
   * Extract realm from URL (for Azure AD tenant detection)
   */
  static extractRealmFromUrl(url: string): string | null {
    try {
      const parsed = new URL(url);
      // Common patterns:
      // - https://acme.service-now.com → acme.com (heuristic)
      // - https://login.microsoftonline.com/acme.com/... → acme.com
      // - https://acme.okta.com → acme.com

      // Azure AD tenant in path
      const azureTenantMatch = parsed.pathname.match(
        /\/([a-zA-Z0-9-]+\.[a-zA-Z]{2,})\//,
      );
      if (azureTenantMatch) {
        return azureTenantMatch[1].toLowerCase();
      }

      // Okta subdomain
      if (parsed.hostname.includes(".okta.com")) {
        const oktaMatch = parsed.hostname.match(/([^.]+)\.okta\.com/);
        if (oktaMatch) {
          return `${oktaMatch[1]}.com`.toLowerCase();
        }
      }

      // Generic: extract from hostname
      const parts = parsed.hostname.split(".");
      if (parts.length >= 2) {
        return parts.slice(-2).join(".").toLowerCase();
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Get password from secure store
   */
  async getPassword(credential: GlobalSsoCredential): Promise<string | null> {
    try {
      return await store.getPassword(
        KEYCHAIN_SERVICE,
        credential.passwordKeychainKey,
      );
    } catch (error) {
      logger.error("Failed to get password from secure store", { error });
      return null;
    }
  }

  /**
   * Save a new SSO credential
   */
  async save(
    email: string,
    password: string,
    idpType: SsoIdpType,
    options: {
      mfaScript?: string;
      tenantId?: string;
    } = {},
  ): Promise<GlobalSsoCredential> {
    const realm = GlobalSsoStore.extractRealm(email);
    if (!realm) {
      throw new Error(`Cannot extract realm from email: ${email}`);
    }

    // Check if credential already exists
    const existing = await this.getForRealm(realm);
    if (existing) {
      // Update existing
      return this.update(existing, { email, password, ...options });
    }

    // Create new credential
    const keychainKey = `${realm}-${email}`;
    const credential: GlobalSsoCredential = {
      realm,
      email,
      passwordKeychainKey: keychainKey,
      idpType,
      mfaScript: options.mfaScript,
      tenantId: options.tenantId,
      createdAt: new Date(),
      lastUsed: new Date(),
    };

    // Store password in secure store
    try {
      await store.setPassword(KEYCHAIN_SERVICE, keychainKey, password);
    } catch (error) {
      logger.error("Failed to store password in secure store", { error });
      throw new Error("Failed to store password securely.");
    }

    // Add to store
    this.store.credentials.push(credential);
    this.persist();

    logger.info("Global SSO credential saved", {
      realm,
      email,
      idpType,
    });

    return credential;
  }

  /**
   * Update an existing credential
   */
  async update(
    existing: GlobalSsoCredential,
    updates: {
      email?: string;
      password?: string;
      mfaScript?: string;
      tenantId?: string;
    },
  ): Promise<GlobalSsoCredential> {
    // Update fields
    if (updates.email) {
      existing.email = updates.email;
    }
    if (updates.mfaScript !== undefined) {
      existing.mfaScript = updates.mfaScript;
    }
    if (updates.tenantId !== undefined) {
      existing.tenantId = updates.tenantId;
    }

    // Update password if provided
    if (updates.password) {
      try {
        await store.setPassword(
          KEYCHAIN_SERVICE,
          existing.passwordKeychainKey,
          updates.password,
        );
      } catch (error) {
        logger.error("Failed to update password in secure store", { error });
        throw error;
      }
    }

    existing.lastUsed = new Date();
    this.persist();

    logger.info("Global SSO credential updated", {
      realm: existing.realm,
      email: existing.email,
    });

    return existing;
  }

  /**
   * Delete a credential
   */
  async delete(realm: string): Promise<boolean> {
    const normalizedRealm = realm.toLowerCase();
    const index = this.store.credentials.findIndex(
      (c) => c.realm.toLowerCase() === normalizedRealm,
    );

    if (index === -1) {
      return false;
    }

    const credential = this.store.credentials[index];

    // Remove from secure store
    try {
      await store.deletePassword(
        KEYCHAIN_SERVICE,
        credential.passwordKeychainKey,
      );
    } catch (error) {
      logger.warn("Failed to delete password from secure store", { error });
    }

    // Remove from store
    this.store.credentials.splice(index, 1);
    this.persist();

    logger.info("Global SSO credential deleted", { realm });

    return true;
  }

  /**
   * List all stored credentials (without passwords)
   */
  list(): GlobalSsoCredential[] {
    return [...this.store.credentials];
  }

  /**
   * Check if credentials exist for a realm
   */
  hasCredentialsForRealm(realm: string): boolean {
    const normalizedRealm = realm.toLowerCase();
    return this.store.credentials.some(
      (c) => c.realm.toLowerCase() === normalizedRealm,
    );
  }

  /**
   * Get the storage directory path
   */
  static getStorageDir(): string {
    return SSO_DIR;
  }

  /**
   * Get the credentials file path
   */
  static getCredentialsPath(): string {
    return CREDENTIALS_FILE;
  }
}

// Singleton instance
let globalSsoStore: GlobalSsoStore | null = null;

export function getGlobalSsoStore(): GlobalSsoStore {
  if (!globalSsoStore) {
    globalSsoStore = new GlobalSsoStore();
  }
  return globalSsoStore;
}

/**
 * Check if global SSO credentials exist for a given URL/email
 */
export async function hasGlobalSsoCredentials(
  urlOrEmail: string,
): Promise<boolean> {
  const globalStore = getGlobalSsoStore();

  // Try as email first
  if (urlOrEmail.includes("@")) {
    const realm = GlobalSsoStore.extractRealm(urlOrEmail);
    if (realm) {
      return globalStore.hasCredentialsForRealm(realm);
    }
  }

  // Try as URL
  const realm = GlobalSsoStore.extractRealmFromUrl(urlOrEmail);
  if (realm) {
    return globalStore.hasCredentialsForRealm(realm);
  }

  return false;
}

/**
 * Get global SSO credentials for a given URL/email
 */
export async function getGlobalSsoCredentials(
  urlOrEmail: string,
): Promise<{ credential: GlobalSsoCredential; password: string } | null> {
  const globalStore = getGlobalSsoStore();

  let credential: GlobalSsoCredential | null = null;

  // Try as email first
  if (urlOrEmail.includes("@")) {
    credential = await globalStore.getByEmail(urlOrEmail);
    if (!credential) {
      const realm = GlobalSsoStore.extractRealm(urlOrEmail);
      if (realm) {
        credential = await globalStore.getForRealm(realm);
      }
    }
  } else {
    // Try as URL
    const realm = GlobalSsoStore.extractRealmFromUrl(urlOrEmail);
    if (realm) {
      credential = await globalStore.getForRealm(realm);
    }
  }

  if (!credential) {
    return null;
  }

  const password = await globalStore.getPassword(credential);
  if (!password) {
    logger.warn("Found credential but password not in secure store", {
      realm: credential.realm,
    });
    return null;
  }

  return { credential, password };
}
