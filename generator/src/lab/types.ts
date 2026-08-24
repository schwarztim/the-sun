/**
 * Conformance Lab — shared types
 *
 * The Lab is a protocol-level verifier: it spawns a generated MCP server,
 * talks real MCP protocol to it, and asserts every standard on the WIRE
 * (never on Python-side objects). See docs/plans (Stage 2) for the full
 * gate list and rationale.
 */

/** Transport actually observed when the Lab connected to a server. */
export type LabTransport = "streamable-http" | "stdio";

/** The 9 gates run by the Lab, in the order the plan specifies. */
export type GateName =
  | "protocol"
  | "instrumentation"
  | "transport"
  | "wire-fingerprint"
  | "credential-scan"
  | "callability"
  | "precision"
  | "coverage"
  | "rate-limiter";

/** Per-gate outcome. `detail` carries gate-specific structured evidence. */
export interface GateFinding {
  gate: GateName;
  passed: boolean;
  /** Human-readable summary; always present, even on pass. */
  message: string;
  /** Set when the gate could not run at all (vs. ran and failed). */
  skipped?: boolean;
  /**
   * Whether this gate actually PROVED the property it is named for.
   *
   * `passed: true` alone is ambiguous: several gates return a pass without
   * verifying anything, either because the property was not required for the
   * target (wire-fingerprint on a non-anti-bot API) or because the check is a
   * presence heuristic rather than a behavioral one (rate-limiter greps for a
   * limiter import; it cannot tell a wired limiter from an unused one). Those
   * gates set `verified: false` so a report reader can tell a satisfied gate
   * apart from an unexamined one.
   *
   * Absent means the gate's verdict is a real verification, so existing gates
   * that genuinely prove their property need no change. This field is
   * informational: it does NOT feed the report's aggregate `passed` (see
   * report.ts), which keeps its original every-gate-passed semantics.
   */
  verified?: boolean;
  detail?: unknown;
}

/**
 * Launch descriptor for a server directory. The Lab reads
 * `<serverDir>/lab.launch.json` when present; every field has a sane
 * FastMCP-shaped default (see DEFAULT_LAUNCH_SPEC in harness.ts) so a
 * server directory need not carry this file at all if it follows the
 * defaults (streamable-http, `python3 server.py`, PORT/HOST env vars).
 */
export interface LaunchSpec {
  transport: LabTransport;
  /** Executable to spawn. Default: "python3". */
  command?: string;
  /** Args passed to `command`. "{port}"/"{host}" are substituted if present. Default: ["server.py"]. */
  args?: string[];
  /** Extra static env vars merged in before Lab-injected overrides. */
  env?: Record<string, string>;
  /** Env var the Lab uses to hand the server its assigned port (streamable-http only). Default: "PORT". */
  portEnvVar?: string;
  /** Env var the Lab uses to hand the server its bind host (streamable-http only). Default: "HOST". */
  hostEnvVar?: string;
  /** HTTP path the streamable-http endpoint is served at. Default: "/mcp". */
  mcpPath?: string;
  /** Logical target/tool name (defaults to the server directory's basename). */
  targetName?: string;
  /**
   * Env var the generated server reads for its upstream API base URL — the
   * var the Lab overrides to route egress at its own capture/mock backends.
   * Defaults to `${TARGET_NAME_UPPER}_BASE_URL`, matching the convention in
   * src/generator/config-abstraction.ts (`generateConfigItems`).
   */
  targetBaseUrlEnvVar?: string;
  /**
   * Explicit acknowledgment that this fixture is a legacy stdio server the
   * Lab is expected to correctly FAIL at gate 3 (transport). Purely
   * documentation for report readers — does not change gate 3's verdict.
   */
  allowStdio?: boolean;
  /**
   * Per-target capability flag (mirrors GoServerConfig.requiresBrowserTLS,
   * written into lab.launch.json by the generator). When true, the target
   * performs anti-bot / JA4 fingerprinting on the MCP's outbound calls, so
   * the wire-fingerprint gate is REQUIRED. When false/absent (the common
   * REST-API case), that gate is informational-pass.
   */
  requiresBrowserTLS?: boolean;
  /**
   * Accepted alias for `requiresBrowserTLS` — some spec sources hint the
   * anti-bot capability under this name. Treated identically by the
   * wire-fingerprint gate.
   */
  antiBot?: boolean;
}

/** One entry from a generated server's coverage.json manifest. */
export interface CoverageOp {
  path: string;
  method: string;
  tool: string | null;
  justification?: string;
}

/** Schema for `<serverDir>/coverage.json`, produced by the detection agent (Stage 5). */
export interface CoverageManifest {
  basis: "spec" | "observed" | "observed-only";
  coverage_pct: number;
  ops: CoverageOp[];
}

/** Full report written to `<serverDir>/lab-report.json`. */
export interface LabReport {
  target: string;
  serverDir: string;
  startedAt: string;
  finishedAt: string;
  passed: boolean;
  transport: LabTransport | null;
  toolCount: number;
  gates: GateFinding[];
  /**
   * Explicit enumeration of what a PASS does NOT mean. A Lab PASS is
   * necessary, not sufficient, for real-target acceptance — this field is
   * how the report communicates that honestly (see plan's "Honest framing").
   */
  residualUnverifiedSurface: string[];
  /**
   * Names of gates that passed WITHOUT proving their property (every gate whose
   * finding carries `verified: false`). `passed: true` with a non-empty
   * `unverifiedGates` means: nothing failed, but these properties were never
   * actually demonstrated. Empty on a run where every passing gate verified.
   */
  unverifiedGates: GateName[];
  /** Subordinate field: when live (credentialed) acceptance was last verified for this target, if ever. */
  live_acceptance_last_verified: string | null;
}
