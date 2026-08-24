# Hermes Phase 0 + Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove thesun/mcp-forge duplication, then build the Hermes broker foundation end-to-end — broker core, ms365 provider, client library, and migrated ms365-mcp container — so MS365 auth becomes reliable and the architecture is proven with one real service.

**Architecture:** Hermes is a local Node.js MCP server that runs on the host. It exposes MCP tools for management over stdio, and a localhost HTTP API for containerized MCPs to fetch validated tokens. Providers are pluggable npm packages implementing a common interface. Phase 1 builds the broker core plus a single `@hermes/provider-ms365` to validate the architecture with the hardest real-world case.

**Tech Stack:**
- Node.js 20 LTS + TypeScript 5.4
- pnpm workspaces (monorepo: broker, client, provider-ms365)
- Vitest (testing)
- @modelcontextprotocol/sdk (MCP server)
- Fastify 4 (HTTP server)
- keytar (cross-platform credential storage)
- pino (structured JSON logging)
- zod (runtime validation)
- commander (CLI)
- Playwright (browser automation, ms365 provider only)

**Repo layout:**
```
~/Projects/hermes/
├── package.json                      (workspace root)
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── packages/
│   ├── broker/         @hermes/broker
│   ├── client/         @hermes/client
│   └── provider-ms365/ @hermes/provider-ms365
└── docs/superpowers/
    ├── specs/2026-04-09-hermes-design.md
    └── plans/2026-04-09-hermes-phase-0-1.md
```

This plan is split across multiple files for readability and token budget:
- `2026-04-09-hermes-phase-0-1.md` — this file (tasks 1–8)
- `2026-04-09-hermes-phase-0-1-part2.md` — tasks 9–17
- `2026-04-09-hermes-phase-0-1-part3.md` — tasks 18–25

Execute tasks in numeric order across all three files.

---

## Phase 0 — Kill duplication

### Task 1: Archive mcp-forge, keep thesun

**Context:** `~/Scripts/mcp-servers/thesun/` and `~/Scripts/mcp-servers/mcp-forge/` contain near-duplicate MCP generator codebases. thesun is the actively-registered one. mcp-forge must go before Hermes absorbs thesun's Azure AD SSO code.

**Files:**
- Archive: `~/Scripts/mcp-servers/mcp-forge/` → `~/Archive/mcp-forge-2026-04-09.tar.gz`
- Modify: `~/.config/mcpu/config.json` (remove mcp-forge entry if present)
- Create: `~/Projects/hermes/docs/decisions/0001-keep-thesun-drop-mcp-forge.md`

- [ ] **Step 1: Verify thesun is registered, mcp-forge is optional**

Run:
```bash
grep -c thesun ~/.config/mcpu/config.json || echo 0
grep -c mcp-forge ~/.config/mcpu/config.json || echo 0
```

Expected: `thesun` count >= 1. Note the `mcp-forge` count.

- [ ] **Step 2: Archive mcp-forge**

Run:
```bash
mkdir -p ~/Archive
tar -czf ~/Archive/mcp-forge-2026-04-09.tar.gz -C ~/Scripts/mcp-servers mcp-forge
ls -lh ~/Archive/mcp-forge-2026-04-09.tar.gz
```

Expected: archive file created, size > 0.

- [ ] **Step 3: Remove mcp-forge from MCPU config if present**

If Step 1 found mcp-forge in the config, read `~/.config/mcpu/config.json`, remove the `mcp-forge` entry under `mcpServers`, and write it back. If not present, skip.

- [ ] **Step 4: Delete mcp-forge source**

Run:
```bash
rm -rf ~/Scripts/mcp-servers/mcp-forge
ls ~/Scripts/mcp-servers/ | grep -c forge || echo 0
```

Expected: `0`.

- [ ] **Step 5: Record the decision**

Create `~/Projects/hermes/docs/decisions/0001-keep-thesun-drop-mcp-forge.md`:

