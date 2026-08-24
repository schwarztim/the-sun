import { sanitizeLifecycleMessage, type LifecycleState, type ProofEvent, type ProofState, type ProofTier, type PropagationEvent, type PropagationStatus } from './lifecycle-state.js';
import type { FreshnessAssessment } from './validator.js';
import type { Provider, ProviderContext, TokenBundle } from './types.js';

/**
 * Scope-appropriate HTTP probe endpoints for az-teams schemes.
 *
 * These endpoints are selected to prove what the token CAN do using only the
 * minimal scopes actually granted by the issuing client app:
 *
 * - graph: GET /v1.0/me  — User.Read is always granted to the Azure CLI app
 *   (04b07795-8ddb-461a-bbee-02f9e1bf7b46). Chat.Read is NOT present; probing
 *   any Chat endpoint would 403 even though the token is perfectly healthy.
 *
 * - files: GET /v1.0/me/drive  — requires Files.ReadWrite.All, which is in the
 *   filesClientId (9199bf20) token scope. Does NOT require Chat.* scopes.
 *
 * - teams-bearer: GET /v1.0/me  — the Teams SPA token (5e3ce6c0) has openid
 *   and api.spaces.skype.com scopes. Calling the Teams-internal CSA endpoint
 *   or any Graph endpoint that requires additional consent would fail. /v1.0/me
 *   is the safest minimal-scope probe that confirms the token is accepted by
 *   the resource server.
 *
 * - skype: no HTTP probe — skype tokens are derived from the Teams exchange
 *   and the exchange itself is the proof. Probing the authsvc would require
 *   constructing a POST body; trust the exchange result instead.
 *
 * - substrate: GET https://outlook.office.com/api/v2.0/me — the substrate
 *   scope (outlook.office.com/search/.default) grants access to the OWA API
 *   root, which returns the mailbox user object without needing Mail.Read.
 */
export const AZ_TEAMS_SCHEME_PROBE_URLS: Record<string, string | null> = {
  graph: 'https://graph.microsoft.com/v1.0/me',
  files: 'https://graph.microsoft.com/v1.0/me/drive',
  'teams-bearer': 'https://graph.microsoft.com/v1.0/me',
  // teams is normalized to teams-bearer before reaching the provider; include
  // both for safety so callers using the raw scheme name also resolve correctly.
  teams: 'https://graph.microsoft.com/v1.0/me',
  skype: null,   // derived token — no HTTP probe; trust the authsvc exchange
  substrate: 'https://outlook.office.com/api/v2.0/me',
};

export type AzTeamsHttpProbeFetcher = (
  url: string,
  init: { method?: string; headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number }>;

/**
 * Perform a scope-appropriate HTTP proof probe for a single az-teams token.
 *
 * Returns a `provider_validated` ProofEvent reflecting the HTTP response.
 * Skips the HTTP call for schemes with no probe URL (e.g. skype) and returns a
 * `skipped` event so callers do not falsely report probe failures.
 *
 * This function is intentionally provider-agnostic: it accepts a raw access
 * token and scheme string so it can be used from proof-collection paths that do
 * not have a full Provider instance available.
 *
 * @param scheme  - The az-teams scheme (e.g. 'graph', 'files', 'teams-bearer').
 * @param accessToken - The raw Bearer token to probe with.
 * @param fetcher - Optional HTTP fetch override (for testing). Defaults to
 *   globalThis.fetch.
 * @param at - Timestamp override for the proof event (default: Date.now()).
 */
export async function azTeamsHttpProof(
  scheme: string,
  accessToken: string,
  fetcher?: AzTeamsHttpProbeFetcher,
  at = Date.now(),
): Promise<ProofEvent> {
  const probeUrl = AZ_TEAMS_SCHEME_PROBE_URLS[scheme];

  if (probeUrl === null) {
    return {
      tier: 'provider_validated',
      status: 'skipped',
      at,
      message: `az-teams:${scheme} is a derived token; no HTTP probe is performed`,
      metadata: { scheme, probeStrategy: 'derived-skip' },
    };
  }

  if (probeUrl === undefined) {
    return {
      tier: 'provider_validated',
      status: 'skipped',
      at,
      message: `az-teams: no scope-appropriate probe URL configured for scheme "${scheme}"`,
      metadata: { scheme, probeStrategy: 'unconfigured-skip' },
    };
  }

  const doFetch: AzTeamsHttpProbeFetcher = fetcher ?? (async (url, init) => {
    const r = await globalThis.fetch(url, { method: init.method ?? 'GET', headers: init.headers });
    return { ok: r.ok, status: r.status };
  });

  try {
    const resp = await doFetch(probeUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    // A 200 proves the token is accepted by the resource server for this scope.
    // A 403 is a definitive scope failure (not a token validity failure): the
    // token is accepted (auth succeeded) but the scope is insufficient. This
    // should never happen if probeUrl is kept in sync with the granted scopes,
    // and if it does it indicates the probe URL config is wrong, not the token.
    // Treat 403 as failed so the misconfiguration is surfaced.
    return {
      tier: 'provider_validated',
      status: resp.ok ? 'valid' : 'failed',
      at,
      message: resp.ok ? undefined : `scope-appropriate probe returned HTTP ${resp.status}`,
      metadata: { scheme, probeUrl, httpStatus: resp.status, probeStrategy: 'scope-appropriate-get' },
    };
  } catch (err) {
    return {
      tier: 'provider_validated',
      status: 'degraded',
      at,
      error: sanitizeLifecycleMessage(err),
      metadata: { scheme, probeUrl, probeStrategy: 'scope-appropriate-get' },
    };
  }
}

export const PROOF_TIERS = ['stored', 'fresh', 'provider_validated', 'propagated', 'mcp_validated'] as const satisfies readonly ProofTier[];

const tierRank = new Map<ProofTier, number>(PROOF_TIERS.map((tier, index) => [tier, index]));

export interface ProofSummary {
  highestValidTier?: ProofTier;
  currentTier: ProofTier;
  state: ProofState;
  tiers: ProofEvent[];
}

function metadata(entries: Record<string, string | number | boolean | null | undefined>): NonNullable<ProofEvent['metadata']> {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined)) as NonNullable<ProofEvent['metadata']>;
}

