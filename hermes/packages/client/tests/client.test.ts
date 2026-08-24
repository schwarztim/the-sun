import { describe, it, expect, vi } from 'vitest';
import { classifyAuthResponse, credentialHeaders, HermesClient, type ClientFetch } from '../src/client.js';
import { HermesClientErrorCode } from '../src/errors.js';

const okBundle = {
  service: 'ms365', scheme: 'graph', accessToken: 'abc', tokenType: 'Bearer',
  expiresAt: Date.now() + 3600_000, acquiredAt: Date.now(),
};

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}

function okFetch(): ClientFetch {
  return async () => jsonResponse(200, okBundle);
}

describe('HermesClient.getToken', () => {
  it('returns the bundle on 200', async () => {
    const c = new HermesClient({ brokerUrl: 'http://localhost:9876', clientToken: 'tok', fetch: okFetch() });
    expect((await c.getToken('ms365', 'graph')).accessToken).toBe('abc');
  });
  it('sends bearer header', async () => {
    const f = vi.fn(okFetch());
    const c = new HermesClient({ brokerUrl: 'http://localhost:9876', clientToken: 'tok', fetch: f });
    await c.getToken('ms365', 'graph');
    expect((f as any).mock.calls[0][1].headers.Authorization).toBe('Bearer tok');
  });
  it('maps 409 ACQUIRE_REQUIRED to client error', async () => {
    const c = new HermesClient({
      brokerUrl: 'http://localhost:9876', clientToken: 'tok',
      fetch: async () => ({ ok: false, status: 409, async json() { return { code: 'ACQUIRE_REQUIRED', message: 'need login', remediation: 'run acquire' }; }, async text() { return ''; } }),
    });
    try { await c.getToken('ms365', 'graph'); throw new Error('expected throw'); }
    catch (e: any) { expect(e.code).toBe(HermesClientErrorCode.ACQUIRE_REQUIRED); expect(e.remediation).toBe('run acquire'); }
  });
  it('does not retry human-action auth errors', async () => {
    let calls = 0;
    const c = new HermesClient({
      brokerUrl: 'http://localhost:9876', clientToken: 'tok', retries: 2, retryDelayMs: 1,
      fetch: async () => {
        calls++;
        return {
          ok: false,
          status: 409,
          async json() {
            return {
              code: 'INTERACTIVE_AUTH_REQUIRED',
              message: 'refresh token expired',
              category: 'auth-required',
              retryable: false,
              remediation: 'run: hermes acquire ms365',
              remediationCommands: ['hermes acquire ms365'],
            };
          },
          async text() { return ''; },
        };
      },
    });
    await expect(c.getToken('ms365', 'graph')).rejects.toMatchObject({
      code: HermesClientErrorCode.ACQUIRE_REQUIRED,
      retryable: false,
      remediationCommands: ['hermes acquire ms365'],
    });
    expect(calls).toBe(1);
  });
  it('retries retryable broker responses', async () => {
    let calls = 0;
    const c = new HermesClient({
      brokerUrl: 'http://localhost:9876', clientToken: 'tok', retries: 2, retryDelayMs: 1,
      fetch: async () => {
        calls++;
        if (calls < 2) {
          return {
            ok: false,
            status: 409,
            async json() {
              return {
                code: 'REFRESH_FAILED',
                message: 'issuer unavailable',
                category: 'transient',
                retryable: true,
                retryAfterMs: 1,
              };
            },
            async text() { return ''; },
          };
        }
        return { ok: true, status: 200, async json() { return okBundle; }, async text() { return ''; } };
      },
    });
    expect((await c.getToken('ms365', 'graph')).accessToken).toBe('abc');
    expect(calls).toBe(2);
  });
  it('maps 404 SERVICE_NOT_REGISTERED', async () => {
    const c = new HermesClient({
      brokerUrl: 'http://localhost:9876', clientToken: 'tok',
      fetch: async () => ({ ok: false, status: 404, async json() { return { code: 'SERVICE_NOT_REGISTERED', message: 'nope' }; }, async text() { return ''; } }),
    });
    await expect(c.getToken('nope', 'graph')).rejects.toMatchObject({ code: HermesClientErrorCode.SERVICE_NOT_REGISTERED });
  });
  it('retries transient failures then throws BROKER_UNREACHABLE', async () => {
    let calls = 0;
    const c = new HermesClient({
      brokerUrl: 'http://localhost:9876', clientToken: 'tok', retries: 2, retryDelayMs: 1,
      fetch: async () => { calls++; throw new Error('ECONNREFUSED'); },
    });
    await expect(c.getToken('ms365', 'graph')).rejects.toMatchObject({ code: HermesClientErrorCode.BROKER_UNREACHABLE });
    expect(calls).toBe(3);
  });
  it('dedups concurrent calls for the same service:scheme', async () => {
    let calls = 0;
    const c = new HermesClient({
      brokerUrl: 'http://localhost:9876', clientToken: 'tok',
      fetch: async () => { calls++; await new Promise((r) => setTimeout(r, 20)); return { ok: true, status: 200, async json() { return okBundle; }, async text() { return ''; } }; },
    });
    await Promise.all([c.getToken('ms365', 'graph'), c.getToken('ms365', 'graph'), c.getToken('ms365', 'graph')]);
    expect(calls).toBe(1);
  });
  it('NEVER returns empty/null on failure — always throws', async () => {
    const c = new HermesClient({
      brokerUrl: 'http://localhost:9876', clientToken: 'tok',
      fetch: async () => ({ ok: true, status: 200, async json() { return {} as any; }, async text() { return ''; } }),
    });
    await expect(c.getToken('ms365', 'graph')).rejects.toMatchObject({ code: HermesClientErrorCode.INVALID_RESPONSE });
  });

  it('reports downstream auth failures to the broker', async () => {
    const f = vi.fn(async (_url: string, init: any) => ({
      ok: true,
      status: 200,
      async json() {
        return {
          status: 'recorded',
          service: 'servicenow',
          scheme: 'session',
          classification: 'auth_recovery',
          forceRecovery: true,
          credentialStatus: 'suspect',
          guidance: {
            retryable: true,
            retryAfterMs: 0,
            nextAction: 'request_fresh_token_then_retry_downstream',
            remediation: 'request a fresh token',
          },
          report: { httpStatus: 401 },
        };
      },
      async text() { return ''; },
    }));
    const c = new HermesClient({ brokerUrl: 'http://localhost:9876', clientToken: 'tok', fetch: f });

    const result = await c.reportAuthFailure('servicenow', 'session', {
      httpStatus: 401,
      backend: 'servicenow-mcp',
      tool: 'incident.list',
      errorEvidence: { authorization: 'Bearer secret-token' },
    });

    expect(f).toHaveBeenCalledWith(
      'http://localhost:9876/token/servicenow/session/report-failure',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer tok',
          'Content-Type': 'application/json',
        }),
        body: expect.stringContaining('"httpStatus":401'),
      }),
    );
    expect(result).toMatchObject({
      status: 'recorded',
      classification: 'auth_recovery',
      guidance: { nextAction: 'request_fresh_token_then_retry_downstream' },
    });
  });

  it('materializes provider-neutral credentials for bearer, cookie, and API-token shapes', async () => {
    const c = new HermesClient({ brokerUrl: 'http://localhost:9876', clientToken: 'tok', fetch: okFetch() });
    await expect(c.getCredential('ms365', 'graph')).resolves.toMatchObject({
      token: 'abc',
      headers: { Authorization: 'Bearer abc' },
    });
    expect(credentialHeaders({ ...okBundle, accessToken: 'sid=123', tokenType: 'Cookie' })).toEqual({ Cookie: 'sid=123' });
    expect(credentialHeaders({ ...okBundle, accessToken: 'api-key', tokenType: 'api-token' })).toEqual({ 'X-API-Token': 'api-key' });
    expect(credentialHeaders({ ...okBundle, accessToken: 'api-key', tokenType: 'api-token' }, { headerName: 'X-Api-Key' })).toEqual({ 'X-Api-Key': 'api-key' });
  });

  it('classifies 401/403/invalid_session/csrf_failed as auth failures but not 5xx', async () => {
    await expect(classifyAuthResponse(jsonResponse(401, { code: 'unauthorized' }))).resolves.toMatchObject({
      authFailure: true,
      httpStatus: 401,
    });
    await expect(classifyAuthResponse(jsonResponse(403, { code: 'forbidden' }))).resolves.toMatchObject({
      authFailure: true,
      httpStatus: 403,
    });
    await expect(classifyAuthResponse({ status: 200, body: { code: 'invalid_session' } })).resolves.toMatchObject({
      authFailure: true,
      failureCode: 'invalid_session',
    });
    await expect(classifyAuthResponse({ status: 419, body: { code: 'csrf_failed' } })).resolves.toMatchObject({
      authFailure: true,
      failureCode: 'csrf_failed',
    });
    await expect(classifyAuthResponse(jsonResponse(503, { code: 'upstream_down' }))).resolves.toMatchObject({
      authFailure: false,
      httpStatus: 503,
    });
  });

  it('withHermesAuthRetry reports a downstream 401 and safely retries with a fresh credential', async () => {
    const tokenBodies = [
      { service: 'servicenow', scheme: 'session', accessToken: 'sid=stale', tokenType: 'Cookie', expiresAt: Date.now() + 3600_000, acquiredAt: Date.now() },
      { service: 'servicenow', scheme: 'session', accessToken: 'sid=fresh', tokenType: 'Cookie', expiresAt: Date.now() + 3600_000, acquiredAt: Date.now() },
    ];
    const brokerFetch = vi.fn(async (url: string, init: any) => {
      if (url.endsWith('/report-failure')) {
        expect(JSON.parse(init.body)).toMatchObject({
          httpStatus: 401,
          failureCode: 'invalid_session',
          backend: 'servicenow-mcp',
          tool: 'incident.list',
          endpointClass: 'table-api',
        });
        return jsonResponse(200, {
          status: 'recorded',
          service: 'servicenow',
          scheme: 'session',
          classification: 'auth_recovery',
          forceRecovery: true,
          credentialStatus: 'suspect',
          guidance: {
            retryable: true,
            retryAfterMs: 0,
            nextAction: 'request_fresh_token_then_retry_downstream',
            remediation: 'request a fresh token',
          },
          report: { httpStatus: 401 },
        });
      }
      const next = tokenBodies.shift();
      if (!next) throw new Error('unexpected token request');
      return jsonResponse(200, next);
    });
    const c = new HermesClient({ brokerUrl: 'http://localhost:9876', clientToken: 'tok', fetch: brokerFetch });
    let downstreamCalls = 0;

    const result = await c.withHermesAuthRetry('servicenow', 'session', async (credential) => {
      downstreamCalls++;
      if (downstreamCalls === 1) {
        expect(credential.headers).toEqual({ Cookie: 'sid=stale' });
        return jsonResponse(401, { code: 'invalid_session' });
      }
      expect(credential.headers).toEqual({ Cookie: 'sid=fresh' });
      return jsonResponse(200, { ok: true });
    }, { backend: 'servicenow-mcp', tool: 'incident.list', endpointClass: 'table-api' });

    expect(result.status).toBe(200);
    expect(downstreamCalls).toBe(2);
    expect(brokerFetch).toHaveBeenCalledTimes(3);
  });

  it('withHermesAuthRetry does not report or reauth for non-auth 5xx responses', async () => {
    const brokerFetch = vi.fn(okFetch());
    const c = new HermesClient({ brokerUrl: 'http://localhost:9876', clientToken: 'tok', fetch: brokerFetch });
    const result = await c.withHermesAuthRetry('ms365', 'graph', async () => jsonResponse(503, { code: 'upstream_down' }));

    expect(result.status).toBe(503);
    expect(brokerFetch).toHaveBeenCalledTimes(1);
    expect(brokerFetch.mock.calls[0]?.[0]).toBe('http://localhost:9876/token/ms365/graph');
  });

  it('withHermesAuthRetry surfaces exact human-action remediation from Hermes', async () => {
    let tokenRequests = 0;
    const brokerFetch = vi.fn(async (url: string) => {
      if (url.endsWith('/report-failure')) {
        return jsonResponse(200, {
          status: 'recorded',
          service: 'servicenow',
          scheme: 'session',
          classification: 'auth_recovery',
          forceRecovery: true,
          credentialStatus: 'suspect',
          guidance: {
            retryable: true,
            retryAfterMs: 0,
            nextAction: 'request_fresh_token_then_retry_downstream',
            remediation: 'request a fresh token',
          },
          report: { httpStatus: 401 },
        });
      }
      tokenRequests++;
      if (tokenRequests === 1) {
        return jsonResponse(200, { service: 'servicenow', scheme: 'session', accessToken: 'sid=stale', tokenType: 'Cookie', expiresAt: Date.now() + 3600_000, acquiredAt: Date.now() });
      }
      return {
        ok: false,
        status: 409,
        async json() {
          return {
            code: 'INTERACTIVE_AUTH_REQUIRED',
            message: 'refresh token expired',
            category: 'auth-required',
            retryable: false,
            remediation: 'run: hermes acquire servicenow',
            remediationCommands: ['hermes acquire servicenow'],
          };
        },
        async text() { return ''; },
      };
    });
    const c = new HermesClient({ brokerUrl: 'http://localhost:9876', clientToken: 'tok', fetch: brokerFetch, retryDelayMs: 1 });

    await expect(c.withHermesAuthRetry('servicenow', 'session', async () => jsonResponse(401, { code: 'csrf_failed' }))).rejects.toMatchObject({
      code: HermesClientErrorCode.ACQUIRE_REQUIRED,
      remediation: 'run: hermes acquire servicenow',
      remediationCommands: ['hermes acquire servicenow'],
    });
    expect(tokenRequests).toBe(2);
  });

  it('withHermesAuthRetry honors maxAuthRetries and stops repeated auth failures', async () => {
    const tokenBodies = [
      { service: 'servicenow', scheme: 'session', accessToken: 'sid=one', tokenType: 'Cookie', expiresAt: Date.now() + 3600_000, acquiredAt: Date.now() },
      { service: 'servicenow', scheme: 'session', accessToken: 'sid=two', tokenType: 'Cookie', expiresAt: Date.now() + 3600_000, acquiredAt: Date.now() },
      { service: 'servicenow', scheme: 'session', accessToken: 'sid=three', tokenType: 'Cookie', expiresAt: Date.now() + 3600_000, acquiredAt: Date.now() },
    ];
    const brokerFetch = vi.fn(async (url: string) => {
      if (url.endsWith('/report-failure')) {
        return jsonResponse(200, {
          status: 'recorded',
          service: 'servicenow',
          scheme: 'session',
          classification: 'auth_recovery',
          forceRecovery: true,
          credentialStatus: 'suspect',
          guidance: {
            retryable: true,
            retryAfterMs: 0,
            nextAction: 'request_fresh_token_then_retry_downstream',
            remediation: 'request a fresh token',
          },
          report: { httpStatus: 401 },
        });
      }
      const next = tokenBodies.shift();
      if (!next) throw new Error('unexpected token request');
      return jsonResponse(200, next);
    });
    const c = new HermesClient({ brokerUrl: 'http://localhost:9876', clientToken: 'tok', fetch: brokerFetch });
    let downstreamCalls = 0;

    await expect(c.withHermesAuthRetry(
      'servicenow',
      'session',
      async () => {
        downstreamCalls++;
        return jsonResponse(401, { code: 'invalid_session' });
      },
      { maxAuthRetries: 2 },
    )).rejects.toMatchObject({
      code: HermesClientErrorCode.ACQUIRE_REQUIRED,
      remediation: 'request a fresh token',
    });

    expect(downstreamCalls).toBe(3);
    expect(brokerFetch.mock.calls.filter(([url]) => String(url).endsWith('/report-failure'))).toHaveLength(3);
    expect(brokerFetch.mock.calls.filter(([url]) => String(url).endsWith('/token/servicenow/session'))).toHaveLength(3);
  });
});

