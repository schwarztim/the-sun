import { createHash } from 'node:crypto';
import { KeyedMutex } from './mutex.js';
import { HermesError, HermesErrorCategory, HermesErrorCode, HermesRetryHint, type ConditionalAccessChallengePayload } from './errors.js';
import { proofEventsFromFreshnessAssessment, proofEventsFromRecoveryFailure, storedProof, freshProof, summarizeProof } from './proof-probes.js';
import {
  authFailureEventFromReport,
  authFailureGuidance,
  classifyAuthFailure,
  normalizeAuthFailureReport,
  shouldForceAuthRecovery,
  type AuthFailureReportInput,
  type AuthFailureReportResult,
} from './auth-failure.js';
function isRefreshTokenExpired(err: unknown): err is Error & { aadstsCode: string } {
  return err instanceof Error && err.name === 'RefreshTokenExpiredError' && 'aadstsCode' in err;
}
function isRetryableAuthFailure(err: unknown): err is Error & { retryable: true; retryAfterMs?: number } {
  return err instanceof Error && (err as { retryable?: unknown }).retryable === true;
}
function conditionalAccessChallenge(err: unknown): ConditionalAccessChallengePayload | undefined {
  const challenge = (err as { challenge?: unknown } | undefined)?.challenge;
  if (!challenge || typeof challenge !== 'object') return undefined;
  const c = challenge as Partial<ConditionalAccessChallengePayload>;
  if (
    typeof c.state === 'string' &&
    typeof c.category === 'string' &&
    typeof c.message === 'string' &&
    typeof c.retryable === 'boolean' &&
    typeof c.retryHint === 'string' &&
    typeof c.remediation === 'string' &&
    Array.isArray(c.remediationCommands)
  ) {
    return c as ConditionalAccessChallengePayload;
  }
  return undefined;
}
function hashBundle(bundle: TokenBundle): string {
  return createHash('sha256').update(bundle.accessToken).digest('hex').slice(0, 16);
}
import type { Logger } from './logger.js';
import type { TokenStorage } from './storage.js';
import type { TokenValidator } from './validator.js';
import type { ServiceRegistry } from './registry.js';
import type { LifecycleStateStore, ProofEvent } from './lifecycle-state.js';
import type { ConnectivityGateLike } from './connectivity.js';
import type { Provider, ProviderContext, ServiceRegistration, TokenBundle } from './types.js';

export interface OperatorActionPayload {
  service: string;
  scheme: string;
  reason: string;
  remediation: string;
  actionClass: 'ca_required' | 'bounded_retry_exhausted' | 'acquire_failed';
}

export interface BrokerDeps {
  storage: TokenStorage; registry: ServiceRegistry; validator: TokenValidator;
  logger: Logger; dataDir: string;
  lifecycleStore?: LifecycleStateStore;
  onTokenRefreshed?: (bundle: TokenBundle) => Promise<void>;
  /** Symmetric to onTokenRefreshed: invoked when a background acquire settles
   * as a FAILURE so the scheduler is re-armed with bounded backoff. Without
   * this, skipping the REFRESH_IN_PROGRESS retry would leave a failed in-flight
   * acquire with no re-arm (the fcc2493 silent-disarm bug). */
  onRefreshFailed?: (service: string, scheme: string, error: Error) => void;
  onOperatorActionRequired?: (payload: OperatorActionPayload) => void;
  /** Override the in-flight-acquire wait budget. Tests use a small value to
   * exercise the REFRESH_IN_PROGRESS path without waiting 5s. Production
   * leaves this undefined and gets the static default (ACQUIRE_WAIT_BUDGET_MS). */
  acquireWaitBudgetMs?: number;
  /** Connectivity gate. When present, every AD-touching path (refresh, acquire,
   * validate, autoReacquire, force) consults it FIRST. While offline: zero
   * provider.acquire/refresh/validate calls; cached unexpired tokens are
   * served; otherwise an OFFLINE error (HTTP 503 + Retry-After) is thrown. */
  connectivity?: ConnectivityGateLike;
  /** AD interaction budget (sliding 1h window per service:scheme). Counts
   * provider.acquire() ATTEMPTS at the call sites, regardless of trigger
   * source — failed attempts also load AD. Defaults: 4 acquires/h, 12 validations/h. */
  adBudget?: { maxAcquiresPerHour?: number; maxValidationsPerHour?: number };
  /** Offline-serving knobs (from config.connectivity + refreshSafetyMarginSec). */
  offlineOptions?: {
    /** Serve cached unexpired tokens while offline. Default true. */
    serveCachedWhileOffline?: boolean;
    /** retryAfterMs on OFFLINE errors. Default 30_000 (= offlineRecheckMs default). */
    retryAfterMs?: number;
    /** Safety margin used for the offline grace flag. Default 300_000. */
    safetyMarginMs?: number;
  };
}
export interface GetTokenOptions { force?: boolean; refresh?: boolean; interactive?: boolean; }