```markdown
# ADR 0001: Keep thesun, drop mcp-forge

**Date:** 2026-04-09
**Status:** Accepted

## Context

Two near-duplicate MCP generator codebases existed:
- `~/Scripts/mcp-servers/thesun/` — registered in MCPU, user's active generator
- `~/Scripts/mcp-servers/mcp-forge/` — alternate implementation, diverged

Hermes will absorb the battle-tested Azure AD SSO code from whichever one
survives. Maintaining both blocks extraction.

## Decision

Keep `thesun`. Archive and delete `mcp-forge`.

## Rationale

- `thesun` is the one wired into MCPU and user skills (`/sun:*`)
- `thesun` is more recent (last touched 2026-03-16 vs 2026-02-13)
- The user's mental model treats `thesun` as canonical

## Consequences

- Any fixes made to mcp-forge that did not land in thesun are lost
  (archive at `~/Archive/mcp-forge-2026-04-09.tar.gz` for recovery)
- thesun remains authoritative until its auth code is extracted into
  Hermes providers (Phase 3)
```

- [ ] **Step 6: Commit**

Run:
```bash
cd ~/Projects/hermes
git add docs/
git commit -m "phase-0: archive mcp-forge, keep thesun as canonical generator"
```

---

## Phase 1 — Broker foundation

### Task 2: Workspace scaffolding

**Files:**
- Create: `~/Projects/hermes/package.json`
- Create: `~/Projects/hermes/pnpm-workspace.yaml`
- Create: `~/Projects/hermes/tsconfig.base.json`
- Create: `~/Projects/hermes/.gitignore`
- Create: `~/Projects/hermes/packages/broker/package.json`
- Create: `~/Projects/hermes/packages/broker/tsconfig.json`
- Create: `~/Projects/hermes/packages/broker/vitest.config.ts`

- [ ] **Step 1: Write workspace root package.json**

Create `~/Projects/hermes/package.json`:

```json
{
  "name": "hermes-monorepo",
  "private": true,
  "version": "0.0.0",
  "packageManager": "pnpm@9.0.0",
  "scripts": {
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "typecheck": "pnpm -r typecheck"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "vitest": "^1.6.0",
    "@types/node": "^20.12.0"
  }
}
```

- [ ] **Step 2: Write pnpm-workspace.yaml**

Create `~/Projects/hermes/pnpm-workspace.yaml`:

```yaml
packages:
  - "packages/*"
```

- [ ] **Step 3: Write tsconfig.base.json**

Create `~/Projects/hermes/tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "sourceMap": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true
  }
}
```

- [ ] **Step 4: Write .gitignore**

Create `~/Projects/hermes/.gitignore`:

```
node_modules/
dist/
*.log
.DS_Store
coverage/
.vitest/
```

- [ ] **Step 5: Write broker package.json**

Create `~/Projects/hermes/packages/broker/package.json`:

```json
{
  "name": "@hermes/broker",
  "version": "0.0.1",
  "type": "module",
  "bin": { "hermes": "./dist/cli.js" },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "dev": "tsx src/cli.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "fastify": "^4.27.0",
    "keytar": "^7.9.0",
    "pino": "^9.0.0",
    "pino-pretty": "^11.0.0",
    "zod": "^3.23.0",
    "commander": "^12.0.0"
  },
  "devDependencies": {
    "tsx": "^4.7.0"
  }
}
```

- [ ] **Step 6: Write broker tsconfig**

Create `~/Projects/hermes/packages/broker/tsconfig.json`:

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

- [ ] **Step 7: Write vitest config**

Create `~/Projects/hermes/packages/broker/vitest.config.ts`:

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

- [ ] **Step 8: Install and verify baseline**

Run:
```bash
cd ~/Projects/hermes
pnpm install
mkdir -p packages/broker/src packages/broker/tests
echo "export {};" > packages/broker/src/index.ts
pnpm --filter @hermes/broker typecheck
```

Expected: install completes, typecheck exits 0.

- [ ] **Step 9: Commit**

Run:
```bash
cd ~/Projects/hermes
git add .
git commit -m "phase-1: scaffold hermes monorepo with broker package"
```

---

### Task 3: Core types and HermesError

**Files:**
- Create: `~/Projects/hermes/packages/broker/src/types.ts`
- Create: `~/Projects/hermes/packages/broker/src/errors.ts`
- Create: `~/Projects/hermes/packages/broker/tests/errors.test.ts`

- [ ] **Step 1: Write failing test for HermesError**

