import type { Logger } from './logger.js';
import type { RefreshScheduler } from './scheduler.js';
import type { ServiceRegistry } from './registry.js';
import type { TokenStorage } from './storage.js';
import type { TokenBundle } from './types.js';
import type { LifecycleStateStore } from './lifecycle-state.js';
import type { ConnectivityGateLike } from './connectivity.js';
import { HermesError, HermesErrorCode } from './errors.js';

export interface ScheduleStoredTokenRefreshesOptions {
  now?: () => number;
  overdueDelayMs?: number;
  overdueStaggerMs?: number;
  lifecycleStore?: LifecycleStateStore;
  /** Random 0..jitterMs added to each overdue stagger slot. Used by the
   *  post-offline recovery pass to avoid synchronized refresh bursts. */
  jitterMs?: number;
  /** Injectable RNG for tests. Returns 0..1. Default Math.random. */
  random?: () => number;
}

export async function scheduleTokenRefresh(
  registry: ServiceRegistry,
  scheduler: RefreshScheduler,
  bundle: TokenBundle,
  logger: Logger,
  whenOverride?: Date,
  lifecycleStore?: LifecycleStateStore,
): Promise<boolean> {
  const registration = registry.getService(bundle.service);
  if (!registration) {
    logger.warn('not scheduling token refresh: service is not registered', { service: bundle.service, scheme: bundle.scheme });
    return false;
  }
  const provider = registry.getProvider(registration.providerName);
  if (!provider) {
    logger.warn('not scheduling token refresh: provider is not installed', {
      service: bundle.service,
      scheme: bundle.scheme,
      providerName: registration.providerName,
    });
    return false;
  }
  const when = whenOverride ?? provider.nextRefreshAt(bundle);
  scheduler.schedule(`${bundle.service}:${bundle.scheme}`, when);
  if (lifecycleStore) {
    try {
      await lifecycleStore.recordNextScheduledRefresh(bundle.service, bundle.scheme, when);
    } catch (err) {
      logger.warn('could not persist next scheduled refresh', { service: bundle.service, scheme: bundle.scheme, error: (err as Error).message });
    }
  }
  return true;
}

const FAILURE_RETRY_FLOOR_MS = 30_000;
const FAILURE_RETRY_CEILING_MS = 15 * 60_000;
const AUTH_REQUIRED_HEARTBEAT_MS = 30 * 60_000;
// After this many consecutive proactive-refresh failures (online only — OFFLINE
// and REFRESH_IN_PROGRESS do not count), stop re-arming the scheduler and require
// an explicit operator `hermes acquire <service>`. Each failed proactive refresh
// runs a full SSO that can trigger an interactive MFA prompt, so an unbounded
// retry loop chronically spams the operator's authenticator (a provider's
// degraded-cookie-capture storm). Bounded retries hand control back to the
// human. A successful acquire/refresh clears the backoff (clearFailureBackoff /
// resetAllFailureBackoff) and re-arms the scheduler.
const MAX_PROACTIVE_REFRESH_FAILURES = 2;

/**
 * Schedule a bounded-backoff retry after a proactive refresh failure.
 * This closes the silent-disarm bug: previously a failed proactive refresh
 * permanently disarmed background refresh for that token because only the
 * success path (onTokenRefreshed) re-armed the scheduler.
 *
 * Cadence differs by failure class:
 *   - transient (REFRESH_FAILED / REFRESH_IN_PROGRESS) → honor retryAfterMs
 *     if present, else exponential backoff from 30s capped at 15min.
 *   - auth-required (INTERACTIVE_AUTH_REQUIRED / ACQUIRE_REQUIRED) → slow
 *     heartbeat at 30min so recovery is automatic once the human re-auths,
 *     without tight looping.
 *
 * The backoff state is tracked via an in-memory Map keyed by service:scheme.
 * Reset on success via scheduleTokenRefresh's cancel+reschedule (success path
 * unchanged, already clears the timer for the key).
 */
const failureBackoffState = new Map<string, { consecutiveFailures: number }>();

const OFFLINE_REARM_DEFAULT_MS = 60_000; // 2 × default offlineRecheckMs
const OFFLINE_REARM_MAX_JITTER_MS = 5_000;

export interface ScheduleFailureRetryOptions {
  /** Connectivity gate — when reporting non-online, the offline re-arm path is used. */
  connectivity?: ConnectivityGateLike;
  /** Fixed offline re-arm interval (set to 2 × config.connectivity.offlineRecheckMs). */
  offlineRearmMs?: number;
  /** Injectable RNG for tests. Returns 0..1. Default Math.random. */
  random?: () => number;
}

