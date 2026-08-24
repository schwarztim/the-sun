import { HermesClientError, HermesClientErrorCode } from './errors.js';
import { ClientDedupMutex } from './mutex.js';

export interface TokenBundle {
  service: string; scheme: string; accessToken: string; refreshToken?: string;
  tokenType: string; expiresAt: number; acquiredAt: number; scope?: string;
  extra?: Record<string, unknown>;
}

export interface ClientFetchResponse { ok: boolean; status: number; json(): Promise<any>; text(): Promise<string>; }
export type ClientFetch = (url: string, init: { method?: string; headers: Record<string, string>; body?: string }) => Promise<ClientFetchResponse>;

export interface AuthFailureReport {
  httpStatus?: number;
  failureCode?: string;
  backend?: string;
  tool?: string;
  endpointClass?: string;
  observedAt?: number | string;
  correlationId?: string;
  message?: string;
  errorEvidence?: unknown;
  evidence?: unknown;
}

export interface AuthFailureGuidance {
  retryable: boolean;
  retryAfterMs?: number;
  nextAction: string;
  remediation: string;
}

export interface AuthFailureReportResult {
  status: 'recorded';
  service: string;
  scheme: string;
  classification: 'auth_recovery' | 'transient';
  forceRecovery: boolean;
  credentialStatus: 'suspect' | 'degraded' | 'valid';
  guidance: AuthFailureGuidance;
  report: Record<string, unknown>;
}

export interface HermesClientOptions {
  brokerUrl: string; clientToken: string; retries?: number; retryDelayMs?: number; fetch?: ClientFetch;
}

export interface CredentialHeaderOptions {
  headerName?: string;
  headerValuePrefix?: string;
  tokenType?: string;
  additionalHeaders?: Record<string, string>;
}

export interface HermesCredential {
  service: string;
  scheme: string;
  token: string;
  tokenType: string;
  expiresAt: number;
  acquiredAt: number;
  scope?: string;
  extra?: Record<string, unknown>;
  headers: Record<string, string>;
  bundle: TokenBundle;
}

export interface AuthResponseLike {
  ok?: boolean;
  status?: number;
  statusCode?: number;
  httpStatus?: number;
  statusText?: string;
  headers?: { get(name: string): string | null | undefined } | Record<string, unknown>;
  clone?: () => AuthResponseLike;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
}

export interface ClassifyAuthResponseOptions {
  failureCode?: string;
  message?: string;
  evidence?: unknown;
  authFailureCodes?: readonly string[];
}

export interface AuthResponseClassification {
  classification: 'auth_failure' | 'non_auth_failure';
  authFailure: boolean;
  httpStatus?: number;
  failureCode?: string;
  message?: string;
  evidence?: unknown;
  report: AuthFailureReport;
}

export interface HermesAuthRetryContext {
  service: string;
  scheme: string;
  attempt: number;
}

export type HermesAuthenticatedOperation<T> = (credential: HermesCredential, context: HermesAuthRetryContext) => Promise<T>;

export interface WithHermesAuthRetryOptions {
  credentialHeaders?: CredentialHeaderOptions;
  classify?: ClassifyAuthResponseOptions;
  backend?: string;
  tool?: string;
  endpointClass?: string;
  correlationId?: string;
  maxAuthRetries?: number;
  isRetrySafe?: boolean | ((classification: AuthResponseClassification, context: HermesAuthRetryContext) => boolean);
}

const REMOTE_CODE_MAP: Record<string, HermesClientErrorCode> = {
  ACQUIRE_REQUIRED: HermesClientErrorCode.ACQUIRE_REQUIRED,
  INTERACTIVE_AUTH_REQUIRED: HermesClientErrorCode.ACQUIRE_REQUIRED,
  REFRESH_FAILED: HermesClientErrorCode.UPSTREAM,
  SERVICE_NOT_REGISTERED: HermesClientErrorCode.SERVICE_NOT_REGISTERED,
  PROVIDER_NOT_FOUND: HermesClientErrorCode.SERVICE_NOT_REGISTERED,
  UNAUTHORIZED: HermesClientErrorCode.UNAUTHORIZED,
  OFFLINE: HermesClientErrorCode.OFFLINE,
  RATE_LIMITED: HermesClientErrorCode.RATE_LIMITED,
};

