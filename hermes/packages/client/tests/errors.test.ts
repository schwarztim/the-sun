import { describe, it, expect } from 'vitest';
import { HermesClientError, HermesClientErrorCode } from '../src/errors.js';

describe('HermesClientError', () => {
  it('carries code and remediation', () => {
    const e = new HermesClientError(HermesClientErrorCode.BROKER_UNREACHABLE, 'connection refused', { remediation: 'start the hermes broker' });
    expect(e.code).toBe('BROKER_UNREACHABLE');
    expect(e.remediation).toBe('start the hermes broker');
    expect(e instanceof Error).toBe(true);
  });
});
