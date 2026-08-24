/**
 * index.ts — orchestrate the dependency-guard pipeline and expose the route.
 *
 * assessInstallCommand: parse → resolve version → existence + OSV scan (cached)
 * → compute safe version → policy decision. Fail-open throughout: a parse-null,
 * an unknown verdict, or any thrown error resolves to null (allow). A warn can
 * never block (that is the caller's contract).
 *
 * registerDepScanRoute: mounts POST /dep-scan, loopback-gated exactly like the
 * gateway's /approve route (reuses the same MCP_GATEWAY_ADMIN_TOKEN → loopback
 * check). The route is a PURE NEW FILE — gateway.ts wiring is done at
 * integration (see the report for the exact line).
 */
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { createHash, timingSafeEqual } from "node:crypto";

import { parseInstallCommand } from "./parse.js";
import { resolveScanVersion } from "./resolve-version.js";
import { scanOne, type LocalScanner } from "./osv.js";
import { computeSafeVersion } from "./safe-version.js";
import { checkExistence } from "./existence.js";
import { createScanCache, type ScanCache } from "./cache.js";
import { assessScanResults } from "./policy.js";
import { mapLimit, DEFAULT_CONCURRENCY } from "./limit.js";
import type { Decision, Ecosystem, FetchLike, PkgResult, PkgSpec, ScanVerdict } from "./types.js";

/** Resolve the per-request fan-out ceiling (DEP_SCAN_CONCURRENCY overrides). */
function scanConcurrency(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.DEP_SCAN_CONCURRENCY);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_CONCURRENCY;
}

/** Injectable dependencies — all default to the real implementations. */
export interface AssessDeps {
  fetchFn?: FetchLike;
  cache?: ScanCache;
  localScanners?: LocalScanner[];
  resolveVersion?: (eco: Ecosystem, pkg: PkgSpec, fetchFn: FetchLike) => Promise<string | undefined>;
  scan?: (
    eco: Ecosystem,
    name: string,
    version: string | undefined,
    opts: { fetchFn: FetchLike; localScanners?: LocalScanner[] }
  ) => Promise<ScanVerdict>;
  existence?: (
    eco: Ecosystem,
    name: string,
    fetchFn: FetchLike
  ) => Promise<{ exists: boolean; checked: boolean }>;
  env?: NodeJS.ProcessEnv;
}

// Module-level cache singleton shared across requests in the running gateway.
const defaultCache = createScanCache();

/**
 * Assess an install command. Returns a veto/warn decision, or null to allow.
 * Never throws.
 */
export async function assessInstallCommand(cmd: string, deps: AssessDeps = {}): Promise<Decision> {
  const env = deps.env ?? process.env;
  if (env.DEP_SCAN_DISABLE === "1") return null;

  const fetchFn = deps.fetchFn ?? (fetch as unknown as FetchLike);
  const cache = deps.cache ?? defaultCache;
  const resolveVersion = deps.resolveVersion ?? resolveScanVersion;
  const scan = deps.scan ?? scanOne;
  const existence = deps.existence ?? checkExistence;

  try {
    const parsed = parseInstallCommand(cmd);
    if (!parsed) return null; // not an install we scan → allow

    const { ecosystem } = parsed;
    // Bound the per-package fan-out (OPS-5): a large install list must not open
    // unbounded sockets to the registries/OSV at once. mapLimit preserves order.
    const results = await mapLimit(
      parsed.packages,
      scanConcurrency(env),
      async (pkg): Promise<PkgResult> => {
        const [ex, scannedVersion] = await Promise.all([
          existence(ecosystem, pkg.name, fetchFn),
          resolveVersion(ecosystem, pkg, fetchFn),
        ]);

        let verdict = cache.get(ecosystem, pkg.name, scannedVersion);
        if (!verdict) {
          verdict = await scan(ecosystem, pkg.name, scannedVersion, {
            fetchFn,
            localScanners: deps.localScanners,
          });
          cache.set(ecosystem, pkg.name, scannedVersion, verdict);
        }

        return {
          ecosystem,
          name: pkg.name,
          versionSpec: pkg.versionSpec,
          scannedVersion,
          status: verdict.status,
          vulns: verdict.vulns,
          safeVersion: computeSafeVersion(verdict.vulns, scannedVersion),
          notFound: ex.checked && !ex.exists,
        };
      }
    );

    return assessScanResults(results, env);
  } catch {
    return null; // fail-open: an unexpected error must never block an install
  }
}

// ── Loopback gate (mirrors gateway.ts requireAdminAccess exactly) ────────────

function isLoopbackAddress(address: string): boolean {
  return (
    address === "::1" ||
    address === "127.0.0.1" ||
    address === "::ffff:127.0.0.1" ||
    address.startsWith("127.")
  );
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a).digest();
  const digestB = createHash("sha256").update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

function requireLoopback(req: Request, res: Response, next: NextFunction): void {
  const configuredToken = process.env.MCP_GATEWAY_ADMIN_TOKEN;
  if (configuredToken) {
    const expected = `Bearer ${configuredToken}`;
    const provided = req.header("authorization") ?? "";
    if (timingSafeStringEqual(provided, expected)) {
      next();
      return;
    }
    res.status(401).json({ error: "Admin API authorization required" });
    return;
  }

  const remoteAddress = req.socket?.remoteAddress ?? req.ip ?? "";
  if (isLoopbackAddress(remoteAddress)) {
    next();
    return;
  }

  res.status(403).json({
    error: "dep-scan is restricted to loopback clients unless MCP_GATEWAY_ADMIN_TOKEN is set",
  });
}

/** Minimal logger shape (compatible with pino). */
interface RouteLogger {
  error?: (obj: unknown, msg?: string) => void;
}

/**
 * Register POST /dep-scan on the given Express app. Loopback-gated exactly like
 * /approve. Body: { command: string }. Responds { action, message } | null
 * (null = allow). Fail-open: any error responds null.
 *
 * gateway.ts wiring (done at integration, not here):
 *   import { registerDepScanRoute } from "./dep-scan/index.js";
 *   registerDepScanRoute(this.app, this.logger);
 */
export function registerDepScanRoute(app: Express, logger?: RouteLogger): void {
  const jsonBody = express.json();
  app.post("/dep-scan", jsonBody, requireLoopback, async (req: Request, res: Response) => {
    try {
      const command = typeof req.body?.command === "string" ? req.body.command : "";
      const result = command ? await assessInstallCommand(command) : null;
      res.json(result);
    } catch (err) {
      logger?.error?.({ err }, "dep-scan route error");
      res.json(null); // fail-open
    }
  });
}
