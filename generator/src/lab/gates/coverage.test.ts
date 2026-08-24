import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCoverageGate } from "./coverage.js";

let tmpDir: string | undefined;

afterEach(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  tmpDir = undefined;
});

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "thesun-lab-coverage-"));
  tmpDir = dir;
  return dir;
}

describe("runCoverageGate", () => {
  it("fails with a clear reason when coverage.json is absent", async () => {
    const dir = await makeTmpDir();
    const result = await runCoverageGate(dir);
    expect(result.passed).toBe(false);
    expect(result.message).toMatch(/no coverage\.json manifest found/);
  });

  it("fails on invalid JSON", async () => {
    const dir = await makeTmpDir();
    await fs.writeFile(path.join(dir, "coverage.json"), "{ not json");
    const result = await runCoverageGate(dir);
    expect(result.passed).toBe(false);
    expect(result.message).toMatch(/not valid JSON/);
  });

  it("passes a fully-mapped, justified manifest", async () => {
    const dir = await makeTmpDir();
    await fs.writeFile(
      path.join(dir, "coverage.json"),
      JSON.stringify({
        basis: "spec",
        coverage_pct: 50,
        ops: [
          { path: "/users", method: "GET", tool: "list_users" },
          { path: "/users/{id}/internal-debug", method: "GET", tool: null, justification: "internal debug endpoint, intentionally not exposed" },
        ],
      }),
    );
    const result = await runCoverageGate(dir);
    expect(result.passed).toBe(true);
  });

  it("tolerates a small rounding difference between reported and recomputed coverage_pct", async () => {
    const dir = await makeTmpDir();
    await fs.writeFile(
      path.join(dir, "coverage.json"),
      JSON.stringify({
        basis: "spec",
        coverage_pct: 33, // recomputed 1/3 = 33.33...% -- within the 1-point tolerance
        ops: [
          { path: "/a", method: "GET", tool: "a" },
          { path: "/b", method: "GET", tool: null, justification: "not exposed" },
          { path: "/c", method: "GET", tool: null, justification: "not exposed" },
        ],
      }),
    );
    const result = await runCoverageGate(dir);
    expect(result.passed).toBe(true);
  });

  it("fails when coverage_pct lies about the value recomputed from ops[]", async () => {
    const dir = await makeTmpDir();
    await fs.writeFile(
      path.join(dir, "coverage.json"),
      JSON.stringify({
        basis: "spec",
        coverage_pct: 100, // actual: only 1 of 2 ops maps to a tool (50%)
        ops: [
          { path: "/users", method: "GET", tool: "list_users" },
          { path: "/widgets", method: "GET", tool: null, justification: "internal, not exposed" },
        ],
      }),
    );
    const result = await runCoverageGate(dir);
    expect(result.passed).toBe(false);
    expect(result.message).toMatch(/disagrees with the value recomputed from ops\[\]/);
  });

  it("default-fails on an unjustified null tool mapping", async () => {
    const dir = await makeTmpDir();
    await fs.writeFile(
      path.join(dir, "coverage.json"),
      JSON.stringify({
        basis: "observed",
        coverage_pct: 50,
        ops: [{ path: "/widgets", method: "POST", tool: null }],
      }),
    );
    const result = await runCoverageGate(dir);
    expect(result.passed).toBe(false);
    expect(result.message).toMatch(/no justification/);
    expect(result.message).toMatch(/POST \/widgets/);
  });

  it("rejects an unknown basis value", async () => {
    const dir = await makeTmpDir();
    await fs.writeFile(
      path.join(dir, "coverage.json"),
      JSON.stringify({ basis: "guessed", coverage_pct: 10, ops: [] }),
    );
    const result = await runCoverageGate(dir);
    expect(result.passed).toBe(false);
    expect(result.message).toMatch(/unknown basis/);
  });
});
