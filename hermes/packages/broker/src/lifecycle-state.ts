import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { HermesError } from './errors.js';
import {
  ConsumerAuthFailureEventSchema,
  sanitizeAuthFailureEvent,
  type ConsumerAuthFailureEvent,
  type ConsumerCredentialStatus,
} from './auth-failure.js';

const ProofStatusSchema = z.enum(['unknown', 'valid', 'invalid', 'error', 'degraded', 'failed', 'skipped']);
const ProofTierSchema = z.enum(['stored', 'fresh', 'provider_validated', 'propagated', 'mcp_validated']);
const ProofStateSchema = z.enum(['unknown', 'valid', 'degraded', 'failed', 'skipped']);
const ProofEventMetadataSchema = z.record(z.union([z.string(), z.number(), z.boolean(), z.null()]));
const ProofEventSchema = z.object({
  tier: ProofTierSchema,
  status: ProofStateSchema,
  at: z.number().int().nonnegative(),
  message: z.string().optional(),
  error: z.string().optional(),
  metadata: ProofEventMetadataSchema.optional(),
});
const PropagationStatusSchema = z.enum(['skipped', 'in_progress', 'ok', 'degraded', 'failed']);
const PropagationStepSchema = z.enum([
  'secret_write',
  'container_restart',
  'container_readiness',
  'fleet_sync',
  'gateway_reload',
  'downstream_smoke_probe',
  'downstream_auth_probe',
]);
const PropagationEventStatusSchema = z.enum(['ok', 'skipped', 'degraded', 'failed']);
const PropagationEventMetadataSchema = z.record(z.union([z.string(), z.number(), z.boolean(), z.null()]));
const PropagationEventSchema = z.object({
  step: PropagationStepSchema,
  status: PropagationEventStatusSchema,
  at: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative().optional(),
  message: z.string().optional(),
  error: z.string().optional(),
  metadata: PropagationEventMetadataSchema.optional(),
});

export const LifecycleStateSchema = z.object({
  service: z.string(),
  scheme: z.string(),
  lastRefreshAttemptAt: z.number().int().nonnegative().optional(),
  lastRefreshSuccessAt: z.number().int().nonnegative().optional(),
  lastAcquireAttemptAt: z.number().int().nonnegative().optional(),
  lastAcquireSuccessAt: z.number().int().nonnegative().optional(),
  cooldownUntil: z.number().int().nonnegative().optional(),
  nextScheduledRefreshAt: z.number().int().nonnegative().optional(),
  lastErrorCode: z.string().optional(),
  lastErrorMessage: z.string().optional(),
  lastErrorAt: z.number().int().nonnegative().optional(),
  proofStatus: ProofStatusSchema.optional(),
  proofTier: ProofTierSchema.optional(),
  proofState: ProofStateSchema.optional(),
  lastProofAt: z.number().int().nonnegative().optional(),
  proofEvents: z.array(ProofEventSchema).optional(),
  propagationStatus: PropagationStatusSchema.optional(),
  lastPropagationAt: z.number().int().nonnegative().optional(),
  lastPropagationError: z.string().optional(),
  propagationEvents: z.array(PropagationEventSchema).optional(),
  credentialStatus: z.enum(['valid', 'suspect', 'degraded']).optional(),
  credentialSuspectAt: z.number().int().nonnegative().optional(),
  credentialSuspectReason: z.string().optional(),
  lastConsumerAuthFailureAt: z.number().int().nonnegative().optional(),
  consumerAuthFailures: z.array(ConsumerAuthFailureEventSchema).optional(),
  // --- acquire governor state (persisted so restart does not reset suppression) ---
  /** autoReacquire bounded-retry window: epoch-ms timestamps of recent failures. */
  autoReacquireFailureTimes: z.array(z.number().int().nonnegative()).optional(),
  /** Most recent autoReacquire failure classification (CA vs transient). */
  lastAcquireFailure: z.object({
    isCa: z.boolean(),
    at: z.number().int().nonnegative(),
    message: z.string(),
  }).optional(),
  /** Whether the active cooldown was triggered by a CA challenge (409 vs 503 classification). */
  cooldownIsCa: z.boolean().optional(),
  /** AD acquire budget: epoch-ms timestamps of provider.acquire() attempts (sliding 1h window). */
  adAcquireTimes: z.array(z.number().int().nonnegative()).optional(),
});

