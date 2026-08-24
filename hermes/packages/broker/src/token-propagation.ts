import type { Logger } from './logger.js';
import { sanitizeLifecycleMessage, type LifecycleStateStore, type PropagationEvent, type PropagationStatus } from './lifecycle-state.js';
import type { ServiceRegistry } from './registry.js';
import type { FleetSyncResult } from './fleet-sync.js';
import type { ContainerRestartProof, SecretWriteProof } from './thv-storage.js';
import type { DownstreamAuthProbeConfig, TokenBundle } from './types.js';
import { proofEventsFromPropagation, summarizeProof } from './proof-probes.js';
import { authFailureEventFromReport, normalizeAuthFailureReport, sanitizeAuthFailureValue } from './auth-failure.js';

export interface TokenPropagationStorage {
  writeToken(secretName: string, bundle: TokenBundle): Promise<SecretWriteProof>;
  restartContainer(containerName: string): Promise<ContainerRestartProof>;
}

export interface TokenPropagationFleetSync {
  syncNow(opts?: { forceReload?: boolean }): Promise<FleetSyncResult>;
}

export interface DownstreamSmokeProbeResult {
  initialized: boolean;
  sessionEstablished: boolean;
  toolsListed: boolean;
  toolCount?: number;
}

export interface DownstreamAuthenticatedProbeResult {
  toolName: string;
  success: boolean;
  authFailure: boolean;
  httpStatus?: number;
  failureCode?: string;
  message?: string;
  evidence?: unknown;
}

export interface TokenPropagationResult {
  status: PropagationStatus;
  service: string;
  scheme: string;
  secretName?: string;
  containerName?: string;
  events: PropagationEvent[];
}

export interface TokenPropagationDeps {
  registry: ServiceRegistry;
  thvStorage: TokenPropagationStorage;
  logger: Logger;
  lifecycleStore?: LifecycleStateStore;
  fleetSync?: TokenPropagationFleetSync;
  smokeProbe?: (url: string) => Promise<DownstreamSmokeProbeResult>;
  authenticatedProbe?: (url: string, probe: DownstreamAuthProbeConfig) => Promise<DownstreamAuthenticatedProbeResult>;
  now?: () => number;
}

type EventMetadata = NonNullable<PropagationEvent['metadata']>;

function metadata(entries: Record<string, string | number | boolean | null | undefined>): EventMetadata {
  return Object.fromEntries(Object.entries(entries).filter(([, v]) => v !== undefined)) as EventMetadata;
}

function numberExtra(bundle: TokenBundle, key: string): number | undefined {
  const value = bundle.extra?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function errMessage(err: unknown): string {
  return sanitizeLifecycleMessage(err);
}

export async function smokeProbeMcp(url: string): Promise<DownstreamSmokeProbeResult> {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  const init = await fetchWithTimeout(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'hermes-propagation-probe', version: '0.0.1' },
      },
    }),
  });
  await init.text().catch(() => '');
  if (!init.ok) throw new Error(`downstream initialize returned HTTP ${init.status}`);
  const sessionId = init.headers.get('mcp-session-id');
  if (!sessionId) throw new Error('downstream initialize did not return an mcp-session-id');

  const list = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { ...headers, 'mcp-session-id': sessionId },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  });
  const body = await list.text().catch(() => '');
  if (!list.ok) throw new Error(`downstream tools/list returned HTTP ${list.status}`);
  let toolCount: number | undefined;
  try {
    const parsed = JSON.parse(body) as { result?: { tools?: unknown[] } };
    toolCount = Array.isArray(parsed.result?.tools) ? parsed.result.tools.length : undefined;
  } catch {
    toolCount = undefined;
  }
  return { initialized: true, sessionEstablished: true, toolsListed: true, toolCount };
}

