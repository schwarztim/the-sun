export enum HermesErrorCode {
  ACQUIRE_REQUIRED = 'ACQUIRE_REQUIRED',
  REFRESH_FAILED = 'REFRESH_FAILED',
  REFRESH_IN_PROGRESS = 'REFRESH_IN_PROGRESS',
  VALIDATION_FAILED = 'VALIDATION_FAILED',
  INTERACTIVE_AUTH_REQUIRED = 'INTERACTIVE_AUTH_REQUIRED',
  PROVIDER_NOT_FOUND = 'PROVIDER_NOT_FOUND',
  SERVICE_NOT_REGISTERED = 'SERVICE_NOT_REGISTERED',
  STORAGE_ERROR = 'STORAGE_ERROR',
  CONFIG_ERROR = 'CONFIG_ERROR',
  UNAUTHORIZED = 'UNAUTHORIZED',
  INTERNAL = 'INTERNAL',
  /** Broker detected no network path to the IdP. Distinct from
   *  REFRESH_IN_PROGRESS (broker busy) and 409s (operator action). Maps to
   *  HTTP 503 with a Retry-After derived from the offline recheck cadence. */
  OFFLINE = 'OFFLINE',
  /** Consumer exceeded the per-key /token request rate limit. Maps to 429. */
  RATE_LIMITED = 'RATE_LIMITED',
}

export enum HermesErrorCategory {
  AUTH_REQUIRED = 'auth-required',
  TRANSIENT = 'transient',
  CONFIGURATION = 'configuration',
  NOT_FOUND = 'not-found',
  UNAUTHORIZED = 'unauthorized',
  STORAGE = 'storage',
  INTERNAL = 'internal',
}

export enum HermesRetryHint {
  DO_NOT_RETRY = 'do-not-retry',
  RETRY_AFTER = 'retry-after',
  SAFE_TO_RETRY = 'safe-to-retry',
  HUMAN_ACTION_REQUIRED = 'human-action-required',
}

export interface HermesErrorOptions {
  remediation?: string;
  remediationCommands?: string[];
  category?: HermesErrorCategory;
  retryable?: boolean;
  retryAfterMs?: number;
  retryHint?: HermesRetryHint;
  conditionalAccessChallenge?: ConditionalAccessChallengePayload;
  cause?: unknown;
}

export interface ConditionalAccessChallengePayload {
  state: string;
  category: string;
  message: string;
  retryable: boolean;
  retryHint: string;
  retryAfterMs?: number;
  remediation: string;
  remediationCommands: string[];
  evidence?: Record<string, unknown>;
}

function defaultCategory(code: HermesErrorCode): HermesErrorCategory {
  switch (code) {
    case HermesErrorCode.ACQUIRE_REQUIRED:
    case HermesErrorCode.INTERACTIVE_AUTH_REQUIRED:
      return HermesErrorCategory.AUTH_REQUIRED;
    case HermesErrorCode.REFRESH_FAILED:
    case HermesErrorCode.REFRESH_IN_PROGRESS:
    case HermesErrorCode.OFFLINE:
    case HermesErrorCode.RATE_LIMITED:
      return HermesErrorCategory.TRANSIENT;
    case HermesErrorCode.PROVIDER_NOT_FOUND:
    case HermesErrorCode.SERVICE_NOT_REGISTERED:
      return HermesErrorCategory.NOT_FOUND;
    case HermesErrorCode.CONFIG_ERROR:
    case HermesErrorCode.VALIDATION_FAILED:
      return HermesErrorCategory.CONFIGURATION;
    case HermesErrorCode.STORAGE_ERROR:
      return HermesErrorCategory.STORAGE;
    case HermesErrorCode.UNAUTHORIZED:
      return HermesErrorCategory.UNAUTHORIZED;
    case HermesErrorCode.INTERNAL:
      return HermesErrorCategory.INTERNAL;
  }
}

function defaultRetryHint(category: HermesErrorCategory, retryable: boolean): HermesRetryHint {
  if (category === HermesErrorCategory.AUTH_REQUIRED) return HermesRetryHint.HUMAN_ACTION_REQUIRED;
  if (retryable) return HermesRetryHint.SAFE_TO_RETRY;
  return HermesRetryHint.DO_NOT_RETRY;
}

export class HermesError extends Error {
  public readonly code: HermesErrorCode;
  public readonly remediation?: string;
  public readonly remediationCommands: string[];
  public readonly category: HermesErrorCategory;
  public readonly retryable: boolean;
  public readonly retryAfterMs?: number;
  public readonly retryHint: HermesRetryHint;
  public readonly conditionalAccessChallenge?: ConditionalAccessChallengePayload;

  constructor(code: HermesErrorCode, message: string, opts: HermesErrorOptions = {}) {
    super(message, opts.cause ? { cause: opts.cause } : undefined);
    this.name = 'HermesError';
    this.code = code;
    this.remediation = opts.remediation;
    this.remediationCommands = opts.remediationCommands ?? [];
    this.category = opts.category ?? defaultCategory(code);
    this.retryable = opts.retryable ?? this.category === HermesErrorCategory.TRANSIENT;
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = Math.max(0, Math.ceil(opts.retryAfterMs));
    this.conditionalAccessChallenge = opts.conditionalAccessChallenge;
    this.retryHint = opts.retryHint ?? (
      this.retryAfterMs !== undefined && this.retryable
        ? HermesRetryHint.RETRY_AFTER
        : defaultRetryHint(this.category, this.retryable)
    );
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      category: this.category,
      message: this.message,
      retryable: this.retryable,
      retryHint: this.retryHint,
      ...(this.retryAfterMs !== undefined ? { retryAfterMs: this.retryAfterMs } : {}),
      ...(this.remediation ? { remediation: this.remediation } : {}),
      ...(this.remediationCommands.length > 0 ? { remediationCommands: this.remediationCommands } : {}),
      ...(this.conditionalAccessChallenge ? { conditionalAccessChallenge: this.conditionalAccessChallenge } : {}),
    };
  }
}
