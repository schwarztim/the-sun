import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HermesError, HermesErrorCode } from '../src/errors.js';
import { LifecycleStateStore } from '../src/lifecycle-state.js';

const testDirs: string[] = [];
function testDataDir(): string {
  const dir = path.join(process.cwd(), '.test-data', `lifecycle-state-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  testDirs.push(dir);
  return dir;
}

describe('LifecycleStateStore', () => {
  afterEach(() => {
    while (testDirs.length > 0) rmSync(testDirs.pop()!, { recursive: true, force: true });
  });

  it('persists non-secret lifecycle state across store instances', async () => {
    const dir = testDataDir();
    const store = new LifecycleStateStore(dir);
    await store.recordRefreshAttempt('ms365', 'graph', 1_700_000_000_000);
    await store.recordRefreshFailure(
      'ms365',
      'graph',
      new HermesError(HermesErrorCode.INTERACTIVE_AUTH_REQUIRED, 'Bearer secret-token refreshToken=secret expired'),
      { cooldownUntil: 1_700_000_060_000 },
    );
    await store.recordProof('ms365', 'graph', 'unknown', 1_700_000_001_000);
    await store.recordProofEvents('ms365', 'graph', [{
      tier: 'provider_validated',
      status: 'degraded',
      at: 1_700_000_001_500,
      error: 'Bearer secret-token validate failed',
      metadata: { validationStrategy: 'http' },
    }], { proofTier: 'fresh', proofState: 'degraded' });
    await store.recordPropagation('ms365', 'graph', 'degraded', [{
      step: 'downstream_smoke_probe',
      status: 'degraded',
      at: 1_700_000_002_000,
      error: 'Bearer secret-token accessToken=abc failed',
      metadata: { secretName: 'MS365_GRAPH_TOKEN', backends: 1 },
    }], { at: 1_700_000_003_000, error: 'refreshToken=secret probe failed' });

    const reloaded = new LifecycleStateStore(dir);
    expect(await reloaded.get('ms365', 'graph')).toMatchObject({
      service: 'ms365',
      scheme: 'graph',
      lastRefreshAttemptAt: 1_700_000_000_000,
      cooldownUntil: 1_700_000_060_000,
      lastErrorCode: HermesErrorCode.INTERACTIVE_AUTH_REQUIRED,
      lastErrorMessage: 'Bearer [redacted] refreshToken=[redacted] expired',
      proofStatus: 'degraded',
      proofTier: 'fresh',
      proofState: 'degraded',
      lastProofAt: 1_700_000_001_500,
      proofEvents: [{
        tier: 'provider_validated',
        status: 'degraded',
        at: 1_700_000_001_500,
        error: 'Bearer [redacted] validate failed',
        metadata: { validationStrategy: 'http' },
      }],
      propagationStatus: 'degraded',
      lastPropagationAt: 1_700_000_003_000,
      lastPropagationError: 'refreshToken=[redacted] probe failed',
      propagationEvents: [{
        step: 'downstream_smoke_probe',
        status: 'degraded',
        at: 1_700_000_002_000,
        error: 'Bearer [redacted] accessToken=[redacted] failed',
        metadata: { secretName: 'MS365_GRAPH_TOKEN', backends: 1 },
      }],
    });
  });

  it('clears cooldown and error fields after a successful acquire', async () => {
    const store = new LifecycleStateStore(testDataDir());
    await store.recordAcquireFailure('ms365', 'graph', new Error('browser unavailable'), { cooldownUntil: 1_700_000_060_000 });
    await store.recordAcquireSuccess('ms365', 'graph', 1_700_000_010_000);

    expect(await store.get('ms365', 'graph')).toMatchObject({
      service: 'ms365',
      scheme: 'graph',
      lastAcquireSuccessAt: 1_700_000_010_000,
    });
    expect(await store.get('ms365', 'graph')).not.toMatchObject({
      cooldownUntil: expect.any(Number),
      lastErrorCode: expect.any(String),
    });
  });
});
