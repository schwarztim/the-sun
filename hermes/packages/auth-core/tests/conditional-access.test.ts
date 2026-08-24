import { describe, expect, it } from 'vitest';
import {
  ConditionalAccessChallengeError,
  classifyConditionalAccessChallenge,
} from '../src/conditional-access.js';

describe('Conditional Access challenge classification', () => {
  it('classifies MFA/TOTP requirements with exact acquire remediation', () => {
    const challenge = classifyConditionalAccessChallenge({
      message: 'AADSTS50076: Due to a configuration change, multi-factor authentication is required.',
      service: 'ms365',
      acquireCommand: 'hermes acquire ms365',
    });

    expect(challenge).toMatchObject({
      state: 'mfa_or_totp_required',
      category: 'auth-required',
      retryable: false,
      retryHint: 'human-action-required',
      remediationCommands: ['hermes acquire ms365'],
    });
  });

  it('does not classify visible TOTP entry as blocked when TOTP is configured', () => {
    expect(classifyConditionalAccessChallenge({
      selectors: ['input[name="otc"]'],
      service: 'ms365',
      totpConfigured: true,
    })).toBeUndefined();
  });

  it('classifies device certificate and policy-blocked headless states', () => {
    expect(classifyConditionalAccessChallenge({
      text: 'Select a certificate to continue',
      service: 'servicenow',
    })?.state).toBe('device_certificate_required');

    expect(classifyConditionalAccessChallenge({
      text: 'You cannot access this right now because of a Conditional Access policy.',
      service: 'servicenow',
    })?.state).toBe('policy_blocks_headless');
  });

  it('classifies network/proxy failures as retryable with retryAfterMs', () => {
    const challenge = classifyConditionalAccessChallenge({
      message: 'ERR_TUNNEL_CONNECTION_FAILED',
      service: 'fabrikam',
    });

    expect(challenge).toMatchObject({
      state: 'vpn_or_network_required',
      category: 'environment-required',
      retryable: true,
      retryHint: 'retry-after',
      retryAfterMs: 60_000,
    });
  });

  it('emits structured JSON from ConditionalAccessChallengeError', () => {
    const challenge = classifyConditionalAccessChallenge({
      message: 'AADSTS65001 consent_required',
      service: 'azure-devops',
    });
    expect(challenge).toBeDefined();

    const err = new ConditionalAccessChallengeError(challenge!);
    expect(err.toJSON()).toMatchObject({
      name: 'ConditionalAccessChallengeError',
      state: 'consent_required',
      remediationCommands: ['hermes acquire azure-devops'],
    });
  });

  it('classifies unknown login routes only when requested', () => {
    expect(classifyConditionalAccessChallenge({
      url: 'https://idp.example.com/custom/login',
      service: 'contoso',
    })).toBeUndefined();

    expect(classifyConditionalAccessChallenge({
      url: 'https://idp.example.com/custom/login',
      service: 'contoso',
      unknownLoginRoute: true,
    })?.state).toBe('unknown_login_route');
  });
});