Create `~/Projects/hermes/packages/broker/tests/errors.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { HermesError, HermesErrorCode } from '../src/errors.js';

describe('HermesError', () => {
  it('carries a code and remediation hint', () => {
    const err = new HermesError(
      HermesErrorCode.ACQUIRE_REQUIRED,
      'ms365 has no cached credentials',
      { remediation: 'run hermes acquire ms365' }
    );
    expect(err.code).toBe(HermesErrorCode.ACQUIRE_REQUIRED);
    expect(err.message).toBe('ms365 has no cached credentials');
    expect(err.remediation).toBe('run hermes acquire ms365');
    expect(err instanceof Error).toBe(true);
  });

  it('serializes to JSON with code + message + remediation', () => {
    const err = new HermesError(
      HermesErrorCode.VALIDATION_FAILED,
      'token rejected by IdP',
      { remediation: 'force refresh' }
    );
    expect(err.toJSON()).toEqual({
      name: 'HermesError',
      code: 'VALIDATION_FAILED',
      message: 'token rejected by IdP',
      remediation: 'force refresh',
    });
  });
});
```

- [ ] **Step 2: Run test — expect failure**

Run:
```bash
cd ~/Projects/hermes/packages/broker
pnpm test errors
```

Expected: FAIL with "Cannot find module '../src/errors.js'".

- [ ] **Step 3: Implement errors.ts**

Create `~/Projects/hermes/packages/broker/src/errors.ts`:

```typescript
export enum HermesErrorCode {
  ACQUIRE_REQUIRED = 'ACQUIRE_REQUIRED',
  REFRESH_FAILED = 'REFRESH_FAILED',
  VALIDATION_FAILED = 'VALIDATION_FAILED',
  PROVIDER_NOT_FOUND = 'PROVIDER_NOT_FOUND',
  SERVICE_NOT_REGISTERED = 'SERVICE_NOT_REGISTERED',
  STORAGE_ERROR = 'STORAGE_ERROR',
  CONFIG_ERROR = 'CONFIG_ERROR',
  UNAUTHORIZED = 'UNAUTHORIZED',
  INTERNAL = 'INTERNAL',
}

export interface HermesErrorOptions {
  remediation?: string;
  cause?: unknown;
}

export class HermesError extends Error {
  public readonly code: HermesErrorCode;
  public readonly remediation?: string;

  constructor(code: HermesErrorCode, message: string, opts: HermesErrorOptions = {}) {
    super(message, opts.cause ? { cause: opts.cause } : undefined);
    this.name = 'HermesError';
    this.code = code;
    this.remediation = opts.remediation;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      ...(this.remediation ? { remediation: this.remediation } : {}),
    };
  }
}
```

- [ ] **Step 4: Run test — expect pass**

Run:
```bash
cd ~/Projects/hermes/packages/broker
pnpm test errors
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Implement types.ts**

Create `~/Projects/hermes/packages/broker/src/types.ts`:

```typescript
import { z } from 'zod';

export const TokenBundleSchema = z.object({
  service: z.string(),
  scheme: z.string(),
  accessToken: z.string(),
  refreshToken: z.string().optional(),
  tokenType: z.string().default('Bearer'),
  expiresAt: z.number().int(),
  acquiredAt: z.number().int(),
  scope: z.string().optional(),
  extra: z.record(z.unknown()).optional(),
});

export type TokenBundle = z.infer<typeof TokenBundleSchema>;

export interface ProviderLogger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export interface ProviderContext {
  service: string;
  config: Record<string, unknown>;
  logger: ProviderLogger;
  dataDir: string;
}

export interface Provider {
  readonly name: string;
  readonly schemes: readonly string[];
  acquire(ctx: ProviderContext, scheme: string): Promise<TokenBundle>;
  refresh(ctx: ProviderContext, bundle: TokenBundle): Promise<TokenBundle>;
  validate(ctx: ProviderContext, bundle: TokenBundle): Promise<boolean>;
  nextRefreshAt(bundle: TokenBundle): Date;
  dispose?(): Promise<void>;
}

export interface ServiceRegistration {
  name: string;
  providerName: string;
  schemes: string[];
  config: Record<string, unknown>;
  createdAt: number;
}
```

- [ ] **Step 6: Typecheck**

Run:
```bash
cd ~/Projects/hermes/packages/broker
pnpm typecheck
```

Expected: exits 0.

- [ ] **Step 7: Commit**

Run:
```bash
cd ~/Projects/hermes
git add packages/broker
git commit -m "phase-1: add core types and HermesError"
```

---

### Task 4: Logger

**Files:**
- Create: `~/Projects/hermes/packages/broker/src/logger.ts`
- Create: `~/Projects/hermes/packages/broker/tests/logger.test.ts`

- [ ] **Step 1: Write failing test**

Create `~/Projects/hermes/packages/broker/tests/logger.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { Writable } from 'node:stream';
import { createLogger, type LoggerOptions } from '../src/logger.js';

