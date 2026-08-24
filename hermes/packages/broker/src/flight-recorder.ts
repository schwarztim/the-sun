import { createHash, randomUUID } from 'node:crypto';
import {
  authFailureGuidance,
  classifyAuthFailure,
  normalizeAuthFailureReport,
  shouldForceAuthRecovery,
  type AuthFailureGuidance,
  type AuthFailureReportInput,
  type ConsumerAuthFailureClassification,
  type ConsumerCredentialStatus,
  type NormalizedAuthFailureReport,
} from './auth-failure.js';
import type { CredentialArtifactProof, CredentialArtifactProofStatus, CredentialArtifactFreshness, CredentialArtifactKind } from './credential-artifacts.js';
import {
  analyzeTransportFailure,
  classifyTransportFailure,
  type TransportFailureAnalysis,
  type TransportFailureClassification,
  type TransportRecoveryGuidance,
} from './transport-failure.js';

export type FlightFailureDomain = 'none' | 'auth' | 'transport' | 'application';
export type FlightApplicationFailureClassification = 'http_error' | 'tool_error' | 'unexpected_response' | 'unknown_application_failure';

type JsonPrimitive = string | number | boolean | null;
export type FlightRecorderJsonValue = JsonPrimitive | FlightRecorderJsonValue[] | { [key: string]: FlightRecorderJsonValue };

export interface FlightRecorderRequest {
  capability?: string;
  tool?: string;
  operation?: string;
  endpointClass?: string;
  args?: FlightRecorderJsonValue;
}

export interface FlightRecorderIdentity {
  backendAlias?: string;
  canonicalService: string;
  requestedService?: string;
  scheme?: string;
  providerName?: string;
}

export interface CredentialArtifactProofSummary {
  kind: CredentialArtifactKind;
  artifactIdDigest: string;
  fingerprint: string;
  observedAt: number;
  proofStatus: CredentialArtifactProofStatus;
  freshness: CredentialArtifactFreshness;
  producedBy?: string;
  service?: string;
  scheme?: string;
}

export interface AuthFlightFailure {
  domain: 'auth';
  classification: ConsumerAuthFailureClassification;
  credentialStatus: ConsumerCredentialStatus;
  httpStatus?: number;
  failureCode?: string;
  report: NormalizedAuthFailureReport;
}

export interface TransportFlightFailure {
  domain: 'transport';
  classification: TransportFailureClassification;
  authFailure: false;
  credentialStatus: 'unchanged';
}

export interface ApplicationFlightFailure {
  domain: 'application';
  classification: FlightApplicationFailureClassification;
  httpStatus?: number;
  failureCode?: string;
  credentialStatus: 'unchanged';
}

export interface NoFlightFailure {
  domain: 'none';
  classification: 'none';
  credentialStatus: 'unchanged';
}

export type FlightFailure = AuthFlightFailure | TransportFlightFailure | ApplicationFlightFailure | NoFlightFailure;
export type FlightRecoveryGuidance = AuthFailureGuidance | TransportRecoveryGuidance | {
  retryable: boolean;
  nextAction: string;
  remediation: string;
};

export interface FlightRecord {
  recordType: 'hermes.auth_transport_flight';
  correlationId: string;
  startedAt: number;
  completedAt: number;
  durationMs: number;
  request: FlightRecorderRequest;
  identity: FlightRecorderIdentity;
  credentialArtifactProofs: CredentialArtifactProofSummary[];
  failure: FlightFailure;
  recoveryGuidance: FlightRecoveryGuidance;
  evidence?: FlightRecorderJsonValue;
}

export interface FlightRecorderFailureInput {
  domain?: 'auto' | FlightFailureDomain;
  evidence?: unknown;
  auth?: AuthFailureReportInput;
  transport?: unknown;
  application?: unknown;
}

export interface FlightRecordInput {
  correlationId?: string;
  startedAt?: number;
  completedAt?: number;
  requestedCapability?: string;
  capability?: string;
  tool?: string;
  operation?: string;
  endpointClass?: string;
  args?: unknown;
  backendAlias?: string;
  canonicalService?: string;
  requestedService?: string;
  service?: string;
  scheme?: string;
  providerName?: string;
  credentialArtifactProofs?: CredentialArtifactProof[];
  failure?: FlightRecorderFailureInput;
  evidence?: unknown;
}

export interface FlightRecorderOptions {
  now?: () => number;
  correlationId?: () => string;
  maxRecords?: number;
}

const DEFAULT_TEXT_LIMIT = 2_000;
const DEFAULT_ARRAY_LIMIT = 20;