/** Minimum memo window for OFFLINE short-circuiting (Retry-After floor). */
const OFFLINE_MEMO_FLOOR_MS = 30_000;
/** Minimum delay before retrying a 503 REFRESH_IN_PROGRESS response. */
const REFRESH_IN_PROGRESS_RETRY_FLOOR_MS = 1_000;

const AUTH_FAILURE_CODES = new Set(['invalid_session', 'csrf_failed', 'unauthorized', 'forbidden']);
const API_TOKEN_TYPES = new Set(['api_token', 'api-token', 'apitoken', 'api_key', 'api-key', 'apikey', 'x_api_key', 'x-api-key']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function cleanUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const str = String(value).trim();
  return str ? str : undefined;
}

function normalizeCode(value: unknown): string | undefined {
  const raw = optionalString(value);
  return raw?.toLowerCase().replace(/[-\s]+/g, '_');
}

function optionalStatus(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (parsed >= 100 && parsed <= 599) return parsed;
  }
  return undefined;
}

function valueFromExtra(extra: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!extra) return undefined;
  for (const key of keys) {
    const value = optionalString(extra[key]);
    if (value) return value;
  }
  return undefined;
}

function withPrefix(token: string, prefix?: string): string {
  const p = optionalString(prefix);
  return p ? `${p} ${token}` : token;
}

export function credentialHeaders(bundle: TokenBundle, options: CredentialHeaderOptions = {}): Record<string, string> {
  const tokenType = (options.tokenType ?? bundle.tokenType ?? 'Bearer').trim() || 'Bearer';
  const normalized = normalizeCode(tokenType) ?? 'bearer';
  const headerName = options.headerName ?? valueFromExtra(bundle.extra, ['headerName', 'header', 'authHeaderName']);
  const headerValuePrefix = options.headerValuePrefix ?? valueFromExtra(bundle.extra, ['headerValuePrefix', 'headerPrefix', 'authHeaderPrefix']);

  let headers: Record<string, string>;
  if (headerName) {
    headers = { [headerName]: withPrefix(bundle.accessToken, headerValuePrefix) };
  } else if (normalized === 'cookie') {
    headers = { Cookie: bundle.accessToken };
  } else if (API_TOKEN_TYPES.has(normalized)) {
    headers = { 'X-API-Token': withPrefix(bundle.accessToken, headerValuePrefix) };
  } else if (normalized === 'sessionstoragetoken' || normalized === 'oauth' || normalized === 'oauth2') {
    headers = { Authorization: `Bearer ${bundle.accessToken}` };
  } else {
    headers = { Authorization: `${tokenType} ${bundle.accessToken}` };
  }
  return { ...headers, ...(options.additionalHeaders ?? {}) };
}

export function credentialFromBundle(bundle: TokenBundle, options: CredentialHeaderOptions = {}): HermesCredential {
  return cleanUndefined({
    service: bundle.service,
    scheme: bundle.scheme,
    token: bundle.accessToken,
    tokenType: bundle.tokenType,
    expiresAt: bundle.expiresAt,
    acquiredAt: bundle.acquiredAt,
    scope: bundle.scope,
    extra: bundle.extra,
    headers: credentialHeaders(bundle, options),
    bundle,
  });
}

function responseSource(input: unknown): unknown {
  if (isRecord(input) && input.response !== undefined) return input.response;
  return input;
}

function statusFrom(input: unknown): number | undefined {
  if (!isRecord(input)) return undefined;
  return optionalStatus(input.httpStatus ?? input.statusCode ?? input.status);
}

function messageFrom(input: unknown): string | undefined {
  if (input instanceof Error) return input.message;
  if (!isRecord(input)) return undefined;
  return optionalString(input.message ?? input.statusText);
}

function codeFrom(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  return optionalString(input.failureCode ?? input.errorCode ?? input.code ?? input.reason ?? input.error);
}

