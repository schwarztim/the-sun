import { describe, expect, it, vi } from 'vitest';
import { classifyToolFailure, prepareCapabilities } from '../src/capability-shield.js';
import type { Broker } from '../src/broker.js';
import type { LifecycleState, LifecycleStateStore } from '../src/lifecycle-state.js';
import type { ServiceRegistry } from '../src/registry.js';

function registry(): ServiceRegistry {
  const service = {
    name: 'ms365',
    providerName: 'ms365',
    schemes: ['graph'],
    config: {},
    createdAt: 1,
    thvContainerName: 'ms365-thv',
    backendAliases: ['msgraph-backend'],
    downstreamAuthProbes: [{
      toolName: 'teams_list_channels',
      operation: 'teams.list_channels',
      endpointClass: 'teams',
      proofDepth: 'deep' as const,
      required: true,
    }],
  };
  return {
    resolveServiceName: vi.fn((input: string) => ['ms365', 'ms365-thv', 'msgraph-backend'].includes(input) ? 'ms365' : undefined),
    getService: vi.fn((name: string) => name === 'ms365' ? service : undefined),
    listServices: vi.fn(() => [service]),
  } as unknown as ServiceRegistry;
}

function lifecycle(state: LifecycleState | null): LifecycleStateStore {
  return {
    get: vi.fn(async () => state),
  } as unknown as LifecycleStateStore;
}

describe('capability shield', () => {
  it('prepares a ready capability lease when required operation proof is valid', async () => {
    const result = await prepareCapabilities({
      service: 'ms365',
      scheme: 'graph',
      operation: 'teams.list_channels',
    }, {
      registry: registry(),
      lifecycleStore: lifecycle({
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
      }),
      now: () => 1_700_000_010_000,
    });

    expect(result.status).toBe('ready');
    expect(result.leases[0]).toMatchObject({
      status: 'ready',
      service: 'ms365',
      canonicalService: 'ms365',
      scheme: 'graph',
      proofTimestamp: '2023-11-14T22:13:20.000Z',
      degradedCapabilities: [],
    });
  });

  it('does not return ready when a required deep probe is skipped or missing', async () => {
    const result = await prepareCapabilities({
      service: 'ms365',
      scheme: 'graph',
      operation: 'teams.list_channels',
    }, {
      registry: registry(),
      lifecycleStore: lifecycle({
        service: 'ms365',
        scheme: 'graph',
        propagationStatus: 'ok',
        lastProofAt: 1_700_000_000_000,
        proofEvents: [
          { tier: 'propagated', status: 'valid', at: 1_700_000_000_000 },
          { tier: 'mcp_validated', status: 'skipped', at: 1_700_000_000_000, message: 'transport smoke only' },
        ],
        propagationEvents: [{
          step: 'downstream_auth_probe',
          status: 'skipped',
          at: 1_700_000_000_000,
          metadata: { toolName: 'teams_list_channels', operation: 'teams.list_channels', required: true },
        }],
      }),
    });

    expect(result.status).toBe('degraded');
    expect(result.degradedCapabilities).toContain('teams.list_channels');
    expect(result.nextAction).toContain('run_required_authenticated_operation_probe');
  });

  it('resolves backend aliases to canonical service identity', async () => {
    const result = await prepareCapabilities({
      backend: 'ms365-thv',
      scheme: 'graph',
      tool: 'teams_list_channels',
    }, {
      registry: registry(),
      lifecycleStore: lifecycle({
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
      }),
    });

    expect(result.status).toBe('ready');
    expect(result.leases[0]).toMatchObject({
      service: 'ms365',
      reportedService: 'ms365-thv',
      canonicalService: 'ms365',
    });
  });

  it('does not overclaim readiness for an unmapped capability when contracts exist', async () => {
    const result = await prepareCapabilities({
      service: 'ms365',
      scheme: 'graph',
      operation: 'teams.send_message',
    }, {
      registry: registry(),
      lifecycleStore: lifecycle({
        service: 'ms365',
        scheme: 'graph',
        propagationStatus: 'ok',
        lastProofAt: 1_700_000_000_000,
        proofEvents: [{ tier: 'provider_validated', status: 'valid', at: 1_700_000_000_000 }],
        propagationEvents: [],
      }),
    });

    expect(result.status).toBe('unknown');
    expect(result.degradedCapabilities).toContain('teams.send_message');
    expect(result.nextAction).toBe('register_operation_contract_or_authenticated_probe_for_requested_capability');
  });

  it('classifies Session not found as transport recovery instead of auth refresh', async () => {
    const broker = {
      reportAuthFailure: vi.fn(),
    } as unknown as Broker;

    const result = await classifyToolFailure({
      service: 'ms365',
      scheme: 'graph',
      tool: 'stash_create_pull_request',
      error: { code: -32001, message: 'Session not found' },
    }, {
      registry: registry(),
      broker,
    });

    expect(result).toMatchObject({
      failureDomain: 'mcp_transport',
      classification: 'mcp_session_not_found',
      authFailure: false,
      credentialStatus: 'unchanged',
    });
    expect(result.nextActions).toContain('reinitialize_backend_session');
    expect(result.nextActions).toContain('perform_duplicate_check_before_replay');
    expect(broker.reportAuthFailure).not.toHaveBeenCalled();
  });

  it('routes HTTP 401 failures through broker auth failure reporting', async () => {
    const broker = {
      reportAuthFailure: vi.fn(async (input: any) => ({
        status: 'recorded',
        service: 'ms365',
        scheme: input.scheme,
        classification: 'auth_recovery',
        forceRecovery: true,
        credentialStatus: 'suspect',
        guidance: {
          retryable: true,
          retryAfterMs: 0,
          nextAction: 'request_fresh_token_then_retry_downstream',
          remediation: 'Hermes marked ms365:graph suspect',
        },
        report: { ...input, service: 'ms365' },
      })),
    } as unknown as Broker;

    const result = await classifyToolFailure({
      backend: 'ms365-thv',
      scheme: 'graph',
      tool: 'teams_list_channels',
      httpStatus: 401,
      message: 'Unauthorized',
    }, {
      registry: registry(),
      broker,
    });

    expect(broker.reportAuthFailure).toHaveBeenCalledWith(expect.objectContaining({
      service: 'ms365',
      scheme: 'graph',
      backend: 'ms365-thv',
      httpStatus: 401,
    }));
    expect(result).toMatchObject({
      failureDomain: 'auth',
      classification: 'auth_recovery',
      service: 'ms365',
      reportedService: 'ms365-thv',
      authFailure: true,
      credentialStatus: 'suspect',
      nextActions: ['request_fresh_token_then_retry_downstream'],
    });
  });
});
