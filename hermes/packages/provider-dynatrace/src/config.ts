import { z } from 'zod';

/**
 * Dynatrace supports two auth modes:
 *   - 'session': Browser-based SSO producing cookies + CSRF tokens (dual API surface)
 *   - 'api-token': Static Dynatrace personal access token (no browser needed)
 */
export const SCHEMES = ['session', 'api-token'] as const;
export type DynatraceScheme = typeof SCHEMES[number];

export const DynatraceConfigSchema = z.object({
  environmentId: z.string().min(1, 'environmentId is required'),
  loginHint: z.string().optional(),
  apiToken: z.string().optional(),
  passwordKeychainService: z.string().optional(),
  passwordKeychainAccount: z.string().optional(),
  totpKeychainService: z.string().optional(),
  totpKeychainAccount: z.string().optional(),
  headless: z.literal(true).default(true),
  authTimeoutMs: z.number().int().min(5_000).default(120_000),
});

export type DynatraceConfig = z.infer<typeof DynatraceConfigSchema>;

export function appsUrl(envId: string): string {
  return `https://${envId}.apps.dynatrace.com`;
}

export function liveUrl(envId: string): string {
  return `https://${envId}.live.dynatrace.com`;
}
