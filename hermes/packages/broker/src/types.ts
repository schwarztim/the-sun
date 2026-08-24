import { z } from 'zod';

export const TokenBundleSchema = z.object({
  service: z.string(),
  scheme: z.string(),
  accessToken: z.string(),
  refreshToken: z.string().optional(),
  tokenType: z.string().default('Bearer'),
  expiresAt: z.number().int(),
  acquiredAt: z.number().int(),
  scope: z.string().optional(),
  extra: z.record(z.unknown()).optional(),
});

export type TokenBundle = z.infer<typeof TokenBundleSchema>;

export interface ProviderLogger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export interface ProviderContext {
  service: string;
  config: Record<string, unknown>;
  logger: ProviderLogger;
  dataDir: string;
}

export type ProviderCredentialSource =
  | 'oauth'
  | 'cookie-session'
  | 'browser-proxy'
  | 'api-token'
  | 'client-credentials'
  | 'external-vault';

export type ProviderRefreshStrategy =
  | 'refresh-token'
  | 'reacquire'
  | 'self-maintained'
  | 'client-credentials'
  | 'none';

export type ProviderValidationStrategy =
  | 'http'
  | 'jwt-exp'
  | 'proxy-health'
  | 'service-probe'
  | 'none';

export interface ProviderSchemeCapabilities {
  scheme: string;
  credentialSource: ProviderCredentialSource;
  refreshStrategy: ProviderRefreshStrategy;
  supportsRefresh: boolean;
  supportsValidation: boolean;
  validationStrategy: ProviderValidationStrategy;
  refreshTokenMaxAgeMs?: number;
}

export interface ProviderRemediationHints {
  acquire: string;
  refresh: string;
  validate: string;
}

export type ConditionalAccessMode =
  | 'mfa_or_totp_required'
  | 'device_certificate_required'
  | 'vpn_or_network_required'
  | 'consent_required'
  | 'password_expired'
  | 'browser_profile_locked'
  | 'prompt_loop'
  | 'policy_blocks_headless'
  | 'unknown_login_route';

export type BrowserProfileStrategy =
  | 'service-scoped-persistent'
  | 'shared-persistent'
  | 'ephemeral'
  | 'external';

export interface ProviderCapabilities {
  headless: true;
  schemes: readonly ProviderSchemeCapabilities[];
  remediation: ProviderRemediationHints;
  conditionalAccessModes?: readonly ConditionalAccessMode[];
  requiresDeviceContext?: boolean;
  supportsTotp?: boolean;
  supportsDeviceCodeFallback?: boolean;
  browserProfileStrategy?: BrowserProfileStrategy;
}

export interface Provider {
  readonly name: string;
  readonly schemes: readonly string[];
  readonly capabilities?: ProviderCapabilities;
  acquire(ctx: ProviderContext, scheme: string): Promise<TokenBundle>;
  acquireAll?(ctx: ProviderContext): Promise<TokenBundle[]>;
  refresh(ctx: ProviderContext, bundle: TokenBundle): Promise<TokenBundle>;
  validate(ctx: ProviderContext, bundle: TokenBundle): Promise<boolean>;
  nextRefreshAt(bundle: TokenBundle): Date;
  dispose?(): Promise<void>;
}

export interface DownstreamAuthProbeExpectation {
  httpStatus?: number | number[];
  shape?: unknown;
  minArrayLength?: { path: string; min: number }[];
}

export interface DownstreamAuthProbeRedaction {
  redactKeys?: string[];
  redactPaths?: string[];
}

export interface DownstreamAuthProbeConfig {
  toolName: string;
  args?: Record<string, unknown>;
  operation?: string;
  endpointClass?: string;
  proofDepth?: 'transport' | 'provider' | 'shallow' | 'deep' | 'last_real_use';
  required?: boolean;
  expectedSuccess?: DownstreamAuthProbeExpectation;
  expectedAuthFailure?: DownstreamAuthProbeExpectation;
  redaction?: DownstreamAuthProbeRedaction;
}

export interface ServiceRegistration {
  name: string;
  providerName: string;
  schemes: string[];
  config: Record<string, unknown>;
  createdAt: number;
  thvSecretPrefix?: string;
  thvContainerName?: string;
  serviceAliases?: string[];
  backendAliases?: string[];
  toolhiveContainerAliases?: string[];
  gatewayBackendAliases?: string[];
  userFacingNames?: string[];
  downstreamAuthProbe?: DownstreamAuthProbeConfig;
  downstreamAuthProbes?: DownstreamAuthProbeConfig[];
  /** When true, the broker automatically re-runs acquire() instead of returning
   *  INTERACTIVE_AUTH_REQUIRED on token expiry. Defaults to false. Opt-in only.
   *  Bounded-retry safety: 2 consecutive failures within 10 min suppress further
   *  auto-acquires for that (service, scheme) and fall back to INTERACTIVE_AUTH_REQUIRED. */
  autoReacquire?: boolean;
}
