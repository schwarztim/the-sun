import type { Provider, ProviderContext, TokenBundle } from './types.js';

export type ValidationPolicy = 'eager' | 'lazy' | 'paranoid';

export interface ValidatorOptions {
  policy: ValidationPolicy;
  safetyMarginSec: number;
  eagerThresholdSec?: number;
  /**
   * Consulted immediately before any provider.validate() call. 'ok' proceeds
   * (and the gate owner records the call against maxValidationsPerHour);
   * 'offline' / 'budget' skip provider.validate — the token is assessed by
   * expiry math alone and reported as providerValidation: 'not-run'.
   * Wired to Broker.validationGate (see broker.ts).
   */
  validationGate?: (service: string, scheme: string) => 'ok' | 'offline' | 'budget';
}

export interface FreshnessQuery { cacheAge: number; }
export type ProviderValidationOutcome = 'not-run' | 'not-supported' | 'valid' | 'invalid' | 'error';

export interface FreshnessAssessment {
  fresh: boolean;
  accessTokenFresh: boolean;
  msUntilExpiry: number;
  safetyMarginMs: number;
  providerValidation: ProviderValidationOutcome;
  providerValidationError?: string;
}

const DEFAULT_EAGER_THRESHOLD = 60;

export class TokenValidator {
  constructor(private readonly opts: ValidatorOptions) {}

  async isFresh(provider: Provider, ctx: ProviderContext, bundle: TokenBundle, query: FreshnessQuery): Promise<boolean> {
    return (await this.assessFreshness(provider, ctx, bundle, query)).fresh;
  }

  async assessFreshness(provider: Provider, ctx: ProviderContext, bundle: TokenBundle, query: FreshnessQuery): Promise<FreshnessAssessment> {
    const msLeft = bundle.expiresAt - Date.now();
    const safetyMarginMs = this.opts.safetyMarginSec * 1000;
    if (msLeft <= safetyMarginMs) {
      return { fresh: false, accessTokenFresh: false, msUntilExpiry: msLeft, safetyMarginMs, providerValidation: 'not-run' };
    }
    const threshold = this.opts.eagerThresholdSec ?? DEFAULT_EAGER_THRESHOLD;
    const capabilities = provider.capabilities?.schemes.find((scheme) => scheme.scheme === bundle.scheme);
    const requiresPerUseValidation = capabilities?.credentialSource === 'cookie-session' && capabilities.validationStrategy === 'service-probe';
    const needsValidate = this.opts.policy === 'paranoid'
      || (this.opts.policy === 'eager' && (requiresPerUseValidation || query.cacheAge >= threshold));
    if (!needsValidate) return { fresh: true, accessTokenFresh: true, msUntilExpiry: msLeft, safetyMarginMs, providerValidation: 'not-run' };
    if (capabilities && (!capabilities.supportsValidation || capabilities.validationStrategy === 'none')) {
      return { fresh: true, accessTokenFresh: true, msUntilExpiry: msLeft, safetyMarginMs, providerValidation: 'not-supported' };
    }
    if (this.opts.validationGate) {
      const verdict = this.opts.validationGate(bundle.service, bundle.scheme);
      if (verdict !== 'ok') {
        ctx.logger.info('provider validation skipped by gate', { service: ctx.service, scheme: bundle.scheme, verdict });
        return { fresh: true, accessTokenFresh: true, msUntilExpiry: msLeft, safetyMarginMs, providerValidation: 'not-run' };
      }
    }
    try {
      const valid = await provider.validate(ctx, bundle);
      return { fresh: valid, accessTokenFresh: true, msUntilExpiry: msLeft, safetyMarginMs, providerValidation: valid ? 'valid' : 'invalid' };
    } catch (err) {
      const message = (err as Error).message;
      ctx.logger.warn('provider.validate threw', { service: ctx.service, error: message });
      const retryable = (err as { retryable?: unknown }).retryable === true;
      return { fresh: retryable, accessTokenFresh: true, msUntilExpiry: msLeft, safetyMarginMs, providerValidation: 'error', providerValidationError: message };
    }
  }
}
