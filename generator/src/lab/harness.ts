/**
 * Spawn/connect/teardown harness for the Conformance Lab.
 *
 * Dual-capable per the plan: streamable-http (the only transport a real
 * generated server should ship, per Locked direction #1) with a dynamic
 * port + bounded readiness poll, and stdio (for legacy fixtures the Lab
 * must correctly FAIL at gate 3 — see gates/connection-gates.ts).
 *
 * The stdio JSON-RPC-initialize precedent is tracking/validator.ts:307-342,
 * which sleeps a fixed 3000ms. This harness replaces that with a real
 * bounded poll for the streamable-http path (retry `initialize` every
 * ~150ms up to a ~20s ceiling) since a fixed sleep is either too slow
 * (wasted time once the server is actually ready) or too fast (flaky on a
 * loaded machine).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { getFreePort } from "./ports.js";
import type { LabTransport, LaunchSpec } from "./types.js";

export const DEFAULT_LAUNCH_SPEC: LaunchSpec = {
  transport: "streamable-http",
  command: "python3",
  args: ["server.py"],
  portEnvVar: "PORT",
  hostEnvVar: "HOST",
  mcpPath: "/mcp",
};

/** Read `<serverDir>/lab.launch.json`, falling back to FastMCP-shaped defaults when absent. */
export async function readLaunchSpec(serverDir: string): Promise<LaunchSpec> {
  const descriptorPath = path.join(serverDir, "lab.launch.json");
  try {
    const raw = await fs.readFile(descriptorPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<LaunchSpec>;
    return { ...DEFAULT_LAUNCH_SPEC, ...parsed };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return { ...DEFAULT_LAUNCH_SPEC };
    }
    // Malformed descriptor is a hard failure, not a silent fallback — a
    // JSON syntax error here should never be mistaken for "no descriptor."
    throw new Error(`Failed to parse ${descriptorPath}: ${err.message}`);
  }
}

/**
 * Resolves the env var a generated server reads for its upstream base URL,
 * matching src/generator/config-abstraction.ts's `generateConfigItems`
 * convention (`${TOOL_UPPER}_BASE_URL`) unless the descriptor overrides it.
 */
export function resolveBaseUrlEnvVar(spec: LaunchSpec, serverDir: string): string {
  if (spec.targetBaseUrlEnvVar) return spec.targetBaseUrlEnvVar;
  const name = spec.targetName ?? path.basename(serverDir);
  const prefix = name.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return `${prefix}_BASE_URL`;
}