class Capture extends Writable {
  lines: string[] = [];
  override _write(chunk: Buffer, _enc: BufferEncoding, cb: () => void) {
    this.lines.push(chunk.toString());
    cb();
  }
}

describe('createLogger', () => {
  let sink: Capture;
  let opts: LoggerOptions;

  beforeEach(() => {
    sink = new Capture();
    opts = { level: 'debug', stream: sink, pretty: false };
  });

  it('emits JSON lines with level and msg', () => {
    const log = createLogger(opts);
    log.info('hello', { service: 'ms365' });
    const parsed = JSON.parse(sink.lines[0]!);
    expect(parsed.level).toBe(30);
    expect(parsed.msg).toBe('hello');
    expect(parsed.service).toBe('ms365');
  });

  it('supports child loggers with bound fields', () => {
    const log = createLogger(opts).child({ component: 'validator' });
    log.warn('stale token');
    const parsed = JSON.parse(sink.lines[0]!);
    expect(parsed.component).toBe('validator');
    expect(parsed.msg).toBe('stale token');
  });
});
```

- [ ] **Step 2: Run test — expect failure**

Run:
```bash
cd ~/Projects/hermes/packages/broker
pnpm test logger
```

Expected: FAIL.

- [ ] **Step 3: Implement logger.ts**

Create `~/Projects/hermes/packages/broker/src/logger.ts`:

```typescript
import pino, { type Logger as PinoLogger } from 'pino';
import type { Writable } from 'node:stream';

