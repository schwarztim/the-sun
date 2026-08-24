/**
 * E2E harness: boots the REAL Gateway against REAL in-process MCP backends.
 *
 * - getFreePort(): OS-assigned free port via the net listen-on-0 trick.
 * - fakeBackend(): express + per-request McpServer/StreamableHTTPServerTransport
 *   (mirrors the gateway's own stateless pattern) exposing three tools:
 *     echo_message      — verb-less name (UNCLASSIFIED post-integration); NOTE
 *                         the "_message" segment matches the escalation
 *                         overlay's outbound-verb list, so it escalates to
 *                         HUMAN_OUTBOUND when that policy is enabled.
 *     store_note        — a genuinely-benign write name (no destructive/outbound
 *                         verb collision) — the "benign write flows" fixture.
 *     fake_delete_item  — matches the write-verb regex (WRITE by name-pattern)
 *   Records per-tool invocation counts so tests can assert zero backend hits
 *   on denied calls.
 * - bootGateway(): writes a minimal temp YAML config (mkdtemp — the gateway
 *   chokidar-watches its config path, so NEVER point it at a repo config),
 *   loadConfig()s it, constructs and starts a real Gateway, and returns url +
 *   stop() that tears down gateway + temp dir.
 * - mcpClient()/callTool(): SDK streamable-http client helpers.
 */