export class Broker {
  private readonly mutex = new KeyedMutex();
  private readonly cooldowns = new Map<string, number>();
  /**
   * Per-key reason a cooldown was activated. `isCa` distinguishes a CA
   * challenge (operator must act — the cooldown gate keeps surfacing
   * INTERACTIVE_AUTH_REQUIRED) from a transient/self-recovering failure
   * (the cooldown is a self-expiring window the consumer can ride out —
   * the gate surfaces REFRESH_IN_PROGRESS with retry_after so daemons
   * back off instead of dead-ending on a misleading "operator must act").
   */
  private readonly cooldownReason = new Map<string, { isCa: boolean }>();
  private readonly suspectCredentials = new Map<string, { at: number; reason: string }>();
  private readonly autoReacquireFailures = new Map<string, number[]>();
  /**
   * In-flight acquire promises by `${service}:${scheme}` key. Used to dedup
   * concurrent autoReacquire triggers AND to bound /token wait time so that
   * slow Playwright/SSO acquires don't block consumer requests for 30-90s.
   * See tryAutoReacquire for the bounded-wait + REFRESH_IN_PROGRESS path.
   */
  private readonly inFlightAcquires = new Map<string, Promise<TokenBundle | null>>();
  /**
   * Per-key record of the most recent autoReacquire failure. `isCa` tells
   * whether the failure was a CA challenge (operator-action-needed) vs a
   * transient runtime issue (cold-start race, Playwright stall, IdP timeout).
   * Used by tryAutoReacquire's null-paths to decide whether to fall through
   * to the original INTERACTIVE_AUTH_REQUIRED (CA → 409 with remediation)
   * or surface REFRESH_IN_PROGRESS (transient → 503 with retry-after) so
   * consumers don't get a misleading "operator must act" signal for what
   * is actually a recoverable wait.
   */
  private readonly lastAcquireFailure = new Map<string, { isCa: boolean; at: number; message: string }>();
  private readonly operatorNotified = new Map<string, number>();
  private static readonly OPERATOR_NOTIFY_DEDUP_MS = 10 * 60_000;
  private static readonly COOLDOWN_MS = 60_000;
  private static readonly TRANSIENT_RETRY_AFTER_MS = 30_000;
  private static readonly AUTO_REACQUIRE_WINDOW_MS = 10 * 60_000;
  private static readonly AUTO_REACQUIRE_MAX_FAILURES = 2;
  /**
   * How long /token will wait for an in-flight acquire to complete before
   * throwing REFRESH_IN_PROGRESS. Fast refreshes (OAuth refresh-token, ~200ms)
   * complete within this budget and return inline. Slow Playwright/SSO
   * acquires (30-90s) exceed it and surface REFRESH_IN_PROGRESS to the caller
   * while continuing in the background.
   */
  private static readonly ACQUIRE_WAIT_BUDGET_MS = 5_000;
  private static readonly REFRESH_IN_PROGRESS_RETRY_AFTER_MS = 15_000;
  private static readonly AD_BUDGET_WINDOW_MS = 3600_000;
  private static readonly DEFAULT_MAX_ACQUIRES_PER_HOUR = 4;
  private static readonly DEFAULT_MAX_VALIDATIONS_PER_HOUR = 12;
  private static readonly DEFAULT_OFFLINE_RETRY_AFTER_MS = 30_000;
  private static readonly DEFAULT_OFFLINE_SAFETY_MARGIN_MS = 300_000;
  /** AD budget: per-key epoch-ms timestamps of provider.acquire() attempts. */
  private readonly adAcquireTimes = new Map<string, number[]>();
  /** AD budget: per-key epoch-ms timestamps of provider.validate() calls. */
  private readonly adValidationTimes = new Map<string, number[]>();
  constructor(private readonly deps: BrokerDeps) {}

  /**
   * Hydrate persisted acquire-governor state from the LifecycleStateStore.
   * Restores autoReacquire failure windows, lastAcquireFailure classification,
   * cooldown CA flags, and AD budget timestamps so a broker restart does not
   * reset suppression context. Call once at startup, before serving requests.
   */
  async init(): Promise<void> {
    if (!this.deps.lifecycleStore) return;
    let states;
    try {
      states = await this.deps.lifecycleStore.list();
    } catch (err) {
      this.deps.logger.warn('could not hydrate acquire governor state', { error: (err as Error).message });
      return;
    }
    const now = Date.now();
    for (const state of states) {
      const key = `${state.service}:${state.scheme}`;
      if (state.autoReacquireFailureTimes?.length) {
        const live = state.autoReacquireFailureTimes.filter((t) => now - t < Broker.AUTO_REACQUIRE_WINDOW_MS);
        if (live.length) this.autoReacquireFailures.set(key, live);
      }
      if (state.lastAcquireFailure) this.lastAcquireFailure.set(key, state.lastAcquireFailure);
      if (state.cooldownIsCa !== undefined) this.cooldownReason.set(key, { isCa: state.cooldownIsCa });
      if (state.adAcquireTimes?.length) {
        const live = state.adAcquireTimes.filter((t) => now - t < Broker.AD_BUDGET_WINDOW_MS);
        if (live.length) this.adAcquireTimes.set(key, live);
      }
    }
  }

  async getToken(service: string, scheme: string, opts: GetTokenOptions = {}): Promise<TokenBundle> {
    const key = `${service}:${scheme}`;
    return this.mutex.runDedup(key, () => this.fetchLocked(service, scheme, opts.force ?? false, opts.refresh ?? false, opts.interactive ?? false));
  }

  async listServices(): Promise<string[]> {
    return this.deps.registry.listServices().map((s) => s.name);
  }

  async reportAuthFailure(input: AuthFailureReportInput): Promise<AuthFailureReportResult> {
    let report: ReturnType<typeof normalizeAuthFailureReport>;
    try {
      report = normalizeAuthFailureReport(input);
    } catch (err) {
      throw new HermesError(HermesErrorCode.VALIDATION_FAILED, `invalid auth failure report: ${(err as Error).message}`, {
        cause: err,
        remediation: 'include service, scheme, and non-secret downstream failure metadata',
      });
    }
    const canonicalService = this.deps.registry.resolveServiceName(report.service);
    const key = `${canonicalService ?? report.service}:${report.scheme}`;
    return this.mutex.run(`auth-report:${key}`, async () => {
      if (!canonicalService) throw new HermesError(HermesErrorCode.SERVICE_NOT_REGISTERED, `SERVICE_NOT_REGISTERED: service ${report.service} is not registered`, { remediation: 'register the service first' });
      const registration = this.deps.registry.getService(canonicalService);
      if (!registration) throw new HermesError(HermesErrorCode.SERVICE_NOT_REGISTERED, `SERVICE_NOT_REGISTERED: service ${canonicalService} is not registered`, { remediation: 'register the service first' });
      const originalService = report.service;
      report = { ...report, service: canonicalService };
      if (!registration.schemes.includes(report.scheme)) {
        throw new HermesError(HermesErrorCode.SERVICE_NOT_REGISTERED, `SERVICE_NOT_REGISTERED: scheme ${report.scheme} is not registered for service ${report.service}`, { remediation: 'register the scheme first' });
      }
      const forceRecovery = shouldForceAuthRecovery(report);
      const event = authFailureEventFromReport(report);
      if (forceRecovery) {
        const reason = event.message ?? event.failureCode ?? (event.httpStatus ? `HTTP ${event.httpStatus}` : 'downstream auth failure');
        this.suspectCredentials.set(key, { at: event.at, reason });
      }
      await this.lifecycle((store) => store.recordConsumerAuthFailure(report.service, report.scheme, event));
      this.deps.logger.warn('consumer auth failure reported', {
        service: report.service,
        scheme: report.scheme,
        httpStatus: report.httpStatus,
        failureCode: report.failureCode,
        classification: classifyAuthFailure(report),
        forceRecovery,
        backend: report.backend,
        reportedService: originalService !== report.service ? originalService : undefined,
        tool: report.tool,
        endpointClass: report.endpointClass,
        correlationId: report.correlationId,
      });
      const guidance = authFailureGuidance(report, forceRecovery);
      return {
        status: 'recorded',
        service: report.service,
        scheme: report.scheme,
        classification: classifyAuthFailure(report),
        forceRecovery,
        credentialStatus: forceRecovery ? 'suspect' : 'degraded',
        guidance,
        report,
      };
    });
  }

