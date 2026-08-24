export enum HermesClientErrorCode {
  BROKER_UNREACHABLE = 'BROKER_UNREACHABLE',
  UNAUTHORIZED = 'UNAUTHORIZED',
  ACQUIRE_REQUIRED = 'ACQUIRE_REQUIRED',
  SERVICE_NOT_REGISTERED = 'SERVICE_NOT_REGISTERED',
  INVALID_RESPONSE = 'INVALID_RESPONSE',
  UPSTREAM = 'UPSTREAM',
  /** Broker is up but has no network path to the IdP (HTTP 503, body code
   *  OFFLINE). The client memoizes this per service:scheme for retryAfterMs
   *  (floor 30s) and short-circuits without an HTTP call — no hot loops. */
  OFFLINE = 'OFFLINE',
  /** Broker rate-limited this consumer (HTTP 429). Honor Retry-After; never tight-retry. */
  RATE_LIMITED = 'RATE_LIMITED',
}

export interface HermesClientErrorOptions {
  remediation?: string;
  remediationCommands?: string[];
  category?: string;
  retryable?: boolean;
  retryAfterMs?: number;
  retryHint?: string;
  cause?: unknown;
  status?: number;
}

export class HermesClientError extends Error {
  public readonly code: HermesClientErrorCode;
  public readonly remediation?: string;
  public readonly remediationCommands: string[];
  public readonly category?: string;
  public readonly retryable: boolean;
  public readonly retryAfterMs?: number;
  public readonly retryHint?: string;
  public readonly status?: number;
  constructor(code: HermesClientErrorCode, message: string, opts: HermesClientErrorOptions = {}) {
    super(message, opts.cause ? { cause: opts.cause } : undefined);
    this.name = 'HermesClientError';
    this.code = code;
    this.remediation = opts.remediation;
    this.remediationCommands = opts.remediationCommands ?? [];
    this.category = opts.category;
    this.retryable = opts.retryable ?? false;
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = Math.max(0, Math.ceil(opts.retryAfterMs));
    this.retryHint = opts.retryHint;
    this.status = opts.status;
  }
}
