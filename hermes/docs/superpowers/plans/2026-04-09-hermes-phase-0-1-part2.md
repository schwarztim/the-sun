# Hermes Phase 0+1 Plan — Part 2 (Tasks 9–17)

Continued from `2026-04-09-hermes-phase-0-1.md`.

---

### Task 9: TokenValidator

**Files:**
- Create: `~/Projects/hermes/packages/broker/src/validator.ts`
- Create: `~/Projects/hermes/packages/broker/tests/validator.test.ts`

**Rationale:** Closes the "cached but actually invalid" gap. Runs a real provider.validate() call before returning cached tokens under the eager/paranoid policies.

- [ ] **Step 1: Write failing tests**

Create `~/Projects/hermes/packages/broker/tests/validator.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { TokenValidator } from '../src/validator.js';
import type { Provider, TokenBundle } from '../src/types.js';

const now = () => Date.now();
const bundle = (overrides: Partial<TokenBundle> = {}): TokenBundle => ({
  service: 'ms365', scheme: 'graph', accessToken: 'x', tokenType: 'Bearer',
  expiresAt: now() + 3600_000, acquiredAt: now() - 60_000, ...overrides,
});

function mockProvider(validateResult: boolean | Error): Provider {
  return {
    name: 'ms365',
    schemes: ['graph'],
    acquire: async () => bundle(),
    refresh: async (_c, b) => b,
    validate: async () => {
      if (validateResult instanceof Error) throw validateResult;
      return validateResult;
    },
    nextRefreshAt: (b) => new Date(b.expiresAt - 300_000),
  };
}

const ctx = {
  service: 'ms365', config: {}, dataDir: '/tmp/hermes',
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
};

describe('TokenValidator', () => {
  it('lazy policy returns true without calling validate on fresh cache', async () => {
    const v = new TokenValidator({ policy: 'lazy', safetyMarginSec: 300 });
    expect(await v.isFresh(mockProvider(false), ctx, bundle(), { cacheAge: 5 })).toBe(true);
  });

  it('eager policy calls validate after threshold', async () => {
    const v = new TokenValidator({ policy: 'eager', safetyMarginSec: 300 });
    expect(await v.isFresh(mockProvider(true), ctx, bundle(), { cacheAge: 120 })).toBe(true);
  });

  it('eager policy returns false when provider.validate returns false', async () => {
    const v = new TokenValidator({ policy: 'eager', safetyMarginSec: 300 });
    expect(await v.isFresh(mockProvider(false), ctx, bundle(), { cacheAge: 120 })).toBe(false);
  });

  it('paranoid policy validates even on fresh cache', async () => {
    const v = new TokenValidator({ policy: 'paranoid', safetyMarginSec: 300 });
    expect(await v.isFresh(mockProvider(true), ctx, bundle(), { cacheAge: 1 })).toBe(true);
  });

  it('returns false when token is within safety margin regardless of policy', async () => {
    const v = new TokenValidator({ policy: 'lazy', safetyMarginSec: 300 });
    const expiring = bundle({ expiresAt: now() + 60_000 });
    expect(await v.isFresh(mockProvider(true), ctx, expiring, { cacheAge: 1 })).toBe(false);
  });

  it('treats provider.validate errors as invalid', async () => {
    const v = new TokenValidator({ policy: 'eager', safetyMarginSec: 300 });
    expect(
      await v.isFresh(mockProvider(new Error('net down')), ctx, bundle(), { cacheAge: 120 })
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run test — expect failure**

Run:
```bash
cd ~/Projects/hermes/packages/broker
pnpm test validator
```

Expected: FAIL.

- [ ] **Step 3: Implement validator.ts**

Create `~/Projects/hermes/packages/broker/src/validator.ts`:

```typescript
import type { Provider, ProviderContext, TokenBundle } from './types.js';

export type ValidationPolicy = 'eager' | 'lazy' | 'paranoid';

export interface ValidatorOptions {
  policy: ValidationPolicy;
  safetyMarginSec: number;
  eagerThresholdSec?: number;
}

export interface FreshnessQuery {
  cacheAge: number;
}

const DEFAULT_EAGER_THRESHOLD = 60;

export class TokenValidator {
  constructor(private readonly opts: ValidatorOptions) {}

  async isFresh(
    provider: Provider,
    ctx: ProviderContext,
    bundle: TokenBundle,
    query: FreshnessQuery
  ): Promise<boolean> {
    const msLeft = bundle.expiresAt - Date.now();
    if (msLeft <= this.opts.safetyMarginSec * 1000) return false;

    const threshold = this.opts.eagerThresholdSec ?? DEFAULT_EAGER_THRESHOLD;
    const needsValidate =
      this.opts.policy === 'paranoid' ||
      (this.opts.policy === 'eager' && query.cacheAge >= threshold);

    if (!needsValidate) return true;

    try {
      return await provider.validate(ctx, bundle);
    } catch (err) {
      ctx.logger.warn('provider.validate threw', {
        service: ctx.service, error: (err as Error).message,
      });
      return false;
    }
  }
}
```

- [ ] **Step 4: Run test — expect pass**

Run:
```bash
cd ~/Projects/hermes/packages/broker
pnpm test validator
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

Run:
```bash
cd ~/Projects/hermes
git add packages/broker
git commit -m "phase-1: add TokenValidator with eager/lazy/paranoid policies"
```

---

### Task 10: Broker core

**Files:**
- Create: `~/Projects/hermes/packages/broker/src/broker.ts`
- Create: `~/Projects/hermes/packages/broker/tests/broker.test.ts`

Ties storage + registry + validator + mutex together. `getToken()` is the single entrypoint every caller goes through.

- [ ] **Step 1: Write failing tests**

