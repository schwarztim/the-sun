import { describe, it, expect } from 'vitest';
import { AzureKeyVaultConfigSchema, SCHEMES, SCOPES } from '../src/config.js';

describe('AzureKeyVaultConfig', () => {
  it('parses minimal valid config', () => {
    const parsed = AzureKeyVaultConfigSchema.parse({
      tenantId: 'tenant-123',
      clientId: 'client-456',
      clientSecret: 'secret-789',
    });
    expect(parsed.tenantId).toBe('tenant-123');
    expect(parsed.clientId).toBe('client-456');
    expect(parsed.clientSecret).toBe('secret-789');
    expect(parsed.headless).toBe(true);
    expect(parsed.authority).toBe('https://login.microsoftonline.com');
  });

  it('requires tenantId', () => {
    expect(() =>
      AzureKeyVaultConfigSchema.parse({ clientId: 'client-456', clientSecret: 'secret' })
    ).toThrow(/tenantId/);
  });

  it('requires clientId', () => {
    expect(() =>
      AzureKeyVaultConfigSchema.parse({ tenantId: 'tenant-123', clientSecret: 'secret' })
    ).toThrow(/clientId/);
  });

  it('SCHEMES contains management and vault', () => {
    expect(SCHEMES).toContain('management');
    expect(SCHEMES).toContain('vault');
  });

  it('SCOPES.management is the ARM default scope', () => {
    expect(SCOPES.management).toBe('https://management.azure.com/.default');
  });

  it('SCOPES.vault is the Key Vault data plane scope', () => {
    expect(SCOPES.vault).toBe('https://vault.azure.net/.default');
  });

  it('rejects headless: false', () => {
    expect(() =>
      AzureKeyVaultConfigSchema.parse({
        tenantId: 'tenant-123',
        clientId: 'client-456',
        clientSecret: 'secret',
        headless: false,
      })
    ).toThrow();
  });

  it('defaults authority to https://login.microsoftonline.com', () => {
    const parsed = AzureKeyVaultConfigSchema.parse({
      tenantId: 'tenant-123',
      clientId: 'client-456',
      clientSecret: 'secret',
    });
    expect(parsed.authority).toBe('https://login.microsoftonline.com');
  });
});
