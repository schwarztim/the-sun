#!/usr/bin/env node
// Minimal stdio MCP server used ONLY by src/lab's own unit tests to prove
// the harness's dual-capable spawn logic AND that gate 3 (transport)
// correctly fails a stdio-only server — a shipped generated server must be
// streamable-http-only (Locked direction #1).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "lab-fixture-stdio", version: "0.1.0" });

server.registerTool(
  "ping",
  {
    description: "Replies pong. Requires nothing.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => ({ content: [{ type: "text", text: "pong" }] }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
