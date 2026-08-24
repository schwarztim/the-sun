import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { HermesError, HermesErrorCode } from './errors.js';
import { sanitizeLifecycleMessage } from './lifecycle-state.js';

const StringListSchema = z.union([z.string(), z.array(z.string())])
  .optional()
  .transform((value) => value === undefined ? undefined : Array.isArray(value) ? value : [value]);

const SafeProbeMetadataSchema = z.object({
  description: z.string().optional(),
  tool: z.string().optional(),
  toolName: z.string().optional(),
  endpointClass: z.string().optional(),
}).strict();

export const OrgRunbookMetadataSchema = z.object({
  service: z.string().min(1),
  scheme: z.string().min(1).optional(),
  owner: z.string().optional(),
  team: z.string().optional(),
  confluenceRunbookUrl: z.string().url().optional(),
  confluencePageId: z.string().optional(),
  pageId: z.string().optional(),
  jiraGroup: z.string().optional(),
  serviceNowGroup: z.string().optional(),
  safeProbe: SafeProbeMetadataSchema.optional(),
  conditionalAccess: StringListSchema,
  conditionalAccessNotes: StringListSchema,
  vpn: z.string().optional(),
  networkRequirements: StringListSchema,
  integrationNotes: StringListSchema,
  lastVerifiedAt: z.string().datetime({ offset: true }).optional(),
}).strict();

export type OrgRunbookMetadata = z.infer<typeof OrgRunbookMetadataSchema>;

const OrgRunbookFileSchema = z.object({
  version: z.literal(1),
  entries: z.array(OrgRunbookMetadataSchema),
}).strict();

export interface OrgRunbookFile {
  version: 1;
  entries: OrgRunbookMetadata[];
}

function redactOrgValue(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeLifecycleMessage(value);
  if (Array.isArray(value)) return value.map(redactOrgValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (/^(access[_-]?token|refresh[_-]?token|id[_-]?token|authorization|token|secret|password|api[_-]?key|apikey)$/i.test(key)) {
        out[key] = '[redacted]';
      } else {
        out[key] = redactOrgValue(entry);
      }
    }
    return out;
  }
  return value;
}

export class OrgRunbookRegistry {
  static readonly fileName = 'org-runbooks.json';
  private readonly entries: OrgRunbookMetadata[];

  constructor(entries: OrgRunbookMetadata[] = []) {
    this.entries = entries.map((entry) => redactOrgValue(entry) as OrgRunbookMetadata);
  }

  static async load(dataDir: string, fileName = OrgRunbookRegistry.fileName): Promise<OrgRunbookRegistry> {
    const root = path.resolve(dataDir);
    const filePath = path.resolve(root, fileName);
    if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
      throw new HermesError(HermesErrorCode.CONFIG_ERROR, `org runbook file must stay within Hermes dataDir: ${fileName}`);
    }
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new OrgRunbookRegistry();
      throw new HermesError(HermesErrorCode.CONFIG_ERROR, `failed to read ${filePath}`, { cause: err });
    }
    try {
      const parsed = OrgRunbookFileSchema.parse(JSON.parse(raw));
      return new OrgRunbookRegistry(parsed.entries);
    } catch (err) {
      throw new HermesError(HermesErrorCode.CONFIG_ERROR, `invalid ${filePath}: ${(err as Error).message}`, { cause: err });
    }
  }

  list(): OrgRunbookMetadata[] {
    return [...this.entries];
  }

  get(service: string, scheme?: string): OrgRunbookMetadata | undefined {
    return this.entries.find((entry) => entry.service === service && entry.scheme === scheme)
      ?? this.entries.find((entry) => entry.service === service && entry.scheme === undefined);
  }

  isEmpty(): boolean {
    return this.entries.length === 0;
  }
}
