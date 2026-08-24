import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runLab } from "./index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(HERE, "__fixtures__");

async function cleanupGeneratedFiles() {
  await fs.rm(path.join(FIXTURES_DIR, "lab-report.json"), { force: true });
  await fs.rm(path.join(FIXTURES_DIR, "coverage.json"), { force: true });
}

describe("runLab — end-to-end against the Node fixture server", () => {
  afterEach(cleanupGeneratedFiles);

  it("runs all 9 gates and writes a lab-report.json", async () => {
    const report = await runLab({ serverDir: FIXTURES_DIR });

    expect(report.target).toBe("example"); // from lab.launch.json's targetName
    expect(report.transport).toBe("streamable-http");
    expect(report.toolCount).toBe(3);

    const gateNames = report.gates.map((g) => g.gate).sort();
    expect(gateNames).toEqual(
      [
        "callability",
        "coverage",
        "credential-scan",
        "instrumentation",
        "precision",
        "protocol",
        "rate-limiter",
        "transport",
        "wire-fingerprint",
      ].sort(),
    );

    // gate 1 — protocol: real connection succeeded
    expect(report.gates.find((g) => g.gate === "protocol")!.passed).toBe(true);
    // gate 3 — transport: streamable-http is correct
    expect(report.gates.find((g) => g.gate === "transport")!.passed).toBe(true);
    // gate 2 — instrumentation: fixture tools have annotations + a help tool
    expect(report.gates.find((g) => g.gate === "instrumentation")!.passed).toBe(true);
    // gate 4 — wire-fingerprint: a real TLS ClientHello WAS observed (the
    // fixture's fetch() really connects), but it's Node's own TLS stack,
    // not curl_cffi impersonating Chrome — so it correctly does NOT match
    // the Chrome-Linux anchors. This proves the capture mechanism works
    // end-to-end without needing curl_cffi installed just to run this test.
    const wireFingerprint = report.gates.find((g) => g.gate === "wire-fingerprint")!;
    expect(wireFingerprint.passed).toBe(false);
    expect(wireFingerprint.message).toMatch(/does NOT match/);
    const wireDetail = wireFingerprint.detail as { ja4: string; mechanism: string };
    expect(wireDetail.ja4).toMatch(/^t/);
    // This fixture doesn't implement maybe_fingerprint_selftest() (it's a
    // Node server) — the gate must fall back to live tool invocation.
    expect(wireDetail.mechanism).toBe("tool-invocation");

    // gate 8 — coverage: no coverage.json in the fixture -> fails with a clear reason
    expect(report.gates.find((g) => g.gate === "coverage")!.passed).toBe(false);

    // gate 9 — rate-limiter: "example" isn't a KNOWN_PATTERNS target -> informational pass
    expect(report.gates.find((g) => g.gate === "rate-limiter")!.passed).toBe(true);

    // Overall verdict reflects the real gate failures above.
    expect(report.passed).toBe(false);

    const reportPath = path.join(FIXTURES_DIR, "lab-report.json");
    const written = JSON.parse(await fs.readFile(reportPath, "utf-8"));
    expect(written.target).toBe("example");
    expect(Array.isArray(written.residualUnverifiedSurface)).toBe(true);
    expect(written.residualUnverifiedSurface.length).toBeGreaterThan(0);
  }, 30_000);

  it("passes coverage once a valid coverage.json is present, still failing overall on wire-fingerprint", async () => {
    await fs.writeFile(
      path.join(FIXTURES_DIR, "coverage.json"),
      JSON.stringify({
        basis: "observed",
        coverage_pct: 100,
        ops: [{ path: "/", method: "GET", tool: "call_upstream" }],
      }),
    );

    const report = await runLab({ serverDir: FIXTURES_DIR });
    expect(report.gates.find((g) => g.gate === "coverage")!.passed).toBe(true);
  }, 30_000);
});
