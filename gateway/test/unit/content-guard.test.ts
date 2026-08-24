import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  applyResultRedaction,
  checkHumanOutboundArgs,
  checkSqlDestructiveArgs,
  findLuhnCardMatches,
  findHighEntropyTokens,
  isHighEntropyToken,
  shannonEntropy,
  type ContentGuardConfig,
} from "../../src/content-guard.js";

const ALL_ON: ContentGuardConfig = {
  secrets: true,
  luhn: true,
  ssn: true,
  sqlDestructive: true,
  maxScanChars: 1_000_000,
};

const DEFAULTS: ContentGuardConfig = {
  secrets: true,
  luhn: true,
  ssn: false,
  sqlDestructive: false,
  maxScanChars: 1_000_000,
};

const ALL_OFF: ContentGuardConfig = {
  secrets: false,
  luhn: false,
  ssn: false,
  sqlDestructive: false,
  maxScanChars: 1_000_000,
};

// Well-known, non-real credential/test values used throughout:
//  - AKIAIOSFODNN7EXAMPLE is AWS's own documentation placeholder access key.
//  - 4111111111111111 is the universally-used Visa test card number.
const AWS_EXAMPLE_KEY = ("AKIA" + "IOSFODNN7EXAMPLE");
const TEST_VISA = "4111111111111111";

// ─── findLuhnCardMatches ───────────────────────────────────────────────────────

describe("findLuhnCardMatches — Luhn + card-prefix detection", () => {
  it("matches a Luhn-valid Visa test number", () => {
    expect(findLuhnCardMatches(`card: ${TEST_VISA}`)).toEqual([TEST_VISA]);
  });

  it("matches with space separators", () => {
    expect(findLuhnCardMatches("card: 4111 1111 1111 1111")).toEqual(["4111 1111 1111 1111"]);
  });

  it("matches with dash separators", () => {
    expect(findLuhnCardMatches("card: 4111-1111-1111-1111")).toEqual(["4111-1111-1111-1111"]);
  });

  it("does NOT match a random 16-digit number that fails Luhn", () => {
    // Same length/prefix as the Visa test number but last digit flipped — fails checksum.
    expect(findLuhnCardMatches("4111111111111112")).toEqual([]);
  });

  it("does NOT match a Luhn-valid-looking number with no known card prefix", () => {
    // 19 digits starting with 9 — not a recognized IIN range even if some
    // permutation could pass Luhn; prefix gate keeps false positives near zero.
    expect(findLuhnCardMatches("9999999999999999")).toEqual([]);
  });

  it("does not false-positive on an ordinary phone number or ID", () => {
    expect(findLuhnCardMatches("call 555-0100 re: ticket 1234567")).toEqual([]);
  });
});

// ─── applyResultRedaction — egress secret redaction ───────────────────────────

