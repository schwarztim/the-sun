import pino from "pino";
import pretty from "pino-pretty";

/**
 * Create the gateway logger.
 *
 * ROBUSTNESS (load-bearing): we do NOT use pino's worker-thread transport
 * (`transport: { target: "pino-pretty" }`). That spawns a thread-stream worker;
 * when the worker exits (observed on a backend SSE-drop log during a downstream
 * restart), the next log write emits an unhandled `'error'` event that crashes
 * the ENTIRE gateway — taking every backend down because one backend hiccuped.
 *
 * Instead we run pino-pretty as a SYNCHRONOUS in-process destination stream (no
 * worker to die) and attach an `'error'` guard so a log-write failure can never
 * take the process down. Output still goes to stdout (captured by launchd into
 * the gateway log), still human-readable.
 */
export function createLogger(level: string = "info") {
  const stream = pretty({ colorize: true, translateTime: "SYS:HH:MM:ss" });
  // A logging stream must never be able to crash the gateway.
  if (typeof (stream as { on?: unknown }).on === "function") {
    (stream as unknown as { on(ev: string, cb: () => void): void }).on("error", () => {
      /* swallow — a failed log write is never worth crashing the fleet */
    });
  }
  return pino({ level }, stream);
}

export type Logger = ReturnType<typeof createLogger>;
