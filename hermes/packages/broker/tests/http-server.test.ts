import { describe, it, expect, afterEach } from 'vitest';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { buildHttpServer } from '../src/http-server.js';
import { createLogger } from '../src/logger.js';
import type { Broker } from '../src/broker.js';
import type { ServiceRegistry } from '../src/registry.js';
import type { TokenBundle } from '../src/types.js';
import type { TokenStorage } from '../src/storage.js';
import type { TokenHealthMonitor } from '../src/health-monitor.js';
import { RefreshScheduler } from '../src/scheduler.js';
import { scheduleFailureRetry, clearFailureBackoff } from '../src/lifecycle.js';

const nullSink = new Writable({ write(_c, _e, cb) { cb(); } });
const logger = createLogger({ level: 'error', stream: nullSink, pretty: false });
const TOKEN = 'shared-secret-value';

const bundle: TokenBundle = {
  service: 'ms365', scheme: 'graph', accessToken: 'abc', tokenType: 'Bearer',
  expiresAt: Date.now() + 3600_000, acquiredAt: Date.now(),
};

const stubRegistry = {
  listProviders() { return []; },
  listServices() { return []; },
} as unknown as ServiceRegistry;

function brokerReturning(result: TokenBundle | Error): Broker {
  return {
    async getToken() { if (result instanceof Error) throw result; return result; },
    async listServices() { return ['ms365']; },
    async reportAuthFailure(input: any) {
      return {
        status: 'recorded',
        service: input.service,
        scheme: input.scheme,
        classification: input.httpStatus === 401 ? 'auth_recovery' : 'transient',
        forceRecovery: input.httpStatus === 401,
        credentialStatus: input.httpStatus === 401 ? 'suspect' : 'degraded',
        guidance: {
          retryable: true,
          retryAfterMs: input.httpStatus === 401 ? 0 : 30_000,
          nextAction: input.httpStatus === 401 ? 'request_fresh_token_then_retry_downstream' : 'retry_downstream_without_reauth',
          remediation: 'retry with guidance',
        },
        report: input,
      };
    },
  } as unknown as Broker;
}

function healthyStorage(bundles: TokenBundle[]) {
  return { async list() { return bundles; } } as unknown as TokenStorage;
}

function healthMonitorReporting(entries: Array<{ service: string; scheme: string; status: string }>) {
  return { status() { return entries; } } as unknown as TokenHealthMonitor;
}

/** Gate result stub for canAttemptAcquire, matching broker.canAttemptAcquire. */
function brokerWithGate(gate: { ok: boolean; reason?: string; retryAfterMs?: number }): Broker {
  return { canAttemptAcquire: () => gate } as unknown as Broker;
}

