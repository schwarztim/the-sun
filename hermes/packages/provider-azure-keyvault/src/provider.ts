import type { Provider, ProviderCapabilities, ProviderContext, TokenBundle } from '@hermes/broker';
import { AzureKeyVaultConfigSchema, SCHEMES, SCOPES, type AzureKeyVaultScheme } from './config.js';

export interface AzureKeyVaultProviderDeps {
  now: () => number;
  httpFetch?: (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }
  ) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
  readKeychain?: (service: string, account: string) => Promise<string | null>;
}

const AZURE_KEYVAULT_CAPABILITIES: ProviderCapabilities = {
  headless: true,
  schemes: SCHEMES.map((scheme) => ({
    scheme,
    credentialSource: 'client-credentials' as const,
    refreshStrategy: 'client-credentials' as const,
    supportsRefresh: true,
    supportsValidation: true,
    validationStrategy: 'jwt-exp' as const,
  })),
  remediation: {
    acquire: 'Confirm tenantId/clientId and seed clientSecret directly or via the configured macOS Keychain reference.',
    refresh: 'Client credentials do not use refresh tokens; refresh re-runs the client_credentials grant with the configured secret.',
    validate: 'JWT expiry validation failures require client_credentials re-acquire; invalid_client means rotate or reseed the client secret.',
  },
};

function decodeJwt(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try { return JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')); } catch { return null; }
}

export class AzureKeyVaultProvider implements Provider {
  readonly name = 'azure-keyvault';
  readonly schemes = SCHEMES;
  readonly capabilities = AZURE_KEYVAULT_CAPABILITIES;

  constructor(private readonly deps: AzureKeyVaultProviderDeps) {}

  private get httpFetch() {
    return this.deps.httpFetch ?? (async (
      url: string,
      init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }
    ) => {
      const r = await globalThis.fetch(url, init);
      return { ok: r.ok, status: r.status, json: () => r.json() };
    });
  }

  private async resolveSecret(config: ReturnType<typeof AzureKeyVaultConfigSchema.parse>): Promise<string> {
    if (config.clientSecret) {
      return config.clientSecret;
    }
    if (config.clientSecretKeychainService && config.clientSecretKeychainAccount) {
      const readKeychain = this.deps.readKeychain ?? (async (service: string, account: string) => {
        const { readKeychainPassword } = await import('@hermes/auth-core');
        return readKeychainPassword(service, account);
      });
      const secret = await readKeychain(config.clientSecretKeychainService, config.clientSecretKeychainAccount);
      if (secret) return secret;
      throw new Error(
        `Keychain lookup returned null for service="${config.clientSecretKeychainService}" account="${config.clientSecretKeychainAccount}". ` +
        `Remediation: seed keychain entry ${config.clientSecretKeychainService}/${config.clientSecretKeychainAccount} with the client secret.`
      );
    }
    throw new Error(
      'No client secret available. Remediation: set clientSecret in service config or seed keychain entry via ' +
      'clientSecretKeychainService + clientSecretKeychainAccount.'
    );
  }

  async acquire(ctx: ProviderContext, scheme: string): Promise<TokenBundle> {
    const config = AzureKeyVaultConfigSchema.parse(ctx.config);
    if (!(SCHEMES as readonly string[]).includes(scheme)) {
      throw new Error(`unsupported azure-keyvault scheme "${scheme}". Remediation: use one of ${SCHEMES.join(', ')}.`);
    }
    const azScheme = scheme as AzureKeyVaultScheme;
    const scope = SCOPES[azScheme];
    const clientSecret = await this.resolveSecret(config);

    const tokenUrl = `${config.authority}/${config.tenantId}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: config.clientId,
      client_secret: clientSecret,
      scope,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.authTimeoutMs);
    let resp: { ok: boolean; status: number; json: () => Promise<unknown> };
    try {
      resp = await this.httpFetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const data = await resp.json() as Record<string, unknown>;

    if (!resp.ok) {
      const desc = typeof data['error_description'] === 'string' ? data['error_description'] : `HTTP ${resp.status}`;
      throw new Error(`Azure token endpoint returned ${resp.status}: ${desc}`);
    }

    const access_token = data['access_token'] as string | undefined;
    const token_type = (data['token_type'] as string | undefined) ?? 'Bearer';
    const expires_in = data['expires_in'] as number | undefined;
    if (!access_token || typeof expires_in !== 'number') {
      throw new Error(
        'Azure token endpoint response missing access_token or numeric expires_in. ' +
        'Remediation: verify tenantId/clientId/clientSecret and Azure AD app permissions.',
      );
    }
    const now = this.deps.now();

    return {
      service: ctx.service,
      scheme: azScheme,
      accessToken: access_token,
      tokenType: token_type,
      expiresAt: now + expires_in * 1000,
      acquiredAt: now,
      scope,
      extra: {
        accessToken: access_token,
        tenantId: config.tenantId,
        expiresAt: now + expires_in * 1000,
        ...(config.subscriptionId ? { subscriptionId: config.subscriptionId } : {}),
      },
    };
  }

  async refresh(ctx: ProviderContext, bundle: TokenBundle): Promise<TokenBundle> {
    // client_credentials has no refresh token — re-acquire with the same scheme
    return this.acquire(ctx, bundle.scheme);
  }

  async validate(_ctx: ProviderContext, bundle: TokenBundle): Promise<boolean> {
    // Decode JWT exp claim; no outbound HTTP call to avoid telemetry on every validate
    const jwt = decodeJwt(bundle.accessToken);
    if (jwt && typeof jwt['exp'] === 'number') {
      return jwt['exp'] * 1000 > this.deps.now();
    }
    // Fallback: trust expiresAt from the bundle
    return bundle.expiresAt > this.deps.now();
  }

  nextRefreshAt(bundle: TokenBundle): Date {
    const jwt = decodeJwt(bundle.accessToken);
    const expMs = (jwt && typeof jwt['exp'] === 'number') ? jwt['exp'] * 1000 : bundle.expiresAt;
    const lifetime = expMs - bundle.acquiredAt;
    const margin = Math.max(300_000, Math.floor(lifetime * 0.2));
    return new Date(expMs - margin);
  }
}