Create `~/Projects/hermes/packages/broker/tests/broker.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { Broker } from '../src/broker.js';
import { TokenStorage, type KeyringAdapter } from '../src/storage.js';
import { TokenValidator } from '../src/validator.js';
import { ServiceRegistry } from '../src/registry.js';
import { createLogger } from '../src/logger.js';
import type { Provider, TokenBundle } from '../src/types.js';

class MemKeyring implements KeyringAdapter {
  m = new Map<string, string>();
  async setPassword(s: string, a: string, p: string) { this.m.set(`${s}:${a}`, p); }
  async getPassword(s: string, a: string) { return this.m.get(`${s}:${a}`) ?? null; }
  async deletePassword(s: string, a: string) { return this.m.delete(`${s}:${a}`); }
  async findCredentials(s: string) {
    return Array.from(this.m.entries())
      .filter(([k]) => k.startsWith(`${s}:`))
      .map(([k, password]) => ({ account: k.slice(s.length + 1), password }));
  }
}

const nullSink = new Writable({ write(_c, _e, cb) { cb(); } });
const logger = createLogger({ level: 'error', stream: nullSink, pretty: false });

const fakeBundle = (overrides: Partial<TokenBundle> = {}): TokenBundle => ({
  service: 'ms365', scheme: 'graph', accessToken: 'abc', tokenType: 'Bearer',
  expiresAt: Date.now() + 3600_000, acquiredAt: Date.now(), ...overrides,
});

function fakeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    name: 'ms365',
    schemes: ['graph'],
    acquire: vi.fn(async () => fakeBundle()),
    refresh: vi.fn(async (_c, b) => ({ ...b, accessToken: b.accessToken + '+refreshed' })),
    validate: vi.fn(async () => true),
    nextRefreshAt: (b) => new Date(b.expiresAt - 300_000),
    ...overrides,
  };
}

async function makeBroker(provider: Provider) {
  const dir = mkdtempSync(path.join(tmpdir(), 'hermes-broker-'));
  const storage = new TokenStorage(new MemKeyring());
  const registry = new ServiceRegistry(dir);
  registry.installProvider(provider);
  await registry.registerService({
    name: 'ms365', providerName: 'ms365', schemes: ['graph'],
    config: {}, createdAt: Date.now(),
  });
  const validator = new TokenValidator({ policy: 'eager', safetyMarginSec: 300 });
  return {
    broker: new Broker({ storage, registry, validator, logger, dataDir: dir }),
    storage,
  };
}

describe('Broker.getToken', () => {
  it('acquires when nothing is cached', async () => {
    const p = fakeProvider();
    const { broker } = await makeBroker(p);
    const token = await broker.getToken('ms365', 'graph');
    expect(token.accessToken).toBe('abc');
    expect(p.acquire).toHaveBeenCalledOnce();
  });

  it('returns cached token when fresh and valid', async () => {
    const p = fakeProvider();
    const { broker } = await makeBroker(p);
    await broker.getToken('ms365', 'graph');
    await broker.getToken('ms365', 'graph');
    expect(p.acquire).toHaveBeenCalledOnce();
  });

  it('refreshes when validate returns false', async () => {
    let call = 0;
    const p = fakeProvider({
      validate: vi.fn(async () => { call++; return call > 1; }),
    });
    const { broker, storage } = await makeBroker(p);
    await storage.set(fakeBundle({ acquiredAt: Date.now() - 120_000 }));
    const token = await broker.getToken('ms365', 'graph');
    expect(p.refresh).toHaveBeenCalledOnce();
    expect(token.accessToken).toContain('refreshed');
  });

  it('falls back to acquire when refresh throws', async () => {
    const p = fakeProvider({
      validate: vi.fn(async () => false),
      refresh: vi.fn(async () => { throw new Error('refresh dead'); }),
    });
    const { broker, storage } = await makeBroker(p);
    await storage.set(fakeBundle({ acquiredAt: Date.now() - 120_000 }));
    const token = await broker.getToken('ms365', 'graph');
    expect(p.acquire).toHaveBeenCalledOnce();
    expect(token.accessToken).toBe('abc');
  });

  it('coalesces concurrent getToken calls', async () => {
    let acquires = 0;
    const p = fakeProvider({
      acquire: vi.fn(async () => {
        acquires++;
        await new Promise((r) => setTimeout(r, 30));
        return fakeBundle();
      }),
    });
    const { broker } = await makeBroker(p);
    await Promise.all([
      broker.getToken('ms365', 'graph'),
      broker.getToken('ms365', 'graph'),
      broker.getToken('ms365', 'graph'),
    ]);
    expect(acquires).toBe(1);
  });

  it('throws SERVICE_NOT_REGISTERED for unknown service', async () => {
    const { broker } = await makeBroker(fakeProvider());
    await expect(broker.getToken('nope', 'graph')).rejects.toThrow(/SERVICE_NOT_REGISTERED/);
  });
});
```

- [ ] **Step 2: Run test — expect failure**

Run:
```bash
cd ~/Projects/hermes/packages/broker
pnpm test broker
```

Expected: FAIL.

- [ ] **Step 3: Implement broker.ts**

Create `~/Projects/hermes/packages/broker/src/broker.ts`:

```typescript
import { KeyedMutex } from './mutex.js';
import { HermesError, HermesErrorCode } from './errors.js';
import type { Logger } from './logger.js';
import type { TokenStorage } from './storage.js';
import type { TokenValidator } from './validator.js';
import type { ServiceRegistry } from './registry.js';
import type { Provider, ProviderContext, TokenBundle } from './types.js';

export interface BrokerDeps {
  storage: TokenStorage;
  registry: ServiceRegistry;
  validator: TokenValidator;
  logger: Logger;
  dataDir: string;
}

export interface GetTokenOptions {
  force?: boolean;
}

export class Broker {
  private readonly mutex = new KeyedMutex();

  constructor(private readonly deps: BrokerDeps) {}

  async getToken(
    service: string,
    scheme: string,
    opts: GetTokenOptions = {}
  ): Promise<TokenBundle> {
    const key = `${service}:${scheme}`;
    return this.mutex.runDedup(key, () =>
      this.fetchLocked(service, scheme, opts.force ?? false)
    );
  }

  async listServices(): Promise<string[]> {
    return this.deps.registry.listServices().map((s) => s.name);
  }

  private ctx(service: string, providerConfig: Record<string, unknown>): ProviderContext {
    return {
      service,
      config: providerConfig,
      dataDir: this.deps.dataDir,
      logger: this.deps.logger.child({ component: 'provider', service }),
    };
  }

  private async fetchLocked(
    service: string,
    scheme: string,
    force: boolean
  ): Promise<TokenBundle> {
    const registration = this.deps.registry.getService(service);
    if (!registration) {
      throw new HermesError(
        HermesErrorCode.SERVICE_NOT_REGISTERED,
        `service ${service} is not registered`,
        { remediation: `register the service first` }
      );
    }
    const provider = this.deps.registry.getProvider(registration.providerName);
    if (!provider) {
      throw new HermesError(
        HermesErrorCode.PROVIDER_NOT_FOUND,
        `provider ${registration.providerName} for service ${service} is not installed`
      );
    }
    const ctx = this.ctx(service, registration.config);

    if (!force) {
      const cached = await this.deps.storage.get(service, scheme);
      if (cached) {
        const age = Math.max(0, Math.floor((Date.now() - cached.acquiredAt) / 1000));
        const fresh = await this.deps.validator.isFresh(provider, ctx, cached, { cacheAge: age });
        if (fresh) return cached;
        this.deps.logger.info('cached token stale, refreshing', { service, scheme });
        try {
          const refreshed = await provider.refresh(ctx, cached);
          await this.deps.storage.set(refreshed);
          return refreshed;
        } catch (err) {
          this.deps.logger.warn('provider refresh failed, falling back to acquire', {
            service, error: (err as Error).message,
          });
        }
      }
    }

    return this.acquireAndStore(provider, ctx, service, scheme);
  }

  private async acquireAndStore(
    provider: Provider, ctx: ProviderContext, service: string, scheme: string
  ): Promise<TokenBundle> {
    try {
      const bundle = await provider.acquire(ctx, scheme);
      await this.deps.storage.set(bundle);
      return bundle;
    } catch (err) {
      throw new HermesError(
        HermesErrorCode.ACQUIRE_REQUIRED,
        `acquire failed for ${service}:${scheme}: ${(err as Error).message}`,
        { cause: err, remediation: `run interactive acquire for ${service}` }
      );
    }
  }
}
```

- [ ] **Step 4: Run test — expect pass**