// --- Workstream B: OFFLINE / RATE_LIMITED handling, retry matrix ---
import { afterEach } from 'vitest';

describe('HermesClient offline + rate limit behavior', () => {
  afterEach(() => { vi.useRealTimers(); });

  function offlineFetch(counter: { calls: number }): ClientFetch {
    return async () => {
      counter.calls++;
      return {
        ok: false, status: 503,
        async json() {
          return { code: 'OFFLINE', message: 'broker is offline', retryable: true, retryAfterMs: 30_000, retryHint: 'retry-after' };
        },
        async text() { return ''; },
      };
    };
  }

  it('surfaces 503 OFFLINE once without consuming retries (no hot loop)', async () => {
    const counter = { calls: 0 };
    const c = new HermesClient({ brokerUrl: 'http://localhost:9876', clientToken: 'tok', retries: 2, retryDelayMs: 1, fetch: offlineFetch(counter) });
    await expect(c.getToken('ms365', 'graph')).rejects.toMatchObject({
      code: HermesClientErrorCode.OFFLINE, retryable: true, retryAfterMs: 30_000,
    });
    expect(counter.calls).toBe(1); // single surface — never retried in-loop
  });

  it('memoizes OFFLINE per key and short-circuits without an HTTP call until retryAfterMs elapses', async () => {
    vi.useFakeTimers();
    const counter = { calls: 0 };
    const c = new HermesClient({ brokerUrl: 'http://localhost:9876', clientToken: 'tok', retries: 2, retryDelayMs: 1, fetch: offlineFetch(counter) });

    await expect(c.getToken('ms365', 'graph')).rejects.toMatchObject({ code: HermesClientErrorCode.OFFLINE });
    expect(counter.calls).toBe(1);

    // Within the memo window: no HTTP call at all.
    await expect(c.getToken('ms365', 'graph')).rejects.toMatchObject({ code: HermesClientErrorCode.OFFLINE });
    await expect(c.getToken('ms365', 'graph')).rejects.toMatchObject({ code: HermesClientErrorCode.OFFLINE });
    expect(counter.calls).toBe(1);

    // A different key is NOT memoized.
    await expect(c.getToken('ms365', 'teams')).rejects.toMatchObject({ code: HermesClientErrorCode.OFFLINE });
    expect(counter.calls).toBe(2);

    // After the memo window the client probes the broker again.
    vi.advanceTimersByTime(30_001);
    await expect(c.getToken('ms365', 'graph')).rejects.toMatchObject({ code: HermesClientErrorCode.OFFLINE });
    expect(counter.calls).toBe(3);
  });

  it('floors the OFFLINE memo at 30s when the broker omits retryAfterMs', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const c = new HermesClient({
      brokerUrl: 'http://localhost:9876', clientToken: 'tok', retries: 2, retryDelayMs: 1,
      fetch: async () => { calls++; return { ok: false, status: 503, async json() { return { code: 'OFFLINE', message: 'offline', retryable: true }; }, async text() { return ''; } }; },
    });
    await expect(c.getToken('ms365', 'graph')).rejects.toMatchObject({ code: HermesClientErrorCode.OFFLINE });
    vi.advanceTimersByTime(15_000); // < 30s floor
    await expect(c.getToken('ms365', 'graph')).rejects.toMatchObject({ code: HermesClientErrorCode.OFFLINE });
    expect(calls).toBe(1);
  });

  it('429 RATE_LIMITED is never tight-retried and carries retryAfterMs', async () => {
    let calls = 0;
    const c = new HermesClient({
      brokerUrl: 'http://localhost:9876', clientToken: 'tok', retries: 3, retryDelayMs: 1,
      fetch: async () => { calls++; return { ok: false, status: 429, async json() { return { code: 'RATE_LIMITED', message: 'slow down', retryable: true, retryAfterMs: 4_000 }; }, async text() { return ''; } }; },
    });
    await expect(c.getToken('ms365', 'graph')).rejects.toMatchObject({
      code: HermesClientErrorCode.RATE_LIMITED, retryAfterMs: 4_000,
    });
    expect(calls).toBe(1);
  });

  it('maps a bare 429 (no body code) to RATE_LIMITED', async () => {
    const c = new HermesClient({
      brokerUrl: 'http://localhost:9876', clientToken: 'tok', retries: 0,
      fetch: async () => ({ ok: false, status: 429, async json() { return {}; }, async text() { return ''; } }),
    });
    await expect(c.getToken('ms365', 'graph')).rejects.toMatchObject({ code: HermesClientErrorCode.RATE_LIMITED });
  });

  it('503 REFRESH_IN_PROGRESS retries honor retryAfterMs with a 1s floor', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const c = new HermesClient({
      brokerUrl: 'http://localhost:9876', clientToken: 'tok', retries: 2, retryDelayMs: 1,
      fetch: async () => {
        calls++;
        if (calls === 1) {
          return { ok: false, status: 503, async json() { return { code: 'REFRESH_IN_PROGRESS', message: 'in flight', retryable: true, retryAfterMs: 5 }; }, async text() { return ''; } };
        }
        return { ok: true, status: 200, async json() { return okBundle; }, async text() { return ''; } };
      },
    });
    const pending = c.getToken('ms365', 'graph');
    const settled = pending.catch(() => undefined); // avoid unhandled rejection noise
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toBe(1); // floor not yet elapsed — no hot retry at 5ms
    await vi.advanceTimersByTimeAsync(2);
    const result = await pending;
    expect(result.accessToken).toBe('abc');
    expect(calls).toBe(2);
    await settled;
  });

  it('a successful fetch clears the OFFLINE memo for that key', async () => {
    vi.useFakeTimers();
    let calls = 0;
    let offline = true;
    const c = new HermesClient({
      brokerUrl: 'http://localhost:9876', clientToken: 'tok', retries: 0,
      fetch: async () => {
        calls++;
        if (offline) return { ok: false, status: 503, async json() { return { code: 'OFFLINE', message: 'offline', retryable: true, retryAfterMs: 30_000 }; }, async text() { return ''; } };
        return { ok: true, status: 200, async json() { return okBundle; }, async text() { return ''; } };
      },
    });
    await expect(c.getToken('ms365', 'graph')).rejects.toMatchObject({ code: HermesClientErrorCode.OFFLINE });
    offline = false;
    vi.advanceTimersByTime(30_001);
    expect((await c.getToken('ms365', 'graph')).accessToken).toBe('abc');
    // Memo cleared: subsequent calls go straight to HTTP.
    expect((await c.getToken('ms365', 'graph')).accessToken).toBe('abc');
    expect(calls).toBe(3);
  });
});
