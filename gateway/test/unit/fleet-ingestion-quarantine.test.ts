import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFleetBackendsFromMcpuConfig } from "../../src/fleet-backend-ingestion.js";
import type { ToolHiveFleetConfig } from "../../src/config.js";
import type { Logger } from "../../src/logger.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const stubLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
} as unknown as Logger;

let dir: string;
let configPath: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "gw-fleet-quarantine-"));
  configPath = join(dir, "mcpu-config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      legacy_stdio: {
        command: "/usr/local/bin/legacy-server",
        args: ["--stdio"],
        description: "legacy stdio entry",
      },
      good_http: {
        type: "http",
        url: "http://127.0.0.1:9101/mcp",
        description: "http entry",
      },
      good_sse: {
        type: "sse",
        url: "http://127.0.0.1:9102/sse",
        description: "sse entry",
      },
    }),
    "utf-8"
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function fleetConfig(): ToolHiveFleetConfig {
  return {
    mcpu_generated_config: configPath,
    ingest_static_mcpu_config: false,
    additional_mcpu_configs: [],
    docker_ps: false,
    endpoint_probe: false,
    probe_timeout_ms: 750,
    auto_ingest: true,
    ingest_namespace_prefix: "",
    ingest_only: [],
    ingest_skip: [],
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("fleet ingestion stdio quarantine", () => {
  it("quarantines command-style entries with the full record shape and never builds a backend", async () => {
    const result = await loadFleetBackendsFromMcpuConfig(fleetConfig(), stubLogger);

    expect(result.backends.legacy_stdio).toBeUndefined();
    expect(result.quarantined).toHaveLength(1);
    expect(result.quarantined[0]).toEqual({
      name: "legacy_stdio",
      transport: "stdio",
      status: "quarantined",
      reason: "stdio-unsupported",
      remedy: "re-front behind streamable-http",
      source: "fleet-mcpu-generated",
    });
  });

  it("ingests http and sse entries as backends", async () => {
    const result = await loadFleetBackendsFromMcpuConfig(fleetConfig(), stubLogger);

    expect(result.backends.good_http).toBeDefined();
    expect(result.backends.good_http.transport).toBe("http");
    expect(result.backends.good_http.url).toBe("http://127.0.0.1:9101/mcp");

    expect(result.backends.good_sse).toBeDefined();
    expect(result.backends.good_sse.transport).toBe("sse");
    expect(result.backends.good_sse.url).toBe("http://127.0.0.1:9102/sse");

    expect(Object.keys(result.backends)).toHaveLength(2);
  });
});
