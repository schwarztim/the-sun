import { createRemoteJWKSet, jwtVerify } from "jose";
import type { JWTVerifyGetKey } from "jose";
import type { NextFunction, Request, Response } from "express";
import type { AuthConfig } from "./config.js";
import type { Logger } from "./logger.js";

// ─── Identity model ───────────────────────────────────────────────────────────

/**
 * The authenticated principal attached to a request after JWT validation.
 * oid is the Entra object ID (stable per principal — users AND workload
 * identities); upn/name are human-friendly context for the decision log.
 */
export interface Identity {
  oid: string;
  upn?: string;
  name?: string;
  groups?: string[];
}

/** Express Request carrying a validated identity (set by the auth middleware). */
export interface AuthedRequest extends Request {
  identity?: Identity;
}

// ─── Entra endpoint derivation ────────────────────────────────────────────────

export function entraIssuer(cfg: AuthConfig): string {
  return cfg.issuer ?? `https://login.microsoftonline.com/${cfg.tenant_id}/v2.0`;
}

export function entraJwksUri(cfg: AuthConfig): string {
  return (
    cfg.jwks_uri ??
    `https://login.microsoftonline.com/${cfg.tenant_id}/discovery/v2.0/keys`
  );
}

// ─── Token verification ───────────────────────────────────────────────────────

/**
 * Verify a bearer token and extract the identity. Throws on ANY failure
 * (bad signature, wrong iss/aud, expired, missing oid/sub) — callers treat
 * every throw as 401. Fail-closed by construction: if Entra/JWKS is
 * unreachable, requests are rejected, not waved through.
 */
export async function verifyBearerToken(
  token: string,
  cfg: AuthConfig,
  getKey: JWTVerifyGetKey
): Promise<Identity> {
  const { payload } = await jwtVerify(token, getKey, {
    issuer: entraIssuer(cfg),
    audience: cfg.audience,
  });

  const oid =
    typeof payload.oid === "string" && payload.oid.length > 0
      ? payload.oid
      : typeof payload.sub === "string" && payload.sub.length > 0
        ? payload.sub
        : undefined;
  if (!oid) {
    throw new Error("token has no oid or sub claim");
  }

  const upn =
    typeof payload.upn === "string"
      ? payload.upn
      : typeof payload.preferred_username === "string"
        ? payload.preferred_username
        : undefined;

  return {
    oid,
    upn,
    name: typeof payload.name === "string" ? payload.name : undefined,
    groups: Array.isArray(payload.groups)
      ? payload.groups.filter((g): g is string => typeof g === "string")
      : undefined,
  };
}

// ─── Express middleware ───────────────────────────────────────────────────────

/**
 * Build the tool-plane authentication middleware for auth.mode = "entra".
 *
 * Mounted on /mcp, /sse, and /messages — the gateway validates Entra-issued
 * JWTs ITSELF as a resource server (defense-in-depth): headers injected by an
 * upstream edge (APIM/Caddy) are never trusted as an authorization input. A
 * bypassed or misrouted edge therefore fails to 401, not to silent access.
 *
 * 401 responses are deliberately generic; verification detail goes to the
 * gateway log only.
 *
 * @param getKeyOverride  Test seam: inject a local JWKS resolver instead of
 *                        the remote Entra JWKS set.
 */
export function createEntraAuthMiddleware(
  cfg: AuthConfig,
  logger: Logger,
  getKeyOverride?: JWTVerifyGetKey
): (req: Request, res: Response, next: NextFunction) => void {
  if (cfg.mode !== "entra") {
    throw new Error("createEntraAuthMiddleware requires auth.mode = 'entra'");
  }

  const getKey =
    getKeyOverride ?? createRemoteJWKSet(new URL(entraJwksUri(cfg)));

  return (req: Request, res: Response, _next: NextFunction): void => {
    const header = req.header("authorization") ?? "";
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      res
        .status(401)
        .set("WWW-Authenticate", 'Bearer error="invalid_request"')
        .json({ error: "Authentication required" });
      return;
    }

    verifyBearerToken(match[1], cfg, getKey)
      .then((identity) => {
        (req as AuthedRequest).identity = identity;
        _next();
      })
      .catch((err: unknown) => {
        logger.warn(
          `Tool-plane auth rejected ${req.method} ${req.path} from ${req.ip}: ${err instanceof Error ? err.message : String(err)}`
        );
        if (!res.headersSent) {
          res
            .status(401)
            .set("WWW-Authenticate", 'Bearer error="invalid_token"')
            .json({ error: "Invalid or expired token" });
        }
      });
  };
}