export async function authenticatedProbeMcp(url: string, probe: DownstreamAuthProbeConfig): Promise<DownstreamAuthenticatedProbeResult> {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  const init = await fetchWithTimeout(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'hermes-authenticated-probe', version: '0.0.1' },
      },
    }),
  });
  await init.text().catch(() => '');
  if (!init.ok) throw new Error(`downstream initialize returned HTTP ${init.status}`);
  const sessionId = init.headers.get('mcp-session-id');
  if (!sessionId) throw new Error('downstream initialize did not return an mcp-session-id');

  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { ...headers, 'mcp-session-id': sessionId },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: probe.toolName, arguments: probe.args ?? {} },
    }),
  });
  const text = await response.text().catch(() => '');
  const body = parseJson(text);
  const evidence = redactProbeEvidence({ httpStatus: response.status, body: body ?? text }, probe);
  const authExpectation = expectationMatches(probe.expectedAuthFailure, response.status, body ?? text) === true;
  const authFailure = authExpectation || response.status === 401 || response.status === 403 || looksLikeAuthFailure(body ?? text);
  const successExpectation = expectationMatches(probe.expectedSuccess, response.status, body ?? text);
  const success = !authFailure
    && response.ok
    && !hasJsonRpcError(body)
    && !hasMcpToolError(body)
    && (successExpectation ?? true);

  return {
    toolName: probe.toolName,
    success,
    authFailure,
    httpStatus: response.status,
    ...(authFailure ? { failureCode: failureCode(body, response.status) } : {}),
    message: sanitizeLifecycleMessage(probeMessage(body ?? text, response.status)),
    evidence,
  };
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timeout));
}

function parseJson(text: string): unknown | undefined {
  try { return JSON.parse(text); } catch { return undefined; }
}

function statusMatches(expected: number | number[] | undefined, actual: number): boolean {
  if (expected === undefined) return true;
  return Array.isArray(expected) ? expected.includes(actual) : expected === actual;
}

function expectationMatches(expectation: DownstreamAuthProbeConfig['expectedSuccess'], status: number, body: unknown): boolean | undefined {
  if (!expectation) return undefined;
  return statusMatches(expectation.httpStatus, status)
    && (expectation.shape === undefined || partialShapeMatches(body, expectation.shape))
    && minArrayLengthMatches(body, expectation.minArrayLength);
}

function minArrayLengthMatches(body: unknown, checks: NonNullable<DownstreamAuthProbeConfig['expectedSuccess']>['minArrayLength']): boolean {
  if (!checks) return true;
  return checks.every((check) => {
    const value = valueAtPath(body, check.path);
    return Array.isArray(value) && value.length >= check.min;
  });
}

function valueAtPath(value: unknown, pathSpec: string): unknown {
  if (pathSpec === '') return value;
  return pathSpec.split('.').filter(Boolean).reduce<unknown>((cursor, part) => {
    if (cursor && typeof cursor === 'object') return (cursor as Record<string, unknown>)[part];
    return undefined;
  }, value);
}

function partialShapeMatches(actual: unknown, expected: unknown): boolean {
  if (expected === actual) return true;
  if (expected === null || typeof expected !== 'object') return Object.is(actual, expected);
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return false;
    return expected.every((entry, index) => partialShapeMatches(actual[index], entry));
  }
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
  return Object.entries(expected as Record<string, unknown>).every(([key, value]) =>
    partialShapeMatches((actual as Record<string, unknown>)[key], value),
  );
}

function hasJsonRpcError(body: unknown): boolean {
  return Boolean(body && typeof body === 'object' && 'error' in body);
}

function hasMcpToolError(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const result = (body as { result?: unknown }).result;
  return Boolean(result && typeof result === 'object' && (result as { isError?: unknown }).isError === true);
}

function looksLikeAuthFailure(body: unknown): boolean {
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? {});
  return /\b(401|403|unauthori[sz]ed|forbidden|not authenticated|invalid[_\s-]?session|csrf)\b/i.test(text);
}

function failureCode(body: unknown, status: number): string {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (body && typeof body === 'object') {
    const error = (body as { error?: unknown }).error;
    if (error && typeof error === 'object') {
      const data = (error as { data?: unknown }).data;
      const code = (error as { code?: unknown }).code ?? (data && typeof data === 'object' ? (data as { code?: unknown }).code : undefined);
      if (typeof code === 'string' || typeof code === 'number') return String(code);
    }
  }
  return 'downstream_auth_probe_failed';
}

function probeMessage(body: unknown, status: number): string {
  if (body && typeof body === 'object') {
    const error = (body as { error?: unknown }).error;
    if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
      return String((error as { message: string }).message);
    }
  }
  return `authenticated MCP probe returned HTTP ${status}`;
}

function redactProbeEvidence(value: unknown, probe: DownstreamAuthProbeConfig): unknown {
  const redacted = sanitizeAuthFailureValue(value);
  const keys = new Set((probe.redaction?.redactKeys ?? []).map((key) => key.toLowerCase()));
  const withKeys = keys.size > 0 ? redactKeys(redacted, keys) : redacted;
  return (probe.redaction?.redactPaths ?? []).reduce((acc, path) => redactPath(acc, path), withKeys);
}

