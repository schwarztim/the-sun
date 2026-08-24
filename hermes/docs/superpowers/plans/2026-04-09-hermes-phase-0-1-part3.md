# Hermes Phase 0+1 Plan — Part 3 (Tasks 18–25)

Continued from `2026-04-09-hermes-phase-0-1-part2.md`.

---

### Task 18: Port Playwright browser login from host-auth.mjs

**Files:**
- Modify: `~/Projects/hermes/packages/provider-ms365/src/browser-auth.ts`
- Reference: `~/Scripts/mcp-servers/ms365-mcp/scripts/host-auth.mjs` (existing working implementation)
- Create: `~/Projects/hermes/packages/provider-ms365/tests/browser-auth.test.ts`

**Context:** The existing `host-auth.mjs` in the ms365-mcp repo is a working, battle-tested Playwright script that captures tokens by intercepting network traffic during an Azure AD login flow. This task ports that logic into `PlaywrightBrowserAuth.login()` with the bug fixes identified in the audit:

1. **Stale profile lock** — `clearProfileLock()` (already implemented in Task 17) is called before every launch
2. **Silent failure on Conditional Access** — detect the "You cannot access this right now" page and throw a clear error instead of timing out
3. **TOTP support** — read from context config's `totpKeychainService/totpKeychainAccount` or directly from a `totp` param
4. **Network interception** — capture tokens from requests to `login.microsoftonline.com/*/oauth2/v2.0/token`

- [ ] **Step 1: Read the existing host-auth.mjs to understand the flow**

Run:
```bash
wc -l ~/Scripts/mcp-servers/ms365-mcp/scripts/host-auth.mjs
```

Read the file fully. Note:
- What selectors it uses for email/password/MFA inputs
- How it intercepts token responses
- How it handles "Stay signed in?" prompt
- How it extracts TOTP

Document findings in `~/Projects/hermes/packages/provider-ms365/src/PORT_NOTES.md` (short, ~1 page).

- [ ] **Step 2: Write failing tests for the port**

Create `~/Projects/hermes/packages/provider-ms365/tests/browser-auth.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { clearProfileLock } from '../src/browser-auth.js';

describe('clearProfileLock', () => {
  it('removes lock files if present', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hermes-prof-'));
    const lockPath = path.join(dir, 'lock');
    writeFileSync(lockPath, 'x');
    expect(existsSync(lockPath)).toBe(true);
    await clearProfileLock(dir);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('does not throw when lock files are missing', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hermes-prof-'));
    await expect(clearProfileLock(dir)).resolves.toBeUndefined();
  });

  it('removes .parentlock and parent.lock variants', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hermes-prof-'));
    writeFileSync(path.join(dir, '.parentlock'), 'x');
    writeFileSync(path.join(dir, 'parent.lock'), 'x');
    await clearProfileLock(dir);
    expect(existsSync(path.join(dir, '.parentlock'))).toBe(false);
    expect(existsSync(path.join(dir, 'parent.lock'))).toBe(false);
  });
});
```

- [ ] **Step 3: Run test — expect pass (clearProfileLock already implemented)**

Run:
```bash
cd ~/Projects/hermes/packages/provider-ms365
pnpm test browser-auth
```

Expected: PASS, 3 tests.

- [ ] **Step 4: Implement PlaywrightBrowserAuth.login()**

Replace the stub in `~/Projects/hermes/packages/provider-ms365/src/browser-auth.ts` with the full implementation. Use these selectors and flow (adapted from the reference host-auth.mjs):

```typescript
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';

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

const EMAIL_SELECTORS = [
  'input[type="email"]',
  'input[name="loginfmt"]',
  '#i0116',
];
const NEXT_SELECTORS = ['input[type="submit"]', '#idSIButton9', 'button[type="submit"]'];
const PASSWORD_SELECTORS = [
  'input[type="password"]',
  'input[name="passwd"]',
  '#i0118',
];
const TOTP_SELECTORS = ['input[name="otc"]', '#idTxtBx_SAOTCC_OTC', 'input[type="tel"]'];
const STAY_SIGNED_IN_NO = '#idBtn_Back';
const STAY_SIGNED_IN_YES = '#idSIButton9';
const CONDITIONAL_ACCESS_BLOCKED_TEXTS = [
  'You cannot access this right now',
  'blocked by Conditional Access',
  'Sign-in was blocked',
];

async function clickFirstVisible(page: Page, selectors: string[], timeoutMs: number): Promise<boolean> {
  for (const sel of selectors) {
    try {
      const el = await page.waitForSelector(sel, { timeout: timeoutMs, state: 'visible' });
      if (el) {
        await el.click();
        return true;
      }
    } catch {
      // try next
    }
  }
  return false;
}

async function fillFirstVisible(
  page: Page, selectors: string[], value: string, timeoutMs: number
): Promise<boolean> {
  for (const sel of selectors) {
    try {
      const el = await page.waitForSelector(sel, { timeout: timeoutMs, state: 'visible' });
      if (el) {
        await el.fill(value);
        return true;
      }
    } catch {
      // try next
    }
  }
  return false;
}

function buildAuthUrl(params: BrowserAuthParams): string {
  const scopesByScheme = {
    graph: 'https://graph.microsoft.com/.default offline_access',
    teams: 'https://api.spaces.skype.com/.default offline_access',
    outlook: 'https://outlook.office.com/.default offline_access',
  } as const;
  const u = new URL(`https://login.microsoftonline.com/${params.tenant}/oauth2/v2.0/authorize`);
  u.searchParams.set('client_id', params.clientId);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', 'https://login.microsoftonline.com/common/oauth2/nativeclient');
  u.searchParams.set('response_mode', 'query');
  u.searchParams.set('scope', scopesByScheme[params.scheme]);
  u.searchParams.set('login_hint', params.loginHint);
  u.searchParams.set('prompt', 'select_account');
  return u.toString();
}

export class PlaywrightBrowserAuth implements BrowserAuth {
  private browser?: Browser;
  private context?: BrowserContext;

