/**
 * Tests for honest status semantics:
 *   A. Refreshability is informational, not health.
 *   B. Staleness rules applied at status-read time.
 *   C. Degraded summary count reflects only genuinely actionable problems.
 *   D. thv-storage secret-set timeout is 30 seconds.
 */
import { describe, it, expect } from 'vitest';
import { summarizeOperatorHealth, type StatusRegistryLens, type TokenHealthLike } from '../src/operator-ux.js';

// ---------------------------------------------------------------------------
// Registry lens stubs
// ---------------------------------------------------------------------------

function makeRegistry(overrides: {
  autoReacquire?: boolean;
  refreshStrategy?: string;
  thvContainerName?: string;
  providerName?: string;
} = {}): StatusRegistryLens {
  const providerName = overrides.providerName ?? 'cookie-session';
  const refreshStrategy = overrides.refreshStrategy ?? 'reacquire';
  return {
    getService: (_name: string) => ({
      autoReacquire: overrides.autoReacquire,
      thvContainerName: overrides.thvContainerName,
      providerName,
    }),
    getProvider: (_name: string) => ({
      capabilities: {
        schemes: [{ scheme: 'session', refreshStrategy }, { scheme: 'pat', refreshStrategy }],
      },
    }),
  };
}

function makeToken(overrides: Partial<TokenHealthLike> = {}): TokenHealthLike {
  return {
    service: 'servicenow',
    scheme: 'session',
    status: 'no-refresh-token',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// A. Refreshability semantics
// ---------------------------------------------------------------------------

describe('A — no-refresh-token is healthy for non-refreshable providers', () => {
  it('autoReacquire=true: no-refresh-token is healthy with informational note', () => {
    const registry = makeRegistry({ autoReacquire: true });
    const summary = summarizeOperatorHealth([makeToken()], { registry });

    expect(summary.status).toBe('healthy');
    expect(summary.degradedServices).toHaveLength(0);
    const svc = summary.services[0]!;
    expect(svc.status).toBe('healthy');
    expect(svc.reason).toContain('reacquired automatically on expiry');
    expect(svc.nextAction).toContain('Informational:');
    expect(svc.nextAction).not.toContain('create a refreshable credential');
  });

  it('reacquire refreshStrategy (no autoReacquire flag): no-refresh-token is healthy', () => {
    const registry = makeRegistry({ refreshStrategy: 'reacquire' });
    const summary = summarizeOperatorHealth([makeToken()], { registry });

    expect(summary.status).toBe('healthy');
    expect(summary.degradedServices).toHaveLength(0);
    const svc = summary.services[0]!;
    expect(svc.status).toBe('healthy');
    expect(svc.nextAction).toContain('hermes acquire servicenow when it expires');
    expect(svc.nextAction).not.toContain('create a refreshable credential');
  });

  it('api-token refreshStrategy: no-refresh-token is healthy', () => {
    const registry = makeRegistry({ refreshStrategy: 'reacquire', providerName: 'adventureworks' });
    const summary = summarizeOperatorHealth([makeToken({ scheme: 'pat' })], { registry });

    expect(summary.status).toBe('healthy');
    expect(summary.degradedServices).toHaveLength(0);
  });

  it('refresh-token strategy missing refresh token: still degraded', () => {
    // ms365 graph uses refresh-token strategy — missing refresh token IS a problem
    const registry: StatusRegistryLens = {
      getService: (_name) => ({ providerName: 'ms365', autoReacquire: undefined }),
      getProvider: (_name) => ({
        capabilities: {
          schemes: [{ scheme: 'graph', refreshStrategy: 'refresh-token' }],
        },
      }),
    };
    const summary = summarizeOperatorHealth([makeToken({ service: 'ms365', scheme: 'graph' })], { registry });

    expect(summary.status).toBe('degraded');
    expect(summary.degradedServices).toHaveLength(1);
  });

  it('no registry: no-refresh-token still degraded (backward compatible)', () => {
    const summary = summarizeOperatorHealth([makeToken()]);
    // Without registry, we cannot determine refreshability — conservative: degraded
    expect(summary.status).toBe('degraded');
  });

  it('provider not installed (static import like github_pat): no-refresh-token is healthy', () => {
    // github/stash PATs are imported credentials; their providers are not installed in
    // the broker. Nothing can refresh them — missing refresh token is the permanent,
    // expected state, not a degraded condition.
    const registry: StatusRegistryLens = {
      getService: (_name) => ({ providerName: 'github_pat', autoReacquire: undefined }),
      getProvider: (_name) => undefined,
    };
    const summary = summarizeOperatorHealth([makeToken({ service: 'github', scheme: 'pat' })], { registry });

    expect(summary.status).toBe('healthy');
    expect(summary.degradedServices).toHaveLength(0);
    expect(summary.services[0]!.nextAction).not.toContain('create a refreshable credential');
  });
});

// ---------------------------------------------------------------------------
// B. Staleness rules at status-read time
// ---------------------------------------------------------------------------

describe('B — propagation staleness evaluated at read time', () => {
  const THIRTY_TWO_MINUTES_AGO = Date.now() - 32 * 60_000;
  const TWENTY_MINUTES_AGO = Date.now() - 20 * 60_000;
  const TEN_DAYS_AGO = Date.now() - 10 * 24 * 3600_000;
  const TWO_DAYS_AGO = Date.now() - 2 * 24 * 3600_000;

  it('in_progress older than 30 minutes is presented as stale_in_progress (not degraded)', () => {
    const registry = makeRegistry({ thvContainerName: 'servicenow-mcp' });
    const token = makeToken({
      lifecycle: {
        service: 'servicenow',
        scheme: 'session',
        propagationStatus: 'in_progress',
        lastPropagationAt: THIRTY_TWO_MINUTES_AGO,
      } as unknown as import('../src/lifecycle-state.js').LifecycleState,
    });
    const summary = summarizeOperatorHealth([token], { registry });

    expect(summary.status).toBe('healthy');
    expect(summary.degradedServices).toHaveLength(0);
    const svc = summary.services[0]!;
    expect(svc.propagationStatus).toBe('stale_in_progress');
    expect(svc.nextAction).toContain('stale');
  });

  it('in_progress within 30 minutes is still treated as live', () => {
    const registry = makeRegistry({ thvContainerName: 'servicenow-mcp' });
    const token = makeToken({
      status: 'healthy',
      lifecycle: {
        service: 'servicenow',
        scheme: 'session',
        propagationStatus: 'in_progress',
        lastPropagationAt: TWENTY_MINUTES_AGO,
      } as unknown as import('../src/lifecycle-state.js').LifecycleState,
    });
    const summary = summarizeOperatorHealth([token], { registry });

    expect(summary.status).toBe('degraded');
    const svc = summary.services[0]!;
    expect(svc.propagationStatus).toBe('in_progress');
  });

  it('failed propagation for service without thvContainerName is presented as not_configured', () => {
    // The service no longer configures thv — old failed state is stale
    const registry: StatusRegistryLens = {
      getService: (_name) => ({ providerName: 'ms365', autoReacquire: undefined, thvContainerName: undefined }),
      getProvider: (_name) => ({ capabilities: { schemes: [{ scheme: 'graph', refreshStrategy: 'refresh-token' }] } }),
    };
    const token: TokenHealthLike = {
      service: 'ms365',
      scheme: 'graph',
      status: 'healthy',
      lifecycle: {
        service: 'ms365',
        scheme: 'graph',
        propagationStatus: 'failed',
        lastPropagationAt: TWO_DAYS_AGO,
        lastPropagationError: 'thv timed out',
      } as unknown as import('../src/lifecycle-state.js').LifecycleState,
    };
    const summary = summarizeOperatorHealth([token], { registry });

    expect(summary.status).toBe('healthy');
    expect(summary.degradedServices).toHaveLength(0);
    const svc = summary.services[0]!;
    expect(svc.propagationStatus).toBe('not_configured');
    expect(svc.nextAction).toContain('not configured');
  });

  it('lifecycle errors older than 7 days are excluded from the degraded count', () => {
    const token: TokenHealthLike = {
      service: 'stash',
      scheme: 'pat',
      status: 'no-refresh-token',
      lifecycle: {
        service: 'stash',
        scheme: 'pat',
        lastErrorCode: 'CONSUMER_TRANSIENT_FAILURE',
        lastErrorMessage: 'backend HTTP 503',
        lastErrorAt: TEN_DAYS_AGO,
      } as unknown as import('../src/lifecycle-state.js').LifecycleState,
    };
    // registry: stash is reacquire-strategy (no-refresh-token is by design)
    const registry = makeRegistry({ refreshStrategy: 'reacquire', providerName: 'stash_pat' });
    const summary = summarizeOperatorHealth([token], { registry });

    // Both no-refresh-token and old lifecycle error should be excluded
    expect(summary.status).toBe('healthy');
    expect(summary.degradedServices).toHaveLength(0);
  });

  it('lifecycle errors within 7 days are still included in the degraded count', () => {
    const token: TokenHealthLike = {
      service: 'stash',
      scheme: 'pat',
      status: 'healthy',
      lifecycle: {
        service: 'stash',
        scheme: 'pat',
        lastErrorCode: 'CONSUMER_TRANSIENT_FAILURE',
        lastErrorMessage: 'backend HTTP 503',
        lastErrorAt: TWO_DAYS_AGO,
      } as unknown as import('../src/lifecycle-state.js').LifecycleState,
    };
    const registry = makeRegistry({ refreshStrategy: 'reacquire', providerName: 'stash_pat' });
    const summary = summarizeOperatorHealth([token], { registry });

    expect(summary.status).toBe('degraded');
    expect(summary.degradedServices).toHaveLength(1);
    expect(summary.services[0]!.lifecycleError).toBe('CONSUMER_TRANSIENT_FAILURE');
  });

  it('credential-suspect state older than 7 days is excluded from degraded count (transient failure aging)', () => {
    // stash/pat: credentialStatus=degraded from a CONSUMER_TRANSIENT_FAILURE (HTTP 503)
    // that occurred 22 days ago — should not keep the service degraded forever.
    const token: TokenHealthLike = {
      service: 'stash',
      scheme: 'pat',
      status: 'no-refresh-token',
      lifecycle: {
        service: 'stash',
        scheme: 'pat',
        credentialStatus: 'degraded',
        lastConsumerAuthFailureAt: TEN_DAYS_AGO,
      } as unknown as import('../src/lifecycle-state.js').LifecycleState,
    };
    // stash_pat uses reacquire strategy — no-refresh-token is by design
    const registry = makeRegistry({ refreshStrategy: 'reacquire', providerName: 'stash_pat' });
    const summary = summarizeOperatorHealth([token], { registry });

    expect(summary.status).toBe('healthy');
    expect(summary.degradedServices).toHaveLength(0);
    // Evidence still present (we only suppress the reason, not the evidence)
    const svc = summary.services[0]!;
    expect(svc.status).toBe('healthy');
    expect(svc.reason).not.toContain('credential is degraded');
  });

  it('credential-suspect state within 7 days is still included in degraded count', () => {
    // Fresh CONSUMER_TRANSIENT_FAILURE (2 days ago) — should still show as degraded.
    const token: TokenHealthLike = {
      service: 'stash',
      scheme: 'pat',
      status: 'healthy',
      lifecycle: {
        service: 'stash',
        scheme: 'pat',
        credentialStatus: 'degraded',
        lastConsumerAuthFailureAt: TWO_DAYS_AGO,
      } as unknown as import('../src/lifecycle-state.js').LifecycleState,
    };
    const registry = makeRegistry({ refreshStrategy: 'reacquire', providerName: 'stash_pat' });
    const summary = summarizeOperatorHealth([token], { registry });

    expect(summary.status).toBe('degraded');
    expect(summary.degradedServices).toHaveLength(1);
    const svc = summary.services[0]!;
    expect(svc.reason).toContain('credential is degraded');
  });
});

// ---------------------------------------------------------------------------
// C. Degraded count integrity
// ---------------------------------------------------------------------------

describe('C — degraded count only includes genuinely actionable problems', () => {
  it('mixed bag: only real failures count', () => {
    const now = Date.now();
    const registry: StatusRegistryLens = {
      getService: (name) => {
        const map: Record<string, { providerName: string; autoReacquire?: boolean; thvContainerName?: string }> = {
          github: { providerName: 'github_pat' },
          stash: { providerName: 'stash_pat' },
          servicenow: { providerName: 'servicenow', autoReacquire: true },
          ms365: { providerName: 'ms365' },
        };
        return map[name];
      },
      getProvider: (name) => {
        const strategyMap: Record<string, string> = {
          github_pat: 'reacquire',
          stash_pat: 'reacquire',
          servicenow: 'reacquire',
          ms365: 'refresh-token',
        };
        const strategy = strategyMap[name] ?? 'refresh-token';
        return { capabilities: { schemes: [{ scheme: 'pat', refreshStrategy: strategy }, { scheme: 'graph', refreshStrategy: strategy }, { scheme: 'session', refreshStrategy: strategy }] } };
      },
    };

    const tokens: TokenHealthLike[] = [
      // These should be healthy (non-refreshable by design)
      { service: 'github', scheme: 'pat', status: 'no-refresh-token' },
      { service: 'stash', scheme: 'pat', status: 'no-refresh-token' },
      { service: 'servicenow', scheme: 'session', status: 'no-refresh-token' },
      // This is a genuine degradation
      { service: 'ms365', scheme: 'graph', status: 'expired' },
    ];

    const summary = summarizeOperatorHealth(tokens, { registry, now });

    expect(summary.degradedServices).toHaveLength(1);
    expect(summary.degradedServices[0]!.service).toBe('ms365');
    expect(summary.summary).toContain('1 of 4');
  });
});

// ---------------------------------------------------------------------------
// D. thv-storage secret-set timeout
// ---------------------------------------------------------------------------

describe('D — thv-storage secret-set timeout is 30 000 ms', () => {
  it('writeToken uses 30s timeout (not 10s)', async () => {
    // The spawnWithInput call is internal, so we verify indirectly via the exported source.
    // We read the compiled/source constant by importing the module and checking that
    // a spawn that exceeds 10s but finishes before 30s would not be killed.
    // Since we cannot easily mock spawn here without affecting other tests, we verify
    // the timeout value is ≥ 30_000 by checking the source text.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const source = readFileSync(join(__dirname, '../src/thv-storage.ts'), 'utf8');
    // Verify the secret set call uses 30_000 (not 10_000)
    const secretSetMatch = source.match(/secret.*?set.*?(\d[\d_]+)/s);
    const secretGetMatch = source.match(/secret.*?get.*?timeout.*?(\d[\d_]+)/s);
    // Both timeouts should be 30_000
    expect(source).toContain("['secret', 'set', secretName], value, 30_000");
    expect(source).toContain("['secret', 'get', secretName], { timeout: 30_000 }");
    void secretSetMatch; void secretGetMatch; // suppress unused
  });
});