Run:
```bash
cd ~/Projects/hermes/packages/broker
pnpm test broker
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

Run:
```bash
cd ~/Projects/hermes
git add packages/broker
git commit -m "phase-1: add Broker.getToken with mutex, validate, refresh, acquire"
```

---

### Task 11: RefreshScheduler

**Files:**
- Create: `~/Projects/hermes/packages/broker/src/scheduler.ts`
- Create: `~/Projects/hermes/packages/broker/tests/scheduler.test.ts`

- [ ] **Step 1: Write failing tests**

Create `~/Projects/hermes/packages/broker/tests/scheduler.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Writable } from 'node:stream';
import { RefreshScheduler } from '../src/scheduler.js';
import { createLogger } from '../src/logger.js';

const nullSink = new Writable({ write(_c, _e, cb) { cb(); } });
const logger = createLogger({ level: 'error', stream: nullSink, pretty: false });

describe('RefreshScheduler', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('invokes refresh at the scheduled time', async () => {
    const refresh = vi.fn(async () => {});
    const s = new RefreshScheduler({ logger, refresh });
    s.schedule('ms365:graph', new Date(Date.now() + 1000));
    await vi.advanceTimersByTimeAsync(1100);
    expect(refresh).toHaveBeenCalledWith('ms365', 'graph');
  });

  it('replaces existing schedule for same key', async () => {
    const refresh = vi.fn(async () => {});
    const s = new RefreshScheduler({ logger, refresh });
    s.schedule('ms365:graph', new Date(Date.now() + 10_000));
    s.schedule('ms365:graph', new Date(Date.now() + 500));
    await vi.advanceTimersByTimeAsync(600);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('cancels a scheduled refresh', async () => {
    const refresh = vi.fn(async () => {});
    const s = new RefreshScheduler({ logger, refresh });
    s.schedule('ms365:graph', new Date(Date.now() + 500));
    s.cancel('ms365:graph');
    await vi.advanceTimersByTimeAsync(1000);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('logs and continues on refresh errors', async () => {
    const refresh = vi.fn(async () => { throw new Error('boom'); });
    const s = new RefreshScheduler({ logger, refresh });
    s.schedule('ms365:graph', new Date(Date.now() + 100));
    await vi.advanceTimersByTimeAsync(200);
    expect(refresh).toHaveBeenCalledTimes(1);
    s.schedule('ms365:graph', new Date(Date.now() + 100));
    await vi.advanceTimersByTimeAsync(200);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run test — expect failure**

Run:
```bash
cd ~/Projects/hermes/packages/broker
pnpm test scheduler
```

Expected: FAIL.

- [ ] **Step 3: Implement scheduler.ts**

Create `~/Projects/hermes/packages/broker/src/scheduler.ts`:

```typescript
import type { Logger } from './logger.js';

export interface SchedulerOptions {
  logger: Logger;
  refresh: (service: string, scheme: string) => Promise<void>;
}

export class RefreshScheduler {
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly opts: SchedulerOptions) {}

  schedule(key: string, when: Date): void {
    this.cancel(key);
    const ms = Math.max(0, when.getTime() - Date.now());
    const parts = key.split(':');
    const service = parts[0] ?? '';
    const scheme = parts[1] ?? '';
    const t = setTimeout(() => {
      this.timers.delete(key);
      this.opts.refresh(service, scheme).catch((err) =>
        this.opts.logger.warn('scheduled refresh failed', {
          key, error: (err as Error).message,
        })
      );
    }, ms);
    if (typeof t.unref === 'function') t.unref();
    this.timers.set(key, t);
  }

  cancel(key: string): void {
    const t = this.timers.get(key);
    if (t) {
      clearTimeout(t);
      this.timers.delete(key);
    }
  }

  cancelAll(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  pendingKeys(): string[] {
    return Array.from(this.timers.keys());
  }
}
```

- [ ] **Step 4: Run test — expect pass**

Run:
```bash
cd ~/Projects/hermes/packages/broker
pnpm test scheduler
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

Run:
```bash
cd ~/Projects/hermes
git add packages/broker
git commit -m "phase-1: add RefreshScheduler with replace/cancel semantics"
```

---

### Task 12: HTTP server (Fastify)

**Files:**
- Create: `~/Projects/hermes/packages/broker/src/http-server.ts`
- Create: `~/Projects/hermes/packages/broker/tests/http-server.test.ts`

- [ ] **Step 1: Write failing tests**

Create `~/Projects/hermes/packages/broker/tests/http-server.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { buildHttpServer } from '../src/http-server.js';
import { createLogger } from '../src/logger.js';
import type { Broker } from '../src/broker.js';
import type { TokenBundle } from '../src/types.js';

const nullSink = new Writable({ write(_c, _e, cb) { cb(); } });
const logger = createLogger({ level: 'error', stream: nullSink, pretty: false });
const TOKEN = 'shared-secret-value';

const bundle: TokenBundle = {
  service: 'ms365', scheme: 'graph', accessToken: 'abc', tokenType: 'Bearer',
  expiresAt: Date.now() + 3600_000, acquiredAt: Date.now(),
};

function brokerReturning(result: TokenBundle | Error): Broker {
  return {
    async getToken() {
      if (result instanceof Error) throw result;
      return result;
    },
    async listServices() { return ['ms365']; },
  } as unknown as Broker;
}

describe('httpServer', () => {
  let app: FastifyInstance;
  afterEach(async () => { if (app) await app.close(); });

  it('GET /health returns ok without auth', async () => {
    app = buildHttpServer({ broker: brokerReturning(bundle), clientToken: TOKEN, logger });
    const r = await app.inject({ method: 'GET', url: '/health' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ status: 'ok' });
  });

  it('rejects /token without bearer', async () => {
    app = buildHttpServer({ broker: brokerReturning(bundle), clientToken: TOKEN, logger });
    const r = await app.inject({ method: 'GET', url: '/token/ms365/graph' });
    expect(r.statusCode).toBe(401);
  });

  it('rejects /token with wrong bearer', async () => {
    app = buildHttpServer({ broker: brokerReturning(bundle), clientToken: TOKEN, logger });
    const r = await app.inject({
      method: 'GET', url: '/token/ms365/graph',
      headers: { authorization: 'Bearer wrong' },
    });
    expect(r.statusCode).toBe(401);
  });

  it('returns token bundle when authorized', async () => {
    app = buildHttpServer({ broker: brokerReturning(bundle), clientToken: TOKEN, logger });
    const r = await app.inject({
      method: 'GET', url: '/token/ms365/graph',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().accessToken).toBe('abc');
  });

  it('maps HermesError to structured JSON', async () => {
    const { HermesError, HermesErrorCode } = await import('../src/errors.js');
    const err = new HermesError(
      HermesErrorCode.ACQUIRE_REQUIRED, 'need login',
      { remediation: 'run hermes acquire ms365' }
    );
    app = buildHttpServer({ broker: brokerReturning(err), clientToken: TOKEN, logger });
    const r = await app.inject({
      method: 'GET', url: '/token/ms365/graph',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({
      code: 'ACQUIRE_REQUIRED',
      remediation: 'run hermes acquire ms365',
    });
  });
});
```

- [ ] **Step 2: Run test — expect failure**

Run:
```bash
cd ~/Projects/hermes/packages/broker
pnpm test http-server
```

Expected: FAIL.

- [ ] **Step 3: Implement http-server.ts**

Create `~/Projects/hermes/packages/broker/src/http-server.ts`:

```typescript
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Logger } from './logger.js';
import { HermesError, HermesErrorCode } from './errors.js';
import type { Broker } from './broker.js';

export interface HttpServerDeps {
  broker: Broker;
  clientToken: string;
  logger: Logger;
}

const codeToStatus: Record<HermesErrorCode, number> = {
  [HermesErrorCode.ACQUIRE_REQUIRED]: 409,
  [HermesErrorCode.REFRESH_FAILED]: 409,
  [HermesErrorCode.VALIDATION_FAILED]: 409,
  [HermesErrorCode.PROVIDER_NOT_FOUND]: 404,
  [HermesErrorCode.SERVICE_NOT_REGISTERED]: 404,
  [HermesErrorCode.STORAGE_ERROR]: 500,
  [HermesErrorCode.CONFIG_ERROR]: 500,
  [HermesErrorCode.UNAUTHORIZED]: 401,
  [HermesErrorCode.INTERNAL]: 500,
};

export function buildHttpServer(deps: HttpServerDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  const requireAuth = (req: FastifyRequest, reply: FastifyReply): boolean => {
    const header = req.headers.authorization ?? '';
    const expected = `Bearer ${deps.clientToken}`;
    if (header !== expected) {
      reply.code(401).send({ code: 'UNAUTHORIZED', message: 'invalid or missing bearer token' });
      return false;
    }
    return true;
  };

  app.get('/health', async () => ({ status: 'ok' }));

  app.get<{
    Params: { service: string; scheme: string };
    Querystring: { force?: string };
  }>('/token/:service/:scheme', async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    try {
      const bundle = await deps.broker.getToken(req.params.service, req.params.scheme, {
        force: req.query.force === '1' || req.query.force === 'true',
      });
      return bundle;
    } catch (err) {
      if (err instanceof HermesError) {
        reply.code(codeToStatus[err.code] ?? 500).send(err.toJSON());
        return;
      }
      deps.logger.error('unhandled http error', { error: (err as Error).message });
      reply.code(500).send({ code: 'INTERNAL', message: 'internal error' });
    }
  });

  return app;
}
```

- [ ] **Step 4: Run test — expect pass**

Run:
```bash
cd ~/Projects/hermes/packages/broker
pnpm test http-server
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

Run:
```bash
cd ~/Projects/hermes
git add packages/broker
git commit -m "phase-1: add Fastify HTTP server with bearer auth and error mapping"
```

---

### Task 13: MCP management tools

**Files:**
- Create: `~/Projects/hermes/packages/broker/src/mcp-server.ts`
- Create: `~/Projects/hermes/packages/broker/tests/mcp-server.test.ts`

**Scope for v1:** expose `hermes_status`, `hermes_force_refresh`, `hermes_list_services`, `hermes_list_providers`. Other tools (install, diagnose, tail_logs) are Phase 4.

- [ ] **Step 1: Write failing test**

Create `~/Projects/hermes/packages/broker/tests/mcp-server.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { buildMcpToolHandlers } from '../src/mcp-server.js';
import type { Broker } from '../src/broker.js';
import type { ServiceRegistry } from '../src/registry.js';
import type { TokenBundle } from '../src/types.js';

const bundle: TokenBundle = {
  service: 'ms365', scheme: 'graph', accessToken: 'abc', tokenType: 'Bearer',
  expiresAt: Date.now() + 3600_000, acquiredAt: Date.now(),
};

function fakeBroker(): Broker {
  return {
    getToken: vi.fn(async () => bundle),
    listServices: vi.fn(async () => ['ms365', 'servicenow']),
  } as unknown as Broker;
}

function fakeRegistry(): ServiceRegistry {
  return {
    listProviders: () => [
      { name: 'ms365', schemes: ['graph', 'teams'] } as any,
    ],
    listServices: () => [
      { name: 'ms365', providerName: 'ms365', schemes: ['graph'], config: {}, createdAt: 1 },
    ],
  } as unknown as ServiceRegistry;
}

describe('mcp tool handlers', () => {
  it('hermes_status lists services and providers', async () => {
    const handlers = buildMcpToolHandlers({
      broker: fakeBroker(), registry: fakeRegistry(),
    });
    const res = await handlers.hermes_status({});
    expect(res.services).toContain('ms365');
    expect(res.providers.map((p: any) => p.name)).toContain('ms365');
  });

  it('hermes_force_refresh calls broker.getToken with force', async () => {
    const broker = fakeBroker();
    const handlers = buildMcpToolHandlers({ broker, registry: fakeRegistry() });
    const res = await handlers.hermes_force_refresh({ service: 'ms365', scheme: 'graph' });
    expect(broker.getToken).toHaveBeenCalledWith('ms365', 'graph', { force: true });
    expect(res.accessToken).toBe('abc');
  });

  it('hermes_list_services returns registered services', async () => {
    const handlers = buildMcpToolHandlers({
      broker: fakeBroker(), registry: fakeRegistry(),
    });
    const res = await handlers.hermes_list_services({});
    expect(res.services[0].name).toBe('ms365');
  });

  it('hermes_list_providers returns installed providers', async () => {
    const handlers = buildMcpToolHandlers({
      broker: fakeBroker(), registry: fakeRegistry(),
    });
    const res = await handlers.hermes_list_providers({});
    expect(res.providers[0].name).toBe('ms365');
    expect(res.providers[0].schemes).toEqual(['graph', 'teams']);
  });
});
```

- [ ] **Step 2: Run test — expect failure**

Run:
```bash
cd ~/Projects/hermes/packages/broker
pnpm test mcp-server
```

Expected: FAIL.

- [ ] **Step 3: Implement mcp-server.ts**

Create `~/Projects/hermes/packages/broker/src/mcp-server.ts`:

```typescript
import type { Broker } from './broker.js';
import type { ServiceRegistry } from './registry.js';

export interface McpDeps {
  broker: Broker;
  registry: ServiceRegistry;
}

export interface McpToolHandlers {
  hermes_status(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  hermes_force_refresh(args: { service: string; scheme: string }): Promise<Record<string, unknown>>;
  hermes_list_services(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  hermes_list_providers(args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export function buildMcpToolHandlers(deps: McpDeps): McpToolHandlers {
  return {
    async hermes_status() {
      const services = (await deps.broker.listServices());
      const providers = deps.registry.listProviders().map((p) => ({
        name: p.name, schemes: [...p.schemes],
      }));
      return { services, providers };
    },
    async hermes_force_refresh(args) {
      return deps.broker.getToken(args.service, args.scheme, { force: true });
    },
    async hermes_list_services() {
      const services = deps.registry.listServices().map((s) => ({
        name: s.name, providerName: s.providerName, schemes: s.schemes,
      }));
      return { services };
    },
    async hermes_list_providers() {
      const providers = deps.registry.listProviders().map((p) => ({
        name: p.name, schemes: [...p.schemes],
      }));
      return { providers };
    },
  };
}

// MCP SDK tool descriptors — consumed by cli.ts when wiring the stdio server.
export const mcpToolDescriptors = [
  {
    name: 'hermes_status',
    description: 'Show all registered services and installed providers.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'hermes_force_refresh',
    description: 'Force a refresh of the token for a given service and scheme.',
    inputSchema: {
      type: 'object',
      properties: {
        service: { type: 'string', description: 'service name (e.g. ms365)' },
        scheme:  { type: 'string', description: 'scheme name (e.g. graph)' },
      },
      required: ['service', 'scheme'],
      additionalProperties: false,
    },
  },
  {
    name: 'hermes_list_services',
    description: 'List registered services with their provider binding.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'hermes_list_providers',
    description: 'List installed providers and their supported schemes.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
] as const;
```

- [ ] **Step 4: Run test — expect pass**

Run:
```bash
cd ~/Projects/hermes/packages/broker
pnpm test mcp-server
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

Run:
```bash
cd ~/Projects/hermes
git add packages/broker
git commit -m "phase-1: add MCP tool handlers for status/refresh/list"
```

---

### Task 14: CLI (init, start)

**Files:**
- Create: `~/Projects/hermes/packages/broker/src/cli.ts`
- Create: `~/Projects/hermes/packages/broker/src/bootstrap.ts`
- Create: `~/Projects/hermes/packages/broker/tests/bootstrap.test.ts`

`cli.ts` is the binary entrypoint. `bootstrap.ts` holds the wiring logic (testable without actually starting listeners).

- [ ] **Step 1: Write failing test for bootstrap**

Create `~/Projects/hermes/packages/broker/tests/bootstrap.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initDataDir, generateClientToken } from '../src/bootstrap.js';

describe('bootstrap', () => {
  it('initDataDir creates config + client token file', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hermes-boot-'));
    const result = await initDataDir(dir);
    expect(existsSync(path.join(dir, 'config.json'))).toBe(true);
    expect(existsSync(path.join(dir, 'client.token'))).toBe(true);
    expect(result.clientToken.length).toBeGreaterThanOrEqual(32);
  });

  it('initDataDir is idempotent — reuses existing client token', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hermes-boot-'));
    const first = await initDataDir(dir);
    const second = await initDataDir(dir);
    expect(second.clientToken).toBe(first.clientToken);
  });

  it('generateClientToken returns url-safe 32+ char string', () => {
    const t = generateClientToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(t.length).toBeGreaterThanOrEqual(32);
  });
});
```

- [ ] **Step 2: Run test — expect failure**

Run:
```bash
cd ~/Projects/hermes/packages/broker
pnpm test bootstrap
```

Expected: FAIL.

- [ ] **Step 3: Implement bootstrap.ts**

Create `~/Projects/hermes/packages/broker/src/bootstrap.ts`:

```typescript
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function generateClientToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export interface InitResult {
  dataDir: string;
  clientToken: string;
  configPath: string;
  clientTokenPath: string;
}

export async function initDataDir(dataDir: string): Promise<InitResult> {
  await fs.mkdir(dataDir, { recursive: true });
  const configPath = path.join(dataDir, 'config.json');
  const clientTokenPath = path.join(dataDir, 'client.token');

  try {
    await fs.access(configPath);
  } catch {
    await fs.writeFile(
      configPath,
      JSON.stringify({ httpPort: 9876, logLevel: 'info' }, null, 2),
      { mode: 0o600 }
    );
  }

  let clientToken: string;
  try {
    clientToken = (await fs.readFile(clientTokenPath, 'utf8')).trim();
    if (!clientToken) throw new Error('empty');
  } catch {
    clientToken = generateClientToken();
    await fs.writeFile(clientTokenPath, clientToken, { mode: 0o600 });
  }

  return { dataDir, clientToken, configPath, clientTokenPath };
}
```

- [ ] **Step 4: Run test — expect pass**

Run:
```bash
cd ~/Projects/hermes/packages/broker
pnpm test bootstrap
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Implement cli.ts**

Create `~/Projects/hermes/packages/broker/src/cli.ts`:

```typescript
#!/usr/bin/env node
import { Command } from 'commander';
import path from 'node:path';
import { loadConfig, defaultDataDir } from './config.js';
import { initDataDir } from './bootstrap.js';
import { createLogger } from './logger.js';
import { TokenStorage, createKeytarAdapter } from './storage.js';
import { ServiceRegistry } from './registry.js';
import { TokenValidator } from './validator.js';
import { Broker } from './broker.js';
import { RefreshScheduler } from './scheduler.js';
import { buildHttpServer } from './http-server.js';
import { buildMcpToolHandlers, mcpToolDescriptors } from './mcp-server.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const program = new Command();
program.name('hermes').description('Local MCP auth broker').version('0.0.1');

program
  .command('init')
  .description('Initialize ~/.hermes with config and client token')
  .option('--data-dir <path>', 'data directory', defaultDataDir())
  .action(async (opts) => {
    const result = await initDataDir(opts.dataDir);
    console.log(`initialized ${result.dataDir}`);
    console.log(`config:        ${result.configPath}`);
    console.log(`client token:  ${result.clientTokenPath}`);
  });

program
  .command('start')
  .description('Start Hermes broker (MCP stdio + HTTP API)')
  .option('--data-dir <path>', 'data directory', defaultDataDir())
  .option('--stdio', 'run MCP server on stdio (required for MCP clients)')
  .action(async (opts) => {
    const init = await initDataDir(opts.dataDir);
    const config = await loadConfig({ dataDir: init.dataDir });
    const logger = createLogger({ level: config.logLevel, pretty: false });

    const keyring = await createKeytarAdapter();
    const storage = new TokenStorage(keyring);
    const registry = new ServiceRegistry(config.dataDir);
    await registry.loadServices();

    const validator = new TokenValidator({
      policy: config.validationPolicy,
      safetyMarginSec: config.refreshSafetyMarginSec,
    });
    const broker = new Broker({
      storage, registry, validator, logger, dataDir: config.dataDir,
    });

    const scheduler = new RefreshScheduler({
      logger,
      refresh: async (service, scheme) => {
        await broker.getToken(service, scheme, { force: true });
      },
    });

    const http = buildHttpServer({ broker, clientToken: init.clientToken, logger });
    await http.listen({ host: config.httpHost, port: config.httpPort });
    logger.info('http listening', { host: config.httpHost, port: config.httpPort });

    if (opts.stdio) {
      const handlers = buildMcpToolHandlers({ broker, registry });
      const server = new Server(
        { name: 'hermes', version: '0.0.1' },
        { capabilities: { tools: {} } }
      );
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: mcpToolDescriptors as unknown as Array<{
          name: string; description: string; inputSchema: unknown;
        }>,
      }));
      server.setRequestHandler(CallToolRequestSchema, async (req) => {
        const name = req.params.name as keyof typeof handlers;
        const args = (req.params.arguments ?? {}) as any;
        if (!(name in handlers)) {
          throw new Error(`unknown tool: ${String(name)}`);
        }
        const result = await handlers[name](args);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      });
      await server.connect(new StdioServerTransport());
      logger.info('mcp stdio ready');
    }

    const shutdown = async () => {
      logger.info('shutting down');
      scheduler.cancelAll();
      await http.close();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

program.parseAsync(process.argv);
```

- [ ] **Step 6: Typecheck**

Run:
```bash
cd ~/Projects/hermes/packages/broker
pnpm typecheck
```

Expected: exits 0. If the MCP SDK import types differ from what the code assumes, fix the import path and re-run until typecheck passes. Do NOT suppress errors with `any` — adjust the imports.

- [ ] **Step 7: Commit**

Run:
```bash
cd ~/Projects/hermes
git add packages/broker
git commit -m "phase-1: add CLI with init and start (HTTP + MCP stdio)"
```

---

### Task 15: provider-ms365 package scaffolding

**Files:**
- Create: `~/Projects/hermes/packages/provider-ms365/package.json`
- Create: `~/Projects/hermes/packages/provider-ms365/tsconfig.json`
- Create: `~/Projects/hermes/packages/provider-ms365/vitest.config.ts`
- Create: `~/Projects/hermes/packages/provider-ms365/src/index.ts`
- Create: `~/Projects/hermes/packages/provider-ms365/src/config.ts`
- Create: `~/Projects/hermes/packages/provider-ms365/tests/config.test.ts`

- [ ] **Step 1: Write package.json**

Create `~/Projects/hermes/packages/provider-ms365/package.json`:

```json
{
  "name": "@hermes/provider-ms365",
  "version": "0.0.1",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  },
  "dependencies": {
    "@hermes/broker": "workspace:*",
    "playwright": "^1.44.0",
    "zod": "^3.23.0"
  }
}
```

- [ ] **Step 2: Write tsconfig**

Create `~/Projects/hermes/packages/provider-ms365/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 3: Write vitest config**

Create `~/Projects/hermes/packages/provider-ms365/vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 10_000,
  },
});
```

- [ ] **Step 4: Write failing config test**

Create `~/Projects/hermes/packages/provider-ms365/tests/config.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { Ms365ConfigSchema, SCHEMES } from '../src/config.js';

describe('Ms365Config', () => {
  it('parses minimal valid config', () => {
    const parsed = Ms365ConfigSchema.parse({ loginHint: 'user@example.com' });
    expect(parsed.loginHint).toBe('user@example.com');
    expect(parsed.tenant).toBe('common');
  });

  it('requires loginHint', () => {
    expect(() => Ms365ConfigSchema.parse({})).toThrow(/loginHint/);
  });

  it('exposes all ms365 schemes', () => {
    expect(SCHEMES).toContain('graph');
    expect(SCHEMES).toContain('teams');
    expect(SCHEMES).toContain('outlook');
  });
});
```

- [ ] **Step 5: Install deps**

Run:
```bash
cd ~/Projects/hermes
pnpm install
```

Expected: workspace resolves `@hermes/broker` as a local dep.

- [ ] **Step 6: Run test — expect failure**

Run:
```bash
cd ~/Projects/hermes/packages/provider-ms365
mkdir -p src tests
pnpm test config || true
```

Expected: FAIL — module missing.

- [ ] **Step 7: Implement src/config.ts**

Create `~/Projects/hermes/packages/provider-ms365/src/config.ts`:

```typescript
import { z } from 'zod';

export const SCHEMES = ['graph', 'teams', 'outlook'] as const;
export type Ms365Scheme = typeof SCHEMES[number];

export const Ms365ConfigSchema = z.object({
  loginHint: z.string().min(1, 'loginHint is required'),
  tenant: z.string().default('common'),
  clientId: z.string().default('d3590ed6-52b3-4102-aeff-aad2292ab01c'), // Office public client id
  totpKeychainService: z.string().optional(),
  totpKeychainAccount: z.string().optional(),
  headless: z.boolean().default(true),
  authTimeoutMs: z.number().int().min(5_000).default(120_000),
});

export type Ms365Config = z.infer<typeof Ms365ConfigSchema>;

export const SCOPES: Record<Ms365Scheme, string[]> = {
  graph:   ['https://graph.microsoft.com/.default', 'offline_access'],
  teams:   ['https://api.spaces.skype.com/.default', 'offline_access'],
  outlook: ['https://outlook.office.com/.default', 'offline_access'],
};
```

- [ ] **Step 8: Run test — expect pass**

Run:
```bash
cd ~/Projects/hermes/packages/provider-ms365
pnpm test config
```

Expected: PASS, 3 tests.

- [ ] **Step 9: Write stub index.ts**

Create `~/Projects/hermes/packages/provider-ms365/src/index.ts`:

```typescript
export { SCHEMES, SCOPES, Ms365ConfigSchema, type Ms365Config } from './config.js';
export { Ms365Provider } from './provider.js';
```

Note: `provider.ts` is created in Task 17. For this task, a placeholder export is fine — comment out the provider export line if typecheck complains, then uncomment in Task 17.

- [ ] **Step 10: Commit**

Run:
```bash
cd ~/Projects/hermes
git add packages/provider-ms365
git commit -m "phase-1: scaffold @hermes/provider-ms365 package with config schema"
```

---

### Task 16: ms365 token refresh logic (silent refresh)

**Files:**
- Create: `~/Projects/hermes/packages/provider-ms365/src/refresh.ts`
- Create: `~/Projects/hermes/packages/provider-ms365/tests/refresh.test.ts`

Silent refresh using `refresh_token` grant against `/oauth2/v2.0/token`. Extracted as a pure function so it can be tested without a real Playwright browser.

- [ ] **Step 1: Write failing tests**

Create `~/Projects/hermes/packages/provider-ms365/tests/refresh.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { silentRefresh, type OauthFetcher } from '../src/refresh.js';
import type { TokenBundle } from '@hermes/broker/src/types.js';

const bundle = (refreshToken: string | undefined, scheme = 'graph'): TokenBundle => ({
  service: 'ms365',
  scheme,
  accessToken: 'old',
  refreshToken,
  tokenType: 'Bearer',
  expiresAt: Date.now() - 60_000,
  acquiredAt: Date.now() - 3600_000,
});

describe('silentRefresh', () => {
  let fetcher: OauthFetcher;

  beforeEach(() => {
    fetcher = vi.fn(async () => ({
      access_token: 'new-token',
      refresh_token: 'new-refresh',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'https://graph.microsoft.com/.default',
    }));
  });

  it('posts form body with refresh_token grant', async () => {
    await silentRefresh({
      fetcher,
      tenant: 'common',
      clientId: 'cid',
      bundle: bundle('rt'),
    });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, opts] = (fetcher as any).mock.calls[0];
    expect(url).toContain('common/oauth2/v2.0/token');
    expect(opts.body).toContain('grant_type=refresh_token');
    expect(opts.body).toContain('refresh_token=rt');
    expect(opts.body).toContain('client_id=cid');
  });

  it('returns new TokenBundle with computed expiresAt', async () => {
    const result = await silentRefresh({
      fetcher, tenant: 'common', clientId: 'cid', bundle: bundle('rt'),
    });
    expect(result.accessToken).toBe('new-token');
    expect(result.refreshToken).toBe('new-refresh');
    expect(result.expiresAt).toBeGreaterThan(Date.now() + 3_500_000);
    expect(result.service).toBe('ms365');
    expect(result.scheme).toBe('graph');
  });

  it('throws when bundle has no refresh_token', async () => {
    await expect(
      silentRefresh({ fetcher, tenant: 'common', clientId: 'cid', bundle: bundle(undefined) })
    ).rejects.toThrow(/no refresh_token/);
  });

  it('throws when fetcher returns non-200 with error body', async () => {
    fetcher = vi.fn(async () => {
      throw new Error('HTTP 400: invalid_grant');
    });
    await expect(
      silentRefresh({ fetcher, tenant: 'common', clientId: 'cid', bundle: bundle('rt') })
    ).rejects.toThrow(/invalid_grant/);
  });
});
```

- [ ] **Step 2: Run test — expect failure**

Run:
```bash
cd ~/Projects/hermes/packages/provider-ms365
pnpm test refresh
```

Expected: FAIL.

- [ ] **Step 3: Implement refresh.ts**

Create `~/Projects/hermes/packages/provider-ms365/src/refresh.ts`:

```typescript
import type { TokenBundle } from '@hermes/broker/src/types.js';
import { SCOPES, type Ms365Scheme } from './config.js';

export interface OauthTokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
  scope?: string;
}

