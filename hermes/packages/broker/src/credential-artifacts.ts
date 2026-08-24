import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { Stats } from 'node:fs';
import type { TokenBundle } from './types.js';

export const CREDENTIAL_ARTIFACT_KINDS = [
  'token_bundle',
  'credential_file',
  'browser_profile',
  'cookie_jar',
  'derived_header',
  'proxy_endpoint',
  'thv_secret',
  'volume_mount',
] as const;

export type CredentialArtifactKind = typeof CREDENTIAL_ARTIFACT_KINDS[number];
export type CredentialArtifactFreshness = 'fresh' | 'stale' | 'expired' | 'missing' | 'unknown';
export type CredentialArtifactProofStatus = 'present' | 'stale' | 'expired' | 'missing' | 'unknown';
export type PropagationTransactionStatus = 'pending' | 'in_progress' | 'ok' | 'degraded' | 'failed' | 'skipped';

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface CredentialArtifactProofBase<K extends CredentialArtifactKind, M extends Record<string, JsonValue>> {
  kind: K;
  artifactId: string;
  fingerprint: string;
  observedAt: number;
  proofStatus: CredentialArtifactProofStatus;
  freshness: CredentialArtifactFreshness;
  producedBy?: string;
  service?: string;
  scheme?: string;
  metadata: M;
}

export interface TokenBundleArtifactMetadata extends Record<string, JsonValue> {
  service: string;
  scheme: string;
  tokenType: string;
  acquiredAt: number;
  expiresAt: number;
  hasRefreshToken: boolean;
  scopeDigest: string | null;
  extraKeys: string[];
}

export type TokenBundleArtifactProof = CredentialArtifactProofBase<'token_bundle', TokenBundleArtifactMetadata>;

export interface FileArtifactMetadata extends Record<string, JsonValue> {
  sourcePath: string;
  exists: boolean;
  size: number | null;
  mtimeMs: number | null;
  mode: number | null;
  isDirectory: boolean | null;
  maxAgeMs: number | null;
}

export type CredentialFileArtifactProof = CredentialArtifactProofBase<'credential_file', FileArtifactMetadata>;
export type BrowserProfileArtifactProof = CredentialArtifactProofBase<'browser_profile', FileArtifactMetadata>;
export type CookieJarArtifactProof = CredentialArtifactProofBase<'cookie_jar', FileArtifactMetadata>;

export interface DerivedHeaderArtifactMetadata extends Record<string, JsonValue> {
  headerName: string;
  valueDigest: string;
  present: boolean;
}

export type DerivedHeaderArtifactProof = CredentialArtifactProofBase<'derived_header', DerivedHeaderArtifactMetadata>;

export interface ProxyEndpointArtifactMetadata extends Record<string, JsonValue> {
  endpoint: string;
  endpointDigest: string;
}

export type ProxyEndpointArtifactProof = CredentialArtifactProofBase<'proxy_endpoint', ProxyEndpointArtifactMetadata>;

export interface ToolHiveSecretArtifactMetadata extends Record<string, JsonValue> {
  secretName: string;
  secretNameDigest: string;
}

export type ToolHiveSecretArtifactProof = CredentialArtifactProofBase<'thv_secret', ToolHiveSecretArtifactMetadata>;

export interface VolumeMountArtifactMetadata extends Record<string, JsonValue> {
  sourcePath: string;
  containerPath: string;
  readOnly: boolean;
}

export type VolumeMountArtifactProof = CredentialArtifactProofBase<'volume_mount', VolumeMountArtifactMetadata>;

export type CredentialArtifactProof =
  | TokenBundleArtifactProof
  | CredentialFileArtifactProof
  | BrowserProfileArtifactProof
  | CookieJarArtifactProof
  | DerivedHeaderArtifactProof
  | ProxyEndpointArtifactProof
  | ToolHiveSecretArtifactProof
  | VolumeMountArtifactProof;

export interface ArtifactProofOptions {
  observedAt?: number;
  producedBy?: string;
  service?: string;
  scheme?: string;
}

export interface FileArtifactProofOptions extends ArtifactProofOptions {
  maxAgeMs?: number;
  now?: number;
}

export interface VolumeMountDeclaration {
  sourcePath: string;
  containerPath: string;
  readOnly?: boolean;
}

export interface PropagationTransactionStep {
  name: string;
  status: PropagationTransactionStatus;
  startedAt?: number;
  completedAt?: number;
  artifactIds?: string[];
  message?: string;
}

export interface CredentialPropagationTransaction {
  transactionId: string;
  service: string;
  scheme: string;
  startedAt: number;
  completedAt?: number;
  finalStatus: PropagationTransactionStatus;
  steps: PropagationTransactionStep[];
  artifactProofs: CredentialArtifactProof[];
}

export interface PropagationTransactionSummary {
  transactionId: string;
  service: string;
  scheme: string;
  finalStatus: PropagationTransactionStatus;
  startedAt: number;
  completedAt?: number;
  stepCounts: Record<PropagationTransactionStatus, number>;
  artifactCounts: Record<CredentialArtifactKind, number>;
  proofStatusCounts: Record<CredentialArtifactProofStatus, number>;
}