  async login(params: BrowserAuthParams): Promise<BrowserAuthResult> {
    const playwright = await import('playwright');
    await clearProfileLock(params.profileDir);
    await fs.mkdir(params.profileDir, { recursive: true });

    this.context = await playwright.firefox.launchPersistentContext(params.profileDir, {
      headless: params.headless,
      timeout: params.authTimeoutMs,
    });

    const page = await this.context.newPage();

    // Intercept token responses
    const tokenPromise = new Promise<BrowserAuthResult>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('timed out waiting for token response')),
        params.authTimeoutMs
      );
      page.on('response', async (resp) => {
        const url = resp.url();
        if (!/login\.microsoftonline\.com\/.+\/oauth2\/v2\.0\/token/.test(url)) return;
        try {
          const body = await resp.json();
          if (body.access_token) {
            clearTimeout(timer);
            resolve({
              accessToken: body.access_token,
              refreshToken: body.refresh_token,
              expiresIn: body.expires_in,
              scope: body.scope,
            });
          }
        } catch {
          // not JSON, skip
        }
      });
    });

    try {
      await page.goto(buildAuthUrl(params), { waitUntil: 'domcontentloaded' });

      // Detect Conditional Access block before waiting for input fields
      const content = await page.content().catch(() => '');
      for (const blockedText of CONDITIONAL_ACCESS_BLOCKED_TEXTS) {
        if (content.includes(blockedText)) {
          throw new Error(
            `Conditional Access blocked sign-in. Page says: "${blockedText}". ` +
            `Check device compliance / cert enrollment on this host.`
          );
        }
      }

      // Email
      const emailFilled = await fillFirstVisible(page, EMAIL_SELECTORS, params.loginHint, 10_000);
      if (emailFilled) {
        await clickFirstVisible(page, NEXT_SELECTORS, 5_000);
      }

      // Password — user interactively enters, or env var if provided
      // For v1 MVP we still require user presence for password; the existing
      // host-auth.mjs does the same when TOTP is present.
      // If a future task adds keychain-sourced password, inject it here.

      // Wait for password field; if it never appears, user may already be signed in.
      await fillFirstVisible(
        page,
        PASSWORD_SELECTORS,
        process.env.HERMES_MS365_PASSWORD ?? '',
        15_000
      ).catch(() => false);

      // TOTP if provided
      if (params.totp) {
        await fillFirstVisible(page, TOTP_SELECTORS, params.totp, 15_000);
        await clickFirstVisible(page, NEXT_SELECTORS, 5_000);
      }

      // "Stay signed in?" — say No to avoid persistent cookies in profile
      await clickFirstVisible(page, [STAY_SIGNED_IN_NO], 10_000).catch(() => false);

      return await tokenPromise;
    } finally {
      // Always attempt to close; keep process clean
      await this.close().catch(() => {});
    }
  }

  async close(): Promise<void> {
    try {
      await this.context?.close();
    } catch {
      // ignore
    }
    this.context = undefined;
    this.browser = undefined;
  }
}
```

- [ ] **Step 5: Add playwright install script to provider-ms365**

Add this script to `~/Projects/hermes/packages/provider-ms365/package.json`:

```json
"scripts": {
  "build": "tsc -p tsconfig.json",
  "test": "vitest run",
  "typecheck": "tsc --noEmit -p tsconfig.json",
  "postinstall": "playwright install firefox"
}
```

Edit the file and merge the `postinstall` line into the existing scripts block.

- [ ] **Step 6: Typecheck**

Run:
```bash
cd ~/Projects/hermes
pnpm -r typecheck
```

Expected: exits 0.

- [ ] **Step 7: Commit**

Run:
```bash
cd ~/Projects/hermes
git add packages/provider-ms365
git commit -m "phase-1: port host-auth.mjs into PlaywrightBrowserAuth with fixes"
```

---

### Task 19: @hermes/client package scaffolding

**Files:**
- Create: `~/Projects/hermes/packages/client/package.json`
- Create: `~/Projects/hermes/packages/client/tsconfig.json`
- Create: `~/Projects/hermes/packages/client/vitest.config.ts`
- Create: `~/Projects/hermes/packages/client/src/index.ts`
- Create: `~/Projects/hermes/packages/client/src/errors.ts`
- Create: `~/Projects/hermes/packages/client/tests/errors.test.ts`

- [ ] **Step 1: Write package.json**

Create `~/Projects/hermes/packages/client/package.json`:

```json
{
  "name": "@hermes/client",
  "version": "0.0.1",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  },
  "dependencies": {}
}
```

- [ ] **Step 2: Write tsconfig**

Create `~/Projects/hermes/packages/client/tsconfig.json`:

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

Create `~/Projects/hermes/packages/client/vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { globals: true, environment: 'node', include: ['tests/**/*.test.ts'], testTimeout: 10_000 },
});
```

- [ ] **Step 4: Write failing test for client errors**

Create `~/Projects/hermes/packages/client/tests/errors.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { HermesClientError, HermesClientErrorCode } from '../src/errors.js';

describe('HermesClientError', () => {
  it('carries code and remediation', () => {
    const e = new HermesClientError(
      HermesClientErrorCode.BROKER_UNREACHABLE,
      'connection refused',
      { remediation: 'start the hermes broker' }
    );
    expect(e.code).toBe('BROKER_UNREACHABLE');
    expect(e.remediation).toBe('start the hermes broker');
    expect(e instanceof Error).toBe(true);
  });
});
```

- [ ] **Step 5: Install deps**

Run:
```bash
cd ~/Projects/hermes
pnpm install
mkdir -p packages/client/src packages/client/tests
```

- [ ] **Step 6: Run test — expect failure**

Run:
```bash
cd ~/Projects/hermes/packages/client
pnpm test errors || true
```

Expected: FAIL.

- [ ] **Step 7: Implement src/errors.ts**

Create `~/Projects/hermes/packages/client/src/errors.ts`:

```typescript
export enum HermesClientErrorCode {
  BROKER_UNREACHABLE = 'BROKER_UNREACHABLE',
  UNAUTHORIZED = 'UNAUTHORIZED',
  ACQUIRE_REQUIRED = 'ACQUIRE_REQUIRED',
  SERVICE_NOT_REGISTERED = 'SERVICE_NOT_REGISTERED',
  INVALID_RESPONSE = 'INVALID_RESPONSE',
  UPSTREAM = 'UPSTREAM',
}