const SECRET_KEY_PATTERN = /^(authorization|proxy-authorization|cookie|set-cookie|x-skypetoken|x-csrftoken|x-xsrf-token|x-api-key|api-key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|skype[_-]?token|token|secret|password|passwd|pwd|client[_-]?secret|private[_-]?key|session[_-]?id)$/i;
const BODY_KEY_PATTERN = /^(body|requestBody|responseBody|payload|content|contents|html|messageBody|messages|chatMessage|chatMessages)$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function cleanUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function digest(value: unknown, length = 32): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex').slice(0, length)}`;
}

function stableValue(value: unknown): FlightRecorderJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(stableValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    ) as Record<string, FlightRecorderJsonValue>;
  }
  return String(value);
}

function redactUrlSecrets(raw: string): string {
  return raw.replace(/https?:\/\/[^\s"'<>]+/giu, (match) => {
    try {
      const parsed = new URL(match);
      parsed.username = parsed.username ? '[redacted]' : '';
      parsed.password = parsed.password ? '[redacted]' : '';
      parsed.search = parsed.search ? '?[redacted]' : '';
      parsed.hash = parsed.hash ? '#[redacted]' : '';
      return parsed.toString();
    } catch {
      return match.replace(/\/\/[^/@\s]+@/u, '//[redacted]@').replace(/[?#][^\s"'<>]*/u, '?[redacted]');
    }
  });
}

function redactSecretText(raw: string): string {
  return redactUrlSecrets(raw)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [redacted]')
    .replace(/Basic\s+[A-Za-z0-9+/=-]+/giu, 'Basic [redacted]')
    .replace(/(authorization|proxy-authorization|cookie|set-cookie|x-skypetoken|x-api-key|api-key|apikey)\s*[:=]\s*[^,;\n\r]+/giu, '$1=[redacted]')
    .replace(/\b(access[_-]?token|refresh[_-]?token|id[_-]?token|skype[_-]?token|token|secret|password|passwd|pwd|client[_-]?secret|api[_-]?key|session[_-]?id)\b\s*[:=]\s*[^,;\s\n\r]+/giu, '$1=[redacted]')
    .replace(/"(body|requestBody|responseBody|payload|content|messageBody)"\s*:\s*"(?:\\.|[^"\\])*"/giu, '"$1":"[redacted]"')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu, '[redacted-jwt]')
    .replace(/\b(skypetoken|api[_-]?key|secret)[A-Za-z0-9._~+/=-]{16,}\b/giu, '[redacted-secret]')
    .slice(0, DEFAULT_TEXT_LIMIT);
}

export function redactFlightRecorderValue(value: unknown, depth = 0): FlightRecorderJsonValue {
  if (depth > 6) return '[redacted]';
  if (typeof value === 'string') return redactSecretText(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, DEFAULT_ARRAY_LIMIT).map((entry) => redactFlightRecorderValue(entry, depth + 1));
  if (value instanceof Error) {
    return cleanUndefined({ name: value.name, message: redactSecretText(value.message) });
  }
  if (isRecord(value)) {
    const out: Record<string, FlightRecorderJsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (SECRET_KEY_PATTERN.test(key) || BODY_KEY_PATTERN.test(key)) {
        out[key] = '[redacted]';
      } else {
        out[key] = redactFlightRecorderValue(entry, depth + 1);
      }
    }
    return out;
  }
  if (value === undefined) return '[redacted]';
  return redactSecretText(String(value));
}

function optionalString(value: unknown, maxLength = 200): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const trimmed = redactSecretText(String(value).trim());
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function directHttpStatus(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (parsed >= 100 && parsed <= 599) return parsed;
  }
  return undefined;
}

function findHttpStatus(value: unknown, depth = 0): number | undefined {
  if (depth > 5) return undefined;
  if (isRecord(value)) {
    const direct = directHttpStatus(value.httpStatus ?? value.statusCode ?? value.status);
    if (direct !== undefined) return direct;
    for (const entry of Object.values(value)) {
      const nested = findHttpStatus(entry, depth + 1);
      if (nested !== undefined) return nested;
    }
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const nested = findHttpStatus(entry, depth + 1);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

function findFailureCode(value: unknown, depth = 0): string | undefined {
  if (depth > 5) return undefined;
  if (isRecord(value)) {
    const direct = optionalString(value.failureCode ?? value.errorCode ?? value.reason, 120);
    if (direct) return direct;
    const code = value.code;
    if (typeof code === 'string' || (typeof code === 'number' && code > 0)) return optionalString(code, 120);
    for (const entry of Object.values(value)) {
      const nested = findFailureCode(entry, depth + 1);
      if (nested) return nested;
    }
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const nested = findFailureCode(entry, depth + 1);
      if (nested) return nested;
    }
  }
  return undefined;
}

function findMessage(value: unknown, depth = 0): string | undefined {
  if (depth > 5) return undefined;
  if (value instanceof Error) return optionalString(value.message, 500);
  if (isRecord(value)) {
    const direct = optionalString(value.message ?? value.statusText, 500);
    if (direct) return direct;
    for (const entry of Object.values(value)) {
      const nested = findMessage(entry, depth + 1);
      if (nested) return nested;
    }
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const nested = findMessage(entry, depth + 1);
      if (nested) return nested;
    }
  }
  if (typeof value === 'string') return optionalString(value, 500);
  return undefined;
}