  private ctx(service: string, providerConfig: Record<string, unknown>, _interactive = false): ProviderContext {
    const config = { ...providerConfig, headless: true };
    return { service, config, dataDir: this.deps.dataDir, logger: this.deps.logger.child({ component: 'provider', service }) };
  }

  private offlineRetryAfterMs(): number {
    return this.deps.offlineOptions?.retryAfterMs ?? Broker.DEFAULT_OFFLINE_RETRY_AFTER_MS;
  }

  private offlineError(service: string, scheme: string): HermesError {
    const retryAfterMs = this.offlineRetryAfterMs();
    return new HermesError(
      HermesErrorCode.OFFLINE,
      `broker is offline — no network path to the identity provider; cannot serve ${service}:${scheme}`,
      {
        retryAfterMs,
        retryable: true,
        retryHint: HermesRetryHint.RETRY_AFTER,
        remediation: `restore network connectivity (VPN/Wi-Fi); the broker rechecks every ~${Math.ceil(retryAfterMs / 1000)}s and recovers automatically`,
      },
    );
  }

  private async isOffline(): Promise<boolean> {
    if (!this.deps.connectivity) return false;
    return !(await this.deps.connectivity.isOnline());
  }

  /** Sliding-window check WITHOUT recording an attempt. */
  private adAcquireBudgetCheck(service: string, scheme: string): { ok: true } | { ok: false; retryAfterMs: number } {
    const key = `${service}:${scheme}`;
    const now = Date.now();
    const max = this.deps.adBudget?.maxAcquiresPerHour ?? Broker.DEFAULT_MAX_ACQUIRES_PER_HOUR;
    const times = (this.adAcquireTimes.get(key) ?? []).filter((t) => now - t < Broker.AD_BUDGET_WINDOW_MS);
    this.adAcquireTimes.set(key, times);
    if (times.length >= max) {
      return { ok: false, retryAfterMs: Math.max(0, Broker.AD_BUDGET_WINDOW_MS - (now - times[0]!)) };
    }
    return { ok: true };
  }

  /**
   * Consolidated pre-acquire gate, consulted by EVERY path that is about to
   * call provider.acquire() (consumer getToken force/fallback via
   * acquireAndStore, scheduler refresh fallback, health monitor force,
   * autoReacquire). Order: connectivity → AD budget. The existing cooldown
   * gate (fetchLocked) and autoReacquire bounded window (tryAutoReacquire)
   * remain in place upstream — this gate adds the offline and budget layers
   * without duplicating them.
   */
  private async acquireGate(service: string, scheme: string): Promise<void> {
    if (await this.isOffline()) throw this.offlineError(service, scheme);
    const budget = this.adAcquireBudgetCheck(service, scheme);
    if (!budget.ok) {
      this.deps.logger.warn('AD acquire budget exhausted — suppressing acquire', {
        service, scheme,
        maxAcquiresPerHour: this.deps.adBudget?.maxAcquiresPerHour ?? Broker.DEFAULT_MAX_ACQUIRES_PER_HOUR,
        retryAfterMs: budget.retryAfterMs,
      });
      throw new HermesError(
        HermesErrorCode.REFRESH_IN_PROGRESS,
        `AD acquire budget exhausted for ${service}:${scheme} — retry after ~${Math.ceil(budget.retryAfterMs / 1000)}s`,
        {
          retryAfterMs: budget.retryAfterMs,
          retryHint: HermesRetryHint.RETRY_AFTER,
          remediation: `the broker caps browser-auth attempts per hour to protect the IdP; retry after the window relaxes or raise adBudget.maxAcquiresPerHour`,
        },
      );
    }
  }

  /** Record an acquire ATTEMPT against the AD budget (attempts, not successes —
   *  failed attempts also load AD). Persisted for restart survival. */
  private async recordAdAcquireAttempt(service: string, scheme: string): Promise<void> {
    const key = `${service}:${scheme}`;
    const now = Date.now();
    const times = (this.adAcquireTimes.get(key) ?? []).filter((t) => now - t < Broker.AD_BUDGET_WINDOW_MS);
    times.push(now);
    this.adAcquireTimes.set(key, times);
    await this.lifecycle((store) => store.recordAcquireGovernorState(service, scheme, { adAcquireTimes: times }));
  }

  /**
   * Read-only advisory check for the health monitor and `hermes status`.
   * Synchronous: uses the gate's last-known state (no probe) and in-memory
   * windows. Order mirrors acquireGate: connectivity → cooldown →
   * autoReacquire bounded window → AD budget.
   */
  canAttemptAcquire(service: string, scheme: string): { ok: boolean; reason?: string; retryAfterMs?: number } {
    if (this.deps.connectivity && this.deps.connectivity.getState() !== 'online') {
      return { ok: false, reason: 'offline', retryAfterMs: this.offlineRetryAfterMs() };
    }
    const key = `${service}:${scheme}`;
    const now = Date.now();
    const cooldownUntil = this.cooldowns.get(key);
    if (cooldownUntil && cooldownUntil > now) {
      return { ok: false, reason: 'cooldown', retryAfterMs: cooldownUntil - now };
    }
    const recentFailures = (this.autoReacquireFailures.get(key) ?? []).filter((t) => now - t < Broker.AUTO_REACQUIRE_WINDOW_MS);
    if (recentFailures.length >= Broker.AUTO_REACQUIRE_MAX_FAILURES) {
      return { ok: false, reason: 'auto-reacquire-suppressed', retryAfterMs: Math.max(0, Broker.AUTO_REACQUIRE_WINDOW_MS - (now - recentFailures[0]!)) };
    }
    const budget = this.adAcquireBudgetCheck(service, scheme);
    if (!budget.ok) return { ok: false, reason: 'ad-budget', retryAfterMs: budget.retryAfterMs };
    return { ok: true };
  }

  /**
   * Validation gate for TokenValidator (wired via ValidatorOptions.validationGate).
   * 'ok' RECORDS the validation against the per-key hourly budget; 'offline'
   * and 'budget' tell the validator to skip provider.validate and fall back
   * to expiry math ('not-run').
   */
  validationGate(service: string, scheme: string): 'ok' | 'offline' | 'budget' {
    if (this.deps.connectivity && this.deps.connectivity.getState() !== 'online') return 'offline';
    const key = `${service}:${scheme}`;
    const now = Date.now();
    const max = this.deps.adBudget?.maxValidationsPerHour ?? Broker.DEFAULT_MAX_VALIDATIONS_PER_HOUR;
    const times = (this.adValidationTimes.get(key) ?? []).filter((t) => now - t < Broker.AD_BUDGET_WINDOW_MS);
    if (times.length >= max) {
      this.adValidationTimes.set(key, times);
      return 'budget';
    }
    times.push(now);
    this.adValidationTimes.set(key, times);
    return 'ok';
  }

