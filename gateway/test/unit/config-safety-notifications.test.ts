/**
 * Phase 2: `safety.notifications` config knob — default ON per the roadmap
 * ("notifications: true config default on"), explicitly disableable.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.js";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "gw-config-notify-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("safety.notifications", () => {
  it("defaults ON when absent", async () => {
    const path = join(dir, "default.yaml");
    await writeFile(path, "gateway:\n  port: 3100\n", "utf-8");
    const config = await loadConfig(path);
    expect(config.safety.notifications).toBe(true);
  });

  it("can be switched off", async () => {
    const path = join(dir, "off.yaml");
    await writeFile(path, "gateway:\n  port: 3100\nsafety:\n  notifications: false\n", "utf-8");
    const config = await loadConfig(path);
    expect(config.safety.notifications).toBe(false);
  });
});