export interface HermesClientErrorOptions {
  remediation?: string;
  cause?: unknown;
  status?: number;
}

export class HermesClientError extends Error {
  public readonly code: HermesClientErrorCode;
  public readonly remediation?: string;
  public readonly status?: number;

  constructor(code: HermesClientErrorCode, message: string, opts: HermesClientErrorOptions = {}) {
    super(message, opts.cause ? { cause: opts.cause } : undefined);
    this.name = 'HermesClientError';
    this.code = code;
    this.remediation = opts.remediation;
    this.status = opts.status;
  }
}
```

- [ ] **Step 8: Run test — expect pass**

Run:
```bash
cd ~/Projects/hermes/packages/client
pnpm test errors
```

Expected: PASS.

- [ ] **Step 9: Commit**

Run:
```bash
cd ~/Projects/hermes
git add packages/client
git commit -m "phase-1: scaffold @hermes/client with error type"
```

---

### Task 20: HermesClient.getToken + retry + mutex

**Files:**
- Create: `~/Projects/hermes/packages/client/src/client.ts`
- Create: `~/Projects/hermes/packages/client/src/mutex.ts`
- Modify: `~/Projects/hermes/packages/client/src/index.ts`
- Create: `~/Projects/hermes/packages/client/tests/client.test.ts`

- [ ] **Step 1: Write failing tests for HermesClient**

Create `~/Projects/hermes/packages/client/tests/client.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { HermesClient, type ClientFetch } from '../src/client.js';
import { HermesClientErrorCode } from '../src/errors.js';

const okBundle = {
  service: 'ms365', scheme: 'graph', accessToken: 'abc', tokenType: 'Bearer',
  expiresAt: Date.now() + 3600_000, acquiredAt: Date.now(),
};

function okFetch(): ClientFetch {
  return async () => ({
    ok: true, status: 200, async json() { return okBundle; }, async text() { return ''; },
  });
}

describe('HermesClient.getToken', () => {
  it('returns the bundle on 200', async () => {
    const c = new HermesClient({
      brokerUrl: 'http://localhost:9876', clientToken: 'tok', fetch: okFetch(),
    });
    const b = await c.getToken('ms365', 'graph');
    expect(b.accessToken).toBe('abc');
  });

  it('sends bearer header', async () => {
    const fetchMock = vi.fn(okFetch());
    const c = new HermesClient({
      brokerUrl: 'http://localhost:9876', clientToken: 'tok', fetch: fetchMock,
    });
    await c.getToken('ms365', 'graph');
    const [, init] = (fetchMock as any).mock.calls[0];
    expect((init.headers as any).Authorization).toBe('Bearer tok');
  });

  it('maps 409 ACQUIRE_REQUIRED to client error', async () => {
    const c = new HermesClient({
      brokerUrl: 'http://localhost:9876', clientToken: 'tok',
      fetch: async () => ({
        ok: false, status: 409,
        async json() { return { code: 'ACQUIRE_REQUIRED', message: 'need login', remediation: 'run acquire' }; },
        async text() { return ''; },
      }),
    });
    try {
      await c.getToken('ms365', 'graph');
      throw new Error('expected throw');
    } catch (e: any) {
      expect(e.code).toBe(HermesClientErrorCode.ACQUIRE_REQUIRED);
      expect(e.remediation).toBe('run acquire');
    }
  });

  it('maps 404 SERVICE_NOT_REGISTERED', async () => {
    const c = new HermesClient({
      brokerUrl: 'http://localhost:9876', clientToken: 'tok',
      fetch: async () => ({
        ok: false, status: 404,
        async json() { return { code: 'SERVICE_NOT_REGISTERED', message: 'nope' }; },
        async text() { return ''; },
      }),
    });
    await expect(c.getToken('nope', 'graph')).rejects.toMatchObject({
      code: HermesClientErrorCode.SERVICE_NOT_REGISTERED,
    });
  });

  it('retries transient failures then throws BROKER_UNREACHABLE', async () => {
    let calls = 0;
    const c = new HermesClient({
      brokerUrl: 'http://localhost:9876', clientToken: 'tok',
      retries: 2, retryDelayMs: 1,
      fetch: async () => { calls++; throw new Error('ECONNREFUSED'); },
    });
    await expect(c.getToken('ms365', 'graph')).rejects.toMatchObject({
      code: HermesClientErrorCode.BROKER_UNREACHABLE,
    });
    expect(calls).toBe(3);
  });

  it('dedups concurrent calls for the same service:scheme', async () => {
    let calls = 0;
    const c = new HermesClient({
      brokerUrl: 'http://localhost:9876', clientToken: 'tok',
      fetch: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 20));
        return {
          ok: true, status: 200, async json() { return okBundle; }, async text() { return ''; },
        };
      },
    });
    await Promise.all([
      c.getToken('ms365', 'graph'),
      c.getToken('ms365', 'graph'),
      c.getToken('ms365', 'graph'),
    ]);
    expect(calls).toBe(1);
  });

  it('NEVER returns empty/null on failure — always throws', async () => {
    const c = new HermesClient({
      brokerUrl: 'http://localhost:9876', clientToken: 'tok',
      fetch: async () => ({
        ok: true, status: 200,
        async json() { return {} as any; },
        async text() { return ''; },
      }),
    });
    await expect(c.getToken('ms365', 'graph')).rejects.toMatchObject({
      code: HermesClientErrorCode.INVALID_RESPONSE,
    });
  });
});
```

- [ ] **Step 2: Run test — expect failure**

Run:
```bash
cd ~/Projects/hermes/packages/client
pnpm test client
```

Expected: FAIL.

- [ ] **Step 3: Implement mutex (copy from broker, keep client self-contained)**

Create `~/Projects/hermes/packages/client/src/mutex.ts`:

```typescript
export class ClientDedupMutex {
  private inflight = new Map<string, Promise<unknown>>();
  async runDedup<T>(key: string, job: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const p = (async () => {
      try { return await job(); } finally { this.inflight.delete(key); }
    })();
    this.inflight.set(key, p);
    return p;
  }
}
```

- [ ] **Step 4: Implement client.ts**

Create `~/Projects/hermes/packages/client/src/client.ts`:

```typescript
import { HermesClientError, HermesClientErrorCode } from './errors.js';
import { ClientDedupMutex } from './mutex.js';

