/**
 * Proves http_client.py's browser-camouflage override: when
 * <THESUN_HOME>/camouflage.json is present (written by fleetd's
 * internal/camouflage package from a detection of the OPERATOR'S OWN
 * machine/browser), the curl_cffi `impersonate` target and `User-Agent`
 * actually used for outbound requests come from that file instead of the
 * hardcoded Chrome-131 default -- and the hardcoded default survives
 * untouched when the file is absent, unreadable, or malformed.
 *
 * Structural assertions run directly against the source (no interpreter
 * needed). The behavioral test shells out to a real Python 3 interpreter
 * (same convention as ratelimit.test.ts / gates/wire-fingerprint.selftest.
 * test.ts) but strips the third-party imports (`curl_cffi` and `httpx`)
 * first, since neither is expected to be installed in this dev/CI
 * environment -- the identity-resolution logic under test (_thesun_home /
 * _load_camouflage_config / _build_identity) is pure stdlib and needs
 * neither to run.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = path.join(HERE, "http_client.py");
const SOURCE = fs.readFileSync(SOURCE_PATH, "utf-8");

describe("http_client.py — structure", () => {
  it("imports curl_cffi and uses AsyncSession-backed impersonation", () => {
    expect(SOURCE).toContain("from curl_cffi.requests import AsyncSession");
  });

  it("reads <THESUN_HOME>/camouflage.json for the browser profile", () => {
    expect(SOURCE).toContain("def _thesun_home()");
    expect(SOURCE).toContain("def _load_camouflage_config()");
    expect(SOURCE).toContain('"THESUN_HOME"');
    expect(SOURCE).toContain('"camouflage.json"');
  });

  it("falls back to the Chrome-131 default when no override is found", () => {
    expect(SOURCE).toContain('_IMPERSONATE = "chrome131"');
    // _load_camouflage_config never raises to the caller.
    expect(SOURCE).toMatch(/except \(OSError, ValueError\):\s*\n\s*return None/);
  });

  it("CurlCffiTransport's default impersonate comes from BROWSER_IDENTITY (not the hardcoded constant)", () => {
    // This is the real wiring: BROWSER_IDENTITY reflects the camouflage
    // override when present, and the transport must actually use it, not
    // just compute it and never read it.
    expect(SOURCE).toContain('impersonate: str = BROWSER_IDENTITY["impersonate"]');
  });

  it("identity headers (User-Agent, Sec-CH-UA-Platform) are built from BROWSER_IDENTITY", () => {
    expect(SOURCE).toContain('"User-Agent": BROWSER_IDENTITY["user_agent"]');
    expect(SOURCE).toContain('"Sec-CH-UA-Platform": BROWSER_IDENTITY["sec_ch_ua_platform"]');
  });
});

describe("http_client.py — camouflage override behavior (real interpreter)", () => {
  const python = "python3";
  // Spawning an interpreter and compiling the template is slower than
  // vitest's 5s default on a loaded machine or a cold CI runner.
  const INTERPRETER_TIMEOUT_MS = 30_000;

  function runIdentityCheck(thesunHome: string): { impersonate: string; platform: string; user_agent: string } {
    // Strip the third-party imports and exec the rest, then print
    // _build_identity() as JSON. This test is identity-only: it never touches
    // AsyncSession or httpx, so requiring either to be installed would only
    // make the test fail wherever they are absent (as it did in CI) without
    // checking anything more. Keeping it hermetic means it needs nothing but a
    // Python interpreter.
    const patched = SOURCE.replace(
      "from curl_cffi.requests import AsyncSession",
      "AsyncSession = object  # stripped for identity-only test",
    ).replace(
      /^import httpx$/m,
      // A bare `httpx = None` is not enough: the module subclasses
      // httpx.AsyncBaseTransport at import time, so the name has to yield a
      // usable base class. Every other httpx reference is inside a function
      // body or an annotation (unevaluated under `from __future__ import
      // annotations`), so returning `object` for any attribute is sufficient.
      [
        "class _StrippedHttpx:  # stripped for identity-only test",
        "    def __getattr__(self, name):",
        "        return object",
        "",
        "",
        "httpx = _StrippedHttpx()",
      ].join("\n"),
    );
    const driver = `
import json, sys
ns = {}
exec(compile(sys.stdin.read(), "http_client.py", "exec"), ns)
print(json.dumps(ns["_build_identity"]()))
`;
    const out = execFileSync(python, ["-c", driver], {
      input: patched,
      env: { ...process.env, THESUN_HOME: thesunHome },
      encoding: "utf-8",
    });
    return JSON.parse(out);
  }

  it("uses the hardcoded Chrome-131 default when camouflage.json is absent", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "thesun-camo-absent-"));
    try {
      const ident = runIdentityCheck(dir);
      expect(ident.impersonate).toBe("chrome131");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, INTERPRETER_TIMEOUT_MS);

  it("overrides impersonate + user_agent from a valid camouflage.json (Edge/Windows)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "thesun-camo-edge-"));
    try {
      fs.writeFileSync(
        path.join(dir, "camouflage.json"),
        JSON.stringify({
          os: "windows",
          browser: "edge",
          browser_version: "120.0.6099.129",
          impersonate: "edge101",
          user_agent:
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
          tls_profile: "HelloEdge_106",
        }),
      );
      const ident = runIdentityCheck(dir);
      expect(ident.impersonate).toBe("edge101");
      expect(ident.platform).toBe("windows");
      // The user_agent is passed through from camouflage.json VERBATIM
      // (fleetd's camouflage package, not this Python client, owns UA
      // construction) -- so this must be the exact string from the config,
      // not a reconstruction from browser_version.
      expect(ident.user_agent).toContain("Edg/120.0.0.0");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, INTERPRETER_TIMEOUT_MS);

  it("falls back to the default on malformed camouflage.json instead of crashing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "thesun-camo-bad-"));
    try {
      fs.writeFileSync(path.join(dir, "camouflage.json"), "not json");
      const ident = runIdentityCheck(dir);
      expect(ident.impersonate).toBe("chrome131");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, INTERPRETER_TIMEOUT_MS);

  it("falls back to the default when camouflage.json is missing required fields", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "thesun-camo-incomplete-"));
    try {
      fs.writeFileSync(path.join(dir, "camouflage.json"), JSON.stringify({ os: "linux" }));
      const ident = runIdentityCheck(dir);
      expect(ident.impersonate).toBe("chrome131");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, INTERPRETER_TIMEOUT_MS);
});
