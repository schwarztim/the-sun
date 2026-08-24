import type { Broker } from './broker.js';
import { shouldForceAuthRecovery, type AuthFailureReportInput } from './auth-failure.js';
import { HermesError, HermesErrorCode } from './errors.js';
import { proofEventsFromLifecycle } from './proof-probes.js';
import { analyzeTransportFailure, classifyTransportFailure, toolReplayPolicy, type ToolCallPolicyInput } from './transport-failure.js';
import type { LifecycleState, LifecycleStateStore, ProofEvent, ProofTier, PropagationEvent } from './lifecycle-state.js';
import type { ServiceRegistry } from './registry.js';
import type { DownstreamAuthProbeConfig, ServiceRegistration } from './types.js';

export type CapabilityLeaseStatus = 'ready' | 'degraded' | 'repairing' | 'human_action_required' | 'unknown';

export interface PrepareCapabilitiesInput {
  service?: unknown;
  backend?: unknown;
  tool?: unknown;
  capability?: unknown;
  capabilities?: unknown;
  operation?: unknown;
  operations?: unknown;
  scheme?: unknown;
  minProofTier?: unknown;
}

export interface CapabilityLease {
  status: CapabilityLeaseStatus;
  service?: string;
  reportedService?: string;
  scheme?: string;
  capability?: string;
  canonicalService?: string;
  proofTimestamp?: string;
  proofAt?: number;
  expiresAt?: string;
  leaseTtlMs: number;
  proofTier?: ProofTier;
  proofState?: string;
  degradedCapabilities: string[];
  nextAction: string;
  evidence: Record<string, unknown>;
}

export interface PrepareCapabilitiesResult {
  status: CapabilityLeaseStatus;
  leases: CapabilityLease[];
  degradedCapabilities: string[];
  nextAction: string;
}

export interface ClassifyToolFailureInput extends AuthFailureReportInput, ToolCallPolicyInput {
  service?: unknown;
  scheme?: unknown;
  backend?: unknown;
  tool?: unknown;
  method?: unknown;
  idempotency?: unknown;
  idempotencyKey?: unknown;
  error?: unknown;
  response?: unknown;
  evidence?: unknown;
}

export interface ToolCallReliabilityEnvelope {
  status: 'classified';
  failureDomain: 'auth' | 'mcp_transport' | 'unknown';
  classification: string;
  service?: string;
  reportedService?: string;
  scheme?: string;
  credentialStatus?: string;
  authFailure: boolean;
  transportRecovery?: unknown;
  authRecovery?: unknown;
  replayPolicy: ReturnType<typeof toolReplayPolicy>;
  nextActions: string[];
  remediation: string;
}

export interface CapabilityShieldDeps {
  registry: ServiceRegistry;
  lifecycleStore?: LifecycleStateStore;
  broker?: Broker;
  now?: () => number;
  leaseTtlMs?: number;
}

const DEFAULT_LEASE_TTL_MS = 5 * 60_000;
const tierRank = new Map<ProofTier, number>([
  ['stored', 0],
  ['fresh', 1],
  ['provider_validated', 2],
  ['propagated', 3],
  ['mcp_validated', 4],
]);

function stringValue(value: unknown): string | undefined {
  if (typeof value === 'string' || typeof value === 'number') {
    const str = String(value).trim();
    return str.length > 0 ? str : undefined;
  }
  return undefined;
}

function stringList(...values: unknown[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        const str = stringValue(entry);
        if (str) out.push(str);
      }
    } else {
      const str = stringValue(value);
      if (str) out.push(str);
    }
  }
  return Array.from(new Set(out));
}

function configuredAuthProbes(registration: ServiceRegistration): DownstreamAuthProbeConfig[] {
  if (registration.downstreamAuthProbes && registration.downstreamAuthProbes.length > 0) return registration.downstreamAuthProbes;
  return registration.downstreamAuthProbe ? [registration.downstreamAuthProbe] : [];
}

function matchesProbe(probe: DownstreamAuthProbeConfig, names: string[]): boolean {
  if (names.length === 0) return true;
  const candidates = [probe.operation, probe.toolName, probe.endpointClass].filter((value): value is string => Boolean(value));
  return candidates.some((candidate) => names.some((name) => candidate === name || candidate.toLowerCase() === name.toLowerCase()));
}

