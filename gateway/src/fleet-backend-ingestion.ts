/**
 * Fleet Backend Ingestion
 *
 * Reads fleet entries from ~/.config/mcpu/config.generated.json and/or ToolHive
 * inventory, then converts "running" streamable-http / sse entries into callable
 * gateway HttpBackendConfig objects that can be connected at startup.
 *
 * This is read-only; it never modifies ToolHive state or Docker containers.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  HttpBackendConfig,
  SseBackendConfig,
  ToolHiveFleetConfig,
} from "./config.js";
import type { Logger } from "./logger.js";

export type FleetBackendConfig = HttpBackendConfig | SseBackendConfig;

export interface QuarantineRecord {
  name: string;
  transport: "stdio";
  status: "quarantined";
  reason: string;
  remedy: string;
  source: string;
}

export interface FleetIngestResult {
  backends: Record<string, FleetBackendConfig>;
  skipped: Array<{ name: string; reason: string }>;
  quarantined: QuarantineRecord[];
  source: string;
  sources: string[];
  generatedAt: string;
}

/** Shape of a single MCPU config.generated.json entry */
interface McpuEntry {
  type?: string;
  url?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  description?: string;
}

interface McpuConfigSource {
  path: string;
  source: "fleet-mcpu-generated" | "fleet-mcpu-static" | "fleet-mcpu-additional";
}

/**
 * Sanitise a backend name for use as a namespace / backend key.
 * Replaces non-alphanumeric runs with underscores and lowercases.
 */
function sanitiseName(name: string): string {
  return name.replace(/[^a-zA-Z0-9]+/g, "_").toLowerCase();
}

