/**
 * Proves AdaptiveRateLimiter.acquire() (ratelimit.py) releases its
 * concurrency-semaphore permit when a per-window acquire raises/is cancelled
 * mid-wait, instead of leaking it. Before this fix, a client timeout or
 * disconnect (asyncio.CancelledError) while waiting on a window would leave
 * the semaphore permit taken forever -- available concurrency shrinks
 * monotonically until every generated server (this file is copied into
 * every one of them) deadlocks.
 *
 * Shells out to a real Python interpreter (same convention as
 * ../../lab/gates/wire-fingerprint.selftest.test.ts) since the behavior
 * under test only exists at the asyncio runtime level. Only needs
 * ratelimit.py's own deps (aiolimiter, tenacity) -- no fastmcp/curl_cffi/mcp
 * required, so this is much more likely to find a usable interpreter than
 * the golden-fixture tests.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELFTEST_SCRIPT = path.join(HERE, "ratelimit.selftest.py");
// Opportunistic-only: the Stage-0 spike venv is machine-local build output
// (never committed), not a portability dependency -- just a candidate this
// happens to have the right deps installed already, on this machine (see
// gates/wire-fingerprint.selftest.test.ts for the identical convention).
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

function resolvePythonWithDeps(): string | null {
  const candidates = [process.env.THESUN_LAB_TEST_PYTHON, SPIKE_VENV_PYTHON, "python3"].filter(
    (c): c is string => Boolean(c),
  );
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ["-c", "import aiolimiter, tenacity"], { stdio: "ignore" });
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

describe("AdaptiveRateLimiter.acquire() — permit release on cancellation", () => {
  it("releases the concurrency semaphore permit when a per-window acquire is cancelled", () => {
    const python = resolvePythonWithDeps();
    if (!python) {
      console.warn(
        "SKIPPED: no Python interpreter with aiolimiter/tenacity found — " +
          "set THESUN_LAB_TEST_PYTHON to run this test.",
      );
      return;
    }
    const output = execFileSync(python, [SELFTEST_SCRIPT], { encoding: "utf-8" });
    expect(output).toMatch(/PASS/);
  }, 10_000);
});
