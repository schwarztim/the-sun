#!/usr/bin/env node
// Minimal streamable-http MCP server used ONLY by src/lab's own unit tests
// (harness.test.ts, index.test.ts) to exercise the Lab's spawn/connect/
// teardown plumbing without depending on Python/FastMCP being installed on
// the machine running `npm test`. Reads PORT/HOST from env (the Lab's
// default convention — see harness.ts's DEFAULT_LAUNCH_SPEC) and an
// upstream base URL from BASE_URL (used by the "caller" tool below to
// prove env-var-driven egress redirection works, the same mechanism the
// wire-fingerprint/callability/precision gates rely on for real servers).
import http from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const server = new McpServer({ name: "lab-fixture-http", version: "0.1.0" });

const ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

// Registered FIRST deliberately: the wire-fingerprint gate invokes
// `tools[0]` to trigger egress (see gates/wire-fingerprint.ts), so this
// fixture's first tool must be the one that actually calls out — otherwise
// an integration test against this fixture would only ever exercise the
// "no egress observed" branch, never the "captured a JA4" branch.
server.registerTool(
  "call_upstream",
  {
    description: "Calls the configured upstream base URL and returns its status. Requires nothing.",
    annotations: ANNOTATIONS,
  },
  async () => {
    const baseUrl = process.env.BASE_URL;
    if (!baseUrl) {
      return { content: [{ type: "text", text: "no BASE_URL configured" }], isError: true };
    }
    try {
      const res = await fetch(baseUrl, { method: "GET" });
      return { content: [{ type: "text", text: `status ${res.status}` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `error: ${error}` }], isError: true };
    }
  },
);

server.registerTool(
  "ping",
  { description: "Replies pong. Requires nothing.", annotations: ANNOTATIONS },
  async () => ({ content: [{ type: "text", text: "pong" }] }),
);

server.registerTool(
  "example_help",
  {
    description: "Help topics for this fixture server.",
    inputSchema: { topic: z.string().optional().describe("Help topic to look up") },
    annotations: ANNOTATIONS,
  },
  async () => ({ content: [{ type: "text", text: "no topics" }] }),
);

const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
await server.connect(transport);

const httpServer = http.createServer((req, res) => {
  transport.handleRequest(req, res).catch((error) => {
    console.error("handleRequest error:", error);
    if (!res.headersSent) res.writeHead(500).end();
  });
});

const port = Number(process.env.PORT || 0);
const host = process.env.HOST || "127.0.0.1";
httpServer.listen(port, host, () => {
  // Deliberately silent on stdout — the harness only cares about the port
  // being open, not about any readiness banner.
});