  private async fetchLocked(service: string, scheme: string, force: boolean, refresh: boolean, interactive = false): Promise<TokenBundle> {
    const key = `${service}:${scheme}`;
    // Connectivity gate FIRST (Req C order: connectivity → cooldown → window →
    // budget). While offline: serve the cached unexpired token (grace-flagged
    // inside the safety margin, NEVER past expiresAt), else throw OFFLINE.
    // `force` (health-monitor path) always throws OFFLINE — no browser spawns.
    if (await this.isOffline()) {
      const serveCached = this.deps.offlineOptions?.serveCachedWhileOffline ?? true;
      if (!force && serveCached) {
        let cached: TokenBundle | null = null;
        try { cached = await this.deps.storage.get(service, scheme); }
        catch (err) { this.deps.logger.warn('offline: could not read cached token', { service, scheme, error: (err as Error).message }); }
        if (cached && cached.expiresAt > Date.now()) {
          const safetyMarginMs = this.deps.offlineOptions?.safetyMarginMs ?? Broker.DEFAULT_OFFLINE_SAFETY_MARGIN_MS;
          const insideSafetyMargin = cached.expiresAt - Date.now() <= safetyMarginMs;
          if (insideSafetyMargin) {
            this.deps.logger.warn('offline: serving cached token inside safety margin (grace)', {
              service, scheme, msUntilExpiry: cached.expiresAt - Date.now(),
            });
            // Grace flag on the returned COPY only — never persisted to storage.
            return { ...cached, extra: { ...(cached.extra ?? {}), hermesOfflineGrace: true } };
          }
          this.deps.logger.info('offline: serving cached token', { service, scheme });
          return cached;
        }
      }
      throw this.offlineError(service, scheme);
    }
    const cooldownUntil = await this.cooldownUntil(service, scheme);
    if (cooldownUntil && cooldownUntil > Date.now()) {
      // Bypass the cooldown gate when the cached AT is still valid and the
      // caller isn't asking for a forced refresh. The freshness check below
      // will serve the cached token without contacting the IdP.
      let cachedStillValid = false;
      if (!force && !refresh) {
        try {
          const cached = await this.deps.storage.get(service, scheme);
          cachedStillValid = !!cached && cached.expiresAt - Date.now() > 0;
        } catch { /* fall through */ }
      }
      if (!cachedStillValid) {
        const retryAfterMs = cooldownUntil - Date.now();
        // Classify the cooldown response. REFRESH_IN_PROGRESS (503,
        // retryable) is only honest when the broker can actually recover
        // on its own — i.e. autoReacquire is enabled AND the triggering
        // failure was NOT a CA challenge. In that case the headless
        // reacquire typically completes within the cooldown window and the
        // consumer's retry lands on a fresh token. Otherwise (autoReacquire
        // off → broker won't self-recover; or CA challenge → operator must
        // act) keep INTERACTIVE_AUTH_REQUIRED (409) so the consumer doesn't
        // retry-loop forever on a state that needs `hermes acquire`.
        const reason = this.cooldownReason.get(key);
        const reg = this.deps.registry.getService(service);
        const canSelfRecover = !!reg && this.deps.registry.autoReacquireEnabled(reg.name) && !reason?.isCa;
        if (canSelfRecover) {
          throw new HermesError(
            HermesErrorCode.REFRESH_IN_PROGRESS,
            `reauth cooldown active for ${service}:${scheme} (${Math.ceil(retryAfterMs / 1000)}s remaining) — broker is auto-recovering; retry after the cooldown`,
            {
              retryAfterMs,
              retryHint: HermesRetryHint.RETRY_AFTER,
              remediation: `retry after ~${Math.ceil(retryAfterMs / 1000)}s; no operator action needed unless a 409 INTERACTIVE_AUTH_REQUIRED follows`,
            },
          );
        }
        throw new HermesError(
          HermesErrorCode.INTERACTIVE_AUTH_REQUIRED,
          `reauth cooldown active for ${service}:${scheme} (${Math.ceil(retryAfterMs / 1000)}s remaining)`,
          this.authRequiredOptions(service, { retryAfterMs }),
        );
      }
      // Clear stale cooldown so subsequent calls don't keep paying the AT-valid check.
      this.cooldowns.delete(key);
      this.cooldownReason.delete(key);
    }
    const registration = this.deps.registry.getService(service);
    if (!registration) throw new HermesError(HermesErrorCode.SERVICE_NOT_REGISTERED, `SERVICE_NOT_REGISTERED: service ${service} is not registered`, { remediation: `register the service first` });
    const provider = this.deps.registry.getProvider(registration.providerName);
    if (!provider) throw new HermesError(HermesErrorCode.PROVIDER_NOT_FOUND, `provider ${registration.providerName} for service ${service} is not installed`);
    const ctx = this.ctx(service, registration.config, interactive);

    if (!force) {
      const cached = await this.deps.storage.get(service, scheme);
      if (cached) {
        const age = Math.max(0, Math.floor((Date.now() - cached.acquiredAt) / 1000));
        const credentialSuspect = await this.isCredentialSuspect(service, scheme);
        if (!refresh && !credentialSuspect) {
          const assessment = await this.deps.validator.assessFreshness(provider, ctx, cached, { cacheAge: age });
          await this.recordProofEvents(service, scheme, proofEventsFromFreshnessAssessment(cached, assessment));
          if (assessment.fresh) return cached;
        }
        this.deps.logger.info(
          refresh ? 'cached token scheduled for refresh' : credentialSuspect ? 'cached token marked suspect by downstream, refreshing' : 'cached token stale, refreshing',
          { service, scheme },
        );
        await this.lifecycle((store) => store.recordRefreshAttempt(service, scheme));
        try {
          const refreshed = await provider.refresh(ctx, cached);
          if (hashBundle(refreshed) === hashBundle(cached)) {
            const err = new HermesError(
              HermesErrorCode.INTERACTIVE_AUTH_REQUIRED,
              `refresh returned identical credentials for ${service}:${scheme} — interactive re-auth needed`,
              this.authRequiredOptions(service),
            );
            await this.activateCooldown(service, scheme, err, 'refresh');
            throw err;
          }
          await this.deps.storage.set(refreshed);
          this.suspectCredentials.delete(key);
          await this.lifecycle((store) => store.recordRefreshSuccess(service, scheme));
          await this.recordStoredFreshProof(refreshed);
          await this.notifyTokenRefreshed(refreshed);
          return refreshed;
          } catch (err) {
            if (err instanceof HermesError) {
              await this.recordRecoveryFailureProof(service, scheme, cached, err, 'refresh', err.code === HermesErrorCode.INTERACTIVE_AUTH_REQUIRED ? 'failed' : 'degraded');
              await this.lifecycle((store) => store.recordRefreshFailure(service, scheme, err, { code: err.code }));
              if (err.code === HermesErrorCode.INTERACTIVE_AUTH_REQUIRED) {
                const recovered = await this.tryAutoReacquire(registration, provider, ctx, service, scheme, 'refresh returned INTERACTIVE_AUTH_REQUIRED', false);
                if (recovered) return recovered;
              }
              throw err;
            }
            if (isRefreshTokenExpired(err)) {
              this.deps.logger.warn('refresh token expired, interactive re-auth needed', { service, scheme, aadstsCode: err.aadstsCode });
            const authErr = new HermesError(
              HermesErrorCode.INTERACTIVE_AUTH_REQUIRED,
              `refresh token expired for ${service}:${scheme} (${err.aadstsCode})`,
                this.authRequiredOptions(service),
              );
              await this.recordRecoveryFailureProof(service, scheme, cached, authErr, 'refresh', 'failed');
              await this.activateCooldown(service, scheme, authErr, 'refresh');
              const recovered = await this.tryAutoReacquire(registration, provider, ctx, service, scheme, `refresh token expired: ${err.aadstsCode}`, false);
              if (recovered) return recovered;
              throw authErr;
            }
            const challenge = conditionalAccessChallenge(err);
            if (challenge) {
            this.deps.logger.warn('conditional access challenge during refresh', { service, scheme, state: challenge.state });
            const authErr = new HermesError(
              HermesErrorCode.INTERACTIVE_AUTH_REQUIRED,
              `conditional access challenge for ${service}:${scheme}: ${challenge.state}`,
                { cause: err, ...this.authRequiredOptions(service, { challenge }) },
              );
              await this.recordRecoveryFailureProof(service, scheme, cached, authErr, 'refresh', 'failed');
              await this.activateCooldown(service, scheme, authErr, 'refresh');
              // CA challenges always need operator — tryAutoReacquire with isCaChallenge=true returns null
              const recovered = await this.tryAutoReacquire(registration, provider, ctx, service, scheme, `conditional access: ${challenge.state}`, true);
              if (recovered) return recovered;
              throw authErr;
            }
            if (isRetryableAuthFailure(err)) {
              const retryAfterMs = err.retryAfterMs ?? Broker.TRANSIENT_RETRY_AFTER_MS;
            const refreshErr = new HermesError(
              HermesErrorCode.REFRESH_FAILED,
              `transient refresh failed for ${service}:${scheme}: ${err.message}`,
              {
                cause: err,
                category: HermesErrorCategory.TRANSIENT,
                retryable: true,
                retryAfterMs,
                remediation: `retry after ${Math.ceil(retryAfterMs / 1000)}s; do not run acquire unless Hermes returns INTERACTIVE_AUTH_REQUIRED`,
                },
              );
              await this.recordRecoveryFailureProof(service, scheme, cached, refreshErr, 'refresh', 'degraded');
              await this.lifecycle((store) => store.recordRefreshFailure(service, scheme, refreshErr, { code: refreshErr.code }));
              throw refreshErr;
            }
            if (refresh) {
            this.deps.logger.warn('scheduled refresh failed, keeping cached token', { service, scheme, error: (err as Error).message });
            const retryAfterMs = Broker.TRANSIENT_RETRY_AFTER_MS;
            const refreshErr = new HermesError(
              HermesErrorCode.REFRESH_FAILED,
              `scheduled refresh failed for ${service}:${scheme}: ${(err as Error).message}`,
              {
                cause: err,
                category: HermesErrorCategory.TRANSIENT,
                retryable: true,
                retryAfterMs,
                remediation: `retry after ${Math.ceil(retryAfterMs / 1000)}s; Hermes will keep serving the cached token if it still validates`,
                },
              );
              await this.recordRecoveryFailureProof(service, scheme, cached, refreshErr, 'refresh', 'degraded');
              await this.lifecycle((store) => store.recordRefreshFailure(service, scheme, refreshErr, { code: refreshErr.code }));
              throw refreshErr;
            }
            await this.recordRecoveryFailureProof(service, scheme, cached, err, 'refresh_fallback_to_acquire', 'degraded');
            await this.lifecycle((store) => store.recordRefreshFailure(service, scheme, err));
            this.deps.logger.warn('provider refresh failed, falling back to acquire', { service, error: (err as Error).message });
          }
      }
    }
    return this.acquireAndStore(provider, ctx, service, scheme);
  }

