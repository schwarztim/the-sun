/**
 * The Conformance Lab — orchestrates all 9 gates against a generated
 * server directory and writes `lab-report.json`. See CLAUDE plan (Stage 2)
 * for the full rationale; this file just sequences the gates in the
 * plan's numbered order and decides what can run without a live server.
 *
 * Three separate spawns are used by design, not by accident: each gate
 * group needs a DIFFERENT env (normal env; base-URL -> TLS capture;
 * base-URL -> mock HTTP backend), and a generated server reads its base
 * URL once at startup — there is no way to change it on an already-running
 * process, so a fresh spawn per differing env is required, not merely
 * convenient.
 */
import path from "node:path";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { protocolGate, protocolGateFailure, transportGate } from "./gates/connection-gates.js";
import { runCoverageGate } from "./gates/coverage.js";
import { runCredentialScanGate } from "./gates/credential-scan.js";
import { runInstrumentationGate } from "./gates/instrumentation.js";
import { runRateLimiterGate } from "./gates/rate-limiter.js";
import { runToolInvocationGates } from "./gates/tool-invocation.js";
import { runWireFingerprintGate } from "./gates/wire-fingerprint.js";
import { launchAndConnect, readLaunchSpec } from "./harness.js";
import { buildReport, writeReport } from "./report.js";
import type { CoverageManifest, GateFinding, LabReport, LabTransport } from "./types.js";

export interface RunLabOptions {
  serverDir: string;
  targetName?: string;
  /**
   * Reserved for a future live-credential smoke test (THESUN_VERIFY_LIVE=1
   * in the plan). Not implemented in this pass — see
   * gates/tool-invocation.ts's docstring. When set, only stamps the
   * report's `live_acceptance_last_verified` field.
   */
  live?: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

function skippedGate(gate: GateFinding["gate"], reason: string): GateFinding {
  return { gate, passed: false, skipped: true, message: `skipped: ${reason}` };
}

export async function runLab(options: RunLabOptions): Promise<LabReport> {
  const serverDir = path.resolve(options.serverDir);
  const startedAt = nowIso();
  const gates: GateFinding[] = [];

  const spec = await readLaunchSpec(serverDir);
  // Precedence: explicit CLI/API option > lab.launch.json's targetName >
  // the server directory's basename.
  const targetName = options.targetName ?? spec.targetName ?? path.basename(serverDir);
  spec.targetName = targetName;

  // --- Spawn #1: default env — gates 1, 2, 3 ---------------------------
  let tools: Tool[] = [];
  let actualTransport: LabTransport | null = null;
  let firstSpawnError: unknown = null;

  const firstSpawn = await launchAndConnect(serverDir, spec).catch((error: unknown) => {
    firstSpawnError = error;
    return null;
  });

  if (firstSpawn) {
    actualTransport = firstSpawn.actualTransport;
    try {
      const listResult = await firstSpawn.client.listTools();
      tools = listResult.tools;
      gates.push(protocolGate(tools.length)); // gate 1
    } catch (error) {
      gates.push(protocolGateFailure(error)); // gate 1
    } finally {
      await firstSpawn.close();
    }
  } else if (spec.transport === "streamable-http") {
    // The server never opened a streamable-http listener. Before declaring
    // it broken, probe over stdio — a server that's a legitimate MCP
    // endpoint but shipped the wrong transport (the "_stdio" golden fixture
    // scenario) must fail gate 3 (transport) specifically, not gate 1
    // (protocol), so the report can tell "not an MCP server at all" apart
    // from "an MCP server, just not streamable-http."
    const stdioProbe = await launchAndConnect(serverDir, { ...spec, transport: "stdio" }).catch(
      () => null,
    );
    if (stdioProbe) {
      actualTransport = stdioProbe.actualTransport; // "stdio"
      try {
        const listResult = await stdioProbe.client.listTools();
        tools = listResult.tools;
        gates.push(protocolGate(tools.length)); // gate 1 — it IS a valid MCP server
      } catch (error) {
        gates.push(protocolGateFailure(error));
      } finally {
        await stdioProbe.close();
      }
    } else {
      gates.push(protocolGateFailure(firstSpawnError)); // neither transport produced a valid MCP server
    }
  } else {
    gates.push(protocolGateFailure(firstSpawnError));
  }

  // gate 2 — instrumentation (needs live Tool objects; no new spawn)
  if (tools.length > 0) {
    gates.push(runInstrumentationGate(targetName, tools));
  } else {
    gates.push(skippedGate("instrumentation", "no tools available (protocol gate did not succeed)"));
  }

  // gate 3 — transport
  gates.push(transportGate(actualTransport));

  const liveGatesEligible = tools.length > 0 && actualTransport === "streamable-http";

  // --- Spawn #2: base URL -> TLS capture terminus — gate 4 -------------
  if (liveGatesEligible) {
    gates.push(await runWireFingerprintGate(serverDir, spec, tools));
  } else {
    gates.push(
      skippedGate(
        "wire-fingerprint",
        tools.length === 0 ? "no tools available" : `transport is ${actualTransport}, not streamable-http`,
      ),
    );
  }

  // gate 5 — credential scan (pure filesystem check, no live server)
  gates.push(await runCredentialScanGate(serverDir));

  // --- Spawn #3: base URL -> mock HTTP backend — gates 6 & 7 -----------
  let coverage: CoverageManifest | null = null;
  const coverageGate = await runCoverageGate(serverDir); // computed early so gate 7 can use it
  if (coverageGate.passed) {
    coverage = coverageGate.detail as CoverageManifest;
  }

  if (liveGatesEligible) {
    const { callability, precision } = await runToolInvocationGates(serverDir, spec, tools, coverage);
    gates.push(callability, precision);
  } else {
    const reason =
      tools.length === 0 ? "no tools available" : `transport is ${actualTransport}, not streamable-http`;
    gates.push(skippedGate("callability", reason), skippedGate("precision", reason));
  }

  // gate 8 — coverage (pure filesystem check, no live server)
  gates.push(coverageGate);

  // gate 9 — rate-limiter presence (pure filesystem + static-data check)
  gates.push(await runRateLimiterGate(serverDir, targetName));

  const finishedAt = nowIso();
  const report = buildReport({
    target: targetName,
    serverDir,
    startedAt,
    finishedAt,
    transport: actualTransport,
    toolCount: tools.length,
    gates,
    liveAcceptanceLastVerified: options.live ? finishedAt : null,
  });

  await writeReport(serverDir, report);
  return report;
}

export type { GateFinding, LabReport, LabTransport } from "./types.js";
