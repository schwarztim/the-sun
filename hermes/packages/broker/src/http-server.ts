import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Logger } from './logger.js';
import { HermesError, HermesErrorCode } from './errors.js';
import type { Broker } from './broker.js';
import { buildMcpToolHandlers, mcpToolDescriptors } from './mcp-server.js';
import type { ServiceRegistry } from './registry.js';
import type { TokenHealth, TokenHealthMonitor } from './health-monitor.js';
import type { GatewayFleetSync } from './fleet-sync.js';
import type { LifecycleState, LifecycleStateStore } from './lifecycle-state.js';
import type { OrgRunbookRegistry } from './org-runbook-registry.js';
import type { TokenStorage } from './storage.js';
import type { TokenBundle } from './types.js';
import { proactiveRefreshState } from './lifecycle.js';

export interface HttpServerDeps {
  broker: Broker; registry: ServiceRegistry; clientToken: string; logger: Logger;
  storage?: TokenStorage; healthMonitor?: TokenHealthMonitor; fleetSync?: GatewayFleetSync;
  lifecycleStore?: LifecycleStateStore; orgRunbooks?: OrgRunbookRegistry;
  /** Per service:scheme token bucket on GET /token. Default 20 req / 10s. */
  consumerRateLimit?: { maxTokenRequestsPer10s?: number };
}

const codeToStatus: Record<HermesErrorCode, number> = {
  [HermesErrorCode.ACQUIRE_REQUIRED]: 409,
  [HermesErrorCode.REFRESH_FAILED]: 409,
  [HermesErrorCode.REFRESH_IN_PROGRESS]: 503,
  [HermesErrorCode.VALIDATION_FAILED]: 409,
  [HermesErrorCode.INTERACTIVE_AUTH_REQUIRED]: 409,
  [HermesErrorCode.PROVIDER_NOT_FOUND]: 404,
  [HermesErrorCode.SERVICE_NOT_REGISTERED]: 404,
  [HermesErrorCode.STORAGE_ERROR]: 500,
  [HermesErrorCode.CONFIG_ERROR]: 500,
  [HermesErrorCode.UNAUTHORIZED]: 401,
  [HermesErrorCode.INTERNAL]: 500,
  // 503 OFFLINE is distinguished from 503 REFRESH_IN_PROGRESS by the body
  // `code` field; both carry Retry-After (sendHermesError sets it from
  // retryAfterMs). Distinct from 409 CA/auth-required (operator action).
  [HermesErrorCode.OFFLINE]: 503,
  [HermesErrorCode.RATE_LIMITED]: 429,
};

const RATE_LIMIT_WINDOW_MS = 10_000;
const RATE_LIMIT_DEFAULT_MAX = 20;
/** Header a consumer may set to identify itself to the /token fairness limiter. */
const CONSUMER_HEADER = 'x-hermes-consumer';
/** Aggregate per-service ceiling, as a multiple of the per-consumer limit. */
const SERVICE_CEILING_MULTIPLIER = 4;

function sendHermesError(reply: FastifyReply, err: HermesError): void {
  if (err.retryAfterMs !== undefined) {
    reply.header('Retry-After', String(Math.ceil(err.retryAfterMs / 1000)));
  }
  reply.code(codeToStatus[err.code] ?? 500).send(err.toJSON());
}

function mcpErrorResponse(id: string | number | null | undefined, err: unknown): {
  jsonrpc: '2.0';
  id: string | number | null;
  error: { code: number; message: string; data?: Record<string, unknown> };
} {
  if (err instanceof HermesError) {
    return {
      jsonrpc: '2.0',
      id: id ?? null,
      error: { code: -32000, message: err.message, data: err.toJSON() },
    };
  }
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code: -32603, message: 'internal error' },
  };
}

