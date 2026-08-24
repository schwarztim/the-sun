import { describe, it, expect, beforeAll } from "vitest";
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet } from "jose";
import type { JWTVerifyGetKey } from "jose";
import { createLogger } from "../../src/logger.js";
import {
  createEntraAuthMiddleware,
  verifyBearerToken,
  entraIssuer,
  entraJwksUri,
  type AuthedRequest,
} from "../../src/auth.js";
import type { AuthConfig } from "../../src/config.js";

const silentLogger = createLogger("silent");

const TENANT = "11111111-2222-3333-4444-555555555555";
const AUDIENCE = "api://mcp-gateway-test";
const ISSUER = `https://login.microsoftonline.com/${TENANT}/v2.0`;

const cfg: AuthConfig = {
  mode: "entra",
  tenant_id: TENANT,
  audience: AUDIENCE,
};

// Local signing key + JWKS injected through the middleware's test seam — no
// network, same verification path as the remote Entra JWKS in production.
let privateKey: CryptoKey;
let getKey: JWTVerifyGetKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  jwk.kid = "test-key";
  jwk.alg = "RS256";
  getKey = createLocalJWKSet({ keys: [jwk] });
});

interface TokenClaims {
  oid?: string;
  sub?: string;
  upn?: string;
  preferred_username?: string;
  name?: string;
  groups?: string[];
}