export interface TokenBundle {
  service: string;
  scheme: string;
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  expiresAt: number;
  acquiredAt: number;
  scope?: string;
}

export interface ClientFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<any>;
  text(): Promise<string>;
}

export type ClientFetch = (url: string, init: {
  method?: string;
  headers: Record<string, string>;
}) => Promise<ClientFetchResponse>;

export interface HermesClientOptions {
  brokerUrl: string;
  clientToken: string;
  retries?: number;
  retryDelayMs?: number;
  fetch?: ClientFetch;
}

const REMOTE_CODE_MAP: Record<string, HermesClientErrorCode> = {
  ACQUIRE_REQUIRED: HermesClientErrorCode.ACQUIRE_REQUIRED,
  SERVICE_NOT_REGISTERED: HermesClientErrorCode.SERVICE_NOT_REGISTERED,
  PROVIDER_NOT_FOUND: HermesClientErrorCode.SERVICE_NOT_REGISTERED,
  UNAUTHORIZED: HermesClientErrorCode.UNAUTHORIZED,
};

export class HermesClient {
  private readonly mutex = new ClientDedupMutex();
  private readonly retries: number;
  private readonly retryDelayMs: number;
  private readonly fetch: ClientFetch;

  constructor(private readonly opts: HermesClientOptions) {
    this.retries = opts.retries ?? 2;
    this.retryDelayMs = opts.retryDelayMs ?? 200;
    this.fetch = opts.fetch ?? this.nodeFetch;
  }

  async getToken(service: string, scheme: string): Promise<TokenBundle> {
    const key = `${service}:${scheme}`;
    return this.mutex.runDedup(key, () => this.fetchWithRetry(service, scheme));
  }

  async authHeaders(service: string, scheme: string): Promise<Record<string, string>> {
    const b = await this.getToken(service, scheme);
    return { Authorization: `${b.tokenType} ${b.accessToken}` };
  }

