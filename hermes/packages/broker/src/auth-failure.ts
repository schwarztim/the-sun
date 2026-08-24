import { z } from 'zod';

export const ConsumerAuthFailureClassificationSchema = z.enum(['auth_recovery', 'transient']);
export const ConsumerCredentialStatusSchema = z.enum(['valid', 'suspect', 'degraded']);

export const ConsumerAuthFailureEventSchema = z.object({
  classification: ConsumerAuthFailureClassificationSchema,
  credentialStatus: ConsumerCredentialStatusSchema,
  at: z.number().int().nonnegative(),
  httpStatus: z.number().int().min(100).max(599).optional(),
  failureCode: z.string().optional(),
  backend: z.string().optional(),
  tool: z.string().optional(),
  endpointClass: z.string().optional(),
  correlationId: z.string().optional(),
  message: z.string().optional(),
  errorEvidence: z.unknown().optional(),
});

export type ConsumerAuthFailureClassification = z.infer<typeof ConsumerAuthFailureClassificationSchema>;
export type ConsumerCredentialStatus = z.infer<typeof ConsumerCredentialStatusSchema>;
export type ConsumerAuthFailureEvent = z.infer<typeof ConsumerAuthFailureEventSchema>;

export interface AuthFailureReportInput {
  service?: unknown;
  scheme?: unknown;
  httpStatus?: unknown;
  statusCode?: unknown;
  status?: unknown;
  failureCode?: unknown;
  errorCode?: unknown;
  code?: unknown;
  reason?: unknown;
  backend?: unknown;
  tool?: unknown;
  endpointClass?: unknown;
  endpoint_class?: unknown;
  endpoint?: unknown;
  observedAt?: unknown;
  correlationId?: unknown;
  correlation_id?: unknown;
  message?: unknown;
  statusText?: unknown;
  evidence?: unknown;
  errorEvidence?: unknown;
  error?: unknown;
  response?: unknown;
}

export interface NormalizedAuthFailureReport {
  service: string;
  scheme: string;
  httpStatus?: number;
  failureCode?: string;
  backend?: string;
  tool?: string;
  endpointClass?: string;
  observedAt: number;
  correlationId?: string;
  message?: string;
  errorEvidence?: unknown;
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
  classification: ConsumerAuthFailureClassification;
  forceRecovery: boolean;
  credentialStatus: ConsumerCredentialStatus;
  guidance: AuthFailureGuidance;
  report: NormalizedAuthFailureReport;
}

const DEFAULT_TRANSIENT_RETRY_AFTER_MS = 30_000;

function sanitizeText(raw: unknown): string {
  return String(raw)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(access[_-]?token|refresh[_-]?token|id[_-]?token|authorization|token|secret|password|api[_-]?key)\b\s*[:=]\s*[^,\s;]+/gi, '$1=[redacted]')
    .replace(/\b(cookie|set-cookie|session|csrf|xsrf)\b\s*[:=]\s*[^,\n;]+/gi, '$1=[redacted]')
    .slice(0, 500);
}

function cleanUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function optionalString(value: unknown, maxLength = 200): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const str = String(value).trim();
  if (!str) return undefined;
  return sanitizeText(str).slice(0, maxLength);
}

function optionalHttpStatus(input: AuthFailureReportInput): number | undefined {
  const raw = input.httpStatus ?? input.statusCode ?? input.status;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 100 && raw <= 599) return raw;
  if (typeof raw === 'string' && /^\d+$/.test(raw)) {
    const parsed = Number(raw);
    if (parsed >= 100 && parsed <= 599) return parsed;
  }
  return undefined;
}

function observedAt(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.trunc(value);
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return Date.now();
}

export function sanitizeAuthFailureValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[redacted]';
  if (typeof value === 'string') return sanitizeText(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((entry) => sanitizeAuthFailureValue(entry, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (/^(access[_-]?token|refresh[_-]?token|id[_-]?token|authorization|token|secret|password|cookie|set-cookie|api[_-]?key|x-api-key)$/i.test(key)) {
        out[key] = '[redacted]';
      } else {
        out[key] = sanitizeAuthFailureValue(entry, depth + 1);
      }
    }
    return out;
  }
  return undefined;
}

function rawEvidence(input: AuthFailureReportInput): unknown {
  if (input.errorEvidence !== undefined) return input.errorEvidence;
  if (input.evidence !== undefined) return input.evidence;
  if (input.error !== undefined) return input.error;
  if (input.response !== undefined) return input.response;
  const message = optionalString(input.message ?? input.statusText);
  return message ? { message } : undefined;
}

