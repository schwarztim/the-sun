/**
 * OPS-3: ManifestRegistry hot-reload. Editing/adding a manifest file and
 * calling reload() reclassifies tools WITHOUT a gateway restart; a corrupt
 * manifest on reload keeps the prior good manifests and never throws.
 *
 * Hermetic: real manifest files in a temp dir, no gateway boot.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManifestRegistry } from "../../src/manifest.js";
import type { Logger } from "../../src/logger.js";

function fakeLogger(): Logger {
  return {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

/** Write a single-capability manifest for backend "svc". */
function writeManifest(dir: string, tool: string, safetyClass: string): void {
  const manifest = {
    manifest: "isaac-router-manifest/v1",
    backend: "svc",
    capabilities: [{ tool, safety_class: safetyClass, tags: [] }],
  };
  writeFileSync(join(dir, "svc.json"), JSON.stringify(manifest), "utf-8");
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gw-manifest-reload-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("ManifestRegistry.reload — reclassify on edit without restart", () => {
  it("re-reads an edited manifest so a tool is reclassified", () => {
    // do_thing is verb-less, so a READ manifest label is valid (no RISKY_AS_READ).
    writeManifest(dir, "do_thing", "READ");
    const reg = new ManifestRegistry(fakeLogger(), dir);
    expect(reg.classify("svc", "do_thing", "svc_do_thing").safetyClass).toBe("READ");
    expect(reg.classify("svc", "do_thing", "svc_do_thing").source).toBe("manifest");

    // Edit the manifest on disk and reload (no new registry constructed).
    writeManifest(dir, "do_thing", "WRITE");
    reg.reload();
    expect(reg.classify("svc", "do_thing", "svc_do_thing").safetyClass).toBe("WRITE");
  });

  it("picks up a NEWLY ADDED manifest so a previously unclassified tool is classified", () => {
    // Empty dir: verb-less unmanifested tool is UNCLASSIFIED (fail-closed).
    const reg = new ManifestRegistry(fakeLogger(), dir);
    expect(reg.classify("svc", "do_thing", "svc_do_thing").safetyClass).toBe("UNCLASSIFIED");

    // Add a manifest and reload: now classified from the manifest.
    writeManifest(dir, "do_thing", "READ");
    reg.reload();
    const after = reg.classify("svc", "do_thing", "svc_do_thing");
    expect(after.safetyClass).toBe("READ");
    expect(after.source).toBe("manifest");
  });
});

describe("ManifestRegistry.reload — fail-safe on a corrupt manifest", () => {
  it("keeps the prior manifests and does NOT throw when a manifest becomes corrupt", () => {
    writeManifest(dir, "do_thing", "READ");
    const logger = fakeLogger();
    const reg = new ManifestRegistry(logger, dir);
    expect(reg.classify("svc", "do_thing", "svc_do_thing").safetyClass).toBe("READ");

    // Corrupt the manifest file (invalid JSON) and reload.
    writeFileSync(join(dir, "svc.json"), "{ this is not valid json", "utf-8");
    expect(() => reg.reload()).not.toThrow();

    // Prior good classification is retained (fresh index was not swapped in).
    expect(reg.classify("svc", "do_thing", "svc_do_thing").safetyClass).toBe("READ");
    expect(reg.classify("svc", "do_thing", "svc_do_thing").source).toBe("manifest");
    // A warning was logged about keeping prior manifests.
    expect(logger.warn).toHaveBeenCalled();
  });

  it("keeps prior manifests when the directory becomes unreadable", () => {
    writeManifest(dir, "do_thing", "READ");
    const reg = new ManifestRegistry(fakeLogger(), dir);
    expect(reg.classify("svc", "do_thing", "svc_do_thing").safetyClass).toBe("READ");

    // Remove the whole directory, then reload: prior index retained, no throw.
    rmSync(dir, { recursive: true, force: true });
    expect(() => reg.reload()).not.toThrow();
    expect(reg.classify("svc", "do_thing", "svc_do_thing").safetyClass).toBe("READ");
  });

  it("getManifestDir returns the resolved directory", () => {
    const reg = new ManifestRegistry(fakeLogger(), dir);
    expect(reg.getManifestDir()).toContain("gw-manifest-reload-");
  });
});
