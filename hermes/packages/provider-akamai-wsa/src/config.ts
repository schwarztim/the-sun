import { z } from 'zod';

export const SCHEMES = ['session'] as const;
export type AkamaiWsaScheme = typeof SCHEMES[number];

export const AkamaiWsaConfigSchema = z.object({
  baseUrl: z.string().url().default('https://control.akamai.com'),
  appPath: z.string().default('/apps/security-analytics'),
  loginHint: z.string().min(1, 'loginHint is required'),
  passwordKeychainService: z.string().optional(),
  passwordKeychainAccount: z.string().optional(),
  totpKeychainService: z.string().optional(),
  totpKeychainAccount: z.string().optional(),
  wafConfigId: z.number({ required_error: 'wafConfigId is required: set it to your own Akamai WAF security configuration ID (Security > WAF Configurations in the Akamai control center)' }).int(),
  headless: z.literal(true).default(true),
  authTimeoutMs: z.number().int().min(5_000).default(120_000),
});

export type AkamaiWsaConfig = z.infer<typeof AkamaiWsaConfigSchema>;