  private async fetchWithRetry(service: string, scheme: string): Promise<TokenBundle> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        return await this.fetchOnce(service, scheme);
      } catch (err) {
        lastErr = err;
        if (err instanceof HermesClientError) {
          // Only retry on transient codes
          if (err.code !== HermesClientErrorCode.BROKER_UNREACHABLE) throw err;
        }
        if (attempt < this.retries) {
          await new Promise((r) => setTimeout(r, this.retryDelayMs * (attempt + 1)));
        }
      }
    }
    throw new HermesClientError(
      HermesClientErrorCode.BROKER_UNREACHABLE,
      `broker at ${this.opts.brokerUrl} unreachable after ${this.retries + 1} attempts`,
      { cause: lastErr, remediation: 'ensure hermes is running (hermes start --stdio)' }
    );
  }

  private async fetchOnce(service: string, scheme: string): Promise<TokenBundle> {
    const url = `${this.opts.brokerUrl}/token/${encodeURIComponent(service)}/${encodeURIComponent(scheme)}`;
    let resp: ClientFetchResponse;
    try {
      resp = await this.fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.opts.clientToken}` },
      });
    } catch (err) {
      throw new HermesClientError(
        HermesClientErrorCode.BROKER_UNREACHABLE,
        `fetch failed: ${(err as Error).message}`,
        { cause: err }
      );
    }

    if (!resp.ok) {
      let body: any = {};
      try { body = await resp.json(); } catch { body = {}; }
      const mapped = REMOTE_CODE_MAP[body.code] ?? HermesClientErrorCode.UPSTREAM;
      throw new HermesClientError(
        mapped,
        body.message ?? `broker returned ${resp.status}`,
        { status: resp.status, remediation: body.remediation }
      );
    }

    const bundle = await resp.json();
    if (!bundle || typeof bundle.accessToken !== 'string' || !bundle.accessToken) {
      throw new HermesClientError(
        HermesClientErrorCode.INVALID_RESPONSE,
        'broker returned a response without a valid accessToken',
        { remediation: 'check broker logs with hermes_tail_logs' }
      );
    }
    return bundle as TokenBundle;
  }

  private nodeFetch: ClientFetch = async (url, init) => {
    const r = await (globalThis as any).fetch(url, init);
    return {
      ok: r.ok, status: r.status,
      json: () => r.json(), text: () => r.text(),
    };
  };
}
```

- [ ] **Step 5: Update index.ts**

Create `~/Projects/hermes/packages/client/src/index.ts`:

```typescript
export { HermesClient, type HermesClientOptions, type TokenBundle, type ClientFetch } from './client.js';
export { HermesClientError, HermesClientErrorCode } from './errors.js';
```

- [ ] **Step 6: Run tests — expect pass**

Run:
```bash
cd ~/Projects/hermes/packages/client
pnpm test
```

Expected: PASS, all client tests.

- [ ] **Step 7: Commit**

Run:
```bash
cd ~/Projects/hermes
git add packages/client
git commit -m "phase-1: add HermesClient with retry, dedup, and loud failure"
```

---

### Task 21: Wire ms365 provider into broker CLI

**Files:**
- Modify: `~/Projects/hermes/packages/broker/src/cli.ts`
- Modify: `~/Projects/hermes/packages/broker/package.json`

Make the broker load `@hermes/provider-ms365` on startup so `hermes start` comes up with ms365 already installed. Also add a `register` CLI command so users can bind a service to a provider.

- [ ] **Step 1: Add provider-ms365 as a broker dependency**

Edit `~/Projects/hermes/packages/broker/package.json` and add to `dependencies`:

```json
"@hermes/provider-ms365": "workspace:*"
```

Run:
```bash
cd ~/Projects/hermes
pnpm install
```

- [ ] **Step 2: Update cli.ts to install providers and add register command**

Edit `~/Projects/hermes/packages/broker/src/cli.ts`. At the top of the file, add the import:

```typescript
import { Ms365Provider } from '@hermes/provider-ms365';
import { PlaywrightBrowserAuth } from '@hermes/provider-ms365/dist/browser-auth.js';
import { defaultFetcher } from '@hermes/provider-ms365/dist/refresh.js';
```

If import paths fail under TS `NodeNext` resolution, switch to subpath exports in `packages/provider-ms365/package.json`:

```json
"exports": {
  ".": "./dist/index.js",
  "./browser-auth": "./dist/browser-auth.js",
  "./refresh": "./dist/refresh.js"
}
```

and import as `@hermes/provider-ms365/browser-auth` / `@hermes/provider-ms365/refresh`.

Inside the `start` action, after `registry.loadServices()`, add:

```typescript
registry.installProvider(new Ms365Provider({
  browser: new PlaywrightBrowserAuth(),
  fetcher: defaultFetcher,
  now: () => Date.now(),
}));
```

Add a new `register` command above `program.parseAsync`:

```typescript
program
  .command('register <service>')
  .description('Register a service with a provider')
  .requiredOption('--provider <name>', 'provider name (e.g. ms365)')
  .requiredOption('--scheme <scheme...>', 'one or more schemes (e.g. graph teams)')
  .requiredOption('--config <json>', 'provider config as JSON string')
  .option('--data-dir <path>', 'data directory', defaultDataDir())
  .action(async (service, opts) => {
    await initDataDir(opts.dataDir);
    const config = await loadConfig({ dataDir: opts.dataDir });
    const registry = new ServiceRegistry(config.dataDir);
    await registry.loadServices();
    // Install the same provider set the start command uses
    registry.installProvider(new Ms365Provider({
      browser: new PlaywrightBrowserAuth(),
      fetcher: defaultFetcher,
      now: () => Date.now(),
    }));
    let parsedConfig: Record<string, unknown>;
    try { parsedConfig = JSON.parse(opts.config); }
    catch (err) {
      console.error(`invalid --config JSON: ${(err as Error).message}`);
      process.exit(2);
    }
    await registry.registerService({
      name: service,
      providerName: opts.provider,
      schemes: opts.scheme,
      config: parsedConfig,
      createdAt: Date.now(),
    });
    console.log(`registered service ${service} with provider ${opts.provider}`);
  });
```

- [ ] **Step 3: Build the workspace**

Run:
```bash
cd ~/Projects/hermes
pnpm -r build
```

Expected: all packages build, exit 0.

- [ ] **Step 4: Smoke test the CLI**

Run:
```bash
cd ~/Projects/hermes
node packages/broker/dist/cli.js init --data-dir /tmp/hermes-smoke
node packages/broker/dist/cli.js register ms365 \
  --provider ms365 \
  --scheme graph \
  --config '{"loginHint":"test@example.com","tenant":"common"}' \
  --data-dir /tmp/hermes-smoke
cat /tmp/hermes-smoke/services.json
```

Expected: `services.json` contains the ms365 registration.

- [ ] **Step 5: Commit**

Run:
```bash
cd ~/Projects/hermes
git add packages/
git commit -m "phase-1: install ms365 provider in broker CLI and add register command"
```

---

### Task 22: End-to-end integration test (broker + client)

**Files:**
- Create: `~/Projects/hermes/packages/broker/tests/e2e.test.ts`

This spins up a real HTTP server with a fake provider and hits it with the real HermesClient to prove the loop works end-to-end.

- [ ] **Step 1: Write the e2e test**

Create `~/Projects/hermes/packages/broker/tests/e2e.test.ts`:

```typescript
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
import { HermesClient } from '../../client/src/client.js';
import type { Provider, TokenBundle } from '../src/types.js';
import type { FastifyInstance } from 'fastify';

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

const bundle = (overrides: Partial<TokenBundle> = {}): TokenBundle => ({
  service: 'fake', scheme: 'main', accessToken: 'tok',
  tokenType: 'Bearer', expiresAt: Date.now() + 3600_000, acquiredAt: Date.now(),
  ...overrides,
});

function fakeProvider(): Provider {
  return {
    name: 'fake',
    schemes: ['main'],
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
    await registry.registerService({
      name: 'fake', providerName: 'fake', schemes: ['main'],
      config: {}, createdAt: Date.now(),
    });
    const broker = new Broker({
      storage, registry,
      validator: new TokenValidator({ policy: 'eager', safetyMarginSec: 300 }),
      logger, dataDir: dir,
    });
    const CLIENT_TOKEN = 'integration-test-token';
    app = buildHttpServer({ broker, clientToken: CLIENT_TOKEN, logger });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const brokerUrl = typeof address === 'string' ? address : `http://127.0.0.1:${(app.server.address() as any).port}`;

    const client = new HermesClient({ brokerUrl, clientToken: CLIENT_TOKEN });
    const result = await client.getToken('fake', 'main');
    expect(result.accessToken).toBe('tok');

    await expect(
      new HermesClient({ brokerUrl, clientToken: 'wrong' }).getToken('fake', 'main')
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});
```

- [ ] **Step 2: Run the e2e test**

Run:
```bash
cd ~/Projects/hermes
pnpm -r build
cd packages/broker
pnpm test e2e
```

Expected: PASS.

- [ ] **Step 3: Commit**

Run:
```bash
cd ~/Projects/hermes
git add packages/broker/tests/e2e.test.ts
git commit -m "phase-1: add e2e test covering broker HTTP + HermesClient"
```

---

### Task 23: Migrate ms365-mcp container to @hermes/client

**Files:**
- Modify: `~/Scripts/mcp-servers/ms365-mcp/src/auth/` (remove in-container auth)
- Modify: `~/Scripts/mcp-servers/ms365-mcp/src/api-client.ts` (or equivalent — use HermesClient)
- Modify: `~/Scripts/mcp-servers/ms365-mcp/Dockerfile` (remove Playwright + Firefox)
- Modify: `~/Scripts/mcp-servers/ms365-mcp/package.json` (add @hermes/client)

**Context:** This migration is the proof that the architecture works. ms365-mcp currently runs its own Firefox browser inside the container (see the failure chain: stale lock + no DISPLAY + Conditional Access). After this task, ms365-mcp becomes a thin container that just fetches tokens from Hermes.

The exact files to modify depend on the current ms365-mcp layout. The executing agent should read `~/Scripts/mcp-servers/ms365-mcp/` first and identify the concrete auth integration points.

- [ ] **Step 1: Audit the current auth code**

Run:
```bash
find ~/Scripts/mcp-servers/ms365-mcp -name "*.ts" -o -name "*.js" -o -name "*.mjs" | head -50
grep -rln "Firefox\|playwright\|host-auth\|robust-auth" ~/Scripts/mcp-servers/ms365-mcp/src/ 2>/dev/null
cat ~/Scripts/mcp-servers/ms365-mcp/package.json
```

Identify:
- The main entry point
- The file that makes Graph API calls (where Authorization headers are attached)
- Any in-container auth/browser code that must be removed

Write findings to `~/Projects/hermes/docs/migrations/ms365-mcp-audit.md` (short).

- [ ] **Step 2: Link @hermes/client as a dependency of ms365-mcp**

Run:
```bash
cd ~/Scripts/mcp-servers/ms365-mcp
# Install the local package directly via pnpm's file: or link: protocol
pnpm add file:~/Projects/hermes/packages/client
```

If ms365-mcp uses npm instead of pnpm, use:

```bash
cd ~/Scripts/mcp-servers/ms365-mcp
npm install ~/Projects/hermes/packages/client
```

- [ ] **Step 3: Replace auth integration in the API client**

In whatever file currently attaches `Authorization` headers to outgoing Graph/Teams/Outlook requests, replace the in-container token acquisition with HermesClient calls. The edit pattern (applied to each call site):

```typescript
// BEFORE (illustrative — adapt to actual code)
const token = await localAuth.getGraphToken();
headers['Authorization'] = `Bearer ${token}`;

