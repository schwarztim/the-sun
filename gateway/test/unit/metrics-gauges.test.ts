/**
 * metrics-gauges.test.ts (STAB-3) — the backend status breakdown gauges.
 *
 * /healthz and /metrics used to report a bare connected/total pair, which made
 * a gap like "17 of 37 connected" unreadable: it could not say whether the 20
 * missing backends were still being retried, given up on, or deliberately
 * disabled. The breakdown is ADDITIVE: the two original series keep their names
 * and meaning so existing consumers are unaffected.
 */
import { describe, expect, it } from "vitest";
import { COUNTERS, GAUGES, Metrics } from "../../src/metrics.js";

function seriesValue(text: string, name: string): number | undefined {
  for (const line of text.split("\n")) {
    if (line.startsWith("#")) continue;
    const [seriesName, raw] = line.split(" ");
    if (seriesName === name) return Number(raw);
  }
  return undefined;
}

describe("Metrics.renderPrometheus backend gauges (STAB-3)", () => {
  it("emits every status gauge with the supplied values", () => {
    const m = new Metrics();
    const out = m.renderPrometheus({
      backendsConnected: 17,
      backendsTotal: 37,
      backendsStarting: 0,
      backendsRetrying: 16,
      backendsAbandoned: 4,
      backendsDisabled: 0,
    });

    expect(seriesValue(out, GAUGES.backendsConnected)).toBe(17);
    expect(seriesValue(out, GAUGES.backendsTotal)).toBe(37);
    expect(seriesValue(out, GAUGES.backendsStarting)).toBe(0);
    expect(seriesValue(out, GAUGES.backendsRetrying)).toBe(16);
    expect(seriesValue(out, GAUGES.backendsAbandoned)).toBe(4);
    expect(seriesValue(out, GAUGES.backendsDisabled)).toBe(0);
  });

  it("declares each new gauge with a TYPE and HELP line", () => {
    const m = new Metrics();
    const out = m.renderPrometheus({ backendsConnected: 1, backendsTotal: 1 });

    for (const name of [
      GAUGES.backendsStarting,
      GAUGES.backendsRetrying,
      GAUGES.backendsAbandoned,
      GAUGES.backendsDisabled,
    ]) {
      expect(out).toContain(`# TYPE ${name} gauge`);
      expect(out).toContain(`# HELP ${name} `);
    }
  });

  it("keeps the original two gauges unchanged for existing consumers", () => {
    // Backward compatibility: a caller that supplies only the original pair
    // still renders, and those two series keep their exact names and values.
    const m = new Metrics();
    const out = m.renderPrometheus({ backendsConnected: 3, backendsTotal: 5 });

    expect(out).toContain(`${GAUGES.backendsConnected} 3`);
    expect(out).toContain(`${GAUGES.backendsTotal} 5`);
    // Omitted breakdown renders as 0 rather than vanishing, so the emitted
    // series set stays stable from the first scrape.
    expect(seriesValue(out, GAUGES.backendsRetrying)).toBe(0);
    expect(seriesValue(out, GAUGES.backendsAbandoned)).toBe(0);
  });

  it("exposes the facade and embed counters, pre-registered at zero", () => {
    // tool_calls_total counts only backend dispatches inside dispatchToolCall;
    // mux facade tools never cross it, so reading a zero there as "no client
    // activity" is wrong. These counters close that gap and must be present
    // from the first scrape, not appear only after the first event.
    const out = new Metrics().renderPrometheus({ backendsConnected: 0, backendsTotal: 0 });
    expect(seriesValue(out, COUNTERS.facadeCalls)).toBe(0);
    expect(seriesValue(out, COUNTERS.embedBatches)).toBe(0);
    expect(seriesValue(out, COUNTERS.embedTools)).toBe(0);
    for (const name of [COUNTERS.facadeCalls, COUNTERS.embedBatches, COUNTERS.embedTools]) {
      expect(out).toContain(`# HELP ${name} `);
      expect(out).toContain(`# TYPE ${name} counter`);
    }
  });

  it("counts facade and embed work independently of tool_calls_total", () => {
    const m = new Metrics();
    // A search that re-embeds: one facade call, embed work, zero dispatches.
    m.inc(COUNTERS.facadeCalls);
    m.inc(COUNTERS.embedBatches, 22);
    m.inc(COUNTERS.embedTools, 341);
    const out = m.renderPrometheus({ backendsConnected: 0, backendsTotal: 0 });

    expect(seriesValue(out, COUNTERS.facadeCalls)).toBe(1);
    expect(seriesValue(out, COUNTERS.embedBatches)).toBe(22);
    expect(seriesValue(out, COUNTERS.embedTools)).toBe(341);
    // The whole point: activity is visible even though nothing was dispatched.
    expect(seriesValue(out, COUNTERS.toolCalls)).toBe(0);
  });

  it("still emits the counter series alongside the gauges", () => {
    const m = new Metrics();
    m.inc(COUNTERS.toolCalls, 2);
    const out = m.renderPrometheus({ backendsConnected: 0, backendsTotal: 0 });

    expect(seriesValue(out, COUNTERS.toolCalls)).toBe(2);
    expect(out).toContain(`# TYPE ${COUNTERS.toolCalls} counter`);
  });
});