import { createServer, type AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/logger.js";
import { Gateway } from "../../src/gateway.js";

/** Allocate an OS-assigned free port (listen on 0, read, close). */
export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

export interface FakeBackend {
  name: string;
  port: number;
  url: string;
  /** Per-tool invocation counters (key = tool name). */
  calls: Record<string, number>;
  close: () => Promise<void>;
}

/**
 * In-process MCP backend over stateless streamable HTTP.
 * A fresh McpServer + transport per POST — same pattern the gateway itself
 * uses for its stateless facade (simplest thing that works, no session state).
 */
export async function fakeBackend(name: string): Promise<FakeBackend> {
  const port = await getFreePort();
  const calls: Record<string, number> = { echo_message: 0, store_note: 0, fake_delete_item: 0 };

  const buildServer = (): McpServer => {
    const server = new McpServer({ name, version: "0.0.1" });
    server.registerTool(
      "echo_message",
      {
        description: "Echo the provided text back (verb-less tool name).",
        inputSchema: { text: z.string() },
      },
      async ({ text }) => {
        calls.echo_message += 1;
        return { content: [{ type: "text" as const, text }] };
      }
    );
    server.registerTool(
      "store_note",
      {
        description: "Store a note and echo it back (benign write-verb-free name).",
        inputSchema: { text: z.string() },
      },
      async ({ text }) => {
        calls.store_note += 1;
        return { content: [{ type: "text" as const, text }] };
      }
    );
    server.registerTool(
      "fake_delete_item",
      {
        description: "Pretend to delete an item (write-verb tool name).",
        inputSchema: { id: z.string() },
      },
      async ({ id }) => {
        calls.fake_delete_item += 1;
        return { content: [{ type: "text" as const, text: `deleted ${id}` }] };
      }
    );
    return server;
  };

  const app = express();
  app.use(express.json());
  // Stateless server: no standalone SSE stream. 405 tells the SDK client
  // cleanly that GET /mcp is unsupported (avoids noisy reconnect errors).
  app.get("/mcp", (_req, res) => {
    res.status(405).set("Allow", "POST").end();
  });
  app.post("/mcp", async (req, res) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const server = buildServer();
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: String(err) },
          id: null,
        });
      }
    } finally {
      try {
        await server.close();
      } catch {
        /* per-request cleanup */
      }
      try {
        await transport.close();
      } catch {
        /* per-request cleanup */
      }
    }
  });

  const httpServer = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(port, "127.0.0.1", () => resolve(s));
  });

  return {
    name,
    port,
    url: `http://127.0.0.1:${port}/mcp`,
    calls,
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

export interface BootGatewayOpts {
  backends: Record<string, { url: string }>;
  toolExposure?: "mux" | "both";
  enforce?: "advisory" | "blocking";
  /** Fleet config block; defaults to { enabled: false }. */
  fleet?: object;
  /** Extra keys merged into the safety block. */
  safetyExtra?: object;
  /** Extra keys merged into the gateway block (e.g. streamable_http_stateless: false for elicitation tests). */
  gatewayExtra?: object;
  /** Extra keys merged into the approvals block (e.g. elicitation: "on" + a short elicitation_timeout_ms). */
  approvalsExtra?: object;
  /** Raw backend entries written verbatim into the YAML (e.g. stdio quarantine probes). */
  rawBackends?: Record<string, object>;
}

export interface BootedGateway {
  url: string;
  port: number;
  adminUrl: string;
  /** Directory holding this boot's isolated approvals.json / grants.json (Phase 2 value-free persistence checks read these). */
  approvalsDir: string;
  /** Path of this boot's isolated safety decision log (JSONL) — for audit-trail assertions. */
  decisionLogPath: string;
  stop: () => Promise<void>;
}

/** Boot a real Gateway on a free port from a minimal temp YAML config. */
export async function bootGateway(opts: BootGatewayOpts): Promise<BootedGateway> {
  const dir = await mkdtemp(join(tmpdir(), "gw-e2e-"));

  const attempt = async (): Promise<BootedGateway> => {
    const port = await getFreePort();
    const decisionLogPath = join(dir, "decisions.jsonl");
    const configObj = {
      gateway: {
        port,
        host: "127.0.0.1",
        tool_exposure: opts.toolExposure ?? "both",
        log_level: "error",
        streamable_http_json_response: true,
        ...(opts.gatewayExtra ?? {}),
      },
      fleet: opts.fleet ?? { enabled: false },
      safety: {
        enforce: opts.enforce ?? "advisory",
        // The escalation overlay ships enabled (config.ts default) but it
        // reclassifies this harness's write-verb fixture (fake_delete_item →
        // Tier-B via policy:destructive-verb). Default it OFF here so the
        // pre-overlay suites keep exercising their own layer (Tier-A confirm,
        // manifest Tier-B, content-guard) unperturbed — the same test-ergonomics
        // precedent as enforce defaulting to "advisory" while shipped is
        // "blocking". Escalation suites opt in via safetyExtra.escalation.
        escalation: { enabled: false },
        // Keep test dispatches out of the operator's real audit trail — the
        // decision log defaults ON, so point it into this boot's temp dir.
        decision_log: { enabled: true, path: decisionLogPath },
        // Park notifications default ON in production but must NEVER fire a
        // real OS toast from CI/test runs. Tests that exercise the
        // notification path re-enable via safetyExtra + a spawn stub.
        notifications: false,
        confirm_token: false, // Phase-4 audit nonce ships ON; harness boots pre-nonce semantics — confirm-token e2e opts back in via safetyExtra
        ...(opts.safetyExtra ?? {}),
      },
      // Isolate the Tier-B approval store (approvals.json/grants.json/
      // install-identity.json) into this boot's temp dir — tests must never
      // read or write the operator's real THESUN_HOME.
      approvals: { dir: join(dir, "approvals"), ...(opts.approvalsExtra ?? {}) },
      backends: {
        ...Object.fromEntries(
          Object.entries(opts.backends).map(([name, b]) => [
            name,
            { transport: "http", url: b.url, namespace: name },
          ])
        ),
        ...(opts.rawBackends ?? {}),
      },
    };
    const configPath = join(dir, "config.yaml");
    await writeFile(configPath, stringifyYaml(configObj), "utf-8");

    const config = await loadConfig(configPath);
    const gateway = new Gateway(config, configPath, createLogger("error"));
    await gateway.start();

    return {
      url: `http://127.0.0.1:${port}/mcp`,
      port,
      adminUrl: `http://127.0.0.1:${port}`,
      approvalsDir: join(dir, "approvals"),
      decisionLogPath,
      stop: async () => {
        await gateway.stop();
        await rm(dir, { recursive: true, force: true });
      },
    };
  };

  try {
    return await attempt();
  } catch (err) {
    // Free-port allocation is TOCTOU; retry once on a bind collision.
    if (err instanceof Error && /EADDRINUSE/.test(err.message)) {
      return attempt();
    }
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
}

/** Connected SDK client against a streamable-http /mcp endpoint. */
export async function mcpClient(url: string): Promise<Client> {
  const client = new Client({ name: "gw-e2e-client", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  await client.connect(transport); // performs the initialize handshake
  return client;
}

export interface ToolCallResult {
  /** Raw SDK result. */
  raw: any;
  /** Concatenated text content. */
  text: string;
  /** First text block parsed as JSON, or undefined if not parseable. */
  json: any | undefined;
  isError: boolean;
}

/** Call a tool and return parsed text/JSON views of the result. */
export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<ToolCallResult> {
  const raw: any = await client.callTool({ name, arguments: args });
  const blocks: any[] = Array.isArray(raw?.content) ? raw.content : [];
  const text = blocks
    .filter((b) => b?.type === "text")
    .map((b) => String(b.text))
    .join("\n");
  let json: any | undefined;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { raw, text, json, isError: raw?.isError === true };
}
