import { describe, it, expect } from "vitest";
import { resolveScanVersion } from "../../src/dep-scan/resolve-version.js";
import { checkExistence } from "../../src/dep-scan/existence.js";
import type { FetchLike } from "../../src/dep-scan/types.js";

function jsonFetch(byUrl: (url: string) => { ok?: boolean; status?: number; body: unknown }): FetchLike {
  return async (url) => {
    const r = byUrl(url);
    return { ok: r.ok ?? true, status: r.status ?? 200, json: async () => r.body };
  };
}

const throwingFetch: FetchLike = async () => {
  throw new Error("down");
};

describe("resolveScanVersion — pinned exact (no network)", () => {
  const never: FetchLike = async () => {
    throw new Error("should not fetch for a pinned version");
  };

  it("uses a bare pinned version", async () => {
    expect(await resolveScanVersion("npm", { name: "lodash", versionSpec: "4.17.20" }, never)).toBe("4.17.20");
  });
  it("normalizes ==1.2.3 and v1.2.3", async () => {
    expect(await resolveScanVersion("PyPI", { name: "flask", versionSpec: "==2.0.1" }, never)).toBe("2.0.1");
    expect(await resolveScanVersion("npm", { name: "x", versionSpec: "v1.2.3" }, never)).toBe("1.2.3");
  });
});

describe("resolveScanVersion — best-effort latest", () => {
  it("npm latest .version", async () => {
    const f = jsonFetch(() => ({ body: { version: "4.17.21" } }));
    expect(await resolveScanVersion("npm", { name: "lodash" }, f)).toBe("4.17.21");
  });
  it("PyPI .info.version", async () => {
    const f = jsonFetch(() => ({ body: { info: { version: "2.3.3" } } }));
    expect(await resolveScanVersion("PyPI", { name: "flask", versionSpec: ">=2.0" }, f)).toBe("2.3.3");
  });
  it("crates.io .crate.max_stable_version", async () => {
    const f = jsonFetch(() => ({ body: { crate: { max_stable_version: "1.0.190" } } }));
    expect(await resolveScanVersion("crates.io", { name: "serde", versionSpec: "^1" }, f)).toBe("1.0.190");
  });
  it("RubyGems .version", async () => {
    const f = jsonFetch(() => ({ body: { version: "7.1.0" } }));
    expect(await resolveScanVersion("RubyGems", { name: "rails" }, f)).toBe("7.1.0");
  });
  it("Go is skipped → undefined", async () => {
    expect(await resolveScanVersion("Go", { name: "mod" }, throwingFetch)).toBeUndefined();
  });
  it("returns undefined on failure (NEVER throws)", async () => {
    expect(await resolveScanVersion("npm", { name: "x", versionSpec: "latest" }, throwingFetch)).toBeUndefined();
    const bad = jsonFetch(() => ({ ok: false, status: 500, body: {} }));
    expect(await resolveScanVersion("npm", { name: "x" }, bad)).toBeUndefined();
  });
});

describe("checkExistence — 404-only, fail-open", () => {
  it("returns not-found ONLY on a 404", async () => {
    const f = jsonFetch(() => ({ ok: false, status: 404, body: {} }));
    expect(await checkExistence("npm", "lodahs", f)).toEqual({ exists: false, checked: true });
  });
  it("treats a 200 as existing", async () => {
    const f = jsonFetch(() => ({ ok: true, status: 200, body: {} }));
    expect(await checkExistence("npm", "lodash", f)).toEqual({ exists: true, checked: true });
  });
  it("fails open on a network error (exists, not checked)", async () => {
    expect(await checkExistence("npm", "x", throwingFetch)).toEqual({ exists: true, checked: false });
  });
  it("fails open on a non-404 error status", async () => {
    const f = jsonFetch(() => ({ ok: false, status: 500, body: {} }));
    expect(await checkExistence("PyPI", "x", f)).toEqual({ exists: true, checked: true });
  });
  it("skips Go (no 404 endpoint)", async () => {
    expect(await checkExistence("Go", "mod", throwingFetch)).toEqual({ exists: true, checked: false });
  });
});
