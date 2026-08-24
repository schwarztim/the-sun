/**
 * Confirms Gate 4 (wire-fingerprint) is correctly wired to the
 * `maybe_fingerprint_selftest()` contract in
 * src/templates/python/http_client.py: a real Python/FastMCP server that
 * calls the hook at startup gets its JA4 captured with NO tool-invocation
 * fallback needed (mechanism === "self-test"), and the JA4 matches the
 * Chrome-Linux anchors read live from the same template file.
 *
 * Needs a Python interpreter with fastmcp/curl_cffi/httpx/mcp installed
 * (same deps as test-fixtures/golden-servers/pyproject.toml). Skips
 * gracefully everywhere else — set THESUN_LAB_TEST_PYTHON to point at a
 * suitable interpreter to force it to run.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { launchAndConnect, readLaunchSpec } from "../harness.js";
import { runWireFingerprintGate } from "./wire-fingerprint.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELFTEST_FIXTURE_DIR = path.join(HERE, "..", "__fixtures__", "selftest");
// Opportunistic-only: the Stage-0 spike venv is machine-local build output
// (never committed), not a portability dependency — just a candidate this
// happens to have the right deps installed already, on this machine.
const SPIKE_VENV_PYTHON = path.join(
  HERE,
  "..",
  "..",
  "..",
  "test-fixtures",
  "spike",
  ".venv",
  "bin",
  "python3",
);

async function resolvePythonWithDeps(): Promise<string | null> {
  const candidates = [process.env.THESUN_LAB_TEST_PYTHON, SPIKE_VENV_PYTHON, "python3"].filter(
    (c): c is string => Boolean(c),
  );
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ["-c", "import fastmcp, curl_cffi, httpx, mcp"], {
        stdio: "ignore",
      });
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

describe("Gate 4 — self-test hook wiring (real Python/FastMCP)", () => {
  it("captures JA4 via maybe_fingerprint_selftest() with no tool-invocation fallback needed", async () => {
    const python = await resolvePythonWithDeps();
    if (!python) {
      console.warn(
        "SKIPPED: no Python interpreter with fastmcp/curl_cffi/httpx/mcp found — " +
          "set THESUN_LAB_TEST_PYTHON to run this test.",
      );
      return;
    }

    const spec = await readLaunchSpec(SELFTEST_FIXTURE_DIR);
    spec.command = python; // override the descriptor's bare "python3" with a resolved interpreter

    // Need real Tool objects to invoke the gate (tools[0] is only used by
    // the tool-invocation FALLBACK path — this fixture's self-test should
    // fire before that's ever needed).
    const probe = await launchAndConnect(SELFTEST_FIXTURE_DIR, spec);
    let tools;
    try {
      tools = (await probe.client.listTools()).tools;
    } finally {
      await probe.close();
    }
    expect(tools.length).toBeGreaterThan(0);

    const result = await runWireFingerprintGate(SELFTEST_FIXTURE_DIR, spec, tools);

    expect((result.detail as { mechanism: string }).mechanism).toBe("self-test");
    expect(result.passed).toBe(true);
    expect(result.message).toMatch(/matches the Chrome-Linux anchors/);
    expect(result.message).toMatch(/\[via self-test\]/);
  }, 30_000);
});