export function scheduleFailureRetry(
  scheduler: RefreshScheduler,
  service: string,
  scheme: string,
  error: Error,
  logger: Logger,
  opts: ScheduleFailureRetryOptions = {},
): void {
  const key = `${service}:${scheme}`;

  // REFRESH_IN_PROGRESS is not a failure — a background acquire is already
  // running for this key. Scheduling a tight retry on top of it spawns
  // redundant work (the 30s loop). Do NOT schedule and do NOT bump the
  // failure counter; the in-flight acquire's settle path re-arms the
  // scheduler (success → nextRefreshAt via onTokenRefreshed; failure →
  // bounded backoff via onRefreshFailed). This cannot reintroduce the
  // fcc2493 silent-disarm bug because both settle paths re-arm.
  if (error instanceof HermesError && error.code === HermesErrorCode.REFRESH_IN_PROGRESS) {
    logger.info('refresh-in-progress: deferring re-arm to the in-flight acquire settle', { service, scheme });
    return;
  }

  // Offline-aware re-arm: while the broker is offline, failures are
  // environmental, not credential-related. Re-arm at a FIXED cadence with
  // jitter and do NOT escalate the backoff counter — offline time must not
  // inflate post-recovery backoff or burn the autoReacquire window.
  const offline = (error instanceof HermesError && error.code === HermesErrorCode.OFFLINE)
    || (opts.connectivity !== undefined && opts.connectivity.getState() !== 'online');
  if (offline) {
    const base = opts.offlineRearmMs ?? OFFLINE_REARM_DEFAULT_MS;
    const jitter = Math.floor((opts.random ?? Math.random)() * OFFLINE_REARM_MAX_JITTER_MS);
    const delayMs = base + jitter;
    logger.info('offline: re-arming refresh at fixed cadence (no backoff escalation)', { service, scheme, delayMs });
    scheduler.schedule(key, new Date(Date.now() + delayMs));
    return;
  }

  const state = failureBackoffState.get(key) ?? { consecutiveFailures: 0 };
  state.consecutiveFailures++;
  failureBackoffState.set(key, state);

  // Hard stop: a proactive refresh that keeps failing (degraded SSO cookie
  // capture, or MFA that cannot complete headlessly) is not self-healing. After
  // MAX_PROACTIVE_REFRESH_FAILURES consecutive failures, stop re-arming so the
  // chronic reacquire loop — and the MFA prompt each attempt fires at the
  // operator — does not run forever. Recovery is an explicit
  // `hermes acquire <service>`, which clears this backoff and re-arms.
  if (state.consecutiveFailures >= MAX_PROACTIVE_REFRESH_FAILURES) {
    logger.warn('proactive refresh disarmed after repeated failures — run `hermes acquire` to recover', {
      service,
      scheme,
      consecutiveFailures: state.consecutiveFailures,
      remediation: `hermes acquire ${service}`,
    });
    return;
  }

  const isAuthRequired = error instanceof HermesError && (
    error.code === HermesErrorCode.INTERACTIVE_AUTH_REQUIRED ||
    error.code === HermesErrorCode.ACQUIRE_REQUIRED
  );

  let delayMs: number;
  if (isAuthRequired) {
    delayMs = AUTH_REQUIRED_HEARTBEAT_MS;
  } else {
    const retryAfter = error instanceof HermesError ? error.retryAfterMs : undefined;
    if (retryAfter !== undefined && retryAfter > 0) {
      delayMs = Math.max(FAILURE_RETRY_FLOOR_MS, Math.min(retryAfter, FAILURE_RETRY_CEILING_MS));
    } else {
      delayMs = Math.min(FAILURE_RETRY_FLOOR_MS * Math.pow(2, state.consecutiveFailures - 1), FAILURE_RETRY_CEILING_MS);
    }
  }

  logger.info('scheduling failure retry', {
    service, scheme,
    consecutiveFailures: state.consecutiveFailures,
    delayMs,
    failureClass: isAuthRequired ? 'auth-required' : 'transient',
  });
  scheduler.schedule(key, new Date(Date.now() + delayMs));
}

export function clearFailureBackoff(service: string, scheme: string): void {
  failureBackoffState.delete(`${service}:${scheme}`);
}

/**
 * Read-only view of the proactive-refresh backoff for one key.
 *
 * `disarmed` is the state that predicts a silent credential outage: background
 * refresh has stopped re-arming for this key and only an explicit
 * `hermes acquire <service>` brings it back, so the token will run to expiry
 * unless a human intervenes. It was previously visible ONLY as a log line;
 * GET /health/credentials reports it.
 */
export function proactiveRefreshState(service: string, scheme: string): {
  consecutiveFailures: number;
  disarmed: boolean;
} {
  const consecutiveFailures = failureBackoffState.get(`${service}:${scheme}`)?.consecutiveFailures ?? 0;
  return { consecutiveFailures, disarmed: consecutiveFailures >= MAX_PROACTIVE_REFRESH_FAILURES };
}

/** Clear ALL failure backoff state. Called by the post-offline recovery pass
 *  so the first post-recovery failure starts at the 30s floor, not an
 *  escalated delay inherited from pre-offline failures. */
export function resetAllFailureBackoff(): void {
  failureBackoffState.clear();
}

export async function scheduleStoredTokenRefreshes(
  storage: TokenStorage,
  registry: ServiceRegistry,
  scheduler: RefreshScheduler,
  logger: Logger,
  opts: ScheduleStoredTokenRefreshesOptions = {},
): Promise<number> {
  let bundles: TokenBundle[];
  try {
    bundles = await storage.list();
  } catch (err) {
    logger.warn('could not schedule stored token refreshes: token inventory failed to load', { error: (err as Error).message });
    return 0;
  }

  const now = opts.now?.() ?? Date.now();
  const overdueDelayMs = opts.overdueDelayMs ?? 30_000;
  const overdueStaggerMs = opts.overdueStaggerMs ?? 10_000;
  const jitterMs = opts.jitterMs ?? 0;
  const random = opts.random ?? Math.random;
  let scheduled = 0;
  for (const bundle of bundles) {
    const registration = registry.getService(bundle.service);
    const provider = registration ? registry.getProvider(registration.providerName) : undefined;
    const nextRefresh = provider?.nextRefreshAt(bundle);
    const jitter = jitterMs > 0 ? Math.floor(random() * jitterMs) : 0;
    const whenOverride = nextRefresh && nextRefresh.getTime() <= now
      ? new Date(now + overdueDelayMs + scheduled * overdueStaggerMs + jitter)
      : undefined;
    if (await scheduleTokenRefresh(registry, scheduler, bundle, logger, whenOverride, opts.lifecycleStore)) scheduled++;
  }
  return scheduled;
}
