import { describe, it, expect, beforeEach } from "vitest";
import { Gateway } from "../../src/gateway.js";
import { createLogger } from "../../src/logger.js";
import type { Config } from "../../src/config.js";

// Regression coverage for the streamable-http stale-session auto-heal path.
//
// ROOT CAUSE: when a streamable-http backend (for example an orchestrator backend on :3737) restarts and
// invalidates the gateway's cached mcp-session-id, the backend rejects the next
// forwarded tool call with JSON-RPC code -32000, message
// "Bad Request: No valid session ID provided". The original isStaleSessionError()
// only matched code===-32001 OR /session not found/i, so this shape was NOT
// recognized as stale, the reconnect+retry path never fired, and the consumer
// was stuck until a manual gateway_reconnect_backend.

const minimalConfig: Config = {
  gateway: {
    port: 3100,
    host: "127.0.0.1",
    name: "mcp-gateway-test",
    log_level: "error",
    tool_prefix: "",
    tool_exposure: "mux",
    streamable_http_stateless: true,
    streamable_http_json_response: true,
  },
  fleet: {
    enabled: false,
    toolhive: {
      ingest_static_mcpu_config: false,
      additional_mcpu_configs: [],
      docker_ps: false,
      endpoint_probe: false,
      probe_timeout_ms: 750,
      auto_ingest: false,
      ingest_namespace_prefix: "",
      ingest_only: [],
      ingest_skip: [],
    },
  },
  backends: {},
  safety: {
    enforce: "advisory",
    decision_log: { enabled: false, path: "" },
  },
  compression: { enabled: false, min_chars: 20_000, mode: "active" as const },
};

// Build the McpError-shaped object the SDK surfaces. The real SDK McpError sets
// `this.code` and stringifies its message as "MCP error <code>: <message>", so
// the original text lives in err.message. We replicate both fields here.
function mcpError(code: number, originalMessage: string): Error & { code: number } {
  const err = new Error(`MCP error ${code}: ${originalMessage}`) as Error & { code: number };
  err.code = code;
  return err;
}

function newGateway(): Gateway {
  return new Gateway(minimalConfig, "<test-config>", createLogger("error"));
}

describe("isStaleSessionError — stale-session detection", () => {
  const gw = newGateway() as any;
  const detect = (err: unknown) => gw.isStaleSessionError(err);

  it("matches the -32000 'No valid session ID' shape (the orchestrator-restart regression)", () => {
    expect(detect(mcpError(-32000, "Bad Request: No valid session ID provided"))).toBe(true);
  });

  it("still matches the -32001 transport code (fast-path)", () => {
    expect(detect(mcpError(-32001, "Session not found"))).toBe(true);
    // Fast-path is code-only — true even if the message is empty.
    expect(detect({ code: -32001 })).toBe(true);
  });

  it("still matches the textual 'session not found' variant", () => {
    expect(detect(mcpError(-32600, "Session not found"))).toBe(true);
  });

  it("matches 'no valid session' regardless of code (message-gated)", () => {
    expect(detect({ message: "No valid session ID provided" })).toBe(true);
  });

  it("does NOT treat an unrelated -32000 as stale (no false reconnect)", () => {
    expect(detect(mcpError(-32000, "internal error"))).toBe(false);
  });

  it("does NOT match unrelated application errors", () => {
    expect(detect(mcpError(-32602, "Invalid params"))).toBe(false);
    expect(detect(new Error("Confluence page not found"))).toBe(false);
  });

  it("returns false for non-object inputs", () => {
    expect(detect(null)).toBe(false);
    expect(detect(undefined)).toBe(false);
    expect(detect("no valid session")).toBe(false);
  });
});

describe("callBackendTool — auto-reconnect + retry on stale session", () => {
  let gw: any;
  let restartCount: number;
  let callAttempts: number;

  // Fake backend wired directly into the gateway's private maps. resolve() must
  // return a ToolEntry, and the backend must be status "connected".
  function wireBackend(opts: {
    firstCallThrows: Error;
    retrySucceeds: boolean;
    retryError?: Error;
  }): void {
    callAttempts = 0;
    restartCount = 0;

    const backend = {
      status: "connected",
      config: { namespace: "orchestrator" },
      tools: [] as any[],
      restart: async () => {
        restartCount++;
      },
      callTool: async (_name: string, _args: Record<string, unknown>) => {
        callAttempts++;
        if (callAttempts === 1) throw opts.firstCallThrows;
        if (!opts.retrySucceeds) throw opts.retryError ?? new Error("retry failed too");
        return { content: [{ type: "text", text: "ok-after-reconnect" }] };
      },
    };

    gw.backends.set("orchestrator", backend);
    gw.toolRegistry.tools.set("orchestrator_do_thing", {
      namespacedName: "orchestrator_do_thing",
      originalName: "do_thing",
      backendName: "orchestrator",
      tool: { name: "orchestrator_do_thing" },
    });
  }

  beforeEach(() => {
    gw = newGateway() as any;
  });

  it("reconnects and retries once, returning the retry result", async () => {
    wireBackend({
      firstCallThrows: mcpError(-32000, "Bad Request: No valid session ID provided"),
      retrySucceeds: true,
    });

    const result = await gw.callBackendTool("orchestrator_do_thing", { foo: "bar" });

    expect(restartCount).toBe(1); // reconnected exactly once
    expect(callAttempts).toBe(2); // original + one retry
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe("ok-after-reconnect");
  });

  it("does NOT reconnect on an unrelated -32000 error", async () => {
    wireBackend({
      firstCallThrows: mcpError(-32000, "internal error"),
      retrySucceeds: true, // irrelevant — retry should never be attempted
    });

    const result = await gw.callBackendTool("orchestrator_do_thing", {});

    expect(restartCount).toBe(0); // no reconnect for a non-stale error
    expect(callAttempts).toBe(1); // no retry
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("internal error");
  });

  it("surfaces the retryErr (not the stale-session error) when the retry also fails", async () => {
    wireBackend({
      firstCallThrows: mcpError(-32001, "Session not found"),
      retrySucceeds: false,
      retryError: new Error("ARMED_FAILURE_XYZ"),
    });

    const result = await gw.callBackendTool("orchestrator_do_thing", {});

    // The retry error must be surfaced, NOT the original stale-session text.
    expect(result.content[0].text).toContain("ARMED_FAILURE_XYZ");
    expect(result.content[0].text).not.toMatch(/session not found/i);

    expect(restartCount).toBe(1); // it did reconnect
    expect(callAttempts).toBe(2); // original + failed retry
    expect(result.isError).toBe(true);
  });
});
