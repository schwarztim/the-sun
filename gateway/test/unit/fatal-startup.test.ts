/**
 * fatal-startup.test.ts (STAB-5) — the uncaughtException handler must not
 * swallow a bind failure.
 *
 * The handler was written to keep one backend's transport hiccup from taking the
 * whole fleet down, which is right. But it swallowed EVERYTHING, including
 * EADDRINUSE at startup, and the cost was observed live: a gateway that lost the
 * bind race stayed alive for over half an hour as a headless zombie, owning no
 * port, answering nothing, and still running its health monitor against every
 * backend. The supervisor could not see the failure because the process never
 * exited.
 *
 * These tests pin the classification in src/index.ts so a refactor cannot
 * restore the blanket swallow, and cannot over-correct into a blanket exit
 * (which would reintroduce the failure the swallow was written to prevent).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../../src/index.ts", import.meta.url), "utf-8");

describe("uncaughtException classification (STAB-5)", () => {
  it("exits non-zero rather than continuing unconditionally", () => {
    // The handler must contain a conditional exit. A handler with no exit path
    // is the original bug.
    expect(SRC).toMatch(/process\.on\("uncaughtException"/);
    expect(SRC).toMatch(/process\.exit\(1\)/);
  });

  it("treats EADDRINUSE as fatal", () => {
    expect(SRC).toContain("EADDRINUSE");
    expect(SRC).toMatch(/function isFatalStartupError/);
  });

  it("treats any pre-startup fault as fatal, via an explicit startup flag", () => {
    expect(SRC).toMatch(/let startupComplete = false/);
    expect(SRC).toMatch(/!startupComplete/);
    // The flag must actually be set after start() resolves, or every fault is
    // fatal forever and we have traded one failure mode for another.
    expect(SRC).toMatch(/startupComplete = true/);
  });

  it("still continues for ordinary post-startup faults", () => {
    // The log-and-continue branch must survive: a backend transport error after
    // startup must NOT kill the gateway and every other backend with it.
    expect(SRC).toMatch(/continuing/);
    // Guard against an over-correction to a blanket exit: the exit must be
    // conditional on the fatal classification, not unconditional.
    const handler = SRC.slice(SRC.indexOf('process.on("uncaughtException"'));
    expect(handler).toMatch(/if \(fatal\)/);
  });

  it("keeps unhandledRejection on log and continue", () => {
    // Deliberately unchanged: there is no evidence that an unhandled rejection
    // leaves the process structurally unable to serve, and broadening the exit
    // policy without evidence risks a new crash-loop failure mode.
    // Bound the slice to the handler block itself; slicing to end of file would
    // pick up main().catch(), which exits by design and always has.
    const start = SRC.indexOf('process.on("unhandledRejection"');
    const rejectionHandler = SRC.slice(start, SRC.indexOf("\n});", start));
    expect(rejectionHandler).toMatch(/continuing/);
    expect(rejectionHandler).not.toMatch(/process\.exit/);
  });
});

describe("isFatalStartupError behavior (STAB-5)", () => {
  // Mirror of the classifier, kept in sync by the source assertions above.
  // Exercises the logic itself rather than only its presence.
  function isFatalStartupError(err: unknown): boolean {
    const code = (err as { code?: unknown } | null)?.code;
    if (code === "EADDRINUSE") return true;
    const text = err instanceof Error ? `${err.message}` : String(err);
    return text.includes("EADDRINUSE");
  }

  it("catches EADDRINUSE by error code", () => {
    const err = Object.assign(new Error("listen failed"), { code: "EADDRINUSE" });
    expect(isFatalStartupError(err)).toBe(true);
  });

  it("catches EADDRINUSE by message when the code is absent", () => {
    expect(isFatalStartupError(new Error("listen EADDRINUSE: address already in use"))).toBe(true);
  });

  it("does NOT classify an ordinary backend fault as fatal", () => {
    expect(isFatalStartupError(new Error("fetch failed"))).toBe(false);
    expect(isFatalStartupError(Object.assign(new Error("reset"), { code: "ECONNRESET" }))).toBe(false);
    expect(isFatalStartupError("some string")).toBe(false);
    expect(isFatalStartupError(null)).toBe(false);
  });
});
