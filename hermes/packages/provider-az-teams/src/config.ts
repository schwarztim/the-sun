import { z } from 'zod';

export const CANONICAL_SCHEMES = ['graph', 'teams-bearer', 'skype', 'files', 'substrate'] as const;
export const SCHEMES = [...CANONICAL_SCHEMES, 'teams'] as const;
export type AzTeamsScheme = (typeof SCHEMES)[number];
export type CanonicalAzTeamsScheme = (typeof CANONICAL_SCHEMES)[number];

export function normalizeAzTeamsScheme(scheme: string): CanonicalAzTeamsScheme {
  if (scheme === 'teams') return 'teams-bearer';
  if ((CANONICAL_SCHEMES as readonly string[]).includes(scheme)) {
    return scheme as CanonicalAzTeamsScheme;
  }
  throw new Error(`unsupported az-teams scheme "${scheme}"; use graph, teams, teams-bearer, skype, or files`);
}

export const AzTeamsConfigSchema = z.object({
  loginHint: z.string().min(1, 'loginHint is required'),
  tenant: z.string().default('common'),
  teamsClientId: z.string().default('5e3ce6c0-2b1f-4285-8d4b-75ee78787346'),
  filesClientId: z.string().default('9199bf20-a13f-4107-85dc-02114787ef48'),
  passwordKeychainService: z.string().optional(),
  passwordKeychainAccount: z.string().optional(),
  totpKeychainService: z.string().optional(),
  totpKeychainAccount: z.string().optional(),
  headless: z.literal(true).default(true),
  authTimeoutMs: z.number().int().min(5_000).default(120_000),
});

export type AzTeamsConfig = z.infer<typeof AzTeamsConfigSchema>;

export const SCOPES: Record<CanonicalAzTeamsScheme, string[]> = {
  graph: ['https://graph.microsoft.com/.default', 'offline_access'],
  'teams-bearer': [
    'https://api.spaces.skype.com/.default',
    'openid',
    'offline_access',
  ],
  skype: [],
  files: [
    'https://graph.microsoft.com/Files.ReadWrite.All',
    'https://graph.microsoft.com/User.Read',
    'openid',
    'offline_access',
  ],
  substrate: [
    'https://outlook.office.com/search/.default',
    'openid',
    'offline_access',
  ],
};