function rank(tier: ProofTier): number {
  return tierRank.get(tier) ?? -1;
}

export function summarizeProof(events: ProofEvent[]): ProofSummary {
  const tiers = [...events].sort((a, b) => rank(a.tier) - rank(b.tier));
  const highestValid = tiers.filter((event) => event.status === 'valid').at(-1);
  const current = [...tiers].reverse().find((event) => event.status !== 'skipped')
    ?? tiers.at(-1)
    ?? { tier: 'stored' as const, status: 'unknown' as const, at: Date.now() };
  return {
    ...(highestValid ? { highestValidTier: highestValid.tier } : {}),
    currentTier: current.tier,
    state: current.status,
    tiers,
  };
}

export function storedProof(bundle: TokenBundle | null, at = Date.now()): ProofEvent {
  if (!bundle) {
    return { tier: 'stored', status: 'failed', at, message: 'no stored token bundle found' };
  }
  return {
    tier: 'stored',
    status: 'valid',
    at,
    metadata: metadata({
      service: bundle.service,
      scheme: bundle.scheme,
      tokenType: bundle.tokenType,
      expiresAt: bundle.expiresAt,
      hasRefreshToken: Boolean(bundle.refreshToken),
    }),
  };
}

export function freshProof(bundle: TokenBundle, opts: { now?: number; safetyMarginMs?: number } = {}): ProofEvent {
  const now = opts.now ?? Date.now();
  const safetyMarginMs = opts.safetyMarginMs ?? 0;
  const msUntilExpiry = bundle.expiresAt - now;
  const valid = msUntilExpiry > safetyMarginMs;
  return {
    tier: 'fresh',
    status: valid ? 'valid' : 'failed',
    at: now,
    message: valid ? undefined : 'access token is expired or inside the freshness safety margin',
    metadata: metadata({
      expiresAt: bundle.expiresAt,
      msUntilExpiry,
      safetyMarginMs,
    }),
  };
}

export function proofEventsFromFreshnessAssessment(bundle: TokenBundle, assessment: FreshnessAssessment, at = Date.now()): ProofEvent[] {
  const events: ProofEvent[] = [
    storedProof(bundle, at),
    {
      tier: 'fresh',
      status: assessment.accessTokenFresh ? 'valid' : 'failed',
      at,
      message: assessment.accessTokenFresh ? undefined : 'access token is expired or inside the freshness safety margin',
      metadata: metadata({
        expiresAt: bundle.expiresAt,
        msUntilExpiry: assessment.msUntilExpiry,
        safetyMarginMs: assessment.safetyMarginMs,
      }),
    },
  ];

  if (assessment.providerValidation !== 'not-run') {
    events.push({
      tier: 'provider_validated',
      status: assessment.providerValidation === 'valid' ? 'valid' : assessment.providerValidation === 'invalid' ? 'failed' : 'degraded',
      at,
      message: assessment.providerValidation === 'not-supported' ? 'provider validation is not supported for this scheme' : undefined,
      error: assessment.providerValidationError ? sanitizeLifecycleMessage(assessment.providerValidationError) : undefined,
      metadata: metadata({
        providerValidation: assessment.providerValidation,
      }),
    });
  }

  return events;
}