// AFTER
import { HermesClient } from '@hermes/client';

const hermes = new HermesClient({
  brokerUrl: process.env.HERMES_URL ?? 'http://host.docker.internal:9876',
  clientToken: process.env.HERMES_CLIENT_TOKEN ?? '',
});

const authHeaders = await hermes.authHeaders('ms365', 'graph');
Object.assign(headers, authHeaders);
```

For the `teams` and `outlook` schemes, call `hermes.authHeaders('ms365', 'teams')` and `'outlook'` respectively.

- [ ] **Step 4: Delete in-container auth code**

Remove the files identified in Step 1 that implemented in-container Playwright/Firefox auth, robust-auth cookie logic, token cache files, etc. Do not remove code unrelated to auth.

Ensure the build still compiles:

```bash
cd ~/Scripts/mcp-servers/ms365-mcp
npm run build 2>&1 | tail -20
```

Expected: build succeeds. Fix any residual imports of the deleted modules.

- [ ] **Step 5: Remove Playwright/Firefox from Dockerfile**

Edit `~/Scripts/mcp-servers/ms365-mcp/Dockerfile`. Remove:
- Base image Firefox installation
- `playwright install` commands
- X11/display-related packages
- Volume mounts for `/root/.ms365-mcp/browser-profile/`

The container should end up much smaller (node + app only).

- [ ] **Step 6: Add HERMES_URL and HERMES_CLIENT_TOKEN to runconfig**

Identify how ms365-mcp is launched (thv runconfig, docker-compose, or similar). Add environment variables:

```
HERMES_URL=http://host.docker.internal:9876
HERMES_CLIENT_TOKEN=<contents of ~/.hermes/client.token>
```

For `thv`, store the client token via `thv secret set HERMES_CLIENT_TOKEN` and reference it in the runconfig `secrets` array:

```json
"secrets": ["HERMES_CLIENT_TOKEN,target=HERMES_CLIENT_TOKEN"]
```

**Do not** commit the client token to any repo or runconfig.

- [ ] **Step 7: Rebuild and run ms365-mcp**

Run:
```bash
cd ~/Scripts/mcp-servers/ms365-mcp
docker build -t localhost:5555/ms365-mcp:latest .
docker push localhost:5555/ms365-mcp:latest
thv stop ms365 || true
thv rm ms365 || true
thv run localhost:5555/ms365-mcp:latest --name ms365 --transport stdio
thv list
```

Expected: ms365 shows up as running.

- [ ] **Step 8: Verify end-to-end**

With `hermes start --stdio` running on the host (and `hermes acquire ms365` completed interactively at least once — see Task 25), call an ms365 MCP tool that hits Graph and confirm it returns real data instead of an empty array.

If this fails:
- Check broker logs for incoming requests: the broker should log GET /token/ms365/graph
- Check ms365-mcp container logs for HermesClient errors
- Verify `HERMES_CLIENT_TOKEN` matches `~/.hermes/client.token` on the host

- [ ] **Step 9: Commit**

Run:
```bash
cd ~/Scripts/mcp-servers/ms365-mcp
git add -A
git commit -m "migrate to @hermes/client; remove in-container browser auth"
```

---

### Task 24: hermes acquire command for first-time setup

**Files:**
- Modify: `~/Projects/hermes/packages/broker/src/cli.ts` (add `acquire` command)
- Create: `~/Projects/hermes/packages/broker/tests/cli-acquire.test.ts`

**Context:** First-time login must be interactive — the user has to enter their password (and possibly approve MFA) at least once per service. `hermes acquire` kicks off the provider's `acquire()` flow in the foreground.

- [ ] **Step 1: Write failing test for the acquire function**

Create `~/Projects/hermes/packages/broker/tests/cli-acquire.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { runAcquire } from '../src/acquire.js';
import type { Broker } from '../src/broker.js';

