import { describe, it, expect } from "vitest";
import {
  checkHumanOutboundArgs,
  checkSqlDestructiveArgs,
  type ContentGuardConfig,
} from "../../src/content-guard.js";

/**
 * SEC-9 regression suite: the outbound-argument guards must NOT skip an
 * oversized arg.
 *
 * Before the fix, checkHumanOutboundArgs and checkSqlDestructiveArgs early
 * returned blocked:false when the serialized args exceeded maxScanChars, so a
 * padded HUMAN_OUTBOUND arg (e.g. a card number buried in a large Teams
 * message) skipped the card/SSN/SQL block entirely. Same oversize-skip bypass
 * class fixed for egress redaction in SEC-3, applied here on the BLOCKING path:
 * scan the head window, and treat an oversized (not-fully-scannable) arg as
 * blockable regardless (fail-closed).
 *
 * Fixtures assemble secret-shaped digits AT RUNTIME (e.g. ["4111", ...].join(""))
 * so no contiguous card literal appears in this file (that trips PCI scanners).
 * The assembled digits are the universal Visa test number; 123-45-6789 is a
 * placeholder SSN shape.
 */

const LUHN_ON: ContentGuardConfig = {
  secrets: true,
  luhn: true,
  ssn: false,
  sqlDestructive: false,
  maxScanChars: 1_000_000,
};

const SSN_ON: ContentGuardConfig = { ...LUHN_ON, ssn: true };
const SQL_ON: ContentGuardConfig = { ...LUHN_ON, sqlDestructive: true };

// Assembled at runtime; never a contiguous 16-digit card literal in source.
const TEST_VISA = ["4111", "1111", "1111", "1111"].join("");
const TEST_SSN = "123-45-6789";

// ─── HUMAN_OUTBOUND oversize fail-closed ──────────────────────────────────────

describe("checkHumanOutboundArgs — oversized arg (SEC-9 fail-closed)", () => {
  it("BLOCKS a card number padded PAST maxScanChars (was skipped pre-fix)", () => {
    const cfg: ContentGuardConfig = { ...LUHN_ON, maxScanChars: 100 };
    const args = { message: "x".repeat(300) + " pay with " + TEST_VISA };
    const result = checkHumanOutboundArgs(args, cfg);
    expect(result.blocked).toBe(true);
  });

  it("BLOCKS an SSN padded PAST maxScanChars when the ssn pack is on", () => {
    const cfg: ContentGuardConfig = { ...SSN_ON, maxScanChars: 100 };
    const args = { message: "y".repeat(300) + " ssn " + TEST_SSN };
    const result = checkHumanOutboundArgs(args, cfg);
    expect(result.blocked).toBe(true);
  });

  it("still reports the specific kind when a card is in the scanned HEAD", () => {
    const cfg: ContentGuardConfig = { ...LUHN_ON, maxScanChars: 100 };
    const args = { message: "card " + TEST_VISA + " " + "x".repeat(400) };
    const result = checkHumanOutboundArgs(args, cfg);
    expect(result.blocked).toBe(true);
    expect(result.kind).toBe("card-number");
  });

  it("fail-closed: even a CLEAN oversized arg is blocked (unscannable tail)", () => {
    const cfg: ContentGuardConfig = { ...LUHN_ON, maxScanChars: 50 };
    const args = { message: "z".repeat(500) };
    const result = checkHumanOutboundArgs(args, cfg);
    expect(result.blocked).toBe(true);
    expect(result.kind).toBe("oversize");
  });
});

// ─── HUMAN_OUTBOUND normal-size baselines (unchanged behavior) ─────────────────

describe("checkHumanOutboundArgs — normal-size baselines preserved", () => {
  it("blocks a small arg containing a card number, as before", () => {
    const result = checkHumanOutboundArgs({ message: "your card " + TEST_VISA }, LUHN_ON);
    expect(result.blocked).toBe(true);
    expect(result.kind).toBe("card-number");
  });

  it("passes a clean small arg through untouched", () => {
    const result = checkHumanOutboundArgs({ message: "Your order has shipped!" }, LUHN_ON);
    expect(result.blocked).toBe(false);
  });
});

// ─── Destructive-SQL guard oversize fail-closed ───────────────────────────────

describe("checkSqlDestructiveArgs — oversized arg (SEC-9 fail-closed)", () => {
  it("fail-closed: blocks a CLEAN oversized arg (unscannable tail)", () => {
    const cfg: ContentGuardConfig = { ...SQL_ON, maxScanChars: 50 };
    const result = checkSqlDestructiveArgs({ query: "a".repeat(500) }, cfg);
    expect(result.blocked).toBe(true);
    expect(result.kind).toBe("oversize");
  });

  it("still blocks a small DROP TABLE, as before", () => {
    const result = checkSqlDestructiveArgs({ query: "DROP TABLE users" }, SQL_ON);
    expect(result.blocked).toBe(true);
    expect(result.kind).toBe("sql-destructive");
  });

  it("passes a clean small query through untouched", () => {
    const result = checkSqlDestructiveArgs({ query: "SELECT 1" }, SQL_ON);
    expect(result.blocked).toBe(false);
  });
});
