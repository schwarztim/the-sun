import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { LifecycleStateStore } from '../src/lifecycle-state.js';
import { createLogger } from '../src/logger.js';
import { authenticatedProbeMcp, propagateTokenToToolHive } from '../src/token-propagation.js';
import type { ServiceRegistry } from '../src/registry.js';
import type { DownstreamAuthProbeConfig, TokenBundle } from '../src/types.js';

const testDirs: string[] = [];
const nullSink = new Writable({ write(_c, _e, cb) { cb(); } });
const logger = createLogger({ level: 'error', stream: nullSink, pretty: false });

function testDataDir(): string {
  const dir = path.join(process.cwd(), '.test-data', `token-propagation-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  testDirs.push(dir);
  return dir;
}

const authProbeConfig: DownstreamAuthProbeConfig = {
  toolName: 'servicenow_get_current_user',
  args: { sysparm_fields: 'user_name' },
  expectedSuccess: { httpStatus: 200, shape: { result: { isError: false } } },
  expectedAuthFailure: { httpStatus: [401, 403] },
  redaction: { redactKeys: ['sessionId'], redactPaths: ['body.error.data.debug'] },
};

function registry(opts: { thv?: boolean; downstreamAuthProbe?: DownstreamAuthProbeConfig; downstreamAuthProbes?: DownstreamAuthProbeConfig[] } = { thv: true }): ServiceRegistry {
  return {
    getService: vi.fn(() => ({
      name: 'ms365',
      providerName: 'ms365',
      schemes: ['graph'],
      config: {},
      createdAt: 1,
      ...(opts.thv !== false ? { thvSecretPrefix: 'MS365', thvContainerName: 'ms365-mcp' } : {}),
      ...(opts.downstreamAuthProbe ? { downstreamAuthProbe: opts.downstreamAuthProbe } : {}),
      ...(opts.downstreamAuthProbes ? { downstreamAuthProbes: opts.downstreamAuthProbes } : {}),
    })),
  } as unknown as ServiceRegistry;
}

function bundle(): TokenBundle {
  return {
    service: 'ms365',
    scheme: 'graph',
    accessToken: 'secret-access-token',
    refreshToken: 'secret-refresh-token',
    tokenType: 'Bearer',
    expiresAt: 1_700_004_000_000,
    acquiredAt: 1_700_000_000_000,
  };
}

describe('ToolHive token propagation proof', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    while (testDirs.length > 0) rmSync(testDirs.pop()!, { recursive: true, force: true });
  });

  it('records secret write, restart readiness, fleet reload, and smoke probe success', async () => {
    const lifecycleStore = new LifecycleStateStore(testDataDir());
    const thvStorage = {
      writeToken: vi.fn(async (secretName: string, token: TokenBundle) => ({
        secretName,
        writtenAt: 1_700_000_001_000,
        tokenType: token.tokenType,
        expiresAt: token.expiresAt,
        hasRefreshToken: Boolean(token.refreshToken),
      })),
      restartContainer: vi.fn(async (containerName: string) => ({
        containerName,
        restartedAt: 1_700_000_002_000,
        readyAt: 1_700_000_003_000,
        url: 'http://127.0.0.1:12345/mcp',
      })),
    };
    const fleetSync = {
      syncNow: vi.fn(async () => ({
        changed: true,
        backends: 1,
        configHash: 'abc123',
        configPath: '.test-data/config.generated.json',
        containerNames: ['ms365-mcp'],
        gatewayReload: { status: 'ok' as const, at: 1_700_000_004_000, loaded: 1, httpStatus: 200 },
      })),
    };
    const smokeProbe = vi.fn(async () => ({
      initialized: true,
      sessionEstablished: true,
      toolsListed: true,
      toolCount: 7,
    }));
    const authenticatedProbe = vi.fn(async () => ({
      toolName: 'servicenow_get_current_user',
      success: true,
      authFailure: false,
      httpStatus: 200,
      evidence: { result: { isError: false } },
    }));

    const result = await propagateTokenToToolHive(bundle(), {
      registry: registry({ downstreamAuthProbe: authProbeConfig }),
      thvStorage,
      fleetSync,
      lifecycleStore,
      logger,
      smokeProbe,
      authenticatedProbe,
      now: () => 1_700_000_010_000,
    });

    expect(result.status).toBe('ok');
    expect(thvStorage.writeToken).toHaveBeenCalledWith('MS365_GRAPH_TOKEN', expect.objectContaining({ service: 'ms365' }));
    expect(thvStorage.restartContainer).toHaveBeenCalledWith('ms365-mcp');
    expect(fleetSync.syncNow).toHaveBeenCalledWith({ forceReload: true });
    expect(smokeProbe).toHaveBeenCalledWith('http://127.0.0.1:12345/mcp');
    expect(authenticatedProbe).toHaveBeenCalledWith('http://127.0.0.1:12345/mcp', authProbeConfig);
    expect(await lifecycleStore.get('ms365', 'graph')).toMatchObject({
      propagationStatus: 'ok',
      proofTier: 'mcp_validated',
      proofState: 'valid',
      proofEvents: expect.arrayContaining([
        expect.objectContaining({ tier: 'propagated', status: 'valid' }),
        expect.objectContaining({ tier: 'mcp_validated', status: 'valid' }),
      ]),
      propagationEvents: [
        expect.objectContaining({
          step: 'secret_write',
          status: 'ok',
          metadata: expect.objectContaining({
            secretName: 'MS365_GRAPH_TOKEN',
            acquiredAt: 1_700_000_000_000,
            tokenAgeAtPropagationMs: 1_000,
          }),
        }),
        expect.objectContaining({ step: 'container_restart', status: 'ok', metadata: expect.objectContaining({ containerName: 'ms365-mcp' }) }),
        expect.objectContaining({ step: 'container_readiness', status: 'ok', metadata: expect.objectContaining({ url: 'http://127.0.0.1:12345/mcp' }) }),
        expect.objectContaining({ step: 'fleet_sync', status: 'ok', metadata: expect.objectContaining({ backends: 1, configHash: 'abc123' }) }),
        expect.objectContaining({ step: 'gateway_reload', status: 'ok', metadata: expect.objectContaining({ loaded: 1 }) }),
        expect.objectContaining({ step: 'downstream_smoke_probe', status: 'ok', metadata: expect.objectContaining({ toolCount: 7 }) }),
        expect.objectContaining({ step: 'downstream_auth_probe', status: 'ok', metadata: expect.objectContaining({ toolName: 'servicenow_get_current_user' }) }),
      ],
    });
    expect(JSON.stringify(await lifecycleStore.get('ms365', 'graph'))).not.toContain('secret-access-token');
  });

  it('marks fleet and smoke failures as degraded without hiding completed THV steps', async () => {
    const lifecycleStore = new LifecycleStateStore(testDataDir());
    const thvStorage = {
      writeToken: vi.fn(async (secretName: string, token: TokenBundle) => ({
        secretName,
        writtenAt: 1,
        tokenType: token.tokenType,
        expiresAt: token.expiresAt,
        hasRefreshToken: true,
      })),
      restartContainer: vi.fn(async (containerName: string) => ({
        containerName,
        restartedAt: 2,
        readyAt: 3,
        url: 'http://127.0.0.1:12345/mcp',
      })),
    };

    const result = await propagateTokenToToolHive(bundle(), {
      registry: registry(),
      thvStorage,
      fleetSync: { syncNow: vi.fn(async () => { throw new Error('gateway Bearer bad-token unavailable'); }) },
      lifecycleStore,
      logger,
      smokeProbe: vi.fn(async () => { throw new Error('tools/list HTTP 500'); }),
      now: () => 10,
    });

    expect(result.status).toBe('degraded');
    expect(await lifecycleStore.get('ms365', 'graph')).toMatchObject({
      propagationStatus: 'degraded',
      proofTier: 'propagated',
      proofState: 'degraded',
      proofEvents: expect.arrayContaining([
        expect.objectContaining({ tier: 'propagated', status: 'degraded' }),
        expect.objectContaining({ tier: 'mcp_validated', status: 'skipped' }),
      ]),
      propagationEvents: expect.arrayContaining([
        expect.objectContaining({ step: 'secret_write', status: 'ok' }),
        expect.objectContaining({ step: 'container_readiness', status: 'ok' }),
        expect.objectContaining({ step: 'fleet_sync', status: 'failed', error: 'gateway Bearer [redacted] unavailable' }),
        expect.objectContaining({ step: 'downstream_smoke_probe', status: 'degraded', error: 'tools/list HTTP 500' }),
        expect.objectContaining({ step: 'downstream_auth_probe', status: 'skipped' }),
      ]),
    });
  });

  it('degrades proof and records CA-1 auth failure feedback when authenticated probe returns 401', async () => {
    const lifecycleStore = new LifecycleStateStore(testDataDir());
    const thvStorage = {
      writeToken: vi.fn(async (secretName: string, token: TokenBundle) => ({
        secretName,
        writtenAt: 1,
        tokenType: token.tokenType,
        expiresAt: token.expiresAt,
        hasRefreshToken: true,
      })),
      restartContainer: vi.fn(async (containerName: string) => ({
        containerName,
        restartedAt: 2,
        readyAt: 3,
        url: 'http://127.0.0.1:12345/mcp',
      })),
    };
    const authenticatedProbe = vi.fn(async () => ({
      toolName: 'servicenow_get_current_user',
      success: false,
      authFailure: true,
      httpStatus: 401,
      failureCode: 'unauthorized',
      message: 'User Not Authenticated Bearer leaked-token',
      evidence: {
        httpStatus: 401,
        body: {
          error: { message: 'User Not Authenticated', data: { debug: 'secret-debug-token' } },
          sessionId: 'secret-session',
        },
      },
    }));

    const result = await propagateTokenToToolHive(bundle(), {
      registry: registry({ downstreamAuthProbe: authProbeConfig }),
      thvStorage,
      fleetSync: { syncNow: vi.fn(async () => ({ changed: false, backends: 1, configHash: 'hash', configPath: '.test-data/config.generated.json', containerNames: ['ms365-mcp'], gatewayReload: { status: 'ok' as const, at: 4, loaded: 1, httpStatus: 200 } })) },
      lifecycleStore,
      logger,
      smokeProbe: vi.fn(async () => ({ initialized: true, sessionEstablished: true, toolsListed: true, toolCount: 1 })),
      authenticatedProbe,
      now: () => 10,
    });

    expect(result.status).toBe('degraded');
    const state = await lifecycleStore.get('ms365', 'graph');
    expect(state).toMatchObject({
      propagationStatus: 'degraded',
      credentialStatus: 'suspect',
      lastErrorCode: 'CONSUMER_AUTH_FAILURE',
      proofTier: 'propagated',
      proofState: 'degraded',
      proofEvents: expect.arrayContaining([
        expect.objectContaining({ tier: 'mcp_validated', status: 'degraded' }),
      ]),
      consumerAuthFailures: [
        expect.objectContaining({
          httpStatus: 401,
          failureCode: 'unauthorized',
          backend: 'ms365-mcp',
          tool: 'servicenow_get_current_user',
          endpointClass: 'mcp_tool',
        }),
      ],
      propagationEvents: expect.arrayContaining([
        expect.objectContaining({
          step: 'downstream_auth_probe',
          status: 'degraded',
          metadata: expect.objectContaining({ authFailure: true, httpStatus: 401 }),
        }),
      ]),
    });
    const serialized = JSON.stringify(state);
    expect(serialized).not.toContain('leaked-token');
    expect(serialized).not.toContain('secret-session');
    expect(serialized).not.toContain('secret-debug-token');
  });

  it('runs multi-probe operation contracts and degrades mcp validation when required deep proof fails', async () => {
    const lifecycleStore = new LifecycleStateStore(testDataDir());
    const shallowProbe: DownstreamAuthProbeConfig = {
      toolName: 'teams_list_chats',
      operation: 'teams.list_chats',
      endpointClass: 'teams_chat_list',
      proofDepth: 'shallow',
      expectedSuccess: { httpStatus: 200 },
    };
    const deepProbe: DownstreamAuthProbeConfig = {
      toolName: 'teams_get_chat_messages',
      args: { chatId: 'chat-1' },
      operation: 'teams.read_chat_messages',
      endpointClass: 'teams_chat_messages',
      proofDepth: 'deep',
      required: true,
      expectedSuccess: { httpStatus: 200, minArrayLength: [{ path: 'result.messages', min: 1 }] },
      expectedAuthFailure: { httpStatus: [401, 403] },
    };
    const authenticatedProbe = vi.fn(async (_url: string, probe: DownstreamAuthProbeConfig) => probe.toolName === 'teams_list_chats'
      ? { toolName: probe.toolName, success: true, authFailure: false, httpStatus: 200, evidence: { result: { chats: [{}] } } }
      : { toolName: probe.toolName, success: false, authFailure: true, httpStatus: 401, failureCode: '911', message: 'Teams 401 errorCode 911', evidence: { errorCode: 911 } });

    const result = await propagateTokenToToolHive(bundle(), {
      registry: registry({ downstreamAuthProbes: [shallowProbe, deepProbe] }),
      thvStorage: {
        writeToken: vi.fn(async (secretName, token) => ({ secretName, writtenAt: 1, tokenType: token.tokenType, expiresAt: token.expiresAt, hasRefreshToken: true })),
        restartContainer: vi.fn(async (containerName) => ({ containerName, restartedAt: 2, readyAt: 3, url: 'http://127.0.0.1:12345/mcp' })),
      },
      fleetSync: { syncNow: vi.fn(async () => ({ changed: false, backends: 1, configHash: 'hash', configPath: '.test-data/config.generated.json', containerNames: ['ms365-mcp'], gatewayReload: { status: 'ok' as const, at: 4, loaded: 1, httpStatus: 200 } })) },
      lifecycleStore,
      logger,
      smokeProbe: vi.fn(async () => ({ initialized: true, sessionEstablished: true, toolsListed: true, toolCount: 2 })),
      authenticatedProbe,
      now: () => 10,
    });

    expect(result.status).toBe('degraded');
    expect(authenticatedProbe).toHaveBeenCalledTimes(2);
    expect(await lifecycleStore.get('ms365', 'graph')).toMatchObject({
      proofTier: 'propagated',
      proofState: 'degraded',
      proofEvents: expect.arrayContaining([expect.objectContaining({ tier: 'mcp_validated', status: 'degraded' })]),
      propagationEvents: expect.arrayContaining([
        expect.objectContaining({ step: 'downstream_auth_probe', status: 'ok', metadata: expect.objectContaining({ operation: 'teams.list_chats', proofDepth: 'shallow' }) }),
        expect.objectContaining({ step: 'downstream_auth_probe', status: 'degraded', metadata: expect.objectContaining({ operation: 'teams.read_chat_messages', endpointClass: 'teams_chat_messages', required: true, authFailure: true }) }),
      ]),
    });
  });

  it('does not mark mcp validation healthy when required deep proof is skipped', async () => {
    const lifecycleStore = new LifecycleStateStore(testDataDir());
    const deepProbe: DownstreamAuthProbeConfig = {
      toolName: 'teams_get_chat_messages',
      operation: 'teams.read_chat_messages',
      endpointClass: 'teams_chat_messages',
      proofDepth: 'deep',
      required: true,
    };

    const result = await propagateTokenToToolHive(bundle(), {
      registry: registry({ downstreamAuthProbes: [deepProbe] }),
      thvStorage: {
        writeToken: vi.fn(async (secretName, token) => ({ secretName, writtenAt: 1, tokenType: token.tokenType, expiresAt: token.expiresAt, hasRefreshToken: true })),
        restartContainer: vi.fn(async (containerName) => ({ containerName, restartedAt: 2, readyAt: 3, url: 'http://127.0.0.1:12345/mcp' })),
      },
      fleetSync: { syncNow: vi.fn(async () => ({ changed: false, backends: 1, configHash: 'hash', configPath: '.test-data/config.generated.json', containerNames: ['ms365-mcp'], gatewayReload: { status: 'ok' as const, at: 4, loaded: 1, httpStatus: 200 } })) },
      lifecycleStore,
      logger,
      smokeProbe: vi.fn(async () => ({ initialized: true, sessionEstablished: true, toolsListed: false, toolCount: 0 })),
      authenticatedProbe: vi.fn(),
      now: () => 10,
    });

    expect(result.status).toBe('degraded');
    expect(await lifecycleStore.get('ms365', 'graph')).toMatchObject({
      proofState: 'degraded',
      proofEvents: expect.arrayContaining([expect.objectContaining({ tier: 'mcp_validated', status: 'degraded' })]),
      propagationEvents: expect.arrayContaining([
        expect.objectContaining({ step: 'downstream_auth_probe', status: 'skipped', metadata: expect.objectContaining({ required: true, proofDepth: 'deep' }) }),
      ]),
    });
  });

  it('fails success-shaped empty results when a non-empty array proof is required', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 200, headers: { 'mcp-session-id': 'session-1' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: { messages: [] } }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);

    const result = await authenticatedProbeMcp('http://127.0.0.1:12345/mcp', {
      toolName: 'teams_get_chat_messages',
      expectedSuccess: { httpStatus: 200, shape: { result: {} }, minArrayLength: [{ path: 'result.messages', min: 1 }] },
    });

    expect(result).toMatchObject({ success: false, authFailure: false, httpStatus: 200 });
  });

  it('does not overclaim mcp_validated when no authenticated probe is configured', async () => {
    const lifecycleStore = new LifecycleStateStore(testDataDir());
    const thvStorage = {
      writeToken: vi.fn(async (secretName: string, token: TokenBundle) => ({
        secretName,
        writtenAt: 1,
        tokenType: token.tokenType,
        expiresAt: token.expiresAt,
        hasRefreshToken: true,
      })),
      restartContainer: vi.fn(async (containerName: string) => ({
        containerName,
        restartedAt: 2,
        readyAt: 3,
        url: 'http://127.0.0.1:12345/mcp',
      })),
    };

    const result = await propagateTokenToToolHive(bundle(), {
      registry: registry(),
      thvStorage,
      fleetSync: { syncNow: vi.fn(async () => ({ changed: false, backends: 1, configHash: 'hash', configPath: '.test-data/config.generated.json', containerNames: ['ms365-mcp'], gatewayReload: { status: 'ok' as const, at: 4, loaded: 1, httpStatus: 200 } })) },
      lifecycleStore,
      logger,
      smokeProbe: vi.fn(async () => ({ initialized: true, sessionEstablished: true, toolsListed: true, toolCount: 1 })),
      now: () => 10,
    });

    expect(result.status).toBe('ok');
    expect(await lifecycleStore.get('ms365', 'graph')).toMatchObject({
      propagationStatus: 'ok',
      proofTier: 'propagated',
      proofState: 'valid',
      proofEvents: expect.arrayContaining([
        expect.objectContaining({ tier: 'propagated', status: 'valid' }),
        expect.objectContaining({ tier: 'mcp_validated', status: 'skipped' }),
      ]),
      propagationEvents: expect.arrayContaining([
        expect.objectContaining({
          step: 'downstream_auth_probe',
          status: 'skipped',
          message: expect.stringContaining('transport readiness does not prove credential validity'),
        }),
      ]),
    });
  });

  it('records and rethrows critical secret write failures', async () => {
    const lifecycleStore = new LifecycleStateStore(testDataDir());
    const thvStorage = {
      writeToken: vi.fn(async () => { throw new Error('secret set failed accessToken=bad'); }),
      restartContainer: vi.fn(),
    };

    await expect(propagateTokenToToolHive(bundle(), {
      registry: registry(),
      thvStorage,
      lifecycleStore,
      logger,
      now: () => 10,
    })).rejects.toThrow(/secret set failed/);

    expect(thvStorage.restartContainer).not.toHaveBeenCalled();
    expect(await lifecycleStore.get('ms365', 'graph')).toMatchObject({
      propagationStatus: 'failed',
      proofTier: 'propagated',
      proofState: 'failed',
      proofEvents: expect.arrayContaining([
        expect.objectContaining({ tier: 'propagated', status: 'failed' }),
      ]),
      lastPropagationError: 'secret set failed accessToken=[redacted]',
      propagationEvents: [expect.objectContaining({
        step: 'secret_write',
        status: 'failed',
        error: 'secret set failed accessToken=[redacted]',
      })],
    });
  });
});
