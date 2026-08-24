import { describe, expect, it } from 'vitest';
import {
  analyzeTransportFailure,
  classifyAuthFailure,
  classifyTransportFailure,
  normalizeAuthFailureReport,
  shouldForceAuthRecovery,
  toolReplayPolicy,
  transportFailureGuidance,
} from '../src/index.js';

describe('MCP transport failure controller primitives', () => {
  it('classifies the Stash JSON-RPC session-not-found shape as transport, not auth', () => {
    const stashFailure = {
      jsonrpc: '2.0',
      id: 7,
      error: {
        code: -32001,
        message: 'Session not found',
      },
    };

    const analysis = analyzeTransportFailure(stashFailure, { tool: 'stash_create_pull_request' });

    expect(analysis).toMatchObject({
      failureDomain: 'mcp_transport',
      classification: 'mcp_session_not_found',
      authFailure: false,
      credentialStatus: 'unchanged',
      guidance: {
        credentialRefreshRecommended: false,
        resetSession: true,
        reinitializeSession: true,
      },
    });
    expect(analysis.guidance.nextActions).toEqual(expect.arrayContaining([
      'close_stale_mcp_session',
      'reinitialize_backend_session',
      'do_not_refresh_token_first',
      'perform_duplicate_check_before_replay',
    ]));

    const authReport = normalizeAuthFailureReport({
      service: 'stash',
      scheme: 'pat',
      failureCode: '-32001',
      message: 'Session not found',
    });
    expect(shouldForceAuthRecovery(authReport)).toBe(false);
    expect(classifyAuthFailure(authReport)).not.toBe('auth_recovery');
  });

  it('classifies Stash text session-not-found as transport, not auth', () => {
    const text = 'stash_create_pull_request failed with streamable HTTP JSON-RPC error {"code":-32001,"message":"Session not found"}';

    expect(classifyTransportFailure(text)).toBe('mcp_session_not_found');
    expect(analyzeTransportFailure({ message: text }).guidance.credentialRefreshRecommended).toBe(false);
  });

  it.each([
    [{ message: 'connect ECONNREFUSED 127.0.0.1:9876' }, 'gateway_backend_stale'],
    [{ error: new Error('request timed out after 30000ms') }, 'tool_call_timeout'],
    [{ message: 'EADDRINUSE: address already in use 127.0.0.1:9876' }, 'port_conflict'],
    [{ message: 'SSE stream disconnected before response completed' }, 'sse_disconnect'],
    [{ message: 'socket hang up after backend restarted' }, 'backend_restarted'],
    [{ message: 'Already connected to a transport. Call close() before connecting.' }, 'streamable_http_protocol_error'],
  ] as const)('classifies common transport evidence %#', (input, classification) => {
    expect(classifyTransportFailure(input)).toBe(classification);
  });

  it('requires duplicate check before replaying PR creation writes', () => {
    const policy = toolReplayPolicy({ tool: 'stash_create_pull_request' });

    expect(policy).toMatchObject({
      idempotency: 'write_requires_duplicate_check',
      safeToReplayNow: false,
      duplicateCheckRequired: true,
      guidance: expect.stringContaining('duplicate'),
    });

    const guidance = transportFailureGuidance('mcp_session_not_found', { tool: 'stash_create_pull_request' });
    expect(guidance.remediation).toContain('do not refresh or rotate credentials');
    expect(guidance.nextActions).toContain('perform_duplicate_check_before_replay');
  });

  it('allows reads and idempotency-key writes while blocking unsafe automatic replay', () => {
    expect(toolReplayPolicy({ tool: 'stash_list_pull_requests' })).toMatchObject({
      idempotency: 'read',
      safeToReplayNow: true,
      duplicateCheckRequired: false,
    });
    expect(toolReplayPolicy({
      tool: 'stash_create_pull_request',
      idempotency: 'safe_write_with_idempotency_key',
      idempotencyKey: 'pr-title-branch-key',
    })).toMatchObject({
      idempotency: 'safe_write_with_idempotency_key',
      safeToReplayNow: true,
      duplicateCheckRequired: false,
    });
    expect(toolReplayPolicy({ tool: 'custom_mutation', idempotency: 'unsafe_write' })).toMatchObject({
      idempotency: 'unsafe_write',
      safeToReplayNow: false,
      duplicateCheckRequired: false,
    });
  });
});