function correlationIdFrom(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  const headers = input.headers;
  if (headers && typeof (headers as { get?: unknown }).get === 'function') {
    const get = (headers as { get(name: string): string | null | undefined }).get.bind(headers);
    return optionalString(get('x-correlation-id') ?? get('x-request-id') ?? get('request-id'));
  }
  if (isRecord(headers)) {
    return optionalString(headers['x-correlation-id'] ?? headers['x-request-id'] ?? headers['request-id']);
  }
  return undefined;
}

function parseJsonText(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try { return JSON.parse(trimmed); } catch { return trimmed.slice(0, 500); }
}

async function evidenceFrom(input: unknown, status: number | undefined, hasClone: boolean): Promise<unknown> {
  if (!isRecord(input)) return undefined;
  if (input.body !== undefined && typeof input.body !== 'function') return input.body;
  const source = typeof input.clone === 'function' ? input.clone() : input;
  if (!hasClone && status !== undefined && status !== 401 && status !== 403) return undefined;
  if (isRecord(source) && typeof source.json === 'function') {
    try { return await source.json(); } catch {}
  }
  if (isRecord(source) && typeof source.text === 'function') {
    try { return parseJsonText(await source.text()); } catch {}
  }
  return undefined;
}

function fieldFromEvidence(evidence: unknown, keys: string[]): string | undefined {
  if (!isRecord(evidence)) return undefined;
  for (const key of keys) {
    const value = optionalString(evidence[key]);
    if (value) return value;
  }
  const nested = evidence.error ?? evidence.errorResponse ?? evidence.response;
  if (isRecord(nested)) return fieldFromEvidence(nested, keys);
  return undefined;
}

export async function classifyAuthResponse(input: unknown, options: ClassifyAuthResponseOptions = {}): Promise<AuthResponseClassification> {
  const source = responseSource(input);
  const status = statusFrom(source) ?? statusFrom(input);
  const hasClone = isRecord(source) && typeof source.clone === 'function';
  const evidence = options.evidence ?? await evidenceFrom(source, status, hasClone);
  const failureCode = optionalString(options.failureCode)
    ?? codeFrom(input)
    ?? codeFrom(source)
    ?? fieldFromEvidence(evidence, ['failureCode', 'errorCode', 'code', 'reason', 'error']);
  const message = options.message
    ?? messageFrom(input)
    ?? messageFrom(source)
    ?? fieldFromEvidence(evidence, ['message', 'statusText', 'error_description']);
  const normalizedCode = normalizeCode(failureCode);
  const authCodes = new Set([...AUTH_FAILURE_CODES, ...(options.authFailureCodes ?? []).map((code) => normalizeCode(code)).filter((code): code is string => !!code)]);
  const authFailure = status === 401 || status === 403 || (normalizedCode !== undefined && authCodes.has(normalizedCode));
  const classificationValue: AuthResponseClassification['classification'] = authFailure ? 'auth_failure' : 'non_auth_failure';
  const report = cleanUndefined({
    httpStatus: status,
    failureCode,
    message,
    correlationId: correlationIdFrom(source) ?? correlationIdFrom(input),
    errorEvidence: evidence,
  });
  return cleanUndefined({
    classification: classificationValue,
    authFailure,
    httpStatus: status,
    failureCode,
    message,
    evidence,
    report,
  });
}

function reportFromClassification(classification: AuthResponseClassification, options: WithHermesAuthRetryOptions): AuthFailureReport {
  return cleanUndefined({
    ...classification.report,
    backend: options.backend,
    tool: options.tool,
    endpointClass: options.endpointClass,
    correlationId: options.correlationId ?? classification.report.correlationId,
  });
}

function authFailureError(result: AuthFailureReportResult): HermesClientError {
  return new HermesClientError(HermesClientErrorCode.ACQUIRE_REQUIRED, `downstream auth failure for ${result.service}:${result.scheme}`, {
    remediation: result.guidance.remediation,
    retryable: result.guidance.retryable,
    retryAfterMs: result.guidance.retryAfterMs,
  });
}

function isRetrySafe(options: WithHermesAuthRetryOptions, classification: AuthResponseClassification, context: HermesAuthRetryContext): boolean {
  if (typeof options.isRetrySafe === 'function') return options.isRetrySafe(classification, context);
  return options.isRetrySafe ?? true;
}

