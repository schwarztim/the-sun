import { sanitizeLifecycleMessage, type LifecycleState } from './lifecycle-state.js';
import type { OrgRunbookMetadata } from './org-runbook-registry.js';

export type OperatorHealthStatus = 'healthy' | 'degraded';

/** Staleness thresholds for status-read-time evaluation. */
const PROPAGATION_STALE_MS = 30 * 60_000;     // 30 minutes: in_progress → stale
const LIFECYCLE_ERROR_STALE_MS = 7 * 24 * 3600_000; // 7 days: old lifecycle errors excluded from degraded count

/** Minimal registry interface for status evaluation — avoids a direct circular dep on the full registry. */
export interface StatusRegistryLens {
  getService(name: string): { autoReacquire?: boolean; thvContainerName?: string; providerName: string } | undefined;
  getProvider(name: string): { capabilities?: { schemes?: ReadonlyArray<{ scheme: string; refreshStrategy: string }> } } | undefined;
}

export interface OperatorEvidence {
  service?: string;
  scheme?: string;
  kind: string;
  status?: string;
  at?: string;
  message?: string;
  details?: Record<string, unknown>;
}

export interface OperatorServiceSummary {
  service: string;
  scheme: string;
  status: OperatorHealthStatus;
  reason: string;
  proofTier?: string;
  proofState?: string;
  propagationStatus?: string;
  lifecycleError?: string;
  nextAction: string;
  orgMetadata?: OrgRunbookMetadata;
  evidence: OperatorEvidence[];
}

export interface OperatorSummary {
  status: OperatorHealthStatus;
  summary: string;
  nextAction: string;
  degradedServices: OperatorServiceSummary[];
  services: OperatorServiceSummary[];
  evidence: OperatorEvidence[];
}

type SerializedLifecycle = Record<string, unknown>;

export interface TokenHealthLike {
  service: string;
  scheme: string;
  status?: string;
  accessTokenExpiresAt?: unknown;
  refreshTokenAge?: unknown;
  refreshTokenAgeHours?: unknown;
  lifecycle?: LifecycleState | SerializedLifecycle;
  proof?: {
    highestValidTier?: string;
    currentTier?: string;
    state?: string;
    tiers?: Array<Record<string, unknown>>;
  };
}

export interface OperatorSummaryOptions {
  inventoryError?: unknown;
  orgRunbooks?: OrgRunbookMetadata[];
  orgMetadataError?: unknown;
  /** Optional registry lens; when provided, enables honest refreshability and staleness evaluation. */
  registry?: StatusRegistryLens;
  /** Override wall-clock time for testing staleness rules (ms since epoch). Defaults to Date.now(). */
  now?: number;
}

export function redactOperatorValue(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeLifecycleMessage(value);
  if (Array.isArray(value)) return value.map(redactOperatorValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (/^(access[_-]?token|refresh[_-]?token|id[_-]?token|authorization|token|secret|password|api[_-]?key|apikey)$/i.test(key)) {
        out[key] = '[redacted]';
      } else {
        out[key] = redactOperatorValue(entry);
      }
    }
    return out;
  }
  return value;
}

export function isoTime(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  return undefined;
}

function lifecycleString(lifecycle: LifecycleState | SerializedLifecycle | undefined, field: string): string | undefined {
  const value = lifecycle?.[field as keyof typeof lifecycle];
  return typeof value === 'string' ? value : undefined;
}

function lifecycleStatus(lifecycle: LifecycleState | SerializedLifecycle | undefined, field: string): string | undefined {
  const value = lifecycle?.[field as keyof typeof lifecycle];
  return typeof value === 'string' ? value : undefined;
}

function lifecycleTime(lifecycle: LifecycleState | SerializedLifecycle | undefined, field: string): string | undefined {
  return isoTime(lifecycle?.[field as keyof typeof lifecycle]);
}

function lifecycleEvents(lifecycle: LifecycleState | SerializedLifecycle | undefined, field: string): Array<Record<string, unknown>> {
  const value = lifecycle?.[field as keyof typeof lifecycle];
  return Array.isArray(value) ? value as Array<Record<string, unknown>> : [];
}

