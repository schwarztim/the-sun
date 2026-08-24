/**
 * Gate 4 — Wire-fingerprint.
 *
 * SCOPE (read this before trusting a pass): this gate measures a fingerprint
 * only when the server declares `requiresBrowserTLS`/`antiBot` AND is on the
 * Python (curl_cffi) path. Every other case returns `passed: true` with
 * `verified: false` and a message saying NOT VERIFIED, which is also rolled up
 * into `lab-report.json`'s `unverifiedGates`. In particular a Go server is never
 * measured here: see the isGoServer branch below for why. Treat a pass from this
 * gate as evidence only when the finding's `verified` field is absent.
 *
 * Primary mechanism: `src/templates/python/http_client.py`'s
 * `maybe_fingerprint_selftest()` — every generated server calls this once at
 * startup, BEFORE the event loop / mcp.run(). When `THESUN_FINGERPRINT_ECHO`
 * (set below to this gate's TLS-capture server) is present, the server fires
 * one throwaway HTTPS GET through the real `CurlCffiTransport`, independent
 * of any target credential. This resolves the credential-free-vs-real-egress
 * tension: the fingerprint is proven without needing the target's auth to
 * succeed (previously, lazy-auth servers like the `rest-bearer` golden
 * fixture never opened a socket credential-free, so this gate could only
 * ever report "no egress observed" for them — see 2026-07-02 integration
 * notes).
 *
 * Fallback mechanism: for servers that don't implement the self-test hook
 * (or haven't been regenerated with it yet), this gate ALSO redirects the
 * upstream base-URL env var at the same capture server and invokes one tool
 * to trigger egress the original way — the same capture server accepts
 * either connection, whichever arrives first wins (the capture resolves
 * once). No timing race is required: both mechanisms target one endpoint.
 *
 * The anchors (JA4_PREFIX / JA4_CIPHER_HASH) are read out of
 * src/templates/python/http_client.py rather than duplicated here, so the
 * Python template stays the single source of truth — if it can't be
 * resolved, this gate fails closed rather than asserting against a
 * guessed/stale value.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { launchAndConnect, resolveBaseUrlEnvVar } from "../harness.js";
import { synthesizeArgs } from "../schema-args.js";
import type { GateFinding, LaunchSpec } from "../types.js";
import { startCaptureServer } from "../wire-capture.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Walks up from this module's own location to find the repo root (the
 * directory containing package.json). `../../templates/...` alone isn't
 * enough: this module lives at `src/lab/gates/` in source but at
 * `dist/lab/gates/` once built, and `templates/python/*.py` is never
 * copied into `dist/` (tsc only emits compiled TS) — so the relative
 * offset from THIS file's location differs depending on whether the Lab
 * is running from source (vitest) or from the compiled CLI. Anchoring to
 * the repo root instead of a fixed number of `..` segments works from
 * either location, and avoids hardcoding an absolute machine path (the
 * convention `src/generator/config-abstraction.ts`'s callers use
 * elsewhere via `homedir()` — anchoring to package.json is more portable).
 */
async function findRepoRoot(startDir: string): Promise<string> {
  let dir = startDir;
  for (;;) {
    if (
      await fs
        .access(path.join(dir, "package.json"))
        .then(() => true)
        .catch(() => false)
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`could not locate repo root (package.json) walking up from ${startDir}`);
    }
    dir = parent;
  }
}

async function loadBrowserIdentityAnchors(
  templatePath?: string,
): Promise<{ prefix: string; cipherHash: string }> {
  const resolvedPath =
    templatePath ??
    path.join(await findRepoRoot(HERE), "src", "templates", "python", "http_client.py");
  const content = await fs.readFile(resolvedPath, "utf-8");
  const prefixMatch = content.match(/JA4_PREFIX\s*=\s*"([^"]+)"/);
  const hashMatch = content.match(/JA4_CIPHER_HASH\s*=\s*"([^"]+)"/);
  if (!prefixMatch || !hashMatch) {
    throw new Error(
      `could not resolve JA4_PREFIX/JA4_CIPHER_HASH from ${resolvedPath} — refusing to assert against a stale/guessed value`,
    );
  }
  return { prefix: prefixMatch[1], cipherHash: hashMatch[1] };
}

/**
 * A `go.mod` at the server root is the definitive marker of a Go module. Checked
 * on the filesystem rather than off `spec.command`, which may be any path to a
 * go toolchain ("go", "/usr/local/go/bin/go", a wrapper script).
 */
async function isGoServer(serverDir: string): Promise<boolean> {
  return fs
    .access(path.join(serverDir, "go.mod"))
    .then(() => true)
    .catch(() => false);
}

