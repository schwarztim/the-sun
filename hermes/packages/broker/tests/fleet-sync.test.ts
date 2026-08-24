import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { GatewayFleetSync } from '../src/fleet-sync.js';
import { createLogger } from '../src/logger.js';

const testDirs: string[] = [];
const nullSink = new Writable({ write(_c, _e, cb) { cb(); } });
const logger = createLogger({ level: 'error', stream: nullSink, pretty: false });

function testDataDir(): string {
  const dir = path.join(process.cwd(), '.test-data', `fleet-sync-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  testDirs.push(dir);
  return dir;
}

function fakeThv(dir: string, body: string): string {
  const script = path.join(dir, 'thv');
  writeFileSync(script, `#!/usr/bin/env node
if (process.argv[2] === 'list') {
${body}
process.exit(0);
}
process.exit(2);
`);
  chmodSync(script, 0o755);
  return script;
}

function okGateway(loaded = 1): ReturnType<typeof vi.fn> {
  return vi.fn(async () => new Response(JSON.stringify({ ingestResult: { loaded } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
}

describe('GatewayFleetSync', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    while (testDirs.length > 0) rmSync(testDirs.pop()!, { recursive: true, force: true });
  });

  it('writes a generated fleet config and records a gateway reload proof', async () => {
    const dir = testDataDir();
    const thvPath = fakeThv(dir, "console.log('NAME TYPE STATUS AGE URL'); console.log('ms365-mcp mcp running 1s http://127.0.0.1:4444/mcp'); console.log('old-mcp mcp stopped 1s http://127.0.0.1:5555/mcp');");
    const configPath = path.join(dir, 'config.generated.json');
    const fetchMock = okGateway(1);
    vi.stubGlobal('fetch', fetchMock);
    const sync = new GatewayFleetSync({ logger, thvPath, configPath, gatewayUrl: 'http://gateway.local' });

    const result = await sync.syncNow();

    expect(result).toMatchObject({
      changed: true,
      backends: 1,
      configPath,
      containerNames: ['ms365-mcp'],
      gatewayReload: { status: 'ok', loaded: 1, httpStatus: 200 },
    });
    expect(fetchMock).toHaveBeenCalledWith('http://gateway.local/admin/fleet/reload', expect.objectContaining({ method: 'POST' }));
    expect(sync.status()).toMatchObject({
      backendCount: 1,
      gatewayReachable: true,
      gatewayBackends: 1,
      lastContainerNames: ['ms365-mcp'],
      lastGatewayReloadStatus: 'ok',
      lastGatewayReloadStatusCode: 200,
    });
  });

  it('can force a gateway reload even when the generated config hash is unchanged', async () => {
    const dir = testDataDir();
    const thvPath = fakeThv(dir, "console.log('NAME TYPE STATUS AGE URL'); console.log('ms365-mcp mcp running 1s http://127.0.0.1:4444/mcp');");
    const fetchMock = okGateway(1);
    vi.stubGlobal('fetch', fetchMock);
    const sync = new GatewayFleetSync({ logger, thvPath, configPath: path.join(dir, 'config.generated.json') });

    await sync.syncNow();
    const result = await sync.syncNow({ forceReload: true });

    expect(result.changed).toBe(false);
    expect(result.gatewayReload.status).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('records degraded gateway reload and ToolHive inventory failures in status', async () => {
    const dir = testDataDir();
    const nonOkThv = fakeThv(dir, "console.log('NAME TYPE STATUS AGE URL'); console.log('ms365-mcp mcp running 1s http://127.0.0.1:4444/mcp');");
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad', { status: 503 })));
    const sync = new GatewayFleetSync({ logger, thvPath: nonOkThv, configPath: path.join(dir, 'config.generated.json') });

    const result = await sync.syncNow();
    expect(result.gatewayReload).toMatchObject({ status: 'non_ok', httpStatus: 503 });
    expect(sync.status()).toMatchObject({ gatewayReachable: true, lastGatewayReloadStatus: 'non_ok', lastGatewayReloadStatusCode: 503 });

    const failingThv = fakeThv(dir, "console.error('thv inventory failed'); process.exit(7);");
    const failingSync = new GatewayFleetSync({ logger, thvPath: failingThv, configPath: path.join(dir, 'other-config.generated.json') });
    await expect(failingSync.syncNow()).rejects.toThrow();
    expect(failingSync.status().lastSyncError).toContain('Command failed');
  });
});