export type OauthFetcher = (url: string, opts: {
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}) => Promise<OauthTokenResponse>;

export interface SilentRefreshOptions {
  fetcher: OauthFetcher;
  tenant: string;
  clientId: string;
  bundle: TokenBundle;
}

export async function silentRefresh(opts: SilentRefreshOptions): Promise<TokenBundle> {
  const { fetcher, tenant, clientId, bundle } = opts;
  if (!bundle.refreshToken) {
    throw new Error('no refresh_token in bundle');
  }
  const scheme = bundle.scheme as Ms365Scheme;
  const scopes = SCOPES[scheme] ?? SCOPES.graph;

  const params = new URLSearchParams();
  params.set('grant_type', 'refresh_token');
  params.set('refresh_token', bundle.refreshToken);
  params.set('client_id', clientId);
  params.set('scope', scopes.join(' '));

  const url = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;

  const resp = await fetcher(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      // Required for SPA-issued tokens (prevents AADSTS9002327)
      Origin: 'https://login.microsoftonline.com',
    },
    body: params.toString(),
  });

  const now = Date.now();
  return {
    service: bundle.service,
    scheme: bundle.scheme,
    accessToken: resp.access_token,
    refreshToken: resp.refresh_token ?? bundle.refreshToken,
    tokenType: resp.token_type || 'Bearer',
    expiresAt: now + resp.expires_in * 1000,
    acquiredAt: now,
    ...(resp.scope ? { scope: resp.scope } : {}),
  };
}

