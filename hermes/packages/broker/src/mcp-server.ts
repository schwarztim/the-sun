import type { Broker } from './broker.js';
import type { ServiceRegistry } from './registry.js';
import type { TokenHealthMonitor } from './health-monitor.js';
import type { GatewayFleetSync } from './fleet-sync.js';
import { sanitizeLifecycleMessage, type LifecycleState, type LifecycleStateStore } from './lifecycle-state.js';
import { HermesError } from './errors.js';
import { redactOperatorValue, summarizeOperatorHealth, summarizeOperatorTimeline, type TokenHealthLike } from './operator-ux.js';
import type { AuthFailureReportInput } from './auth-failure.js';
import type { OrgRunbookRegistry } from './org-runbook-registry.js';
import {
  classifyToolFailure,
  prepareCapabilities,
  type ClassifyToolFailureInput,
  type PrepareCapabilitiesInput,
} from './capability-shield.js';

export interface McpDeps { broker: Broker; registry: ServiceRegistry; healthMonitor?: TokenHealthMonitor; fleetSync?: GatewayFleetSync; lifecycleStore?: LifecycleStateStore; orgRunbooks?: OrgRunbookRegistry; }

export interface McpToolHandlers {
  hermes_status(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  hermes_force_refresh(args: { service: string; scheme: string }): Promise<Record<string, unknown>>;
  hermes_list_services(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  hermes_list_providers(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  hermes_token_health(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  hermes_auth_summary(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  hermes_auth_timeline(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  hermes_report_auth_failure(args: AuthFailureReportInput): Promise<Record<string, unknown>>;
  hermes_prepare_capabilities(args: PrepareCapabilitiesInput): Promise<Record<string, unknown>>;
  hermes_classify_tool_failure(args: ClassifyToolFailureInput): Promise<Record<string, unknown>>;
  hermes_fleet_status(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  hermes_fleet_sync(args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

const lifecycleTimeFields = [
  'lastRefreshAttemptAt',
  'lastRefreshSuccessAt',
  'lastAcquireAttemptAt',
  'lastAcquireSuccessAt',
  'cooldownUntil',
  'nextScheduledRefreshAt',
  'lastErrorAt',
  'lastProofAt',
  'lastPropagationAt',
  'credentialSuspectAt',
  'lastConsumerAuthFailureAt',
] as const;

function serializeLifecycle(state: LifecycleState | null): Record<string, unknown> | undefined {
  if (!state) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(state)) out[k] = v;
  for (const field of lifecycleTimeFields) {
    if (typeof state[field] === 'number') out[field] = new Date(state[field]).toISOString();
  }
  if (Array.isArray(state.propagationEvents)) {
    out.propagationEvents = state.propagationEvents.map((event) => ({
      ...event,
      at: new Date(event.at).toISOString(),
    }));
  }
  if (Array.isArray(state.proofEvents)) {
    out.proofEvents = state.proofEvents.map((event) => ({
      ...event,
      at: new Date(event.at).toISOString(),
    }));
  }
  if (Array.isArray(state.consumerAuthFailures)) {
    out.consumerAuthFailures = state.consumerAuthFailures.map((event) => ({
      ...event,
      at: new Date(event.at).toISOString(),
    }));
  }
  return redactOperatorValue(out) as Record<string, unknown>;
}

async function collectTokenHealth(deps: McpDeps): Promise<Record<string, unknown> & { tokens: TokenHealthLike[] }> {
  if (!deps.healthMonitor) {
    const tokens = deps.lifecycleStore
      ? (await deps.lifecycleStore.list().catch(() => [])).map((state) => ({
        service: state.service,
        scheme: state.scheme,
        status: 'unknown',
        lifecycle: serializeLifecycle(state),
      }))
      : [];
    return {
      tokens,
      status: tokens.length === 0 ? 'unknown' : 'degraded',
      message: 'health monitor not configured',
      operator: summarizeOperatorHealth(tokens, { orgRunbooks: deps.orgRunbooks?.list(), registry: deps.registry }),
    };
  }
  let health;
  try {
    health = await deps.healthMonitor.runCheck();
  } catch (err) {
    const lifecycleStates = deps.lifecycleStore ? await deps.lifecycleStore.list().catch(() => []) : [];
    const tokens = lifecycleStates.map((state) => ({
      service: state.service,
      scheme: state.scheme,
      status: 'unknown',
      lifecycle: serializeLifecycle(state),
    }));
    return {
      tokens,
      status: 'degraded',
      message: 'token health check failed',
      error: sanitizeLifecycleMessage(err),
      remediation: 'run hermes doctor or inspect stored token metadata; broker remains available',
      operator: summarizeOperatorHealth(tokens, { inventoryError: err, orgRunbooks: deps.orgRunbooks?.list(), registry: deps.registry }),
    };
  }
  const tokens = await Promise.all(health.map(async (h) => ({
    service: h.service,
    scheme: h.scheme,
    status: h.status,
    proof: h.proof ? {
      highestValidTier: h.proof.highestValidTier,
      currentTier: h.proof.currentTier,
      state: h.proof.state,
      tiers: h.proof.tiers.map((event) => ({ ...event, at: new Date(event.at).toISOString() })),
    } : undefined,
    accessTokenExpiresAt: new Date(h.accessTokenExpiresAt).toISOString(),
    refreshTokenAgeHours: h.refreshTokenAge != null ? Math.round(h.refreshTokenAge / 3600_000 * 10) / 10 : null,
    lifecycle: serializeLifecycle(deps.lifecycleStore ? await deps.lifecycleStore.get(h.service, h.scheme).catch(() => null) : null),
  })));
  return {
    tokens,
    operator: summarizeOperatorHealth(tokens, { orgRunbooks: deps.orgRunbooks?.list(), registry: deps.registry }),
  };
}

export function buildMcpToolHandlers(deps: McpDeps): McpToolHandlers {
  return {
    async hermes_status() {
      const services = await deps.broker.listServices();
      const providers = deps.registry.listProviders().map((p) => ({ name: p.name, schemes: [...p.schemes] }));
      const auth = await collectTokenHealth(deps);
      return { services, providers, auth: auth.operator };
    },
    async hermes_force_refresh(args) {
      try {
        return await deps.broker.getToken(args.service, args.scheme, { force: true });
      } catch (err) {
        if (err instanceof HermesError) return { status: 'error', error: err.toJSON() };
        throw err;
      }
    },
    async hermes_list_services() {
      const services = deps.registry.listServices().map((s) => ({
        name: s.name,
        providerName: s.providerName,
        schemes: s.schemes,
        thvContainerName: s.thvContainerName,
        serviceAliases: s.serviceAliases,
        backendAliases: s.backendAliases,
        toolhiveContainerAliases: s.toolhiveContainerAliases,
        gatewayBackendAliases: s.gatewayBackendAliases,
        userFacingNames: s.userFacingNames,
      }));
      return { services };
    },
    async hermes_list_providers() {
      const providers = deps.registry.listProviders().map((p) => ({ name: p.name, schemes: [...p.schemes] }));
      return { providers };
    },
    async hermes_token_health() {
      return collectTokenHealth(deps);
    },
    async hermes_auth_summary() {
      const health = await collectTokenHealth(deps);
      return health.operator as Record<string, unknown>;
    },
    async hermes_auth_timeline(args) {
      const limit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.max(1, Math.min(100, Math.trunc(args.limit))) : 20;
      const health = await collectTokenHealth(deps);
      return { events: summarizeOperatorTimeline(health.tokens, limit), schemaReady: true };
    },
    async hermes_report_auth_failure(args) {
      return { ...(await deps.broker.reportAuthFailure(args)) };
    },
    async hermes_prepare_capabilities(args) {
      return { ...(await prepareCapabilities(args, { registry: deps.registry, lifecycleStore: deps.lifecycleStore })) };
    },
    async hermes_classify_tool_failure(args) {
      return { ...(await classifyToolFailure(args, { registry: deps.registry, lifecycleStore: deps.lifecycleStore, broker: deps.broker })) };
    },
    async hermes_fleet_status() {
      return deps.fleetSync ? { ...deps.fleetSync.status() } : { status: 'disabled' };
    },
    async hermes_fleet_sync() {
      return deps.fleetSync ? { ...(await deps.fleetSync.syncNow()) } : { status: 'disabled' };
    },
  };
}

export const mcpToolDescriptors = [
  { name: 'hermes_status', description: 'Show all registered services, installed providers, and redacted auth operator health summary with optional advisory org runbook metadata.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'hermes_force_refresh', description: 'Force a refresh of the token for a given service and scheme.', inputSchema: { type: 'object', properties: { service: { type: 'string', description: 'service name' }, scheme: { type: 'string', description: 'scheme name' } }, required: ['service', 'scheme'], additionalProperties: false } },
  { name: 'hermes_list_services', description: 'List registered services with their provider binding.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'hermes_list_providers', description: 'List installed providers and their supported schemes.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'hermes_token_health', description: 'Check health of all stored tokens. Reports refresh token age, expiry risk, and optional advisory org runbook metadata. Status: healthy, expiring (approaching max age), expired (past max age), no-refresh-token.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'hermes_auth_summary', description: 'One-shot operator auth summary: healthy/degraded services, proof tier, lifecycle errors, propagation state, exact next action, optional advisory org runbooks, and redacted evidence.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'hermes_auth_timeline', description: 'Redacted latest auth proof/propagation/lifecycle events from persisted lifecycle state.', inputSchema: { type: 'object', properties: { limit: { type: 'number', minimum: 1, maximum: 100 } }, additionalProperties: false } },
  {
    name: 'hermes_report_auth_failure',
    description: 'Report a downstream REST/MCP 401/403/auth failure or transient consumer failure to Hermes so it can mark credentials suspect, coalesce recovery, and return retry guidance.',
    inputSchema: {
      type: 'object',
      properties: {
        service: { type: 'string', description: 'registered service name' },
        scheme: { type: 'string', description: 'credential scheme' },
        httpStatus: { type: 'number', description: 'downstream HTTP status such as 401, 403, or 503' },
        failureCode: { type: 'string', description: 'provider-neutral failure code such as invalid_session, csrf_failed, network, or transient' },
        backend: { type: 'string', description: 'downstream MCP/backend name' },
        tool: { type: 'string', description: 'tool or operation that observed the failure' },
        endpointClass: { type: 'string', description: 'redacted endpoint/resource class, not a full secret-bearing URL' },
        observedAt: { oneOf: [{ type: 'number' }, { type: 'string' }], description: 'epoch milliseconds or ISO timestamp' },
        correlationId: { type: 'string', description: 'caller correlation id' },
        message: { type: 'string', description: 'redacted or redactable human-readable failure summary' },
        errorEvidence: { description: 'non-secret evidence; Hermes redacts known secret fields before persistence' },
        evidence: { description: 'alias for errorEvidence' },
      },
      required: ['service', 'scheme'],
      additionalProperties: true,
    },
  },
  {
    name: 'hermes_prepare_capabilities',
    description: 'Preflight downstream MCP/tool capabilities through Hermes operation proof state and return a readiness lease before calling ad-hoc MCPs. Either "service" or "backend" is required.',
    inputSchema: {
      type: 'object',
      properties: {
        service: { type: 'string', description: 'registered service name or service alias (required if backend is not provided)' },
        backend: { type: 'string', description: 'backend/container/gateway alias when service is not known (required if service is not provided)' },
        scheme: { type: 'string', description: 'credential scheme to preflight; defaults to all registered schemes' },
        capability: { type: 'string', description: 'single capability or operation name' },
        capabilities: { type: 'array', items: { type: 'string' }, description: 'capability or operation names' },
        operation: { type: 'string', description: 'single operation contract name' },
        operations: { type: 'array', items: { type: 'string' }, description: 'operation contract names' },
        tool: { type: 'string', description: 'downstream MCP tool name' },
        minProofTier: { type: 'string', enum: ['stored', 'fresh', 'provider_validated', 'propagated', 'mcp_validated'], description: 'minimum proof tier required for readiness' },
      },
      additionalProperties: true,
    },
  },
  {
    name: 'hermes_classify_tool_failure',
    description: 'Classify a downstream tool-call failure as auth, MCP transport, or unknown and return canonical Hermes recovery/replay guidance.',
    inputSchema: {
      type: 'object',
      properties: {
        service: { type: 'string', description: 'registered service name or alias' },
        scheme: { type: 'string', description: 'credential scheme' },
        backend: { type: 'string', description: 'downstream backend/container/gateway alias' },
        tool: { type: 'string', description: 'downstream tool name' },
        method: { type: 'string', description: 'operation/method name' },
        httpStatus: { type: 'number', description: 'HTTP status observed from downstream' },
        statusCode: { type: 'number', description: 'alternate HTTP status field' },
        failureCode: { type: 'string', description: 'provider-neutral failure code' },
        message: { type: 'string', description: 'redacted error message' },
        error: { description: 'non-secret error object or string' },
        response: { description: 'non-secret response evidence' },
        evidence: { description: 'non-secret evidence' },
        idempotency: { type: 'string', enum: ['read', 'safe_write_with_idempotency_key', 'write_requires_duplicate_check', 'unsafe_write'] },
        idempotencyKey: { type: 'string', description: 'idempotency key used by the downstream write, if any' },
      },
      additionalProperties: true,
    },
  },
  { name: 'hermes_fleet_status', description: 'Get MCP Gateway fleet sync status — last sync time, backend count, gateway reachability.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'hermes_fleet_sync', description: 'Force an immediate fleet sync — regenerate config.generated.json from running ToolHive containers and reload the MCP Gateway.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
] as const;
