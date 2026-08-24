/**
 * gateway.search_semantic / gateway.search_top_k config knobs.
 * search_semantic defaults ON; search_top_k defaults to 8.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.js";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "gw-config-search-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("gateway search config", () => {
  it("defaults: search_semantic ON, search_top_k 8", async () => {
    const path = join(dir, "default.yaml");
    await writeFile(path, "gateway:\n  port: 3100\n", "utf-8");
    const config = await loadConfig(path);
    expect(config.gateway.search_semantic).toBe(true);
    expect(config.gateway.search_top_k).toBe(8);
  });

  it("search_semantic can be disabled and search_top_k overridden", async () => {
    const path = join(dir, "override.yaml");
    await writeFile(
      path,
      "gateway:\n  port: 3100\n  search_semantic: false\n  search_top_k: 20\n",
      "utf-8"
    );
    const config = await loadConfig(path);
    expect(config.gateway.search_semantic).toBe(false);
    expect(config.gateway.search_top_k).toBe(20);
  });

  it("rejects a non-positive search_top_k", async () => {
    const path = join(dir, "bad.yaml");
    await writeFile(path, "gateway:\n  port: 3100\n  search_top_k: 0\n", "utf-8");
    await expect(loadConfig(path)).rejects.toThrow();
  });
});