  async acquireAllForService(service: string, opts: { interactive?: boolean } = {}): Promise<TokenBundle[]> {
    const registration = this.deps.registry.getService(service);
    if (!registration) throw new HermesError(HermesErrorCode.SERVICE_NOT_REGISTERED, `SERVICE_NOT_REGISTERED: service ${service} is not registered`, { remediation: `register the service first` });
    const provider = this.deps.registry.getProvider(registration.providerName);
    if (!provider) throw new HermesError(HermesErrorCode.PROVIDER_NOT_FOUND, `provider ${registration.providerName} for service ${service} is not installed`);
    if (!provider.acquireAll) throw new HermesError(HermesErrorCode.ACQUIRE_REQUIRED, `provider ${registration.providerName} does not support batch acquire`);
    const ctx = this.ctx(service, registration.config, opts.interactive ?? false);
    await Promise.all(registration.schemes.map((s) => this.lifecycle((store) => store.recordAcquireAttempt(service, s))));
    let bundles: TokenBundle[];
    try {
      bundles = await provider.acquireAll(ctx);
    } catch (err) {
      const challenge = conditionalAccessChallenge(err);
      const acquireErr = challenge
        ? new HermesError(
          HermesErrorCode.ACQUIRE_REQUIRED,
          `acquire failed for ${service}: ${challenge.state}`,
          { cause: err, ...this.authRequiredOptions(service, { challenge }) },
        )
        : err;
      await Promise.all(registration.schemes.map((s) => this.lifecycle((store) => store.recordAcquireFailure(service, s, acquireErr))));
      throw acquireErr;
    }
    for (const bundle of bundles) {
      await this.deps.storage.set(bundle);
      await this.lifecycle((store) => store.recordAcquireSuccess(bundle.service, bundle.scheme));
      await this.recordStoredFreshProof(bundle);
      // Same contract as the single-scheme paths: a propagation failure must not
      // fail the batch, nor abort propagation for the bundles after this one.
      await this.notifyTokenRefreshed(bundle);
    }
    return bundles;
  }