export interface LoggerOptions {
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  stream?: Writable;
  pretty?: boolean;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

function wrap(p: PinoLogger): Logger {
  return {
    debug: (msg, f) => p.debug(f ?? {}, msg),
    info:  (msg, f) => p.info(f ?? {}, msg),
    warn:  (msg, f) => p.warn(f ?? {}, msg),
    error: (msg, f) => p.error(f ?? {}, msg),
    child: (b) => wrap(p.child(b)),
  };
}

export function createLogger(opts: LoggerOptions): Logger {
  const base = pino(
    {
      level: opts.level,
      ...(opts.pretty
        ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
        : {}),
    },
    opts.stream ?? process.stderr
  );
  return wrap(base);
}
```

- [ ] **Step 4: Run test — expect pass**

Run:
```bash
cd ~/Projects/hermes/packages/broker
pnpm test logger
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

Run:
```bash
cd ~/Projects/hermes
git add packages/broker
git commit -m "phase-1: add pino-based structured logger"
```

---

### Task 5: KeyedMutex

**Files:**
- Create: `~/Projects/hermes/packages/broker/src/mutex.ts`
- Create: `~/Projects/hermes/packages/broker/tests/mutex.test.ts`

**Rationale:** Directly fixes the concurrent-401 thundering herd identified across the fleet. Every token fetch for a `(service, scheme)` pair flows through this.

- [ ] **Step 1: Write failing tests**

Create `~/Projects/hermes/packages/broker/tests/mutex.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { KeyedMutex } from '../src/mutex.js';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('KeyedMutex', () => {
  it('serializes concurrent runs for the same key', async () => {
    const m = new KeyedMutex();
    const events: string[] = [];
    const job = (id: string) => async () => {
      events.push(`start:${id}`);
      await tick(20);
      events.push(`end:${id}`);
      return id;
    };
    const results = await Promise.all([
      m.run('k', job('a')),
      m.run('k', job('b')),
      m.run('k', job('c')),
    ]);
    expect(results).toEqual(['a', 'b', 'c']);
    expect(events).toEqual([
      'start:a', 'end:a',
      'start:b', 'end:b',
      'start:c', 'end:c',
    ]);
  });

  it('runs different keys in parallel', async () => {
    const m = new KeyedMutex();
    const events: string[] = [];
    const job = (id: string) => async () => {
      events.push(`start:${id}`);
      await tick(20);
      events.push(`end:${id}`);
    };
    await Promise.all([m.run('a', job('a')), m.run('b', job('b'))]);
    expect(events.slice(0, 2).sort()).toEqual(['start:a', 'start:b']);
  });

  it('releases the lock when the job throws', async () => {
    const m = new KeyedMutex();
    await expect(m.run('k', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    const ok = await m.run('k', async () => 'ok');
    expect(ok).toBe('ok');
  });

  it('coalesces waiters via runDedup', async () => {
    const m = new KeyedMutex();
    let calls = 0;
    const job = async () => { calls++; await tick(30); return calls; };
    const results = await Promise.all([
      m.runDedup('k', job),
      m.runDedup('k', job),
      m.runDedup('k', job),
    ]);
    expect(calls).toBe(1);
    expect(results).toEqual([1, 1, 1]);
  });
});
```

- [ ] **Step 2: Run test — expect failure**

Run:
```bash
cd ~/Projects/hermes/packages/broker
pnpm test mutex
```

Expected: FAIL.

- [ ] **Step 3: Implement mutex.ts**

Create `~/Projects/hermes/packages/broker/src/mutex.ts`:

```typescript
type Job<T> = () => Promise<T>;

interface Chain {
  tail: Promise<unknown>;
}

export class KeyedMutex {
  private chains = new Map<string, Chain>();
  private inflight = new Map<string, Promise<unknown>>();

  async run<T>(key: string, job: Job<T>): Promise<T> {
    const prev = this.chains.get(key)?.tail ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    const next = prev.then(() => gate);
    this.chains.set(key, { tail: next });

    await prev.catch(() => undefined);
    try {
      return await job();
    } finally {
      release();
      queueMicrotask(() => {
        if (this.chains.get(key)?.tail === next) {
          this.chains.delete(key);
        }
      });
    }
  }

  async runDedup<T>(key: string, job: Job<T>): Promise<T> {
    const existing = this.inflight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const p = (async () => {
      try {
        return await job();
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }
}
```

- [ ] **Step 4: Run test — expect pass**

Run:
```bash
cd ~/Projects/hermes/packages/broker
pnpm test mutex
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

Run:
```bash
cd ~/Projects/hermes
git add packages/broker
git commit -m "phase-1: add KeyedMutex with serialize and dedup modes"
```

---

### Task 6: TokenStorage (keytar-backed)

**Files:**
- Create: `~/Projects/hermes/packages/broker/src/storage.ts`
- Create: `~/Projects/hermes/packages/broker/tests/storage.test.ts`

- [ ] **Step 1: Write failing tests**

Create `~/Projects/hermes/packages/broker/tests/storage.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { TokenStorage, type KeyringAdapter } from '../src/storage.js';
import type { TokenBundle } from '../src/types.js';

class MemKeyring implements KeyringAdapter {
  private m = new Map<string, string>();
  async setPassword(s: string, a: string, p: string) { this.m.set(`${s}:${a}`, p); }
  async getPassword(s: string, a: string) { return this.m.get(`${s}:${a}`) ?? null; }
  async deletePassword(s: string, a: string) { return this.m.delete(`${s}:${a}`); }
  async findCredentials(s: string) {
    return Array.from(this.m.entries())
      .filter(([k]) => k.startsWith(`${s}:`))
      .map(([k, password]) => ({ account: k.slice(s.length + 1), password }));
  }
}

const bundle: TokenBundle = {
  service: 'ms365',
  scheme: 'graph',
  accessToken: 'abc',
  tokenType: 'Bearer',
  expiresAt: Date.now() + 3600_000,
  acquiredAt: Date.now(),
};

describe('TokenStorage', () => {
  let kr: MemKeyring;
  let s: TokenStorage;
  beforeEach(() => { kr = new MemKeyring(); s = new TokenStorage(kr); });

  it('returns null when nothing is stored', async () => {
    expect(await s.get('ms365', 'graph')).toBeNull();
  });

  it('round-trips a TokenBundle', async () => {
    await s.set(bundle);
    expect(await s.get('ms365', 'graph')).toEqual(bundle);
  });

  it('overwrites on set', async () => {
    await s.set(bundle);
    await s.set({ ...bundle, accessToken: 'xyz' });
    expect((await s.get('ms365', 'graph'))?.accessToken).toBe('xyz');
  });

  it('deletes a stored bundle', async () => {
    await s.set(bundle);
    expect(await s.delete('ms365', 'graph')).toBe(true);
    expect(await s.get('ms365', 'graph')).toBeNull();
  });

  it('lists all stored bundles', async () => {
    await s.set(bundle);
    await s.set({ ...bundle, scheme: 'teams', accessToken: 'def' });
    const all = await s.list();
    expect(all.map((b) => b.scheme).sort()).toEqual(['graph', 'teams']);
  });

  it('rejects corrupt stored JSON with a clear error', async () => {
    await kr.setPassword('hermes', 'ms365:graph', '{not json');
    await expect(s.get('ms365', 'graph')).rejects.toThrow(/corrupt/i);
  });
});
```

- [ ] **Step 2: Run test — expect failure**

Run:
```bash
cd ~/Projects/hermes/packages/broker
pnpm test storage
```

Expected: FAIL.

- [ ] **Step 3: Implement storage.ts**

Create `~/Projects/hermes/packages/broker/src/storage.ts`:

```typescript
import { HermesError, HermesErrorCode } from './errors.js';
import { type TokenBundle, TokenBundleSchema } from './types.js';

const SERVICE = 'hermes';

export interface KeyringAdapter {
  setPassword(service: string, account: string, password: string): Promise<void>;
  getPassword(service: string, account: string): Promise<string | null>;
  deletePassword(service: string, account: string): Promise<boolean>;
  findCredentials(service: string): Promise<Array<{ account: string; password: string }>>;
}

export class TokenStorage {
  constructor(private readonly keyring: KeyringAdapter) {}