export async function defaultFetcher(
  url: string,
  opts: { method: 'POST'; headers: Record<string, string>; body: string }
): Promise<OauthTokenResponse> {
  const r = await fetch(url, opts);
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`HTTP ${r.status}: ${text}`);
  }
  return (await r.json()) as OauthTokenResponse;
}
```

- [ ] **Step 4: Run test — expect pass**

Run:
```bash
cd ~/Projects/hermes/packages/provider-ms365
pnpm test refresh
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

Run:
```bash
cd ~/Projects/hermes
git add packages/provider-ms365
git commit -m "phase-1: add ms365 silent refresh via refresh_token grant"
```

---

### Task 17: ms365 Provider class (acquire + validate + nextRefreshAt)

**Files:**
- Create: `~/Projects/hermes/packages/provider-ms365/src/provider.ts`
- Create: `~/Projects/hermes/packages/provider-ms365/src/browser-auth.ts`
- Create: `~/Projects/hermes/packages/provider-ms365/tests/provider.test.ts`

**Scope:** `acquire()` uses Playwright with a profile-lock-safe launch (fixes the stale lock bug). `validate()` calls Microsoft Graph `/me`. `nextRefreshAt()` reads the actual `exp` claim from the access token (JWT) or falls back to `expiresAt - 20% lifetime`.