export function proofEventsFromRecoveryFailure(
  bundle: TokenBundle | null,
  err: unknown,
  phase: 'refresh' | 'refresh_fallback_to_acquire' | 'acquire',
  status: ProofState = 'degraded',
  at = Date.now(),
): ProofEvent[] {
  return [
    storedProof(bundle, at),
    ...(bundle ? [freshProof(bundle, { now: at })] : []),
    {
      tier: 'provider_validated',
      status,
      at,
      message: `${phase} did not produce a provider-validated credential`,
      error: sanitizeLifecycleMessage(err),
      metadata: metadata({ phase }),
    },
  ];
}

export async function providerValidationProof(provider: Provider, ctx: ProviderContext, bundle: TokenBundle, at = Date.now()): Promise<ProofEvent> {
  const capabilities = provider.capabilities?.schemes.find((scheme) => scheme.scheme === bundle.scheme);
  if (capabilities && (!capabilities.supportsValidation || capabilities.validationStrategy === 'none')) {
    return {
      tier: 'provider_validated',
      status: 'skipped',
      at,
      message: 'provider validation is not supported for this scheme',
      metadata: metadata({
        provider: provider.name,
        validationStrategy: capabilities.validationStrategy,
      }),
    };
  }

  try {
    const valid = await provider.validate(ctx, bundle);
    return {
      tier: 'provider_validated',
      status: valid ? 'valid' : 'failed',
      at,
      metadata: metadata({
        provider: provider.name,
        validationStrategy: capabilities?.validationStrategy ?? 'unknown',
      }),
    };
  } catch (err) {
    return {
      tier: 'provider_validated',
      status: 'degraded',
      at,
      error: sanitizeLifecycleMessage(err),
      metadata: metadata({
        provider: provider.name,
        validationStrategy: capabilities?.validationStrategy ?? 'unknown',
      }),
    };
  }
}

function eventStatus(events: PropagationEvent[], step: PropagationEvent['step']): PropagationEvent['status'] | undefined {
  return [...events].reverse().find((event) => event.step === step)?.status;
}

function mcpValidationState(events: PropagationEvent[]): ProofState {
  const authEvents = events.filter((event) => event.step === 'downstream_auth_probe');
  if (authEvents.length === 0) return 'skipped';
  const required = authEvents.filter((event) => event.metadata?.required === true);
  const decisive = required.length > 0 ? required : authEvents;
  if (decisive.some((event) => event.status === 'failed')) return 'failed';
  if (required.length > 0 && decisive.some((event) => event.status === 'degraded' || event.status === 'skipped')) return 'degraded';
  if (decisive.some((event) => event.status === 'degraded')) return 'degraded';
  if (decisive.some((event) => event.status === 'ok')) return 'valid';
  return 'skipped';
}

function mapPropagationStatus(status: PropagationStatus | undefined): ProofState {
  if (status === 'ok') return 'valid';
  if (status === 'degraded' || status === 'in_progress') return 'degraded';
  if (status === 'failed') return 'failed';
  return 'skipped';
}

export function proofEventsFromPropagation(status: PropagationStatus | undefined, events: PropagationEvent[] = [], at = Date.now()): ProofEvent[] {
  const secret = eventStatus(events, 'secret_write');
  const readiness = eventStatus(events, 'container_readiness');
  const fleet = eventStatus(events, 'fleet_sync');
  const gateway = eventStatus(events, 'gateway_reload');
  const smoke = eventStatus(events, 'downstream_smoke_probe');
  const authProbe = eventStatus(events, 'downstream_auth_probe');
  const propagatedValid = secret === 'ok'
    && readiness === 'ok'
    && fleet !== 'failed'
    && gateway !== 'degraded'
    && gateway !== 'failed'
    && smoke !== 'degraded'
    && smoke !== 'failed';
  const propagatedState: ProofState = propagatedValid ? 'valid' : mapPropagationStatus(status);
  const mcpState = mcpValidationState(events);

  return [
    {
      tier: 'propagated',
      status: propagatedState,
      at,
      message: propagatedState === 'skipped' ? 'service is not configured for token propagation' : undefined,
      metadata: metadata({ propagationStatus: status ?? 'unknown' }),
    },
    {
      tier: 'mcp_validated',
      status: mcpState,
      at,
      message: mcpState === 'skipped'
        ? 'authenticated downstream MCP probe is not configured or did not run; transport smoke only does not validate credentials'
        : undefined,
      metadata: metadata({ smokeProbeStatus: smoke ?? 'unknown', authProbeStatus: authProbe ?? 'unknown' }),
    },
  ];
}

export function proofEventsFromLifecycle(state: LifecycleState | null, at = Date.now()): ProofEvent[] {
  if (!state) return [];
  return proofEventsFromPropagation(state.propagationStatus, state.propagationEvents ?? [], at);
}
