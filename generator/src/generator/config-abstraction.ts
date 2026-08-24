/**
 * Configuration Abstraction Layer
 *
 * Ensures generated MCPs are generic and reusable by separating:
 * - Tool logic (generic, publishable to GitHub)
 * - Company-specific configuration (environment variables, .env files)
 *
 * All company data MUST be abstracted to environment variables.
 */

import { z } from 'zod';

/**
 * Configuration categories
 */
export type ConfigCategory = 'auth' | 'endpoint' | 'feature' | 'limit' | 'custom';

/**
 * Configuration item definition
 */
export interface ConfigItem {
  /** Environment variable name (e.g., AKAMAI_HOST) */
  envVar: string;
  /** Human-readable description */
  description: string;
  /** Category for documentation */
  category: ConfigCategory;
  /** Is this required for the MCP to function? */
  required: boolean;
  /** Default value if not set (only for non-secrets) */
  defaultValue?: string;
  /** Is this a secret that should never be logged? */
  isSecret: boolean;
  /** Example value for documentation (use fake data for secrets) */
  example: string;
  /** Validation pattern (regex) */
  pattern?: string;
}

/**
 * Standard config items common to most MCPs
 */
export const STANDARD_CONFIG_ITEMS: ConfigItem[] = [
  {
    envVar: 'LOG_LEVEL',
    description: 'Logging verbosity level',
    category: 'feature',
    required: false,
    defaultValue: 'info',
    isSecret: false,
    example: 'debug',
    pattern: '^(error|warn|info|debug)$',
  },
  {
    envVar: 'REQUEST_TIMEOUT',
    description: 'Request timeout in milliseconds',
    category: 'limit',
    required: false,
    defaultValue: '30000',
    isSecret: false,
    example: '30000',
    pattern: '^\\d+$',
  },
  {
    envVar: 'MAX_RETRIES',
    description: 'Maximum retry attempts for failed requests',
    category: 'limit',
    required: false,
    defaultValue: '3',
    isSecret: false,
    example: '3',
    pattern: '^\\d+$',
  },
  {
    envVar: 'RATE_LIMIT_RPS',
    description: 'Rate limit in requests per second',
    category: 'limit',
    required: false,
    defaultValue: '10',
    isSecret: false,
    example: '10',
    pattern: '^\\d+$',
  },
];

/**
 * Auth-type specific config templates
 */
export const AUTH_CONFIG_TEMPLATES: Record<string, ConfigItem[]> = {
  api_key: [
    {
      envVar: '{TOOL}_API_KEY',
      description: 'API key for authentication',
      category: 'auth',
      required: true,
      isSecret: true,
      example: 'sk-xxxxxxxxxxxxxxxxxxxx',
    },
  ],
  bearer: [
    {
      envVar: '{TOOL}_TOKEN',
      description: 'Bearer token for authentication',
      category: 'auth',
      required: true,
      isSecret: true,
      example: 'eyJhbGciOiJIUzI1NiIs...',
    },
  ],
  oauth2: [
    {
      envVar: '{TOOL}_CLIENT_ID',
      description: 'OAuth 2.0 client ID',
      category: 'auth',
      required: true,
      isSecret: false,
      example: 'client-id-12345',
    },
    {
      envVar: '{TOOL}_CLIENT_SECRET',
      description: 'OAuth 2.0 client secret',
      category: 'auth',
      required: true,
      isSecret: true,
      example: 'secret-xxxxxxxxxxxx',
    },
  ],
  basic: [
    {
      envVar: '{TOOL}_USERNAME',
      description: 'Basic auth username',
      category: 'auth',
      required: true,
      isSecret: false,
      example: 'api-user',
    },
    {
      envVar: '{TOOL}_PASSWORD',
      description: 'Basic auth password',
      category: 'auth',
      required: true,
      isSecret: true,
      example: 'your-password',
    },
  ],
  custom: [
    {
      envVar: '{TOOL}_AUTH_CONFIG',
      description: 'Custom authentication configuration (JSON)',
      category: 'auth',
      required: true,
      isSecret: true,
      example: '{"type":"custom","token":"xxx"}',
    },
  ],
  har_file: [
    {
      envVar: '{TOOL}_HAR_FILE_PATH',
      description: 'Path to HAR file containing authentication data',
      category: 'auth',
      required: false,
      isSecret: false,
      example: './auth/{tool}.har',
    },
    {
      envVar: '{TOOL}_LOGIN_URL',
      description: 'Login URL for interactive authentication (if HAR not available)',
      category: 'auth',
      required: false,
      isSecret: false,
      example: 'https://login.{tool}.com',
    },
    {
      envVar: '{TOOL}_EXTRACTED_TOKEN',
      description: 'Extracted auth token from HAR file (auto-populated)',
      category: 'auth',
      required: false,
      isSecret: true,
      example: '',
    },
    {
      envVar: '{TOOL}_EXTRACTED_COOKIES',
      description: 'Extracted cookies from HAR file as JSON (auto-populated)',
      category: 'auth',
      required: false,
      isSecret: true,
      example: '',
    },
  ],
  har_or_api_key: [
    {
      envVar: '{TOOL}_API_KEY',
      description: 'API key for authentication (if available)',
      category: 'auth',
      required: false,
      isSecret: true,
      example: 'sk-xxxxxxxxxxxxxxxxxxxx',
    },
    {
      envVar: '{TOOL}_HAR_FILE_PATH',
      description: 'Path to HAR file containing authentication data (fallback if no API key)',
      category: 'auth',
      required: false,
      isSecret: false,
      example: './auth/{tool}.har',
    },
    {
      envVar: '{TOOL}_LOGIN_URL',
      description: 'Login URL for interactive authentication (fallback)',
      category: 'auth',
      required: false,
      isSecret: false,
      example: 'https://login.{tool}.com',
    },
    {
      envVar: '{TOOL}_EXTRACTED_TOKEN',
      description: 'Extracted auth token from HAR file (auto-populated)',
      category: 'auth',
      required: false,
      isSecret: true,
      example: '',
    },
  ],
};