  /**
   * Attempt an automatic re-acquisition for services with autoReacquire: true.
   * Returns the fresh TokenBundle on success, or null if suppressed or failed.
   * When null is returned the caller should proceed with its normal error path.
   * The `isCaChallenge` flag is forwarded from the caller so CA walls still
   * surface the original INTERACTIVE_AUTH_REQUIRED instead of being swallowed.
   */
  private async tryAutoReacquire(
    _registration: ServiceRegistration,
    provider: Provider,
    ctx: ProviderContext,
    service: string,
    scheme: string,
    reason: string,
    isCaChallenge: boolean,
  ): Promise<TokenBundle | null> {
    if (!this.deps.registry.autoReacquireEnabled(service)) return null;
    const key = `${service}:${scheme}`;
    const now = Date.now();
    const window = Broker.AUTO_REACQUIRE_WINDOW_MS;
    const recentFailures = (this.autoReacquireFailures.get(key) ?? []).filter(
      (t) => now - t < window,
    );
    if (recentFailures.length >= Broker.AUTO_REACQUIRE_MAX_FAILURES) {
      const remainingMs = Math.max(0, window - (now - recentFailures[0]!));
      this.deps.logger.warn('autoReacquire suppressed — bounded-retry limit hit', {
        service, scheme,
        recentFailures: recentFailures.length,
        remainingMs,
      });
      this.autoReacquireFailures.set(key, recentFailures);
      const lastFailure = this.lastAcquireFailure.get(key);
      if (!lastFailure?.isCa) {
        this.notifyOperator({
          service, scheme,
          reason: `bounded-retry exhausted (${recentFailures.length} failures in ${Math.ceil(window / 60_000)}min)`,
          remediation: `hermes acquire ${service}`,
          actionClass: 'bounded_retry_exhausted',
        });
        throw new HermesError(
          HermesErrorCode.REFRESH_IN_PROGRESS,
          `autoReacquire suppressed for ${service}:${scheme} (${Math.ceil(remainingMs / 1000)}s remaining); recent acquires failed transiently`,
          {
            retryAfterMs: remainingMs,
            retryHint: HermesRetryHint.RETRY_AFTER,
            remediation: `retry after ~${Math.ceil(remainingMs / 1000)}s; if 503s persist past the suppression window, underlying acquire may need operator attention`,
          },
        );
      }
      this.notifyOperator({
        service, scheme,
        reason: 'conditional access challenge — operator must re-authenticate',
        remediation: `hermes acquire ${service}`,
        actionClass: 'ca_required',
      });
      return null;
    }
    if (isCaChallenge) {
      this.deps.logger.error('autoReacquire blocked by conditional access — operator action required', {
        service, scheme,
        requiresOperatorAction: true,
        remediation: `hermes acquire ${service}`,
        surfaceTo: 'operator',
        actionClass: 'ca_required',
      });
      this.notifyOperator({
        service, scheme,
        reason: 'conditional access challenge — headless reacquire cannot proceed',
        remediation: `hermes acquire ${service}`,
        actionClass: 'ca_required',
      });
      return null;
    }

    // Dedup + non-blocking reacquire. Long Playwright/SSO acquires can take
    // 30-90s; without a wait budget every /token call during that window
    // blocks for the full duration, causing daemon-side timeouts that get
    // surfaced to operators as misleading "network or broker error" messages
    // (see the 2026-05-27 timbot incident: ~954 cascading errors in 8h while
    // the underlying acquires were succeeding).
    //
    // Pattern: track in-flight acquires by key. First caller kicks off the
    // acquire in the background. All callers (including the first) race the
    // acquire against a 5s budget. If the acquire finishes within budget,
    // return the bundle inline (preserves existing fast-path semantics for
    // OAuth refresh-token flows). If the budget elapses, throw
    // REFRESH_IN_PROGRESS so the consumer can back off and retry cleanly —
    // the background acquire continues independently and stores the result.
    let inFlight = this.inFlightAcquires.get(key);
    if (!inFlight) {
      // Consolidated gate: connectivity + AD budget. Joining an existing
      // in-flight acquire is exempt (no new AD load).
      await this.acquireGate(service, scheme);
      await this.recordAdAcquireAttempt(service, scheme);
      this.deps.logger.info('autoReacquire triggered', { service, scheme, reason });
      const acquireStart = Date.now();
      inFlight = (async () => {
        try {
          const bundle = await provider.acquire(ctx, scheme);
          await this.deps.storage.set(bundle);
          this.suspectCredentials.delete(key);
          await this.lifecycle((store) => store.recordAcquireSuccess(service, scheme));
          await this.recordStoredFreshProof(bundle);
          // Outside-the-try contract: on this path a throwing propagation would
          // land in the catch below and BUMP autoReacquireFailures, suppressing
          // future auto-reacquires for a credential that was captured fine.
          await this.notifyTokenRefreshed(bundle);
          this.autoReacquireFailures.delete(key);
          this.lastAcquireFailure.delete(key);
          await this.lifecycle((store) => store.recordAcquireGovernorState(service, scheme, {
            autoReacquireFailureTimes: undefined,
            lastAcquireFailure: undefined,
          }));
          this.clearOperatorNotification(service, scheme);
          this.deps.logger.info('autoReacquire succeeded', {
            service, scheme,
            durationMs: Date.now() - acquireStart,
          });
          return bundle;
        } catch (acquireErr) {
          const failures = (this.autoReacquireFailures.get(key) ?? []).filter(
            (t) => Date.now() - t < Broker.AUTO_REACQUIRE_WINDOW_MS,
          );
          failures.push(Date.now());
          this.autoReacquireFailures.set(key, failures);
          const isCa = !!conditionalAccessChallenge(acquireErr);
          this.lastAcquireFailure.set(key, {
            isCa,
            at: Date.now(),
            message: (acquireErr as Error).message,
          });
          await this.lifecycle((store) => store.recordAcquireGovernorState(service, scheme, {
            autoReacquireFailureTimes: failures,
            lastAcquireFailure: this.lastAcquireFailure.get(key),
          }));
          this.deps.logger.warn('autoReacquire failed', {
            service, scheme, isCa,
            error: (acquireErr as Error).message,
            durationMs: Date.now() - acquireStart,
          });
          // Re-arm the scheduler now that this background acquire settled as a
          // failure. Since REFRESH_IN_PROGRESS no longer schedules a retry, this
          // is the only failure-path re-arm — it preserves the fcc2493
          // silent-disarm guarantee. CA → 30-min auth heartbeat; transient →
          // bounded exponential backoff (no retryAfterMs → 30s→15min).
          this.deps.onRefreshFailed?.(
            service, scheme,
            isCa
              ? new HermesError(
                  HermesErrorCode.INTERACTIVE_AUTH_REQUIRED,
                  `conditional access challenge for ${service}:${scheme} during background reacquire`,
                  this.authRequiredOptions(service),
                )
              : new HermesError(
                  HermesErrorCode.REFRESH_FAILED,
                  `background reacquire failed for ${service}:${scheme}: ${(acquireErr as Error).message}`,
                  { category: HermesErrorCategory.TRANSIENT, retryable: true },
                ),
          );
          return null;
        }
      })();
      // Cleanup the in-flight map when the background acquire settles, so
      // the next /token after completion either gets the fresh cached bundle
      // OR triggers a new acquire (on subsequent expiry). Errors swallowed
      // because we don't want unhandled-rejection noise — the result is
      // already captured inside the IIFE.
      inFlight.catch(() => {}).finally(() => {
        if (this.inFlightAcquires.get(key) === inFlight) {
          this.inFlightAcquires.delete(key);
        }
      });
      this.inFlightAcquires.set(key, inFlight);
    } else {
      this.deps.logger.info('autoReacquire already in-flight, joining wait', { service, scheme });
    }

    // Race the in-flight acquire against the wait budget. The TIMEOUT_SENTINEL
    // is a unique object reference so we can distinguish it from `null`
    // (which is a valid acquire-failure result we want to bubble up).
    const TIMEOUT_SENTINEL: unique symbol = Symbol('refresh-timeout') as unknown as never;
    type Outcome = TokenBundle | null | typeof TIMEOUT_SENTINEL;
    let timerHandle: ReturnType<typeof setTimeout> | undefined;
    const waitBudgetMs = this.deps.acquireWaitBudgetMs ?? Broker.ACQUIRE_WAIT_BUDGET_MS;
    const timer = new Promise<Outcome>((resolve) => {
      timerHandle = setTimeout(() => resolve(TIMEOUT_SENTINEL as Outcome), waitBudgetMs);
    });
    let outcome: Outcome;
    try {
      outcome = await Promise.race([inFlight as Promise<Outcome>, timer]);
    } finally {
      if (timerHandle) clearTimeout(timerHandle);
    }
    if (outcome === TIMEOUT_SENTINEL) {
      throw new HermesError(
        HermesErrorCode.REFRESH_IN_PROGRESS,
        `refresh in progress for ${service}:${scheme} — retry shortly; the broker is re-acquiring this credential in the background`,
        {
          retryAfterMs: Broker.REFRESH_IN_PROGRESS_RETRY_AFTER_MS,
          retryHint: HermesRetryHint.RETRY_AFTER,
          remediation: `retry the same request after ~${Math.ceil(Broker.REFRESH_IN_PROGRESS_RETRY_AFTER_MS / 1000)}s; no operator action needed`,
        },
      );
    }
    // Background acquire completed within budget but returned null = failure.
    // Same classification rule as the bounded-retry suppression: transient
    // failures get REFRESH_IN_PROGRESS so the consumer doesn't mistake them
    // for "operator must act"; CA challenges fall through to the original 409.
    if (outcome === null) {
      const lastFailure = this.lastAcquireFailure.get(key);
      if (!lastFailure?.isCa) {
        throw new HermesError(
          HermesErrorCode.REFRESH_IN_PROGRESS,
          `recent autoReacquire for ${service}:${scheme} failed transiently — retry shortly`,
          {
            retryAfterMs: Broker.REFRESH_IN_PROGRESS_RETRY_AFTER_MS,
            retryHint: HermesRetryHint.RETRY_AFTER,
            remediation: `retry the same request after ~${Math.ceil(Broker.REFRESH_IN_PROGRESS_RETRY_AFTER_MS / 1000)}s; the broker will attempt acquire again`,
          },
        );
      }
      return null;
    }
    return outcome;
  }

