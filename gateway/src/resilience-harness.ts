import { buildFleetMcpuConfig } from "./fleet-mcpu-config.js";
import type { FleetEntry, FleetInventory, FleetHealth } from "./fleet-inventory.js";
import { getMuxTools } from "./mux-tools.js";

interface HarnessResult {
  scenario: string;
  passed: boolean;
  details: Record<string, unknown>;
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function entry(index: number, health: FleetHealth, port: number, reasons: string[] = []): FleetEntry {
  const name = `simulated-${String(index).padStart(3, "0")}`;
  return {
    name,
    health,
    reasons,
    runConfig: {
      path: `/simulated/runconfigs/${name}.json`,
      image: `localhost:5555/${name}:latest`,
      containerName: name,
      baseName: name,
      transport: "stdio",
      proxyMode: "streamable-http",
      group: "default",
      host: "127.0.0.1",
      port,
      targetHost: "127.0.0.1",
      envKeys: ["MCP_TRANSPORT"],
      secretRefs: [],
      labelPort: String(port),
      labelTransport: "stdio",
    },
    statusFile: {
      path: `/simulated/statuses/${name}.json`,
      status: health === "available" ? "running" : "unhealthy",
      statusContext: reasons.join("; ") || undefined,
      processId: 10_000 + index,
      proxyProcessAlive: health === "available",
    },
    docker: {
      id: `container-${index}`,
      name,
      image: `localhost:5555/${name}:latest`,
      state: "running",
      status: "Up 1 minute",
      labels: {
        toolhive: "true",
        "toolhive-name": name,
        "toolhive-port": String(port),
        "toolhive-transport": "stdio",
      },
      toolhiveName: name,
      toolhivePort: String(port),
      toolhiveTransport: "stdio",
    },
    mcpu: { exposed: health === "available", type: "streamable-http", url: `http://127.0.0.1:${port}/mcp` },
    endpoint: { checked: false, url: `http://127.0.0.1:${port}/mcp` },
    repairHints: health === "available"
      ? []
      : [{
          code: "restart-toolhive-proxy",
          safeAutomatic: true,
          description: "Simulated dead proxy with known runconfig and running container.",
        }],
  };
}

function inventory(entries: FleetEntry[]): FleetInventory {
  const byHealth: Record<FleetHealth, number> = { available: 0, degraded: 0, unavailable: 0, unknown: 0 };
  let exposedInMcpu = 0;
  let safeAutomaticRepairHints = 0;
  for (const item of entries) {
    byHealth[item.health]++;
    if (item.mcpu.exposed) exposedInMcpu++;
    safeAutomaticRepairHints += item.repairHints.filter((hint) => hint.safeAutomatic).length;
  }
  return {
    generatedAt: new Date().toISOString(),
    source: "toolhive",
    paths: {
      appSupportDir: "/simulated/toolhive",
      runconfigsDir: "/simulated/toolhive/runconfigs",
      statusesDir: "/simulated/toolhive/statuses",
      mcpuGeneratedConfig: "/simulated/mcpu/config.generated.json",
    },
    probeEnabled: false,
    dockerPsEnabled: true,
    summary: {
      total: entries.length,
      byHealth,
      toolhiveStatuses: {
        running: byHealth.available,
        unhealthy: byHealth.degraded,
      },
      dockerStates: { running: entries.length },
      exposedInMcpu,
      withRunConfig: entries.length,
      withStatusFile: entries.length,
      withDockerContainer: entries.length,
      safeAutomaticRepairHints,
    },
    entries,
    errors: [],
  };
}

function runHarness(): HarnessResult[] {
  const entries = Array.from({ length: 500 }, (_, index) =>
    index % 4 === 0
      ? entry(index, "degraded", 20_000 + index, ["proxy-process-missing", "not-exposed-in-mcpu-generated-config"])
      : entry(index, "available", 20_000 + index)
  );

  const firstReport = buildFleetMcpuConfig(inventory(entries));
  const changedPortEntries = entries.map((item, index) =>
    index === 42 && item.runConfig
      ? {
          ...item,
          runConfig: { ...item.runConfig, port: 31_042, labelPort: "31042" },
          endpoint: { checked: false, url: "http://127.0.0.1:31042/mcp" },
        }
      : item
  );
  const changedPortReport = buildFleetMcpuConfig(inventory(changedPortEntries));
  const muxToolCount = getMuxTools().length;

  assert(firstReport.summary.included === 500, "all simulated backends must remain in MCPU config");
  assert(firstReport.summary.degradedIncluded === 125, "degraded backends must be preserved");
  assert(muxToolCount < 10, "mux context surface must remain compact");
  assert(changedPortReport.config["simulated-042"].url === "http://127.0.0.1:31042/mcp", "port changes must resolve from the latest catalog");

  return [
    {
      scenario: "500-backend-preservation",
      passed: true,
      details: firstReport.summary,
    },
    {
      scenario: "compact-context-surface",
      passed: true,
      details: { muxToolCount, simulatedBackendTools: 500 },
    },
    {
      scenario: "ephemeral-port-change",
      passed: true,
      details: { backend: "simulated-042", url: changedPortReport.config["simulated-042"].url },
    },
  ];
}

try {
  console.log(JSON.stringify({ passed: true, results: runHarness() }, null, 2));
} catch (err) {
  console.error(JSON.stringify({
    passed: false,
    error: err instanceof Error ? err.message : String(err),
  }, null, 2));
  process.exit(1);
}
