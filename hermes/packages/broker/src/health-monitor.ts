import type { Logger } from './logger.js';
import type { TokenStorage } from './storage.js';
import type { TokenBundle } from './types.js';
import type { LifecycleStateStore, ProofEvent } from './lifecycle-state.js';
import { freshProof, proofEventsFromLifecycle, summarizeProof, storedProof, type ProofSummary } from './proof-probes.js';

export interface TokenHealth {
  service: string;
  scheme: string;
  accessTokenExpiresAt: number;
  refreshTokenAge: number | null;
  status: 'healthy' | 'expiring' | 'expired' | 'no-refresh-token';
  proof?: ProofSummary;
}

export interface HealthMonitorOptions {
  storage: TokenStorage;
  logger: Logger;
  checkIntervalMs?: number;
  refreshTokenMaxAgeMs?: number;
  warningThresholdMs?: number;
  accessTokenFreshMarginMs?: number;
  lifecycleStore?: LifecycleStateStore;
  providerValidationProbe?: (bundle: TokenBundle) => Promise<ProofEvent>;
  onWarning?: (health: TokenHealth) => void;
}

const DEFAULT_CHECK_INTERVAL = 30 * 60_000;
const DEFAULT_RT_MAX_AGE = 24 * 3600_000;
const DEFAULT_WARNING_THRESHOLD = 20 * 3600_000;
const DEFAULT_ACCESS_TOKEN_FRESH_MARGIN = 5 * 60_000;

export class TokenHealthMonitor {
  private timer: NodeJS.Timeout | null = null;
  private lastCheck: TokenHealth[] = [];
  private readonly checkIntervalMs: number;
  private readonly rtMaxAgeMs: number;
  private readonly warningMs: number;
  private readonly accessTokenFreshMarginMs: number;

  constructor(private readonly opts: HealthMonitorOptions) {
    this.checkIntervalMs = opts.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL;
    this.rtMaxAgeMs = opts.refreshTokenMaxAgeMs ?? DEFAULT_RT_MAX_AGE;
    this.warningMs = opts.warningThresholdMs ?? DEFAULT_WARNING_THRESHOLD;
    this.accessTokenFreshMarginMs = opts.accessTokenFreshMarginMs ?? DEFAULT_ACCESS_TOKEN_FRESH_MARGIN;
  }

  start(): void {
    if (this.timer) return;
    this.runCheck().catch((err) =>
      this.opts.logger.warn('health check failed', { error: (err as Error).message }),
    );
    const t = setInterval(() => {
      this.runCheck().catch((err) =>
        this.opts.logger.warn('health check failed', { error: (err as Error).message }),
      );
    }, this.checkIntervalMs);
    if (typeof t.unref === 'function') t.unref();
    this.timer = t;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  status(): TokenHealth[] {
    return this.lastCheck;
  }

  async runCheck(): Promise<TokenHealth[]> {
    const bundles = await this.opts.storage.list();
    const now = Date.now();
    const results: TokenHealth[] = [];

    for (const bundle of bundles) {
      const health = this.assess(bundle, now);
      health.proof = await this.assessProof(bundle, now);
      results.push(health);

      if (health.status === 'expiring') {
        this.opts.logger.warn('refresh token approaching expiry', {
          service: health.service,
          scheme: health.scheme,
          ageHours: health.refreshTokenAge != null ? Math.round(health.refreshTokenAge / 3600_000 * 10) / 10 : null,
          maxAgeHours: this.rtMaxAgeMs / 3600_000,
        });
        this.opts.onWarning?.(health);
      } else if (health.status === 'expired') {
        this.opts.logger.error('refresh token likely expired — interactive re-auth needed', {
          service: health.service,
          scheme: health.scheme,
          remediation: `run: hermes acquire ${health.service}`,
        });
        this.opts.onWarning?.(health);
      }
    }

    this.lastCheck = results;
    return results;
  }

  assess(bundle: TokenBundle, now: number = Date.now()): TokenHealth {
    const base: Pick<TokenHealth, 'service' | 'scheme' | 'accessTokenExpiresAt'> = {
      service: bundle.service,
      scheme: bundle.scheme,
      accessTokenExpiresAt: bundle.expiresAt,
    };

    if (!bundle.refreshToken) {
      return { ...base, refreshTokenAge: null, status: 'no-refresh-token' };
    }

    const age = now - bundle.acquiredAt;

    if (age >= this.rtMaxAgeMs) {
      return { ...base, refreshTokenAge: age, status: 'expired' };
    }
    if (age >= this.warningMs) {
      return { ...base, refreshTokenAge: age, status: 'expiring' };
    }
    return { ...base, refreshTokenAge: age, status: 'healthy' };
  }

  private async assessProof(bundle: TokenBundle, now: number): Promise<ProofSummary> {
    const events: ProofEvent[] = [
      storedProof(bundle, now),
      freshProof(bundle, { now, safetyMarginMs: this.accessTokenFreshMarginMs }),
    ];

    if (this.opts.providerValidationProbe) {
      try {
        events.push(await this.opts.providerValidationProbe(bundle));
      } catch (err) {
        events.push({
          tier: 'provider_validated',
          status: 'degraded',
          at: now,
          error: (err as Error).message,
        });
      }
    }

    let lifecycleEvents: ProofEvent[] = [];
    if (this.opts.lifecycleStore) {
      try {
        lifecycleEvents = proofEventsFromLifecycle(await this.opts.lifecycleStore.get(bundle.service, bundle.scheme), now);
        events.push(...lifecycleEvents);
      } catch (err) {
        this.opts.logger.warn('could not read lifecycle proof state', { service: bundle.service, scheme: bundle.scheme, error: (err as Error).message });
      }
    }

    const summary = summarizeProof(events);
    if (this.opts.lifecycleStore) {
      try {
        const recordable = events.filter((event) => event.tier === 'stored' || event.tier === 'fresh' || event.tier === 'provider_validated');
        await this.opts.lifecycleStore.recordProofEvents(bundle.service, bundle.scheme, recordable, {
          proofTier: summary.highestValidTier ?? summary.currentTier,
          proofState: summary.state,
        });
      } catch (err) {
        this.opts.logger.warn('could not update proof state', { service: bundle.service, scheme: bundle.scheme, error: (err as Error).message });
      }
    }

    return summary;
  }
}