function redactKeys(value: unknown, keys: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((entry) => redactKeys(entry, keys));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key,
      keys.has(key.toLowerCase()) ? '[redacted]' : redactKeys(entry, keys),
    ]));
  }
  return value;
}

function redactPath(value: unknown, pathSpec: string): unknown {
  if (!value || typeof value !== 'object') return value;
  const clone = Array.isArray(value) ? [...value] : { ...(value as Record<string, unknown>) };
  const parts = pathSpec.split('.').filter(Boolean);
  let cursor: unknown = clone;
  for (let index = 0; index < parts.length; index += 1) {
    if (!cursor || typeof cursor !== 'object') return clone;
    const part = parts[index]!;
    if (index === parts.length - 1) {
      (cursor as Record<string, unknown>)[part] = '[redacted]';
    } else {
      const next = (cursor as Record<string, unknown>)[part];
      const nextClone = Array.isArray(next) ? [...next] : next && typeof next === 'object' ? { ...(next as Record<string, unknown>) } : next;
      (cursor as Record<string, unknown>)[part] = nextClone;
      cursor = nextClone;
    }
  }
  return clone;
}

function evidenceString(evidence: unknown): string | undefined {
  if (evidence === undefined) return undefined;
  try { return JSON.stringify(evidence).slice(0, 500); } catch { return String(evidence).slice(0, 500); }
}

function configuredAuthProbes(registration: { downstreamAuthProbe?: DownstreamAuthProbeConfig; downstreamAuthProbes?: DownstreamAuthProbeConfig[] }): DownstreamAuthProbeConfig[] {
  if (registration.downstreamAuthProbes && registration.downstreamAuthProbes.length > 0) return registration.downstreamAuthProbes;
  return registration.downstreamAuthProbe ? [registration.downstreamAuthProbe] : [];
}

function probeMetadata(probe: DownstreamAuthProbeConfig, entries: Record<string, string | number | boolean | null | undefined> = {}): EventMetadata {
  return metadata({
    toolName: probe.toolName,
    operation: probe.operation,
    endpointClass: probe.endpointClass,
    proofDepth: probe.proofDepth,
    required: probe.required,
    ...entries,
  });
}