describe('httpServer', () => {
  let app: FastifyInstance;
  afterEach(async () => { if (app) await app.close(); });

  it('GET /health returns ok without auth', async () => {
    app = buildHttpServer({ broker: brokerReturning(bundle), registry: stubRegistry, clientToken: TOKEN, logger });
    const r = await app.inject({ method: 'GET', url: '/health' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: 'ok' });
  });
  // THE regression guard for the fleetd restart loop. fleetd treats only 200 as
  // healthy and kills the broker after 3 consecutive non-200s, and a restart
  // cannot fix a stale credential, so credential state must never reach the
  // status code. If this test ever fails, hermes is one bad token away from a
  // supervised restart loop that ends with the circuit breaker tripped.
  it('GET /health stays 200 while credentials are degraded', async () => {
    app = buildHttpServer({
      broker: brokerReturning(bundle), registry: stubRegistry, clientToken: TOKEN, logger,
      storage: healthyStorage([bundle]),
      healthMonitor: healthMonitorReporting([
        { service: 'ms365', scheme: 'graph', status: 'expired' },
      ]),
    });
    const r = await app.inject({ method: 'GET', url: '/health' });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body).toMatchObject({ status: 'ok', probe: 'liveness' });
    // The degraded credential is still reported, in the body only.
    const tokens = body.checks.find((c: any) => c.name === 'tokens');
    expect(tokens).toMatchObject({ status: 'degraded' });
  });

  it('GET /health returns 503 only when the broker cannot serve at all', async () => {
    app = buildHttpServer({
      broker: brokerReturning(bundle), registry: stubRegistry, clientToken: TOKEN, logger,
      storage: { async list() { throw new Error('vault inventory unreadable'); } } as any,
    });
    const r = await app.inject({ method: 'GET', url: '/health' });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toMatchObject({ status: 'degraded' });
  });

  it('rejects /token without bearer', async () => {
    app = buildHttpServer({ broker: brokerReturning(bundle), registry: stubRegistry, clientToken: TOKEN, logger });
    const r = await app.inject({ method: 'GET', url: '/token/ms365/graph' });
    expect(r.statusCode).toBe(401);
  });
  it('rejects /token with wrong bearer', async () => {
    app = buildHttpServer({ broker: brokerReturning(bundle), registry: stubRegistry, clientToken: TOKEN, logger });
    const r = await app.inject({ method: 'GET', url: '/token/ms365/graph', headers: { authorization: 'Bearer wrong' } });
    expect(r.statusCode).toBe(401);
  });
  it('returns token bundle when authorized', async () => {
    app = buildHttpServer({ broker: brokerReturning(bundle), registry: stubRegistry, clientToken: TOKEN, logger });
    const r = await app.inject({ method: 'GET', url: '/token/ms365/graph', headers: { authorization: `Bearer ${TOKEN}` } });
    expect(r.statusCode).toBe(200);
    expect(r.json().accessToken).toBe('abc');
  });
  it('maps HermesError to structured JSON', async () => {
    const { HermesError, HermesErrorCode } = await import('../src/errors.js');
    const err = new HermesError(HermesErrorCode.ACQUIRE_REQUIRED, 'need login', { remediation: 'run hermes acquire ms365' });
    app = buildHttpServer({ broker: brokerReturning(err), registry: stubRegistry, clientToken: TOKEN, logger });
    const r = await app.inject({ method: 'GET', url: '/token/ms365/graph', headers: { authorization: `Bearer ${TOKEN}` } });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ code: 'ACQUIRE_REQUIRED', remediation: 'run hermes acquire ms365' });
  });

  it('maps INTERACTIVE_AUTH_REQUIRED to 409', async () => {
    const { HermesError, HermesErrorCode } = await import('../src/errors.js');
    const err = new HermesError(HermesErrorCode.INTERACTIVE_AUTH_REQUIRED, 'refresh token expired', { remediation: 'run: hermes acquire ms365', remediationCommands: ['hermes acquire ms365'] });
    app = buildHttpServer({ broker: brokerReturning(err), registry: stubRegistry, clientToken: TOKEN, logger });
    const r = await app.inject({ method: 'GET', url: '/token/ms365/graph', headers: { authorization: `Bearer ${TOKEN}` } });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ code: 'INTERACTIVE_AUTH_REQUIRED', category: 'auth-required', retryable: false, remediation: 'run: hermes acquire ms365', remediationCommands: ['hermes acquire ms365'] });
  });

  it('serializes transient retry metadata and Retry-After header', async () => {
    const { HermesError, HermesErrorCategory, HermesErrorCode } = await import('../src/errors.js');
    const err = new HermesError(HermesErrorCode.REFRESH_FAILED, 'issuer unavailable', {
      category: HermesErrorCategory.TRANSIENT,
      retryable: true,
      retryAfterMs: 1500,
      remediation: 'retry after 2s',
    });
    app = buildHttpServer({ broker: brokerReturning(err), registry: stubRegistry, clientToken: TOKEN, logger });
    const r = await app.inject({ method: 'GET', url: '/token/ms365/graph', headers: { authorization: `Bearer ${TOKEN}` } });
    expect(r.statusCode).toBe(409);
    expect(r.headers['retry-after']).toBe('2');
    expect(r.json()).toMatchObject({
      code: 'REFRESH_FAILED',
      category: 'transient',
      retryable: true,
      retryHint: 'retry-after',
      retryAfterMs: 1500,
    });
  });

  it('rejects interactive query param', async () => {
    app = buildHttpServer({ broker: brokerReturning(bundle), registry: stubRegistry, clientToken: TOKEN, logger });
    const resp = await app.inject({
      method: 'GET',
      url: '/token/test-svc/graph?interactive=true',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(resp.statusCode).toBe(400);
    expect(resp.json().code).toBe('BAD_REQUEST');
  });

  it('rejects headless query param', async () => {
    app = buildHttpServer({ broker: brokerReturning(bundle), registry: stubRegistry, clientToken: TOKEN, logger });
    const resp = await app.inject({
      method: 'GET',
      url: '/token/test-svc/graph?headless=false',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(resp.statusCode).toBe(400);
    expect(resp.json().code).toBe('BAD_REQUEST');
  });

  it('POST /token/:service/:scheme/report-failure records downstream auth failure guidance', async () => {
    app = buildHttpServer({ broker: brokerReturning(bundle), registry: stubRegistry, clientToken: TOKEN, logger });
    const resp = await app.inject({
      method: 'POST',
      url: '/token/servicenow/session/report-failure',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        httpStatus: 401,
        backend: 'servicenow-mcp',
        tool: 'incident.list',
        endpointClass: 'table-api',
        errorEvidence: { authorization: 'Bearer secret-token' },
      }),
    });

    expect(resp.statusCode).toBe(200);
    expect(resp.headers['retry-after']).toBe('0');
    expect(resp.json()).toMatchObject({
      status: 'recorded',
      service: 'servicenow',
      scheme: 'session',
      classification: 'auth_recovery',
      forceRecovery: true,
      guidance: {
        retryable: true,
        nextAction: 'request_fresh_token_then_retry_downstream',
      },
    });
  });

  it('/mcp registers session on initialize and accepts follow-up requests', async () => {
    app = buildHttpServer({ broker: brokerReturning(bundle), registry: stubRegistry, clientToken: TOKEN, logger });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as { port: number }).port;
    const url = `http://127.0.0.1:${port}/mcp`;
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };

    // POST 1: initialize (no session id) — server generates one and returns it.
    const initBody = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'lane-d-test', version: '0.0.0' },
      },
    };
    const r1 = await fetch(url, { method: 'POST', headers, body: JSON.stringify(initBody) });
    // drain the body so the underlying socket can be released even if SSE
    await r1.text();
    expect(r1.status).toBe(200);
    const sid1 = r1.headers.get('mcp-session-id');
    expect(sid1).toBeTruthy();

    // POST 2: follow-up with the issued session id — must NOT 400/500.
    const listBody = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };
    const r2 = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'mcp-session-id': sid1 as string },
      body: JSON.stringify(listBody),
    });
    await r2.text();
    expect(r2.status).toBe(200);

    // POST 3: another fresh initialize on the same server — gets a different session id.
    const r3 = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...initBody, id: 3 }),
    });
    await r3.text();
    expect(r3.status).toBe(200);
    const sid3 = r3.headers.get('mcp-session-id');
    expect(sid3).toBeTruthy();
    expect(sid3).not.toBe(sid1);
  });

  it('/mcp supports stateless tools/list without a session id', async () => {
    app = buildHttpServer({ broker: brokerReturning(bundle), registry: stubRegistry, clientToken: TOKEN, logger });
    const r = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      payload: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/list', params: {} }),
    });

    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      jsonrpc: '2.0',
      id: 10,
      result: {
        tools: expect.arrayContaining([
          expect.objectContaining({ name: 'hermes_status' }),
        ]),
      },
    });
  });

  it('/mcp supports stateless tools/call without a session id', async () => {
    app = buildHttpServer({ broker: brokerReturning(bundle), registry: stubRegistry, clientToken: TOKEN, logger });
    const r = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      payload: JSON.stringify({
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: { name: 'hermes_status', arguments: {} },
      }),
    });

    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe(11);
    const text = body.result.content[0].text;
    expect(JSON.parse(text)).toMatchObject({ services: ['ms365'], providers: [] });
  });

  it('/mcp returns a JSON-RPC error for unknown stateless tools/call names', async () => {
    app = buildHttpServer({ broker: brokerReturning(bundle), registry: stubRegistry, clientToken: TOKEN, logger });
    const r = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      payload: JSON.stringify({
        jsonrpc: '2.0',
        id: 12,
        method: 'tools/call',
        params: { name: 'not_a_real_tool', arguments: {} },
      }),
    });

    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({
      jsonrpc: '2.0',
      id: 12,
      error: { code: -32601, message: 'unknown tool: not_a_real_tool' },
    });
  });

  it('/mcp stateless tools/call surfaces auth remediation in tool content', async () => {
    const { HermesError, HermesErrorCode } = await import('../src/errors.js');
    const err = new HermesError(HermesErrorCode.INTERACTIVE_AUTH_REQUIRED, 'refresh token expired', {
      remediation: 'run: hermes acquire ms365',
      remediationCommands: ['hermes acquire ms365'],
    });
    app = buildHttpServer({ broker: brokerReturning(err), registry: stubRegistry, clientToken: TOKEN, logger });
    const r = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      payload: JSON.stringify({
        jsonrpc: '2.0',
        id: 13,
        method: 'tools/call',
        params: { name: 'hermes_force_refresh', arguments: { service: 'ms365', scheme: 'graph' } },
      }),
    });

    expect(r.statusCode).toBe(200);
    const body = r.json();
    const text = body.result.content[0].text;
    expect(JSON.parse(text)).toMatchObject({
      status: 'error',
      error: {
        code: 'INTERACTIVE_AUTH_REQUIRED',
        category: 'auth-required',
        retryable: false,
        remediationCommands: ['hermes acquire ms365'],
      },
    });
  });
});