const LifecycleFileSchema = z.object({
  version: z.literal(1),
  states: z.array(LifecycleStateSchema),
});

export type ProofStatus = z.infer<typeof ProofStatusSchema>;
export type ProofTier = z.infer<typeof ProofTierSchema>;
export type ProofState = z.infer<typeof ProofStateSchema>;
export type ProofEvent = z.infer<typeof ProofEventSchema>;
export type PropagationStatus = z.infer<typeof PropagationStatusSchema>;
export type PropagationStep = z.infer<typeof PropagationStepSchema>;
export type PropagationEventStatus = z.infer<typeof PropagationEventStatusSchema>;
export type PropagationEvent = z.infer<typeof PropagationEventSchema>;
export type { ConsumerAuthFailureEvent, ConsumerCredentialStatus };
export type LifecycleState = z.infer<typeof LifecycleStateSchema>;
export type LifecycleStatePatch = Partial<Omit<LifecycleState, 'service' | 'scheme'>>;

function key(service: string, scheme: string): string {
  return `${service}:${scheme}`;
}

function cleanState(state: LifecycleState): LifecycleState {
  return Object.fromEntries(Object.entries(state).filter(([, value]) => value !== undefined)) as LifecycleState;
}

function cleanUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function errorCode(err: unknown, fallback = 'ERROR'): string {
  if (err instanceof HermesError) return err.code;
  if (err instanceof Error && err.name) return err.name;
  return fallback;
}

export function sanitizeLifecycleMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(access[_-]?token|refresh[_-]?token|authorization|api[_-]?key|apikey)\b\s*[:=]\s*[^,\s;]+/gi, '$1=[redacted]')
    .slice(0, 500);
}

function errorMessage(err: unknown): string {
  return sanitizeLifecycleMessage(err);
}

function sanitizePropagationEvent(event: PropagationEvent): PropagationEvent {
  return cleanUndefined({
    ...event,
    message: event.message ? sanitizeLifecycleMessage(event.message) : undefined,
    error: event.error ? sanitizeLifecycleMessage(event.error) : undefined,
  });
}

function sanitizeProofEvent(event: ProofEvent): ProofEvent {
  return cleanUndefined({
    ...event,
    message: event.message ? sanitizeLifecycleMessage(event.message) : undefined,
    error: event.error ? sanitizeLifecycleMessage(event.error) : undefined,
  });
}

function consumerFailureMessage(event: ConsumerAuthFailureEvent): string {
  const parts = [
    'downstream auth failure',
    event.httpStatus ? `HTTP ${event.httpStatus}` : undefined,
    event.failureCode,
    event.backend ? `backend=${event.backend}` : undefined,
    event.tool ? `tool=${event.tool}` : undefined,
    event.endpointClass ? `endpoint=${event.endpointClass}` : undefined,
  ].filter(Boolean);
  return sanitizeLifecycleMessage(parts.join(' '));
}

function proofStatusFromState(state: ProofState): ProofStatus {
  if (state === 'valid' || state === 'degraded' || state === 'failed' || state === 'skipped') return state;
  return 'unknown';
}