describe("applyResultRedaction — egress secret redaction (results)", () => {
  it("redacts an AWS access key in plain text", () => {
    const result = applyResultRedaction(`key=${AWS_EXAMPLE_KEY}`, DEFAULTS);
    expect(result.text).not.toContain(AWS_EXAMPLE_KEY);
    expect(result.text).toContain("[REDACTED:aws-key]");
    expect(result.redactedKinds).toContain("aws-key");
  });

  it("redacts a GitHub token", () => {
    const token = `ghp_${"a".repeat(36)}`;
    const result = applyResultRedaction(`token: ${token}`, DEFAULTS);
    expect(result.text).not.toContain(token);
    expect(result.redactedKinds).toContain("github-token");
  });

  it("redacts an OpenAI-shaped key", () => {
    const key = `sk-${"A".repeat(24)}`;
    const result = applyResultRedaction(`OPENAI_API_KEY=${key}`, DEFAULTS);
    expect(result.text).not.toContain(key);
    expect(result.redactedKinds).toContain("openai-key");
  });

  it("redacts a full PEM private-key block, not just the header", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK...\n-----END RSA PRIVATE KEY-----";
    const result = applyResultRedaction(pem, DEFAULTS);
    expect(result.text).not.toContain("MIIBOgIBAAJBAK");
    expect(result.redactedKinds).toContain("private-key");
  });

  it("redacts a Slack token", () => {
    const token = ["xoxb", "111111111111", "222222222222", "abcdefghijklmnopqrstuvwx"].join("-");
    const result = applyResultRedaction(token, DEFAULTS);
    expect(result.text).not.toContain(token);
    expect(result.redactedKinds).toContain("slack-token");
  });

  it("redacts a Google API key", () => {
    const key = `AIza${"S".repeat(35)}`;
    const result = applyResultRedaction(key, DEFAULTS);
    expect(result.text).not.toContain(key);
    expect(result.redactedKinds).toContain("google-api-key");
  });

  it("redacts a generic bearer token", () => {
    const result = applyResultRedaction(`Authorization: Bearer ${"x".repeat(30)}`, DEFAULTS);
    expect(result.text).not.toContain("x".repeat(30));
    expect(result.redactedKinds).toContain("bearer-token");
  });

  it("redacts a Luhn-valid card number in results (luhn pack)", () => {
    const result = applyResultRedaction(`charged card ${TEST_VISA}`, DEFAULTS);
    expect(result.text).not.toContain(TEST_VISA);
    expect(result.text).toContain("[REDACTED:card-number]");
    expect(result.redactedKinds).toContain("card-number");
  });

  it("redacts inside NESTED JSON string values, not just top-level", () => {
    const payload = JSON.stringify({
      user: { name: "Jane", credentials: { key: AWS_EXAMPLE_KEY } },
      items: [{ note: `card on file: ${TEST_VISA}` }],
    });
    const result = applyResultRedaction(payload, DEFAULTS);
    expect(result.text).not.toContain(AWS_EXAMPLE_KEY);
    expect(result.text).not.toContain(TEST_VISA);
    const parsed = JSON.parse(result.text);
    expect(parsed.user.credentials.key).toBe("[REDACTED:aws-key]");
    expect(parsed.items[0].note).toContain("[REDACTED:card-number]");
    expect(result.redactedKinds.sort()).toEqual(["aws-key", "card-number"]);
  });

  it("does NOT redact an SSN when the ssn pack is disabled (default off)", () => {
    const result = applyResultRedaction("SSN: 123-45-6789", DEFAULTS);
    expect(result.text).toContain("123-45-6789");
    expect(result.redactedKinds).not.toContain("ssn");
  });

  it("redacts an SSN when the ssn pack is explicitly enabled", () => {
    const result = applyResultRedaction("SSN: 123-45-6789", ALL_ON);
    expect(result.text).not.toContain("123-45-6789");
    expect(result.redactedKinds).toContain("ssn");
  });

  it("passes benign text through completely untouched (non-annoying)", () => {
    const benign = "The weather in Portland is 62F with light rain. Ticket INC0012345 is resolved.";
    const result = applyResultRedaction(benign, DEFAULTS);
    expect(result.text).toBe(benign);
    expect(result.redactedKinds).toEqual([]);
  });

  it("passes benign JSON through untouched", () => {
    const benign = JSON.stringify({ status: "ok", count: 3, items: ["a", "b", "c"] });
    const result = applyResultRedaction(benign, DEFAULTS);
    expect(JSON.parse(result.text)).toEqual(JSON.parse(benign));
    expect(result.redactedKinds).toEqual([]);
  });

  it("is a no-op when all packs are disabled", () => {
    const result = applyResultRedaction(`key=${AWS_EXAMPLE_KEY} card=${TEST_VISA}`, ALL_OFF);
    expect(result.redactedKinds).toEqual([]);
  });

  it("fail-closed on a payload larger than maxScanChars: scans the head, withholds the remainder (SEC-3)", () => {
    // Previously this passed the oversized payload through UNSCANNED, which let a
    // padded backend response smuggle a secret to the model. Now the head window
    // is scanned/redacted and the past-budget remainder is withheld, never emitted.
    const huge = `${AWS_EXAMPLE_KEY} ${"x".repeat(200)}`;
    const cfg: ContentGuardConfig = { ...DEFAULTS, maxScanChars: 50 };
    const result = applyResultRedaction(huge, cfg);
    // The secret in the head window is redacted, not emitted verbatim.
    expect(result.text).not.toContain(AWS_EXAMPLE_KEY);
    // The past-budget remainder is withheld behind the oversize marker.
    expect(result.text).toContain("[REDACTED:oversize-withheld]");
    expect(result.text).not.toContain("x".repeat(200));
    expect(result.redactedKinds).toContain("oversize-withheld");
  });
});

// ─── GitHub token family (full coverage: ghp/gho/ghu/ghs/ghr + fine-grained) ──
//
// Fixture tokens are ASSEMBLED AT RUNTIME via string concatenation — a
// contiguous secret-shaped literal in this file trips GitHub push protection
// (it did, before). Never inline a full token literal here.