describe('runAcquire', () => {
  it('calls broker.getToken with force for every scheme of the service', async () => {
    const getToken = vi.fn(async (_s, scheme) => ({
      service: 'ms365', scheme, accessToken: 'x', tokenType: 'Bearer',
      expiresAt: Date.now() + 3600_000, acquiredAt: Date.now(),
    }));
    const broker = { getToken } as unknown as Broker;
    const result = await runAcquire({
      broker,
      service: 'ms365',
      schemes: ['graph', 'teams'],
    });
    expect(getToken).toHaveBeenCalledTimes(2);
    expect(getToken).toHaveBeenCalledWith('ms365', 'graph', { force: true });
    expect(getToken).toHaveBeenCalledWith('ms365', 'teams', { force: true });
    expect(result.acquired).toEqual(['graph', 'teams']);
    expect(result.failed).toEqual([]);
  });

  it('continues when one scheme fails and reports it', async () => {
    const getToken = vi.fn(async (_s, scheme) => {
      if (scheme === 'teams') throw new Error('MFA declined');
      return {
        service: 'ms365', scheme, accessToken: 'x', tokenType: 'Bearer',
        expiresAt: Date.now() + 3600_000, acquiredAt: Date.now(),
      };
    });
    const broker = { getToken } as unknown as Broker;
    const result = await runAcquire({
      broker, service: 'ms365', schemes: ['graph', 'teams'],
    });
    expect(result.acquired).toEqual(['graph']);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].scheme).toBe('teams');
  });
});
```

- [ ] **Step 2: Run test — expect failure**

Run:
```bash
cd ~/Projects/hermes/packages/broker
pnpm test cli-acquire
```

Expected: FAIL.

- [ ] **Step 3: Implement acquire.ts**

Create `~/Projects/hermes/packages/broker/src/acquire.ts`:

```typescript
import type { Broker } from './broker.js';

export interface AcquireOptions {
  broker: Broker;
  service: string;
  schemes: string[];
}

export interface AcquireResult {
  acquired: string[];
  failed: Array<{ scheme: string; error: string }>;
}

export async function runAcquire(opts: AcquireOptions): Promise<AcquireResult> {
  const acquired: string[] = [];
  const failed: Array<{ scheme: string; error: string }> = [];
  for (const scheme of opts.schemes) {
    try {
      await opts.broker.getToken(opts.service, scheme, { force: true });
      acquired.push(scheme);
    } catch (err) {
      failed.push({ scheme, error: (err as Error).message });
    }
  }
  return { acquired, failed };
}
```

- [ ] **Step 4: Run test — expect pass**

Run:
```bash
cd ~/Projects/hermes/packages/broker
pnpm test cli-acquire
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Wire acquire into cli.ts**

Edit `~/Projects/hermes/packages/broker/src/cli.ts` and add (above `program.parseAsync`):

```typescript
program
  .command('acquire <service>')
  .description('Interactively acquire tokens for a registered service')
  .option('--data-dir <path>', 'data directory', defaultDataDir())
  .action(async (service, opts) => {
    const { runAcquire } = await import('./acquire.js');
    const init = await initDataDir(opts.dataDir);
    const config = await loadConfig({ dataDir: init.dataDir });
    const logger = createLogger({ level: config.logLevel, pretty: true });
    const keyring = await createKeytarAdapter();
    const storage = new TokenStorage(keyring);
    const registry = new ServiceRegistry(config.dataDir);
    await registry.loadServices();
    registry.installProvider(new Ms365Provider({
      browser: new PlaywrightBrowserAuth(),
      fetcher: defaultFetcher,
      now: () => Date.now(),
    }));
    const validator = new TokenValidator({
      policy: config.validationPolicy,
      safetyMarginSec: config.refreshSafetyMarginSec,
    });
    const broker = new Broker({ storage, registry, validator, logger, dataDir: config.dataDir });

    const registration = registry.getService(service);
    if (!registration) {
      console.error(`service ${service} is not registered — run hermes register first`);
      process.exit(2);
    }
    console.log(`acquiring tokens for ${service} (schemes: ${registration.schemes.join(', ')})`);
    const result = await runAcquire({ broker, service, schemes: registration.schemes });
    console.log(`acquired: ${result.acquired.join(', ') || '(none)'}`);
    if (result.failed.length > 0) {
      console.error('failed:');
      for (const f of result.failed) console.error(`  ${f.scheme}: ${f.error}`);
      process.exit(1);
    }
  });
```

- [ ] **Step 6: Build and smoke test**

Run:
```bash
cd ~/Projects/hermes
pnpm -r build
node packages/broker/dist/cli.js acquire --help
```

Expected: help text shows the acquire command.

- [ ] **Step 7: Commit**

Run:
```bash
cd ~/Projects/hermes
git add packages/broker
git commit -m "phase-1: add hermes acquire command for interactive first-time login"
```

---

### Task 25: First-time setup documentation

**Files:**
- Create: `~/Projects/hermes/README.md`
- Create: `~/Projects/hermes/docs/first-time-setup.md`

- [ ] **Step 1: Write README.md**

Create `~/Projects/hermes/README.md`:

```markdown
# Hermes — MCP Auth Broker

Hermes is a local MCP server that handles authentication for other MCP servers.
It runs on your host (where device certificates, keychains, and browsers live),
holds tokens, and exposes a localhost HTTP API that containerized MCPs call to
fetch fresh, validated credentials.

## Why

Every MCP that authenticates against a corporate SSO or OAuth service hits the
same wall: containers cannot pass Conditional Access, refresh tokens silently,
or survive parallel 401s. Hermes solves that once, on the host, for every MCP.

## Status

Phase 1. Supports the `ms365` provider end-to-end. Phase 2 adds additional
providers (servicenow, generic OAuth, device code, cookie-session).

## Install

```bash
git clone <repo> ~/Projects/hermes
cd ~/Projects/hermes
pnpm install
pnpm -r build
```

See `docs/first-time-setup.md` for the initialization walkthrough.

## Architecture

See `docs/superpowers/specs/2026-04-09-hermes-design.md`.
```