async function mintToken(
  claims: TokenClaims,
  opts?: { issuer?: string; audience?: string; expiresIn?: string }
): Promise<string> {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(opts?.issuer ?? ISSUER)
    .setAudience(opts?.audience ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(opts?.expiresIn ?? "5m")
    .sign(privateKey);
}

// ─── Minimal express req/res doubles ──────────────────────────────────────────

function fakeReq(authorization?: string): AuthedRequest {
  return {
    header: (name: string) =>
      name.toLowerCase() === "authorization" ? authorization : undefined,
    method: "POST",
    path: "/mcp",
    ip: "127.0.0.1",
  } as unknown as AuthedRequest;
}

interface FakeRes {
  statusCode?: number;
  headers: Record<string, string>;
  body?: unknown;
  headersSent: boolean;
}

function fakeRes(): FakeRes & { asExpress: () => any } {
  const res: FakeRes = { headers: {}, headersSent: false };
  const expressish: any = {
    status(code: number) {
      res.statusCode = code;
      return expressish;
    },
    set(name: string, value: string) {
      res.headers[name] = value;
      return expressish;
    },
    json(payload: unknown) {
      res.body = payload;
      res.headersSent = true;
      return expressish;
    },
    get headersSent() {
      return res.headersSent;
    },
  };
  return Object.assign(res, { asExpress: () => expressish });
}

/** Run the middleware and resolve once it either calls next() or writes a response. */
async function runMiddleware(
  mw: ReturnType<typeof createEntraAuthMiddleware>,
  req: AuthedRequest,
  res: ReturnType<typeof fakeRes>
): Promise<{ nextCalled: boolean }> {
  let nextCalled = false;
  mw(req as any, res.asExpress(), () => {
    nextCalled = true;
  });
  // The middleware resolves asynchronously (token verification); poll briefly.
  for (let i = 0; i < 100 && !nextCalled && !res.headersSent; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  return { nextCalled };
}

// ─── Endpoint derivation ──────────────────────────────────────────────────────

describe("entra endpoint derivation", () => {
  it("derives issuer and JWKS URI from tenant_id", () => {
    expect(entraIssuer(cfg)).toBe(ISSUER);
    expect(entraJwksUri(cfg)).toBe(
      `https://login.microsoftonline.com/${TENANT}/discovery/v2.0/keys`
    );
  });

  it("explicit overrides win", () => {
    const custom: AuthConfig = {
      ...cfg,
      issuer: "https://example.test/issuer",
      jwks_uri: "https://example.test/jwks",
    };
    expect(entraIssuer(custom)).toBe("https://example.test/issuer");
    expect(entraJwksUri(custom)).toBe("https://example.test/jwks");
  });
});

// ─── verifyBearerToken ────────────────────────────────────────────────────────

describe("verifyBearerToken", () => {
  it("accepts a valid token and extracts oid/upn/name/groups", async () => {
    const token = await mintToken({
      oid: "user-oid-1",
      upn: "tim@example.test",
      name: "Tim",
      groups: ["sec-arch", "gateway-admins"],
    });
    const identity = await verifyBearerToken(token, cfg, getKey);
    expect(identity.oid).toBe("user-oid-1");
    expect(identity.upn).toBe("tim@example.test");
    expect(identity.name).toBe("Tim");
    expect(identity.groups).toEqual(["sec-arch", "gateway-admins"]);
  });

  it("falls back to sub when oid is absent (workload identities)", async () => {
    const token = await mintToken({ sub: "client-credential-sub" });
    const identity = await verifyBearerToken(token, cfg, getKey);
    expect(identity.oid).toBe("client-credential-sub");
  });

  it("falls back to preferred_username when upn is absent", async () => {
    const token = await mintToken({ oid: "x", preferred_username: "pref@example.test" });
    const identity = await verifyBearerToken(token, cfg, getKey);
    expect(identity.upn).toBe("pref@example.test");
  });

  it("rejects a token with the wrong audience", async () => {
    const token = await mintToken({ oid: "x" }, { audience: "api://someone-else" });
    await expect(verifyBearerToken(token, cfg, getKey)).rejects.toThrow();
  });

  it("rejects a token with the wrong issuer", async () => {
    const token = await mintToken({ oid: "x" }, { issuer: "https://evil.example/v2.0" });
    await expect(verifyBearerToken(token, cfg, getKey)).rejects.toThrow();
  });

  it("rejects an expired token", async () => {
    const token = await mintToken({ oid: "x" }, { expiresIn: "-1m" });
    await expect(verifyBearerToken(token, cfg, getKey)).rejects.toThrow();
  });

  it("rejects a token with neither oid nor sub", async () => {
    const token = await mintToken({ upn: "no-principal@example.test" });
    await expect(verifyBearerToken(token, cfg, getKey)).rejects.toThrow(/oid or sub/);
  });
});

// ─── Middleware behavior ──────────────────────────────────────────────────────

describe("createEntraAuthMiddleware", () => {
  it("refuses to build for auth.mode = none", () => {
    expect(() =>
      createEntraAuthMiddleware({ mode: "none", tenant_id: "", audience: "" }, silentLogger)
    ).toThrow(/entra/);
  });

  it("valid bearer → identity attached, next() called", async () => {
    const mw = createEntraAuthMiddleware(cfg, silentLogger, getKey);
    const token = await mintToken({ oid: "user-oid-2", upn: "u2@example.test" });
    const req = fakeReq(`Bearer ${token}`);
    const res = fakeRes();

    const { nextCalled } = await runMiddleware(mw, req, res);
    expect(nextCalled).toBe(true);
    expect(req.identity?.oid).toBe("user-oid-2");
    expect(res.statusCode).toBeUndefined();
  });

  it("missing Authorization header → 401 invalid_request, no identity", async () => {
    const mw = createEntraAuthMiddleware(cfg, silentLogger, getKey);
    const req = fakeReq(undefined);
    const res = fakeRes();

    const { nextCalled } = await runMiddleware(mw, req, res);
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.headers["WWW-Authenticate"]).toContain("invalid_request");
    expect(req.identity).toBeUndefined();
  });

  it("malformed token → 401 invalid_token, generic body", async () => {
    const mw = createEntraAuthMiddleware(cfg, silentLogger, getKey);
    const req = fakeReq("Bearer not.a.jwt");
    const res = fakeRes();

    const { nextCalled } = await runMiddleware(mw, req, res);
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.headers["WWW-Authenticate"]).toContain("invalid_token");
    // Generic error only — verification detail must not leak to the caller.
    expect(JSON.stringify(res.body)).not.toContain("signature");
  });

  it("expired token → 401, next() not called", async () => {
    const mw = createEntraAuthMiddleware(cfg, silentLogger, getKey);
    const token = await mintToken({ oid: "x" }, { expiresIn: "-1m" });
    const req = fakeReq(`Bearer ${token}`);
    const res = fakeRes();

    const { nextCalled } = await runMiddleware(mw, req, res);
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
  });
});