describe("applyResultRedaction — GitHub token family", () => {
  const FAMILY_PREFIXES = ["ghp", "gho", "ghu", "ghs", "ghr"];

  it.each(FAMILY_PREFIXES)("redacts a %s_ token (36-char alnum tail)", (prefix) => {
    const token = `${prefix}_` + "Ab3".repeat(12); // 36-char tail
    const result = applyResultRedaction(`token: ${token}`, DEFAULTS);
    expect(result.text).not.toContain(token);
    expect(result.text).toContain("[REDACTED:github-token]");
    expect(result.redactedKinds).toContain("github-token");
  });

  it.each(FAMILY_PREFIXES)("redacts a %s_ token whose tail contains underscores", (prefix) => {
    const token = `${prefix}_` + "aB1_c2".repeat(6); // 36-char tail with underscores
    const result = applyResultRedaction(`cfg = { "access_token": "${token}" }`, DEFAULTS);
    expect(result.text).not.toContain(token);
    expect(result.redactedKinds).toContain("github-token");
  });

  it("redacts a fine-grained PAT (github_pat_ prefix, 22+ char tail)", () => {
    const token = "github_pat_" + "11ABCDEFG0".repeat(3); // 30-char tail
    const result = applyResultRedaction(`auth: ${token}`, DEFAULTS);
    expect(result.text).not.toContain(token);
    expect(result.redactedKinds).toContain("github-token");
  });

  it("redacts a gho_ OAuth token nested in JSON (the copilot config leak shape)", () => {
    const token = "gho_" + "x".repeat(36);
    const payload = JSON.stringify({ hosts: { "github.com": { oauth_token: token } } });
    const result = applyResultRedaction(payload, DEFAULTS);
    expect(result.text).not.toContain(token);
    expect(JSON.parse(result.text).hosts["github.com"].oauth_token).toBe(
      "[REDACTED:github-token]"
    );
  });

  it('does NOT redact prose containing "ghost_" (prefix requires gh + [posur] + underscore)', () => {
    const prose = `the ghost_writer module handles ghost_${"a".repeat(36)} identifiers`;
    const result = applyResultRedaction(prose, DEFAULTS);
    expect(result.text).toBe(prose);
    expect(result.redactedKinds).not.toContain("github-token");
  });

  it('does NOT redact a short "gho_x" (36-char minimum tail)', () => {
    const short = "set gho_x and gho_" + "y".repeat(10) + " in the env";
    const result = applyResultRedaction(short, DEFAULTS);
    expect(result.text).toBe(short);
    expect(result.redactedKinds).toEqual([]);
  });
});

// ─── High-entropy secret detector (opt-in pack, default OFF) ─────────────────

describe("high-entropy secret detector (entropy pack)", () => {
  const ENTROPY_ON: ContentGuardConfig = { ...DEFAULTS, entropy: true };

  // Runtime-assembled high-entropy fixtures (never contiguous secret-shaped
  // literals): deterministic digests are indistinguishable from random keys.
  const HEX_SECRET_64 = createHash("sha256").update("entropy-fixture").digest("hex");
  const B64_SECRET = createHash("sha512").update("entropy-fixture").digest("base64"); // 88 chars
  const GIT_SHA_40 = createHash("sha1").update("entropy-fixture").digest("hex");

  it("shannonEntropy sanity: uniform-ish digest text scores far above repeated chars", () => {
    expect(shannonEntropy("aaaaaaaaaaaaaaaa")).toBe(0);
    expect(shannonEntropy(HEX_SECRET_64)).toBeGreaterThan(3.0);
  });

  it("flags a 64-char hex secret (sha256-sized key material)", () => {
    expect(isHighEntropyToken(HEX_SECRET_64)).toBe(true);
    const result = applyResultRedaction(`api_secret=${HEX_SECRET_64}`, ENTROPY_ON);
    expect(result.text).not.toContain(HEX_SECRET_64);
    expect(result.text).toContain("[REDACTED:high-entropy]");
    expect(result.redactedKinds).toContain("high-entropy");
  });

  it("flags a long base64 blob (mixed-class, high entropy)", () => {
    expect(isHighEntropyToken(B64_SECRET.replace(/=+$/, ""))).toBe(true);
    const result = applyResultRedaction(`signing key: ${B64_SECRET}`, ENTROPY_ON);
    expect(result.text).not.toContain(B64_SECRET);
    expect(result.redactedKinds).toContain("high-entropy");
  });

  it("does NOT flag English prose", () => {
    const prose =
      "The deployment completed successfully and all seventeen integration checks passed without incident.";
    expect(findHighEntropyTokens(prose)).toEqual([]);
    const result = applyResultRedaction(prose, ENTROPY_ON);
    expect(result.text).toBe(prose);
  });

  it("does NOT flag UUIDs", () => {
    const uuid = "6f9619ff-8b86-4011-b42d-00c04fc964ff";
    expect(isHighEntropyToken(uuid)).toBe(false);
    const result = applyResultRedaction(`request id ${uuid} completed`, ENTROPY_ON);
    expect(result.text).toContain(uuid);
    expect(result.redactedKinds).toEqual([]);
  });

  it("does NOT flag short hex (ids, checksums)", () => {
    const result = applyResultRedaction("crc=deadbeef block=cafef00d", ENTROPY_ON);
    expect(result.text).toBe("crc=deadbeef block=cafef00d");
    expect(result.redactedKinds).toEqual([]);
  });

  it("does NOT flag a 40-char git SHA-1 (deliberate 48-char hex floor)", () => {
    expect(isHighEntropyToken(GIT_SHA_40)).toBe(false);
    const result = applyResultRedaction(`commit ${GIT_SHA_40}`, ENTROPY_ON);
    expect(result.text).toContain(GIT_SHA_40);
  });

  it("does NOT flag a long single-class token (lowercase identifier)", () => {
    const ident = "supercalifragilisticexpialidociousandthensomemorewords";
    expect(isHighEntropyToken(ident)).toBe(false);
  });

  it("is OFF by default: the same hex secret passes through under DEFAULTS", () => {
    const result = applyResultRedaction(`api_secret=${HEX_SECRET_64}`, DEFAULTS);
    expect(result.text).toContain(HEX_SECRET_64);
    expect(result.redactedKinds).not.toContain("high-entropy");
  });
});