  /**
   * Run the post-store propagation callback so it can never retro-classify a
   * capture that already succeeded.
   *
   * By the time this runs the bundle is persisted (`storage.set` has returned),
   * so the credential is stored and will be served. If the callback throws from
   * inside the success `try` of acquireAndStore/fetchLocked, the catch converts
   * a good, stored credential into ACQUIRE_REQUIRED and activates a cooldown,
   * and the proactive-failure counter walks toward the disarm threshold, so the
   * service stops self-refreshing even though every capture worked.
   *
   * cli.ts already swallows the ToolHive push for exactly this reason; this
   * generalizes the guarantee to EVERY propagation failure (a throwing
   * scheduleTokenRefresh included), rather than one known-flaky downstream.
   * Failures are logged at error level, never silently dropped.
   */
  private async notifyTokenRefreshed(bundle: TokenBundle): Promise<void> {
    if (!this.deps.onTokenRefreshed) return;
    try {
      await this.deps.onTokenRefreshed(bundle);
    } catch (err) {
      this.deps.logger.error('token propagation failed AFTER a successful store; the credential is stored and will be served', {
        service: bundle.service,
        scheme: bundle.scheme,
        error: (err as Error).message,
      });
    }
  }

  private async acquireAndStore(provider: Provider, ctx: ProviderContext, service: string, scheme: string): Promise<TokenBundle> {
    // Consolidated gate: connectivity + AD budget — guards every
    // provider.acquire() regardless of trigger (consumer force, scheduler
    // refresh-fallback, health monitor).
    await this.acquireGate(service, scheme);
    await this.recordAdAcquireAttempt(service, scheme);
    await this.lifecycle((store) => store.recordAcquireAttempt(service, scheme));
    try {
      const bundle = await provider.acquire(ctx, scheme);
      await this.deps.storage.set(bundle);
      this.suspectCredentials.delete(`${service}:${scheme}`);
      await this.lifecycle((store) => store.recordAcquireSuccess(service, scheme));
      await this.recordStoredFreshProof(bundle);
      await this.notifyTokenRefreshed(bundle);
      return bundle;
    } catch (err) {
      const challenge = conditionalAccessChallenge(err);
      const acquireErr = new HermesError(
        HermesErrorCode.ACQUIRE_REQUIRED,
        challenge
          ? `acquire failed for ${service}:${scheme}: ${challenge.state}`
          : `acquire failed for ${service}:${scheme}: ${(err as Error).message}`,
        { cause: err, ...this.authRequiredOptions(service, challenge ? { challenge } : {}) },
      );
      await this.recordRecoveryFailureProof(service, scheme, null, acquireErr, 'acquire', 'failed');
      await this.activateCooldown(service, scheme, acquireErr, 'acquire');
      throw acquireErr;
    }
  }

