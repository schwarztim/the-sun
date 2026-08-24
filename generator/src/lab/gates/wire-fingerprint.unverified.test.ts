/**
 * Gate 4 honesty: the two branches that return `passed: true` without ever
 * measuring a TLS fingerprint must say so, so a report reader (and `thesun
 * publish`, which hard-gates on lab-report.json) cannot mistake an unexamined
 * gate for a satisfied one.
 *
 * Both branches return before any server spawn or capture server, so these are
 * pure filesystem tests with no process launched.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LaunchSpec } from "../types.js";
import { runWireFingerprintGate } from "./wire-fingerprint.js";

let tmpDir: string | undefined;

afterEach(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  tmpDir = undefined;
});

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "thesun-lab-wirefp-"));
  tmpDir = dir;
  return dir;
}

const SPEC: LaunchSpec = { transport: "streamable-http" };
// One tool is enough: the branches under test return before the tool is used.
const TOOLS = [{ name: "example_get", inputSchema: { type: "object" as const, properties: {} } }];

describe("runWireFingerprintGate honesty", () => {
  it("reports NOT VERIFIED when the target never declared requiresBrowserTLS", async () => {
    const dir = await makeTmpDir();
    const result = await runWireFingerprintGate(dir, SPEC, TOOLS);
    expect(result.passed).toBe(true);
    expect(result.verified).toBe(false);
    expect(result.message).toMatch(/NOT VERIFIED/);
    // The flag is self-declared in the server's own lab.launch.json, so its
    // absence must not read as evidence about the target.
    expect(result.message).toMatch(/declaration, not evidence/);
  });

  it("reports NOT VERIFIED for a Go server even when it DOES declare requiresBrowserTLS", async () => {
    const dir = await makeTmpDir();
    await fs.writeFile(path.join(dir, "go.mod"), "module example-mcp\n\ngo 1.23\n");
    const result = await runWireFingerprintGate(dir, { ...SPEC, requiresBrowserTLS: true }, TOOLS);
    expect(result.passed).toBe(true);
    expect(result.verified).toBe(false);
    expect(result.message).toMatch(/NOT VERIFIED/);
    // The gate's anchors and self-test hook are Python-only, so a Go server's
    // uTLS handshake is never measured. Saying "unimplemented" out loud is the
    // point: the previous message let this read as a satisfied gate.
    expect(result.message).toMatch(/unimplemented, not passing/);
  });

  it("accepts antiBot as an alias and still reports Go as NOT VERIFIED", async () => {
    const dir = await makeTmpDir();
    await fs.writeFile(path.join(dir, "go.mod"), "module example-mcp\n\ngo 1.23\n");
    const result = await runWireFingerprintGate(dir, { ...SPEC, antiBot: true }, TOOLS);
    expect(result.passed).toBe(true);
    expect(result.verified).toBe(false);
  });
});