export class LifecycleStateStore {
  private readonly filePath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly dataDir: string, fileName = 'lifecycle-state.json') {
    this.filePath = path.join(dataDir, fileName);
  }

  async get(service: string, scheme: string): Promise<LifecycleState | null> {
    return (await this.readMap()).get(key(service, scheme)) ?? null;
  }

  async list(): Promise<LifecycleState[]> {
    return Array.from((await this.readMap()).values());
  }

  async update(service: string, scheme: string, patch: LifecycleStatePatch): Promise<LifecycleState> {
    const run = async (): Promise<LifecycleState> => {
      const states = await this.readMap();
      const next = cleanState({ ...(states.get(key(service, scheme)) ?? { service, scheme }), ...patch });
      states.set(key(service, scheme), next);
      await this.writeMap(states);
      return next;
    };
    const result = this.writeQueue.then(run, run);
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async recordRefreshAttempt(service: string, scheme: string, at = Date.now()): Promise<LifecycleState> {
    return this.update(service, scheme, { lastRefreshAttemptAt: at });
  }

  async recordRefreshSuccess(service: string, scheme: string, at = Date.now()): Promise<LifecycleState> {
    return this.update(service, scheme, {
      lastRefreshSuccessAt: at,
      cooldownUntil: undefined,
      cooldownIsCa: undefined,
      lastErrorCode: undefined,
      lastErrorMessage: undefined,
      lastErrorAt: undefined,
      credentialStatus: 'valid',
      credentialSuspectAt: undefined,
      credentialSuspectReason: undefined,
    });
  }

  async recordRefreshFailure(service: string, scheme: string, err: unknown, opts: { at?: number; code?: string; cooldownUntil?: number } = {}): Promise<LifecycleState> {
    const at = opts.at ?? Date.now();
    return this.update(service, scheme, {
      lastErrorCode: opts.code ?? errorCode(err),
      lastErrorMessage: errorMessage(err),
      lastErrorAt: at,
      ...(opts.cooldownUntil !== undefined ? { cooldownUntil: opts.cooldownUntil } : {}),
    });
  }

  async recordAcquireAttempt(service: string, scheme: string, at = Date.now()): Promise<LifecycleState> {
    return this.update(service, scheme, { lastAcquireAttemptAt: at });
  }

  async recordAcquireSuccess(service: string, scheme: string, at = Date.now()): Promise<LifecycleState> {
    return this.update(service, scheme, {
      lastAcquireSuccessAt: at,
      cooldownUntil: undefined,
      cooldownIsCa: undefined,
      lastErrorCode: undefined,
      lastErrorMessage: undefined,
      lastErrorAt: undefined,
      credentialStatus: 'valid',
      credentialSuspectAt: undefined,
      credentialSuspectReason: undefined,
    });
  }

  async recordAcquireFailure(service: string, scheme: string, err: unknown, opts: { at?: number; code?: string; cooldownUntil?: number } = {}): Promise<LifecycleState> {
    const at = opts.at ?? Date.now();
    return this.update(service, scheme, {
      lastErrorCode: opts.code ?? errorCode(err),
      lastErrorMessage: errorMessage(err),
      lastErrorAt: at,
      ...(opts.cooldownUntil !== undefined ? { cooldownUntil: opts.cooldownUntil } : {}),
    });
  }

  async recordNextScheduledRefresh(service: string, scheme: string, when: Date): Promise<LifecycleState> {
    return this.update(service, scheme, { nextScheduledRefreshAt: when.getTime() });
  }

  /**
   * Persist the broker's acquire-governor state (autoReacquire failure window,
   * last failure classification, cooldown CA flag, AD budget timestamps) so a
   * broker restart does not reset suppression context. Messages are sanitized.
   */
  async recordAcquireGovernorState(
    service: string,
    scheme: string,
    patch: Pick<LifecycleStatePatch, 'autoReacquireFailureTimes' | 'lastAcquireFailure' | 'cooldownIsCa' | 'adAcquireTimes'>,
  ): Promise<LifecycleState> {
    const sanitized: LifecycleStatePatch = { ...patch };
    if (patch.lastAcquireFailure) {
      sanitized.lastAcquireFailure = {
        ...patch.lastAcquireFailure,
        message: sanitizeLifecycleMessage(patch.lastAcquireFailure.message),
      };
    }
    return this.update(service, scheme, sanitized);
  }

  async recordProof(service: string, scheme: string, proofStatus: ProofStatus, at = Date.now()): Promise<LifecycleState> {
    return this.update(service, scheme, { proofStatus, lastProofAt: at });
  }

  async recordProofEvents(
    service: string,
    scheme: string,
    events: ProofEvent[],
    opts: { at?: number; proofTier?: ProofTier; proofState?: ProofState; proofStatus?: ProofStatus } = {},
  ): Promise<LifecycleState> {
    const sanitizedEvents = events.map(sanitizeProofEvent);
    const current = await this.get(service, scheme);
    const last = sanitizedEvents.at(-1);
    const proofState = opts.proofState ?? last?.status;
    return this.update(service, scheme, {
      proofTier: opts.proofTier ?? last?.tier,
      proofState,
      proofStatus: opts.proofStatus ?? (proofState ? proofStatusFromState(proofState) : undefined),
      lastProofAt: opts.at ?? last?.at ?? Date.now(),
      proofEvents: [...(current?.proofEvents ?? []), ...sanitizedEvents].slice(-20),
    });
  }

  async recordProofTier(service: string, scheme: string, event: ProofEvent): Promise<LifecycleState> {
    return this.recordProofEvents(service, scheme, [event], {
      at: event.at,
      proofTier: event.tier,
      proofState: event.status,
    });
  }

  async recordPropagation(
    service: string,
    scheme: string,
    status: PropagationStatus,
    events: PropagationEvent[],
    opts: { at?: number; error?: unknown } = {},
  ): Promise<LifecycleState> {
    const sanitizedEvents = events.map(sanitizePropagationEvent).slice(-20);
    return this.update(service, scheme, {
      propagationStatus: status,
      lastPropagationAt: opts.at ?? Date.now(),
      lastPropagationError: opts.error === undefined ? undefined : sanitizeLifecycleMessage(opts.error),
      propagationEvents: sanitizedEvents,
    });
  }

  async recordConsumerAuthFailure(service: string, scheme: string, event: ConsumerAuthFailureEvent): Promise<LifecycleState> {
    const sanitizedEvent = sanitizeAuthFailureEvent(event);
    const current = await this.get(service, scheme);
    const forceRecovery = sanitizedEvent.credentialStatus === 'suspect';
    const credentialStatus: ConsumerCredentialStatus = forceRecovery
      ? 'suspect'
      : current?.credentialStatus === 'suspect'
        ? 'suspect'
        : 'degraded';
    return this.update(service, scheme, {
      credentialStatus,
      credentialSuspectAt: forceRecovery ? sanitizedEvent.at : current?.credentialSuspectAt,
      credentialSuspectReason: forceRecovery ? consumerFailureMessage(sanitizedEvent) : current?.credentialSuspectReason,
      lastConsumerAuthFailureAt: sanitizedEvent.at,
      lastErrorCode: forceRecovery ? 'CONSUMER_AUTH_FAILURE' : 'CONSUMER_TRANSIENT_FAILURE',
      lastErrorMessage: consumerFailureMessage(sanitizedEvent),
      lastErrorAt: sanitizedEvent.at,
      proofTier: 'mcp_validated',
      proofState: forceRecovery ? 'failed' : 'degraded',
      proofStatus: forceRecovery ? 'failed' : 'degraded',
      lastProofAt: sanitizedEvent.at,
      consumerAuthFailures: [...(current?.consumerAuthFailures ?? []), sanitizedEvent].slice(-20),
    });
  }

  private async readMap(): Promise<Map<string, LifecycleState>> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
      throw err;
    }
    const data = LifecycleFileSchema.parse(parsed);
    return new Map(data.states.map((state) => [key(state.service, state.scheme), state]));
  }

  private async writeMap(states: Map<string, LifecycleState>): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    const data = {
      version: 1 as const,
      states: Array.from(states.values()).sort((a, b) => key(a.service, a.scheme).localeCompare(key(b.service, b.scheme))),
    };
    const tmpPath = `${this.filePath}.${process.pid}.new`;
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), { mode: 0o600 });
    await fs.rename(tmpPath, this.filePath);
  }
}
