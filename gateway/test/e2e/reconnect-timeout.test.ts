/**
 * reconnect-timeout.test.ts (STAB-3) — proves the reconnect path is BOUNDED.
 *
 * reconnectBackend() awaits backend.restart(), which awaits client.connect()
 * then client.listTools(). Neither self-times-out. Against an endpoint that
 * accepts the TCP connection and then never answers (a filtered port, a wedged
 * server, a half-open socket), that await never settled. Three callers were
 * exposed: the health sweep (one hung backend stalled every later backend in
 * the same sweep), the gateway_reconnect_backend tool, and the dead-session
 * recovery inside dispatch, which could hang a live tool call.
 *
 * The fix wraps the restart in the same withTimeout helper connectBackend
 * already used, bounded by the backend's connect_timeout_ms.
 *
 * This test drives the reconnect through POST /admin/reload/:name, which shares
 * ensureReconnected() with all three callers above.
 */
import { createServer, type Server, type Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootGateway, getFreePort, type BootedGateway } from "./harness.js";

/** Connect timeout for the black-hole backend. Short so the test stays fast. */
const CONNECT_TIMEOUT_MS = 500;

/**
 * A TCP listener that accepts connections and then says nothing, ever. It never
 * writes an HTTP response, so a client request against it hangs until something
 * on the client side gives up. Sockets are retained so close() can destroy them
 * (a hung socket would otherwise keep the server from closing).
 */
async function blackHoleServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const port = await getFreePort();
  const sockets: Socket[] = [];
  const server: Server = createServer((socket) => {
    sockets.push(socket);
    // Deliberately no response, no end, no error: swallow everything.
    socket.on("error", () => {});
    socket.resume();
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("reconnect path is bounded by connect_timeout_ms (STAB-3)", () => {
  let blackHole: Awaited<ReturnType<typeof blackHoleServer>>;
  let gw: BootedGateway;

  beforeAll(async () => {
    blackHole = await blackHoleServer();
    // rawBackends so connect_timeout_ms can be set verbatim. restart_policy
    // "never" keeps the 30s health monitor from racing this test's explicit
    // reconnect; the code path under test is the same either way.
    gw = await bootGateway({
      backends: {},
      rawBackends: {
        blackhole: {
          transport: "http",
          url: blackHole.url,
          namespace: "blackhole",
          connect_timeout_ms: CONNECT_TIMEOUT_MS,
          restart_policy: "never",
        },
      },
    });
  }, 30_000);

  afterAll(async () => {
    await gw.stop();
    await blackHole.close();
  });

  it("boots despite a backend that accepts sockets and never answers", async () => {
    // The initial connect already had a timeout (connectBackend), so the point
    // here is only that the gateway is serving and honest about the backend.
    const res = await fetch(`${gw.adminUrl}/healthz`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.backends.total).toBe(1);
    expect(body.backends.connected).toBe(0);
  });

  it("reconnect REJECTS within the timeout instead of hanging forever", async () => {
    const started = Date.now();
    const res = await fetch(`${gw.adminUrl}/admin/reload/blackhole`, { method: "POST" });
    const elapsed = Date.now() - started;

    // Before the fix this request never resolved and the test died on its own
    // timeout. The assertion that matters is that it settles at all, promptly.
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/timed out/i);

    // Generous ceiling (the timeout plus scheduling slack) so the test is not
    // flaky on a loaded machine, while still failing hard on an unbounded await.
    expect(elapsed).toBeLessThan(CONNECT_TIMEOUT_MS + 4_000);
  }, 20_000);

  it("a bounded failed reconnect leaves the backend reusable, not wedged", async () => {
    // The single-flight entry in reconnectInflight must be released even when
    // the reconnect times out, otherwise the first timeout would permanently
    // pin the backend and every later attempt would await a dead promise.
    const res = await fetch(`${gw.adminUrl}/admin/reload/blackhole`, { method: "POST" });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/timed out/i);
  }, 20_000);
});
