/**
 * fetch-timeout.ts (OPS-5) — wrap every outbound dep-scan fetch with an
 * AbortController + setTimeout so a hung registry/OSV endpoint aborts instead of
 * hanging the install-gating request.
 *
 * The timeout is a degradation, not a new failure mode: a real fetch rejects
 * when the signal fires, and every caller (osv.ts, resolve-version.ts,
 * existence.ts) already treats a thrown/rejected fetch as fail-open (unknown /
 * undefined / exists:true). So a timeout degrades identically to a network
 * error that was already handled. No behavior change on the success path.
 */
import type { FetchLike } from "./types.js";

type FetchInit = Parameters<FetchLike>[1];
type FetchResult = Awaited<ReturnType<FetchLike>>;

/** Default outbound timeout (ms); DEP_SCAN_FETCH_TIMEOUT_MS overrides at call time. */
export const DEFAULT_FETCH_TIMEOUT_MS = 4000;

/** Resolve the configured per-request timeout, read at call time so tests can toggle it. */
export function fetchTimeoutMs(): number {
  const raw = Number(process.env.DEP_SCAN_FETCH_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_FETCH_TIMEOUT_MS;
}

/**
 * Invoke fetchFn with an abort signal that fires after timeoutMs. The timer is
 * always cleared (success, error, or abort) so no handle leaks. Callers keep
 * their own try/catch: a timeout surfaces as a rejection there, exactly like a
 * network error, preserving fail-open.
 */
export async function fetchWithTimeout(
  fetchFn: FetchLike,
  url: string,
  init: FetchInit = {},
  timeoutMs: number = fetchTimeoutMs()
): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchFn(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