/**
 * Generate config items for a tool
 */
export function generateConfigItems(
  toolName: string,
  authType: string,
  additionalConfig?: ConfigItem[]
): ConfigItem[] {
  const toolPrefix = toolName.toUpperCase().replace(/-/g, '_');

  // Start with standard config
  const items: ConfigItem[] = [...STANDARD_CONFIG_ITEMS];

  // Add auth-specific config (with tool prefix substitution)
  const authTemplate = AUTH_CONFIG_TEMPLATES[authType] ?? [];
  for (const item of authTemplate) {
    items.push({
      ...item,
      envVar: item.envVar.replace('{TOOL}', toolPrefix),
      description: item.description.replace('{tool}', toolName),
    });
  }

  // Add tool-specific endpoint config
  items.push({
    envVar: `${toolPrefix}_BASE_URL`,
    description: `Base URL for ${toolName} API`,
    category: 'endpoint',
    required: false,
    isSecret: false,
    example: `https://api.${toolName.toLowerCase()}.com`,
    defaultValue: `https://api.${toolName.toLowerCase()}.com`,
  });

  // Add any additional config
  if (additionalConfig) {
    items.push(...additionalConfig);
  }

  return items;
}

/**
 * Generate Zod schema for config validation
 */
export function generateConfigSchema(items: ConfigItem[]): string {
  const lines: string[] = [
    `import { z } from 'zod';`,
    ``,
    `export const ConfigSchema = z.object({`,
  ];

  for (const item of items) {
    const zodType = item.pattern
      ? `z.string().regex(/${item.pattern}/)`
      : 'z.string()';

    const schema = item.required
      ? zodType
      : item.defaultValue
        ? `${zodType}.default('${item.defaultValue}')`
        : `${zodType}.optional()`;

    lines.push(`  /** ${item.description} */`);
    lines.push(`  ${item.envVar}: ${schema},`);
  }

  lines.push(`});`);
  lines.push(``);
  lines.push(`export type Config = z.infer<typeof ConfigSchema>;`);

  return lines.join('\n');
}

/**
 * Generate .env.example file content
 */