export async function runWireFingerprintGate(
  serverDir: string,
  spec: LaunchSpec,
  tools: Tool[],
): Promise<GateFinding> {
  // Conditional gate (mirrors rate-limiter.ts): a browser-realistic TLS
  // fingerprint is only REQUIRED when the target declares it performs
  // anti-bot / JA4 fingerprinting on the MCP's outbound calls
  // (requiresBrowserTLS / antiBot in lab.launch.json). For the common
  // REST-API target (api.github.com, etc.) there is no browser-TLS need, so
  // demanding a Chrome-JA4 self-test is a false failure — return an
  // informational pass instead. This is what lets Go dev-API servers score
  // 9/9 while anti-bot targets still REQUIRE the self-test.
  const requiresBrowserTLS = spec.requiresBrowserTLS === true || spec.antiBot === true;
  if (!requiresBrowserTLS) {
    return {
      gate: "wire-fingerprint",
      passed: true,
      verified: false,
      message:
        "NOT VERIFIED (informational-pass): the target does not declare requiresBrowserTLS/antiBot, so no browser-realistic TLS fingerprint was measured. This flag comes from the server's own lab.launch.json, so its absence is a declaration, not evidence.",
    };
  }

  // Go servers cannot be measured by this gate as written. Both of its
  // mechanisms are Python-only: the JA4 anchors are read out of
  // src/templates/python/http_client.py, and the primary
  // THESUN_FINGERPRINT_ECHO self-test hook exists solely in that template
  // (src/generator/go-generator.ts emits no such hook). A Go server therefore
  // falls through to the tool-invocation fallback and is then compared against
  // curl_cffi's Chrome-on-Linux anchors while presenting a uTLS ClientHello, a
  // different handshake. Reporting either verdict from that comparison would be
  // noise, so the gate says so instead of asserting.
  if (await isGoServer(serverDir)) {
    return {
      gate: "wire-fingerprint",
      passed: true,
      verified: false,
      message:
        "NOT VERIFIED: this is a Go server and the gate's JA4 anchors plus its THESUN_FINGERPRINT_ECHO self-test hook exist only on the Python (curl_cffi) path. The server's uTLS fingerprint was not measured. Go fingerprint verification is unimplemented, not passing.",
    };
  }

  if (tools.length === 0) {
    return {
      gate: "wire-fingerprint",
      passed: false,
      skipped: true,
      message: "no tools available to invoke for a wire capture",
    };
  }

  let anchors: { prefix: string; cipherHash: string };
  try {
    anchors = await loadBrowserIdentityAnchors();
  } catch (error) {
    return { gate: "wire-fingerprint", passed: false, message: (error as Error).message };
  }

  const baseUrlEnvVar = resolveBaseUrlEnvVar(spec, serverDir);
  const capture = await startCaptureServer(10_000);
  // "localhost", not "127.0.0.1" — a bare IP literal in the request URL
  // makes curl_cffi (correctly, per RFC 6066) omit the SNI extension, which
  // would make the JA4 "SNI" flag read "i" instead of "d" and desync the
  // extension count by one, producing a false anchor mismatch unrelated to
  // the actual browser impersonation. "localhost" still resolves to the
  // loopback interface this capture server is bound to, but is a real
  // hostname as far as the TLS client is concerned, so SNI is sent —
  // matching how a real target hostname behaves. Empirically confirmed
  // 2026-07-02 against curl_cffi 0.15.0 (see wire-capture.test.ts's frozen
  // fixture, captured the same way).
  const echoAddress = `localhost:${capture.port}`;

  let spawned: Awaited<ReturnType<typeof launchAndConnect>> | null = null;
  let spawnError: string | null = null;
  let mechanism: "self-test" | "tool-invocation" | "none" = "none";
  try {
    spawned = await launchAndConnect(serverDir, spec, {
      // Primary: maybe_fingerprint_selftest() fires at startup, BEFORE the
      // MCP port opens — by the time launchAndConnect resolves (its
      // readiness poll alone takes >=150ms), a same-machine loopback
      // self-test has already had ample time to reach the capture server.
      THESUN_FINGERPRINT_ECHO: echoAddress,
      // Fallback target, in case the server doesn't self-test.
      [baseUrlEnvVar]: `https://${echoAddress}`,
    });

    if (await isSettledWithin(capture.result, 50)) {
      mechanism = "self-test";
    } else {
      // Server doesn't implement the self-test hook (or it didn't fire) —
      // trigger egress the original way. Harmless even if the self-test
      // lands concurrently: the capture server accepts either connection
      // and resolves on whichever ClientHello arrives first.
      const tool = tools[0];
      await spawned.client
        .callTool({ name: tool.name, arguments: synthesizeArgs(tool.inputSchema) })
        .catch(() => undefined);
      mechanism = "tool-invocation";
    }
  } catch (error) {
    spawnError = error instanceof Error ? error.message : String(error);
  } finally {
    if (spawned) await spawned.close();
  }

  const result = await capture.result;
  capture.close();

  if (!result.ja4) {
    const reason = result.error ?? spawnError ?? "unknown reason";
    return {
      gate: "wire-fingerprint",
      passed: false,
      message: `no TLS ClientHello observed from the generated server (${reason}) — the server may not implement maybe_fingerprint_selftest(), the tool may not call out over HTTPS, or ${baseUrlEnvVar} isn't wired to the browser-fingerprinted http client`,
      detail: { mechanism, ja4: null },
    };
  }

  const passed = result.ja4.startsWith(anchors.prefix) && result.ja4.includes(anchors.cipherHash);
  return {
    gate: "wire-fingerprint",
    passed,
    message: passed
      ? `JA4 ${result.ja4} matches the Chrome-Linux anchors (prefix ${anchors.prefix}, cipher hash ${anchors.cipherHash}) [via ${mechanism}]`
      : `JA4 ${result.ja4} does NOT match the Chrome-Linux anchors (expected prefix ${anchors.prefix}, cipher hash ${anchors.cipherHash}) [via ${mechanism}]`,
    detail: { mechanism, ja4: result.ja4 },
  };
}

/**
 * True if `promise` resolves within `graceMs`, without consuming its
 * eventual value destructively (promises are safe to await more than once).
 */
async function isSettledWithin(promise: Promise<unknown>, graceMs: number): Promise<boolean> {
  const pending = Symbol("pending");
  const outcome = await Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(pending), graceMs)),
  ]);
  return outcome !== pending;
}
