import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import { CredentialWizard } from "./credential-wizard.js";
import type { AuthType, StoredCredential } from "../types/index.js";

// Mock fs module
vi.mock("fs/promises");

describe("CredentialWizard", () => {
  let wizard: CredentialWizard;
  const mockCredentialsDir = "/tmp/test-thesun/credentials";

  beforeEach(() => {
    wizard = new CredentialWizard(mockCredentialsDir);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("detectAuthType", () => {
    it("detects Bearer token auth from Authorization header", () => {
      const headers = {
        Authorization: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
      };

      const result = wizard.detectAuthType(headers);

      expect(result).toBe("bearer");
    });

    it("detects API key auth from x-api-key header", () => {
      const headers = {
        "x-api-key": "sk-1234567890abcdef",
      };

      const result = wizard.detectAuthType(headers);

      expect(result).toBe("api-key");
    });

    it("detects API key auth from Authorization: ApiKey header", () => {
      const headers = {
        Authorization: "ApiKey sk-1234567890abcdef",
      };

      const result = wizard.detectAuthType(headers);

      expect(result).toBe("api-key");
    });

    it("detects session cookie auth from Cookie header", () => {
      const headers = {
        Cookie: "session_id=abc123; other=value",
      };

      const result = wizard.detectAuthType(headers);

      expect(result).toBe("session-cookie");
    });

    it("detects Basic auth from Authorization header", () => {
      const headers = {
        Authorization: "Basic dXNlcm5hbWU6cGFzc3dvcmQ=",
      };

      const result = wizard.detectAuthType(headers);

      expect(result).toBe("basic");
    });

    it("returns none when no auth headers present", () => {
      const headers = {
        "Content-Type": "application/json",
        Accept: "application/json",
      };

      const result = wizard.detectAuthType(headers);

      expect(result).toBe("none");
    });

    it("handles case-insensitive header names", () => {
      const headers = {
        authorization: "Bearer token123",
      };

      const result = wizard.detectAuthType(headers);

      expect(result).toBe("bearer");
    });
  });

  describe("detectAuthFromHar", () => {
    it("detects OAuth2 from HAR with token endpoint", () => {
      const har = {
        log: {
          entries: [
            {
              request: {
                url: "https://api.example.com/oauth/token",
                method: "POST",
                postData: {
                  text: "grant_type=authorization_code&code=abc123",
                },
              },
              response: {
                content: {
                  text: JSON.stringify({
                    access_token: "token123",
                    refresh_token: "refresh456",
                    token_type: "Bearer",
                  }),
                },
              },
            },
          ],
        },
      };

      const result = wizard.detectAuthFromHar(har);

      expect(result).toBe("oauth2");
    });

    it("detects OAuth2 PKCE from HAR with code_verifier", () => {
      const har = {
        log: {
          entries: [
            {
              request: {
                url: "https://api.example.com/oauth/token",
                method: "POST",
                postData: {
                  text: "grant_type=authorization_code&code=abc123&code_verifier=xyz",
                },
              },
              response: {
                content: {
                  text: JSON.stringify({
                    access_token: "token123",
                    token_type: "Bearer",
                  }),
                },
              },
            },
          ],
        },
      };

      const result = wizard.detectAuthFromHar(har);

      expect(result).toBe("oauth2-pkce");
    });

    it("detects Bearer auth from HAR request headers", () => {
      const har = {
        log: {
          entries: [
            {
              request: {
                url: "https://api.example.com/data",
                method: "GET",
                headers: [{ name: "Authorization", value: "Bearer token123" }],
              },
            },
          ],
        },
      };

      const result = wizard.detectAuthFromHar(har);

      expect(result).toBe("bearer");
    });

    it("detects API key from HAR headers", () => {
      const har = {
        log: {
          entries: [
            {
              request: {
                url: "https://api.example.com/data",
                method: "GET",
                headers: [{ name: "X-Api-Key", value: "key123" }],
              },
            },
          ],
        },
      };

      const result = wizard.detectAuthFromHar(har);

      expect(result).toBe("api-key");
    });

    it("returns none for HAR without auth patterns", () => {
      const har = {
        log: {
          entries: [
            {
              request: {
                url: "https://api.example.com/public",
                method: "GET",
                headers: [{ name: "Content-Type", value: "application/json" }],
              },
            },
          ],
        },
      };

      const result = wizard.detectAuthFromHar(har);

      expect(result).toBe("none");
    });
  });

  describe("storeCredentials", () => {
    it("stores credentials to .env file", async () => {
      const mockMkdir = vi.mocked(fs.mkdir);
      const mockWriteFile = vi.mocked(fs.writeFile);
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);

      const creds: StoredCredential = {
        target: "myapi",
        authType: "bearer",
        accessToken: "token123",
        refreshToken: "refresh456",
        expiresAt: Date.now() + 3600000,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await wizard.storeCredentials("myapi", creds);

      expect(mockMkdir).toHaveBeenCalledWith(mockCredentialsDir, {
        recursive: true,
      });
      expect(mockWriteFile).toHaveBeenCalledTimes(2); // .env and .meta.json
    });

    it("stores metadata to .meta.json file", async () => {
      const mockMkdir = vi.mocked(fs.mkdir);
      const mockWriteFile = vi.mocked(fs.writeFile);
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);

      const creds: StoredCredential = {
        target: "myapi",
        authType: "bearer",
        accessToken: "token123",
        scopes: ["read", "write"],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await wizard.storeCredentials("myapi", creds);

      const metaCall = mockWriteFile.mock.calls.find((call) =>
        String(call[0]).endsWith(".meta.json"),
      );

      expect(metaCall).toBeDefined();
      const metaContent = JSON.parse(String(metaCall![1]));
      expect(metaContent.target).toBe("myapi");
      expect(metaContent.authType).toBe("bearer");
      expect(metaContent.scopes).toEqual(["read", "write"]);
    });

    it("formats env file with uppercase variable names", async () => {
      const mockMkdir = vi.mocked(fs.mkdir);
      const mockWriteFile = vi.mocked(fs.writeFile);
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);

      const creds: StoredCredential = {
        target: "my-api",
        authType: "bearer",
        accessToken: "token123",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await wizard.storeCredentials("my-api", creds);

      const envCall = mockWriteFile.mock.calls.find((call) =>
        String(call[0]).endsWith(".env"),
      );

      expect(envCall).toBeDefined();
      const envContent = String(envCall![1]);
      expect(envContent).toContain("MY_API_ACCESS_TOKEN=token123");
      expect(envContent).toContain("MY_API_AUTH_TYPE=bearer");
    });
  });

  describe("loadCredentials", () => {
    it("loads credentials from .env and .meta.json files", async () => {
      const mockReadFile = vi.mocked(fs.readFile);

      const envContent = `MY_API_ACCESS_TOKEN=token123
MY_API_REFRESH_TOKEN=refresh456
MY_API_AUTH_TYPE=bearer
MY_API_EXPIRES_AT=1700000000000`;

      const metaContent = JSON.stringify({
        target: "my-api",
        authType: "bearer",
        expiresAt: 1700000000000,
        scopes: ["read"],
        refreshCount: 2,
      });

      mockReadFile.mockImplementation(async (filePath) => {
        if (String(filePath).endsWith(".env")) {
          return envContent;
        }
        if (String(filePath).endsWith(".meta.json")) {
          return metaContent;
        }
        throw new Error("File not found");
      });

      const result = await wizard.loadCredentials("my-api");

      expect(result).not.toBeNull();
      expect(result!.target).toBe("my-api");
      expect(result!.authType).toBe("bearer");
      expect(result!.accessToken).toBe("token123");
      expect(result!.refreshToken).toBe("refresh456");
    });

    it("returns null when credentials do not exist", async () => {
      const mockReadFile = vi.mocked(fs.readFile);
      mockReadFile.mockRejectedValue(new Error("ENOENT"));

      const result = await wizard.loadCredentials("nonexistent");

      expect(result).toBeNull();
    });
  });

  describe("deleteCredentials", () => {
    it("removes both .env and .meta.json files", async () => {
      const mockUnlink = vi.mocked(fs.unlink);
      mockUnlink.mockResolvedValue(undefined);

      await wizard.deleteCredentials("myapi");

      expect(mockUnlink).toHaveBeenCalledTimes(2);
      expect(mockUnlink).toHaveBeenCalledWith(
        path.join(mockCredentialsDir, "myapi.env"),
      );
      expect(mockUnlink).toHaveBeenCalledWith(
        path.join(mockCredentialsDir, "myapi.meta.json"),
      );
    });

    it("does not throw if files do not exist", async () => {
      const mockUnlink = vi.mocked(fs.unlink);
      mockUnlink.mockRejectedValue(new Error("ENOENT"));

      await expect(
        wizard.deleteCredentials("nonexistent"),
      ).resolves.not.toThrow();
    });
  });

  describe("isExpired", () => {
    it("returns true when expiresAt is in the past", () => {
      const creds: StoredCredential = {
        target: "myapi",
        authType: "bearer",
        accessToken: "token123",
        expiresAt: Date.now() - 1000, // 1 second ago
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      expect(wizard.isExpired(creds)).toBe(true);
    });

    it("returns false when expiresAt is in the future", () => {
      const creds: StoredCredential = {
        target: "myapi",
        authType: "bearer",
        accessToken: "token123",
        expiresAt: Date.now() + 3600000, // 1 hour from now
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      expect(wizard.isExpired(creds)).toBe(false);
    });

    it("returns false when expiresAt is not set", () => {
      const creds: StoredCredential = {
        target: "myapi",
        authType: "api-key",
        apiKey: "key123",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      expect(wizard.isExpired(creds)).toBe(false);
    });
  });

  describe("needsRefresh", () => {
    it("returns true when within 5-minute refresh buffer", () => {
      const creds: StoredCredential = {
        target: "myapi",
        authType: "bearer",
        accessToken: "token123",
        refreshToken: "refresh456",
        expiresAt: Date.now() + 4 * 60 * 1000, // 4 minutes from now
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      expect(wizard.needsRefresh(creds)).toBe(true);
    });

    it("returns false when more than 5 minutes until expiry", () => {
      const creds: StoredCredential = {
        target: "myapi",
        authType: "bearer",
        accessToken: "token123",
        refreshToken: "refresh456",
        expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes from now
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      expect(wizard.needsRefresh(creds)).toBe(false);
    });

    it("returns true when already expired", () => {
      const creds: StoredCredential = {
        target: "myapi",
        authType: "bearer",
        accessToken: "token123",
        refreshToken: "refresh456",
        expiresAt: Date.now() - 1000, // Already expired
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      expect(wizard.needsRefresh(creds)).toBe(true);
    });

    it("returns false when no expiresAt set", () => {
      const creds: StoredCredential = {
        target: "myapi",
        authType: "api-key",
        apiKey: "key123",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      expect(wizard.needsRefresh(creds)).toBe(false);
    });

    it("returns false when no refresh token available", () => {
      const creds: StoredCredential = {
        target: "myapi",
        authType: "bearer",
        accessToken: "token123",
        expiresAt: Date.now() + 2 * 60 * 1000, // 2 minutes from now
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // No refresh token, so even though within buffer, cannot refresh
      expect(wizard.needsRefresh(creds)).toBe(false);
    });
  });

  describe("getEnvVarPrefix", () => {
    it("converts target name to uppercase with underscores", () => {
      expect(wizard.getEnvVarPrefix("my-api")).toBe("MY_API");
      expect(wizard.getEnvVarPrefix("myApi")).toBe("MYAPI");
      expect(wizard.getEnvVarPrefix("my_api_v2")).toBe("MY_API_V2");
    });
  });

  describe("extractTokenFromResponse", () => {
    it("extracts OAuth2 tokens from response", () => {
      const response = {
        access_token: "token123",
        refresh_token: "refresh456",
        expires_in: 3600,
        token_type: "Bearer",
        scope: "read write",
      };

      const result = wizard.extractTokenFromResponse(response);

      expect(result.accessToken).toBe("token123");
      expect(result.refreshToken).toBe("refresh456");
      expect(result.expiresIn).toBe(3600);
      expect(result.scopes).toEqual(["read", "write"]);
    });

    it("handles response with only access_token", () => {
      const response = {
        access_token: "token123",
      };

      const result = wizard.extractTokenFromResponse(response);

      expect(result.accessToken).toBe("token123");
      expect(result.refreshToken).toBeUndefined();
    });
  });
});
