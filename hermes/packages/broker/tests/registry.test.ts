import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ServiceRegistry } from '../src/registry.js';
import type { Provider, ProviderContext, TokenBundle } from '../src/types.js';

function fakeProvider(name: string, schemes: string[]): Provider {
  return {
    name, schemes,
    async acquire(ctx: ProviderContext, scheme: string): Promise<TokenBundle> {
      return { service: ctx.service, scheme, accessToken: 'x', tokenType: 'Bearer', expiresAt: Date.now() + 3600_000, acquiredAt: Date.now() };
    },
    async refresh(_c, b) { return b; },
    async validate() { return true; },
    nextRefreshAt: (b) => new Date(b.expiresAt - 300_000),
  };
}

describe('ServiceRegistry', () => {
  let reg: ServiceRegistry; let dir: string;
  const testDirs: string[] = [];
  beforeEach(() => {
    dir = path.join(process.cwd(), '.test-data', `hermes-reg-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    testDirs.push(dir);
    reg = new ServiceRegistry(dir);
  });
  afterEach(() => {
    while (testDirs.length > 0) rmSync(testDirs.pop()!, { recursive: true, force: true });
  });

  it('registers and resolves providers by name', () => {
    reg.installProvider(fakeProvider('ms365', ['graph', 'teams']));
    expect(reg.getProvider('ms365')?.name).toBe('ms365');
    expect(reg.listProviders().map((p) => p.name)).toEqual(['ms365']);
  });
  it('persists services to disk and reloads them', async () => {
    reg.installProvider(fakeProvider('ms365', ['graph']));
    await reg.registerService({
      name: 'ms365',
      providerName: 'ms365',
      schemes: ['graph'],
      config: { loginHint: 'user@example.com' },
      createdAt: Date.now(),
      thvContainerName: 'ms365-thv',
      serviceAliases: ['microsoft-365'],
      backendAliases: ['msgraph-backend'],
      toolhiveContainerAliases: ['ms365-toolhive'],
      gatewayBackendAliases: ['gateway-ms365'],
      userFacingNames: ['Microsoft 365'],
      downstreamAuthProbe: {
        toolName: 'servicenow_get_current_user',
        args: { sysparm_fields: 'user_name' },
        expectedSuccess: { httpStatus: 200, shape: { result: { isError: false } } },
        expectedAuthFailure: { httpStatus: [401, 403] },
        redaction: { redactKeys: ['sessionId'], redactPaths: ['result.secret'] },
      },
      downstreamAuthProbes: [{
        toolName: 'teams_list_chats',
        operation: 'teams.list_chats',
        endpointClass: 'teams_chat_list',
        proofDepth: 'shallow',
        expectedSuccess: { httpStatus: 200 },
      }, {
        toolName: 'teams_get_chat_messages',
        operation: 'teams.read_chat_messages',
        endpointClass: 'teams_chat_messages',
        proofDepth: 'deep',
        required: true,
        expectedSuccess: { httpStatus: 200, minArrayLength: [{ path: 'result.messages', min: 1 }] },
      }],
    });
    const reloaded = new ServiceRegistry(dir);
    reloaded.installProvider(fakeProvider('ms365', ['graph']));
    await reloaded.loadServices();
    expect(reloaded.getService('ms365')?.config.loginHint).toBe('user@example.com');
    expect(reloaded.getService('ms365')?.backendAliases).toEqual(['msgraph-backend']);
    expect(reloaded.resolveServiceName('ms365')).toBe('ms365');
    expect(reloaded.resolveServiceName('ms365-thv')).toBe('ms365');
    expect(reloaded.resolveServiceName('microsoft-365')).toBe('ms365');
    expect(reloaded.resolveServiceName('ms365-toolhive')).toBe('ms365');
    expect(reloaded.resolveServiceName('gateway-ms365')).toBe('ms365');
    expect(reloaded.resolveService('Microsoft 365')?.name).toBe('ms365');
    expect(reloaded.getService('ms365')?.downstreamAuthProbe).toMatchObject({
      toolName: 'servicenow_get_current_user',
      expectedAuthFailure: { httpStatus: [401, 403] },
    });
    expect(reloaded.getService('ms365')?.downstreamAuthProbes).toEqual([
      expect.objectContaining({ toolName: 'teams_list_chats', operation: 'teams.list_chats', proofDepth: 'shallow' }),
      expect.objectContaining({ toolName: 'teams_get_chat_messages', operation: 'teams.read_chat_messages', proofDepth: 'deep', required: true }),
    ]);
  });
  it('rejects service with unknown provider', async () => {
    await expect(reg.registerService({ name: 'foo', providerName: 'nope', schemes: ['x'], config: {}, createdAt: Date.now() })).rejects.toThrow(/PROVIDER_NOT_FOUND|not installed/);
  });
  it('rejects service with unsupported scheme', async () => {
    reg.installProvider(fakeProvider('ms365', ['graph']));
    await expect(reg.registerService({ name: 'ms365', providerName: 'ms365', schemes: ['teams'], config: {}, createdAt: Date.now() })).rejects.toThrow(/scheme/);
  });
  it('rejects service registration with headless: false', async () => {
    reg.installProvider(fakeProvider('ms365', ['graph']));
    await expect(reg.registerService({
      name: 'bad-svc', providerName: 'ms365', schemes: ['graph'],
      config: { headless: false, loginHint: 'test@test.com' }, createdAt: Date.now(),
    })).rejects.toThrow(/headless: false is not allowed/);
  });
  it('allows service registration with headless: true', async () => {
    reg.installProvider(fakeProvider('ms365', ['graph']));
    await expect(reg.registerService({
      name: 'good-svc', providerName: 'ms365', schemes: ['graph'],
      config: { headless: true, loginHint: 'test@test.com' }, createdAt: Date.now(),
    })).resolves.not.toThrow();
  });
  it('rejects ambiguous identity aliases', async () => {
    reg.installProvider(fakeProvider('ms365', ['graph']));
    await reg.registerService({
      name: 'ms365', providerName: 'ms365', schemes: ['graph'],
      config: {}, createdAt: Date.now(), backendAliases: ['shared-backend'],
    });
    await expect(reg.registerService({
      name: 'office365', providerName: 'ms365', schemes: ['graph'],
      config: {}, createdAt: Date.now(), thvContainerName: 'shared-backend',
    })).rejects.toThrow(/ambiguous/);
    expect(reg.resolveServiceName('shared-backend')).toBe('ms365');
    expect(reg.getService('office365')).toBeUndefined();
  });
  it('rejects aliases that conflict with another registered service name', async () => {
    reg.installProvider(fakeProvider('ms365', ['graph']));
    await reg.registerService({ name: 'ms365', providerName: 'ms365', schemes: ['graph'], config: {}, createdAt: Date.now() });
    await expect(reg.registerService({
      name: 'servicenow', providerName: 'ms365', schemes: ['graph'],
      config: {}, createdAt: Date.now(), serviceAliases: ['ms365'],
    })).rejects.toThrow(/conflicts with registered service/);
  });
});