export function normalizeAuthFailureReport(input: AuthFailureReportInput, defaults: { service?: string; scheme?: string } = {}): NormalizedAuthFailureReport {
  const service = optionalString(defaults.service ?? input.service, 120);
  const scheme = optionalString(defaults.scheme ?? input.scheme, 120);
  if (!service) throw new Error('service is required');
  if (!scheme) throw new Error('scheme is required');
  const evidence = rawEvidence(input);
  return cleanUndefined({
    service,
    scheme,
    httpStatus: optionalHttpStatus(input),
    failureCode: optionalString(input.failureCode ?? input.errorCode ?? input.code ?? input.reason, 120),
    backend: optionalString(input.backend, 200),
    tool: optionalString(input.tool, 200),
    endpointClass: optionalString(input.endpointClass ?? input.endpoint_class ?? input.endpoint, 200),
    observedAt: observedAt(input.observedAt),
    correlationId: optionalString(input.correlationId ?? input.correlation_id, 200),
    message: optionalString(input.message ?? input.statusText, 500),
    errorEvidence: evidence === undefined ? undefined : sanitizeAuthFailureValue(evidence),
  });
}

function normalizedFailureCode(report: NormalizedAuthFailureReport): string {
  return (report.failureCode ?? '').trim().toLowerCase().replace(/[-\s]+/g, '_');
}

export function shouldForceAuthRecovery(report: NormalizedAuthFailureReport): boolean {
  const code = normalizedFailureCode(report);
  return report.httpStatus === 401
    || report.httpStatus === 403
    || [
      'invalid_session',
      'csrf_failed',
      'csrf_invalid',
      'missing_or_invalid_g_ck',
      'api_unauthorized',
      'api_forbidden',
      'session_info_unavailable',
      'instance_redirect_or_login_route_changed',
      'unauthorized',
      'forbidden',
    ].includes(code);
}

export function classifyAuthFailure(report: NormalizedAuthFailureReport): ConsumerAuthFailureClassification {
  if (shouldForceAuthRecovery(report)) return 'auth_recovery';
  const code = normalizedFailureCode(report);
  if ((report.httpStatus !== undefined && report.httpStatus >= 500) || ['network', 'timeout', 'transient', 'econnreset', 'etimedout'].includes(code)) {
    return 'transient';
  }
  return 'transient';
}

export function authFailureGuidance(report: NormalizedAuthFailureReport, forceRecovery = shouldForceAuthRecovery(report)): AuthFailureGuidance {
  if (forceRecovery) {
    return {
      retryable: true,
      retryAfterMs: 0,
      nextAction: 'request_fresh_token_then_retry_downstream',
      remediation: `Hermes marked ${report.service}:${report.scheme} suspect; request a fresh token, retry the downstream request, and run: hermes acquire ${report.service} only if Hermes returns INTERACTIVE_AUTH_REQUIRED.`,
    };
  }
  return {
    retryable: true,
    retryAfterMs: DEFAULT_TRANSIENT_RETRY_AFTER_MS,
    nextAction: 'retry_downstream_without_reauth',
    remediation: `Recorded transient downstream failure for ${report.service}:${report.scheme}; retry the downstream request after ${Math.ceil(DEFAULT_TRANSIENT_RETRY_AFTER_MS / 1000)}s without rotating credentials.`,
  };
}

export function authFailureEventFromReport(report: NormalizedAuthFailureReport): ConsumerAuthFailureEvent {
  const forceRecovery = shouldForceAuthRecovery(report);
  return cleanUndefined({
    classification: classifyAuthFailure(report),
    credentialStatus: forceRecovery ? 'suspect' : 'degraded',
    at: report.observedAt,
    httpStatus: report.httpStatus,
    failureCode: report.failureCode,
    backend: report.backend,
    tool: report.tool,
    endpointClass: report.endpointClass,
    correlationId: report.correlationId,
    message: report.message,
    errorEvidence: report.errorEvidence,
  });
}

export function sanitizeAuthFailureEvent(event: ConsumerAuthFailureEvent): ConsumerAuthFailureEvent {
  return cleanUndefined({
    ...event,
    failureCode: optionalString(event.failureCode, 120),
    backend: optionalString(event.backend, 200),
    tool: optionalString(event.tool, 200),
    endpointClass: optionalString(event.endpointClass, 200),
    correlationId: optionalString(event.correlationId, 200),
    message: event.message ? sanitizeText(event.message) : undefined,
    errorEvidence: event.errorEvidence === undefined ? undefined : sanitizeAuthFailureValue(event.errorEvidence),
  });
}
