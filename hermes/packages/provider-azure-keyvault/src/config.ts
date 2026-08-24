import { z } from 'zod';

export const SCHEMES = ['management', 'vault'] as const;
export type AzureKeyVaultScheme = typeof SCHEMES[number];

export const SCOPES: Record<AzureKeyVaultScheme, string> = {
  management: 'https://management.azure.com/.default',
  vault: 'https://vault.azure.net/.default',
};

export const AzureKeyVaultConfigSchema = z.object({
  tenantId: z.string().min(1, 'tenantId is required'),
  clientId: z.string().min(1, 'clientId is required'),
  // Either clientSecret directly OR keychain reference. At least one path must resolve.
  clientSecret: z.string().optional(),
  clientSecretKeychainService: z.string().optional(),
  clientSecretKeychainAccount: z.string().optional(),
  subscriptionId: z.string().optional(), // informational; surfaced via TokenBundle.extra
  authority: z.string().url().default('https://login.microsoftonline.com'),
  headless: z.literal(true).default(true),
  authTimeoutMs: z.number().int().min(5_000).default(30_000),
});

export type AzureKeyVaultConfig = z.infer<typeof AzureKeyVaultConfigSchema>;