`browser-auth.ts` wraps Playwright interactions so they can be swapped for a mock in tests.

- [ ] **Step 1: Write failing tests for provider**

Create `~/Projects/hermes/packages/provider-ms365/tests/provider.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { Ms365Provider } from '../src/provider.js';
import type { BrowserAuth, BrowserAuthResult } from '../src/browser-auth.js';
import type { TokenBundle } from '@hermes/broker/src/types.js';
import type { ProviderContext } from '@hermes/broker/src/types.js';

const nullLogger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
};

function ctx(config: Record<string, unknown>): ProviderContext {
  return { service: 'ms365', config, dataDir: '/tmp/hermes-test', logger: nullLogger };
}

function jwt(expSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url');
  return `${header}.${payload}.sig`;
}

const mockResult: BrowserAuthResult = {
  accessToken: jwt(Math.floor(Date.now() / 1000) + 3600),
  refreshToken: 'rt',
  expiresIn: 3600,
  scope: 'https://graph.microsoft.com/.default',
};

function mockBrowser(result: BrowserAuthResult | Error = mockResult): BrowserAuth {
  return {
    login: vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
    close: vi.fn(async () => {}),
  };
}

describe('Ms365Provider', () => {
  it('acquire returns TokenBundle with computed expiresAt', async () => {
    const browser = mockBrowser();
    const p = new Ms365Provider({
      browser, fetcher: async () => mockResult as any, now: () => 1_000_000_000_000,
    });
    const bundle = await p.acquire(ctx({ loginHint: 'u@e.com' }), 'graph');
    expect(bundle.accessToken).toBe(mockResult.accessToken);
    expect(bundle.service).toBe('ms365');
    expect(bundle.scheme).toBe('graph');
    expect(bundle.expiresAt).toBe(1_000_000_000_000 + 3600_000);
    expect(browser.login).toHaveBeenCalledWith(expect.objectContaining({
      loginHint: 'u@e.com', scheme: 'graph',
    }));
  });

  it('acquire throws when config is missing loginHint', async () => {
    const p = new Ms365Provider({
      browser: mockBrowser(), fetcher: async () => mockResult as any, now: () => 0,
    });
    await expect(p.acquire(ctx({}), 'graph')).rejects.toThrow(/loginHint/);
  });

  it('validate calls Graph /me and returns true on 200', async () => {
    const httpFetch = vi.fn(async () => ({ ok: true, status: 200 })) as any;
    const p = new Ms365Provider({
      browser: mockBrowser(), fetcher: async () => mockResult as any,
      now: () => Date.now(), httpFetch,
    });
    const bundle: TokenBundle = {
      service: 'ms365', scheme: 'graph', accessToken: 'abc', tokenType: 'Bearer',
      expiresAt: Date.now() + 3600_000, acquiredAt: Date.now(),
    };
    expect(await p.validate(ctx({ loginHint: 'u@e.com' }), bundle)).toBe(true);
    expect(httpFetch).toHaveBeenCalledWith(
      'https://graph.microsoft.com/v1.0/me',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer abc' }),
      })
    );
  });

  it('validate returns false on 401', async () => {
    const httpFetch = vi.fn(async () => ({ ok: false, status: 401 })) as any;
    const p = new Ms365Provider({
      browser: mockBrowser(), fetcher: async () => mockResult as any,
      now: () => Date.now(), httpFetch,
    });
    const bundle: TokenBundle = {
      service: 'ms365', scheme: 'graph', accessToken: 'abc', tokenType: 'Bearer',
      expiresAt: Date.now() + 3600_000, acquiredAt: Date.now(),
    };
    expect(await p.validate(ctx({ loginHint: 'u@e.com' }), bundle)).toBe(false);
  });

  it('nextRefreshAt reads JWT exp and applies safety margin', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const expSec = nowSec + 3600;
    const p = new Ms365Provider({
      browser: mockBrowser(), fetcher: async () => mockResult as any, now: () => Date.now(),
    });
    const bundle: TokenBundle = {
      service: 'ms365', scheme: 'graph', accessToken: jwt(expSec), tokenType: 'Bearer',
      expiresAt: expSec * 1000, acquiredAt: Date.now(),
    };
    const next = p.nextRefreshAt(bundle);
    // Should be before expiry
    expect(next.getTime()).toBeLessThan(expSec * 1000);
    // Should be at least 5 minutes before expiry
    expect(expSec * 1000 - next.getTime()).toBeGreaterThanOrEqual(300_000);
  });

  it('refresh delegates to silentRefresh', async () => {
    const fetcher = vi.fn(async () => ({
      access_token: 'refreshed', token_type: 'Bearer', expires_in: 3600,
      refresh_token: 'new-rt',
    }));
    const p = new Ms365Provider({
      browser: mockBrowser(), fetcher: fetcher as any, now: () => Date.now(),
    });
    const bundle: TokenBundle = {
      service: 'ms365', scheme: 'graph', accessToken: 'old', refreshToken: 'rt',
      tokenType: 'Bearer', expiresAt: Date.now() - 1000, acquiredAt: Date.now() - 3600_000,
    };
    const refreshed = await p.refresh(ctx({ loginHint: 'u@e.com' }), bundle);
    expect(refreshed.accessToken).toBe('refreshed');
    expect(fetcher).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test — expect failure**

Run:
```bash
cd ~/Projects/hermes/packages/provider-ms365
pnpm test provider
```

Expected: FAIL.

- [ ] **Step 3: Implement browser-auth.ts (interface + Playwright impl)**

Create `~/Projects/hermes/packages/provider-ms365/src/browser-auth.ts`:

```typescript
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface BrowserAuthParams {
  loginHint: string;
  tenant: string;
  clientId: string;
  scheme: 'graph' | 'teams' | 'outlook';
  headless: boolean;
  authTimeoutMs: number;
  profileDir: string;
  totp?: string;
}

