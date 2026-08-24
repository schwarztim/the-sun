import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { HermesError, HermesErrorCode } from './errors.js';
import type { Provider, ServiceRegistration } from './types.js';

const ProbeExpectationSchema = z.object({
  httpStatus: z.union([z.number().int().min(100).max(599), z.array(z.number().int().min(100).max(599))]).optional(),
  shape: z.unknown().optional(),
  minArrayLength: z.array(z.object({
    path: z.string(),
    min: z.number().int().nonnegative(),
  }).strict()).optional(),
}).strict();

const DownstreamAuthProbeSchema = z.object({
  toolName: z.string().min(1),
  args: z.record(z.unknown()).optional(),
  operation: z.string().min(1).optional(),
  endpointClass: z.string().min(1).optional(),
  proofDepth: z.enum(['transport', 'provider', 'shallow', 'deep', 'last_real_use']).optional(),
  required: z.boolean().optional(),
  expectedSuccess: ProbeExpectationSchema.optional(),
  expectedAuthFailure: ProbeExpectationSchema.optional(),
  redaction: z.object({
    redactKeys: z.array(z.string().min(1)).optional(),
    redactPaths: z.array(z.string().min(1)).optional(),
  }).strict().optional(),
}).strict();

const IdentityAliasesSchema = z.array(z.string().min(1)).optional();

const ServiceRegistrationSchema = z.object({
  name: z.string(),
  providerName: z.string(),
  schemes: z.array(z.string()),
  config: z.record(z.unknown()),
  createdAt: z.number().int(),
  thvSecretPrefix: z.string().optional(),
  thvContainerName: z.string().optional(),
  serviceAliases: IdentityAliasesSchema,
  backendAliases: IdentityAliasesSchema,
  toolhiveContainerAliases: IdentityAliasesSchema,
  gatewayBackendAliases: IdentityAliasesSchema,
  userFacingNames: IdentityAliasesSchema,
  downstreamAuthProbe: DownstreamAuthProbeSchema.optional(),
  downstreamAuthProbes: z.array(DownstreamAuthProbeSchema).optional(),
  autoReacquire: z.boolean().optional(),
});

const SERVICE_ALIAS_FIELDS = [
  'serviceAliases',
  'backendAliases',
  'toolhiveContainerAliases',
  'gatewayBackendAliases',
  'userFacingNames',
] as const satisfies readonly (keyof ServiceRegistration)[];

const ServicesFileSchema = z.object({
  version: z.literal(1),
  services: z.array(ServiceRegistrationSchema),
});

export class ServiceRegistry {
  private providers = new Map<string, Provider>();
  private services = new Map<string, ServiceRegistration>();
  private readonly servicesPath: string;
  constructor(private readonly dataDir: string) { this.servicesPath = path.join(dataDir, 'services.json'); }

  installProvider(p: Provider): void { this.providers.set(p.name, p); }
  getProvider(name: string): Provider | undefined { return this.providers.get(name); }
  listProviders(): Provider[] { return Array.from(this.providers.values()); }
  getService(name: string): ServiceRegistration | undefined { return this.services.get(name); }
  listServices(): ServiceRegistration[] { return Array.from(this.services.values()); }

  /**
   * Resolve whether a service should auto-reacquire on token expiry.
   * Default is ON — Hermes's contract is "auth is a solved background
   * service," so services self-heal unless explicitly opted out.
   *
   * Priority: explicit `autoReacquire: false` (opt-out) > `true` (opt-in)
   *           > undefined (default-on). `undefined` in services.json means
   *           the operator never touched it — use the default.
   *
   * The existing bounded-retry (2 fails/10min) + CA-classification gates
   * contain misfires: a service that genuinely can't headless-acquire gets
   * at most 2 Playwright attempts per 10min, then surfaces INTERACTIVE_AUTH_REQUIRED.
   */
  autoReacquireEnabled(name: string): boolean {
    const reg = this.services.get(name);
    if (!reg) return false;
    if (reg.autoReacquire === false) return false;
    if (reg.autoReacquire === true) return true;
    return true;
  }
  resolveServiceName(input: string): string | undefined {
    if (this.services.has(input)) return input;
    const matches: string[] = [];
    for (const [name, service] of this.services) {
      if (this.identityAliases(service).includes(input)) matches.push(name);
    }
    return matches.length === 1 ? matches[0] : undefined;
  }
  resolveService(input: string): ServiceRegistration | undefined {
    const name = this.resolveServiceName(input);
    return name ? this.services.get(name) : undefined;
  }

