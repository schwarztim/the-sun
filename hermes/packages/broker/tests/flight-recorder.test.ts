import { describe, expect, it } from 'vitest';
import {
  createDerivedHeaderArtifactProof,
  createFlightRecord,
  createTokenBundleArtifactProof,
  FlightRecorder,
  redactFlightRecorderValue,
} from '../src/index.js';
import type { TokenBundle } from '../src/types.js';
import { stashSessionNotFoundFixture, teams401ErrorCode911Fixture } from './chaos-fixtures.js';

function teamsBundle(): TokenBundle {
  return {
    service: 'ms365',
    scheme: 'teams',
    accessToken: 'secret-access-token-teams',
    refreshToken: 'secret-refresh-token-teams',
    tokenType: 'Bearer',
    expiresAt: 1_700_001_000_000,
    acquiredAt: 1_700_000_000_000,
    scope: 'Chat.Read Chat.ReadWrite',
    extra: { skypetoken: 'secret-skype-token-extra' },
  };
}

describe('redacted auth/transport flight recorder', () => {
  it('records Teams 401 errorCode 911 as auth recovery without leaking message or token content', () => {
    const recorder = new FlightRecorder({ now: () => 1_700_000_000_000, correlationId: () => 'corr-teams-911' });
    const record = recorder.record({
      requestedCapability: 'Chat.Read',
      tool: 'get_chat_messages',
      operation: 'read chat messages',
      endpointClass: 'teams-chat-messages',
      backendAlias: 'teams-mcp',
      canonicalService: 'ms365',
      requestedService: 'teams',
      scheme: 'teams',
      providerName: 'provider-ms365',
      args: {
        chatId: '19:meeting-secret-thread@thread.v2',
        messageBody: 'do not leak outbound message body',
        authorization: 'Bearer outbound-secret-token',
      },
      credentialArtifactProofs: [
        createTokenBundleArtifactProof(teamsBundle(), { observedAt: 1_700_000_000_000, now: 1_700_000_000_000 }),
        createDerivedHeaderArtifactProof('x-skypetoken', 'secret-skype-token-header', { observedAt: 1_700_000_000_001 }),
      ],
      failure: { domain: 'auto', evidence: teams401ErrorCode911Fixture() },
    });

    expect(record).toMatchObject({
      correlationId: 'corr-teams-911',
      request: { capability: 'Chat.Read', tool: 'get_chat_messages' },
      identity: { backendAlias: 'teams-mcp', canonicalService: 'ms365', requestedService: 'teams' },
      failure: {
        domain: 'auth',
        classification: 'auth_recovery',
        credentialStatus: 'suspect',
        httpStatus: 401,
        failureCode: '911',
      },
    });
    expect(record.credentialArtifactProofs).toHaveLength(2);
    expect(record.recoveryGuidance.remediation).toContain('request a fresh token');
    expect(recorder.list({ tool: 'get_chat_messages' })).toEqual([record]);

    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain('secret-access-token-teams');
    expect(serialized).not.toContain('secret-refresh-token-teams');
    expect(serialized).not.toContain('secret-skype-token-extra');
    expect(serialized).not.toContain('secret-skype-token-header');
    expect(serialized).not.toContain('super secret Teams message body');
    expect(serialized).not.toContain('outbound message body');
    expect(serialized).not.toContain('Bearer outbound-secret-token');
    expect(serialized).not.toContain('secret-cookie-value');
    expect(serialized).toContain('artifactIdDigest');
  });

  it('records Stash Session not found as transport/session failure and not auth', () => {
    const record = createFlightRecord({
      correlationId: 'corr-stash-session',
      startedAt: 1,
      completedAt: 5,
      requestedCapability: 'pull-request-write',
      tool: 'stash_create_pull_request',
      operation: 'create pull request',
      backendAlias: 'stash-mcp',
      canonicalService: 'stash',
      scheme: 'pat',
      failure: { domain: 'auto', evidence: stashSessionNotFoundFixture() },
    });

    expect(record.failure).toMatchObject({
      domain: 'transport',
      classification: 'mcp_session_not_found',
      authFailure: false,
      credentialStatus: 'unchanged',
    });
    expect(record.recoveryGuidance).toMatchObject({
      failureDomain: 'mcp_transport',
      credentialRefreshRecommended: false,
      resetSession: true,
    });
    expect(JSON.stringify(record)).not.toContain('auth_recovery');
  });

  it('redacts auth headers, cookies, API keys, x-skypetoken values, bodies, URLs, and obvious secrets', () => {
    const redacted = redactFlightRecorderValue({
      authorization: 'Bearer secret-token-value',
      cookie: 'sid=secret-cookie-value',
      'x-skypetoken': 'secret-skype-token-value',
      apiKey: 'secret-api-key-value',
      url: 'https://user:password@example.test/path?api_key=secret-query-key',
      body: { content: 'secret request body content' },
      message: 'failed with access_token=secret-access-token and password=secret-password',
    });

    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain('secret-token-value');
    expect(serialized).not.toContain('secret-cookie-value');
    expect(serialized).not.toContain('secret-skype-token-value');
    expect(serialized).not.toContain('secret-api-key-value');
    expect(serialized).not.toContain('secret-query-key');
    expect(serialized).not.toContain('secret request body content');
    expect(serialized).not.toContain('secret-access-token');
    expect(serialized).not.toContain('secret-password');
  });
});