export class HermesClient {
  private readonly mutex = new ClientDedupMutex();
  private readonly retries: number;
  private readonly retryDelayMs: number;
  private readonly doFetch: ClientFetch;
  /** Per service:scheme OFFLINE memo. While an entry is live the client
   *  short-circuits without an HTTP call — generated MCPs naturally back off
   *  instead of hot-looping a broker that cannot reach the IdP. */
  private readonly offlineMemo = new Map<string, { until: number; error: HermesClientError }>();
  constructor(private readonly opts: HermesClientOptions) {
    this.retries = opts.retries ?? 2;
    this.retryDelayMs = opts.retryDelayMs ?? 200;
    this.doFetch = opts.fetch ?? (async (url, init) => {
      const r = await (globalThis as any).fetch(url, init);
      return { ok: r.ok, status: r.status, json: () => r.json(), text: () => r.text() };
    });
  }

  async getToken(service: string, scheme: string): Promise<TokenBundle> {
    return this.mutex.runDedup(`${service}:${scheme}`, () => this.fetchWithRetry(service, scheme));
  }

  async getCredential(service: string, scheme: string, options: CredentialHeaderOptions = {}): Promise<HermesCredential> {
    return credentialFromBundle(await this.getToken(service, scheme), options);
  }

  async authHeaders(service: string, scheme: string): Promise<Record<string, string>> {
    return (await this.getCredential(service, scheme)).headers;
  }

