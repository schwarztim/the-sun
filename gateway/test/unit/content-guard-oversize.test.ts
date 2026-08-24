import { describe, it, expect } from "vitest";
import { applyResultRedaction, type ContentGuardConfig } from "../../src/content-guard.js";

/**
 * SEC-3 regression suite for the two egress content-guard holes:
 *
 *  1. OVERSIZED-PAYLOAD BYPASS — before the fix, applyResultRedaction returned
 *     any payload longer than maxScanChars UNSCANNED, so a compromised backend
 *     could pad a response past the cap to smuggle a secret out in the tail.
 *     The fix scans the head window and WITHHOLDS the remainder (fail-closed);
 *     it never emits unscanned bytes.
 *  2. NON-STRING LEAVES — before the fix, only string leaves were scanned, so
 *     a secret hidden in a numeric leaf or an object KEY slipped through.
 *
 * Fixtures assemble secret-shaped values AT RUNTIME (e.g. "AKIA" + "IOSFO...",
 * "4111" + ...) so no contiguous secret-shaped literal appears in this file
 * (that trips push-protection / PCI scanners). that same AWS example key is AWS's
 * own documentation placeholder key; the assembled digits are the universal
 * Visa test number.
 */

const DEFAULTS: ContentGuardConfig = {
  secrets: true,
  luhn: true,
  ssn: false,
  sqlDestructive: false,
  maxScanChars: 1_000_000,
};

const AWS_EXAMPLE_KEY = ("AKIA" + "IOSFODNN7EXAMPLE");
// Assembled at runtime; never a contiguous 16-digit card literal in source.
const TEST_VISA = ["4111", "1111", "1111", "1111"].join("");

// ─── Hole 1: oversized-payload bypass ─────────────────────────────────────────

describe("applyResultRedaction — oversized payload (fail-closed, no bypass)", () => {
  it("does NOT emit a secret padded PAST the maxScanChars boundary verbatim", () => {
    const cfg: ContentGuardConfig = { ...DEFAULTS, maxScanChars: 100 };
    // The secret sits past the scan budget; pre-fix this whole payload passed
    // through untouched, exfiltrating the key. It must now be withheld.
    const padded = "x".repeat(300) + " secret=" + AWS_EXAMPLE_KEY;
    const result = applyResultRedaction(padded, cfg);
    expect(result.text).not.toContain(AWS_EXAMPLE_KEY);
    expect(result.text).toContain("[REDACTED:oversize-withheld]");
    expect(result.redactedKinds).toContain("oversize-withheld");
  });

  it("still redacts a secret in the scanned HEAD of an oversized payload", () => {
    const cfg: ContentGuardConfig = { ...DEFAULTS, maxScanChars: 100 };
    const padded = "key=" + AWS_EXAMPLE_KEY + " " + "x".repeat(400);
    const result = applyResultRedaction(padded, cfg);
    expect(result.text).not.toContain(AWS_EXAMPLE_KEY);
    expect(result.text).toContain("[REDACTED:aws-key]");
    expect(result.text).toContain("[REDACTED:oversize-withheld]");
    expect(result.redactedKinds).toContain("aws-key");
  });

  it("fail-closed: even a CLEAN payload past the budget has its tail withheld", () => {
    const cfg: ContentGuardConfig = { ...DEFAULTS, maxScanChars: 50 };
    const clean = "y".repeat(500);
    const result = applyResultRedaction(clean, cfg);
    expect(result.text).toContain("[REDACTED:oversize-withheld]");
    expect(result.text.length).toBeLessThan(clean.length);
    expect(result.redactedKinds).toEqual(["oversize-withheld"]);
  });
});

// ─── Hole 2: numeric leaves and object keys ───────────────────────────────────

describe("applyResultRedaction — non-string leaves (numeric values, object keys)", () => {
  it("redacts a card number hidden in a NUMERIC JSON leaf", () => {
    const payload = JSON.stringify({ amount: Number(TEST_VISA) });
    const result = applyResultRedaction(payload, DEFAULTS);
    expect(result.text).not.toContain(TEST_VISA);
    expect(result.text).toContain("[REDACTED:card-number]");
    expect(result.redactedKinds).toContain("card-number");
  });

  it("redacts a secret hidden in an object KEY", () => {
    const payload = JSON.stringify({ [AWS_EXAMPLE_KEY]: "value" });
    const result = applyResultRedaction(payload, DEFAULTS);
    expect(result.text).not.toContain(AWS_EXAMPLE_KEY);
    const parsed = JSON.parse(result.text);
    expect(Object.keys(parsed)).toContain("[REDACTED:aws-key]");
    expect(parsed["[REDACTED:aws-key]"]).toBe("value");
    expect(result.redactedKinds).toContain("aws-key");
  });

  it("leaves benign numeric leaves as numbers (no spurious stringification)", () => {
    const payload = JSON.stringify({ count: 3, total: 42, ratio: 0.5 });
    const result = applyResultRedaction(payload, DEFAULTS);
    expect(JSON.parse(result.text)).toEqual({ count: 3, total: 42, ratio: 0.5 });
    expect(result.redactedKinds).toEqual([]);
  });
});

// ─── Baselines: unchanged behavior for normal-size payloads ───────────────────

describe("applyResultRedaction — baselines preserved", () => {
  it("redacts a secret in a normal small payload as before", () => {
    const result = applyResultRedaction(`key=${AWS_EXAMPLE_KEY}`, DEFAULTS);
    expect(result.text).not.toContain(AWS_EXAMPLE_KEY);
    expect(result.text).toContain("[REDACTED:aws-key]");
    expect(result.redactedKinds).toContain("aws-key");
  });

  it("passes a clean small payload through completely untouched", () => {
    const benign = "all systems nominal; 3 checks passed for ticket INC0012345.";
    const result = applyResultRedaction(benign, DEFAULTS);
    expect(result.text).toBe(benign);
    expect(result.redactedKinds).toEqual([]);
  });
});
