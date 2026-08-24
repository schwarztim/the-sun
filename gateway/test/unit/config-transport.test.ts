import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "gw-config-transport-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeConfig(name: string, yaml: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, yaml, "utf-8");
  return path;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("config transport constitution", () => {
  it("strips stdio backends pre-parse and boots on with remaining backends", async () => {
    const path = await writeConfig(
      "mixed.yaml",
      `
gateway:
  port: 3100
backends:
  good_http:
    transport: http
    url: http://127.0.0.1:9001/mcp
    namespace: good_http
  bad_stdio:
    transport: stdio
    command: /usr/local/bin/some-server
    args: ["--flag"]
    namespace: bad_stdio
`
    );

    const config = await loadConfig(path);
    expect(config.backends.bad_stdio).toBeUndefined();
    expect(config.backends.good_http).toBeDefined();
    expect(config.backends.good_http.transport).toBe("http");
  });

  it("strips command-style entries with no url even without an explicit transport", async () => {
    const path = await writeConfig(
      "implicit-stdio.yaml",
      `
backends:
  implicit_stdio:
    command: /usr/bin/legacy-server
    namespace: implicit_stdio
  good_http:
    transport: http
    url: http://127.0.0.1:9002/mcp
    namespace: good_http
`
    );

    const config = await loadConfig(path);
    expect(config.backends.implicit_stdio).toBeUndefined();
    expect(config.backends.good_http).toBeDefined();
  });

  it("parses sse backend entries", async () => {
    const path = await writeConfig(
      "sse.yaml",
      `
backends:
  my_sse:
    transport: sse
    url: http://127.0.0.1:9003/sse
    namespace: my_sse
`
    );

    const config = await loadConfig(path);
    expect(config.backends.my_sse).toBeDefined();
    expect(config.backends.my_sse.transport).toBe("sse");
  });

  it("defaults safety.enforce to blocking", async () => {
    const path = await writeConfig("empty.yaml", "gateway:\n  port: 3100\n");
    const config = await loadConfig(path);
    expect(config.safety.enforce).toBe("blocking");
  });

  it("defaults safety.decision_log to ENABLED with the standard path (fail-closed audit, 2026-06-10)", async () => {
    const path = await writeConfig("empty2.yaml", "gateway:\n  port: 3100\n");
    const config = await loadConfig(path);
    expect(config.safety.decision_log).toEqual({
      enabled: true,
      path: "~/.mcp-gateway/decisions.jsonl",
      max_size_mb: 50,
      max_files: 5,
    });
  });
});