- [ ] **Step 2: Write first-time setup walkthrough**

Create `~/Projects/hermes/docs/first-time-setup.md`:

```markdown
# First-time Setup

Prerequisites:
- Node.js 20+
- pnpm 9+
- On Linux only: libsecret (for keytar) — `apt install libsecret-1-dev gnome-keyring`
- Playwright browsers for ms365 provider (handled automatically via postinstall)

## 1. Install

```bash
cd ~/Projects/hermes
pnpm install
pnpm -r build
```

## 2. Initialize data directory

```bash
node packages/broker/dist/cli.js init
```

This creates:
- `~/.hermes/config.json`
- `~/.hermes/client.token` (keep this secret — any process that can read it can
  request tokens through the broker)

## 3. Register ms365

```bash
node packages/broker/dist/cli.js register ms365 \
  --provider ms365 \
  --scheme graph teams outlook \
  --config '{"loginHint":"your-email@example.com","tenant":"common"}'
```

## 4. Acquire initial tokens (interactive — browser will open)

```bash
node packages/broker/dist/cli.js acquire ms365
```

A Firefox window will open. Complete the login, including any MFA. Hermes
captures the tokens and stores them in the system keyring.

## 5. Add Hermes to your MCP client config

Edit `~/.claude/user-mcps.json` (Claude Code) or equivalent:

```json
{
  "hermes": {
    "command": "node",
    "args": ["/absolute/path/to/hermes/packages/broker/dist/cli.js", "start", "--stdio"]
  }
}
```

Restart your MCP client. Hermes boots, exposes its management tools, and
starts the HTTP API on `127.0.0.1:9876`.

## 6. Point container MCPs at Hermes

For each containerized MCP that needs ms365 tokens, set:

```
HERMES_URL=http://host.docker.internal:9876
HERMES_CLIENT_TOKEN=<contents of ~/.hermes/client.token>
```

Store `HERMES_CLIENT_TOKEN` via `thv secret set` (or your equivalent secret
store). Do not commit it to runconfigs.

## Verifying it works

From the MCP client, call `hermes_status` — you should see ms365 listed as a
registered service. Call any ms365 MCP tool that hits Graph. If it succeeds
without an empty-response failure, the end-to-end loop is working.

## Troubleshooting

- **"broker unreachable"** — make sure `hermes start --stdio` is running in your
  MCP client. Check logs via the `hermes_status` tool.
- **"ACQUIRE_REQUIRED"** — tokens have expired and silent refresh failed. Run
  `hermes acquire ms365` to re-authenticate interactively.
- **Firefox profile lock error** — Hermes clears these automatically before
  every launch. If you still see it, delete `~/.hermes/ms365/profile/` and
  retry.
- **"Conditional Access blocked sign-in"** — your host is not compliant with
  the CA policy (missing device cert, not enrolled, etc.). This must be fixed
  at the host level; Hermes cannot bypass it.
```

- [ ] **Step 3: Commit**

Run:
```bash
cd ~/Projects/hermes
git add README.md docs/
git commit -m "phase-1: add README and first-time setup docs"
```

- [ ] **Step 4: Final verification — run all tests**

Run:
```bash
cd ~/Projects/hermes
pnpm -r test
```

Expected: all tests across all packages pass.

- [ ] **Step 5: Final verification — typecheck**

Run:
```bash
cd ~/Projects/hermes
pnpm -r typecheck
```

Expected: exits 0.

- [ ] **Step 6: Final commit tag**

Run:
```bash
cd ~/Projects/hermes
git tag phase-1-complete
git log --oneline | head -30
```

Expected: clean history showing all phase-0 and phase-1 commits.

---

## Phase 1 — Success criteria

After all 25 tasks complete, the following should be true:

1. `thesun` is the only MCP generator in `~/Scripts/mcp-servers/`. `mcp-forge` is archived.
2. `~/Projects/hermes/` is a working pnpm monorepo with three packages: `@hermes/broker`, `@hermes/client`, `@hermes/provider-ms365`.
3. `pnpm -r test` passes across all packages.
4. `hermes start --stdio` starts a broker that listens on `127.0.0.1:9876` and exposes MCP tools over stdio.
5. `hermes acquire ms365` opens a browser on the host, completes login, and stores tokens in the system keyring.
6. `ms365-mcp` container no longer contains Firefox, no longer attempts in-container browser auth, and fetches tokens from Hermes via `HermesClient`.
7. Calling a Graph-backed tool through ms365-mcp returns real data instead of silent empty responses.
8. Concurrent requests to the broker for the same `(service, scheme)` result in a single provider call (not N).
9. Token expiry is measured from the actual JWT `exp` claim, not a TTL guess.
10. All auth failures surface as structured errors with a code and remediation hint — nothing silently returns empty.

---

## Spec coverage check (plan ↔ spec)

Quick self-review mapping spec sections to tasks:

| Spec section | Covered by |
|---|---|
| Local MCP server (dual MCP+HTTP interface) | Tasks 12, 13, 14 |
| Provider interface | Tasks 3, 8, 15, 17 |
| KeyedMutex / concurrent 401 fix | Tasks 5, 10, 20 |
| Post-cache validation | Tasks 9, 10, 17 |
| Proactive refresh based on exp | Tasks 11, 17 |
| Cross-platform credential storage | Task 6 (keytar) |
| Client library with loud failures | Tasks 19, 20 |
| ms365 provider with Conditional Access awareness | Tasks 15–18 |
| Phase 0 kill thesun/mcp-forge duplication | Task 1 |
| End-to-end proof on real container | Tasks 22, 23 |
| First-time setup | Tasks 24, 25 |

Gaps deferred to later phases (per spec non-goals): smart auth detection, multi-MCP-client simultaneous connections, push-MFA UI, third-party provider registry, auto-start wrappers.