function addEvidence(target: OperatorEvidence[], evidence: OperatorEvidence): void {
  target.push(redactOperatorValue(evidence) as OperatorEvidence);
}

/**
 * Returns true when the service/scheme combination is inherently non-refreshable by design:
 *  - autoReacquire=true: the broker self-heals by re-running acquire() on expiry.
 *  - provider refreshStrategy is not 'refresh-token': cookie-session, api-token, PAT, etc.
 *    never have a refresh token; the provider reacquires instead.
 *
 * When non-refreshable, `no-refresh-token` is informational, not a degraded condition.
 */
function isNonRefreshableByDesign(token: TokenHealthLike, registry: StatusRegistryLens | undefined): boolean {
  if (!registry) return false;
  if (typeof registry.getService !== 'function') return false;
  const svc = registry.getService(token.service);
  if (!svc) return false;
  // autoReacquire=true: broker self-heals — definitely not degraded
  if (svc.autoReacquire === true) return true;
  // Check provider scheme capabilities (getProvider is optional for partial mocks)
  if (typeof registry.getProvider !== 'function') return false;
  const provider = registry.getProvider(svc.providerName);
  // Provider not installed (e.g. github_pat/stash_pat static imports): nothing in this
  // process can refresh the credential, so a missing refresh token is its permanent,
  // expected state — informational, not degraded. Expiry is still tracked separately.
  if (!provider) return true;
  const schemeCapabilities = provider.capabilities?.schemes?.find((s) => s.scheme === token.scheme);
  if (schemeCapabilities && schemeCapabilities.refreshStrategy !== 'refresh-token') return true;
  return false;
}

/**
 * Evaluate propagation status at status-read time.
 * Returns a synthetic status string to use in place of the raw persisted status,
 * or undefined to use the raw value as-is.
 *
 * Rules:
 *  - 'in_progress' older than 30 minutes → 'stale_in_progress'
 *  - 'failed' where the service no longer has thvContainerName → 'not_configured'
 */
function evaluatePropagationStatus(
  rawStatus: string | undefined,
  lastPropagationAt: number | undefined,
  token: TokenHealthLike,
  registry: StatusRegistryLens | undefined,
  now: number,
): string | undefined {
  if (!rawStatus) return undefined;
  if (rawStatus === 'in_progress') {
    if (lastPropagationAt !== undefined && (now - lastPropagationAt) > PROPAGATION_STALE_MS) {
      return 'stale_in_progress';
    }
    return 'in_progress';
  }
  if (rawStatus === 'failed' || rawStatus === 'degraded') {
    if (registry && typeof registry.getService === 'function') {
      const svc = registry.getService(token.service);
      if (svc && !svc.thvContainerName) {
        // Service no longer configured for propagation — old failed state is stale
        return 'not_configured';
      }
    }
  }
  return rawStatus;
}

function remediationFor(token: TokenHealthLike, degradedReasons: string[], evaluatedPropagationStatus?: string): string {
  const service = token.service;
  const lifecycleCode = lifecycleString(token.lifecycle, 'lastErrorCode');
  if (token.status === 'expired' || lifecycleCode === 'INTERACTIVE_AUTH_REQUIRED') {
    return `Run: hermes acquire ${service}. Do not delete or rotate stored credentials.`;
  }
  if (token.status === 'expiring') {
    return `Retry the token request for ${service}/${token.scheme}; if refresh fails, run: hermes acquire ${service}.`;
  }
  if (evaluatedPropagationStatus === 'stale_in_progress') {
    return `Propagation state is stale (started over 30 minutes ago). Will re-evaluate on next hermes acquire ${service}.`;
  }
  if (evaluatedPropagationStatus === 'not_configured') {
    return `Propagation is not configured for ${service}. No action required unless you add a ToolHive container.`;
  }
  const rawPropagationStatus = lifecycleStatus(token.lifecycle, 'propagationStatus');
  if (rawPropagationStatus === 'failed' || rawPropagationStatus === 'degraded') {
    return `Run: hermes doctor. After runtime checks pass, retry the downstream MCP that uses ${service}/${token.scheme}.`;
  }
  if (rawPropagationStatus === 'in_progress') {
    return `Wait for propagation to finish, then re-run hermes status or retry ${service}/${token.scheme}.`;
  }
  if (degradedReasons.some((reason) => reason.includes('proof'))) {
    return `Retry the token request for ${service}/${token.scheme}; if proof remains degraded, run: hermes doctor.`;
  }
  if (lifecycleCode) {
    return `Address ${lifecycleCode} for ${service}/${token.scheme}; start with: hermes doctor.`;
  }
  return 'Run: hermes doctor for runtime diagnostics.';
}