  private account(service: string, scheme: string): string {
    return `${service}:${scheme}`;
  }

  async get(service: string, scheme: string): Promise<TokenBundle | null> {
    const raw = await this.keyring.getPassword(SERVICE, this.account(service, scheme));
    if (raw === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      throw new HermesError(
        HermesErrorCode.STORAGE_ERROR,
        `corrupt token data for ${service}:${scheme}`,
        { cause, remediation: 'delete the stored credential and re-acquire' }
      );
    }
    const result = TokenBundleSchema.safeParse(parsed);
    if (!result.success) {
      throw new HermesError(
        HermesErrorCode.STORAGE_ERROR,
        `invalid token shape for ${service}:${scheme}: ${result.error.message}`
      );
    }
    return result.data;
  }

  async set(bundle: TokenBundle): Promise<void> {
    const validated = TokenBundleSchema.parse(bundle);
    await this.keyring.setPassword(
      SERVICE,
      this.account(bundle.service, bundle.scheme),
      JSON.stringify(validated)
    );
  }

  async delete(service: string, scheme: string): Promise<boolean> {
    return this.keyring.deletePassword(SERVICE, this.account(service, scheme));
  }

  async list(): Promise<TokenBundle[]> {
    const creds = await this.keyring.findCredentials(SERVICE);
    const out: TokenBundle[] = [];
    for (const { password } of creds) {
      try {
        const parsed = JSON.parse(password);
        const result = TokenBundleSchema.safeParse(parsed);
        if (result.success) out.push(result.data);
      } catch {
        // skip corrupt entries in list
      }
    }
    return out;
  }
}

export async function createKeytarAdapter(): Promise<KeyringAdapter> {
  const keytar = await import('keytar');
  return {
    setPassword: (s, a, p) => keytar.default.setPassword(s, a, p),
    getPassword: (s, a) => keytar.default.getPassword(s, a),
    deletePassword: (s, a) => keytar.default.deletePassword(s, a),
    findCredentials: (s) => keytar.default.findCredentials(s),
  };
}
```

- [ ] **Step 4: Run test — expect pass**

Run:
```bash
cd ~/Projects/hermes/packages/broker
pnpm test storage
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

Run:
```bash
cd ~/Projects/hermes
git add packages/broker
git commit -m "phase-1: add keytar-backed TokenStorage with zod validation"
```

---

### Task 7: Config loader

**Files:**
- Create: `~/Projects/hermes/packages/broker/src/config.ts`
- Create: `~/Projects/hermes/packages/broker/tests/config.test.ts`

- [ ] **Step 1: Write failing tests**

Create `~/Projects/hermes/packages/broker/tests/config.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig, defaultConfig } from '../src/config.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'hermes-cfg-'));

describe('loadConfig', () => {
  it('returns defaults when no config file exists', async () => {
    const dir = tmp();
    const cfg = await loadConfig({ dataDir: dir });
    expect(cfg.httpPort).toBe(defaultConfig.httpPort);
    expect(cfg.logLevel).toBe(defaultConfig.logLevel);
    expect(cfg.dataDir).toBe(dir);
  });

  it('reads overrides from config.json', async () => {
    const dir = tmp();
    writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({ httpPort: 12345, logLevel: 'debug' })
    );
    const cfg = await loadConfig({ dataDir: dir });
    expect(cfg.httpPort).toBe(12345);
    expect(cfg.logLevel).toBe('debug');
  });

  it('rejects invalid config with CONFIG_ERROR', async () => {
    const dir = tmp();
    writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ httpPort: 'nope' }));
    await expect(loadConfig({ dataDir: dir })).rejects.toThrow(/CONFIG_ERROR|httpPort/);
  });

  it('creates dataDir if missing', async () => {
    const dir = tmp();
    const nested = path.join(dir, 'nested', 'hermes');
    const cfg = await loadConfig({ dataDir: nested });
    expect(cfg.dataDir).toBe(nested);
  });
});
```

- [ ] **Step 2: Run test — expect failure**

Run:
```bash
cd ~/Projects/hermes/packages/broker
pnpm test config
```

Expected: FAIL.

- [ ] **Step 3: Implement config.ts**

Create `~/Projects/hermes/packages/broker/src/config.ts`:

```typescript
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import { HermesError, HermesErrorCode } from './errors.js';

export const BrokerConfigSchema = z.object({
  httpPort: z.number().int().min(1).max(65535).default(9876),
  httpHost: z.string().default('127.0.0.1'),
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  dataDir: z.string(),
  validationPolicy: z.enum(['eager', 'lazy', 'paranoid']).default('eager'),
  refreshSafetyMarginSec: z.number().int().min(60).default(300),
  clientTokenFile: z.string().optional(),
});

export type BrokerConfig = z.infer<typeof BrokerConfigSchema>;

export const defaultConfig = {
  httpPort: 9876,
  httpHost: '127.0.0.1',
  logLevel: 'info' as const,
  validationPolicy: 'eager' as const,
  refreshSafetyMarginSec: 300,
};

export interface LoadConfigOptions {
  dataDir?: string;
}

export function defaultDataDir(): string {
  return path.join(os.homedir(), '.hermes');
}

export async function loadConfig(opts: LoadConfigOptions = {}): Promise<BrokerConfig> {
  const dataDir = opts.dataDir ?? defaultDataDir();
  await fs.mkdir(dataDir, { recursive: true });
  const configPath = path.join(dataDir, 'config.json');

  let fileData: Record<string, unknown> = {};
  try {
    fileData = JSON.parse(await fs.readFile(configPath, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new HermesError(
        HermesErrorCode.CONFIG_ERROR,
        `failed to read ${configPath}`,
        { cause: err }
      );
    }
  }

  const merged = { ...defaultConfig, ...fileData, dataDir };
  const result = BrokerConfigSchema.safeParse(merged);
  if (!result.success) {
    throw new HermesError(
      HermesErrorCode.CONFIG_ERROR,
      `invalid config: ${result.error.message}`
    );
  }
  return result.data;
}
```

- [ ] **Step 4: Run test — expect pass**

Run:
```bash
cd ~/Projects/hermes/packages/broker
pnpm test config
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

Run:
```bash
cd ~/Projects/hermes
git add packages/broker
git commit -m "phase-1: add broker config loader with zod validation"
```

---

### Task 8: Service registry

**Files:**
- Create: `~/Projects/hermes/packages/broker/src/registry.ts`
- Create: `~/Projects/hermes/packages/broker/tests/registry.test.ts`

- [ ] **Step 1: Write failing tests**

Create `~/Projects/hermes/packages/broker/tests/registry.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ServiceRegistry } from '../src/registry.js';
import type { Provider, ProviderContext, TokenBundle } from '../src/types.js';

