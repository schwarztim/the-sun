import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { BackendConfig } from "../../src/config.js";
import type { Logger } from "../../src/logger.js";

// Captures every transport the SDK "creates" so a test can drive its onclose
// handler (simulating a dropped connection) exactly like the real transport would.
const createdTransports: Array<{
  onclose?: () => void;
  onerror?: (err: Error) => void;
  close(): Promise<void>;
}> = [];

// Mock the streamable-http transport: constructing one records it; close() is a no-op.
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {
    onclose?: () => void;
    onerror?: (err: Error) => void;
    constructor(_url: URL) {
      createdTransports.push(this);
    }
    async close(): Promise<void> {}
  },
}));

// Mock the SSE transport too so the deprecated import resolves without a real network.
vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class {
    onclose?: () => void;
    onerror?: (err: Error) => void;
    constructor(_url: URL) {
      createdTransports.push(this);
    }
    async close(): Promise<void> {}
  },
}));

// Mock the MCP Client: connect() and listTools() succeed instantly (no I/O).
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    async connect(): Promise<void> {}
    async listTools(): Promise<{ tools: unknown[] }> {
      return { tools: [] };
    }
  },
}));

// Imported AFTER the mocks above (vi.mock is hoisted) so BackendInstance binds to them.
import { BackendInstance } from "../../src/backend.js";

const httpConfig = {
  transport: "http",
  url: "http://127.0.0.1:65535/mcp",
  headers: {},
  enabled: true,
  reconnect_interval: 5,
  max_restarts: 5,
  restart_policy: "on-failure",
} as unknown as BackendConfig;

// A silent logger; the real one is a pino instance we do not need here.
const fakeLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
} as unknown as Logger;

describe("BackendInstance lifecycle (STAB-1, STAB-2)", () => {
  beforeEach(() => {
    createdTransports.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // STAB-1: a successful reconnect must refund the restart budget so a backend
  // that flaps and recovers is never abandoned at max_restarts.
  it("resets restartCount to 0 after a successful connect", async () => {
    const backend = new BackendInstance("stab1", httpConfig, fakeLogger);
    // Simulate prior failed reconnect attempts having consumed the budget.
    (backend as unknown as { _restartCount: number })._restartCount = 3;
    expect(backend.restartCount).toBe(3);

    await backend.connect();

    expect(backend.status).toBe("connected");
    expect(backend.restartCount).toBe(0);
  });

  // STAB-2: after disconnect(), a reconnect timer scheduled by an earlier drop
  // must NOT fire and resurrect the removed backend.
  it("does not fire a reconnect after disconnect() cancels the pending timer", async () => {
    vi.useFakeTimers();
    const onToolsChanged = vi.fn();
    const backend = new BackendInstance("stab2", httpConfig, fakeLogger, onToolsChanged);

    await backend.connect();
    expect(backend.status).toBe("connected");

    // Simulate the transport dropping -> schedules a reconnect timer.
    const transport = createdTransports[createdTransports.length - 1];
    transport.onclose?.();

    // Backend removed during a config reload.
    await backend.disconnect();

    // Advance well past reconnect_interval (5s). The cancelled timer must not fire.
    await vi.advanceTimersByTimeAsync(20_000);

    expect(onToolsChanged).not.toHaveBeenCalled();
    expect(backend.status).toBe("disconnected");
  });

  // Positive control: proves the harness actually schedules a reconnect, so the
  // negative assertion above cannot pass falsely (a broken schedule would also
  // never call onToolsChanged).
  it("DOES fire a reconnect when the pending timer is left uncancelled", async () => {
    vi.useFakeTimers();
    const onToolsChanged = vi.fn();
    const backend = new BackendInstance("stab2-ctrl", httpConfig, fakeLogger, onToolsChanged);

    await backend.connect();
    const transport = createdTransports[createdTransports.length - 1];
    transport.onclose?.();

    // No disconnect() this time; the timer should fire and re-register tools.
    await vi.advanceTimersByTimeAsync(6_000);

    expect(onToolsChanged).toHaveBeenCalledTimes(1);
    expect(backend.status).toBe("connected");
  });
});
