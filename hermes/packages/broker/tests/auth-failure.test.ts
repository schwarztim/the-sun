import { describe, expect, it } from 'vitest';
import {
  authFailureEventFromReport,
  authFailureGuidance,
  classifyAuthFailure,
  normalizeAuthFailureReport,
  sanitizeAuthFailureEvent,
  sanitizeAuthFailureValue,
  shouldForceAuthRecovery,
} from '../src/auth-failure.js';

describe('auth failure normalization and classification', () => {
  it('normalizes flexible report shapes into non-secret canonical fields', () => {
    const report = normalizeAuthFailureReport({
      status: '401',
      code: 'invalid-session',
      endpoint_class: 'table-api',
      correlation_id: 'corr-1',
      observedAt: '2026-05-14T10:00:00.000Z',
      message: 'User Not Authenticated access_token=raw-secret',
      response: {
        authorization: 'Bearer secret.token',
        nested: { cookie: 'JSESSIONID=secret-cookie' },
      },
    }, { service: 'servicenow', scheme: 'session' });

    expect(report).toMatchObject({
      service: 'servicenow',
      scheme: 'session',
      httpStatus: 401,
      failureCode: 'invalid-session',
      endpointClass: 'table-api',
      correlationId: 'corr-1',
      observedAt: Date.parse('2026-05-14T10:00:00.000Z'),
    });
    expect(JSON.stringify(report)).not.toContain('raw-secret');
    expect(JSON.stringify(report)).not.toContain('secret.token');
    expect(JSON.stringify(report)).not.toContain('secret-cookie');
  });

  it.each([
    [{ httpStatus: 401 }, 'HTTP 401'],
    [{ httpStatus: 403 }, 'HTTP 403'],
    [{ failureCode: 'invalid_session' }, 'invalid_session'],
    [{ failureCode: 'csrf-failed' }, 'csrf-failed'],
    [{ failureCode: 'missing_or_invalid_g_ck' }, 'missing_or_invalid_g_ck'],
    [{ failureCode: 'api_unauthorized' }, 'api_unauthorized'],
    [{ failureCode: 'session_info_unavailable' }, 'session_info_unavailable'],
  ])('forces auth recovery for %s (%s)', (input) => {
    const report = normalizeAuthFailureReport({ service: 'servicenow', scheme: 'session', ...input });
    expect(shouldForceAuthRecovery(report)).toBe(true);
    expect(classifyAuthFailure(report)).toBe('auth_recovery');
    expect(authFailureGuidance(report)).toMatchObject({
      retryable: true,
      retryAfterMs: 0,
      nextAction: 'request_fresh_token_then_retry_downstream',
    });
  });

  it.each([
    [{ httpStatus: 503, failureCode: 'upstream_down' }],
    [{ failureCode: 'network' }],
    [{ failureCode: 'unknown_new_servicenow_code' }],
  ])('keeps non-auth or unknown failures transient by default', (input) => {
    const report = normalizeAuthFailureReport({ service: 'servicenow', scheme: 'session', ...input });
    expect(shouldForceAuthRecovery(report)).toBe(false);
    expect(classifyAuthFailure(report)).toBe('transient');
    expect(authFailureGuidance(report)).toMatchObject({
      retryable: true,
      retryAfterMs: 30_000,
      nextAction: 'retry_downstream_without_reauth',
    });
  });

  it('creates sanitized lifecycle events with bounded nested evidence', () => {
    const deep = { accessToken: 'secret-a', level: { level: { level: { level: { level: { level: { level: 'too-deep-secret' } } } } } } };
    const event = authFailureEventFromReport(normalizeAuthFailureReport({
      service: 'servicenow',
      scheme: 'session',
      httpStatus: 401,
      backend: 'servicenow-mcp',
      tool: 'tasks.get',
      errorEvidence: {
        token: 'secret-token',
        body: 'Bearer secret.bearer.token refresh_token=secret-refresh cookie=secret-cookie',
        deep,
      },
    }));
    const sanitized = sanitizeAuthFailureEvent(event);
    const serialized = JSON.stringify(sanitized);

    expect(sanitized).toMatchObject({
      classification: 'auth_recovery',
      credentialStatus: 'suspect',
      httpStatus: 401,
      backend: 'servicenow-mcp',
      tool: 'tasks.get',
    });
    expect(serialized).not.toContain('secret-token');
    expect(serialized).not.toContain('secret.bearer.token');
    expect(serialized).not.toContain('secret-refresh');
    expect(serialized).not.toContain('secret-cookie');
    expect(serialized).not.toContain('too-deep-secret');
    expect(serialized).toContain('[redacted]');
  });

  it('redacts token-shaped arrays and object keys directly', () => {
    expect(sanitizeAuthFailureValue([
      { apiKey: 'api-secret' },
      'authorization=should-not-survive',
    ])).toEqual([
      { apiKey: '[redacted]' },
      'authorization=[redacted]',
    ]);
  });
});