export async function propagateTokenToToolHive(bundle: TokenBundle, deps: TokenPropagationDeps): Promise<TokenPropagationResult> {
  const now = deps.now ?? Date.now;
  const service = bundle.service;
  const scheme = bundle.scheme;
  const events: PropagationEvent[] = [];
  let degraded = false;
  let transportSmokeOk = false;

  const record = async (status: PropagationStatus, err?: unknown): Promise<void> => {
    if (!deps.lifecycleStore) return;
    try {
      await deps.lifecycleStore.recordPropagation(service, scheme, status, events, { at: now(), error: err });
    } catch (recordErr) {
      deps.logger.warn('could not update propagation state', { service, scheme, error: errMessage(recordErr) });
    }
  };
  const recordProof = async (status: PropagationStatus): Promise<void> => {
    if (!deps.lifecycleStore) return;
    try {
      const proofEvents = proofEventsFromPropagation(status, events, now());
      const summary = summarizeProof(proofEvents);
      await deps.lifecycleStore.recordProofEvents(service, scheme, proofEvents, {
        proofTier: summary.highestValidTier ?? summary.currentTier,
        proofState: summary.state,
      });
    } catch (recordErr) {
      deps.logger.warn('could not update proof state', { service, scheme, error: errMessage(recordErr) });
    }
  };

  const push = (event: Omit<PropagationEvent, 'at'> & { at?: number }): void => {
    events.push({ ...event, at: event.at ?? now() });
  };
  const recordAuthProbeFailure = async (probe: DownstreamAuthProbeConfig, result: DownstreamAuthenticatedProbeResult): Promise<void> => {
    if (!deps.lifecycleStore) return;
    try {
      const report = normalizeAuthFailureReport({
        service,
        scheme,
        httpStatus: result.httpStatus,
        failureCode: result.failureCode,
        backend: containerName,
        tool: probe.toolName,
        endpointClass: probe.endpointClass ?? 'mcp_tool',
        observedAt: now(),
        message: result.message,
        errorEvidence: result.evidence,
      });
      await deps.lifecycleStore.recordConsumerAuthFailure(service, scheme, authFailureEventFromReport(report));
    } catch (recordErr) {
      deps.logger.warn('could not record downstream auth probe failure', { service, scheme, error: errMessage(recordErr) });
    }
  };

  const registration = deps.registry.getService(service);
  if (!registration?.thvSecretPrefix || !registration.thvContainerName) {
    push({
      step: 'secret_write',
      status: 'skipped',
      message: 'service is not configured for ToolHive token propagation',
      metadata: metadata({ service, scheme }),
    });
    await record('skipped');
    await recordProof('skipped');
    return { status: 'skipped', service, scheme, events };
  }

  const secretName = `${registration.thvSecretPrefix}_${scheme.toUpperCase()}_TOKEN`;
  const containerName = registration.thvContainerName;
  await record('in_progress');

  try {
    const proof = await deps.thvStorage.writeToken(secretName, bundle);
    push({
      step: 'secret_write',
      status: 'ok',
      at: proof.writtenAt,
      metadata: metadata({
        secretName,
        tokenType: proof.tokenType,
        expiresAt: proof.expiresAt,
        acquiredAt: bundle.acquiredAt,
        tokenAgeAtPropagationMs: Math.max(0, proof.writtenAt - bundle.acquiredAt),
        sessionLifetimeMs: numberExtra(bundle, 'sessionLifetimeMs'),
        refreshMarginMs: numberExtra(bundle, 'refreshMarginMs'),
        conservativeRefreshAfterMs: numberExtra(bundle, 'conservativeRefreshAfterMs'),
        hasRefreshToken: proof.hasRefreshToken,
      }),
    });
    await record('in_progress');
  } catch (err) {
    push({ step: 'secret_write', status: 'failed', error: errMessage(err), metadata: metadata({ secretName }) });
    await record('failed', err);
    await recordProof('failed');
    throw err;
  }

  let readyUrl: string | undefined;
  try {
    const proof = await deps.thvStorage.restartContainer(containerName);
    readyUrl = proof.url;
    push({
      step: 'container_restart',
      status: 'ok',
      at: proof.restartedAt,
      metadata: metadata({ containerName }),
    });
    push({
      step: 'container_readiness',
      status: 'ok',
      at: proof.readyAt,
      metadata: metadata({ containerName, url: proof.url }),
    });
    await record('in_progress');
  } catch (err) {
    push({ step: 'container_restart', status: 'failed', error: errMessage(err), metadata: metadata({ containerName }) });
    await record('failed', err);
    await recordProof('failed');
    throw err;
  }

  if (deps.fleetSync) {
    try {
      const sync = await deps.fleetSync.syncNow({ forceReload: true });
      push({
        step: 'fleet_sync',
        status: 'ok',
        metadata: metadata({
          changed: sync.changed,
          backends: sync.backends,
          configHash: sync.configHash,
          configPath: sync.configPath,
        }),
      });
      const gatewayOk = sync.gatewayReload.status === 'ok';
      if (!gatewayOk) degraded = true;
      push({
        step: 'gateway_reload',
        status: gatewayOk ? 'ok' : sync.gatewayReload.status === 'skipped' ? 'skipped' : 'degraded',
        at: sync.gatewayReload.at,
        error: sync.gatewayReload.error,
        metadata: metadata({
          status: sync.gatewayReload.status,
          loaded: sync.gatewayReload.loaded,
          httpStatus: sync.gatewayReload.httpStatus,
        }),
      });
    } catch (err) {
      degraded = true;
      push({ step: 'fleet_sync', status: 'failed', error: errMessage(err) });
    }
  } else {
    degraded = true;
    push({ step: 'fleet_sync', status: 'skipped', message: 'fleet sync is not configured' });
    push({ step: 'gateway_reload', status: 'skipped', message: 'fleet sync is not configured' });
  }
  await record('in_progress');

  const smokeProbe = deps.smokeProbe ?? smokeProbeMcp;
  if (readyUrl) {
    try {
      const smoke = await smokeProbe(readyUrl);
      push({
        step: 'downstream_smoke_probe',
        status: smoke.initialized && smoke.sessionEstablished && smoke.toolsListed ? 'ok' : 'degraded',
        metadata: metadata({
          initialized: smoke.initialized,
          sessionEstablished: smoke.sessionEstablished,
          toolsListed: smoke.toolsListed,
          toolCount: smoke.toolCount,
        }),
      });
      transportSmokeOk = smoke.initialized && smoke.sessionEstablished && smoke.toolsListed;
      if (!transportSmokeOk) degraded = true;
    } catch (err) {
      degraded = true;
      push({ step: 'downstream_smoke_probe', status: 'degraded', error: errMessage(err), metadata: metadata({ url: readyUrl }) });
    }
  } else {
    degraded = true;
    push({ step: 'downstream_smoke_probe', status: 'skipped', message: 'container readiness did not produce an MCP URL' });
  }

  const authProbes = configuredAuthProbes(registration);
  if (authProbes.length === 0) {
    push({
      step: 'downstream_auth_probe',
      status: 'skipped',
      message: 'no safe authenticated downstream MCP probe is configured; transport readiness does not prove credential validity',
      metadata: metadata({ service, scheme }),
    });
  } else {
    const authenticatedProbe = deps.authenticatedProbe ?? authenticatedProbeMcp;
    for (const configuredAuthProbe of authProbes) {
      if (!readyUrl) {
        if (configuredAuthProbe.required) degraded = true;
        push({
          step: 'downstream_auth_probe',
          status: 'skipped',
          message: 'container readiness did not produce an MCP URL for the authenticated probe',
          metadata: probeMetadata(configuredAuthProbe),
        });
        continue;
      }
      if (!transportSmokeOk) {
        if (configuredAuthProbe.required) degraded = true;
        push({
          step: 'downstream_auth_probe',
          status: 'skipped',
          message: 'transport smoke probe did not complete; authenticated probe was not run',
          metadata: probeMetadata(configuredAuthProbe),
        });
        continue;
      }
      try {
        const rawProbe = await authenticatedProbe(readyUrl, configuredAuthProbe);
        const probe = { ...rawProbe, evidence: redactProbeEvidence(rawProbe.evidence, configuredAuthProbe) };
        const probeError = probe.message ? errMessage(probe.message) : undefined;
        push({
          step: 'downstream_auth_probe',
          status: probe.success ? 'ok' : 'degraded',
          ...(probe.success ? {} : { message: 'authenticated downstream MCP probe did not prove credential validity' }),
          ...(!probe.success && probeError ? { error: probeError } : {}),
          metadata: probeMetadata(configuredAuthProbe, {
            toolName: probe.toolName,
            httpStatus: probe.httpStatus,
            authFailure: probe.authFailure,
            evidence: evidenceString(probe.evidence),
          }),
        });
        if (!probe.success) {
          degraded = true;
          if (probe.authFailure) await recordAuthProbeFailure(configuredAuthProbe, probe);
        }
      } catch (err) {
        degraded = true;
        const httpStatus = typeof (err as { httpStatus?: unknown }).httpStatus === 'number' ? (err as { httpStatus: number }).httpStatus : undefined;
        const authFailure = httpStatus === 401 || httpStatus === 403 || looksLikeAuthFailure(errMessage(err));
        const probeResult: DownstreamAuthenticatedProbeResult = {
          toolName: configuredAuthProbe.toolName,
          success: false,
          authFailure,
          ...(httpStatus !== undefined ? { httpStatus } : {}),
          failureCode: httpStatus === 401 ? 'unauthorized' : httpStatus === 403 ? 'forbidden' : 'downstream_auth_probe_failed',
          message: errMessage(err),
          evidence: sanitizeAuthFailureValue({ error: errMessage(err), httpStatus }),
        };
        push({
          step: 'downstream_auth_probe',
          status: authFailure ? 'degraded' : 'failed',
          error: errMessage(err),
          metadata: probeMetadata(configuredAuthProbe, {
            httpStatus,
            authFailure,
            evidence: evidenceString(probeResult.evidence),
          }),
        });
        if (authFailure) await recordAuthProbeFailure(configuredAuthProbe, probeResult);
      }
    }
  }

  const status: PropagationStatus = degraded ? 'degraded' : 'ok';
  await record(status);
  await recordProof(status);
  const result = { status, service, scheme, secretName, containerName, events };
  if (status === 'ok') {
    deps.logger.info('ToolHive token propagation proof succeeded', { service, scheme, secretName, containerName });
  } else {
    deps.logger.warn('ToolHive token propagation proof degraded', { service, scheme, secretName, containerName });
  }
  return result;
}
