import { describe, it, expect, vi } from 'vitest';
import { Writable } from 'node:stream';
import { buildMcpToolHandlers } from '../src/mcp-server.js';
import { TokenHealthMonitor } from '../src/health-monitor.js';
import { createLogger } from '../src/logger.js';
import { HermesError, HermesErrorCode } from '../src/errors.js';
import type { Broker } from '../src/broker.js';
import type { LifecycleStateStore } from '../src/lifecycle-state.js';
import type { ServiceRegistry } from '../src/registry.js';
import type { TokenStorage } from '../src/storage.js';
import type { TokenBundle } from '../src/types.js';

const nullSink = new Writable({ write(_c, _e, cb) { cb(); } });
const logger = createLogger({ level: 'error', stream: nullSink, pretty: false });

const bundle: TokenBundle = {
  service: 'ms365', scheme: 'graph', accessToken: 'abc', tokenType: 'Bearer',
  expiresAt: Date.now() + 3600_000, acquiredAt: Date.now(),
};

function fakeBroker(): Broker {
  return {
    getToken: vi.fn(async () => bundle),
    listServices: vi.fn(async () => ['ms365', 'servicenow']),
    reportAuthFailure: vi.fn(async (input: any) => ({
      status: 'recorded',
      service: input.service,
      scheme: input.scheme,
      classification: input.httpStatus === 401 ? 'auth_recovery' : 'transient',
      forceRecovery: input.httpStatus === 401,
      credentialStatus: input.httpStatus === 401 ? 'suspect' : 'degraded',
      guidance: {
        retryable: true,
        retryAfterMs: input.httpStatus === 401 ? 0 : 30_000,
        nextAction: input.httpStatus === 401 ? 'request_fresh_token_then_retry_downstream' : 'retry_downstream_without_reauth',
        remediation: 'retry with guidance',
      },
      report: input,
    })),
  } as unknown as Broker;
}

function fakeRegistry(): ServiceRegistry {
  const service = {
    name: 'ms365',
    providerName: 'ms365',
    schemes: ['graph'],
    config: {},
    createdAt: 1,
    thvContainerName: 'ms365-thv',
    serviceAliases: ['microsoft-365'],
    backendAliases: ['msgraph-backend'],
    toolhiveContainerAliases: ['ms365-toolhive'],
    gatewayBackendAliases: ['gateway-ms365'],
    userFacingNames: ['Microsoft 365'],
    downstreamAuthProbes: [{
      toolName: 'teams_list_channels',
      operation: 'teams.list_channels',
      endpointClass: 'teams',
      proofDepth: 'deep' as const,
      required: true,
    }],
  };
  return {
    listProviders: () => [{ name: 'ms365', schemes: ['graph', 'teams'] } as any],
    listServices: () => [service],
    getService: (name: string) => name === 'ms365' ? service : undefined,
    resolveServiceName: (input: string) => ['ms365', 'ms365-thv', 'msgraph-backend', 'microsoft-365', 'ms365-toolhive', 'gateway-ms365'].includes(input) ? 'ms365' : undefined,
  } as unknown as ServiceRegistry;
}