export function generateEnvExample(items: ConfigItem[]): string {
  const lines: string[] = [
    `# ${new Date().toISOString().split('T')[0]} - Auto-generated configuration`,
    `# Copy this file to .env and fill in your values`,
    ``,
  ];

  const byCategory = new Map<ConfigCategory, ConfigItem[]>();
  for (const item of items) {
    const categoryItems = byCategory.get(item.category) ?? [];
    categoryItems.push(item);
    byCategory.set(item.category, categoryItems);
  }

  const categoryOrder: ConfigCategory[] = ['auth', 'endpoint', 'limit', 'feature', 'custom'];

  for (const category of categoryOrder) {
    const categoryItems = byCategory.get(category);
    if (!categoryItems || categoryItems.length === 0) continue;

    lines.push(`# === ${category.toUpperCase()} ===`);

    for (const item of categoryItems) {
      lines.push(`# ${item.description}`);
      if (item.required) {
        lines.push(`# Required: yes`);
      }
      if (item.isSecret) {
        lines.push(`# Secret: yes (never commit real values)`);
      }
      const value = item.defaultValue ?? item.example;
      lines.push(`${item.envVar}=${item.isSecret ? '' : value}`);
      lines.push(``);
    }
  }

  return lines.join('\n');
}

/**
 * Generate README section for configuration
 */
export function generateConfigReadme(items: ConfigItem[]): string {
  const lines: string[] = [
    `## Configuration`,
    ``,
    `This MCP is configured via environment variables. Copy \`.env.example\` to \`.env\` and set your values.`,
    ``,
    `### Required Variables`,
    ``,
    `| Variable | Description |`,
    `|----------|-------------|`,
  ];

  const required = items.filter((i) => i.required);
  const optional = items.filter((i) => !i.required);

  for (const item of required) {
    lines.push(`| \`${item.envVar}\` | ${item.description} |`);
  }

  if (optional.length > 0) {
    lines.push(``);
    lines.push(`### Optional Variables`);
    lines.push(``);
    lines.push(`| Variable | Description | Default |`);
    lines.push(`|----------|-------------|---------|`);

    for (const item of optional) {
      lines.push(`| \`${item.envVar}\` | ${item.description} | \`${item.defaultValue ?? '-'}\` |`);
    }
  }

  lines.push(``);
  lines.push(`### Security Notes`);
  lines.push(``);
  lines.push(`- Never commit \`.env\` files with real credentials`);
  lines.push(`- Use secret management (Azure Key Vault, AWS Secrets Manager) in production`);
  lines.push(`- All secrets are marked in \`.env.example\` with \`# Secret: yes\``);

  return lines.join('\n');
}

/**
 * Check if code contains any hardcoded company-specific data
 *
 * Pattern set broadened for the Conformance Lab's gate 5 (Stage 2 — see
 * src/lab/gates/credential-scan.ts, the sole consumer that scans a
 * generated server's full source tree with this function). Originally
 * only 4 narrow patterns (domains / sk- / ghp_ / xoxb- / emails / IPv4);
 * this adds JWTs, AWS access keys, Azure AD client secrets, and generic
 * hardcoded Bearer/high-entropy tokens so the Lab's live-target auth
 * material (mirroring the operator's own access, per Locked direction #3)
 * can't leak into committed/generated code undetected.
 */
/**
 * Markers that identify a matched string as a documented template
 * placeholder rather than a captured secret, so the supply-chain scan (Lab
 * gate 5, src/lab/gates/credential-scan.ts) doesn't block generation on its
 * own templates. Kept deliberately narrow — this is NOT a general
 * "looks like a dummy value" filter. `${...}` is shell/template variable
 * interpolation (e.g. the generated `.env.example`'s
 * `SHODAN_API_KEY=${SHODAN_API_KEY}`-style docs) and `hermescred://` is the
 * fleetd vault-reference scheme (README.md: "fleetd resolves the reference
 * to plaintext before spawning this process, so no secret value ever
 * appears in the manifest file itself") — both are structurally incapable of
 * being a real secret. Generic words like "example"/"dummy"/"placeholder"
 * are intentionally NOT included here: this function's own test suite
 * (config-abstraction.test.ts) requires AWS's own canonical example key
 * (AKIAIOSFODNN7EXAMPLE) to still be flagged, since a documented example
 * value copy-pasted into a config file is exactly as dangerous as a real
 * one left behind by accident — the scan can't tell those apart from shape
 * alone, so it fails closed.
 */
const PLACEHOLDER_MARKERS = ['${', 'hermescred://'];

function isPlaceholderMatch(match: string): boolean {
  return PLACEHOLDER_MARKERS.some((marker) => match.includes(marker));
}

