import { describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { OrgRunbookRegistry } from '../src/org-runbook-registry.js';

let seq = 0;
const tmp = () => {
  const dir = path.resolve(process.cwd(), '.vitest', 'org-runbook-registry', String(++seq));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
};

describe('OrgRunbookRegistry', () => {
  it('loads missing optional metadata as an empty registry', async () => {
    const registry = await OrgRunbookRegistry.load(tmp());
    expect(registry.isEmpty()).toBe(true);
    expect(registry.get('servicenow', 'session')).toBeUndefined();
  });

  it('loads service and scheme-scoped non-secret metadata', async () => {
    const dir = tmp();
    writeFileSync(path.join(dir, OrgRunbookRegistry.fileName), JSON.stringify({
      version: 1,
      entries: [{
        service: 'ms365',
        scheme: 'graph',
        owner: 'Collaboration Platform',
        confluenceRunbookUrl: 'https://example.atlassian.net/wiki/spaces/ENG/pages/123/MS365+Runbook',
        pageId: '123',
        conditionalAccess: ['device certificate required'],
        networkRequirements: ['corporate VPN for admin endpoints'],
        safeProbe: { description: 'Graph /me read-only probe', tool: 'graph_me' },
        lastVerifiedAt: '2026-04-10T12:00:00.000Z',
      }],
    }));

    const registry = await OrgRunbookRegistry.load(dir);
    expect(registry.get('ms365', 'graph')).toMatchObject({
      owner: 'Collaboration Platform',
      pageId: '123',
      conditionalAccess: ['device certificate required'],
    });
  });

  it('rejects metadata file paths that escape the Hermes data directory', async () => {
    await expect(OrgRunbookRegistry.load(tmp(), '../outside.json')).rejects.toMatchObject({
      code: 'CONFIG_ERROR',
      message: expect.stringContaining('must stay within Hermes dataDir'),
    });
  });

  it('falls back from scheme metadata to service-wide metadata', async () => {
    const dir = tmp();
    writeFileSync(path.join(dir, OrgRunbookRegistry.fileName), JSON.stringify({
      version: 1,
      entries: [{ service: 'servicenow', team: 'ITSM', serviceNowGroup: 'ITSM Platform', lastVerifiedAt: '2026-04-10T12:00:00.000Z' }],
    }));

    const registry = await OrgRunbookRegistry.load(dir);
    expect(registry.get('servicenow', 'session')?.serviceNowGroup).toBe('ITSM Platform');
  });

  it('redacts token-shaped advisory strings during load', async () => {
    const dir = tmp();
    writeFileSync(path.join(dir, OrgRunbookRegistry.fileName), JSON.stringify({
      version: 1,
      entries: [{
        service: 'servicenow',
        scheme: 'session',
        owner: 'ITSM authorization=Bearer super.secret.token',
        integrationNotes: ['api-key=secret-value should never be stored here'],
      }],
    }));

    const registry = await OrgRunbookRegistry.load(dir);
    expect(JSON.stringify(registry.list())).not.toContain('super.secret.token');
    expect(JSON.stringify(registry.list())).not.toContain('secret-value');
    expect(JSON.stringify(registry.list())).toContain('[redacted]');
  });

  it('supports ServiceNow example metadata', async () => {
    const dir = tmp();
    writeFileSync(path.join(dir, OrgRunbookRegistry.fileName), JSON.stringify({
      version: 1,
      entries: [{
        service: 'servicenow',
        scheme: 'session',
        team: 'IT Service Management',
        confluenceRunbookUrl: 'https://example.atlassian.net/wiki/spaces/ITSM/pages/456/ServiceNow+Hermes+Runbook',
        serviceNowGroup: 'ServiceNow Platform',
        safeProbe: { description: 'Read-only current user/session probe', toolName: 'servicenow_get_current_user', endpointClass: 'identity-read' },
        conditionalAccessNotes: ['browser-acquired session; no live acquire from status checks'],
        vpn: 'Requires corporate network or VPN for instance access',
        lastVerifiedAt: '2026-04-10T13:00:00.000Z',
      }],
    }));

    const serviceNow = (await OrgRunbookRegistry.load(dir)).get('servicenow', 'session');
    expect(serviceNow).toMatchObject({
      team: 'IT Service Management',
      serviceNowGroup: 'ServiceNow Platform',
      safeProbe: { toolName: 'servicenow_get_current_user' },
    });
  });
});