  private async cooldownUntil(service: string, scheme: string): Promise<number | undefined> {
    const key = `${service}:${scheme}`;
    const memoryUntil = this.cooldowns.get(key);
    let persistedUntil: number | undefined;
    if (this.deps.lifecycleStore) {
      try {
        persistedUntil = (await this.deps.lifecycleStore.get(service, scheme))?.cooldownUntil;
      } catch (err) {
        this.deps.logger.warn('could not read lifecycle cooldown state', { service, scheme, error: (err as Error).message });
      }
    }
    const until = Math.max(memoryUntil ?? 0, persistedUntil ?? 0);
    return until > 0 ? until : undefined;
  }

  private async isCredentialSuspect(service: string, scheme: string): Promise<boolean> {
    const key = `${service}:${scheme}`;
    if (this.suspectCredentials.has(key)) return true;
    if (!this.deps.lifecycleStore) return false;
    try {
      return (await this.deps.lifecycleStore.get(service, scheme))?.credentialStatus === 'suspect';
    } catch (err) {
      this.deps.logger.warn('could not read lifecycle credential status', { service, scheme, error: (err as Error).message });
      return false;
    }
  }

  private async activateCooldown(service: string, scheme: string, err: unknown, kind: 'refresh' | 'acquire'): Promise<void> {
    // If the cached access token is still well within its lifetime, refresh
    // failures shouldn't poison the consumer-facing endpoint. Just record the
    // failure for diagnostics but skip the cooldown gate so subsequent calls
    // can return the cached token via the freshness check.
    if (kind === 'refresh') {
      try {
        const cached = await this.deps.storage.get(service, scheme);
        if (cached && cached.expiresAt - Date.now() > 0) {
          this.deps.logger.warn('skipping cooldown: cached access token still valid', {
            service, scheme, msUntilExpiry: cached.expiresAt - Date.now(),
          });
          await this.lifecycle((store) => store.recordRefreshFailure(service, scheme, err));
          return;
        }
      } catch { /* fall through to default cooldown */ }
    }
    const until = Date.now() + Broker.COOLDOWN_MS;
    this.cooldowns.set(`${service}:${scheme}`, until);
    // Record whether the triggering failure was a CA challenge so the
    // cooldown gate can classify its response (CA → 409, transient → 503).
    const isCa = !!conditionalAccessChallenge(err);
    this.cooldownReason.set(`${service}:${scheme}`, { isCa });
    // Persist the CA flag so a restart keeps the 409-vs-503 classification.
    await this.lifecycle((store) => store.recordAcquireGovernorState(service, scheme, { cooldownIsCa: isCa }));
    if (kind === 'refresh') {
      await this.lifecycle((store) => store.recordRefreshFailure(service, scheme, err, { cooldownUntil: until }));
    } else {
      await this.lifecycle((store) => store.recordAcquireFailure(service, scheme, err, { cooldownUntil: until }));
    }
  }

  private async lifecycle(action: (store: LifecycleStateStore) => Promise<unknown>): Promise<void> {
    if (!this.deps.lifecycleStore) return;
    try {
      await action(this.deps.lifecycleStore);
    } catch (err) {
      this.deps.logger.warn('could not update lifecycle state', { error: (err as Error).message });
    }
  }

  private async recordStoredFreshProof(bundle: TokenBundle): Promise<void> {
    await this.recordProofEvents(bundle.service, bundle.scheme, [storedProof(bundle), freshProof(bundle)]);
  }

  private async recordRecoveryFailureProof(
    service: string,
    scheme: string,
    bundle: TokenBundle | null,
    err: unknown,
    phase: 'refresh' | 'refresh_fallback_to_acquire' | 'acquire',
    status: 'degraded' | 'failed',
  ): Promise<void> {
    await this.recordProofEvents(service, scheme, proofEventsFromRecoveryFailure(bundle, err, phase, status));
  }

  private async recordProofEvents(service: string, scheme: string, events: ProofEvent[]): Promise<void> {
    const summary = summarizeProof(events);
    await this.lifecycle((store) => store.recordProofEvents(service, scheme, events, {
      proofTier: summary.highestValidTier ?? summary.currentTier,
      proofState: summary.state,
    }));
  }

  private notifyOperator(payload: OperatorActionPayload): void {
    const key = `${payload.service}:${payload.scheme}`;
    const lastNotified = this.operatorNotified.get(key);
    if (lastNotified && Date.now() - lastNotified < Broker.OPERATOR_NOTIFY_DEDUP_MS) return;
    this.operatorNotified.set(key, Date.now());
    try {
      this.deps.onOperatorActionRequired?.(payload);
    } catch (err) {
      this.deps.logger.warn('onOperatorActionRequired callback failed', { error: (err as Error).message });
    }
  }

  clearOperatorNotification(service: string, scheme: string): void {
    this.operatorNotified.delete(`${service}:${scheme}`);
  }

  private authRequiredOptions(service: string, opts: { retryAfterMs?: number; challenge?: ConditionalAccessChallengePayload } = {}): {
    category: HermesErrorCategory;
    retryable: boolean;
    retryAfterMs?: number;
    retryHint: HermesRetryHint;
    remediation: string;
    remediationCommands: string[];
    conditionalAccessChallenge?: ConditionalAccessChallengePayload;
  } {
    const command = `hermes acquire ${service}`;
    const challenge = opts.challenge;
    const commands = challenge?.remediationCommands.length ? challenge.remediationCommands : [command];
    const retryAfterMs = opts.retryAfterMs ?? challenge?.retryAfterMs;
    const retryable = challenge?.retryable ?? false;
    const retryHint = challenge?.retryHint === 'retry-after'
      ? HermesRetryHint.RETRY_AFTER
      : challenge?.retryHint === 'safe-to-retry'
        ? HermesRetryHint.SAFE_TO_RETRY
        : challenge?.retryHint === 'do-not-retry'
          ? HermesRetryHint.DO_NOT_RETRY
          : HermesRetryHint.HUMAN_ACTION_REQUIRED;
    const category = challenge?.category === 'transient'
      ? HermesErrorCategory.TRANSIENT
      : challenge?.category === 'configuration-required'
        ? HermesErrorCategory.CONFIGURATION
        : HermesErrorCategory.AUTH_REQUIRED;
    return {
      category,
      retryable,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      retryHint,
      remediation: challenge?.remediation ?? `run: ${command}`,
      remediationCommands: commands,
      ...(challenge ? { conditionalAccessChallenge: challenge } : {}),
    };
  }
}
