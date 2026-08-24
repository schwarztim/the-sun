/**
 * Gate 9 — Rate-limiter presence.
 *
 * Reuses `PatternEngine` + `KNOWN_PATTERNS` (src/patterns/) to decide
 * whether the target is a known-rate-limited service; if so, fails the
 * build when no limiter markers are found in the generated server
 * directory. Language-aware: Python servers carry a `ratelimit.py` template
 * or an `aiolimiter`/`AdaptiveRateLimiter` import; Go servers import
 * `golang.org/x/time/rate` (`rate.NewLimiter`). Pure filesystem + static-data
 * check — no live server needed.
 *
 * SCOPE: this gate never sets `verified: true`. It can only fail (a known
 * rate-limited target shipping no limiter at all) or pass unverified: either the
 * target is absent from KNOWN_PATTERNS so nothing was checked, or a marker was
 * found, which proves an import and not a wired, correctly-budgeted limiter.
 * Both passing branches surface in `lab-report.json`'s `unverifiedGates`.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { PatternEngine } from "../../patterns/pattern-engine.js";
import type { GateFinding } from "../types.js";

// Language-specific limiter markers. Python servers copy a ratelimit.py template
// or import aiolimiter; Go servers import golang.org/x/time/rate (token bucket).
const PY_MARKERS = [
  "aiolimiter",
  "AdaptiveRateLimiter",
  "from .ratelimit",
  "from ratelimit",
  "import ratelimit",
];
const GO_MARKERS = [
  "golang.org/x/time/rate",
  "rate.NewLimiter",
  "rate.Limiter",
];
const SKIP_DIRS = new Set(["__pycache__", "node_modules", ".git", ".venv", "venv", "dist", "build"]);

async function hasLimiterMarker(dir: string): Promise<boolean> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (await hasLimiterMarker(full)) return true;
      continue;
    }
    // Python template file is a limiter by name alone.
    if (entry.name === "ratelimit.py") return true;
    const isPy = entry.name.endsWith(".py");
    const isGo = entry.name.endsWith(".go");
    if (!isPy && !isGo) continue;
    const content = await fs.readFile(full, "utf-8").catch(() => "");
    const markers = isGo ? GO_MARKERS : PY_MARKERS;
    if (markers.some((marker) => content.includes(marker))) return true;
  }
  return false;
}

export async function runRateLimiterGate(serverDir: string, targetName: string): Promise<GateFinding> {
  const pattern = new PatternEngine().matchKnownPattern(targetName);
  const knownRateLimited = pattern?.rateLimiting.hasRateLimiting ?? false;

  if (!knownRateLimited) {
    return {
      gate: "rate-limiter",
      passed: true,
      verified: false,
      message: `NOT VERIFIED (informational-pass): "${targetName}" is not in KNOWN_PATTERNS, so nothing was checked. Absence from the pattern table is not evidence the target is unthrottled.`,
    };
  }

  const present = await hasLimiterMarker(serverDir);
  return {
    gate: "rate-limiter",
    passed: present,
    // Even the affirmative branch is `verified: false`. Finding the marker
    // proves a limiter is IMPORTED, not that it is wired into the request path
    // or that its budget matches the target's real limits. Behavioral
    // verification would need a live throughput test against a mock backend,
    // which this gate deliberately does not do.
    verified: false,
    message: present
      ? `NOT VERIFIED (presence check only): "${targetName}" is known-rate-limited and a limiter marker was found in the generated server, but this gate greps for the import; it does not prove the limiter is wired into the request path or correctly budgeted.`
      : `"${targetName}" is known-rate-limited (KNOWN_PATTERNS) but no rate limiter was found in the generated server`,
  };
}
