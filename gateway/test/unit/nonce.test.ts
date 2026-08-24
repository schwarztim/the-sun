/**
 * Unit tests for the Phase-4 Tier-A confirm token (nonce.ts).
 *
 * The token is AUDIT INTEGRITY ONLY (roadmap §2.4) — these tests prove the
 * audit properties (challenge round-trip binding, args binding, expiry,
 * tamper detection), not any adversarial guarantee.
 */
import { describe, it, expect } from "vitest";
import { ConfirmTokenIssuer, canonicalArgsHash, stableStringify } from "../../src/nonce.js";

describe("stableStringify / canonicalArgsHash", () => {
  it("is key-order independent at every depth", () => {
    const a = { b: 1, a: { d: [1, 2], c: "x" } };
    const b = { a: { c: "x", d: [1, 2] }, b: 1 };
    expect(stableStringify(a)).toBe(stableStringify(b));
    expect(canonicalArgsHash(a)).toBe(canonicalArgsHash(b));
  });

  it("preserves array order (arrays are semantic, not sorted)", () => {
    expect(canonicalArgsHash({ v: [1, 2] })).not.toBe(canonicalArgsHash({ v: [2, 1] }));
  });

  it("excludes gateway-control keys (confirmed / confirmToken) from the hash", () => {
    const base = { id: "42" };
    expect(canonicalArgsHash({ ...base, confirmed: true, confirmToken: "v1.1.x" })).toBe(
      canonicalArgsHash(base)
    );
  });

  it("different semantic args produce different hashes", () => {
    expect(canonicalArgsHash({ id: "42" })).not.toBe(canonicalArgsHash({ id: "43" }));
  });
});

describe("ConfirmTokenIssuer", () => {
  it("round-trip: a freshly issued token verifies for the same tool + args", () => {
    const issuer = new ConfirmTokenIssuer();
    const args = { id: "42", nested: { deep: true } };
    const token = issuer.issue("fakebe_fake_delete_item", args);
    expect(issuer.verify("fakebe_fake_delete_item", args, token)).toEqual({ valid: true });
  });

  it("round-trip survives key reordering and gateway-control-key injection", () => {
    const issuer = new ConfirmTokenIssuer();
    const token = issuer.issue("t", { a: 1, b: 2 });
    // Re-call with reordered keys and the injected confirmed/confirmToken
    // plumbing (mux confirmationMapsToDownstream path) — still the same call.
    expect(issuer.verify("t", { b: 2, a: 1, confirmed: true, confirmToken: token }, token)).toEqual(
      { valid: true }
    );
  });

  it("expiry rejection: a token past its TTL is rejected as expired", () => {
    let now = 1_000_000;
    const issuer = new ConfirmTokenIssuer({ ttlMs: 10 * 60 * 1000, now: () => now });
    const token = issuer.issue("t", { id: "42" });
    now += 10 * 60 * 1000 + 1; // one ms past expiry
    expect(issuer.verify("t", { id: "42" }, token)).toEqual({ valid: false, reason: "expired" });
  });

  it("args-swap rejection: token for args A does not validate a call with args B", () => {
    const issuer = new ConfirmTokenIssuer();
    const token = issuer.issue("t", { path: "/tmp/benign.txt" });
    const verdict = issuer.verify("t", { path: "/etc/passwd" }, token);
    expect(verdict.valid).toBe(false);
    expect(verdict).toMatchObject({ reason: "bad-signature-or-args-mismatch" });
  });

  it("tool-swap rejection: token for tool A does not validate tool B with identical args", () => {
    const issuer = new ConfirmTokenIssuer();
    const token = issuer.issue("tool_a", { id: "42" });
    expect(issuer.verify("tool_b", { id: "42" }, token).valid).toBe(false);
  });

  it("tamper rejection: flipping a character in the MAC invalidates the token", () => {
    const issuer = new ConfirmTokenIssuer();
    const token = issuer.issue("t", { id: "42" });
    const lastChar = token.slice(-1);
    const tampered = token.slice(0, -1) + (lastChar === "0" ? "1" : "0");
    const verdict = issuer.verify("t", { id: "42" }, tampered);
    expect(verdict).toMatchObject({ valid: false, reason: "bad-signature-or-args-mismatch" });
  });

  it("tamper rejection: extending the expiry field invalidates the signature", () => {
    let now = 1_000_000;
    const issuer = new ConfirmTokenIssuer({ ttlMs: 1000, now: () => now });
    const token = issuer.issue("t", { id: "42" });
    const [v, expiry, mac] = token.split(".");
    const forged = [v, String(Number(expiry) + 3_600_000), mac].join(".");
    now += 2000; // original expired; forged expiry is in the future but unsigned
    expect(issuer.verify("t", { id: "42" }, forged)).toMatchObject({
      valid: false,
      reason: "bad-signature-or-args-mismatch",
    });
  });

  it("malformed tokens are rejected (undefined, wrong version, wrong shape, non-numeric expiry)", () => {
    const issuer = new ConfirmTokenIssuer();
    for (const bad of [undefined, null, 42, "", "nope", "v2.123.abc", "v1.abc.def", "v1.123"]) {
      const verdict = issuer.verify("t", { id: "42" }, bad);
      expect(verdict.valid).toBe(false);
    }
  });

  it("per-boot key: a token from one issuer does not verify on another (restart rotation)", () => {
    const a = new ConfirmTokenIssuer();
    const b = new ConfirmTokenIssuer();
    const token = a.issue("t", { id: "42" });
    expect(b.verify("t", { id: "42" }, token).valid).toBe(false);
  });
});
