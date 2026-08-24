/**
 * Gates 1 (protocol) and 3 (transport) — both derive directly from the
 * harness's own connect result, so they live together rather than each
 * re-deriving connection state.
 */
import type { GateFinding, LabTransport } from "../types.js";

export function protocolGate(toolCount: number): GateFinding {
  return {
    gate: "protocol",
    passed: true,
    message: `connect -> initialize -> listTools() succeeded (${toolCount} tool(s))`,
  };
}

export function protocolGateFailure(error: unknown): GateFinding {
  return {
    gate: "protocol",
    passed: false,
    message: `connect -> initialize -> listTools() failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  };
}

/**
 * A shipped generated server must be streamable-http-only (Locked
 * direction #1) — this gate exists specifically to FAIL stdio output, so
 * there is no "allow stdio" branch here, including for the Lab's own
 * legacy stdio fixtures (that's the whole point of running the Lab
 * against them: prove it correctly fails them).
 */
export function transportGate(actual: LabTransport | null): GateFinding {
  if (actual === null) {
    return {
      gate: "transport",
      passed: false,
      skipped: true,
      message: "no transport connected at all — see the protocol gate failure",
    };
  }
  const passed = actual === "streamable-http";
  return {
    gate: "transport",
    passed,
    message: passed
      ? "server is reachable over streamable-http"
      : `server only responded over ${actual} — a shipped generated server must be streamable-http-only`,
  };
}
