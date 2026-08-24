/**
 * GW-1: tiny in-process metrics registry for the gateway.
 *
 * Zero dependencies, zero blocking IO: just a Map of monotonically increasing
 * counters plus a Prometheus text-format renderer. Gauges (values that go up
 * and down, e.g. connected-backend counts) are NOT stored here; they are
 * point-in-time facts the caller samples at scrape time and passes into
 * renderPrometheus, so the registry never holds stale state.
 *
 * Output is deliberately value-free of any secret: metric names and integer
 * counts only. The /metrics endpoint that renders this is loopback and
 * unauthenticated (like /healthz), so nothing sensitive may ever appear here.
 */

/**
 * Canonical counter names (Prometheus convention: snake_case, `_total` suffix
 * for monotonic counters). Referenced by the gateway at each increment site so
 * a rename is a single-source change.
 */
export const COUNTERS = {
  toolCalls: "thesun_gateway_tool_calls_total",
  tierA: "thesun_gateway_tier_a_calls_total",
  tierB: "thesun_gateway_tier_b_calls_total",
  denies: "thesun_gateway_denies_total",
  approvalsParked: "thesun_gateway_approvals_parked_total",
  /**
   * Mux facade tool invocations (gateway_search_tools, gateway_call_tool, and
   * the rest). Counted SEPARATELY from toolCalls, which only ever counted
   * backend dispatches inside dispatchToolCall. Reading a zero toolCalls as
   * "no client activity" is exactly the wrong inference that sent a crash
   * investigation down the wrong path for hours: facade calls never cross that
   * counter. This one makes client activity visible on its own.
   */
  facadeCalls: "thesun_gateway_facade_calls_total",
  /**
   * Embedder invocations issued for semantic tool search, and tools embedded.
   * These are the STAB-4 blast radius made observable: a spike here is a full
   * re-embed of the tool set, which is the expensive, memory-hungry path.
   * Counters rather than a log line on purpose: the production gateway runs at
   * log level "warn" (capped after a 1 GB log incident), so an info line is
   * invisible where it matters most. Counters are level-independent.
   */
  embedBatches: "thesun_gateway_embed_batches_total",
  embedTools: "thesun_gateway_embed_tools_total",
  /**
   * Fleet-ingested backends removed because they vanished from the inventory.
   * Counted so a pruning storm (a bad inventory read wiping the fleet) is
   * VISIBLE rather than inferred from backends quietly disappearing.
   */
  backendsPruned: "thesun_gateway_backends_pruned_total",
} as const;

/** Gauge names sampled at scrape time (backend connectivity). */
export const GAUGES = {
  backendsConnected: "thesun_gateway_backends_connected",
  backendsTotal: "thesun_gateway_backends_total",
  backendsStarting: "thesun_gateway_backends_starting",
  backendsRetrying: "thesun_gateway_backends_retrying",
  backendsAbandoned: "thesun_gateway_backends_abandoned",
  backendsDisabled: "thesun_gateway_backends_disabled",
} as const;

const COUNTER_HELP: Record<string, string> = {
  [COUNTERS.toolCalls]: "Total tool-call dispatches handled by the gateway.",
  [COUNTERS.tierA]: "Tool calls routed through the Tier-A (model self-confirm) path.",
  [COUNTERS.tierB]: "Tool calls routed through the Tier-B (out-of-band human approval) path.",
  [COUNTERS.denies]: "Tool calls denied by the gateway (Tier-A block or content-guard block).",
  [COUNTERS.approvalsParked]: "Distinct Tier-B calls parked pending human approval.",
  [COUNTERS.facadeCalls]:
    "Mux facade tool invocations (gateway_search_tools, gateway_call_tool, and friends). Not counted by tool_calls_total.",
  [COUNTERS.embedBatches]: "Embedder calls issued for semantic tool search.",
  [COUNTERS.embedTools]: "Tools embedded for semantic tool search.",
  [COUNTERS.backendsPruned]:
    "Fleet-ingested backends removed after vanishing from the fleet inventory.",
};

const GAUGE_HELP: Record<string, string> = {
  [GAUGES.backendsConnected]: "Backends currently in the connected state.",
  [GAUGES.backendsTotal]: "Total known/configured backends.",
  [GAUGES.backendsStarting]: "Backends currently attempting their first connection.",
  [GAUGES.backendsRetrying]:
    "Backends not connected that the health monitor will keep retrying.",
  [GAUGES.backendsAbandoned]:
    "Backends not connected that the health monitor has given up on (restart budget exhausted or restart_policy=never).",
  [GAUGES.backendsDisabled]: "Backends configured with enabled=false.",
};

/**
 * Point-in-time gauge values supplied by the caller at scrape time.
 *
 * backendsConnected and backendsTotal are required and keep their original
 * meaning. The status breakdown is optional so existing callers (and tests)
 * that supply only the original pair still type-check; missing values render
 * as 0, which keeps the emitted series set stable from the first scrape.
 */
export interface GaugeSample {
  backendsConnected: number;
  backendsTotal: number;
  backendsStarting?: number;
  backendsRetrying?: number;
  backendsAbandoned?: number;
  backendsDisabled?: number;
}

export class Metrics {
  private readonly counters: Map<string, number> = new Map();

  constructor() {
    // Pre-register every counter at 0 so /metrics emits a stable series set
    // from the first scrape (Prometheus best practice: no missing-until-first-
    // event series).
    for (const name of Object.values(COUNTERS)) this.counters.set(name, 0);
  }

  /** Increment a counter by `by` (default 1). Unknown names are created lazily. */
  inc(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  /** Current value of a counter (0 if never incremented). */
  get(name: string): number {
    return this.counters.get(name) ?? 0;
  }

  /**
   * Render the full registry as Prometheus text-exposition format. Counters
   * come from this instance; gauges are the caller-supplied snapshot. Cheap:
   * pure in-memory string building, no IO.
   */
  renderPrometheus(gauges: GaugeSample): string {
    const lines: string[] = [];

    for (const [name, value] of this.counters) {
      const help = COUNTER_HELP[name];
      if (help) lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} counter`);
      lines.push(`${name} ${value}`);
    }

    const gaugeValues: Record<string, number> = {
      [GAUGES.backendsConnected]: gauges.backendsConnected,
      [GAUGES.backendsTotal]: gauges.backendsTotal,
      [GAUGES.backendsStarting]: gauges.backendsStarting ?? 0,
      [GAUGES.backendsRetrying]: gauges.backendsRetrying ?? 0,
      [GAUGES.backendsAbandoned]: gauges.backendsAbandoned ?? 0,
      [GAUGES.backendsDisabled]: gauges.backendsDisabled ?? 0,
    };
    for (const [name, value] of Object.entries(gaugeValues)) {
      const help = GAUGE_HELP[name];
      if (help) lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} gauge`);
      lines.push(`${name} ${value}`);
    }

    return lines.join("\n") + "\n";
  }
}