function makeUniqueNamespace(
  baseNamespace: string,
  backendName: string,
  usedNamespaces: Map<string, string>,
  logger: Logger
): string {
  const fallbackNamespace = baseNamespace || "backend";
  let namespace = fallbackNamespace;
  let suffix = 2;

  while (usedNamespaces.has(namespace)) {
    namespace = `${fallbackNamespace}_${suffix}`;
    suffix++;
  }

  const priorBackend = usedNamespaces.get(fallbackNamespace);
  if (priorBackend && namespace !== fallbackNamespace) {
    logger.warn(
      `Fleet ingestion: namespace collision for "${backendName}" and "${priorBackend}"; using namespace "${namespace}"`
    );
  }

  usedNamespaces.set(namespace, backendName);
  return namespace;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeConfigMap(parsed: unknown): Record<string, McpuEntry> {
  if (!isRecord(parsed)) return {};

  const maybeWrapped = parsed.mcpServers;
  if (isRecord(maybeWrapped)) {
    return Object.fromEntries(
      Object.entries(maybeWrapped).filter(([, value]) => isRecord(value))
    ) as Record<string, McpuEntry>;
  }

  return Object.fromEntries(
    Object.entries(parsed).filter(([, value]) => isRecord(value))
  ) as Record<string, McpuEntry>;
}

async function readConfigSource(
  source: McpuConfigSource,
  logger: Logger
): Promise<Record<string, McpuEntry> | undefined> {
  try {
    const content = await readFile(source.path, "utf-8");
    return normalizeConfigMap(JSON.parse(content) as unknown);
  } catch (err) {
    logger.warn(
      `Fleet ingestion: could not read MCPU config at ${source.path}: ${err instanceof Error ? err.message : String(err)}`
    );
    return undefined;
  }
}

function inferTransport(entry: McpuEntry): string {
  if (entry.type) return entry.type;
  if (entry.command) return "stdio";
  if (entry.url) return "http";
  return "";
}

/**
 * Load the MCPU-generated config from disk and convert eligible entries to
 * gateway backend configs.
 */
export async function loadFleetBackendsFromMcpuConfig(
  fleetConfig: ToolHiveFleetConfig,
  logger: Logger
): Promise<FleetIngestResult> {
  const generatedPath =
    fleetConfig.mcpu_generated_config ??
    join(homedir(), ".config", "mcpu", "config.generated.json");
  const staticPath =
    fleetConfig.mcpu_static_config ??
    join(homedir(), ".config", "mcpu", "config.json");
  const configSources: McpuConfigSource[] = [
    { path: generatedPath, source: "fleet-mcpu-generated" },
    ...(fleetConfig.ingest_static_mcpu_config
      ? [{ path: staticPath, source: "fleet-mcpu-static" } as const]
      : []),
    ...fleetConfig.additional_mcpu_configs.map((path) => ({
      path,
      source: "fleet-mcpu-additional" as const,
    })),
  ];

  const result: FleetIngestResult = {
    backends: {},
    skipped: [],
    quarantined: [],
    source: configSources.map((s) => s.path).join(", "),
    sources: configSources.map((s) => s.path),
    generatedAt: new Date().toISOString(),
  };

  const ingestOnly = new Set(fleetConfig.ingest_only ?? []);
  const ingestSkip = new Set(fleetConfig.ingest_skip ?? []);
  const namespacePrefix = fleetConfig.ingest_namespace_prefix ?? "";
  const usedNamespaces = new Map<string, string>();

  for (const source of configSources) {
    const rawConfig = await readConfigSource(source, logger);
    if (!rawConfig) continue;

    for (const [name, entry] of Object.entries(rawConfig)) {
      // Filters.
      if (ingestOnly.size > 0 && !ingestOnly.has(name)) {
        result.skipped.push({ name, reason: `not in ingest_only list (${source.path})` });
        continue;
      }
      if (ingestSkip.has(name)) {
        result.skipped.push({ name, reason: `in ingest_skip list (${source.path})` });
        continue;
      }
      if (result.backends[name]) {
        result.skipped.push({
          name,
          reason: `already loaded from higher-priority config; skipping duplicate in ${source.path}`,
        });
        continue;
      }

      const type = inferTransport(entry);
      const namespace = makeUniqueNamespace(
        `${namespacePrefix}${sanitiseName(name)}`,
        name,
        usedNamespaces,
        logger
      );

      if (type === "stdio") {
        result.quarantined.push({
          name,
          transport: "stdio",
          status: "quarantined",
          reason: "stdio-unsupported",
          remedy: "re-front behind streamable-http",
          source: source.source,
        });
        logger.error(
          `Fleet ingestion: quarantined "${name}" (transport=stdio, source=${source.path}): stdio-unsupported — re-front behind streamable-http`
        );
        continue;
      }

      if (type !== "streamable-http" && type !== "http" && type !== "sse") {
        result.skipped.push({
          name,
          reason: `type="${type}" is not stdio/http/streamable-http/sse (${source.path})`,
        });
        continue;
      }

      if (!entry.url) {
        result.skipped.push({ name, reason: `no URL provided (${source.path})` });
        continue;
      }

      // Validate URL.
      let url: URL;
      try {
        url = new URL(entry.url);
      } catch {
        result.skipped.push({ name, reason: `invalid URL: ${entry.url} (${source.path})` });
        continue;
      }

      if (type === "sse") {
        const config: SseBackendConfig = {
          transport: "sse",
          url: url.toString(),
          namespace,
          enabled: true,
          reconnect_interval: 5,
          max_restarts: 5,
          connect_timeout_ms: 15_000,
          restart_policy: "on-failure",
          headers: {},
          health_check_interval: 30,
          source: source.source,
          description: entry.description,
        };
        result.backends[name] = config;
        logger.debug(`Fleet ingestion: will connect "${name}" as SSE backend at ${url}`);
      } else {
        // streamable-http or http
        const config: HttpBackendConfig = {
          transport: "http",
          url: url.toString(),
          namespace,
          enabled: true,
          reconnect_interval: 5,
          max_restarts: 5,
          connect_timeout_ms: 15_000,
          restart_policy: "on-failure",
          headers: {},
          health_check_interval: 30,
          source: source.source,
          description: entry.description,
        };
        result.backends[name] = config;
        logger.debug(`Fleet ingestion: will connect "${name}" as HTTP backend at ${url}`);
      }
    }
  }

  logger.info(
    `Fleet ingestion: ${Object.keys(result.backends).length} backends loaded from ${configSources.length} MCPU config source(s) (${result.skipped.length} skipped, ${result.quarantined.length} quarantined)`
  );
  return result;
}
