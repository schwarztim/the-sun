import { z } from 'zod';

export const TransportFailureClassificationSchema = z.enum([
  'mcp_session_not_found',
  'mcp_session_expired',
  'gateway_backend_stale',
  'backend_restarted',
  'streamable_http_protocol_error',
  'sse_disconnect',
  'port_conflict',
  'tool_call_timeout',
  'unknown_transport_failure',
]);

export const ToolCallIdempotencySchema = z.enum([
  'read',
  'safe_write_with_idempotency_key',
  'write_requires_duplicate_check',
  'unsafe_write',
]);

export type TransportFailureClassification = z.infer<typeof TransportFailureClassificationSchema>;
export type ToolCallIdempotency = z.infer<typeof ToolCallIdempotencySchema>;

export interface TransportFailureInput {
  error?: unknown;
  response?: unknown;
  body?: unknown;
  data?: unknown;
  message?: unknown;
  statusText?: unknown;
  code?: unknown;
  status?: unknown;
  statusCode?: unknown;
  httpStatus?: unknown;
  backend?: unknown;
  tool?: unknown;
  transport?: unknown;
  evidence?: unknown;
}

export interface ToolCallPolicyInput {
  tool?: unknown;
  method?: unknown;
  idempotency?: unknown;
  idempotencyKey?: unknown;
}

export interface ToolReplayPolicy {
  idempotency: ToolCallIdempotency;
  safeToReplayNow: boolean;
  duplicateCheckRequired: boolean;
  idempotencyKeyRequired: boolean;
  guidance: string;
}

export interface TransportRecoveryGuidance {
  failureDomain: 'mcp_transport';
  credentialRefreshRecommended: false;
  retryable: boolean;
  resetSession: boolean;
  reinitializeSession: boolean;
  nextActions: string[];
  replayPolicy: ToolReplayPolicy;
  remediation: string;
}

export interface TransportFailureAnalysis {
  failureDomain: 'mcp_transport';
  classification: TransportFailureClassification;
  authFailure: false;
  credentialStatus: 'unchanged';
  guidance: TransportRecoveryGuidance;
}

const DEFAULT_TEXT_LIMIT = 4_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (value instanceof Error) return value.message;
  return undefined;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function sanitizeText(raw: string): string {
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(access[_-]?token|refresh[_-]?token|id[_-]?token|authorization|token|secret|password|api[_-]?key)\b\s*[:=]\s*[^,\s;]+/gi, '$1=[redacted]')
    .slice(0, DEFAULT_TEXT_LIMIT);
}

function collectText(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 5 || out.join('\n').length >= DEFAULT_TEXT_LIMIT) return out;
  const direct = stringValue(value);
  if (direct) {
    out.push(sanitizeText(direct));
    const parsed = safeJsonParse(direct);
    if (parsed !== undefined) collectText(parsed, out, depth + 1);
    return out;
  }
  if (Array.isArray(value)) {
    for (const entry of value.slice(0, 20)) collectText(entry, out, depth + 1);
    return out;
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (/^(access[_-]?token|refresh[_-]?token|id[_-]?token|authorization|token|secret|password|cookie|set-cookie|api[_-]?key|x-api-key)$/i.test(key)) {
        out.push(`${key}=[redacted]`);
      } else {
        collectText(entry, out, depth + 1);
      }
    }
  }
  return out;
}

function jsonRpcError(value: unknown): { code?: unknown; message?: string } | undefined {
  if (!isRecord(value)) return undefined;
  const nested = isRecord(value.error) ? value.error : value;
  const message = stringValue(nested.message);
  return { code: nested.code, message };
}

function collectJsonRpcErrors(value: unknown, out: Array<{ code?: unknown; message?: string }> = [], depth = 0): Array<{ code?: unknown; message?: string }> {
  if (depth > 5) return out;
  const direct = jsonRpcError(value);
  if (direct && (direct.code !== undefined || direct.message !== undefined)) out.push(direct);
  const text = stringValue(value);
  if (text) {
    const parsed = safeJsonParse(text);
    if (parsed !== undefined) collectJsonRpcErrors(parsed, out, depth + 1);
    return out;
  }
  if (Array.isArray(value)) {
    for (const entry of value.slice(0, 20)) collectJsonRpcErrors(entry, out, depth + 1);
    return out;
  }
  if (isRecord(value)) {
    for (const entry of Object.values(value)) collectJsonRpcErrors(entry, out, depth + 1);
  }
  return out;
}