// ─── checkHumanOutboundArgs — outbound PCI/PII arg blocking ───────────────────

describe("checkHumanOutboundArgs — HUMAN_OUTBOUND outbound-argument blocking", () => {
  it("blocks when a Luhn-valid card number is present in args", () => {
    const result = checkHumanOutboundArgs({ message: `Your card ${TEST_VISA} was charged` }, DEFAULTS);
    expect(result.blocked).toBe(true);
    expect(result.kind).toBe("card-number");
  });

  it("does not block a benign message", () => {
    const result = checkHumanOutboundArgs({ message: "Your order has shipped!" }, DEFAULTS);
    expect(result.blocked).toBe(false);
  });

  it("does not block an SSN-shaped value when the ssn pack is off (default)", () => {
    const result = checkHumanOutboundArgs({ message: "SSN 123-45-6789" }, DEFAULTS);
    expect(result.blocked).toBe(false);
  });

  it("blocks an SSN-shaped value when the ssn pack is enabled", () => {
    const result = checkHumanOutboundArgs({ message: "SSN 123-45-6789" }, ALL_ON);
    expect(result.blocked).toBe(true);
    expect(result.kind).toBe("ssn");
  });

  it("finds a card number nested inside a deeply nested argument object", () => {
    const result = checkHumanOutboundArgs(
      { message: { body: { text: `pay with ${TEST_VISA}` } } },
      DEFAULTS
    );
    expect(result.blocked).toBe(true);
  });

  it("does not block when both packs are disabled", () => {
    const result = checkHumanOutboundArgs({ message: `card ${TEST_VISA}` }, ALL_OFF);
    expect(result.blocked).toBe(false);
  });
});

// ─── checkSqlDestructiveArgs — off-by-default, tag-scoped by caller ───────────

describe("checkSqlDestructiveArgs — destructive-SQL argument blocking", () => {
  it("is a no-op when the pack is disabled (default)", () => {
    const result = checkSqlDestructiveArgs({ query: "DROP TABLE users" }, DEFAULTS);
    expect(result.blocked).toBe(false);
  });

  it("blocks a plain DROP TABLE when enabled", () => {
    const result = checkSqlDestructiveArgs({ query: "DROP TABLE users" }, ALL_ON);
    expect(result.blocked).toBe(true);
    expect(result.kind).toBe("sql-destructive");
  });

  it("blocks comment-injected DROP/**/TABLE when enabled", () => {
    const result = checkSqlDestructiveArgs({ query: "DROP/**/TABLE users" }, ALL_ON);
    expect(result.blocked).toBe(true);
  });

  it("blocks DELETE FROM without a WHERE clause when enabled", () => {
    const result = checkSqlDestructiveArgs({ query: "DELETE FROM users" }, ALL_ON);
    expect(result.blocked).toBe(true);
  });

  it("does NOT block DELETE FROM with a WHERE clause when enabled", () => {
    const result = checkSqlDestructiveArgs({ query: "DELETE FROM users WHERE id = 42" }, ALL_ON);
    expect(result.blocked).toBe(false);
  });

  it("does not block an unrelated SELECT query when enabled", () => {
    const result = checkSqlDestructiveArgs({ query: "SELECT * FROM users WHERE id = 1" }, ALL_ON);
    expect(result.blocked).toBe(false);
  });
});