  async reportAuthFailure(service: string, scheme: string, report: AuthFailureReport): Promise<AuthFailureReportResult> {
    const url = `${this.opts.brokerUrl}/token/${encodeURIComponent(service)}/${encodeURIComponent(scheme)}/report-failure`;
    let resp: ClientFetchResponse;
    try {
      resp = await this.doFetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.opts.clientToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(report),
      });
    } catch (err) {
      throw new HermesClientError(HermesClientErrorCode.BROKER_UNREACHABLE, `fetch failed: ${(err as Error).message}`, { cause: err });
    }
    if (!resp.ok) throw await this.errorFromResponse(resp);
    const body = await resp.json();
    if (!body || body.status !== 'recorded' || !body.guidance || typeof body.guidance.nextAction !== 'string') {
      throw new HermesClientError(HermesClientErrorCode.INVALID_RESPONSE, 'broker returned an invalid auth failure report response', { remediation: 'check broker logs' });
    }
    return body as AuthFailureReportResult;
  }

  async withHermesAuthRetry<T>(
    service: string,
    scheme: string,
    operation: HermesAuthenticatedOperation<T>,
    options: WithHermesAuthRetryOptions = {},
  ): Promise<T> {
    const maxAuthRetries = Math.max(0, Math.min(3, Math.floor(options.maxAuthRetries ?? 1)));
    let credential = await this.getCredential(service, scheme, options.credentialHeaders);
    let authRetries = 0;

    for (;;) {
      const context = { service, scheme, attempt: authRetries };
      try {
        const result = await operation(credential, context);
        const classification = await classifyAuthResponse(result, options.classify);
        if (!classification.authFailure) return result;

        const report = await this.reportAuthFailure(service, scheme, reportFromClassification(classification, options));
        if (authRetries >= maxAuthRetries || !report.guidance.retryable || !isRetrySafe(options, classification, context)) {
          throw authFailureError(report);
        }
        authRetries++;
        if (report.guidance.retryAfterMs && report.guidance.retryAfterMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, report.guidance.retryAfterMs));
        }
        credential = await this.getCredential(service, scheme, options.credentialHeaders);
      } catch (err) {
        if (err instanceof HermesClientError) throw err;
        const classification = await classifyAuthResponse(err, options.classify);
        if (!classification.authFailure) throw err;

        const report = await this.reportAuthFailure(service, scheme, reportFromClassification(classification, options));
        if (authRetries >= maxAuthRetries || !report.guidance.retryable || !isRetrySafe(options, classification, context)) {
          throw authFailureError(report);
        }
        authRetries++;
        if (report.guidance.retryAfterMs && report.guidance.retryAfterMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, report.guidance.retryAfterMs));
        }
        credential = await this.getCredential(service, scheme, options.credentialHeaders);
      }
    }
  }

  private async fetchWithRetry(service: string, scheme: string): Promise<TokenBundle> {
    const key = `${service}:${scheme}`;
    // OFFLINE short-circuit: if the broker reported OFFLINE less than
    // retryAfterMs ago, surface the memoized error WITHOUT an HTTP call.
    const memo = this.offlineMemo.get(key);
    if (memo) {
      if (memo.until > Date.now()) throw memo.error;
      this.offlineMemo.delete(key);
    }
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const bundle = await this.fetchOnce(service, scheme);
        this.offlineMemo.delete(key);
        return bundle;
      }
      catch (err) {
        lastErr = err;
        if (err instanceof HermesClientError) {
          // OFFLINE: single surface, no retry-loop, memoized per key.
          if (err.code === HermesClientErrorCode.OFFLINE) {
            const ttl = Math.max(err.retryAfterMs ?? 0, OFFLINE_MEMO_FLOOR_MS);
            this.offlineMemo.set(key, { until: Date.now() + ttl, error: err });
            throw err;
          }
          // RATE_LIMITED: honor Retry-After by NOT tight-retrying — surface immediately.
          if (err.code === HermesClientErrorCode.RATE_LIMITED) throw err;
          if (err.code !== HermesClientErrorCode.BROKER_UNREACHABLE && !err.retryable) throw err;
          if (attempt < this.retries) {
            let delayMs = err.retryAfterMs ?? this.retryDelayMs * (attempt + 1);
            // 503 REFRESH_IN_PROGRESS (or any retryable 503): floor the delay
            // at 1s so a missing/zero retryAfterMs cannot produce a hot loop.
            if (err.status === 503) delayMs = Math.max(err.retryAfterMs ?? 0, REFRESH_IN_PROGRESS_RETRY_FLOOR_MS);
            await new Promise((r) => setTimeout(r, delayMs));
          }
        } else if (attempt < this.retries) {
          await new Promise((r) => setTimeout(r, this.retryDelayMs * (attempt + 1)));
        }
      }
    }
    throw new HermesClientError(HermesClientErrorCode.BROKER_UNREACHABLE, `broker at ${this.opts.brokerUrl} unreachable after ${this.retries + 1} attempts`, { cause: lastErr, remediation: 'ensure hermes is running' });
  }

  private async fetchOnce(service: string, scheme: string): Promise<TokenBundle> {
    const url = `${this.opts.brokerUrl}/token/${encodeURIComponent(service)}/${encodeURIComponent(scheme)}`;
    let resp: ClientFetchResponse;
    try { resp = await this.doFetch(url, { method: 'GET', headers: { Authorization: `Bearer ${this.opts.clientToken}` } }); }
    catch (err) { throw new HermesClientError(HermesClientErrorCode.BROKER_UNREACHABLE, `fetch failed: ${(err as Error).message}`, { cause: err }); }
    if (!resp.ok) {
      throw await this.errorFromResponse(resp);
    }
    const bundle = await resp.json();
    if (!bundle || typeof bundle.accessToken !== 'string' || !bundle.accessToken) {
      throw new HermesClientError(HermesClientErrorCode.INVALID_RESPONSE, 'broker returned a response without a valid accessToken', { remediation: 'check broker logs' });
    }
    return bundle as TokenBundle;
  }

  private async errorFromResponse(resp: ClientFetchResponse): Promise<HermesClientError> {
    let body: any = {};
    try { body = await resp.json(); } catch {}
    const mapped = REMOTE_CODE_MAP[body.code]
      ?? (resp.status === 429 ? HermesClientErrorCode.RATE_LIMITED : HermesClientErrorCode.UPSTREAM);
    return new HermesClientError(mapped, body.message ?? `broker returned ${resp.status}`, {
      status: resp.status,
      remediation: body.remediation,
      remediationCommands: Array.isArray(body.remediationCommands) ? body.remediationCommands : [],
      category: typeof body.category === 'string' ? body.category : undefined,
      retryable: body.retryable === true,
      retryAfterMs: typeof body.retryAfterMs === 'number' ? body.retryAfterMs : undefined,
      retryHint: typeof body.retryHint === 'string' ? body.retryHint : undefined,
    });
  }
}
