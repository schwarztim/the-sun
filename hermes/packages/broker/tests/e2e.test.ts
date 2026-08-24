import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { buildHttpServer } from '../src/http-server.js';
import { Broker } from '../src/broker.js';
import { TokenStorage, type KeyringAdapter } from '../src/storage.js';
import { ServiceRegistry } from '../src/registry.js';
import { TokenValidator } from '../src/validator.js';
import { createLogger } from '../src/logger.js';
import type { Provider, TokenBundle } from '../src/types.js';
import type { FastifyInstance } from 'fastify';
import { HermesClient } from '@hermes/client';

class MemKeyring implements KeyringAdapter {
  m = new Map<string, string>();
  async setPassword(s: string, a: string, p: string) { this.m.set(`${s}:${a}`, p); }
  async getPassword(s: string, a: string) { return this.m.get(`${s}:${a}`) ?? null; }
  async deletePassword(s: string, a: string) { return this.m.delete(`${s}:${a}`); }
  async findCredentials(s: string) {
    return Array.from(this.m.entries()).filter(([k]) => k.startsWith(`${s}:`))
      .map(([k, password]) => ({ account: k.slice(s.length + 1), password }));
  }
}

const nullSink = new Writable({ write(_c, _e, cb) { cb(); } });
const logger = createLogger({ level: 'error', stream: nullSink, pretty: false });

const bundle = (): TokenBundle => ({
  service: 'fake', scheme: 'main', accessToken: 'tok', tokenType: 'Bearer',
  expiresAt: Date.now() + 3600_000, acquiredAt: Date.now(),
});

function fakeProvider(): Provider {
  return {
    name: 'fake', schemes: ['main'],
    acquire: vi.fn(async () => bundle()),
    refresh: vi.fn(async (_c, b) => b),
    validate: vi.fn(async () => true),
    nextRefreshAt: (b) => new Date(b.expiresAt - 300_000),
  };
}

describe('e2e: broker + client', () => {
  let app: FastifyInstance;
  afterEach(async () => { if (app) await app.close(); });

  it('client.getToken hits real HTTP server and returns a bundle', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hermes-e2e-'));
    const storage = new TokenStorage(new MemKeyring());
    const registry = new ServiceRegistry(dir);
    registry.installProvider(fakeProvider());
    await registry.registerService({ name: 'fake', providerName: 'fake', schemes: ['main'], config: {}, createdAt: Date.now() });
    const broker = new Broker({ storage, registry, validator: new TokenValidator({ policy: 'eager', safetyMarginSec: 300 }), logger, dataDir: dir });
    const CLIENT_TOKEN = 'integration-test-token';
    app = buildHttpServer({ broker, registry, clientToken: CLIENT_TOKEN, logger });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as any).port;
    const brokerUrl = `http://127.0.0.1:${port}`;

    const client = new HermesClient({ brokerUrl, clientToken: CLIENT_TOKEN });
    const result = await client.getToken('fake', 'main');
    expect(result.accessToken).toBe('tok');

    await expect(
      new HermesClient({ brokerUrl, clientToken: 'wrong' }).getToken('fake', 'main')
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});