function fakeProvider(name: string, schemes: string[]): Provider {
  return {
    name,
    schemes,
    async acquire(ctx: ProviderContext, scheme: string): Promise<TokenBundle> {
      return {
        service: ctx.service, scheme, accessToken: 'x',
        tokenType: 'Bearer', expiresAt: Date.now() + 3600_000, acquiredAt: Date.now(),
      };
    },
    async refresh(_c, b) { return b; },
    async validate() { return true; },
    nextRefreshAt: (b) => new Date(b.expiresAt - 300_000),
  };
}

describe('ServiceRegistry', () => {
  let reg: ServiceRegistry;
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'hermes-reg-'));
    reg = new ServiceRegistry(dir);
  });

  it('registers and resolves providers by name', () => {
    reg.installProvider(fakeProvider('ms365', ['graph', 'teams']));
    expect(reg.getProvider('ms365')?.name).toBe('ms365');
    expect(reg.listProviders().map((p) => p.name)).toEqual(['ms365']);
  });

  it('persists services to disk and reloads them', async () => {
    reg.installProvider(fakeProvider('ms365', ['graph']));
    await reg.registerService({
      name: 'ms365', providerName: 'ms365', schemes: ['graph'],
      config: { loginHint: 'user@example.com' }, createdAt: Date.now(),
    });
    const reloaded = new ServiceRegistry(dir);
    reloaded.installProvider(fakeProvider('ms365', ['graph']));
    await reloaded.loadServices();
    expect(reloaded.getService('ms365')?.config.loginHint).toBe('user@example.com');
  });

  it('rejects service with unknown provider', async () => {
    await expect(
      reg.registerService({
        name: 'foo', providerName: 'nope', schemes: ['x'], config: {}, createdAt: Date.now(),
      })
    ).rejects.toThrow(/PROVIDER_NOT_FOUND|not installed/);
  });

  it('rejects service with unsupported scheme', async () => {
    reg.installProvider(fakeProvider('ms365', ['graph']));
    await expect(
      reg.registerService({
        name: 'ms365', providerName: 'ms365', schemes: ['teams'], config: {}, createdAt: Date.now(),
      })
    ).rejects.toThrow(/scheme/);
  });
});
```

- [ ] **Step 2: Run test — expect failure**

Run:
```bash
cd ~/Projects/hermes/packages/broker
pnpm test registry
```

Expected: FAIL.

- [ ] **Step 3: Implement registry.ts**

Create `~/Projects/hermes/packages/broker/src/registry.ts`:

```typescript
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { HermesError, HermesErrorCode } from './errors.js';
import type { Provider, ServiceRegistration } from './types.js';