describe('mcp tool handlers', () => {
  it('hermes_status lists services and providers', async () => {
    const handlers = buildMcpToolHandlers({ broker: fakeBroker(), registry: fakeRegistry() });
    const res = await handlers.hermes_status({});
    expect(res.services).toContain('ms365');
    expect(res.providers.map((p: any) => p.name)).toContain('ms365');
  });
  it('hermes_force_refresh calls broker.getToken with force', async () => {
    const broker = fakeBroker();
    const handlers = buildMcpToolHandlers({ broker, registry: fakeRegistry() });
    const res = await handlers.hermes_force_refresh({ service: 'ms365', scheme: 'graph' });
    expect(broker.getToken).toHaveBeenCalledWith('ms365', 'graph', { force: true });
    expect(res.accessToken).toBe('abc');
  });
  it('hermes_force_refresh returns structured auth errors with remediation commands', async () => {
    const broker = {
      getToken: vi.fn(async () => {
        throw new HermesError(HermesErrorCode.INTERACTIVE_AUTH_REQUIRED, 'refresh token expired', {
          remediation: 'run: hermes acquire ms365',
          remediationCommands: ['hermes acquire ms365'],
        });
      }),
      listServices: vi.fn(async () => ['ms365']),
    } as unknown as Broker;
    const handlers = buildMcpToolHandlers({ broker, registry: fakeRegistry() });
    const res = await handlers.hermes_force_refresh({ service: 'ms365', scheme: 'graph' });
    expect(res).toMatchObject({
      status: 'error',
      error: {
        code: 'INTERACTIVE_AUTH_REQUIRED',
        category: 'auth-required',
        retryable: false,
        remediationCommands: ['hermes acquire ms365'],
      },
    });
  });
  it('hermes_list_services returns registered services', async () => {
    const handlers = buildMcpToolHandlers({ broker: fakeBroker(), registry: fakeRegistry() });
    const res = await handlers.hermes_list_services({});
    expect(res.services[0].name).toBe('ms365');
    expect(res.services[0]).toMatchObject({
      thvContainerName: 'ms365-thv',
      serviceAliases: ['microsoft-365'],
      backendAliases: ['msgraph-backend'],
      toolhiveContainerAliases: ['ms365-toolhive'],
      gatewayBackendAliases: ['gateway-ms365'],
      userFacingNames: ['Microsoft 365'],
    });
  });
  it('hermes_list_providers returns installed providers', async () => {
    const handlers = buildMcpToolHandlers({ broker: fakeBroker(), registry: fakeRegistry() });
    const res = await handlers.hermes_list_providers({});
    expect(res.providers[0].name).toBe('ms365');
    expect(res.providers[0].schemes).toEqual(['graph', 'teams']);
  });

  it('hermes_token_health returns status without monitor', async () => {
    const handlers = buildMcpToolHandlers({ broker: fakeBroker(), registry: fakeRegistry() });
    const res = await handlers.hermes_token_health({});
    expect(res.message).toBe('health monitor not configured');
  });

  it('hermes_token_health returns token health from monitor', async () => {
    const storage = {
      list: vi.fn(async () => [bundle]),
    } as unknown as TokenStorage;
    const lifecycleStore = {
      get: vi.fn(async () => ({
        service: 'ms365',
        scheme: 'graph',
        lastAcquireSuccessAt: 1_700_000_000_000,
        nextScheduledRefreshAt: 1_700_003_000_000,
        proofStatus: 'unknown',
        proofTier: 'provider_validated',
        proofState: 'degraded',
        proofEvents: [{ tier: 'provider_validated', status: 'degraded', at: 1_700_004_500_000 }],
        propagationStatus: 'ok',
        lastPropagationAt: 1_700_004_000_000,
        propagationEvents: [{ step: 'gateway_reload', status: 'ok', at: 1_700_004_000_000 }],
      })),
    } as unknown as LifecycleStateStore;
    const monitor = new TokenHealthMonitor({ storage, logger });
    const handlers = buildMcpToolHandlers({ broker: fakeBroker(), registry: fakeRegistry(), healthMonitor: monitor, lifecycleStore });
    const res = await handlers.hermes_token_health({});
    expect(res.tokens).toHaveLength(1);
    expect(res.tokens[0].service).toBe('ms365');
    expect(res.tokens[0].status).toBe('no-refresh-token');
    expect(res.tokens[0].proof).toMatchObject({
      highestValidTier: 'fresh',
      currentTier: 'fresh',
      state: 'valid',
    });
    expect(res.operator).toMatchObject({
      status: 'degraded',
      degradedServices: [{
        service: 'ms365',
        scheme: 'graph',
        propagationStatus: 'ok',
      }],
    });
      expect(res.tokens[0].lifecycle).toMatchObject({
        lastAcquireSuccessAt: '2023-11-14T22:13:20.000Z',
        nextScheduledRefreshAt: '2023-11-14T23:03:20.000Z',
        proofStatus: 'unknown',
        proofTier: 'provider_validated',
        proofState: 'degraded',
        proofEvents: [{ tier: 'provider_validated', status: 'degraded', at: '2023-11-14T23:28:20.000Z' }],
        propagationStatus: 'ok',
        lastPropagationAt: '2023-11-14T23:20:00.000Z',
        propagationEvents: [{ step: 'gateway_reload', status: 'ok', at: '2023-11-14T23:20:00.000Z' }],
      });
  });

  it('hermes_auth_summary and hermes_auth_timeline expose operator UX', async () => {
    const storage = {
      list: vi.fn(async () => [bundle]),
    } as unknown as TokenStorage;
    const lifecycleStore = {
      get: vi.fn(async () => ({
        service: 'ms365',
        scheme: 'graph',
        lastErrorCode: 'INTERACTIVE_AUTH_REQUIRED',
        lastErrorMessage: 'Bearer secret-token',
        lastErrorAt: 1_700_000_000_000,
        proofEvents: [{ tier: 'provider_validated', status: 'degraded', at: 1_700_004_500_000, error: 'authorization=secret' }],
        propagationEvents: [{ step: 'gateway_reload', status: 'failed', at: 1_700_004_000_000 }],
        propagationStatus: 'failed',
      })),
    } as unknown as LifecycleStateStore;
    const monitor = new TokenHealthMonitor({ storage, logger });
    const handlers = buildMcpToolHandlers({ broker: fakeBroker(), registry: fakeRegistry(), healthMonitor: monitor, lifecycleStore });

    const summary = await handlers.hermes_auth_summary({});
    const timeline = await handlers.hermes_auth_timeline({ limit: 5 });

    expect(summary.status).toBe('degraded');
    expect(summary.nextAction).toContain('hermes acquire ms365');
    expect(JSON.stringify(summary)).not.toContain('secret-token');
    expect(timeline.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'proof:provider_validated', message: expect.stringContaining('[redacted]') }),
      expect.objectContaining({ kind: 'propagation:gateway_reload', status: 'failed' }),
    ]));
  });

  it('hermes_report_auth_failure delegates to broker and returns retry guidance', async () => {
    const broker = fakeBroker();
    const handlers = buildMcpToolHandlers({ broker, registry: fakeRegistry() });
    const res = await handlers.hermes_report_auth_failure({
      service: 'servicenow',
      scheme: 'session',
      httpStatus: 401,
      backend: 'servicenow-mcp',
      tool: 'incident.list',
      endpointClass: 'table-api',
      errorEvidence: { authorization: 'Bearer secret-token' },
    });

    expect(broker.reportAuthFailure).toHaveBeenCalledWith(expect.objectContaining({
      service: 'servicenow',
      scheme: 'session',
      httpStatus: 401,
    }));
    expect(res).toMatchObject({
      status: 'recorded',
      classification: 'auth_recovery',
      forceRecovery: true,
      guidance: {
        nextAction: 'request_fresh_token_then_retry_downstream',
      },
    });
  });

  it('hermes_prepare_capabilities returns a canonical readiness lease', async () => {
    const lifecycleStore = {
      get: vi.fn(async () => ({
        service: 'ms365',
        scheme: 'graph',
        propagationStatus: 'ok',
        lastProofAt: 1_700_000_000_000,
        proofEvents: [{ tier: 'mcp_validated', status: 'valid', at: 1_700_000_000_000 }],
        propagationEvents: [{
          step: 'downstream_auth_probe',
          status: 'ok',
          at: 1_700_000_000_000,
          metadata: { toolName: 'teams_list_channels', operation: 'teams.list_channels', required: true },
        }],
      })),
    } as unknown as LifecycleStateStore;
    const handlers = buildMcpToolHandlers({ broker: fakeBroker(), registry: fakeRegistry(), lifecycleStore });

    const res = await handlers.hermes_prepare_capabilities({
      backend: 'ms365-thv',
      scheme: 'graph',
      operation: 'teams.list_channels',
    });

    expect(res).toMatchObject({
      status: 'ready',
      leases: [expect.objectContaining({
        service: 'ms365',
        reportedService: 'ms365-thv',
        canonicalService: 'ms365',
        status: 'ready',
      })],
    });
  });

  it('hermes_classify_tool_failure reports backend-auth failures with canonical service', async () => {
    const broker = fakeBroker();
    const handlers = buildMcpToolHandlers({ broker, registry: fakeRegistry() });

    const res = await handlers.hermes_classify_tool_failure({
      backend: 'ms365-thv',
      scheme: 'graph',
      tool: 'teams_list_channels',
      httpStatus: 401,
      message: 'Unauthorized',
    });

    expect(broker.reportAuthFailure).toHaveBeenCalledWith(expect.objectContaining({
      service: 'ms365',
      backend: 'ms365-thv',
      scheme: 'graph',
      httpStatus: 401,
    }));
    expect(res).toMatchObject({
      failureDomain: 'auth',
      service: 'ms365',
      reportedService: 'ms365-thv',
      authFailure: true,
    });
  });

  it('hermes_token_health degrades gracefully when token inventory is corrupt', async () => {
    const storage = {
      list: vi.fn(async () => { throw new Error('Unexpected non-whitespace character after JSON'); }),
    } as unknown as TokenStorage;
    const monitor = new TokenHealthMonitor({ storage, logger });
    const handlers = buildMcpToolHandlers({ broker: fakeBroker(), registry: fakeRegistry(), healthMonitor: monitor });
    const res = await handlers.hermes_token_health({});
    expect(res).toMatchObject({
      tokens: [],
      status: 'degraded',
      message: 'token health check failed',
      error: 'Unexpected non-whitespace character after JSON',
    });
  });

  it('hermes_token_health still reports lifecycle state when token inventory is corrupt', async () => {
    const storage = {
      list: vi.fn(async () => { throw new Error('Unexpected non-whitespace character after JSON'); }),
    } as unknown as TokenStorage;
    const lifecycleStore = {
      list: vi.fn(async () => [{
        service: 'ms365',
        scheme: 'graph',
        cooldownUntil: 1_700_000_060_000,
        lastErrorCode: 'INTERACTIVE_AUTH_REQUIRED',
        lastErrorMessage: 'Bearer secret-token',
        lastErrorAt: 1_700_000_000_000,
        proofEvents: [{ tier: 'provider_validated', status: 'degraded', at: 1_700_000_030_000, metadata: { access_token: 'abc123' } }],
      }]),
    } as unknown as LifecycleStateStore;
    const monitor = new TokenHealthMonitor({ storage, logger });
    const handlers = buildMcpToolHandlers({ broker: fakeBroker(), registry: fakeRegistry(), healthMonitor: monitor, lifecycleStore });
    const res = await handlers.hermes_token_health({});
    expect(res).toMatchObject({
      status: 'degraded',
      error: 'Unexpected non-whitespace character after JSON',
      tokens: [{
        service: 'ms365',
        scheme: 'graph',
        status: 'unknown',
        lifecycle: {
          cooldownUntil: '2023-11-14T22:14:20.000Z',
          lastErrorCode: 'INTERACTIVE_AUTH_REQUIRED',
          lastErrorMessage: 'Bearer [redacted]',
          lastErrorAt: '2023-11-14T22:13:20.000Z',
          proofEvents: [{
            tier: 'provider_validated',
            status: 'degraded',
            at: '2023-11-14T22:13:50.000Z',
            metadata: { access_token: '[redacted]' },
          }],
        },
      }],
    });
    expect(JSON.stringify(res)).not.toContain('secret-token');
    expect(JSON.stringify(res)).not.toContain('abc123');
  });
});