function findOrgMetadata(entries: OrgRunbookMetadata[] | undefined, service: string, scheme: string): OrgRunbookMetadata | undefined {
  return entries?.find((entry) => entry.service === service && entry.scheme === scheme)
    ?? entries?.find((entry) => entry.service === service && entry.scheme === undefined);
}

function orgSummary(metadata: OrgRunbookMetadata): Record<string, unknown> {
  return redactOperatorValue({
    owner: metadata.owner,
    team: metadata.team,
    confluenceRunbookUrl: metadata.confluenceRunbookUrl,
    confluencePageId: metadata.confluencePageId ?? metadata.pageId,
    jiraGroup: metadata.jiraGroup,
    serviceNowGroup: metadata.serviceNowGroup,
    safeProbe: metadata.safeProbe,
    conditionalAccess: metadata.conditionalAccess ?? metadata.conditionalAccessNotes,
    vpn: metadata.vpn,
    networkRequirements: metadata.networkRequirements,
    integrationNotes: metadata.integrationNotes,
    lastVerifiedAt: metadata.lastVerifiedAt,
  }) as Record<string, unknown>;
}

export function summarizeOperatorHealth(tokens: TokenHealthLike[], opts: OperatorSummaryOptions = {}): OperatorSummary {
  const services: OperatorServiceSummary[] = [];
  const evidence: OperatorEvidence[] = [];
  const now = opts.now ?? Date.now();

  if (opts.inventoryError !== undefined) {
    addEvidence(evidence, {
      kind: 'token-inventory',
      status: 'degraded',
      message: sanitizeLifecycleMessage(opts.inventoryError),
    });
  }

  if (opts.orgMetadataError !== undefined) {
    addEvidence(evidence, {
      kind: 'org-runbook-registry',
      status: 'degraded',
      message: sanitizeLifecycleMessage(opts.orgMetadataError),
    });
  }

  for (const token of tokens) {
    const reasons: string[] = [];
    const tokenEvidence: OperatorEvidence[] = [];
    const lifecycle = token.lifecycle;
    const proofState = token.proof?.state ?? lifecycleStatus(lifecycle, 'proofState');
    const proofTier = token.proof?.highestValidTier ?? token.proof?.currentTier ?? lifecycleStatus(lifecycle, 'proofTier');
    const rawPropagationStatus = lifecycleStatus(lifecycle, 'propagationStatus');
    const lastPropagationAt = typeof lifecycle?.lastPropagationAt === 'number' ? lifecycle.lastPropagationAt : undefined;
    const evaluatedPropagationStatus = evaluatePropagationStatus(
      rawPropagationStatus,
      lastPropagationAt,
      token,
      opts.registry,
      now,
    );
    const credentialStatus = lifecycleStatus(lifecycle, 'credentialStatus');
    const lifecycleError = lifecycleString(lifecycle, 'lastErrorCode');
    const lifecycleErrorAt = typeof lifecycle?.lastErrorAt === 'number' ? lifecycle.lastErrorAt : undefined;
    const lifecycleErrorMessage = lifecycleString(lifecycle, 'lastErrorMessage');
    const orgMetadata = findOrgMetadata(opts.orgRunbooks, token.service, token.scheme);

    // A no-refresh-token status is informational for non-refreshable credential types.
    // Only push it as a degraded reason when the service uses refresh-token strategy.
    if (token.status && token.status !== 'healthy') {
      if (token.status === 'no-refresh-token' && isNonRefreshableByDesign(token, opts.registry)) {
        // Intentionally skip: no-refresh-token is by design for this provider type
      } else {
        reasons.push(`token is ${token.status}`);
      }
    }
    if (proofState && proofState !== 'valid' && proofState !== 'skipped') reasons.push(`proof is ${proofState}`);
    // Stale/not-configured propagation states are informational, not degraded
    if (evaluatedPropagationStatus && !['ok', 'skipped', 'stale_in_progress', 'not_configured'].includes(evaluatedPropagationStatus)) {
      reasons.push(`propagation is ${evaluatedPropagationStatus}`);
    }
    if (credentialStatus && credentialStatus !== 'valid') {
      // Credential-suspect state older than 7 days mirrors the lifecycle-error aging rule:
      // a TRANSIENT failure from weeks ago should not keep the credential marked degraded.
      const credentialSuspectAt = typeof lifecycle?.lastConsumerAuthFailureAt === 'number' ? lifecycle.lastConsumerAuthFailureAt : undefined;
      const credentialIsStale = credentialSuspectAt !== undefined && (now - credentialSuspectAt) > LIFECYCLE_ERROR_STALE_MS;
      if (!credentialIsStale) reasons.push(`credential is ${credentialStatus}`);
    }
    // Lifecycle errors older than 7 days are historical, not current failures
    if (lifecycleError) {
      const isStale = lifecycleErrorAt !== undefined && (now - lifecycleErrorAt) > LIFECYCLE_ERROR_STALE_MS;
      if (!isStale) reasons.push(`last lifecycle error ${lifecycleError}`);
    }

    addEvidence(tokenEvidence, {
      service: token.service,
      scheme: token.scheme,
      kind: 'token',
      status: token.status ?? 'unknown',
      at: isoTime(token.accessTokenExpiresAt),
      details: {
        accessTokenExpiresAt: isoTime(token.accessTokenExpiresAt),
        refreshTokenAgeHours: typeof token.refreshTokenAgeHours === 'number'
          ? token.refreshTokenAgeHours
          : typeof token.refreshTokenAge === 'number'
            ? Math.round(token.refreshTokenAge / 3600_000 * 10) / 10
            : null,
      },
    });
    if (proofState || proofTier) {
      addEvidence(tokenEvidence, {
        service: token.service,
        scheme: token.scheme,
        kind: 'proof',
        status: proofState,
        at: isoTime(lifecycle?.lastProofAt),
        details: {
          highestValidTier: token.proof?.highestValidTier,
          currentTier: token.proof?.currentTier ?? proofTier,
          lifecycleTier: lifecycleStatus(lifecycle, 'proofTier'),
        },
      });
    }
    if (evaluatedPropagationStatus) {
      addEvidence(tokenEvidence, {
        service: token.service,
        scheme: token.scheme,
        kind: 'propagation',
        status: evaluatedPropagationStatus,
        at: isoTime(lifecycle?.lastPropagationAt),
        message: lifecycleString(lifecycle, 'lastPropagationError'),
      });
    }
    if (lifecycleError) {
      const lifecycleErrorIsStale = lifecycleErrorAt !== undefined && (now - lifecycleErrorAt) > LIFECYCLE_ERROR_STALE_MS;
      addEvidence(tokenEvidence, {
        service: token.service,
        scheme: token.scheme,
        kind: 'lifecycle-error',
        status: lifecycleError,
        at: isoTime(lifecycle?.lastErrorAt),
        message: lifecycleErrorIsStale ? `(aged) ${lifecycleErrorMessage ?? ''}`.trim() : lifecycleErrorMessage,
      });
    }
    if (credentialStatus && credentialStatus !== 'valid') {
      addEvidence(tokenEvidence, {
        service: token.service,
        scheme: token.scheme,
        kind: 'consumer-auth-failure',
        status: credentialStatus,
        at: lifecycleTime(lifecycle, 'lastConsumerAuthFailureAt'),
        message: lifecycleString(lifecycle, 'credentialSuspectReason') ?? lifecycleErrorMessage,
      });
    }
    if (orgMetadata) {
      addEvidence(tokenEvidence, {
        service: token.service,
        scheme: token.scheme,
        kind: 'org-runbook',
        status: orgMetadata.lastVerifiedAt ? 'verified' : 'advisory',
        at: orgMetadata.lastVerifiedAt,
        message: [orgMetadata.owner ?? orgMetadata.team, orgMetadata.confluenceRunbookUrl].filter(Boolean).join(' — ') || undefined,
        details: orgSummary(orgMetadata),
      });
    }

    // Determine reason text for non-refreshable no-refresh-token services
    let noRefreshNote: string | undefined;
    if (token.status === 'no-refresh-token' && isNonRefreshableByDesign(token, opts.registry)) {
      const svc = opts.registry?.getService(token.service);
      if (svc?.autoReacquire === true) {
        noRefreshNote = 'session credential; reacquired automatically on expiry';
      } else {
        noRefreshNote = `non-refreshable credential type; run hermes acquire ${token.service} when it expires`;
      }
    }

    const serviceSummary: OperatorServiceSummary = {
      service: token.service,
      scheme: token.scheme,
      status: reasons.length === 0 ? 'healthy' : 'degraded',
      reason: reasons.length === 0
        ? (noRefreshNote ?? 'token, proof, propagation, and lifecycle metadata are healthy')
        : reasons.join('; '),
      ...(proofTier ? { proofTier } : {}),
      ...(proofState ? { proofState } : {}),
      ...(evaluatedPropagationStatus ? { propagationStatus: evaluatedPropagationStatus } : {}),
      ...(lifecycleError ? { lifecycleError } : {}),
      nextAction: reasons.length === 0
        ? (evaluatedPropagationStatus === 'stale_in_progress'
          ? `Propagation state is stale (started over 30 minutes ago). Will re-evaluate on next hermes acquire ${token.service}.`
          : evaluatedPropagationStatus === 'not_configured'
            ? `Propagation is not configured for ${token.service}. No action required unless you add a ToolHive container.`
            : noRefreshNote
              ? `Informational: ${noRefreshNote}.`
              : 'No action required.')
        : remediationFor(token, reasons, evaluatedPropagationStatus),
      ...(orgMetadata ? { orgMetadata: redactOperatorValue(orgMetadata) as OrgRunbookMetadata } : {}),
      evidence: tokenEvidence.slice(0, 6),
    };
    services.push(serviceSummary);
    evidence.push(...tokenEvidence);
  }

  const degradedServices = services.filter((service) => service.status === 'degraded');
  const status: OperatorHealthStatus = opts.inventoryError !== undefined || degradedServices.length > 0 ? 'degraded' : 'healthy';
  const nextAction = opts.inventoryError !== undefined
    ? 'Token inventory could not be read. Run: hermes doctor. Do not delete credentials.'
    : degradedServices[0]?.nextAction ?? 'No action required.';

  return {
    status,
    summary: status === 'healthy'
      ? `${services.length} auth service(s) healthy`
      : `${degradedServices.length} of ${services.length} auth service(s) degraded`,
    nextAction,
    degradedServices,
    services,
    evidence: evidence.slice(-20),
  };
}