export interface SpawnedServer {
  client: Client;
  transport: Transport;
  actualTransport: LabTransport;
  /** null for stdio — the SDK owns that child process, not the harness. */
  proc: ChildProcess | null;
  port: number | null;
  /** Process-group kill + port-free, safe to call more than once. */
  close(): Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

async function teardownProcess(proc: ChildProcess | null): Promise<void> {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  const pid = proc.pid;
  try {
    // Negative pid targets the whole process group (POSIX only — the
    // process was spawned with detached:true so it leads its own group).
    if (pid) process.kill(-pid, "SIGTERM");
    else proc.kill("SIGTERM");
  } catch {
    try {
      proc.kill("SIGTERM");
    } catch {
      /* process already gone */
    }
  }
  const exited = await Promise.race([
    once(proc, "exit").then(() => true),
    sleep(3000).then(() => false),
  ]);
  if (!exited && proc.exitCode === null && proc.signalCode === null) {
    try {
      if (pid) process.kill(-pid, "SIGKILL");
      else proc.kill("SIGKILL");
    } catch {
      /* process already gone */
    }
  }
}

/**
 * Retries `initialize` against a freshly-created transport every
 * `pollIntervalMs` until it succeeds or `ceilingMs` elapses. A new
 * Client+Transport pair is created per attempt because a failed HTTP
 * connect can leave the transport in a state that isn't safely retryable
 * in place.
 */
async function connectWithReadinessPoll(
  makeTransport: () => Transport,
  opts: { pollIntervalMs?: number; ceilingMs?: number } = {},
): Promise<{ client: Client; transport: Transport }> {
  const pollIntervalMs = opts.pollIntervalMs ?? 150;
  const ceilingMs = opts.ceilingMs ?? 20_000;
  const deadline = Date.now() + ceilingMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const transport = makeTransport();
    const client = new Client({ name: "thesun-conformance-lab", version: "0.1.0" }, { capabilities: {} });
    try {
      await client.connect(transport);
      return { client, transport };
    } catch (error) {
      lastError = error;
      try {
        await transport.close();
      } catch {
        /* never opened, or already closed */
      }
      await sleep(pollIntervalMs);
    }
  }
  throw new Error(
    `server did not become ready within ${ceilingMs}ms: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

async function launchStreamableHttp(
  serverDir: string,
  spec: LaunchSpec,
  envOverrides: Record<string, string>,
): Promise<SpawnedServer> {
  const port = await getFreePort();
  const host = "127.0.0.1";
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(spec.env ?? {}),
    ...envOverrides,
    [spec.portEnvVar ?? "PORT"]: String(port),
    [spec.hostEnvVar ?? "HOST"]: host,
  };
  const args = (spec.args ?? ["server.py"]).map((a) =>
    a.replace("{port}", String(port)).replace("{host}", host),
  );

  const proc = spawn(spec.command ?? "python3", args, {
    cwd: serverDir,
    env,
    detached: true, // POSIX: becomes its own process-group leader for teardown
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stderrChunks: Buffer[] = [];
  proc.stderr?.on("data", (d: Buffer) => stderrChunks.push(d));

  const mcpPath = spec.mcpPath ?? "/mcp";
  const url = new URL(`http://${host}:${port}${mcpPath}`);

  try {
    const { client, transport } = await connectWithReadinessPoll(
      () => new StreamableHTTPClientTransport(url),
      { pollIntervalMs: 150, ceilingMs: 20_000 },
    );
    return {
      client,
      transport,
      actualTransport: "streamable-http",
      proc,
      port,
      close: async () => {
        try {
          await transport.close();
        } catch {
          /* already closed */
        }
        await teardownProcess(proc);
      },
    };
  } catch (error) {
    const exitedEarly = proc.exitCode !== null || proc.signalCode !== null;
    await teardownProcess(proc);
    const exitNote = exitedEarly
      ? ` (process exited early: code=${proc.exitCode} signal=${proc.signalCode})`
      : "";
    const stderrTail = Buffer.concat(stderrChunks).toString("utf-8").slice(-2000);
    throw new Error(
      `streamable-http server at ${serverDir} failed to become ready${exitNote}: ${
        (error as Error).message
      }\n--- stderr tail ---\n${stderrTail}`,
    );
  }
}

async function launchStdio(
  serverDir: string,
  spec: LaunchSpec,
  envOverrides: Record<string, string>,
): Promise<SpawnedServer> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...(spec.env ?? {}),
    ...envOverrides,
  };
  const transport = new StdioClientTransport({
    command: spec.command ?? "python3",
    args: spec.args ?? ["server.py"],
    cwd: serverDir,
    env,
  });
  const client = new Client({ name: "thesun-conformance-lab", version: "0.1.0" }, { capabilities: {} });

  try {
    await withTimeout(
      client.connect(transport),
      20_000,
      "stdio server did not respond to initialize within 20000ms",
    );
  } catch (error) {
    try {
      await transport.close();
    } catch {
      /* already closed */
    }
    throw error;
  }

  return {
    client,
    transport,
    actualTransport: "stdio",
    proc: null, // StdioClientTransport owns the spawned child; close() below tears it down
    port: null,
    close: async () => {
      try {
        await transport.close();
      } catch {
        /* already closed */
      }
    },
  };
}

/**
 * Spawn the target server per its launch spec, connect over MCP protocol,
 * and return a live client plus a teardown function. Callers MUST call
 * `close()` in a `finally` block.
 */
export async function launchAndConnect(
  serverDir: string,
  spec: LaunchSpec,
  envOverrides: Record<string, string> = {},
): Promise<SpawnedServer> {
  if (spec.transport === "stdio") {
    return launchStdio(serverDir, spec, envOverrides);
  }
  return launchStreamableHttp(serverDir, spec, envOverrides);
}