function latestByTier(events: ProofEvent[]): Map<ProofTier, ProofEvent> {
  const out = new Map<ProofTier, ProofEvent>();
  for (const event of events) {
    const current = out.get(event.tier);
    if (!current || event.at >= current.at) out.set(event.tier, event);
  }
  return out;
}

function highestValidTier(events: ProofEvent[]): ProofEvent | undefined {
  return [...latestByTier(events).values()]
    .filter((event) => event.status === 'valid')
    .sort((a, b) => (tierRank.get(a.tier) ?? -1) - (tierRank.get(b.tier) ?? -1))
    .at(-1);
}

function latestProofAt(events: ProofEvent[], state: LifecycleState | null): number | undefined {
  return state?.lastProofAt ?? events.map((event) => event.at).sort((a, b) => a - b).at(-1);
}

function requiredTierFor(probes: DownstreamAuthProbeConfig[], names: string[], explicit: unknown): ProofTier {
  const parsed = stringValue(explicit) as ProofTier | undefined;
  if (parsed && tierRank.has(parsed)) return parsed;
  const matching = probes.filter((probe) => matchesProbe(probe, names));
  if (matching.some((probe) => probe.required || probe.proofDepth === 'deep' || probe.proofDepth === 'last_real_use')) return 'mcp_validated';
  if (matching.length > 0) return 'mcp_validated';
  return 'provider_validated';
}

function latestAuthProbeEvent(events: PropagationEvent[] | undefined, probe: DownstreamAuthProbeConfig): PropagationEvent | undefined {
  return (events ?? [])
    .filter((event) => event.step === 'downstream_auth_probe')
    .filter((event) => {
      const md = event.metadata ?? {};
      return md.toolName === probe.toolName
        || (probe.operation !== undefined && md.operation === probe.operation)
        || (probe.endpointClass !== undefined && md.endpointClass === probe.endpointClass);
    })
    .sort((a, b) => a.at - b.at)
    .at(-1);
}

function statusRank(status: CapabilityLeaseStatus): number {
  return ['ready', 'repairing', 'degraded', 'human_action_required', 'unknown'].indexOf(status);
}

function worse(a: CapabilityLeaseStatus, b: CapabilityLeaseStatus): CapabilityLeaseStatus {
  return statusRank(a) >= statusRank(b) ? a : b;
}

function resolveService(registry: ServiceRegistry, input: PrepareCapabilitiesInput): { reported?: string; canonical?: string; registration?: ServiceRegistration } {
  const reported = stringValue(input.service) ?? stringValue(input.backend);
  if (!reported) return {};
  const canonical = registry.resolveServiceName(reported);
  return { reported, canonical, registration: canonical ? registry.getService(canonical) : undefined };
}

function resolveFailureService(registry: ServiceRegistry, input: ClassifyToolFailureInput): { reported?: string; canonical?: string } {
  const reported = stringValue(input.service) ?? stringValue(input.backend);
  if (!reported) return {};
  return { reported, canonical: registry.resolveServiceName(reported) };
}