export interface BrowserAuthResult {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  scope?: string;
}

export interface BrowserAuth {
  login(params: BrowserAuthParams): Promise<BrowserAuthResult>;
  close(): Promise<void>;
}

/**
 * Clears Firefox/Playwright profile locks left behind by a previous ungraceful shutdown.
 * Fixes the known "Firefox is already running, but is not responding" failure mode.
 */
export async function clearProfileLock(profileDir: string): Promise<void> {
  const lockFiles = ['lock', '.parentlock', 'parent.lock'];
  for (const name of lockFiles) {
    try {
      await fs.unlink(path.join(profileDir, name));
    } catch {
      // ignore missing
    }
  }
}

export class PlaywrightBrowserAuth implements BrowserAuth {
  // Playwright integration implemented in a follow-up step. For v1, this class
  // exists as a concrete entry point that Task 17 + follow-up work fills in.
  async login(_p: BrowserAuthParams): Promise<BrowserAuthResult> {
    throw new Error('PlaywrightBrowserAuth.login not yet implemented — see follow-up tasks');
  }
  async close(): Promise<void> {}
}
```

**Note:** The full Playwright-based `login()` that drives the real Microsoft login flow is the single biggest piece of work in this plan, and wraps the existing `host-auth.mjs` script logic. See the **follow-up tasks** in `part3.md` where the Playwright interactions are ported.

- [ ] **Step 4: Implement provider.ts**

Create `~/Projects/hermes/packages/provider-ms365/src/provider.ts`:

```typescript
import type {
  Provider, ProviderContext, TokenBundle,
} from '@hermes/broker/src/types.js';
import { Ms365ConfigSchema, SCHEMES, type Ms365Scheme } from './config.js';
import {
  silentRefresh, defaultFetcher, type OauthFetcher,
} from './refresh.js';
import {
  clearProfileLock, type BrowserAuth, type BrowserAuthResult,
} from './browser-auth.js';
import path from 'node:path';

