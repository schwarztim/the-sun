import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Tier-A confirm-token (stateless HMAC nonce) — AUDIT INTEGRITY ONLY.
 *
 * ⚠️ THIS IS EXPLICITLY NOT AN ADVERSARIAL CONTROL (SECURITY-ROADMAP.md §2.4).
 * A fully autonomous model reads the token out of the block response and
 * echoes it back, exactly as it reads the `confirmationRequired` hint today.
 * Never describe this mechanism as "hardening Tier-A against autonomous
 * clients" — that would be a soft control dressed as hard. Tier-B (out-of-band
 * human approval) is the control for calls the model must not self-authorize.
 *
 * What the token genuinely buys — and the only honest justification:
 *
 *  1. NO BLIND FIRST-CALL SELF-CONFIRM. Without it, `confirmed: true` on the
 *     very first call proceeds and the challenge text was never seen. With it,
 *     every executed Tier-A gated call provably had a prior challenge
 *     round-trip: the caller demonstrably received the warning and the
 *     redacted args before proceeding.
 *
 *  2. NO CONFIRM-THEN-SWAP. The token is HMAC-bound to a canonical hash of
 *     the challenged arguments, so a token issued for args A does not validate
 *     a confirmed call with args B. The audit pair (challenge, execution) is
 *     guaranteed to describe the same arguments.
 *
 * Design: stateless. HMAC-SHA256 over (toolName \n argsHash \n expiryEpochMs)
 * with a per-boot random 256-bit key. No token store, no replay ledger — a
 * token is valid for its (tool, args) pair until expiry (~10 min default).
 * Replay within the window re-executes the SAME audited action, which is
 * within the audit-integrity threat model (and Tier-A calls are agent-
 * re-invocable anyway). A gateway restart rotates the key and invalidates all
 * outstanding tokens; the caller simply gets re-challenged.
 *
 * Token wire format: `v1.<expiryEpochMs>.<hmacHex>`.
 */

const TOKEN_VERSION = "v1";
const DEFAULT_TTL_MS = 10 * 60 * 1000; // ~10 minutes

/** Gateway-control keys excluded from the canonical args hash. `confirmed`
 * (and the token itself) are gate plumbing, not call semantics — the mux path
 * injects `confirmed: true` into dispatch args for confirmationMapsToDownstream
 * capabilities AFTER the challenge was issued, and hashing them would make the
 * confirmed re-call structurally unable to match its own challenge. */
const CONTROL_KEYS = new Set(["confirmed", "confirmToken"]);

/** Stable JSON stringify: object keys sorted at every depth, arrays in order. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
}

/**
 * Canonical hash of a tool call's arguments: SHA-256 hex over the stable
 * stringify, with gateway-control keys (confirmed / confirmToken) stripped at
 * the top level so gate plumbing never perturbs the hash.
 */
export function canonicalArgsHash(args: Record<string, unknown>): string {
  const semantic: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (CONTROL_KEYS.has(k)) continue;
    semantic[k] = v;
  }
  return createHash("sha256").update(stableStringify(semantic)).digest("hex");
}

export type ConfirmTokenVerdict =
  | { valid: true }
  | { valid: false; reason: "malformed" | "expired" | "bad-signature-or-args-mismatch" };

/**
 * Issues and verifies Tier-A confirm tokens. One instance per gateway boot —
 * the HMAC key is generated at construction and never persisted (per-boot
 * key rotation is a feature: stale tokens across restarts just re-challenge).
 */
export class ConfirmTokenIssuer {
  private readonly key: Buffer;
  private readonly ttlMs: number;
  /** Injectable clock — test seam for expiry behavior. */
  private readonly now: () => number;

  constructor(opts: { ttlMs?: number; now?: () => number } = {}) {
    this.key = randomBytes(32);
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  private sign(toolName: string, argsHash: string, expiryEpochMs: number): string {
    return createHmac("sha256", this.key)
      .update(`${toolName}\n${argsHash}\n${expiryEpochMs}`)
      .digest("hex");
  }

  /** Issue a token bound to (toolName, current args) with the configured TTL. */
  issue(toolName: string, args: Record<string, unknown>): string {
    const expiry = this.now() + this.ttlMs;
    const mac = this.sign(toolName, canonicalArgsHash(args), expiry);
    return `${TOKEN_VERSION}.${expiry}.${mac}`;
  }

  /**
   * Verify a presented token against the CURRENT tool name and arguments.
   * The args hash is recomputed from the current args, so a token issued for
   * args A structurally cannot validate a call with args B (confirm-then-swap
   * shows up here as a signature mismatch — indistinguishable from tamper by
   * design, since both mean "this challenge does not cover this execution").
   */
  verify(toolName: string, args: Record<string, unknown>, token: unknown): ConfirmTokenVerdict {
    if (typeof token !== "string") return { valid: false, reason: "malformed" };
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) {
      return { valid: false, reason: "malformed" };
    }
    const expiry = Number(parts[1]);
    if (!Number.isFinite(expiry)) return { valid: false, reason: "malformed" };
    if (expiry <= this.now()) return { valid: false, reason: "expired" };

    const expected = this.sign(toolName, canonicalArgsHash(args), expiry);
    const presented = parts[2];
    if (presented.length !== expected.length) {
      return { valid: false, reason: "bad-signature-or-args-mismatch" };
    }
    const ok = timingSafeEqual(Buffer.from(presented, "utf-8"), Buffer.from(expected, "utf-8"));
    return ok ? { valid: true } : { valid: false, reason: "bad-signature-or-args-mismatch" };
  }
}