export function summarizeOperatorTimeline(tokens: TokenHealthLike[], limit = 20): OperatorEvidence[] {
  const events: OperatorEvidence[] = [];
  for (const token of tokens) {
    const lifecycle = token.lifecycle;
    if (!lifecycle) continue;
    for (const event of lifecycleEvents(lifecycle, 'proofEvents')) {
      addEvidence(events, {
        service: token.service,
        scheme: token.scheme,
        kind: `proof:${String(event.tier ?? 'unknown')}`,
        status: typeof event.status === 'string' ? event.status : undefined,
        at: isoTime(event.at),
        message: typeof event.message === 'string' ? event.message : typeof event.error === 'string' ? event.error : undefined,
        details: typeof event.metadata === 'object' && event.metadata ? event.metadata as Record<string, unknown> : undefined,
      });
    }
    for (const event of lifecycleEvents(lifecycle, 'propagationEvents')) {
      addEvidence(events, {
        service: token.service,
        scheme: token.scheme,
        kind: `propagation:${String(event.step ?? 'unknown')}`,
        status: typeof event.status === 'string' ? event.status : undefined,
        at: isoTime(event.at),
        message: typeof event.message === 'string' ? event.message : typeof event.error === 'string' ? event.error : undefined,
        details: { durationMs: event.durationMs },
      });
    }
    const lastErrorCode = lifecycleString(lifecycle, 'lastErrorCode');
    for (const event of lifecycleEvents(lifecycle, 'consumerAuthFailures')) {
      addEvidence(events, {
        service: token.service,
        scheme: token.scheme,
        kind: 'consumer-auth-failure',
        status: typeof event.credentialStatus === 'string' ? event.credentialStatus : typeof event.classification === 'string' ? event.classification : undefined,
        at: isoTime(event.at),
        message: typeof event.message === 'string' ? event.message : undefined,
        details: {
          httpStatus: event.httpStatus,
          failureCode: event.failureCode,
          backend: event.backend,
          tool: event.tool,
          endpointClass: event.endpointClass,
          correlationId: event.correlationId,
          errorEvidence: event.errorEvidence,
        },
      });
    }
    if (lastErrorCode) {
      addEvidence(events, {
        service: token.service,
        scheme: token.scheme,
        kind: 'lifecycle-error',
        status: lastErrorCode,
        at: isoTime(lifecycle.lastErrorAt),
        message: lifecycleString(lifecycle, 'lastErrorMessage'),
      });
    }
  }
  return events
    .filter((event) => event.at)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, limit);
}

