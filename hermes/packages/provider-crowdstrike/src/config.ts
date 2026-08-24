import { z } from 'zod';

export const SCHEMES = ['browser-proxy'] as const;
export type CrowdStrikeScheme = typeof SCHEMES[number];

export const CrowdStrikeConfigSchema = z.object({
  falconUrl: z.string().url().default('https://falcon.crowdstrike.com'),
  loginHint: z.string().min(1, 'loginHint is required'),
  passwordKeychainService: z.string().optional(),
  passwordKeychainAccount: z.string().optional(),
  totpKeychainService: z.string().optional(),
  totpKeychainAccount: z.string().optional(),
  headless: z.literal(true).default(true),
  proxyPort: z.number().int().default(0),
  keepaliveIntervalMs: z.number().int().default(120_000),
  authTimeoutMs: z.number().int().min(5_000).default(120_000),
});

export type CrowdStrikeConfig = z.infer<typeof CrowdStrikeConfigSchema>;
