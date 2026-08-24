import { describe, it, expect } from "vitest";
import { buildFleetMcpuConfig } from "../../src/fleet-mcpu-config.js";
import type { FleetEntry, FleetInventory } from "../../src/fleet-inventory.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const BASE_PATHS: FleetInventory["paths"] = {
  appSupportDir: "/tmp/test",
  runconfigsDir: "/tmp/test/runconfigs",
  statusesDir: "/tmp/test/statuses",
  mcpuGeneratedConfig: "/tmp/test/mcpu-generated.json",
};

const EMPTY_SUMMARY: FleetInventory["summary"] = {
  total: 0,
  byHealth: { available: 0, degraded: 0, unavailable: 0, unknown: 0 },
  toolhiveStatuses: {},
  dockerStates: {},
  exposedInMcpu: 0,
  withRunConfig: 0,
  withStatusFile: 0,
  withDockerContainer: 0,
  safeAutomaticRepairHints: 0,
};

function makeInventory(entries: FleetEntry[]): FleetInventory {
  return {
    generatedAt: "2026-05-11T00:00:00.000Z",
    source: "toolhive",
    paths: BASE_PATHS,
    probeEnabled: false,
    dockerPsEnabled: false,
    summary: { ...EMPTY_SUMMARY, total: entries.length },
    entries,
    errors: [],
  };
}

function makeEntry(
  name: string,
  port: number,
  proxyMode: "sse" | "http" | undefined,
  health: FleetEntry["health"] = "available"
): FleetEntry {
  return {
    name,
    health,
    reasons: [],
    runConfig: {
      path: `/tmp/runconfigs/${name}.json`,
      image: `mcp/${name}:latest`,
      port,
      host: "127.0.0.1",
      proxyMode,
      envKeys: [],
      secretRefs: [],
    },
    mcpu: { exposed: true },
    endpoint: { checked: false },
    repairHints: [],
  };
}

// ─── Transport type mapping ────────────────────────────────────────────────────

describe("buildFleetMcpuConfig — transport type and URL mapping", () => {
  it("generates type=sse and /sse path for SSE proxy backends", () => {
    const report = buildFleetMcpuConfig(makeInventory([makeEntry("github", 8081, "sse")]));
    expect(report.config["github"]).toEqual({
      type: "sse",
      url: "http://127.0.0.1:8081/sse",
      description: expect.stringContaining("mcp/github:latest"),
    });
  });

  it("generates type=streamable-http and /mcp path for non-SSE backends", () => {
    const report = buildFleetMcpuConfig(makeInventory([makeEntry("atlassian", 8080, "http")]));
    expect(report.config["atlassian"]).toEqual({
      type: "streamable-http",
      url: "http://127.0.0.1:8080/mcp",
      description: expect.stringContaining("mcp/atlassian:latest"),
    });
  });

  it("generates type=streamable-http for backends with no proxyMode (defaults to http)", () => {
    const report = buildFleetMcpuConfig(makeInventory([makeEntry("unknown-transport", 8082, undefined)]));
    expect(report.config["unknown-transport"].type).toBe("streamable-http");
    expect(report.config["unknown-transport"].url).toMatch(/\/mcp$/);
  });

  // MCPU transport compatibility note:
  // `gateway_mcpu_config` generates type="streamable-http" entries pointing to /mcp.
  // `mcpu call` was observed returning SSE 405 against this endpoint during initial
  // investigation. The /mcp endpoint is streamable-HTTP (POST-only JSON-RPC); the /sse
  // endpoint handles GET+SSE connections. If `mcpu call` ignores `type` and always
  // attempts SSE, use the workaround: direct JSON-RPC POST to http://host:port/mcp.
  // Tracked as: gateway argument forwarding job 147dee6f (lane-D-transport-doc).
  it("documents: streamable-http type points to /mcp (not /sse) — MCPU must use POST JSON-RPC", () => {
    const report = buildFleetMcpuConfig(makeInventory([makeEntry("atlassian", 8080, "http")]));
    const entry = report.config["atlassian"];
    expect(entry.type).toBe("streamable-http");
    expect(entry.url).toMatch(/\/mcp$/);
    expect(entry.url).not.toMatch(/\/sse$/);
  });
});

// ─── Summary and filtering ────────────────────────────────────────────────────

describe("buildFleetMcpuConfig — summary counts", () => {
  it("returns empty config and zero counts for empty inventory", () => {
    const report = buildFleetMcpuConfig(makeInventory([]));
    expect(report.config).toEqual({});
    expect(report.summary.totalCatalogEntries).toBe(0);
    expect(report.summary.included).toBe(0);
    expect(report.summary.omitted).toBe(0);
  });

  it("omits entries that have no runConfig", () => {
    const entry: FleetEntry = {
      name: "no-config",
      health: "unavailable",
      reasons: ["run config missing"],
      runConfig: undefined,
      mcpu: { exposed: false },
      endpoint: { checked: false },
      repairHints: [],
    };
    const report = buildFleetMcpuConfig(makeInventory([entry]));
    expect(report.config).not.toHaveProperty("no-config");
    expect(report.summary.omitted).toBe(1);
    expect(report.summary.included).toBe(0);
  });

  it("omits entries with no port (port=0)", () => {
    const entry = makeEntry("no-port", 0, "http");
    const report = buildFleetMcpuConfig(makeInventory([entry]));
    expect(report.config).not.toHaveProperty("no-port");
    expect(report.summary.omitted).toBe(1);
  });

  it("counts degraded-but-included backends separately", () => {
    const degradedEntry = makeEntry("degraded-backend", 8090, "http", "degraded");
    const report = buildFleetMcpuConfig(makeInventory([degradedEntry]));
    expect(report.config).toHaveProperty("degraded-backend");
    expect(report.summary.degradedIncluded).toBe(1);
    expect(report.summary.included).toBe(1);
  });

  it("includes multiple backends and reports correct counts", () => {
    const entries = [
      makeEntry("atlassian", 8080, "http"),
      makeEntry("github", 8081, "sse"),
      makeEntry("jira", 8082, "http", "degraded"),
    ];
    const report = buildFleetMcpuConfig(makeInventory(entries));
    expect(Object.keys(report.config)).toHaveLength(3);
    expect(report.summary.included).toBe(3);
    expect(report.summary.omitted).toBe(0);
    expect(report.summary.degradedIncluded).toBe(1);
  });
});

// ─── Report envelope ──────────────────────────────────────────────────────────

describe("buildFleetMcpuConfig — report envelope", () => {
  it("always returns mode=read-only", () => {
    const report = buildFleetMcpuConfig(makeInventory([]));
    expect(report.mode).toBe("read-only");
  });

  it("generatedAt is a valid ISO timestamp", () => {
    const report = buildFleetMcpuConfig(makeInventory([]));
    expect(() => new Date(report.generatedAt).toISOString()).not.toThrow();
  });

  it("entries array mirrors the input catalog length", () => {
    const inventory = makeInventory([
      makeEntry("a", 8080, "http"),
      makeEntry("b", 8081, "sse"),
    ]);
    const report = buildFleetMcpuConfig(inventory);
    expect(report.entries).toHaveLength(2);
  });
});
