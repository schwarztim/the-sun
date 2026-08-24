import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  createBrowserProfileArtifactProof,
  createCookieJarArtifactProof,
  createCredentialFileArtifactProof,
  createDerivedHeaderArtifactProof,
  createPropagationTransaction,
  createProxyEndpointArtifactProof,
  createTokenBundleArtifactProof,
  createToolHiveSecretArtifactProof,
  createVolumeMountArtifactProof,
  summarizePropagationTransaction,
} from '../src/credential-artifacts.js';
import type { TokenBundle } from '../src/types.js';

const testDirs: string[] = [];

function testDataDir(): string {
  const dir = path.join(process.cwd(), '.test-data', `credential-artifacts-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  testDirs.push(dir);
  return dir;
}

function bundle(): TokenBundle {
  return {
    service: 'ms365',
    scheme: 'teams',
    accessToken: 'secret-access-token-skype',
    refreshToken: 'secret-refresh-token-skype',
    tokenType: 'Bearer',
    expiresAt: 1_700_001_000_000,
    acquiredAt: 1_700_000_000_000,
    scope: 'Files.ReadWrite.All Chat.ReadWrite',
    extra: {
      skypetokenAsm: 'secret-skypetoken-asm',
      authtokenJWT: 'secret-auth-token-jwt',
      cookie: 'secret-cookie-value',
    },
  };
}

describe('credential artifact proofs', () => {
  afterEach(() => {
    while (testDirs.length > 0) rmSync(testDirs.pop()!, { recursive: true, force: true });
  });

  it('creates token bundle proofs from metadata without serializing token material', () => {
    const proof = createTokenBundleArtifactProof(bundle(), {
      observedAt: 1_700_000_100_000,
      now: 1_700_000_100_000,
      safetyMarginMs: 60_000,
      producedBy: 'provider-ms365',
    });

    expect(proof).toMatchObject({
      kind: 'token_bundle',
      artifactId: 'token_bundle:ms365:teams',
      proofStatus: 'present',
      freshness: 'fresh',
      service: 'ms365',
      scheme: 'teams',
      producedBy: 'provider-ms365',
      metadata: expect.objectContaining({
        tokenType: 'Bearer',
        hasRefreshToken: true,
        extraKeys: ['authtokenJWT', 'cookie', 'skypetokenAsm'],
      }),
    });
    const serialized = JSON.stringify(proof);
    expect(serialized).not.toContain('secret-access-token-skype');
    expect(serialized).not.toContain('secret-refresh-token-skype');
    expect(serialized).not.toContain('secret-skypetoken-asm');
    expect(serialized).not.toContain('secret-auth-token-jwt');
    expect(serialized).not.toContain('secret-cookie-value');
    expect(proof.metadata.scopeDigest).toMatch(/^sha256:/);
  });

  it('creates credential file, browser profile, and cookie jar proofs from stat metadata only', async () => {
    const dir = testDataDir();
    const tokensFile = path.join(dir, 'tokens.json');
    const profileDir = path.join(dir, 'profile');
    const cookieJar = path.join(dir, 'cookies.sqlite');
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(tokensFile, '{"accessToken":"secret-file-access-token"}', { mode: 0o600 });
    writeFileSync(cookieJar, 'secret-cookie-db-value', { mode: 0o600 });

    const fileProof = await createCredentialFileArtifactProof(tokensFile, {
      observedAt: Date.now(),
      now: Date.now(),
      maxAgeMs: 60_000,
      producedBy: 'ms365-provider',
    });
    const profileProof = await createBrowserProfileArtifactProof(profileDir, { observedAt: 1_700_000_100_000 });
    const cookieProof = await createCookieJarArtifactProof(cookieJar, { observedAt: 1_700_000_100_000 });

    expect(fileProof).toMatchObject({
      kind: 'credential_file',
      proofStatus: 'present',
      freshness: 'fresh',
      metadata: expect.objectContaining({ sourcePath: tokensFile, exists: true, size: expect.any(Number), mtimeMs: expect.any(Number) }),
    });
    expect(profileProof).toMatchObject({ kind: 'browser_profile', metadata: expect.objectContaining({ isDirectory: true }) });
    expect(cookieProof).toMatchObject({ kind: 'cookie_jar', metadata: expect.objectContaining({ sourcePath: cookieJar }) });
    const serialized = JSON.stringify([fileProof, profileProof, cookieProof]);
    expect(serialized).not.toContain('secret-file-access-token');
    expect(serialized).not.toContain('secret-cookie-db-value');
  });

  it('marks file metadata stale, fresh, and missing from mtime without reading file contents', async () => {
    const dir = testDataDir();
    const tokensFile = path.join(dir, 'tokens.json');
    writeFileSync(tokensFile, '{"refreshToken":"secret-file-refresh-token"}', { mode: 0o600 });

    const now = Date.now();
    const fresh = await createCredentialFileArtifactProof(tokensFile, { now, maxAgeMs: 60_000 });
    const stale = await createCredentialFileArtifactProof(tokensFile, { now: now + 120_000, maxAgeMs: 60_000 });
    const missing = await createCredentialFileArtifactProof(path.join(dir, 'missing.json'), { now, maxAgeMs: 60_000 });

    expect(fresh.freshness).toBe('fresh');
    expect(fresh.proofStatus).toBe('present');
    expect(stale.freshness).toBe('stale');
    expect(stale.proofStatus).toBe('stale');
    expect(missing.freshness).toBe('missing');
    expect(missing.proofStatus).toBe('missing');
    expect(JSON.stringify([fresh, stale, missing])).not.toContain('secret-file-refresh-token');
  });

  it('records mount declarations and derived header value digests without raw header values', () => {
    const mount = createVolumeMountArtifactProof({
      sourcePath: '/Users/test/.ms365-mcp',
      containerPath: '/root/.ms365-mcp',
      readOnly: true,
    }, { observedAt: 1, producedBy: 'toolhive' });
    const header = createDerivedHeaderArtifactProof('x-skypetoken', 'secret-skype-header-value', {
      observedAt: 1,
      producedBy: 'teams-provider',
    });

    expect(mount).toMatchObject({
      kind: 'volume_mount',
      metadata: { sourcePath: '/Users/test/.ms365-mcp', containerPath: '/root/.ms365-mcp', readOnly: true },
    });
    expect(header).toMatchObject({
      kind: 'derived_header',
      metadata: expect.objectContaining({ headerName: 'x-skypetoken', valueDigest: expect.stringMatching(/^sha256:/) }),
    });
    expect(JSON.stringify([mount, header])).not.toContain('secret-skype-header-value');
  });

  it('uses stable fingerprints and sanitizes proxy endpoints', () => {
    const first = createDerivedHeaderArtifactProof('X-SkypeToken', 'same-secret-header', { observedAt: 1 });
    const second = createDerivedHeaderArtifactProof('x-skypetoken', 'same-secret-header', { observedAt: 2 });
    const different = createDerivedHeaderArtifactProof('x-skypetoken', 'other-secret-header', { observedAt: 1 });
    const proxy = createProxyEndpointArtifactProof('https://user:password@proxy.example.test:8443/path?token=secret-query-token', { observedAt: 1 });

    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.fingerprint).not.toBe(different.fingerprint);
    expect(proxy.metadata.endpoint).toBe('https://proxy.example.test:8443/path');
    const serialized = JSON.stringify(proxy);
    expect(serialized).not.toContain('password');
    expect(serialized).not.toContain('secret-query-token');
  });

  it('summarizes propagation transactions across steps and artifact proofs', () => {
    const tokenProof = createTokenBundleArtifactProof(bundle(), { observedAt: 1, now: 1 });
    const mountProof = createVolumeMountArtifactProof({ sourcePath: '/host', containerPath: '/container' }, { observedAt: 2 });
    const headerProof = createDerivedHeaderArtifactProof('x-skypetoken', 'secret-header-for-transaction', { observedAt: 3 });
    const thvSecret = createToolHiveSecretArtifactProof('MS365_TEAMS_TOKEN', { observedAt: 4 });
    const transaction = createPropagationTransaction({
      transactionId: 'tx-ms365-teams-1',
      service: 'ms365',
      scheme: 'teams',
      startedAt: 1,
      finalStatus: 'degraded',
      artifactProofs: [tokenProof, mountProof, headerProof, thvSecret],
      steps: [
        { name: 'write-token-file', status: 'ok', startedAt: 1, completedAt: 2, artifactIds: [tokenProof.artifactId] },
        { name: 'mount-container-volume', status: 'ok', startedAt: 2, completedAt: 3, artifactIds: [mountProof.artifactId] },
        { name: 'derive-skype-header', status: 'degraded', startedAt: 3, completedAt: 4, artifactIds: [headerProof.artifactId] },
      ],
    });

    const summary = summarizePropagationTransaction(transaction);
    expect(summary).toMatchObject({
      transactionId: 'tx-ms365-teams-1',
      finalStatus: 'degraded',
      stepCounts: expect.objectContaining({ ok: 2, degraded: 1, failed: 0 }),
      artifactCounts: expect.objectContaining({ token_bundle: 1, volume_mount: 1, derived_header: 1, thv_secret: 1 }),
      proofStatusCounts: expect.objectContaining({ present: 4, missing: 0 }),
    });
    expect(JSON.stringify(transaction)).not.toContain('secret-header-for-transaction');
  });
});