export interface Ms365ProviderDeps {
  browser: BrowserAuth;
  fetcher: OauthFetcher;
  now: () => number;
  httpFetch?: (url: string, init: { headers: Record<string, string> }) => Promise<{
    ok: boolean; status: number;
  }>;
}

interface JwtPayload {
  exp?: number;
  [k: string]: unknown;
}

function decodeJwt(token: string): JwtPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

export class Ms365Provider implements Provider {
  readonly name = 'ms365';
  readonly schemes = SCHEMES;

  constructor(private readonly deps: Ms365ProviderDeps) {}

  async acquire(ctx: ProviderContext, scheme: string): Promise<TokenBundle> {
    const config = Ms365ConfigSchema.parse(ctx.config);
    const ms365Scheme = scheme as Ms365Scheme;
    const profileDir = path.join(ctx.dataDir, 'ms365', 'profile');
    await clearProfileLock(profileDir);

    const result: BrowserAuthResult = await this.deps.browser.login({
      loginHint: config.loginHint,
      tenant: config.tenant,
      clientId: config.clientId,
      scheme: ms365Scheme,
      headless: config.headless,
      authTimeoutMs: config.authTimeoutMs,
      profileDir,
    });

    const now = this.deps.now();
    return {
      service: 'ms365',
      scheme,
      accessToken: result.accessToken,
      ...(result.refreshToken ? { refreshToken: result.refreshToken } : {}),
      tokenType: 'Bearer',
      expiresAt: now + result.expiresIn * 1000,
      acquiredAt: now,
      ...(result.scope ? { scope: result.scope } : {}),
    };
  }

  async refresh(ctx: ProviderContext, bundle: TokenBundle): Promise<TokenBundle> {
    const config = Ms365ConfigSchema.parse(ctx.config);
    return silentRefresh({
      fetcher: this.deps.fetcher,
      tenant: config.tenant,
      clientId: config.clientId,
      bundle,
    });
  }

  async validate(ctx: ProviderContext, bundle: TokenBundle): Promise<boolean> {
    const fetch = this.deps.httpFetch ?? (async (url, init) => {
      const r = await (globalThis as any).fetch(url, init);
      return { ok: r.ok, status: r.status };
    });
    const url = bundle.scheme === 'graph'
      ? 'https://graph.microsoft.com/v1.0/me'
      : 'https://graph.microsoft.com/v1.0/me';
    try {
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${bundle.accessToken}` },
      });
      return resp.ok;
    } catch (err) {
      ctx.logger.warn('ms365 validate fetch failed', { error: (err as Error).message });
      return false;
    }
  }

  nextRefreshAt(bundle: TokenBundle): Date {
    const jwt = decodeJwt(bundle.accessToken);
    const expMs = jwt?.exp ? jwt.exp * 1000 : bundle.expiresAt;
    const lifetime = expMs - bundle.acquiredAt;
    const margin = Math.max(300_000, Math.floor(lifetime * 0.2));
    return new Date(expMs - margin);
  }
}
```

- [ ] **Step 5: Run test — expect pass**

Run:
```bash
cd ~/Projects/hermes/packages/provider-ms365
pnpm test provider
```

Expected: PASS, 6 tests.

- [ ] **Step 6: Typecheck everything**

Run:
```bash
cd ~/Projects/hermes
pnpm -r typecheck
```

Expected: exits 0 across all packages.

- [ ] **Step 7: Commit**

Run:
```bash
cd ~/Projects/hermes
git add packages/provider-ms365
git commit -m "phase-1: add Ms365Provider with acquire/refresh/validate/nextRefreshAt"
```

---

**Continued in `2026-04-09-hermes-phase-0-1-part3.md` (tasks 18–25: Playwright browser login port, client library, broker-provider wiring, ms365-mcp container migration, first-time setup docs).**