export function detectHardcodedConfig(code: string): string[] {
  const issues: string[] = [];

  // Patterns that suggest hardcoded config
  const patterns = [
    // URLs with specific domains (not localhost/example.com)
    { regex: /https?:\/\/(?!localhost|127\.0\.0\.1|example\.com|api\.example\.com)[a-z0-9-]+\.(com|net|org|io)/gi, desc: 'Hardcoded domain' },
    // API keys/tokens (common vendor-prefixed formats). GitHub covers all
    // current token prefixes (ghp_ personal, gho_ OAuth, ghu_ user-to-server,
    // ghs_ server-to-server, ghr_ refresh) at their real minimum length (36+,
    // not a fixed 36 — GitHub has lengthened tokens before). Slack covers all
    // its documented prefixes (xoxb- bot, xoxa- app, xoxp- user, xoxr-
    // refresh, xoxs- workspace).
    { regex: /['"`](sk-[a-zA-Z0-9]{20,}|gh[posur]_[a-zA-Z0-9]{36,}|xox[baprs]-[a-zA-Z0-9-]+)['"`]/g, desc: 'Hardcoded API key' },
    // Google API keys (AIza + 35 chars — Maps/Firebase/GCP REST keys)
    { regex: /\bAIza[0-9A-Za-z_-]{35}\b/g, desc: 'Hardcoded Google API key' },
    // PEM-encoded private keys of any kind (RSA/EC/DSA/OPENSSH/generic)
    { regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, desc: 'Hardcoded PEM private key' },
    // Email addresses
    { regex: /['"`][a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}['"`]/g, desc: 'Hardcoded email' },
    // IP addresses (not localhost). Excludes version-shaped literals like
    // "Chrome/131.0.0.0" (a word char immediately followed by "/" right
    // before the digits -- e.g. curl_cffi's browser-identity User-Agent
    // string in src/templates/python/http_client.py, copied into every
    // generated server) and dotted-version suffixes like "5.14.131.0.0.0"
    // (immediately preceded by "."). A real IP embedded in a URL scheme
    // ("http://192.168.1.1") is NOT excluded: the two characters before it
    // are "//" (no preceding word char), which the lookbehind below doesn't
    // match, so it still flags.
    { regex: /(?<![A-Za-z0-9]\/)(?<!\.)\b(?!127\.0\.0\.1)(?!0\.0\.0\.0)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, desc: 'Hardcoded IP address' },
    // JWTs (header.payload[.signature], base64url segments)
    { regex: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, desc: 'Hardcoded JWT' },
    // AWS access key IDs
    { regex: /\bAKIA[0-9A-Z]{16}\b/g, desc: 'Hardcoded AWS access key ID' },
    // Azure AD client secrets (current format: 3 chars + digit + "Q~" + 31-34 chars)
    { regex: /\b[a-zA-Z0-9_~.]{3}[0-9]Q~[a-zA-Z0-9_~.-]{31,34}\b/g, desc: 'Hardcoded Azure AD client secret' },
    // Hardcoded Bearer tokens in string literals
    { regex: /['"`]Bearer\s+[A-Za-z0-9\-_.~+/=]{20,}['"`]/gi, desc: 'Hardcoded Bearer token' },
    // Generic high-entropy credential assignment, including browser-capture-
    // shaped session cookies (api_key/secret/token/password/session/cookie = "...").
    // This is the pattern most likely to catch a HAR/browser-capture-derived
    // session cookie hardcoded into generated source instead of read from
    // Hermes/env at runtime.
    //
    // The assignment operator alternation accepts Go's `:=` short variable
    // declaration as well as plain `=` and `:`. Go is the generator's default
    // output language and `token := "..."` is its most idiomatic way to bind a
    // captured credential, but a bare `[:=]` character class matches only ONE
    // character, so `:=` slipped the scan entirely (verified against the live
    // regex before this change). `:=` is listed first so it wins over the
    // single-character branch.
    { regex: /\b(?:api[_-]?key|secret|token|password|passwd|pwd|session[_-]?id|cookie)\b\s*(?::=|[:=])\s*['"`][A-Za-z0-9\-_/+=;.]{16,}['"`]/gi, desc: 'Hardcoded high-entropy credential' },
  ];

  for (const { regex, desc } of patterns) {
    const matches = code.match(regex);
    if (matches) {
      for (const match of matches) {
        if (isPlaceholderMatch(match)) continue;
        issues.push(`${desc}: ${match}`);
      }
    }
  }

  return issues;
}
