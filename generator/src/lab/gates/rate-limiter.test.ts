import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runRateLimiterGate } from "./rate-limiter.js";

let tmpDir: string | undefined;

afterEach(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  tmpDir = undefined;
});

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "thesun-lab-ratelimit-"));
  tmpDir = dir;
  return dir;
}

describe("runRateLimiterGate", () => {
  it("is an informational pass for a target absent from KNOWN_PATTERNS, reported as NOT VERIFIED", async () => {
    const dir = await makeTmpDir();
    const result = await runRateLimiterGate(dir, "totally-unknown-service-xyz");
    expect(result.passed).toBe(true);
    expect(result.verified).toBe(false);
    expect(result.message).toMatch(/NOT VERIFIED/);
    expect(result.message).toMatch(/not in KNOWN_PATTERNS/);
  });

  it("marks even the affirmative marker-found pass as NOT VERIFIED (presence, not behavior)", async () => {
    const dir = await makeTmpDir();
    await fs.writeFile(path.join(dir, "main.go"), 'import "golang.org/x/time/rate"\n');
    const result = await runRateLimiterGate(dir, "github");
    expect(result.passed).toBe(true);
    // Finding the import proves nothing about whether the limiter is wired into
    // the request path, so the gate must not claim verification.
    expect(result.verified).toBe(false);
    expect(result.message).toMatch(/NOT VERIFIED \(presence check only\)/);
  });

  it("fails when a known-rate-limited target ships with no limiter", async () => {
    const dir = await makeTmpDir();
    await fs.writeFile(path.join(dir, "server.py"), "# no rate limiting here\n");
    const result = await runRateLimiterGate(dir, "github"); // github is in KNOWN_PATTERNS with hasRateLimiting:true
    expect(result.passed).toBe(false);
    expect(result.message).toMatch(/known-rate-limited/);
  });

  it("passes when a known-rate-limited target ships the ratelimit.py template", async () => {
    const dir = await makeTmpDir();
    await fs.writeFile(path.join(dir, "ratelimit.py"), "# copied template\n");
    const result = await runRateLimiterGate(dir, "github");
    expect(result.passed).toBe(true);
  });

  it("passes when a known-rate-limited target's own code imports aiolimiter", async () => {
    const dir = await makeTmpDir();
    await fs.writeFile(path.join(dir, "server.py"), "import aiolimiter\n");
    const result = await runRateLimiterGate(dir, "stripe"); // stripe is also KNOWN_PATTERNS rate-limited
    expect(result.passed).toBe(true);
  });
});