export function buildHttpServer(deps: HttpServerDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  // Replace default JSON parser so /mcp receives a raw Buffer while other routes get parsed objects.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    if (_req.url === '/mcp') {
      done(null, body);
    } else {
      try { done(null, JSON.parse((body as Buffer).toString())); }
      catch (err) { done(err as Error); }
    }
  });

  const expectedAuth = `Bearer ${deps.clientToken}`;
  const requireAuth = (req: FastifyRequest, reply: FastifyReply): boolean => {
    const header = req.headers.authorization ?? '';
    // Constant-time comparison so a network-local attacker cannot recover the
    // client token byte-by-byte from response timing. timingSafeEqual requires
    // equal-length buffers, so the length is checked first (length is not the
    // sensitive part beyond revealing the token's length).
    const got = Buffer.from(header);
    const want = Buffer.from(expectedAuth);
    if (got.length !== want.length || !timingSafeEqual(got, want)) {
      reply.code(401).send({ code: 'UNAUTHORIZED', message: 'invalid or missing bearer token' });
      return false;
    }
    return true;
  };

  /**
   * GET /health is a LIVENESS probe, and fleetd is its consumer.
   *
   * DO NOT turn this into a readiness or credential-health check. fleetd treats
   * ONLY HTTP 200 as healthy (fleet/fleetd/internal/fleet/health.go) and KILLS
   * the process for restart after 3 consecutive non-200 responses
   * (internal/fleet/supervisor.go); repeated restarts trip its circuit breaker
   * and leave hermes degraded with no supervision at all. Hermes is manifested
   * with `health = "/health"`, so every code returned here is a restart vote.
   *
   * A restart CANNOT fix a stale or disarmed credential (that needs
   * `hermes acquire <service>`), so letting credential state drive the status
   * code would convert a credential problem into a broker outage, taking down
   * the one service the whole fleet depends on. Credential state therefore
   * appears in the BODY only, which fleetd never parses, and anything that may
   * legitimately go red lives on GET /health/credentials, which fleetd does not
   * probe.
   *
   * The only condition that may return non-200 here is the broker being unable
   * to serve at all (the vault inventory will not load), where a restart is a
   * genuine remedy.
   */
  app.get('/health', async (_req, reply) => {
    const checks: Array<{ name: string; status: 'ok' | 'degraded'; error?: string; detail?: Record<string, unknown> }> = [];

    // 1. Vault smoke check — can we load the token inventory?
    if (deps.storage) {
      try {
        const bundles = await deps.storage.list();
        checks.push({ name: 'vault', status: 'ok', detail: { tokenCount: bundles.length } });
      } catch (err) {
        checks.push({ name: 'vault', status: 'degraded', error: err instanceof Error ? err.message : String(err) });
      }
    }

    // 2. Token health summary — any genuinely expired bundles?
    // no-refresh-token is NOT degraded for reacquire/cookie-session/PAT services; those
    // providers reacquire by design and autoReacquire self-heals them on access.
    if (deps.healthMonitor) {
      try {
        const health = deps.healthMonitor.status();
        const degraded = health.filter((h: TokenHealth) => {
          if (h.status === 'expired') return true;
          if (h.status === 'no-refresh-token') {
            // Check if this is by design: autoReacquire or reacquire-strategy provider
            const svc = deps.registry.getService(h.service);
            if (svc?.autoReacquire === true) return false;
            const provider = deps.registry.getProvider(svc?.providerName ?? '');
            // Provider not installed (static imports like github_pat/stash_pat): missing
            // refresh token is the permanent expected state — not degraded.
            if (!provider) return false;
            const schemeCapabilities = provider.capabilities?.schemes?.find((s) => s.scheme === h.scheme);
            if (schemeCapabilities && schemeCapabilities.refreshStrategy !== 'refresh-token') return false;
            return true; // refresh-token strategy missing refresh token — genuinely degraded
          }
          return false;
        });
        const expiring = health.filter((h: TokenHealth) => h.status === 'expiring');
        checks.push({
          name: 'tokens',
          status: degraded.length > 0 ? 'degraded' : 'ok',
          detail: {
            total: health.length,
            healthy: health.filter((h: TokenHealth) => h.status === 'healthy').length,
            expiring: expiring.length,
            degraded: degraded.length,
            ...(degraded.length > 0 ? { degradedServices: degraded.map((h: TokenHealth) => `${h.service}/${h.scheme}`) } : {}),
          },
        });
      } catch { /* health monitor not ready yet */ }
    }

    // ONLY the vault check may set a non-200: if the inventory will not load,
    // the broker cannot serve any credential and a restart is a real remedy.
    // The token check is credential state and is reported in the body only.
    // Previously it drove a 503, which meant one expired token could make
    // fleetd restart the broker in a loop that could never fix the token.
    const liveness = checks.find((c) => c.name === 'vault');
    const overallStatus = liveness?.status === 'degraded' ? 'degraded' : 'ok';
    if (overallStatus === 'degraded') reply.code(503);
    return {
      status: overallStatus,
      probe: 'liveness',
      credentialsEndpoint: '/health/credentials',
      checks,
    };
  });

  /**
   * GET /health/credentials — the operator and monitoring view that MAY go red.
   *
   * fleetd does not probe this route (hermes is manifested against /health), so
   * a non-200 here cannot trigger a supervised restart. It surfaces the states
   * that predict credential unavailability and were previously visible only in
   * log lines: proactive-refresh disarm, active cooldowns, AD-budget and
   * autoReacquire suppression, offline gating, and the last error code per key.
   *
   * Bearer-authed like /token and /cred: it enumerates exactly WHICH credentials
   * are weak, which is reconnaissance value, and every legitimate consumer (the
   * hermes CLI, an operator with the client token) already holds the token.
   *
   * NO SECRET VALUES. Service and account names plus state only. The stored
   * `lastErrorMessage` is deliberately NOT returned: it is provider-authored
   * free text, and although the lifecycle store sanitizes known token shapes, a
   * stable error CODE is both safer and more actionable. Nothing here can
   * reconstruct a credential.
   */
  app.get('/health/credentials', async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    if (!deps.storage) return { status: 'unknown', reason: 'no token storage configured', credentials: [] };

    let bundles: TokenBundle[];
    try {
      bundles = await deps.storage.list();
    } catch (err) {
      reply.code(503);
      return {
        status: 'degraded',
        reason: 'token inventory failed to load',
        error: err instanceof Error ? err.message : String(err),
        credentials: [],
      };
    }

    const credentials = await Promise.all(bundles.map(async (bundle) => {
      const { service, scheme } = bundle;
      const gate = deps.broker.canAttemptAcquire(service, scheme);
      const proactive = proactiveRefreshState(service, scheme);
      let state: LifecycleState | null = null;
      if (deps.lifecycleStore) {
        try { state = await deps.lifecycleStore.get(service, scheme); }
        catch { /* lifecycle state is advisory; its absence is not an error */ }
      }
      const healthy = gate.ok && !proactive.disarmed;
      return {
        service,
        scheme,
        healthy,
        expiresAt: bundle.expiresAt,
        // Why the broker cannot currently acquire: cooldown, offline, ad-budget,
        // or auto-reacquire-suppressed, with the wait the gate already computed.
        ...(gate.ok ? {} : { blockedBy: gate.reason, retryAfterMs: gate.retryAfterMs }),
        proactiveRefresh: {
          disarmed: proactive.disarmed,
          consecutiveFailures: proactive.consecutiveFailures,
        },
        ...(state?.lastErrorCode !== undefined ? { lastErrorCode: state.lastErrorCode } : {}),
        ...(state?.lastErrorAt !== undefined ? { lastErrorAt: state.lastErrorAt } : {}),
        ...(state?.lastRefreshSuccessAt !== undefined ? { lastRefreshSuccessAt: state.lastRefreshSuccessAt } : {}),
        ...(state?.cooldownUntil !== undefined ? { cooldownUntil: state.cooldownUntil } : {}),
        // Only a human can clear a disarm, so name the exact command.
        ...(proactive.disarmed ? { nextAction: `hermes acquire ${service}` } : {}),
      };
    }));

    const degraded = credentials.filter((c) => !c.healthy);
    if (degraded.length > 0) reply.code(503);
    return {
      status: degraded.length > 0 ? 'degraded' : 'ok',
      total: credentials.length,
      degraded: degraded.length,
      disarmed: credentials.filter((c) => c.proactiveRefresh.disarmed).length,
      credentials,
    };
  });

  // Fleet sync endpoints
  app.get('/fleet/status', async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    if (!deps.fleetSync) return { status: 'disabled' };
    return deps.fleetSync.status();
  });

  app.post('/fleet/sync', async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    if (!deps.fleetSync) { reply.code(404).send({ error: 'fleet sync not enabled' }); return; }
    const result = await deps.fleetSync.syncNow();
    return result;
  });

  // Consumer-facing rate limit on /token — sliding window of request
  // timestamps. Protects the broker (and the cooldown 409 path) from
  // hot-looping consumers. HTTP-edge only; never touches AD logic (IdP load is
  // governed separately by the broker's cooldowns and AD budget), so this
  // limiter's real job is FAIRNESS between consumers.
  //
  // Two windows, innermost first:
  //   1. per consumer + service:scheme, at the configured max. A hot consumer
  //      now trips its OWN bucket and is refused before its excess is counted
  //      anywhere else, so it can no longer starve a polite consumer of the
  //      same service. This is the fairness fix: keying only on service:scheme
  //      made the misbehaving process the one that never suffered.
  //   2. per service:scheme, at a multiple of the same max, retained as an
  //      aggregate ceiling on total load for one service. Because it is a
  //      multiple, well-behaved consumers see strictly FEWER 429s than before.
  //
  // Consumers are identified only well enough to separate them; there is one
  // shared client token today, so this is a fairness key, NOT an authorization
  // boundary (the header is caller-supplied and trivially spoofed).
  const rateLimitMax = deps.consumerRateLimit?.maxTokenRequestsPer10s ?? RATE_LIMIT_DEFAULT_MAX;
  const serviceCeiling = rateLimitMax * SERVICE_CEILING_MULTIPLIER;
  const rateLimitBuckets = new Map<string, number[]>();
  /** Sliding-window check that records the attempt only when it is allowed. */
  const overLimit = (key: string, max: number): number | null => {
    const now = Date.now();
    const times = (rateLimitBuckets.get(key) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (times.length >= max) {
      rateLimitBuckets.set(key, times);
      return Math.max(0, RATE_LIMIT_WINDOW_MS - (now - times[0]!));
    }
    times.push(now);
    rateLimitBuckets.set(key, times);
    return null;
  };
  /**
   * Best-effort consumer identity: an explicit header, else the remote socket,
   * else a shared anonymous bucket. Truncated and never echoed back to the
   * caller (it is attacker-controlled text).
   */
  const consumerId = (req: FastifyRequest): string => {
    const header = req.headers[CONSUMER_HEADER];
    const raw = Array.isArray(header) ? header[0] : header;
    const declared = typeof raw === 'string' ? raw.trim().slice(0, 64) : '';
    if (declared) return declared;
    const ip = req.ip;
    return ip ? `${ip}:${req.socket?.remotePort ?? 0}` : 'anonymous';
  };
  const tokenRateLimited = (req: FastifyRequest, service: string, scheme: string): { retryAfterMs: number; scope: 'consumer' | 'service' } | null => {
    const target = `${service}:${scheme}`;
    const perConsumer = overLimit(`consumer:${consumerId(req)}:${target}`, rateLimitMax);
    if (perConsumer !== null) return { retryAfterMs: perConsumer, scope: 'consumer' };
    const perService = overLimit(`service:${target}`, serviceCeiling);
    if (perService !== null) return { retryAfterMs: perService, scope: 'service' };
    return null;
  };

  app.get<{ Params: { service: string; scheme: string }; Querystring: { force?: string; interactive?: string; headless?: string } }>(
    '/token/:service/:scheme', async (req, reply) => {
      if (!requireAuth(req, reply)) return;
      if (req.query.interactive !== undefined || req.query.headless !== undefined) {
        reply.code(400).send({ code: 'BAD_REQUEST', message: 'interactive and headless parameters are not accepted — all requests are headless' });
        return;
      }
      const limited = tokenRateLimited(req, req.params.service, req.params.scheme);
      if (limited !== null) {
        const { retryAfterMs, scope } = limited;
        const max = scope === 'consumer' ? rateLimitMax : serviceCeiling;
        reply.header('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
        reply.code(429).send({
          code: 'RATE_LIMITED',
          message: `rate limit exceeded for ${req.params.service}:${req.params.scheme} (${scope} limit: ${max} requests / ${RATE_LIMIT_WINDOW_MS / 1000}s)`,
          retryable: true,
          retryAfterMs,
          retryHint: 'retry-after',
          scope,
          remediation: scope === 'consumer'
            ? `back off for ~${Math.ceil(retryAfterMs / 1000)}s; cache tokens client-side instead of re-fetching per request`
            : `back off for ~${Math.ceil(retryAfterMs / 1000)}s; this service is at its aggregate limit across all consumers`,
        });
        return;
      }
      try {
        const bundle = await deps.broker.getToken(req.params.service, req.params.scheme, {
          force: req.query.force === '1' || req.query.force === 'true',
        });
        // Offline grace: token served from cache while offline AND inside the
        // refresh safety margin — flag so downstreams know it may expire soon.
        if ((bundle.extra as Record<string, unknown> | undefined)?.hermesOfflineGrace === true) {
          reply.header('X-Hermes-Offline-Grace', 'true');
        }
        return bundle;
      } catch (err) {
        if (err instanceof HermesError) {
          sendHermesError(reply, err);
          return;
        }
        deps.logger.error('unhandled http error', { error: (err as Error).message });
        reply.code(500).send({ code: 'INTERNAL', message: 'internal error' });
      }
    }
  );

  // Read a static credential (API key / PAT / token) stored via
  // `hermes creds set <service> <account>`. This is the read side of the
  // credential vault — the token onboarding path for fleet servers (Go/Python)
  // and fleetd, which fetch their outbound API credential here at spawn/runtime.
  // Bearer-authed and localhost-only; the value is returned to the authorized
  // consumer for env injection (same trust model as /token's accessToken).
  app.get<{ Params: { service: string; account: string } }>(
    '/cred/:service/:account', async (req, reply) => {
      if (!requireAuth(req, reply)) return;
      try {
        const { getHermesVault } = await import('@hermes/vault');
        const vault = await getHermesVault();
        const value = await vault.get(req.params.service, req.params.account);
        if (value == null || value === '') {
          reply.code(404).send({
            code: 'NOT_FOUND',
            message: `no credential stored for ${req.params.service}::${req.params.account}`,
            remediation: `enroll it: hermes creds set ${req.params.service} ${req.params.account}`,
          });
          return;
        }
        return { service: req.params.service, account: req.params.account, value };
      } catch (err) {
        deps.logger.error('cred read failed', { error: (err as Error).message });
        reply.code(500).send({ code: 'INTERNAL', message: 'internal error' });
      }
    }
  );

  app.post<{ Params: { service: string; scheme: string }; Body: Record<string, unknown> }>(
    '/token/:service/:scheme/report-failure', async (req, reply) => {
      if (!requireAuth(req, reply)) return;
      try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const result = await deps.broker.reportAuthFailure({
          ...body,
          service: req.params.service,
          scheme: req.params.scheme,
        });
        if (result.guidance.retryAfterMs !== undefined) {
          reply.header('Retry-After', String(Math.ceil(result.guidance.retryAfterMs / 1000)));
        }
        return result;
      } catch (err) {
        if (err instanceof HermesError) {
          sendHermesError(reply, err);
          return;
        }
        deps.logger.error('unhandled http report-failure error', { error: (err as Error).message });
        reply.code(500).send({ code: 'INTERNAL', message: 'internal error' });
      }
    }
  );

  // --- MCP streamable HTTP transport at /mcp ---
  const handlers = buildMcpToolHandlers({ broker: deps.broker, registry: deps.registry, healthMonitor: deps.healthMonitor, fleetSync: deps.fleetSync, lifecycleStore: deps.lifecycleStore, orgRunbooks: deps.orgRunbooks });

  function createMcpServer(): Server {
    const server = new Server({ name: 'hermes', version: '0.0.1' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: mcpToolDescriptors as unknown as Array<{ name: string; description: string; inputSchema: unknown }>,
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const name = req.params.name as keyof typeof handlers;
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;
      if (!(name in handlers)) throw new Error(`unknown tool: ${String(name)}`);
      const fn = handlers[name] as (a: Record<string, unknown>) => Promise<Record<string, unknown>>;
      let result: Record<string, unknown>;
      try {
        result = await fn(args);
      } catch (err) {
        if (!(err instanceof HermesError)) throw err;
        result = { status: 'error', error: err.toJSON() };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    });
    return server;
  }

  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: Server }>();

  app.route({
    method: ['GET', 'POST', 'DELETE'],
    url: '/mcp',
    handler: async (request, reply) => {
      const sessionId = request.headers['mcp-session-id'] as string | undefined;
      const parsedBody = Buffer.isBuffer(request.body)
        ? JSON.parse((request.body as Buffer).toString())
        : undefined;
      const rpcMethod = (parsedBody as { method?: string } | undefined)?.method;
      const hasValidSession = Boolean(sessionId && sessions.has(sessionId));
      deps.logger.debug('mcp request', {
        httpMethod: request.method,
        hasSessionId: Boolean(sessionId),
        sessionKnown: hasValidSession,
        rpcMethod,
      });

      // Stateless compatibility path for clients that call tools directly without
      // maintaining streamable-http session state.
      if (request.method === 'POST' && !hasValidSession && parsedBody && typeof parsedBody === 'object') {
        const rpc = parsedBody as {
          id?: string | number | null;
          method?: string;
          params?: { name?: string; arguments?: Record<string, unknown> };
        };
        if (rpc.method === 'tools/list') {
          return {
            jsonrpc: '2.0',
            id: rpc.id ?? null,
            result: {
              tools: mcpToolDescriptors as unknown as Array<{ name: string; description: string; inputSchema: unknown }>,
            },
          };
        }
      if (rpc.method === 'tools/call') {
          const name = rpc.params?.name as keyof typeof handlers;
          const args = (rpc.params?.arguments ?? {}) as Record<string, unknown>;
          if (!(name in handlers)) {
            reply.code(400).send({ jsonrpc: '2.0', id: rpc.id ?? null, error: { code: -32601, message: `unknown tool: ${String(name)}` } });
            return;
           }
           const fn = handlers[name] as (a: Record<string, unknown>) => Promise<Record<string, unknown>>;
          try {
            const result = await fn(args);
            return { jsonrpc: '2.0', id: rpc.id ?? null, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } };
          } catch (err) {
            if (err instanceof HermesError) {
              if (err.retryAfterMs !== undefined) reply.header('Retry-After', String(Math.ceil(err.retryAfterMs / 1000)));
              reply.code(codeToStatus[err.code] ?? 500).send(mcpErrorResponse(rpc.id, err));
              return;
            }
            deps.logger.error('unhandled stateless mcp error', { error: (err as Error).message });
            reply.code(500).send(mcpErrorResponse(rpc.id, err));
            return;
          }
        }
      }
      let transport: StreamableHTTPServerTransport;

      if (sessionId && sessions.has(sessionId)) {
        transport = sessions.get(sessionId)!.transport;
      } else if (request.method === 'POST' || request.method === 'GET') {
        // Bootstrap a new streamable-http session when callers start without a session id
        // or when they present a stale/unknown session id after broker restart.
        const server = createMcpServer();
        const t = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid: string) => {
            sessions.set(sid, { transport: t, server });
          },
        });
        t.onclose = () => {
          const sid = t.sessionId;
          if (sid) {
            const entry = sessions.get(sid);
            if (entry) {
              entry.server.close().catch(() => {});
              sessions.delete(sid);
            }
          }
        };
        await server.connect(t);
        transport = t;
      } else {
        reply.code(400).send({ error: 'missing or invalid session' });
        return;
      }

      reply.hijack();
      await transport.handleRequest(request.raw, reply.raw, parsedBody);
    },
  });

  return app;
}
