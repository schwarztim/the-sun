/**
 * Credential Wizard for browser-based auth capture with auto-refresh
 *
 * Responsibilities:
 * - Detect auth type from headers or HAR captures
 * - Store credentials securely in ~/.thesun/credentials/
 * - Manage token refresh lifecycle
 * - Trigger browser auth when refresh fails
 */

import * as fs from "fs/promises";
import * as path from "path";
import type {
  AuthType,
  StoredCredential,
  CredentialMeta,
} from "../types/index.js";

/** Default credentials directory */
const DEFAULT_CREDENTIALS_DIR = path.join(
  process.env.HOME || "~",
  ".thesun",
  "credentials",
);

/** Refresh buffer - refresh tokens 5 minutes before expiry */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

/** HAR entry type for type safety */
interface HarEntry {
  request: {
    url: string;
    method: string;
    headers?: Array<{ name: string; value: string }>;
    postData?: { text?: string };
  };
  response?: {
    content?: { text?: string };
  };
}

/** HAR log structure */
interface HarLog {
  log: {
    entries: HarEntry[];
  };
}

/** Token extraction result */
export interface TokenExtractionResult {
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
  scopes?: string[];
  tokenType?: string;
}

/**
 * CredentialWizard handles authentication detection, storage, and refresh
 */
export class CredentialWizard {
  private credentialsDir: string;

  constructor(credentialsDir: string = DEFAULT_CREDENTIALS_DIR) {
    this.credentialsDir = credentialsDir;
  }

  /**
   * Detect auth type from HTTP headers
   */
  detectAuthType(headers: Record<string, string>): AuthType {
    // Normalize header names to lowercase for case-insensitive matching
    const normalizedHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      normalizedHeaders[key.toLowerCase()] = value;
    }

    // Check Authorization header
    const authHeader = normalizedHeaders["authorization"];
    if (authHeader) {
      if (authHeader.startsWith("Bearer ")) {
        return "bearer";
      }
      if (authHeader.startsWith("Basic ")) {
        return "basic";
      }
      if (
        authHeader.startsWith("ApiKey ") ||
        authHeader.startsWith("Api-Key ")
      ) {
        return "api-key";
      }
    }

    // Check API key headers
    if (
      normalizedHeaders["x-api-key"] ||
      normalizedHeaders["api-key"] ||
      normalizedHeaders["apikey"]
    ) {
      return "api-key";
    }

    // Check for session cookies
    const cookieHeader = normalizedHeaders["cookie"];
    if (cookieHeader) {
      // Look for common session cookie patterns
      if (
        cookieHeader.includes("session") ||
        cookieHeader.includes("sid") ||
        cookieHeader.includes("auth")
      ) {
        return "session-cookie";
      }
    }

