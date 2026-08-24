import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import { HermesError, HermesErrorCode } from './errors.js';

/** Offline detection + probe cadence. See connectivity.ts (ConnectivityGate). */
export const ConnectivityConfigSchema = z.object({
  /** DNS probe target. Default IS the IdP, so "probe down" ≈ "AD unreachable". */
  probeHost: z.string().default('login.microsoftonline.com'),
  /** Optional HTTP HEAD probe after DNS success (captive-portal mitigation, best-effort). */
  probeUrl: z.string().url().optional(),
  /** Probe result cache TTL while online. */
  probeTtlMs: z.number().int().min(5_000).default(30_000),
  /** Background recheck cadence while offline (plus 0-5s jitter). */
  offlineRecheckMs: z.number().int().min(10_000).default(30_000),
  /** Consecutive probe failures before transitioning online → offline. */
  failuresToOffline: z.number().int().min(1).default(2),
  /** Serve cached, unexpired tokens while offline (grace-flagged inside the safety margin). */
  serveCachedWhileOffline: z.boolean().default(true),
}).default({});

/** AD interaction budget — caps browser-auth load on the IdP per service:scheme. */
export const AdBudgetConfigSchema = z.object({
  /** Max provider.acquire() attempts per hour per service:scheme, across ALL trigger sources. */
  maxAcquiresPerHour: z.number().int().min(1).default(4),
  /** Max provider.validate() calls per hour per service:scheme. */
  maxValidationsPerHour: z.number().int().min(1).default(12),
}).default({});

/** Consumer-facing /token rate limit (HTTP edge only — never touches AD logic). */
export const ConsumerRateLimitConfigSchema = z.object({
  /** Requests per service:scheme per 10s window before 429 RATE_LIMITED. */
  maxTokenRequestsPer10s: z.number().int().min(1).default(20),
}).default({});

export const BrokerConfigSchema = z.object({
  httpPort: z.number().int().min(1).max(65535).default(9876),
  httpHost: z.string().default('127.0.0.1'),
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  dataDir: z.string(),
  validationPolicy: z.enum(['eager', 'lazy', 'paranoid']).default('lazy'),
  refreshSafetyMarginSec: z.number().int().min(60).default(300),
  clientTokenFile: z.string().optional(),
  connectivity: ConnectivityConfigSchema,
  adBudget: AdBudgetConfigSchema,
  consumerRateLimit: ConsumerRateLimitConfigSchema,
});

export type ConnectivityConfig = z.infer<typeof ConnectivityConfigSchema>;
export type AdBudgetConfig = z.infer<typeof AdBudgetConfigSchema>;
export type ConsumerRateLimitConfig = z.infer<typeof ConsumerRateLimitConfigSchema>;
export type BrokerConfig = z.infer<typeof BrokerConfigSchema>;

export const defaultConfig = {
  httpPort: 9876,
  httpHost: '127.0.0.1',
  logLevel: 'info' as const,
  validationPolicy: 'lazy' as const,
  refreshSafetyMarginSec: 300,
};

export interface LoadConfigOptions { dataDir?: string; }

export function defaultDataDir(): string { return path.join(os.homedir(), '.hermes'); }

export async function loadConfig(opts: LoadConfigOptions = {}): Promise<BrokerConfig> {
  const dataDir = opts.dataDir ?? defaultDataDir();
  await fs.mkdir(dataDir, { recursive: true });
  const configPath = path.join(dataDir, 'config.json');
  let fileData: Record<string, unknown> = {};
  try { fileData = JSON.parse(await fs.readFile(configPath, 'utf8')); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new HermesError(HermesErrorCode.CONFIG_ERROR, `failed to read ${configPath}`, { cause: err });
  }
  const merged = { ...defaultConfig, ...fileData, dataDir };
  const result = BrokerConfigSchema.safeParse(merged);
  if (!result.success) throw new HermesError(HermesErrorCode.CONFIG_ERROR, `invalid config: ${result.error.message}`);
  return result.data;
}