function evidenceFromInput(input: unknown): unknown[] {
  if (isRecord(input)) {
    return [
      input.error,
      input.response,
      input.body,
      input.data,
      input.message,
      input.statusText,
      input.code,
      input.status,
      input.statusCode,
      input.httpStatus,
      input.backend,
      input.tool,
      input.transport,
      input.evidence,
      input,
    ].filter((entry) => entry !== undefined);
  }
  return [input];
}

function textCorpus(input: unknown): string {
  return evidenceFromInput(input).flatMap((entry) => collectText(entry)).join('\n').toLowerCase();
}

function hasJsonRpcSessionNotFound(input: unknown): boolean {
  return evidenceFromInput(input).some((entry) => collectJsonRpcErrors(entry).some((err) => {
    const code = typeof err.code === 'number' ? err.code : Number(err.code);
    return code === -32001 && /session\s+not\s+found/i.test(err.message ?? '');
  }));
}

export function classifyTransportFailure(input: unknown): TransportFailureClassification {
  const text = textCorpus(input);

  if (hasJsonRpcSessionNotFound(input) || /\bsession\s+not\s+found\b/.test(text)) return 'mcp_session_not_found';
  if (/\b(session|mcp-session-id)\b.*\b(expired|invalid|missing)\b|\b(expired|invalid|missing)\b.*\b(session|mcp-session-id)\b/.test(text)) return 'mcp_session_expired';
  if (/\beaddrinuse\b|address already in use|port .*already in use|already .*listening|listen .* in use/.test(text)) return 'port_conflict';
  if (/\b(etimedout|timeout|timed out|deadline exceeded|aborterror|operation aborted)\b/.test(text)) return 'tool_call_timeout';
  if (/\b(econnrefused|connection refused|connect refused|failed to connect|could not connect|fetch failed)\b/.test(text)) return 'gateway_backend_stale';
  if (/\b(econnreset|socket hang up|broken pipe|epipe|server closed|backend restarted|container restarted|upstream reset)\b/.test(text)) return 'backend_restarted';
  if (/\bsse\b.*\b(disconnect|disconnected|closed|terminated|ended|aborted)\b|\beventsource\b.*\b(error|closed|disconnect|disconnected)\b/.test(text)) return 'sse_disconnect';
  if (/already connected to a transport|streamable http|protocol error|invalid content-type|missing mcp-session-id|invalid session header|json-rpc parse error/.test(text)) return 'streamable_http_protocol_error';

  return 'unknown_transport_failure';
}

