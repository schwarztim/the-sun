import { describe, it, expect } from 'vitest';
import { HermesError, HermesErrorCategory, HermesErrorCode, HermesRetryHint } from '../src/errors.js';

describe('HermesError', () => {
  it('carries a code and remediation hint', () => {
    const err = new HermesError(
      HermesErrorCode.ACQUIRE_REQUIRED,
      'ms365 has no cached credentials',
      { remediation: 'run hermes acquire ms365' }
    );
    expect(err.code).toBe(HermesErrorCode.ACQUIRE_REQUIRED);
    expect(err.message).toBe('ms365 has no cached credentials');
    expect(err.remediation).toBe('run hermes acquire ms365');
    expect(err.category).toBe(HermesErrorCategory.AUTH_REQUIRED);
    expect(err.retryable).toBe(false);
    expect(err.retryHint).toBe(HermesRetryHint.HUMAN_ACTION_REQUIRED);
    expect(err instanceof Error).toBe(true);
  });

  it('serializes to JSON with code + message + remediation', () => {
    const err = new HermesError(
      HermesErrorCode.VALIDATION_FAILED,
      'token rejected by IdP',
      { remediation: 'force refresh' }
    );
    expect(err.toJSON()).toEqual({
      name: 'HermesError',
      code: 'VALIDATION_FAILED',
      category: 'configuration',
      message: 'token rejected by IdP',
      retryable: false,
      retryHint: 'do-not-retry',
      remediation: 'force refresh',
    });
  });

  it('serializes retry metadata and exact remediation commands', () => {
    const err = new HermesError(
      HermesErrorCode.REFRESH_FAILED,
      'issuer temporarily unavailable',
      {
        category: HermesErrorCategory.TRANSIENT,
        retryable: true,
        retryAfterMs: 1200,
        remediation: 'retry after 2s',
        remediationCommands: ['hermes acquire ms365'],
      },
    );

    expect(err.toJSON()).toMatchObject({
      code: 'REFRESH_FAILED',
      category: 'transient',
      retryable: true,
      retryHint: 'retry-after',
      retryAfterMs: 1200,
      remediationCommands: ['hermes acquire ms365'],
    });
  });

  it('serializes Conditional Access challenge metadata', () => {
    const err = new HermesError(
      HermesErrorCode.ACQUIRE_REQUIRED,
      'acquire failed for servicenow: device_certificate_required',
      {
        remediation: 'Run on a managed device. Then run: hermes acquire servicenow',
        remediationCommands: ['hermes acquire servicenow'],
        conditionalAccessChallenge: {
          state: 'device_certificate_required',
          category: 'environment-required',
          message: 'device_certificate_required: select a certificate',
          retryable: false,
          retryHint: 'human-action-required',
          remediation: 'Run on a managed device. Then run: hermes acquire servicenow',
          remediationCommands: ['hermes acquire servicenow'],
          evidence: { selector: 'text=/select a certificate/i' },
        },
      },
    );

    expect(err.toJSON()).toMatchObject({
      code: 'ACQUIRE_REQUIRED',
      conditionalAccessChallenge: {
        state: 'device_certificate_required',
        remediationCommands: ['hermes acquire servicenow'],
      },
    });
  });
});