export async function prepareCapabilities(input: PrepareCapabilitiesInput, deps: CapabilityShieldDeps): Promise<PrepareCapabilitiesResult> {
  const now = deps.now ?? Date.now;
  const leaseTtlMs = deps.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const { reported, canonical, registration } = resolveService(deps.registry, input);
  const names = stringList(input.capabilities, input.capability, input.operations, input.operation, input.tool);
  const degradedCapabilities = new Set<string>();

  if (!reported || !canonical || !registration) {
    const capability = names[0] ?? 'unknown';
    degradedCapabilities.add(capability);
    const lease: CapabilityLease = {
      status: 'unknown',
      reportedService: reported,
      capability,
      leaseTtlMs,
      degradedCapabilities: [capability],
      nextAction: reported ? 'register_or_fix_service_alias_before_calling_downstream_tool' : 'provide_service_or_backend_alias',
      evidence: { reason: reported ? 'service_alias_unresolved' : 'service_missing' },
    };
    return { status: 'unknown', leases: [lease], degradedCapabilities: [...degradedCapabilities], nextAction: lease.nextAction };
  }

  const probes = configuredAuthProbes(registration);
  const targets = names.length > 0 ? names : ['default'];
  const schemes = stringList(input.scheme);
  const selectedSchemes = schemes.length > 0 ? schemes : registration.schemes;
  const leases: CapabilityLease[] = [];
  let overall: CapabilityLeaseStatus = 'ready';

  for (const scheme of selectedSchemes) {
    const state = await deps.lifecycleStore?.get(canonical, scheme).catch(() => null) ?? null;
    const proofEvents = [...(state?.proofEvents ?? []), ...proofEventsFromLifecycle(state)];
    const validTier = highestValidTier(proofEvents);
    const proofAt = latestProofAt(proofEvents, state);
    const proofTimestamp = proofAt !== undefined ? new Date(proofAt).toISOString() : undefined;
    const expiresAt = proofAt !== undefined ? new Date(Math.max(now(), proofAt) + leaseTtlMs).toISOString() : undefined;
    const latest = latestByTier(proofEvents);
    const matchingProbes = probes.filter((probe) => matchesProbe(probe, names));
    const requiredOrMatchingProbes = matchingProbes.filter((probe) => probe.required || names.length > 0);
    const requiredTier = requiredTierFor(probes, names, input.minProofTier);

    for (const capability of targets) {
      let status: CapabilityLeaseStatus = 'unknown';
      let nextAction = 'collect_operation_proof_before_calling_downstream_tool';
      const evidence: Record<string, unknown> = {
        requiredProofTier: requiredTier,
        configuredAuthProbes: probes.length,
        matchingAuthProbes: matchingProbes.length,
      };

      if (!state) {
        status = 'unknown';
        nextAction = 'acquire_or_refresh_token_and_run_configured_operation_probe';
      } else if (state.cooldownUntil && state.cooldownUntil > now()) {
        status = 'human_action_required';
        nextAction = 'wait_for_reauth_cooldown_or_run_interactive_acquire_when_hermes_requests_it';
        evidence.cooldownUntil = new Date(state.cooldownUntil).toISOString();
      } else if (state.credentialStatus === 'suspect' || state.lastErrorCode === 'INTERACTIVE_AUTH_REQUIRED') {
        status = 'human_action_required';
        nextAction = 'request_fresh_token_before_calling_downstream_tool';
        evidence.credentialStatus = state.credentialStatus;
        evidence.lastErrorCode = state.lastErrorCode;
      } else if (state.propagationStatus === 'in_progress') {
        status = 'repairing';
        nextAction = 'wait_for_token_propagation_or_fleet_sync_to_finish';
      } else if (names.length > 0 && probes.length > 0 && matchingProbes.length === 0) {
        status = 'unknown';
        nextAction = 'register_operation_contract_or_authenticated_probe_for_requested_capability';
        evidence.availableOperationContracts = probes.map((probe) => probe.operation ?? probe.toolName ?? probe.endpointClass);
      } else if (requiredOrMatchingProbes.length > 0) {
        const probeStates = requiredOrMatchingProbes.map((probe) => ({
          toolName: probe.toolName,
          operation: probe.operation,
          required: probe.required,
          proofDepth: probe.proofDepth,
          event: latestAuthProbeEvent(state.propagationEvents, probe),
        }));
        evidence.probes = probeStates.map(({ event, ...probe }) => ({ ...probe, status: event?.status, at: event?.at }));
        if (probeStates.every(({ event }) => event?.status === 'ok')) {
          status = 'ready';
          nextAction = 'capability_lease_ready_call_downstream_tool';
        } else {
          const authFailure = probeStates.some(({ event }) => event?.metadata?.authFailure === true);
          status = authFailure ? 'human_action_required' : 'degraded';
          nextAction = authFailure ? 'refresh_or_reacquire_credential_before_downstream_call' : 'run_required_authenticated_operation_probe_before_calling_downstream_tool';
        }
      } else if (validTier && (tierRank.get(validTier.tier) ?? -1) >= (tierRank.get(requiredTier) ?? 99)) {
        status = latest.get(requiredTier)?.status === 'skipped' ? 'degraded' : 'ready';
        nextAction = status === 'ready' ? 'capability_lease_ready_call_downstream_tool' : 'run_required_deep_probe_before_calling_downstream_tool';
      } else if (state.proofState === 'degraded' || state.propagationStatus === 'degraded') {
        status = 'degraded';
        nextAction = 'repair_degraded_proof_or_run_authenticated_operation_probe_before_calling_downstream_tool';
      }

      if (status !== 'ready') degradedCapabilities.add(capability);
      overall = worse(overall, status);
      leases.push({
        status,
        service: canonical,
        reportedService: reported !== canonical ? reported : undefined,
        scheme,
        capability,
        canonicalService: canonical,
        proofAt,
        proofTimestamp,
        expiresAt,
        leaseTtlMs,
        proofTier: validTier?.tier ?? state?.proofTier,
        proofState: validTier?.status ?? state?.proofState,
        degradedCapabilities: status === 'ready' ? [] : [capability],
        nextAction,
        evidence,
      });
    }
  }

  return {
    status: overall,
    leases,
    degradedCapabilities: [...degradedCapabilities],
    nextAction: overall === 'ready' ? 'all_requested_capabilities_ready' : leases.find((lease) => lease.status !== 'ready')?.nextAction ?? 'inspect_capability_leases',
  };
}