export function normalizeToolCallIdempotency(value: unknown): ToolCallIdempotency | undefined {
  const parsed = ToolCallIdempotencySchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function inferToolCallIdempotency(input: ToolCallPolicyInput): ToolCallIdempotency {
  const explicit = normalizeToolCallIdempotency(input.idempotency);
  if (explicit) return explicit;

  const tool = stringValue(input.tool)?.toLowerCase() ?? '';
  const method = stringValue(input.method)?.toLowerCase() ?? '';
  const op = `${tool} ${method}`.replace(/[_-]+/g, ' ');

  if (/\b(get|list|search|find|read|describe|status|health|lookup|fetch)\b/.test(op)) return 'read';
  if (/create[_-]?pull[_-]?request|pull request|create[_-]?pr|\bpr[_-]?create\b/.test(op)) return 'write_requires_duplicate_check';
  if (/\b(create|post|put|patch|update|delete|merge|approve|transition|comment|upload|send|write)\b/.test(op)) return 'write_requires_duplicate_check';

  return 'unsafe_write';
}

export function toolReplayPolicy(input: ToolCallPolicyInput = {}): ToolReplayPolicy {
  const idempotency = inferToolCallIdempotency(input);
  const hasIdempotencyKey = typeof input.idempotencyKey === 'string' && input.idempotencyKey.trim().length > 0;

  if (idempotency === 'read') {
    return {
      idempotency,
      safeToReplayNow: true,
      duplicateCheckRequired: false,
      idempotencyKeyRequired: false,
      guidance: 'read-only call may be retried after the MCP session is reinitialized',
    };
  }
  if (idempotency === 'safe_write_with_idempotency_key') {
    return {
      idempotency,
      safeToReplayNow: hasIdempotencyKey,
      duplicateCheckRequired: !hasIdempotencyKey,
      idempotencyKeyRequired: !hasIdempotencyKey,
      guidance: hasIdempotencyKey
        ? 'retry the write only after reinitialization and reuse the same idempotency key'
        : 'do not replay until an idempotency key is available or a duplicate check proves no side effect occurred',
    };
  }
  if (idempotency === 'write_requires_duplicate_check') {
    return {
      idempotency,
      safeToReplayNow: false,
      duplicateCheckRequired: true,
      idempotencyKeyRequired: false,
      guidance: 'perform a duplicate/resource existence check before replaying this write',
    };
  }
  return {
    idempotency,
    safeToReplayNow: false,
    duplicateCheckRequired: false,
    idempotencyKeyRequired: false,
    guidance: 'do not automatically replay this non-idempotent write',
  };
}

function baseActions(classification: TransportFailureClassification): string[] {
  if (classification === 'mcp_session_not_found') {
    return [
      'close_stale_mcp_session',
      'reinitialize_backend_session',
      'retry_only_if_idempotency_policy_allows',
      'do_not_refresh_token_first',
    ];
  }
  if (classification === 'mcp_session_expired' || classification === 'streamable_http_protocol_error') {
    return ['close_stale_mcp_session', 'reinitialize_backend_session', 'do_not_refresh_token_first'];
  }
  if (classification === 'gateway_backend_stale' || classification === 'backend_restarted') {
    return ['refresh_gateway_backend_connection', 'reinitialize_backend_session', 'do_not_refresh_token_first'];
  }
  if (classification === 'port_conflict') {
    return ['inspect_listener_process', 'restart_transport_owner_after_safe_shutdown', 'do_not_refresh_token_first'];
  }
  if (classification === 'sse_disconnect') {
    return ['close_sse_stream', 'reconnect_sse_or_streamable_http_session', 'do_not_refresh_token_first'];
  }
  if (classification === 'tool_call_timeout') {
    return ['check_backend_liveness', 'retry_only_if_idempotency_policy_allows', 'do_not_refresh_token_first'];
  }
  return ['collect_transport_evidence', 'do_not_refresh_token_first_without_auth_evidence'];
}

export function transportFailureGuidance(
  classification: TransportFailureClassification,
  policyInput: ToolCallPolicyInput = {},
): TransportRecoveryGuidance {
  const replayPolicy = toolReplayPolicy(policyInput);
  const sessionResetClassifications = new Set<TransportFailureClassification>([
    'mcp_session_not_found',
    'mcp_session_expired',
    'gateway_backend_stale',
    'backend_restarted',
    'streamable_http_protocol_error',
    'sse_disconnect',
  ]);
  const nextActions = baseActions(classification);
  if (replayPolicy.duplicateCheckRequired) nextActions.push('perform_duplicate_check_before_replay');
  if (replayPolicy.idempotencyKeyRequired) nextActions.push('supply_or_reuse_idempotency_key_before_replay');

  return {
    failureDomain: 'mcp_transport',
    credentialRefreshRecommended: false,
    retryable: classification !== 'port_conflict' && classification !== 'unknown_transport_failure',
    resetSession: sessionResetClassifications.has(classification),
    reinitializeSession: sessionResetClassifications.has(classification),
    nextActions,
    replayPolicy,
    remediation: `${classification}: recover the MCP transport/session first; ${replayPolicy.guidance}; do not refresh or rotate credentials before transport recovery.`,
  };
}

export function analyzeTransportFailure(input: unknown, policyInput: ToolCallPolicyInput = {}): TransportFailureAnalysis {
  const classification = classifyTransportFailure(input);
  return {
    failureDomain: 'mcp_transport',
    classification,
    authFailure: false,
    credentialStatus: 'unchanged',
    guidance: transportFailureGuidance(classification, policyInput),
  };
}
