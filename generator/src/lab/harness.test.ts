import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { launchAndConnect, readLaunchSpec, resolveBaseUrlEnvVar } from "./harness.js";
import { startMockBackend } from "./mock-backend.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(HERE, "__fixtures__");

describe("readLaunchSpec", () => {
  it("falls back to FastMCP-shaped defaults when lab.launch.json is absent", async () => {
    const spec = await readLaunchSpec("/tmp/definitely-does-not-exist-thesun-lab");
    expect(spec.transport).toBe("streamable-http");
    expect(spec.command).toBe("python3");
    expect(spec.portEnvVar).toBe("PORT");
  });
});

describe("resolveBaseUrlEnvVar", () => {
  it("matches config-abstraction.ts's generateConfigItems convention", () => {
    const envVar = resolveBaseUrlEnvVar({ transport: "streamable-http" }, "/some/path/my-cool-tool");
    expect(envVar).toBe("MY_COOL_TOOL_BASE_URL");
  });

  it("honors an explicit targetBaseUrlEnvVar override", () => {
    const envVar = resolveBaseUrlEnvVar(
      { transport: "streamable-http", targetBaseUrlEnvVar: "CUSTOM_URL" },
      "/some/path/my-cool-tool",
    );
    expect(envVar).toBe("CUSTOM_URL");
  });
});

describe("launchAndConnect — streamable-http", () => {
  it("spawns the fixture, connects via a bounded readiness poll, lists its tools, and tears down cleanly", async () => {
    const spawned = await launchAndConnect(FIXTURES_DIR, {
      transport: "streamable-http",
      command: "node",
      args: ["mini-http-server.mjs"],
      portEnvVar: "PORT",
      hostEnvVar: "HOST",
      mcpPath: "/mcp",
    });

    try {
      expect(spawned.actualTransport).toBe("streamable-http");
      expect(spawned.proc).not.toBeNull();
      expect(spawned.port).toBeGreaterThan(0);

      const { tools } = await spawned.client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(["call_upstream", "example_help", "ping"]);

      const result = (await spawned.client.callTool({ name: "ping", arguments: {} })) as {
        content: Array<{ type: string; text: string }>;
      };
      expect(result.content[0].text).toBe("pong");
    } finally {
      await spawned.close();
    }

    // Process-group teardown actually killed the child.
    expect(spawned.proc!.exitCode !== null || spawned.proc!.signalCode !== null).toBe(true);
  }, 15_000);

  it("redirects egress via an env-var override, proving the same mechanism the wire-fingerprint/callability gates rely on", async () => {
    const backend = await startMockBackend([{ method: "GET", path: "/" }]);
    const spawned = await launchAndConnect(
      FIXTURES_DIR,
      {
        transport: "streamable-http",
        command: "node",
        args: ["mini-http-server.mjs"],
        portEnvVar: "PORT",
        hostEnvVar: "HOST",
        mcpPath: "/mcp",
      },
      { BASE_URL: `http://127.0.0.1:${backend.port}/` },
    );

    try {
      const result = (await spawned.client.callTool({ name: "call_upstream", arguments: {} })) as {
        content: Array<{ type: string; text: string }>;
      };
      // No Authorization header sent -> mock backend's credential-free path -> 401.
      expect(result.content[0].text).toBe("status 401");
    } finally {
      await spawned.close();
      await backend.close();
    }
  }, 15_000);

  it("throws a descriptive error when the target never starts listening", async () => {
    await expect(
      launchAndConnect(FIXTURES_DIR, {
        transport: "streamable-http",
        command: "node",
        args: ["-e", "setTimeout(() => {}, 60000)"], // spawns but never opens the port
        portEnvVar: "PORT",
        hostEnvVar: "HOST",
      }),
    ).rejects.toThrow(/failed to become ready/);
  }, 25_000);
});

describe("launchAndConnect — stdio (legacy fixture)", () => {
  it("connects over stdio and lists tools", async () => {
    const spawned = await launchAndConnect(FIXTURES_DIR, {
      transport: "stdio",
      command: "node",
      args: ["mini-stdio-server.mjs"],
    });

    try {
      expect(spawned.actualTransport).toBe("stdio");
      expect(spawned.proc).toBeNull(); // the SDK owns the stdio child, not the harness
      const { tools } = await spawned.client.listTools();
      expect(tools.map((t) => t.name)).toEqual(["ping"]);
    } finally {
      await spawned.close();
    }
  }, 15_000);
});