function authLike(input: AuthFailureReportInput): boolean {
  const report = { service: stringValue(input.service) ?? 'unknown', scheme: stringValue(input.scheme) ?? 'unknown', ...input };
  try {
    return shouldForceAuthRecovery({
      service: String(report.service),
      scheme: String(report.scheme),
      observedAt: Date.now(),
      ...(typeof input.httpStatus === 'number' ? { httpStatus: input.httpStatus } : {}),
      ...(typeof input.statusCode === 'number' ? { httpStatus: input.statusCode } : {}),
      ...(typeof input.status === 'number' ? { httpStatus: input.status } : {}),
      ...(typeof input.failureCode === 'string' ? { failureCode: input.failureCode } : {}),
    });
  } catch {
    return false;
  }
}

export async function classifyToolFailure(input: ClassifyToolFailureInput, deps: CapabilityShieldDeps): Promise<ToolCallReliabilityEnvelope> {
  const policyInput = { tool: input.tool, method: input.method, idempotency: input.idempotency, idempotencyKey: input.idempotencyKey };
  const replayPolicy = toolReplayPolicy(policyInput);
  const identity = resolveFailureService(deps.registry, input);
  const transportClassification = classifyTransportFailure(input);
  if (transportClassification !== 'unknown_transport_failure') {
    const transport = analyzeTransportFailure(input, policyInput);
    return {
      status: 'classified',
      failureDomain: 'mcp_transport',
      classification: transport.classification,
      service: identity.canonical,
      reportedService: identity.reported && identity.canonical && identity.reported !== identity.canonical ? identity.reported : undefined,
      scheme: stringValue(input.scheme),
      authFailure: false,
      credentialStatus: transport.credentialStatus,
      transportRecovery: transport.guidance,
      replayPolicy,
      nextActions: transport.guidance.nextActions,
      remediation: transport.guidance.remediation,
    };
  }

  if (authLike(input)) {
    if (!deps.broker) {
      throw new HermesError(HermesErrorCode.CONFIG_ERROR, 'capability shield cannot report auth failure without broker dependency', {
        remediation: 'wire broker.reportAuthFailure into the MCP shield',
      });
    }
    const reportInput: AuthFailureReportInput = {
      ...input,
      ...(identity.canonical ? { service: identity.canonical } : {}),
      ...(identity.reported && identity.canonical && identity.reported !== identity.canonical && !stringValue(input.backend)
        ? { backend: identity.reported }
        : {}),
    };
    const reported = await deps.broker.reportAuthFailure(reportInput);
    return {
      status: 'classified',
      failureDomain: 'auth',
      classification: reported.classification,
      service: reported.service,
      reportedService: identity.reported && identity.reported !== reported.service ? identity.reported : undefined,
      scheme: reported.scheme,
      authFailure: true,
      credentialStatus: reported.credentialStatus,
      authRecovery: reported,
      replayPolicy,
      nextActions: [reported.guidance.nextAction],
      remediation: reported.guidance.remediation,
    };
  }

  return {
    status: 'classified',
    failureDomain: 'unknown',
    classification: 'unknown_tool_failure',
    authFailure: false,
    replayPolicy,
    nextActions: ['collect_non_secret_error_evidence', 'do_not_refresh_credentials_without_auth_evidence'],
    remediation: `Could not classify downstream failure; ${replayPolicy.guidance}.`,
  };
}
