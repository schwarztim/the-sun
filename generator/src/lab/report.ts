/**
 * Builds and writes `lab-report.json`.
 *
 * Per the plan: the report must ENUMERATE the residual-unverified surface
 * (semantic correctness, write surface, live WAF acceptance, auth scopes)
 * so a PASS is never read as "this server is fully correct" — only
 * "structurally valid, alive, and correctly fingerprinted."
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { GateFinding, GateName, LabReport, LabTransport } from "./types.js";

const RESIDUAL_UNVERIFIED_SURFACE = [
  "semantic correctness of tool behavior (the Lab checks shape/protocol, not business logic)",
  "write-path safety beyond destructiveHint/idempotentHint annotation presence",
  "live WAF/anti-bot acceptance at the real target — the wire-fingerprint gate is necessary, not sufficient, for real-target acceptance",
  "auth scopes / permission boundaries granted by the operator's captured session",
];

/**
 * Gates that passed but explicitly did not prove their property. Only a
 * passing gate can be "unverified": a failing gate is already loud, and a
 * skipped gate carries `passed: false` (see index.ts's skippedGate).
 */
function unverifiedGateNames(gates: GateFinding[]): GateName[] {
  return gates.filter((g) => g.passed && g.verified === false).map((g) => g.gate);
}

export function buildReport(params: {
  target: string;
  serverDir: string;
  startedAt: string;
  finishedAt: string;
  transport: LabTransport | null;
  toolCount: number;
  gates: GateFinding[];
  liveAcceptanceLastVerified: string | null;
}): LabReport {
  return {
    target: params.target,
    serverDir: params.serverDir,
    startedAt: params.startedAt,
    finishedAt: params.finishedAt,
    // Unchanged semantics: a gate marked `verified: false` still counts as
    // passing here. Recording it is an honesty measure for report readers, not
    // a new failure mode.
    passed: params.gates.every((g) => g.passed),
    transport: params.transport,
    toolCount: params.toolCount,
    gates: params.gates,
    residualUnverifiedSurface: RESIDUAL_UNVERIFIED_SURFACE,
    unverifiedGates: unverifiedGateNames(params.gates),
    live_acceptance_last_verified: params.liveAcceptanceLastVerified,
  };
}

export async function writeReport(serverDir: string, report: LabReport): Promise<string> {
  const reportPath = path.join(serverDir, "lab-report.json");
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf-8");
  return reportPath;
}