function nowMs(): number {
  return Date.now();
}

function optionalFields(opts: ArtifactProofOptions): Pick<CredentialArtifactProof, 'producedBy' | 'service' | 'scheme'> {
  return Object.fromEntries(Object.entries({
    producedBy: opts.producedBy,
    service: opts.service,
    scheme: opts.scheme,
  }).filter(([, value]) => value !== undefined)) as Pick<CredentialArtifactProof, 'producedBy' | 'service' | 'scheme'>;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function stableValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return Object.fromEntries(entries.map(([key, entry]) => [key, stableValue(entry)]));
  }
  return String(value);
}

function digest(value: unknown, length = 32): string {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex').slice(0, length)}`;
}

function secretDigest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 32)}`;
}

function tokenFreshness(bundle: TokenBundle, now: number, safetyMarginMs: number): CredentialArtifactFreshness {
  if (bundle.expiresAt <= now) return 'expired';
  if (bundle.expiresAt - now <= safetyMarginMs) return 'stale';
  return 'fresh';
}

function statusFromFreshness(freshness: CredentialArtifactFreshness): CredentialArtifactProofStatus {
  if (freshness === 'fresh' || freshness === 'unknown') return 'present';
  if (freshness === 'stale') return 'stale';
  if (freshness === 'expired') return 'expired';
  return 'missing';
}

export function createTokenBundleArtifactProof(
  bundle: TokenBundle,
  opts: ArtifactProofOptions & { now?: number; safetyMarginMs?: number } = {},
): TokenBundleArtifactProof {
  const observedAt = opts.observedAt ?? nowMs();
  const now = opts.now ?? observedAt;
  const freshness = tokenFreshness(bundle, now, opts.safetyMarginMs ?? 0);
  const metadata: TokenBundleArtifactMetadata = {
    service: bundle.service,
    scheme: bundle.scheme,
    tokenType: bundle.tokenType,
    acquiredAt: bundle.acquiredAt,
    expiresAt: bundle.expiresAt,
    hasRefreshToken: Boolean(bundle.refreshToken),
    scopeDigest: bundle.scope ? secretDigest(bundle.scope) : null,
    extraKeys: Object.keys(bundle.extra ?? {}).sort(),
  };
  return {
    kind: 'token_bundle',
    artifactId: `token_bundle:${bundle.service}:${bundle.scheme}`,
    fingerprint: digest({ kind: 'token_bundle', ...metadata }),
    observedAt,
    proofStatus: statusFromFreshness(freshness),
    freshness,
    service: bundle.service,
    scheme: bundle.scheme,
    ...optionalFields(opts),
    metadata,
  };
}

function fileFreshness(stats: Stats, now: number, maxAgeMs?: number): CredentialArtifactFreshness {
  if (maxAgeMs === undefined) return 'unknown';
  return now - stats.mtimeMs <= maxAgeMs ? 'fresh' : 'stale';
}

async function createFileArtifactProof<K extends 'credential_file' | 'browser_profile' | 'cookie_jar'>(
  kind: K,
  sourcePath: string,
  opts: FileArtifactProofOptions = {},
): Promise<CredentialArtifactProofBase<K, FileArtifactMetadata>> {
  const observedAt = opts.observedAt ?? nowMs();
  const now = opts.now ?? observedAt;
  let stats: Stats | null = null;
  try {
    stats = await fs.stat(sourcePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const metadata: FileArtifactMetadata = {
    sourcePath,
    exists: Boolean(stats),
    size: stats?.size ?? null,
    mtimeMs: stats ? Math.trunc(stats.mtimeMs) : null,
    mode: stats ? stats.mode & 0o777 : null,
    isDirectory: stats ? stats.isDirectory() : null,
    maxAgeMs: opts.maxAgeMs ?? null,
  };
  const freshness = stats ? fileFreshness(stats, now, opts.maxAgeMs) : 'missing';
  return {
    kind,
    artifactId: `${kind}:${sourcePath}`,
    fingerprint: digest({ kind, ...metadata }),
    observedAt,
    proofStatus: statusFromFreshness(freshness),
    freshness,
    ...optionalFields(opts),
    metadata,
  };
}

export function createCredentialFileArtifactProof(sourcePath: string, opts: FileArtifactProofOptions = {}): Promise<CredentialFileArtifactProof> {
  return createFileArtifactProof('credential_file', sourcePath, opts);
}

export function createBrowserProfileArtifactProof(sourcePath: string, opts: FileArtifactProofOptions = {}): Promise<BrowserProfileArtifactProof> {
  return createFileArtifactProof('browser_profile', sourcePath, opts);
}

export function createCookieJarArtifactProof(sourcePath: string, opts: FileArtifactProofOptions = {}): Promise<CookieJarArtifactProof> {
  return createFileArtifactProof('cookie_jar', sourcePath, opts);
}

export function createVolumeMountArtifactProof(declaration: VolumeMountDeclaration, opts: ArtifactProofOptions = {}): VolumeMountArtifactProof {
  const observedAt = opts.observedAt ?? nowMs();
  const metadata: VolumeMountArtifactMetadata = {
    sourcePath: declaration.sourcePath,
    containerPath: declaration.containerPath,
    readOnly: Boolean(declaration.readOnly),
  };
  return {
    kind: 'volume_mount',
    artifactId: `volume_mount:${declaration.sourcePath}->${declaration.containerPath}`,
    fingerprint: digest({ kind: 'volume_mount', ...metadata }),
    observedAt,
    proofStatus: 'present',
    freshness: 'unknown',
    ...optionalFields(opts),
    metadata,
  };
}

export function createDerivedHeaderArtifactProof(headerName: string, headerValue: string, opts: ArtifactProofOptions = {}): DerivedHeaderArtifactProof {
  const observedAt = opts.observedAt ?? nowMs();
  const normalizedHeaderName = headerName.toLowerCase();
  const metadata: DerivedHeaderArtifactMetadata = {
    headerName: normalizedHeaderName,
    valueDigest: secretDigest(headerValue),
    present: headerValue.length > 0,
  };
  return {
    kind: 'derived_header',
    artifactId: `derived_header:${normalizedHeaderName}`,
    fingerprint: digest({ kind: 'derived_header', ...metadata }),
    observedAt,
    proofStatus: metadata.present ? 'present' : 'missing',
    freshness: metadata.present ? 'unknown' : 'missing',
    ...optionalFields(opts),
    metadata,
  };
}

function sanitizeEndpoint(endpoint: string): string {
  try {
    const parsed = new URL(endpoint);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return endpoint.replace(/\/\/[^/@\s]+@/u, '//').replace(/[?#].*$/u, '');
  }
}

export function createProxyEndpointArtifactProof(endpoint: string, opts: ArtifactProofOptions = {}): ProxyEndpointArtifactProof {
  const observedAt = opts.observedAt ?? nowMs();
  const sanitizedEndpoint = sanitizeEndpoint(endpoint);
  const metadata: ProxyEndpointArtifactMetadata = {
    endpoint: sanitizedEndpoint,
    endpointDigest: digest(sanitizedEndpoint),
  };
  return {
    kind: 'proxy_endpoint',
    artifactId: `proxy_endpoint:${metadata.endpointDigest}`,
    fingerprint: digest({ kind: 'proxy_endpoint', ...metadata }),
    observedAt,
    proofStatus: 'present',
    freshness: 'unknown',
    ...optionalFields(opts),
    metadata,
  };
}

export function createToolHiveSecretArtifactProof(secretName: string, opts: ArtifactProofOptions = {}): ToolHiveSecretArtifactProof {
  const observedAt = opts.observedAt ?? nowMs();
  const metadata: ToolHiveSecretArtifactMetadata = {
    secretName,
    secretNameDigest: digest(secretName),
  };
  return {
    kind: 'thv_secret',
    artifactId: `thv_secret:${secretName}`,
    fingerprint: digest({ kind: 'thv_secret', ...metadata }),
    observedAt,
    proofStatus: 'present',
    freshness: 'unknown',
    ...optionalFields(opts),
    metadata,
  };
}

export function createPropagationTransaction(opts: {
  transactionId?: string;
  service: string;
  scheme: string;
  startedAt?: number;
  artifactProofs?: CredentialArtifactProof[];
  steps?: PropagationTransactionStep[];
  finalStatus?: PropagationTransactionStatus;
}): CredentialPropagationTransaction {
  return {
    transactionId: opts.transactionId ?? randomUUID(),
    service: opts.service,
    scheme: opts.scheme,
    startedAt: opts.startedAt ?? nowMs(),
    finalStatus: opts.finalStatus ?? 'pending',
    steps: opts.steps ?? [],
    artifactProofs: opts.artifactProofs ?? [],
  };
}

export function summarizePropagationTransaction(transaction: CredentialPropagationTransaction): PropagationTransactionSummary {
  const stepCounts = emptyStatusCounts<PropagationTransactionStatus>(['pending', 'in_progress', 'ok', 'degraded', 'failed', 'skipped']);
  const artifactCounts = emptyStatusCounts<CredentialArtifactKind>(CREDENTIAL_ARTIFACT_KINDS);
  const proofStatusCounts = emptyStatusCounts<CredentialArtifactProofStatus>(['present', 'stale', 'expired', 'missing', 'unknown']);
  for (const step of transaction.steps) stepCounts[step.status] += 1;
  for (const proof of transaction.artifactProofs) {
    artifactCounts[proof.kind] += 1;
    proofStatusCounts[proof.proofStatus] += 1;
  }
  return {
    transactionId: transaction.transactionId,
    service: transaction.service,
    scheme: transaction.scheme,
    finalStatus: transaction.finalStatus,
    startedAt: transaction.startedAt,
    completedAt: transaction.completedAt,
    stepCounts,
    artifactCounts,
    proofStatusCounts,
  };
}

function emptyStatusCounts<T extends string>(keys: readonly T[]): Record<T, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>;
}