// --- /health/credentials: the operator view that MAY go red (fleetd does not probe it) ---

describe('httpServer /health/credentials', () => {
  let app3: FastifyInstance;
  const DISARMED_SERVICE = 'disarmed-test-service';
  afterEach(async () => {
    if (app3) await app3.close();
    // Disarm state is module-level in lifecycle.ts; do not leak it between tests.
    clearFailureBackoff(DISARMED_SERVICE, 'graph');
  });

  it('requires a bearer token (it enumerates which credentials are weak)', async () => {
    app3 = buildHttpServer({
      broker: brokerWithGate({ ok: true }), registry: stubRegistry, clientToken: TOKEN, logger,
      storage: healthyStorage([bundle]),
    });
    const r = await app3.inject({ method: 'GET', url: '/health/credentials' });
    expect(r.statusCode).toBe(401);
  });

  it('reports ok when every credential can be acquired', async () => {
    app3 = buildHttpServer({
      broker: brokerWithGate({ ok: true }), registry: stubRegistry, clientToken: TOKEN, logger,
      storage: healthyStorage([bundle]),
    });
    const r = await app3.inject({ method: 'GET', url: '/health/credentials', headers: { authorization: `Bearer ${TOKEN}` } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: 'ok', total: 1, degraded: 0, disarmed: 0 });
  });

  it('reports a disarmed service with the exact recovery command', async () => {
    // Drive the REAL disarm path rather than mocking it: two consecutive
    // online failures stop the scheduler re-arming for this key.
    const scheduler = new RefreshScheduler({ logger, refresh: async () => {} });
    scheduleFailureRetry(scheduler, DISARMED_SERVICE, 'graph', new Error('sso capture degraded'), logger);
    scheduleFailureRetry(scheduler, DISARMED_SERVICE, 'graph', new Error('sso capture degraded'), logger);
    scheduler.cancelAll();

    const disarmedBundle: TokenBundle = { ...bundle, service: DISARMED_SERVICE, scheme: 'graph' };
    app3 = buildHttpServer({
      broker: brokerWithGate({ ok: true }), registry: stubRegistry, clientToken: TOKEN, logger,
      storage: healthyStorage([disarmedBundle]),
    });
    const r = await app3.inject({ method: 'GET', url: '/health/credentials', headers: { authorization: `Bearer ${TOKEN}` } });

    // MAY go red here, because nothing supervises this route.
    expect(r.statusCode).toBe(503);
    const body = r.json();
    expect(body).toMatchObject({ status: 'degraded', disarmed: 1 });
    expect(body.credentials[0]).toMatchObject({
      service: DISARMED_SERVICE,
      scheme: 'graph',
      healthy: false,
      proactiveRefresh: { disarmed: true, consecutiveFailures: 2 },
      nextAction: `hermes acquire ${DISARMED_SERVICE}`,
    });
  });

  it('reports why the broker cannot acquire, with the wait the gate computed', async () => {
    app3 = buildHttpServer({
      broker: brokerWithGate({ ok: false, reason: 'cooldown', retryAfterMs: 45_000 }),
      registry: stubRegistry, clientToken: TOKEN, logger,
      storage: healthyStorage([bundle]),
    });
    const r = await app3.inject({ method: 'GET', url: '/health/credentials', headers: { authorization: `Bearer ${TOKEN}` } });
    expect(r.statusCode).toBe(503);
    expect(r.json().credentials[0]).toMatchObject({ healthy: false, blockedBy: 'cooldown', retryAfterMs: 45_000 });
  });

  it('never emits a credential value in either health response', async () => {
    // Synthetic, clearly-fake token material assembled at runtime.
    const secretish = 'SYNTHETIC' + '-not-a-real-token-' + '0123456789abcdef';
    const secretBundle: TokenBundle = {
      ...bundle,
      accessToken: secretish,
      refreshToken: secretish + '-refresh',
      extra: { idToken: secretish + '-id' },
    };
    app3 = buildHttpServer({
      broker: brokerWithGate({ ok: true }), registry: stubRegistry, clientToken: TOKEN, logger,
      storage: healthyStorage([secretBundle]),
      healthMonitor: healthMonitorReporting([{ service: 'ms365', scheme: 'graph', status: 'expired' }]),
    });

    const creds = await app3.inject({ method: 'GET', url: '/health/credentials', headers: { authorization: `Bearer ${TOKEN}` } });
    const live = await app3.inject({ method: 'GET', url: '/health' });
    for (const body of [creds.body, live.body]) {
      expect(body).not.toContain(secretish);
      expect(body).not.toContain('accessToken');
      expect(body).not.toContain('refreshToken');
      expect(body).not.toContain(TOKEN);
    }
    // Names and state ARE present; that is the point of the endpoint.
    expect(creds.body).toContain('ms365');
    expect(creds.body).toContain('graph');
  });
});

