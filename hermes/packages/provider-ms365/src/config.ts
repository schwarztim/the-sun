import { z } from 'zod';

export const SCHEMES = ['graph', 'teams', 'outlook'] as const;
export type Ms365Scheme = typeof SCHEMES[number];

export const Ms365ConfigSchema = z.object({
  loginHint: z.string().min(1, 'loginHint is required'),
  tenant: z.string().default('common'),
  clientId: z.string().default('d3590ed6-52b3-4102-aeff-aad2292ab01c'),
  totpKeychainService: z.string().optional(),
  totpKeychainAccount: z.string().optional(),
  passwordKeychainService: z.string().optional(),
  passwordKeychainAccount: z.string().optional(),
  headless: z.literal(true).default(true),
  authTimeoutMs: z.number().int().min(5_000).default(120_000),
});

export type Ms365Config = z.infer<typeof Ms365ConfigSchema>;

export const SCOPES: Record<Ms365Scheme, string[]> = {
  graph:   ['https://graph.microsoft.com/.default', 'offline_access'],
  teams:   ['https://api.spaces.skype.com/.default', 'offline_access'],
  outlook: ['https://outlook.office.com/.default', 'offline_access'],
};
