/**
 * Confirms Gate 4 (wire-fingerprint) actually DISCRIMINATES: a server whose
 * egress goes out over a non-Chrome-impersonated TLS stack must fail the
 * gate via the ANCHOR-MISMATCH branch (a captured, non-null JA4 that simply
 * doesn't match the anchors — wire-fingerprint.ts's `passed` line, ~171-178)
 * — never via the "no ClientHello observed" branch, which only proves the
 * gate noticed nothing, not that it can tell a real mismatch apart from a
 * missing capture. Before this test, the mismatch branch had never been
 * exercised by any test in this repo.
 *
 * Deliberately pure Node, no Python interpreter required (unlike
 * wire-fingerprint.selftest.test.ts): __fixtures__/mini-http-server.mjs's
 * `call_upstream` tool does a plain `fetch()`, which is Node's own
 * OpenSSL-backed TLS stack — structurally guaranteed to differ from
 * curl_cffi's BoringSSL chrome131 impersonation (different cipher-suite
 * set/order and extension set), so this needs no skip path and runs
 * everywhere `npx vitest run` runs.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { launchAndConnect } from "../harness.js";
import type { LaunchSpec } from "../types.js";
import { runWireFingerprintGate } from "./wire-fingerprint.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(HERE, "..", "__fixtures__");

const SPEC: LaunchSpec = {
  transport: "streamable-http",
  command: "node",
  args: ["mini-http-server.mjs"],
  portEnvVar: "PORT",
  hostEnvVar: "HOST",
  mcpPath: "/mcp",
  targetBaseUrlEnvVar: "BASE_URL",
  // This test exercises the REQUIRED wire-fingerprint path (discriminating
  // power). Post-conditional-gate, the target must declare requiresBrowserTLS
  // for the gate to actually run its capture instead of informational-passing.
  requiresBrowserTLS: true,
};

describe("Gate 4 — wire-fingerprint mismatch branch (discriminating power)", () => {
  it("fails via the JA4-mismatch branch (not 'no ClientHello observed') for a non-Chrome TLS stack", async () => {
    const probe = await launchAndConnect(FIXTURES_DIR, SPEC);
    let tools;
    try {
      tools = (await probe.client.listTools()).tools;
    } finally {
      await probe.close();
    }
    // Must be tools[0] — the gate's tool-invocation fallback always calls
    // tools[0] to trigger egress (see wire-fingerprint.ts).
    expect(tools[0]?.name).toBe("call_upstream");

    const result = await runWireFingerprintGate(FIXTURES_DIR, SPEC, tools);

    const detail = result.detail as { mechanism: string; ja4: string | null };
    expect(detail.mechanism).toBe("tool-invocation");
    // The discriminating assertion: a ClientHello WAS captured (ja4 is
    // non-null) but it fails the anchor check — proves the gate can tell
    // "captured, doesn't match" apart from "never captured anything".
    expect(detail.ja4).not.toBeNull();
    expect(result.passed).toBe(false);
    expect(result.message).toMatch(/does NOT match the Chrome-Linux anchors/);
  }, 20_000);
});
