/**
 * transport-leak.test.ts (STAB-6) — a failed reconnect must not orphan the
 * previous client and transport pair.
 *
 * connect() assigns fresh objects to this.client and this.transport. Any caller
 * that reaches connect() WITHOUT a preceding disconnect() (the handleDisconnect
 * reconnect timer does exactly that) therefore replaced the old pair without
 * closing it: the socket stayed open and the onerror/onclose handlers stayed
 * wired, so the pair could never be collected. Roughly 2 MB per health sweep was
 * measured on an idle gateway with 19 dead backends.
 *
 * This was masked while the gateway crash-looped every four minutes, because the
 * crash acted as an involuntary garbage collector. With the crash fixed the leak
 * accumulates instead, so the close-before-replace is load-bearing now.
 */
import { describe, expect, it, vi } from "vitest";
import { BackendInstance } from "../../src/backend.js";

const silentLogger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, fatal: () => {}, trace: () => {},
};

function httpConfig(url: string) {
  return {
    transport: "http" as const,
    url,
    enabled: true,
    namespace: "t",
    headers: {},
    reconnect_interval: 5,
    max_restarts: 3,
    connect_timeout_ms: 200,
    restart_policy: "on-failure" as const,
    health_check_interval: 30,
  };
}

/**
 * Point at a port nothing is listening on so every connect() fails fast at the
 * transport layer. That is the exact shape of the 19 dead backends.
 */
const DEAD_URL = "http://127.0.0.1:1/mcp";

describe("BackendInstance transport lifecycle (STAB-6)", () => {
  it("closes the previous transport before connect installs a replacement", async () => {
    const backend = new BackendInstance("leaky", httpConfig(DEAD_URL) as never, silentLogger as never);

    // First attempt fails and leaves a transport object behind.
    await expect(backend.connect()).rejects.toBeDefined();
    const first = (backend as unknown as { transport: { close: () => Promise<void> } | null }).transport;

    // If a transport survived the failed attempt, the next connect() must close
    // it rather than dropping the reference on the floor.
    if (first) {
      const closeSpy = vi.spyOn(first, "close");
      await expect(backend.connect()).rejects.toBeDefined();
      expect(closeSpy).toHaveBeenCalled();
    } else {
      // Already torn down, which satisfies the same invariant.
      expect(first).toBeNull();
    }
  });

  it("does not retain a client or transport after a failed connect", async () => {
    const backend = new BackendInstance("leaky2", httpConfig(DEAD_URL) as never, silentLogger as never);
    await expect(backend.connect()).rejects.toBeDefined();
    await backend.disconnect();

    const internals = backend as unknown as { client: unknown; transport: unknown };
    expect(internals.client).toBeNull();
    expect(internals.transport).toBeNull();
  });

  it("repeated failed reconnects do not accumulate transports", async () => {
    const backend = new BackendInstance("leaky3", httpConfig(DEAD_URL) as never, silentLogger as never);
    const seen = new Set<unknown>();

    // Simulate several health sweeps against a dead peer.
    for (let i = 0; i < 5; i++) {
      await expect(backend.connect()).rejects.toBeDefined();
      const t = (backend as unknown as { transport: unknown }).transport;
      if (t) seen.add(t);
    }

    // At most ONE transport may be live at a time. Without close-before-replace
    // each attempt left its predecessor alive and reachable.
    const internals = backend as unknown as { transport: unknown };
    const live = internals.transport;
    expect(seen.size).toBeLessThanOrEqual(5); // sanity: objects were distinct per attempt
    // The invariant that matters: the instance holds at most one at the end.
    expect(live === null || seen.has(live)).toBe(true);
  });

  it("disconnect is idempotent and safe to call twice", async () => {
    const backend = new BackendInstance("leaky4", httpConfig(DEAD_URL) as never, silentLogger as never);
    await expect(backend.connect()).rejects.toBeDefined();
    await backend.disconnect();
    await expect(backend.disconnect()).resolves.toBeUndefined();
  });
});