function proofSummary(proof: CredentialArtifactProof): CredentialArtifactProofSummary {
  return cleanUndefined({
    kind: proof.kind,
    artifactIdDigest: digest(proof.artifactId),
    fingerprint: proof.fingerprint,
    observedAt: proof.observedAt,
    proofStatus: proof.proofStatus,
    freshness: proof.freshness,
    producedBy: proof.producedBy,
    service: proof.service,
    scheme: proof.scheme,
  });
}

function applicationClassification(evidence: unknown): FlightApplicationFailureClassification {
  const status = findHttpStatus(evidence);
  if (status !== undefined) return 'http_error';
  const text = findMessage(evidence)?.toLowerCase() ?? '';
  if (/unexpected|invalid shape|schema|parse/.test(text)) return 'unexpected_response';
  if (/tool|call/.test(text)) return 'tool_error';
  return 'unknown_application_failure';
}

function applicationGuidance(status: number | undefined): FlightRecoveryGuidance {
  const retryable = status === undefined ? false : status >= 500 || status === 408 || status === 429;
  return {
    retryable,
    nextAction: retryable ? 'retry_application_call_after_backoff' : 'inspect_application_error_before_retry',
    remediation: retryable
      ? 'Application failure appears retryable; retry with backoff after confirming the transport session is healthy.'
      : 'Application failure is not classified as auth or transport; inspect sanitized evidence before changing credentials.',
  };
}

function authFailureFromEvidence(
  input: FlightRecordInput,
  evidence: unknown,
  authInput: AuthFailureReportInput = {},
): { failure: AuthFlightFailure; guidance: AuthFailureGuidance } {
  const service = input.canonicalService ?? input.service ?? input.requestedService;
  const scheme = input.scheme ?? 'default';
  const report = normalizeAuthFailureReport({
    ...authInput,
    service: authInput.service ?? service,
    scheme: authInput.scheme ?? scheme,
    httpStatus: authInput.httpStatus ?? authInput.statusCode ?? authInput.status ?? findHttpStatus(evidence),
    failureCode: authInput.failureCode ?? authInput.errorCode ?? authInput.code ?? findFailureCode(evidence),
    backend: authInput.backend ?? input.backendAlias,
    tool: authInput.tool ?? input.tool,
    endpointClass: authInput.endpointClass ?? input.endpointClass,
    correlationId: authInput.correlationId ?? input.correlationId,
    message: authInput.message ?? findMessage(evidence),
    evidence: redactFlightRecorderValue(authInput.evidence ?? evidence),
  });
  const forceRecovery = shouldForceAuthRecovery(report);
  const failure: AuthFlightFailure = cleanUndefined({
    domain: 'auth',
    classification: classifyAuthFailure(report),
    credentialStatus: forceRecovery ? 'suspect' : 'degraded',
    httpStatus: report.httpStatus,
    failureCode: report.failureCode,
    report,
  });
  return { failure, guidance: authFailureGuidance(report, forceRecovery) };
}

function transportFailureFromEvidence(input: FlightRecordInput, evidence: unknown): { failure: TransportFlightFailure; guidance: TransportRecoveryGuidance } {
  const analysis: TransportFailureAnalysis = analyzeTransportFailure(evidence, {
    tool: input.tool,
    method: input.operation,
  });
  return {
    failure: {
      domain: 'transport',
      classification: analysis.classification,
      authFailure: false,
      credentialStatus: 'unchanged',
    },
    guidance: analysis.guidance,
  };
}

