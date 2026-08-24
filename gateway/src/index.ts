import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { Gateway } from "./gateway.js";

const configPath = resolve(process.env.MCP_GATEWAY_CONFIG ?? "config.yaml");

/**
 * True once gateway.start() has resolved: the listener is bound and the initial
 * backend pass is done. Until then the process has no proven-good state, so an
 * uncaught exception is treated as fatal (see the handler below).
 */
let startupComplete = false;

/**
 * Is this error one the process can never recover from by staying alive?
 *
 * Currently exactly one condition qualifies, and it is proven rather than
 * hypothetical: EADDRINUSE. A gateway that cannot bind its port can never serve
 * a single request, but it WILL keep running its health monitor, so swallowing
 * the bind failure produces a headless zombie that doubles connect load on every
 * backend while owning no port and answering nothing. That is not a thought
 * experiment: pid 51678 was observed alive for over half an hour in exactly that
 * state, invisible to the supervisor because the process never exited.
 *
 * Deliberately narrow. A blanket exit would trade this failure mode for the one
 * the swallow was written to prevent (one backend's transport hiccup killing the
 * whole fleet), which is why the classification is by condition, not by default.
 */
function isFatalStartupError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "EADDRINUSE") return true;
  const text = err instanceof Error ? `${err.message}` : String(err);
  return text.includes("EADDRINUSE");
}

// Fleet-control-plane resilience: a single stray error (a backend transport
// hiccup, a downstream restart, a library 'error' event) must NOT crash the
// gateway and take all backends down with it. Log to stderr directly, NOT via
// the pino logger, so a fault in logging itself can never recurse, and keep
// running. Installed before anything else so it also covers startup.
//
// The exception to "keep running" (STAB-5): a fault BEFORE startup completes, or
// a bind failure at any time, is fatal. The process exits non-zero so the
// supervisor sees a real failure and can retry, instead of adopting a process
// that is alive but structurally incapable of serving.
process.on("uncaughtException", (err) => {
  const fatal = !startupComplete || isFatalStartupError(err);
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  try {
    process.stderr.write(
      `[gateway] uncaughtException (${fatal ? "FATAL, exiting 1" : "continuing"}): ${detail}\n`,
    );
  } catch {
    /* stderr write failed, nothing safe left to do */
  }
  if (fatal) {
    process.exit(1);
  }
});
process.on("unhandledRejection", (reason) => {
  try {
    process.stderr.write(`[gateway] unhandledRejection (continuing): ${String(reason)}\n`);
  } catch {
    /* ignore */
  }
});

async function main() {
  const config = await loadConfig(configPath);
  const logger = createLogger(config.gateway.log_level);

  logger.info(`Loading config from ${configPath}`);

  const gateway = new Gateway(config, configPath, logger);

  // Graceful shutdown
  const shutdown = async () => {
    await gateway.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await gateway.start();

  // From here on the listener is bound and the first backend pass is done, so a
  // stray fault is survivable and the log-and-continue policy applies. Before
  // this point it is not: see the uncaughtException handler above.
  startupComplete = true;
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
