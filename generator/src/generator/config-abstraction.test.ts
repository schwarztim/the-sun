import { describe, expect, it } from "vitest";
import { detectHardcodedConfig } from "./config-abstraction.js";

describe("detectHardcodedConfig — IPv4 detection", () => {
  it("does NOT flag a Chrome User-Agent version literal (Chrome/131.0.0.0)", () => {
    // Exactly the string src/templates/python/http_client.py embeds for its
    // browser-identity User-Agent header, copied into every generated server.
    const code =
      'USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"';
    const issues = detectHardcodedConfig(code);
    expect(issues.some((i) => i.includes("Hardcoded IP address"))).toBe(false);
  });

  it("still flags a real hardcoded IP address", () => {
    const code = 'FALLBACK_HOST = "192.168.1.50"';
    const issues = detectHardcodedConfig(code);
    expect(issues.some((i) => i.includes("Hardcoded IP address: 192.168.1.50"))).toBe(true);
  });

  it("still flags a real hardcoded IP embedded in a URL scheme", () => {
    const code = 'INTERNAL_API = "http://192.168.1.50:8080/api"';
    const issues = detectHardcodedConfig(code);
    expect(issues.some((i) => i.includes("Hardcoded IP address: 192.168.1.50"))).toBe(true);
  });

  it("does not flag localhost or the 0.0.0.0 bind-all address", () => {
    const code = 'a = "http://127.0.0.1:8000"; b = "0.0.0.0"';
    const issues = detectHardcodedConfig(code);
    expect(issues.some((i) => i.includes("Hardcoded IP address"))).toBe(false);
  });
});

describe("detectHardcodedConfig — supply-chain secret-scan pattern pack", () => {
  it("flags a planted fake AWS access key (AKIAAAAAAAAAAAAAAAAA)", () => {
    const code = 'AWS_KEY = "AKIAAAAAAAAAAAAAAAAA"';
    const issues = detectHardcodedConfig(code);
    expect(issues.some((i) => i.includes("Hardcoded AWS access key ID"))).toBe(true);
  });

  it("flags all current GitHub token prefixes, not just ghp_", () => {
    for (const token of [
      "ghp_" + "a".repeat(36),
      "gho_" + "b".repeat(36),
      "ghu_" + "c".repeat(40), // longer than 36 — must not be capped at exactly 36
    ]) {
      const issues = detectHardcodedConfig(`token = "${token}"`);
      expect(issues.some((i) => i.includes("Hardcoded API key"))).toBe(true);
    }
  });

  it("flags Slack tokens beyond the bot (xoxb-) prefix", () => {
    const issues = detectHardcodedConfig(`SLACK_TOKEN = "${["xoxp", "1234567890", "abcdef"].join("-")}"`);

    expect(issues.some((i) => i.includes("Hardcoded API key"))).toBe(true);
  });

  it("flags a hardcoded Google API key", () => {
    const key = "AIza" + "a".repeat(35);
    const issues = detectHardcodedConfig(`GOOGLE_API_KEY = "${key}"`);
    expect(issues.some((i) => i.includes("Hardcoded Google API key"))).toBe(true);
  });

  it("flags a hardcoded PEM private key header without printing the key body", () => {
    const code = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQ...\n-----END RSA PRIVATE KEY-----";
    const issues = detectHardcodedConfig(code);
    expect(issues.some((i) => i.includes("Hardcoded PEM private key"))).toBe(true);
  });

  it("flags a hardcoded session/cookie literal (the HAR/browser-capture leak scenario)", () => {
    const issues = detectHardcodedConfig(
      'session_id = "aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789"',
    );
    expect(issues.some((i) => i.includes("Hardcoded high-entropy credential"))).toBe(true);
  });

  it("flags a credential bound with Go's := short variable declaration", () => {
    // Go is the generator's default output language and `token := "..."` is its
    // idiomatic binding form, but a single-character assignment class matched
    // only `=` and `:`, so this shape used to slip the scan.
    const captured = "aBcDeFgHiJkLmNoP" + "0123456789";
    const issues = detectHardcodedConfig(`\ttoken := "${captured}"`);
    expect(issues.some((i) => i.includes("Hardcoded high-entropy credential"))).toBe(true);
  });

  it("still flags the plain = and : assignment forms after the := addition", () => {
    // Guards against the := alternation shadowing the single-character branch.
    // The bare-key `cookie:` form is what the ":" branch covers (YAML, Go struct
    // literals); a JSON quoted key (`"cookie": "..."`) is a separate,
    // pre-existing gap in this pattern and is deliberately not asserted here.
    const captured = "aBcDeFgHiJkLmNoP" + "0123456789";
    expect(detectHardcodedConfig(`api_key = "${captured}"`).length).toBeGreaterThan(0);
    expect(detectHardcodedConfig(`cookie: "${captured}"`).length).toBeGreaterThan(0);
  });

  it("does NOT flag a hermescred:// vault reference", () => {
    const code = 'TOKEN = "hermescred://shodan/default"';
    const issues = detectHardcodedConfig(code);
    expect(issues).toHaveLength(0);
  });

  it("does NOT flag ${VAR} template interpolation even inside a credential-shaped assignment", () => {
    const code = 'api_key = "${SHODAN_API_KEY_LONG_ENOUGH_TO_MATCH}"';
    const issues = detectHardcodedConfig(code);
    expect(issues).toHaveLength(0);
  });

  it("passes clean, credential-free generated-style output", () => {
    const code = [
      "import os",
      "",
      "api_key = os.environ['SHODAN_API_KEY']",
      "base_url = os.environ.get('SHODAN_BASE_URL', 'https://api.example.com')",
      "# fetched via hermescred://shodan/default at spawn time by fleetd",
    ].join("\n");
    expect(detectHardcodedConfig(code)).toHaveLength(0);
  });
});