  async registerService(reg: ServiceRegistration): Promise<void> {
    // Structural guard: headless must never be false
    if (reg.config && typeof reg.config === 'object' && 'headless' in reg.config && reg.config['headless'] === false) {
      throw new HermesError(HermesErrorCode.CONFIG_ERROR, `service ${reg.name} rejected: headless: false is not allowed — Hermes never opens foreground browsers`, { remediation: 'remove headless: false from the service config or set it to true' });
    }
    const provider = this.providers.get(reg.providerName);
    if (!provider) throw new HermesError(HermesErrorCode.PROVIDER_NOT_FOUND, `provider ${reg.providerName} is not installed`, { remediation: `install @hermes/provider-${reg.providerName}` });
    for (const scheme of reg.schemes) {
      if (!provider.schemes.includes(scheme)) throw new HermesError(HermesErrorCode.SERVICE_NOT_REGISTERED, `provider ${provider.name} does not support scheme ${scheme}`);
    }
    reg = ServiceRegistrationSchema.parse(reg);
    this.assertUnambiguousIdentities(reg);
    this.services.set(reg.name, reg);
    await this.persist();
  }

  async unregisterService(name: string): Promise<boolean> {
    const existed = this.services.delete(name);
    if (existed) await this.persist();
    return existed;
  }

  async loadServices(): Promise<void> {
    try {
      const raw = await fs.readFile(this.servicesPath, 'utf8');
      const parsed = ServicesFileSchema.parse(JSON.parse(raw));
      this.services.clear();
      for (const s of parsed.services) this.services.set(s.name, s);
      this.assertUnambiguousIdentities();
      for (const [name, svc] of this.services) {
        if (svc.config && typeof svc.config === 'object' && 'headless' in svc.config && svc.config['headless'] === false) {
          console.warn(`[hermes:registry] WARNING: service ${name} has headless: false — auto-correcting to true`);
          svc.config = { ...svc.config, headless: true };
        }
      }
    } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
  }

  private async persist(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    const data = { version: 1 as const, services: Array.from(this.services.values()) };
    await fs.writeFile(this.servicesPath, JSON.stringify(data, null, 2), { mode: 0o600 });
  }

  private identityAliases(service: ServiceRegistration): string[] {
    const aliases: string[] = [];
    if (service.thvContainerName) aliases.push(service.thvContainerName);
    for (const field of SERVICE_ALIAS_FIELDS) {
      const values = service[field];
      if (Array.isArray(values)) aliases.push(...values);
    }
    return Array.from(new Set(aliases.filter((alias) => alias !== service.name)));
  }

  private assertUnambiguousIdentities(candidate?: ServiceRegistration): void {
    const services = new Map(this.services);
    if (candidate) services.set(candidate.name, candidate);

    const exactOwners = new Map<string, string>();
    for (const name of services.keys()) exactOwners.set(name, name);

    const aliasOwners = new Map<string, string>();
    for (const [serviceName, service] of services) {
      for (const alias of this.identityAliases(service)) {
        const exactOwner = exactOwners.get(alias);
        if (exactOwner && exactOwner !== serviceName) {
          throw new HermesError(HermesErrorCode.CONFIG_ERROR, `identity alias ${alias} for service ${serviceName} conflicts with registered service ${exactOwner}`, {
            remediation: 'remove or rename the alias so service identity resolution is unambiguous',
          });
        }
        const existingOwner = aliasOwners.get(alias);
        if (existingOwner && existingOwner !== serviceName) {
          throw new HermesError(HermesErrorCode.CONFIG_ERROR, `identity alias ${alias} is ambiguous between services ${existingOwner} and ${serviceName}`, {
            remediation: 'remove duplicate aliases so each runtime service/backend identity maps to exactly one service',
          });
        }
        aliasOwners.set(alias, serviceName);
      }
    }
  }
}