    return "none";
  }

  /**
   * Detect auth type from HAR (HTTP Archive) capture
   */
  detectAuthFromHar(har: HarLog): AuthType {
    const entries = har.log?.entries || [];

    for (const entry of entries) {
      const { request, response } = entry;

      // Check for OAuth2 token endpoint
      if (
        request.url.includes("/oauth/token") ||
        request.url.includes("/token") ||
        request.url.includes("/oauth2/token")
      ) {
        const postData = request.postData?.text || "";

        // Check for PKCE (code_verifier parameter)
        if (postData.includes("code_verifier")) {
          return "oauth2-pkce";
        }

        // Check for OAuth2 grant types
        if (
          postData.includes("grant_type=authorization_code") ||
          postData.includes("grant_type=client_credentials") ||
          postData.includes("grant_type=refresh_token")
        ) {
          return "oauth2";
        }

        // Check response for OAuth2 tokens
        if (response?.content?.text) {
          try {
            const responseBody = JSON.parse(response.content.text);
            if (responseBody.access_token && responseBody.token_type) {
              return "oauth2";
            }
          } catch {
            // Ignore JSON parse errors
          }
        }
      }

      // Check request headers
      const headers = request.headers || [];
      const headerMap: Record<string, string> = {};
      for (const header of headers) {
        headerMap[header.name.toLowerCase()] = header.value;
      }

      const detectedType = this.detectAuthType(headerMap);
      if (detectedType !== "none") {
        return detectedType;
      }
    }

    return "none";
  }

  /**
   * Store credentials to filesystem
   */
  async storeCredentials(
    target: string,
    creds: StoredCredential,
  ): Promise<void> {
    // Ensure credentials directory exists
    await fs.mkdir(this.credentialsDir, { recursive: true });

    const envPath = path.join(this.credentialsDir, `${target}.env`);
    const metaPath = path.join(this.credentialsDir, `${target}.meta.json`);

    // Build .env content
    const prefix = this.getEnvVarPrefix(target);
    const envLines: string[] = [];

    if (creds.accessToken) {
      envLines.push(`${prefix}_ACCESS_TOKEN=${creds.accessToken}`);
    }
    if (creds.refreshToken) {
      envLines.push(`${prefix}_REFRESH_TOKEN=${creds.refreshToken}`);
    }
    if (creds.apiKey) {
      envLines.push(`${prefix}_API_KEY=${creds.apiKey}`);
    }
    if (creds.sessionCookie) {
      envLines.push(`${prefix}_SESSION_COOKIE=${creds.sessionCookie}`);
    }
    if (creds.expiresAt !== undefined) {
      envLines.push(`${prefix}_EXPIRES_AT=${creds.expiresAt}`);
    }
    if (creds.baseUrl) {
      envLines.push(`${prefix}_BASE_URL=${creds.baseUrl}`);
    }
    envLines.push(`${prefix}_AUTH_TYPE=${creds.authType}`);

    // Build metadata
    const meta: CredentialMeta = {
      target: creds.target,
      authType: creds.authType,
      expiresAt: creds.expiresAt,
      scopes: creds.scopes,
      lastRefresh: new Date(),
      refreshCount: 0,
    };

    // Write files
    await fs.writeFile(envPath, envLines.join("\n") + "\n", "utf-8");
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), "utf-8");
  }

  /**
   * Load credentials from filesystem
   */
  async loadCredentials(target: string): Promise<StoredCredential | null> {
    const envPath = path.join(this.credentialsDir, `${target}.env`);
    const metaPath = path.join(this.credentialsDir, `${target}.meta.json`);

    try {
      const [envContent, metaContent] = await Promise.all([
        fs.readFile(envPath, "utf-8"),
        fs.readFile(metaPath, "utf-8"),
      ]);

      // Parse .env file
      const env: Record<string, string> = {};
      for (const line of envContent.split("\n")) {
        const trimmedLine = line.trim();
        if (trimmedLine && !trimmedLine.startsWith("#")) {
          const eqIndex = trimmedLine.indexOf("=");
          if (eqIndex > 0) {
            const key = trimmedLine.substring(0, eqIndex);
            const value = trimmedLine.substring(eqIndex + 1);
            env[key] = value;
          }
        }
      }

      // Parse metadata
      const meta: CredentialMeta = JSON.parse(metaContent);

      // Build StoredCredential
      const prefix = this.getEnvVarPrefix(target);
      const creds: StoredCredential = {
        target: meta.target,
        authType: meta.authType,
        accessToken: env[`${prefix}_ACCESS_TOKEN`],
        refreshToken: env[`${prefix}_REFRESH_TOKEN`],
        apiKey: env[`${prefix}_API_KEY`],
        sessionCookie: env[`${prefix}_SESSION_COOKIE`],
        expiresAt: env[`${prefix}_EXPIRES_AT`]
          ? parseInt(env[`${prefix}_EXPIRES_AT`], 10)
          : meta.expiresAt,
        scopes: meta.scopes,
        baseUrl: env[`${prefix}_BASE_URL`],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      return creds;
    } catch {
      // File not found or parse error
      return null;
    }
  }

  /**
   * Delete credentials from filesystem
   */
  async deleteCredentials(target: string): Promise<void> {
    const envPath = path.join(this.credentialsDir, `${target}.env`);
    const metaPath = path.join(this.credentialsDir, `${target}.meta.json`);

    try {
      await Promise.all([fs.unlink(envPath), fs.unlink(metaPath)]);
    } catch {
      // Ignore errors (files may not exist)
    }
  }

  /**
   * Check if credentials are expired
   */
  isExpired(creds: StoredCredential): boolean {
    if (creds.expiresAt === undefined) {
      return false;
    }
    return Date.now() > creds.expiresAt;
  }

  /**
   * Check if credentials need refresh (within 5-minute buffer)
   */
  needsRefresh(creds: StoredCredential): boolean {
    // Cannot refresh without a refresh token
    if (!creds.refreshToken) {
      return false;
    }

    // If no expiry set, no refresh needed
    if (creds.expiresAt === undefined) {
      return false;
    }

    // Check if within refresh buffer or already expired
    const timeUntilExpiry = creds.expiresAt - Date.now();
    return timeUntilExpiry < REFRESH_BUFFER_MS;
  }

  /**
   * Convert target name to environment variable prefix
   */
  getEnvVarPrefix(target: string): string {
    return target.toUpperCase().replace(/-/g, "_");
  }

  /**
   * Extract token information from OAuth2 response
   */
  extractTokenFromResponse(
    response: Record<string, unknown>,
  ): TokenExtractionResult {
    const result: TokenExtractionResult = {};

    if (typeof response.access_token === "string") {
      result.accessToken = response.access_token;
    }

    if (typeof response.refresh_token === "string") {
      result.refreshToken = response.refresh_token;
    }

    if (typeof response.expires_in === "number") {
      result.expiresIn = response.expires_in;
    }

    if (typeof response.token_type === "string") {
      result.tokenType = response.token_type;
    }

    if (typeof response.scope === "string") {
      result.scopes = response.scope.split(" ").filter(Boolean);
    }

    return result;
  }

  /**
   * Refresh an OAuth2 token
   * @throws Error if refresh fails
   */
  async refreshToken(
    target: string,
    refreshToken: string,
    tokenEndpoint: string,
    clientId?: string,
    clientSecret?: string,
  ): Promise<StoredCredential> {
    // Build refresh request
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });

    if (clientId) {
      body.set("client_id", clientId);
    }
    if (clientSecret) {
      body.set("client_secret", clientSecret);
    }

    const response = await fetch(tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    if (!response.ok) {
      throw new Error(
        `Token refresh failed: ${response.status} ${response.statusText}`,
      );
    }

    const tokenResponse = (await response.json()) as Record<string, unknown>;
    const extracted = this.extractTokenFromResponse(tokenResponse);

    if (!extracted.accessToken) {
      throw new Error("Token refresh response missing access_token");
    }

    const now = Date.now();
    const creds: StoredCredential = {
      target,
      authType: "oauth2",
      accessToken: extracted.accessToken,
      refreshToken: extracted.refreshToken || refreshToken, // Keep old refresh token if not provided
      expiresAt: extracted.expiresIn
        ? now + extracted.expiresIn * 1000
        : undefined,
      scopes: extracted.scopes,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Store updated credentials
    await this.storeCredentials(target, creds);

    return creds;
  }

  /**
   * Trigger browser-based authentication
   * This signals to the parent system that browser auth is needed
   */
  async triggerBrowserAuth(
    target: string,
    loginUrl: string,
  ): Promise<{ needsBrowserAuth: true; target: string; loginUrl: string }> {
    // This method returns a signal that browser auth is required
    // The actual browser automation is handled by the BrowserCapture module
    return {
      needsBrowserAuth: true,
      target,
      loginUrl,
    };
  }

  /**
   * Get credentials, refreshing if necessary
   */
  async getValidCredentials(
    target: string,
    tokenEndpoint?: string,
    clientId?: string,
    clientSecret?: string,
  ): Promise<StoredCredential | null> {
    const creds = await this.loadCredentials(target);

    if (!creds) {
      return null;
    }

    // Check if refresh needed
    if (this.needsRefresh(creds) && creds.refreshToken && tokenEndpoint) {
      try {
        return await this.refreshToken(
          target,
          creds.refreshToken,
          tokenEndpoint,
          clientId,
          clientSecret,
        );
      } catch {
        // Refresh failed, return existing credentials
        // Caller may need to trigger browser auth
        return creds;
      }
    }

    return creds;
  }
}