function classifyFailure(input: FlightRecordInput): { failure: FlightFailure; guidance: FlightRecoveryGuidance } {
  const failureInput = input.failure;
  const evidence = failureInput?.evidence ?? failureInput?.auth ?? failureInput?.transport ?? failureInput?.application ?? input.evidence;
  if (!failureInput && evidence === undefined) {
    return {
      failure: { domain: 'none', classification: 'none', credentialStatus: 'unchanged' },
      guidance: { retryable: false, nextAction: 'none', remediation: 'No failure recorded.' },
    };
  }

  const requestedDomain = failureInput?.domain ?? 'auto';
  if (requestedDomain === 'transport') return transportFailureFromEvidence(input, failureInput?.transport ?? evidence);
  if (requestedDomain === 'auth') return authFailureFromEvidence(input, failureInput?.auth ?? evidence, failureInput?.auth ?? {});
  if (requestedDomain === 'application') {
    const appEvidence = failureInput?.application ?? evidence;
    const httpStatus = findHttpStatus(appEvidence);
    const failure: ApplicationFlightFailure = cleanUndefined({
      domain: 'application',
      classification: applicationClassification(appEvidence),
      httpStatus,
      failureCode: findFailureCode(appEvidence),
      credentialStatus: 'unchanged',
    });
    return { failure, guidance: applicationGuidance(httpStatus) };
  }

  const transportClassification = classifyTransportFailure(evidence);
  if (transportClassification !== 'unknown_transport_failure') return transportFailureFromEvidence(input, evidence);
  const httpStatus = findHttpStatus(evidence);
  if (httpStatus === 401 || httpStatus === 403) return authFailureFromEvidence(input, evidence, failureInput?.auth ?? {});

  const failure: ApplicationFlightFailure = cleanUndefined({
    domain: 'application',
    classification: applicationClassification(evidence),
    httpStatus,
    failureCode: findFailureCode(evidence),
    credentialStatus: 'unchanged',
  });
  return { failure, guidance: applicationGuidance(httpStatus) };
}

export function createFlightRecord(input: FlightRecordInput, opts: FlightRecorderOptions = {}): FlightRecord {
  const now = opts.now ?? (() => Date.now());
  const correlationIdFactory = opts.correlationId ?? randomUUID;
  const startedAt = input.startedAt ?? now();
  const completedAt = input.completedAt ?? now();
  const canonicalService = input.canonicalService ?? input.service ?? input.requestedService ?? 'unknown';
  const { failure, guidance } = classifyFailure(input);
  const evidence = input.evidence ?? input.failure?.evidence ?? input.failure?.auth ?? input.failure?.transport ?? input.failure?.application;

  return cleanUndefined({
    recordType: 'hermes.auth_transport_flight',
    correlationId: input.correlationId ?? correlationIdFactory(),
    startedAt,
    completedAt,
    durationMs: Math.max(0, completedAt - startedAt),
    request: cleanUndefined({
      capability: optionalString(input.requestedCapability ?? input.capability),
      tool: optionalString(input.tool),
      operation: optionalString(input.operation),
      endpointClass: optionalString(input.endpointClass),
      args: input.args === undefined ? undefined : redactFlightRecorderValue(input.args),
    }),
    identity: cleanUndefined({
      backendAlias: optionalString(input.backendAlias),
      canonicalService: optionalString(canonicalService) ?? 'unknown',
      requestedService: optionalString(input.requestedService ?? input.service),
      scheme: optionalString(input.scheme),
      providerName: optionalString(input.providerName),
    }),
    credentialArtifactProofs: (input.credentialArtifactProofs ?? []).map(proofSummary),
    failure,
    recoveryGuidance: redactFlightRecorderValue(guidance) as FlightRecoveryGuidance,
    evidence: evidence === undefined ? undefined : redactFlightRecorderValue(evidence),
  });
}

export class FlightRecorder {
  private readonly records: FlightRecord[] = [];
  private readonly maxRecords: number;

  constructor(private readonly opts: FlightRecorderOptions = {}) {
    this.maxRecords = opts.maxRecords ?? 200;
  }

  record(input: FlightRecordInput): FlightRecord {
    const record = createFlightRecord(input, this.opts);
    this.records.push(record);
    while (this.records.length > this.maxRecords) this.records.shift();
    return record;
  }

  list(filter: { correlationId?: string; canonicalService?: string; backendAlias?: string; tool?: string } = {}): FlightRecord[] {
    return this.records.filter((record) => {
      if (filter.correlationId && record.correlationId !== filter.correlationId) return false;
      if (filter.canonicalService && record.identity.canonicalService !== filter.canonicalService) return false;
      if (filter.backendAlias && record.identity.backendAlias !== filter.backendAlias) return false;
      if (filter.tool && record.request.tool !== filter.tool) return false;
      return true;
    });
  }

  clear(): void {
    this.records.splice(0, this.records.length);
  }
}
