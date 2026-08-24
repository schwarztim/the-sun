import { describe, expect, it, vi } from 'vitest';
import {
  freshProof,
  proofEventsFromPropagation,
  providerValidationProof,
  summarizeProof,
  azTeamsHttpProof,
  AZ_TEAMS_SCHEME_PROBE_URLS,
} from '../src/proof-probes.js';
import type { Provider, ProviderContext, TokenBundle } from '../src/types.js';

const bundle: TokenBundle = {
  service: 'synthetic',
  scheme: 'api',
  accessToken: 'secret-access-token',
  refreshToken: 'secret-refresh-token',
  tokenType: 'Bearer',
  expiresAt: 1_700_000_600_000,
  acquiredAt: 1_700_000_000_000,
};

const ctx: ProviderContext = {
  service: 'synthetic',
  config: { headless: true },
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  dataDir: '.test-data',
};

function provider(validate: () => Promise<boolean>): Provider {
  return {
    name: 'synthetic',
    schemes: ['api'],
    capabilities: {
      headless: true,
      schemes: [{
        scheme: 'api',
        credentialSource: 'api-token',
        refreshStrategy: 'none',
        supportsRefresh: false,
        supportsValidation: true,
        validationStrategy: 'service-probe',
      }],
      remediation: { acquire: 'synthetic acquire', refresh: 'synthetic refresh', validate: 'synthetic validate' },
    },
    acquire: vi.fn(async () => bundle),
    refresh: vi.fn(async (_ctx, b) => b),
    validate,
    nextRefreshAt: (b) => new Date(b.expiresAt),
  };
}

