import { describe, expect, it } from 'vitest';
import { formatOperatorSummary, redactOperatorValue, summarizeOperatorHealth, summarizeOperatorTimeline } from '../src/operator-ux.js';

describe('operator UX summaries', () => {
  it('reports degraded token inventory with safe next action and redacted evidence', () => {
    const summary = summarizeOperatorHealth([{
      service: 'ms365',
      scheme: 'graph',
      status: 'unknown',
      lifecycle: {
        service: 'ms365',
        scheme: 'graph',
        lastErrorCode: 'INTERACTIVE_AUTH_REQUIRED',
        lastErrorMessage: 'Bearer super.secret.token refresh_token=verysecret',
        lastErrorAt: 1_700_000_000_000,
      },
    }], { inventoryError: new Error('access_token=abc123 inventory corrupt') });

    expect(summary.status).toBe('degraded');
    expect(summary.nextAction).toContain('Token inventory could not be read');
    expect(summary.degradedServices[0]?.nextAction).toBe('Run: hermes acquire ms365. Do not delete or rotate stored credentials.');
    expect(JSON.stringify(summary)).not.toContain('super.secret.token');
    expect(JSON.stringify(summary)).not.toContain('abc123');
    expect(JSON.stringify(summary)).toContain('[redacted]');
  });

  it('summarizes degraded proof and propagation with exact remediation', () => {
    const summary = summarizeOperatorHealth([{
      service: 'servicenow',
      scheme: 'api',
      status: 'healthy',
      proof: { currentTier: 'provider_validated', state: 'degraded', tiers: [] },
      lifecycle: {
        service: 'servicenow',
        scheme: 'api',
        proofTier: 'provider_validated',
        proofState: 'degraded',
        propagationStatus: 'failed',
        lastPropagationError: 'gateway_reload failed authorization=Bearer secret',
        lastPropagationAt: 1_700_000_060_000,
      },
    }]);

    expect(summary.status).toBe('degraded');
    expect(summary.degradedServices[0]).toMatchObject({
      service: 'servicenow',
      scheme: 'api',
      proofTier: 'provider_validated',
      proofState: 'degraded',
      propagationStatus: 'failed',
    });
    expect(summary.degradedServices[0]?.nextAction).toContain('hermes doctor');
    expect(JSON.stringify(summary)).not.toContain('secret');
  });

  it('formats latest lifecycle timeline events', () => {
    const events = summarizeOperatorTimeline([{
      service: 'ms365',
      scheme: 'graph',
      status: 'healthy',
      lifecycle: {
        service: 'ms365',
        scheme: 'graph',
        proofEvents: [{ tier: 'provider_validated', status: 'degraded', at: 1_700_000_010_000, error: 'Bearer hidden' }],
        propagationEvents: [{ step: 'gateway_reload', status: 'ok', at: 1_700_000_020_000, durationMs: 42 }],
      },
    }]);

    expect(events[0]).toMatchObject({ kind: 'propagation:gateway_reload', status: 'ok' });
    expect(events[1]).toMatchObject({ kind: 'proof:provider_validated', status: 'degraded', message: 'Bearer [redacted]' });
  });

  it('formats one obvious operator surface', () => {
    const text = formatOperatorSummary(summarizeOperatorHealth([{
      service: 'ms365',
      scheme: 'graph',
      status: 'expired',
      lifecycle: { service: 'ms365', scheme: 'graph' },
    }]));
    expect(text).toContain('Hermes auth: degraded');
    expect(text).toContain('Next action: Run: hermes acquire ms365');
    expect(text).toContain('remediation: Run: hermes acquire ms365');
  });

  it('redacts token-shaped metadata keys and values', () => {
    expect(redactOperatorValue({
      access_token: 'abc123',
      refreshToken: 'def456',
      apiKey: 'ghi789',
      nested: { authorization: 'Bearer secret-token', note: 'safe' },
    })).toEqual({
      access_token: '[redacted]',
      refreshToken: '[redacted]',
      apiKey: '[redacted]',
      nested: { authorization: '[redacted]', note: 'safe' },
    });
  });

  it('enriches degraded operator summary with runbook, owner, constraints, and safe probe metadata', () => {
    const summary = summarizeOperatorHealth([{
      service: 'ms365',
      scheme: 'graph',
      status: 'expired',
      lifecycle: { service: 'ms365', scheme: 'graph' },
    }], {
      orgRunbooks: [{
        service: 'ms365',
        scheme: 'graph',
        owner: 'Collaboration Platform',
        confluenceRunbookUrl: 'https://example.atlassian.net/wiki/spaces/ENG/pages/123/MS365+Runbook',
        conditionalAccess: ['device certificate required'],
        networkRequirements: ['corporate VPN for admin endpoints'],
        safeProbe: { description: 'Graph /me read-only probe', tool: 'graph_me' },
        lastVerifiedAt: '2026-04-10T12:00:00.000Z',
      }],
    });

    expect(summary.degradedServices[0]?.orgMetadata).toMatchObject({
      owner: 'Collaboration Platform',
      safeProbe: { tool: 'graph_me' },
    });
    expect(summary.degradedServices[0]?.evidence.some((ev) => ev.kind === 'org-runbook')).toBe(true);
    const text = formatOperatorSummary(summary);
    expect(text).toContain('owner=Collaboration Platform');
    expect(text).toContain('device certificate required');
    expect(text).toContain('Graph /me read-only probe');
  });

  it('degrades gracefully when no org metadata exists', () => {
    const summary = summarizeOperatorHealth([{
      service: 'unknown',
      scheme: 'session',
      status: 'expired',
      lifecycle: { service: 'unknown', scheme: 'session' },
    }], { orgRunbooks: [] });

    expect(summary.degradedServices[0]?.orgMetadata).toBeUndefined();
    expect(formatOperatorSummary(summary)).not.toContain('runbook:');
  });

  it('surfaces ServiceNow advisory metadata without secrets', () => {
    const summary = summarizeOperatorHealth([{
      service: 'servicenow',
      scheme: 'session',
      status: 'healthy',
      lifecycle: { service: 'servicenow', scheme: 'session' },
    }], {
      orgRunbooks: [{
        service: 'servicenow',
        scheme: 'session',
        team: 'IT Service Management',
        confluenceRunbookUrl: 'https://example.atlassian.net/wiki/spaces/ITSM/pages/456/ServiceNow+Hermes+Runbook',
        serviceNowGroup: 'ServiceNow Platform',
        safeProbe: { description: 'Read-only current user probe', toolName: 'servicenow_get_current_user' },
        conditionalAccessNotes: ['browser-acquired session; status never triggers live acquire'],
        vpn: 'Corporate VPN required for instance access',
        integrationNotes: ['do not store api-key=secret-value in org metadata'],
        lastVerifiedAt: '2026-04-10T13:00:00.000Z',
      }],
    });

    expect(summary.services[0]?.orgMetadata?.serviceNowGroup).toBe('ServiceNow Platform');
    expect(JSON.stringify(summary)).not.toContain('secret-value');
    expect(formatOperatorSummary(summary)).toContain('servicenow_get_current_user');
  });
});