export function formatOperatorSummary(summary: OperatorSummary): string {
  const lines = [
    `Hermes auth: ${summary.status}`,
    `Summary: ${summary.summary}`,
    `Next action: ${summary.nextAction}`,
  ];
  for (const service of summary.services) {
    const marker = service.status === 'healthy' ? '✓' : '!';
    lines.push(`${marker} ${service.service}/${service.scheme}: ${service.reason}`);
    if (service.proofTier || service.proofState) lines.push(`  proof: tier=${service.proofTier ?? 'unknown'} state=${service.proofState ?? 'unknown'}`);
    if (service.propagationStatus) lines.push(`  propagation: ${service.propagationStatus}`);
    if (service.lifecycleError) lines.push(`  lifecycle error: ${service.lifecycleError}`);
    if (service.orgMetadata) {
      const org = service.orgMetadata;
      const owner = org.owner ?? org.team;
      const page = org.confluenceRunbookUrl ?? (org.confluencePageId ?? org.pageId ? `Confluence page ${org.confluencePageId ?? org.pageId}` : undefined);
      const constraints = org.conditionalAccess ?? org.conditionalAccessNotes;
      const network = org.networkRequirements ?? (org.vpn ? [org.vpn] : undefined);
      lines.push(`  runbook: ${[owner ? `owner=${owner}` : undefined, page].filter(Boolean).join(' | ') || 'advisory metadata available'}`);
      if (constraints?.length) lines.push(`  conditional access: ${constraints.join('; ')}`);
      if (network?.length) lines.push(`  network: ${network.join('; ')}`);
      if (org.safeProbe) {
        const probeParts = [
          org.safeProbe.description,
          org.safeProbe.tool ?? org.safeProbe.toolName,
          org.safeProbe.endpointClass,
        ].filter(Boolean);
        lines.push(`  safe probe: ${probeParts.join(' | ') || 'configured'}`);
      }
      if (org.lastVerifiedAt) lines.push(`  metadata verified: ${org.lastVerifiedAt}`);
    }
    if (service.status !== 'healthy') lines.push(`  remediation: ${service.nextAction}`);
    for (const ev of service.evidence.slice(-3)) {
      lines.push(`  evidence: ${ev.kind}${ev.status ? ` ${ev.status}` : ''}${ev.at ? ` at ${ev.at}` : ''}${ev.message ? ` — ${ev.message}` : ''}`);
    }
  }
  return lines.join('\n');
}
