import { z } from 'zod';

export const OAuth2ConfigSchema = z.object({
  loginHint: z.string().min(1, 'loginHint is required'),
  tenant: z.string().default('common'),
  clientId: z.string(),
  scopes: z.array(z.string()),
  redirectUri: z.string().default('https://login.microsoftonline.com/common/oauth2/nativeclient'),
  resource: z.string().optional(),
  passwordKeychainService: z.string().optional(),
  passwordKeychainAccount: z.string().optional(),
  totpKeychainService: z.string().optional(),
  totpKeychainAccount: z.string().optional(),
  headless: z.literal(true).default(true),
  authTimeoutMs: z.number().int().min(5000).default(120_000),
  validateUrl: z.string().url().optional(),
});

export type OAuth2Config = z.infer<typeof OAuth2ConfigSchema>;