// --- Workstream B: OFFLINE mapping, offline-grace header, consumer rate limit ---
import { HermesError, HermesErrorCode } from '../src/errors.js';

describe('httpServer offline + rate limit', () => {
  let app2: FastifyInstance;
  afterEach(async () => { if (app2) await app2.close(); });

  it('maps OFFLINE to 503 with body code OFFLINE and a Retry-After header (distinct from REFRESH_IN_PROGRESS)', async () => {
    const offlineErr = new HermesError(HermesErrorCode.OFFLINE, 'broker is offline', { retryAfterMs: 30_000, retryable: true });
    app2 = buildHttpServer({ broker: brokerReturning(offlineErr), registry: stubRegistry, clientToken: TOKEN, logger });
    const r = await app2.inject({ method: 'GET', url: '/token/ms365/graph', headers: { authorization: `Bearer ${TOKEN}` } });
    expect(r.statusCode).toBe(503);
    expect(r.headers['retry-after']).toBe('30');
    expect(r.json()).toMatchObject({ code: 'OFFLINE', retryable: true, retryAfterMs: 30_000 });
  });

  it('sets X-Hermes-Offline-Grace when the broker serves a grace-flagged cached token', async () => {
    const graceBundle: TokenBundle = { ...bundle, extra: { hermesOfflineGrace: true } };
    app2 = buildHttpServer({ broker: brokerReturning(graceBundle), registry: stubRegistry, clientToken: TOKEN, logger });
    const r = await app2.inject({ method: 'GET', url: '/token/ms365/graph', headers: { authorization: `Bearer ${TOKEN}` } });
    expect(r.statusCode).toBe(200);
    expect(r.headers['x-hermes-offline-grace']).toBe('true');
  });

  it('does not set the grace header on normal responses', async () => {
    app2 = buildHttpServer({ broker: brokerReturning(bundle), registry: stubRegistry, clientToken: TOKEN, logger });
    const r = await app2.inject({ method: 'GET', url: '/token/ms365/graph', headers: { authorization: `Bearer ${TOKEN}` } });
    expect(r.statusCode).toBe(200);
    expect(r.headers['x-hermes-offline-grace']).toBeUndefined();
  });

  it('rate-limits /token per service:scheme with 429 RATE_LIMITED + Retry-After', async () => {
    app2 = buildHttpServer({
      broker: brokerReturning(bundle), registry: stubRegistry, clientToken: TOKEN, logger,
      consumerRateLimit: { maxTokenRequestsPer10s: 3 },
    });
    const statuses: number[] = [];
    let limited: any;
    for (let i = 0; i < 5; i++) {
      const r = await app2.inject({ method: 'GET', url: '/token/ms365/graph', headers: { authorization: `Bearer ${TOKEN}` } });
      statuses.push(r.statusCode);
      if (r.statusCode === 429) limited = r;
    }
    expect(statuses.filter((s) => s === 200)).toHaveLength(3);
    expect(statuses.filter((s) => s === 429)).toHaveLength(2);
    expect(limited.headers['retry-after']).toBeDefined();
    expect(limited.json()).toMatchObject({ code: 'RATE_LIMITED', retryable: true });
    // Different key is unaffected.
    const other = await app2.inject({ method: 'GET', url: '/token/ms365/teams', headers: { authorization: `Bearer ${TOKEN}` } });
    expect(other.statusCode).toBe(200);
  });

  // Fairness: keying the limiter only on service:scheme let one hot consumer
  // burn the whole window and 429 every other consumer of the same service,
  // so the misbehaving process was never the one that suffered.
  it('a hot consumer trips its own bucket without starving a polite consumer of the same service', async () => {
    app2 = buildHttpServer({
      broker: brokerReturning(bundle), registry: stubRegistry, clientToken: TOKEN, logger,
      consumerRateLimit: { maxTokenRequestsPer10s: 3 },
    });
    const call = (consumer: string) => app2.inject({
      method: 'GET',
      url: '/token/ms365/graph',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-hermes-consumer': consumer },
    });

    const hot: number[] = [];
    for (let i = 0; i < 6; i++) hot.push((await call('hot-loop-server')).statusCode);
    expect(hot.filter((s) => s === 200)).toHaveLength(3);
    expect(hot.filter((s) => s === 429)).toHaveLength(3);

    // The polite consumer still gets its full per-consumer allowance.
    const polite: number[] = [];
    for (let i = 0; i < 3; i++) polite.push((await call('polite-server')).statusCode);
    expect(polite).toEqual([200, 200, 200]);
  });

  it('reports which limit was hit and holds an aggregate per-service ceiling', async () => {
    app2 = buildHttpServer({
      broker: brokerReturning(bundle), registry: stubRegistry, clientToken: TOKEN, logger,
      consumerRateLimit: { maxTokenRequestsPer10s: 2 },
    });
    const call = (consumer: string) => app2.inject({
      method: 'GET',
      url: '/token/ms365/graph',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-hermes-consumer': consumer },
    });

    const own = [await call('c1'), await call('c1'), await call('c1')];
    expect(own[2]!.statusCode).toBe(429);
    expect(own[2]!.json()).toMatchObject({ code: 'RATE_LIMITED', scope: 'consumer' });

    // Ceiling is 2 * 4 = 8 for the service; c1 spent 2, so c2..c4 fill it.
    for (const c of ['c2', 'c3', 'c4']) { await call(c); await call(c); }
    const overCeiling = await call('c5');
    expect(overCeiling.statusCode).toBe(429);
    expect(overCeiling.json()).toMatchObject({ code: 'RATE_LIMITED', scope: 'service' });
  });

  it('25 rapid /token calls at the default limit produce at least one 429', async () => {
    app2 = buildHttpServer({ broker: brokerReturning(bundle), registry: stubRegistry, clientToken: TOKEN, logger });
    const results = await Promise.all(Array.from({ length: 25 }, () =>
      app2.inject({ method: 'GET', url: '/token/ms365/graph', headers: { authorization: `Bearer ${TOKEN}` } })));
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);
    expect(codes.filter((s) => s === 200)).toHaveLength(20);
  });
});