const ServicesFileSchema = z.object({
  version: z.literal(1),
  services: z.array(
    z.object({
      name: z.string(),
      providerName: z.string(),
      schemes: z.array(z.string()),
      config: z.record(z.unknown()),
      createdAt: z.number().int(),
    })
  ),
});

export class ServiceRegistry {
  private providers = new Map<string, Provider>();
  private services = new Map<string, ServiceRegistration>();
  private readonly servicesPath: string;

  constructor(private readonly dataDir: string) {
    this.servicesPath = path.join(dataDir, 'services.json');
  }

  installProvider(p: Provider): void { this.providers.set(p.name, p); }
  getProvider(name: string): Provider | undefined { return this.providers.get(name); }
  listProviders(): Provider[] { return Array.from(this.providers.values()); }

  getService(name: string): ServiceRegistration | undefined { return this.services.get(name); }
  listServices(): ServiceRegistration[] { return Array.from(this.services.values()); }

  async registerService(reg: ServiceRegistration): Promise<void> {
    const provider = this.providers.get(reg.providerName);
    if (!provider) {
      throw new HermesError(
        HermesErrorCode.PROVIDER_NOT_FOUND,
        `provider ${reg.providerName} is not installed`,
        { remediation: `install @hermes/provider-${reg.providerName}` }
      );
    }
    for (const scheme of reg.schemes) {
      if (!provider.schemes.includes(scheme)) {
        throw new HermesError(
          HermesErrorCode.SERVICE_NOT_REGISTERED,
          `provider ${provider.name} does not support scheme ${scheme}`
        );
      }
    }
    this.services.set(reg.name, reg);
    await this.persist();
  }

  async unregisterService(name: string): Promise<boolean> {
    const existed = this.services.delete(name);
    if (existed) await this.persist();
    return existed;
  }

  async loadServices(): Promise<void> {
    try {
      const raw = await fs.readFile(this.servicesPath, 'utf8');
      const parsed = ServicesFileSchema.parse(JSON.parse(raw));
      this.services.clear();
      for (const s of parsed.services) this.services.set(s.name, s);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  private async persist(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    const data = { version: 1 as const, services: Array.from(this.services.values()) };
    await fs.writeFile(this.servicesPath, JSON.stringify(data, null, 2), { mode: 0o600 });
  }
}
```

- [ ] **Step 4: Run test — expect pass**

Run:
```bash
cd ~/Projects/hermes/packages/broker
pnpm test registry
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

Run:
```bash
cd ~/Projects/hermes
git add packages/broker
git commit -m "phase-1: add ServiceRegistry with provider install and persistence"
```

---

**Continued in `2026-04-09-hermes-phase-0-1-part2.md` (tasks 9–17).**