describe('proof probes', () => {
  it('calculates stored/fresh/provider_validated tiers with a synthetic provider', async () => {
    const providerProof = await providerValidationProof(provider(vi.fn(async () => true)), ctx, bundle, 1_700_000_100_000);
    const summary = summarizeProof([
      freshProof(bundle, { now: 1_700_000_100_000, safetyMarginMs: 300_000 }),
      providerProof,
    ]);

    expect(providerProof).toMatchObject({ tier: 'provider_validated', status: 'valid' });
    expect(summary).toMatchObject({
      highestValidTier: 'provider_validated',
      currentTier: 'provider_validated',
      state: 'valid',
    });
    expect(JSON.stringify(summary)).not.toContain('secret-access-token');
  });

  it('marks provider validation failures without overclaiming beyond freshness', async () => {
    const providerProof = await providerValidationProof(provider(vi.fn(async () => false)), ctx, bundle, 1_700_000_100_000);
    const summary = summarizeProof([
      freshProof(bundle, { now: 1_700_000_100_000, safetyMarginMs: 300_000 }),
      providerProof,
    ]);

    expect(providerProof).toMatchObject({ tier: 'provider_validated', status: 'failed' });
    expect(summary.highestValidTier).toBe('fresh');
    expect(summary.currentTier).toBe('provider_validated');
    expect(summary.state).toBe('failed');
  });

  it('derives propagated and mcp_validated proof tiers from downstream probe events', () => {
    const events = proofEventsFromPropagation('degraded', [
      { step: 'secret_write', status: 'ok', at: 1 },
      { step: 'container_readiness', status: 'ok', at: 2 },
      { step: 'fleet_sync', status: 'ok', at: 3 },
      { step: 'gateway_reload', status: 'ok', at: 4 },
      { step: 'downstream_smoke_probe', status: 'ok', at: 5 },
      { step: 'downstream_auth_probe', status: 'degraded', at: 6, error: 'tools/call HTTP 401' },
    ], 6);

    expect(events).toEqual([
      expect.objectContaining({ tier: 'propagated', status: 'valid' }),
      expect.objectContaining({ tier: 'mcp_validated', status: 'degraded' }),
    ]);
  });

  it('treats transport-only smoke success as skipped mcp_validated evidence', () => {
    const events = proofEventsFromPropagation('ok', [
      { step: 'secret_write', status: 'ok', at: 1 },
      { step: 'container_readiness', status: 'ok', at: 2 },
      { step: 'fleet_sync', status: 'ok', at: 3 },
      { step: 'gateway_reload', status: 'ok', at: 4 },
      { step: 'downstream_smoke_probe', status: 'ok', at: 5 },
    ], 6);

    expect(events).toEqual([
      expect.objectContaining({ tier: 'propagated', status: 'valid' }),
      expect.objectContaining({
        tier: 'mcp_validated',
        status: 'skipped',
        message: expect.stringContaining('transport smoke only does not validate credentials'),
      }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// az-teams scope-appropriate HTTP probe
// ---------------------------------------------------------------------------

describe('AZ_TEAMS_SCHEME_PROBE_URLS', () => {
  it('maps graph to GET /v1.0/me (User.Read, always present on Azure CLI token)', () => {
    expect(AZ_TEAMS_SCHEME_PROBE_URLS['graph']).toBe('https://graph.microsoft.com/v1.0/me');
  });

  it('maps files to GET /v1.0/me/drive (Files.ReadWrite.All, no Chat.* scope required)', () => {
    expect(AZ_TEAMS_SCHEME_PROBE_URLS['files']).toBe('https://graph.microsoft.com/v1.0/me/drive');
  });

  it('maps teams-bearer to GET /v1.0/me (minimal-scope, avoids CSA/Chat endpoints that would 403)', () => {
    expect(AZ_TEAMS_SCHEME_PROBE_URLS['teams-bearer']).toBe('https://graph.microsoft.com/v1.0/me');
  });

  it('maps teams (alias) to the same URL as teams-bearer', () => {
    expect(AZ_TEAMS_SCHEME_PROBE_URLS['teams']).toBe(AZ_TEAMS_SCHEME_PROBE_URLS['teams-bearer']);
  });

  it('maps skype to null (derived token — no HTTP probe)', () => {
    expect(AZ_TEAMS_SCHEME_PROBE_URLS['skype']).toBeNull();
  });

  it('maps substrate to OWA /api/v2.0/me (outlook.office.com/search scope)', () => {
    expect(AZ_TEAMS_SCHEME_PROBE_URLS['substrate']).toBe('https://outlook.office.com/api/v2.0/me');
  });

  it('does NOT contain any Chat.* endpoint (Chat.Read/Chat.ReadWrite not granted to CLI app)', () => {
    const values = Object.values(AZ_TEAMS_SCHEME_PROBE_URLS).filter(Boolean) as string[];
    for (const url of values) {
      expect(url).not.toMatch(/\/chats/i);
      expect(url).not.toMatch(/chat\.read/i);
    }
  });
});

describe('azTeamsHttpProof', () => {
  const AT = 1_700_000_100_000;

  it('returns valid ProofEvent on HTTP 200 for graph scheme', async () => {
    const fetcher = vi.fn(async () => ({ ok: true, status: 200 }));
    const event = await azTeamsHttpProof('graph', 'test-access-token', fetcher, AT);

    expect(event).toMatchObject({
      tier: 'provider_validated',
      status: 'valid',
      at: AT,
      metadata: expect.objectContaining({
        scheme: 'graph',
        probeUrl: 'https://graph.microsoft.com/v1.0/me',
        httpStatus: 200,
        probeStrategy: 'scope-appropriate-get',
      }),
    });
    expect(fetcher).toHaveBeenCalledWith(
      'https://graph.microsoft.com/v1.0/me',
      expect.objectContaining({
        method: 'GET',
        headers: { Authorization: 'Bearer test-access-token' },
      }),
    );
  });

  it('returns valid ProofEvent on HTTP 200 for files scheme (GET /me/drive)', async () => {
    const fetcher = vi.fn(async () => ({ ok: true, status: 200 }));
    const event = await azTeamsHttpProof('files', 'test-access-token', fetcher, AT);

    expect(event).toMatchObject({
      tier: 'provider_validated',
      status: 'valid',
      metadata: expect.objectContaining({
        scheme: 'files',
        probeUrl: 'https://graph.microsoft.com/v1.0/me/drive',
      }),
    });
  });

  it('returns failed ProofEvent on HTTP 401 (token rejected by resource server)', async () => {
    const fetcher = vi.fn(async () => ({ ok: false, status: 401 }));
    const event = await azTeamsHttpProof('graph', 'expired-token', fetcher, AT);

    expect(event).toMatchObject({
      tier: 'provider_validated',
      status: 'failed',
      at: AT,
      metadata: expect.objectContaining({ httpStatus: 401 }),
    });
    expect(event.message).toContain('HTTP 401');
  });

  it('returns failed ProofEvent on HTTP 403 (scope mismatch — surfaces misconfiguration)', async () => {
    const fetcher = vi.fn(async () => ({ ok: false, status: 403 }));
    const event = await azTeamsHttpProof('graph', 'wrong-scope-token', fetcher, AT);

    expect(event).toMatchObject({
      tier: 'provider_validated',
      status: 'failed',
      metadata: expect.objectContaining({ httpStatus: 403 }),
    });
  });

  it('returns skipped ProofEvent for skype scheme (derived token — no HTTP probe)', async () => {
    const fetcher = vi.fn();
    const event = await azTeamsHttpProof('skype', 'skype-token', fetcher, AT);

    expect(event).toMatchObject({
      tier: 'provider_validated',
      status: 'skipped',
      at: AT,
    });
    expect(event.message).toContain('derived token');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('returns skipped ProofEvent for an unknown scheme (no probe URL configured)', async () => {
    const fetcher = vi.fn();
    const event = await azTeamsHttpProof('unknown-scheme', 'token', fetcher, AT);

    expect(event).toMatchObject({
      tier: 'provider_validated',
      status: 'skipped',
    });
    expect(event.message).toContain('no scope-appropriate probe URL');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('returns degraded ProofEvent on network error', async () => {
    const fetcher = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const event = await azTeamsHttpProof('graph', 'token', fetcher, AT);

    expect(event).toMatchObject({
      tier: 'provider_validated',
      status: 'degraded',
      at: AT,
    });
    expect(event.error).toBeDefined();
  });

  it('does not call any Chat.* endpoint for any scheme', async () => {
    const fetcher = vi.fn(async () => ({ ok: true, status: 200 }));
    const schemes = Object.keys(AZ_TEAMS_SCHEME_PROBE_URLS);

    for (const scheme of schemes) {
      vi.clearAllMocks();
      await azTeamsHttpProof(scheme, 'token', fetcher, AT);
      for (const call of fetcher.mock.calls) {
        const url = call[0] as string;
        expect(url).not.toMatch(/\/chats/i);
      }
    }
  });

  it('proof event does not contain raw access token value', async () => {
    const fetcher = vi.fn(async () => ({ ok: true, status: 200 }));
    const secretToken = 'secret-access-token-value-12345';
    const event = await azTeamsHttpProof('graph', secretToken, fetcher, AT);

    expect(JSON.stringify(event)).not.toContain(secretToken);
  });

  it('azTeamsHttpProof result integrates with summarizeProof as provider_validated', async () => {
    const fetcher = vi.fn(async () => ({ ok: true, status: 200 }));
    const probeEvent = await azTeamsHttpProof('graph', 'token', fetcher, AT);
    const freshEvent = freshProof(
      { service: 'az-teams', scheme: 'graph', accessToken: 'token', tokenType: 'Bearer', expiresAt: AT + 3600_000, acquiredAt: AT },
      { now: AT },
    );
    const summary = summarizeProof([freshEvent, probeEvent]);

    expect(summary.highestValidTier).toBe('provider_validated');
    expect(summary.state).toBe('valid');
  });
});
