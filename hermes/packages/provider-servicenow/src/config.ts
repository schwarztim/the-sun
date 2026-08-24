import { z } from 'zod';

export const SCHEMES = ['session'] as const;
export type ServiceNowScheme = typeof SCHEMES[number];

export const DEFAULT_SESSION_LIFETIME_MS = 4 * 60 * 60 * 1000;
export const DEFAULT_REFRESH_MARGIN_MS = 60 * 60 * 1000;

export const ServiceNowConfigSchema = z.object({
  instanceUrl: z.string().url(),
  loginHint: z.string().min(1, 'loginHint is required'),
  passwordKeychainService: z.string().optional(),
  passwordKeychainAccount: z.string().optional(),
  totpKeychainService: z.string().optional(),
  totpKeychainAccount: z.string().optional(),
  headless: z.literal(true).default(true),
  authTimeoutMs: z.number().int().min(5_000).default(120_000),
  sessionLifetimeMs: z.number().int().min(60_000).default(DEFAULT_SESSION_LIFETIME_MS),
  refreshMarginMs: z.number().int().min(0).default(DEFAULT_REFRESH_MARGIN_MS),
});

export type ServiceNowConfig = z.infer<typeof ServiceNowConfigSchema>;
