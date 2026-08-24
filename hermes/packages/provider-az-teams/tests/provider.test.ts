import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AzTeamsProvider } from '../src/provider.js';
import type { ProviderContext } from '@hermes/broker';
import type { OauthTokenResponse } from '@hermes/auth-core';

function jwt(expSeconds: number): string {
  const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${enc({ alg: 'none' })}.${enc({ exp: expSeconds, appid: '5e3ce6c0-2b1f-4285-8d4b-75ee78787346' })}.sig`;
}

function ctx(): ProviderContext {
  return {
    service: 'az-teams',
    config: { loginHint: 'user@example.com' },
    dataDir: '.',
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  };
}

describe('AzTeamsProvider vault auth', () => {
  const originalProjectDir = process.env['AZ_TEAMS_PROJECT_DIR'];
  const originalPython = process.env['AZ_TEAMS_PYTHON'];
  const originalAuthPy = process.env['AZ_TEAMS_AUTH_PY'];
  const projectDir = '/Users/testuser/Projects/az-teams';
  const python = `${projectDir}/.venv/bin/python`;
  const authPy = `${projectDir}/auth.py`;

  beforeEach(() => {
    process.env['AZ_TEAMS_PROJECT_DIR'] = projectDir;
    process.env['AZ_TEAMS_PYTHON'] = python;
    process.env['AZ_TEAMS_AUTH_PY'] = authPy;
  });

  afterEach(() => {
    if (originalProjectDir === undefined) delete process.env['AZ_TEAMS_PROJECT_DIR'];
    else process.env['AZ_TEAMS_PROJECT_DIR'] = originalProjectDir;
    if (originalPython === undefined) delete process.env['AZ_TEAMS_PYTHON'];
    else process.env['AZ_TEAMS_PYTHON'] = originalPython;
    if (originalAuthPy === undefined) delete process.env['AZ_TEAMS_AUTH_PY'];
    else process.env['AZ_TEAMS_AUTH_PY'] = originalAuthPy;
  });

  it('exposes external-vault capabilities and remediation hints', () => {
    const provider = new AzTeamsProvider({
      fetcher: async () => {
        throw new Error('not used');
      },
      now: () => 1_700_000_000_000,
      execFile: (async () => ({ stdout: '', stderr: '' })) as never,
    });
    expect(provider.capabilities?.headless).toBe(true);
    expect(provider.capabilities?.schemes).toEqual(expect.arrayContaining([
      expect.objectContaining({ scheme: 'teams', credentialSource: 'external-vault', refreshStrategy: 'refresh-token' }),
      expect.objectContaining({ scheme: 'skype', credentialSource: 'external-vault', refreshStrategy: 'reacquire' }),
    ]));
    expect(provider.capabilities?.remediation.acquire).toContain('auth.py');
  });

  it('acquires scheme=teams from az-teams vault as teams-bearer', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const accessToken = jwt(exp);
    const vault = new Map<string, string>([
      ['teams_access_token', accessToken],
      ['teams_refresh_token', 'refresh-token'],
    ]);
    const calls: Array<{ file: string; args: readonly string[]; cwd?: string }> = [];
    const execFile = async (file: string, args: readonly string[], options?: { cwd?: string }) => {
      calls.push({ file, args, cwd: options?.cwd });
      const script = args[1] ?? '';
      if (script.includes('auth._kget')) {
        const key = args[3]!;
        return { stdout: `${JSON.stringify(vault.get(key) ?? '')}\n`, stderr: '' };
      }
      throw new Error(`unexpected execFile call: ${args.join(' ')}`);
    };

    const provider = new AzTeamsProvider({
      fetcher: async () => {
        throw new Error('refresh should not run for valid vault token');
      },
      now: () => 1_700_000_000_000,
      execFile: execFile as never,
    });

    const bundle = await provider.acquire(ctx(), 'teams');

    expect(bundle.scheme).toBe('teams-bearer');
    expect(bundle.accessToken).toBe(accessToken);
    expect(bundle.refreshToken).toBe('refresh-token');
    expect(calls.every((call) => call.file === python && call.cwd === projectDir)).toBe(true);
  });

  it('refreshes scheme=teams and persists canonical vault keys', async () => {
    const writes: Record<string, string> = {};
    const execFile = async (_file: string, args: readonly string[], options?: { cwd?: string }) => {
      expect(options?.cwd).toBe(projectDir);
      const script = args[1] ?? '';
      if (script.includes('auth._kset')) {
        writes[args[3]!] = args[4]!;
        return { stdout: '', stderr: '' };
      }
      throw new Error(`unexpected execFile call: ${args.join(' ')}`);
    };
    const refreshedToken = jwt(Math.floor(Date.now() / 1000) + 7200);
    const fetcher = async (): Promise<OauthTokenResponse> => ({
      access_token: refreshedToken,
      refresh_token: 'new-refresh',
      token_type: 'Bearer',
      expires_in: 7200,
    });
    const provider = new AzTeamsProvider({
      fetcher,
      now: () => 1_700_000_000_000,
      execFile: execFile as never,
    });

    const refreshed = await provider.refresh(ctx(), {
      service: 'az-teams',
      scheme: 'teams',
      accessToken: jwt(Math.floor(Date.now() / 1000) - 60),
      refreshToken: 'old-refresh',
      tokenType: 'Bearer',
      expiresAt: Date.now() - 60_000,
      acquiredAt: Date.now() - 120_000,
    });

    expect(refreshed.scheme).toBe('teams-bearer');
    expect(writes['teams_access_token']).toBe(refreshedToken);
    expect(writes['teams_refresh_token']).toBe('new-refresh');
    expect(writes).not.toHaveProperty('teams');
  });

  it('refresh rejects stale external-vault refresh tokens before calling AAD', async () => {
    const fetcher = async (): Promise<OauthTokenResponse> => {
      throw new Error('refresh should not be called for stale refresh token');
    };
    const provider = new AzTeamsProvider({
      fetcher,
      now: () => 1_700_000_000_000,
      execFile: (async () => ({ stdout: '', stderr: '' })) as never,
    });

    await expect(provider.refresh(ctx(), {
      service: 'az-teams',
      scheme: 'teams',
      accessToken: jwt(Math.floor(Date.now() / 1000) - 60),
      refreshToken: 'old-refresh',
      tokenType: 'Bearer',
      expiresAt: 1_700_000_000_000 - 60_000,
      acquiredAt: 1_700_000_000_000 - 25 * 60 * 60 * 1000,
    })).rejects.toThrow(/older than 24h.*auth.py browser_teams/s);
  });

  it('refreshes graph vault tokens with the files client and files scopes', async () => {
    let refreshBody = '';
    const writes: Record<string, string> = {};
    const execFile = async (_file: string, args: readonly string[]) => {
      const script = args[1] ?? '';
      if (script.includes('auth._kset')) {
        writes[args[3]!] = args[4]!;
        return { stdout: '', stderr: '' };
      }
      throw new Error(`unexpected execFile call: ${args.join(' ')}`);
    };
    const refreshedToken = jwt(Math.floor(Date.now() / 1000) + 7200);
    const fetcher = async (_url: string, opts: { body: string }): Promise<OauthTokenResponse> => {
      refreshBody = opts.body;
      return {
        access_token: refreshedToken,
        refresh_token: 'new-graph-refresh',
        token_type: 'Bearer',
        expires_in: 7200,
      };
    };
    const provider = new AzTeamsProvider({
      fetcher,
      now: () => 1_700_000_000_000,
      execFile: execFile as never,
    });

    const refreshed = await provider.refresh(ctx(), {
      service: 'az-teams',
      scheme: 'graph',
      accessToken: jwt(Math.floor(Date.now() / 1000) - 60),
      refreshToken: 'old-graph-refresh',
      tokenType: 'Bearer',
      expiresAt: Date.now() - 60_000,
      acquiredAt: Date.now() - 120_000,
    });

    const params = new URLSearchParams(refreshBody);
    expect(params.get('client_id')).toBe('9199bf20-a13f-4107-85dc-02114787ef48');
    expect(params.get('scope')).toContain('https://graph.microsoft.com/Files.ReadWrite.All');
    expect(refreshed.scheme).toBe('graph');
    expect(writes['graph_access_token']).toBe(refreshedToken);
    expect(writes['graph_refresh_token']).toBe('new-graph-refresh');
  });

  it('runs host auth.py browser_teams from the az-teams cwd as last resort', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const accessToken = jwt(exp);
    let browserAuthRan = false;
    const browserCalls: Array<{ file: string; args: readonly string[]; cwd?: string; env?: NodeJS.ProcessEnv }> = [];
    const execFile = async (file: string, args: readonly string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
      const script = args[1] ?? '';
      if (script.includes('auth._kget')) {
        const key = args[3]!;
        if (!browserAuthRan) return { stdout: `${JSON.stringify('')}\n`, stderr: '' };
        const values: Record<string, string> = {
          teams_access_token: accessToken,
          teams_refresh_token: 'refresh-after-browser',
        };
        return { stdout: `${JSON.stringify(values[key] ?? '')}\n`, stderr: '' };
      }
      if (args[0] === authPy && args[1] === 'browser_teams') {
        browserAuthRan = true;
        browserCalls.push({ file, args, cwd: options?.cwd, env: options?.env });
        return { stdout: 'seeded\n', stderr: '' };
      }
      throw new Error(`unexpected execFile call: ${args.join(' ')}`);
    };
    const provider = new AzTeamsProvider({
      fetcher: async () => {
        throw new Error('refresh should not run without a cached refresh token');
      },
      now: () => 1_700_000_000_000,
      execFile: execFile as never,
    });

    const bundle = await provider.acquire(ctx(), 'teams');

    expect(bundle.scheme).toBe('teams-bearer');
    expect(bundle.accessToken).toBe(accessToken);
    expect(browserCalls).toHaveLength(1);
    expect(browserCalls[0]).toMatchObject({ file: python, args: [authPy, 'browser_teams'], cwd: projectDir });
    expect(browserCalls[0]!.env?.['AZ_TEAMS_DISABLE_HERMES_FALLBACK']).toBe('1');
    expect(browserCalls[0]!.env?.['HERMES_AZ_TEAMS_PROVIDER']).toBe('1');
  });

  it('reseeds scheme=files via the OWA path (browser_auth_x) and captures the refresh token', async () => {
    // Regression guard: the OneDrive command (browser_files) captures only the
    // access token, so files would hit the 409 reacquire loop forever. The OWA
    // path (browser_auth_x) captures the refresh token Hermes needs. Proven
    // self-healable 2026-05-29; this locks the provider onto the OWA path.
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const accessToken = jwt(exp);
    let owaRan = false;
    let browserFilesCalled = false;
    const owaCalls: Array<{ file: string; args: readonly string[]; cwd?: string; env?: NodeJS.ProcessEnv }> = [];
    const execFile = async (file: string, args: readonly string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
      const script = args[1] ?? '';
      if (script.includes('auth._kget')) {
        const key = args[3]!;
        if (!owaRan) return { stdout: `${JSON.stringify('')}\n`, stderr: '' };
        const values: Record<string, string> = {
          graph_access_token: accessToken,
          graph_refresh_token: 'refresh-after-owa',
        };
        return { stdout: `${JSON.stringify(values[key] ?? '')}\n`, stderr: '' };
      }
      // OWA reseed: inline python calling the public browser_auth_x function.
      if (args[0] === '-c' && script.includes('auth.browser_auth_x')) {
        owaRan = true;
        owaCalls.push({ file, args, cwd: options?.cwd, env: options?.env });
        return { stdout: '', stderr: '' };
      }
      // The OneDrive CLI command must never be used for files reseed.
      if (args[1] === 'browser_files') {
        browserFilesCalled = true;
        return { stdout: '', stderr: '' };
      }
      throw new Error(`unexpected execFile call: ${args.join(' ')}`);
    };
    const provider = new AzTeamsProvider({
      fetcher: async () => {
        throw new Error('refresh should not run without a cached refresh token');
      },
      now: () => 1_700_000_000_000,
      execFile: execFile as never,
    });

    const bundle = await provider.acquire(ctx(), 'files');

    expect(owaRan).toBe(true);
    expect(browserFilesCalled).toBe(false);
    expect(owaCalls).toHaveLength(1);
    expect(owaCalls[0]!.cwd).toBe(projectDir);
    expect(owaCalls[0]!.env?.['HERMES_AZ_TEAMS_PROVIDER']).toBe('1');
    expect(bundle.scheme).toBe('files');
    expect(bundle.accessToken).toBe(accessToken);
    expect(bundle.refreshToken).toBe('refresh-after-owa');
  });

  it('validate(skype) returns false when chatsvc returns 401 (RED: old code blindly returned true)', async () => {
    const teamsTok = jwt(Math.floor(Date.now() / 1000) + 3600);
    const skypeTok = jwt(Math.floor(Date.now() / 1000) + 3600);
    const execFile = async (_file: string, args: readonly string[]) => {
      const script = args[1] ?? '';
      if (script.includes('auth._kget')) {
        const key = args[3]!;
        const vals: Record<string, string> = { teams_access_token: teamsTok, teams_refresh_token: 'rt' };
        return { stdout: `${JSON.stringify(vals[key] ?? '')}\n`, stderr: '' };
      }
      throw new Error(`unexpected execFile call: ${args.join(' ')}`);
    };
    const captured: Array<{ url: string; headers: Record<string, string> }> = [];
    const httpFetch = async (url: string, init: { headers: Record<string, string> }) => {
      captured.push({ url, headers: init.headers });
      return { ok: false, status: 401, json: async () => ({}) };
    };
    const provider = new AzTeamsProvider({
      fetcher: async () => { throw new Error('not used'); },
      now: () => Date.now(),
      execFile: execFile as never,
      httpFetch: httpFetch as never,
    });
    const ok = await provider.validate(ctx(), {
      service: 'az-teams', scheme: 'skype', accessToken: skypeTok,
      tokenType: 'Skype', expiresAt: Date.now() + 3600_000, acquiredAt: Date.now(),
    });
    expect(ok).toBe(false);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toContain('/api/chatsvc/amer/v1/users/ME/conversations');
    expect(captured[0]!.headers['Authorization']).toBe(`Bearer ${teamsTok}`);
    expect(captured[0]!.headers['x-skypetoken']).toBe(skypeTok);
  });

  it('validate(skype) returns true when chatsvc returns 200', async () => {
    const teamsTok = jwt(Math.floor(Date.now() / 1000) + 3600);
    const skypeTok = jwt(Math.floor(Date.now() / 1000) + 3600);
    const execFile = async (_file: string, args: readonly string[]) => {
      const script = args[1] ?? '';
      if (script.includes('auth._kget')) {
        const key = args[3]!;
        const vals: Record<string, string> = { teams_access_token: teamsTok };
        return { stdout: `${JSON.stringify(vals[key] ?? '')}\n`, stderr: '' };
      }
      throw new Error(`unexpected execFile call: ${args.join(' ')}`);
    };
    const httpFetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
    const provider = new AzTeamsProvider({
      fetcher: async () => { throw new Error('not used'); },
      now: () => Date.now(),
      execFile: execFile as never,
      httpFetch: httpFetch as never,
    });
    const ok = await provider.validate(ctx(), {
      service: 'az-teams', scheme: 'skype', accessToken: skypeTok,
      tokenType: 'Skype', expiresAt: Date.now() + 3600_000, acquiredAt: Date.now(),
    });
    expect(ok).toBe(true);
  });

  it('validate(skype) treats a transient probe error as valid (no reacquire storm)', async () => {
    const teamsTok = jwt(Math.floor(Date.now() / 1000) + 3600);
    const skypeTok = jwt(Math.floor(Date.now() / 1000) + 3600);
    const execFile = async (_file: string, args: readonly string[]) => {
      const script = args[1] ?? '';
      if (script.includes('auth._kget')) {
        const key = args[3]!;
        const vals: Record<string, string> = { teams_access_token: teamsTok };
        return { stdout: `${JSON.stringify(vals[key] ?? '')}\n`, stderr: '' };
      }
      throw new Error(`unexpected execFile call: ${args.join(' ')}`);
    };
    const httpFetch = async () => { throw new Error('ECONNRESET'); };
    const provider = new AzTeamsProvider({
      fetcher: async () => { throw new Error('not used'); },
      now: () => Date.now(),
      execFile: execFile as never,
      httpFetch: httpFetch as never,
    });
    const ok = await provider.validate(ctx(), {
      service: 'az-teams', scheme: 'skype', accessToken: skypeTok,
      tokenType: 'Skype', expiresAt: Date.now() + 3600_000, acquiredAt: Date.now(),
    });
    expect(ok).toBe(true);
  });

  it('validate(skype) is inconclusive (true, no probe) when no teams-bearer companion exists', async () => {
    const skypeTok = jwt(Math.floor(Date.now() / 1000) + 3600);
    const execFile = async (_file: string, args: readonly string[]) => {
      const script = args[1] ?? '';
      if (script.includes('auth._kget')) return { stdout: `${JSON.stringify('')}\n`, stderr: '' };
      throw new Error(`unexpected execFile call: ${args.join(' ')}`);
    };
    let probed = false;
    const httpFetch = async () => { probed = true; return { ok: true, status: 200, json: async () => ({}) }; };
    const provider = new AzTeamsProvider({
      fetcher: async () => { throw new Error('not used'); },
      now: () => Date.now(),
      execFile: execFile as never,
      httpFetch: httpFetch as never,
    });
    const ok = await provider.validate(ctx(), {
      service: 'az-teams', scheme: 'skype', accessToken: skypeTok,
      tokenType: 'Skype', expiresAt: Date.now() + 3600_000, acquiredAt: Date.now(),
    });
    expect(ok).toBe(true);
    expect(probed).toBe(false);
  });

  it('refresh(skype) re-mints via host get_skype_token without an MSAL exchange', async () => {
    const skypeTok = jwt(Math.floor(Date.now() / 1000) + 3600);
    const skypeExp = String(Math.floor(Date.now() / 1000) + 3600);
    let reminted = false;
    const remintCalls: Array<{ script: string; cwd?: string }> = [];
    const execFile = async (_file: string, args: readonly string[], options?: { cwd?: string }) => {
      const script = args[1] ?? '';
      if (args[0] === '-c' && script.includes('auth.get_skype_token')) {
        reminted = true;
        remintCalls.push({ script, cwd: options?.cwd });
        return { stdout: '', stderr: '' };
      }
      if (script.includes('auth._kget')) {
        const key = args[3]!;
        const vals: Record<string, string> = reminted
          ? { skype_token: skypeTok, skype_token_exp: skypeExp }
          : {};
        return { stdout: `${JSON.stringify(vals[key] ?? '')}\n`, stderr: '' };
      }
      throw new Error(`unexpected execFile call: ${args.join(' ')}`);
    };
    const provider = new AzTeamsProvider({
      fetcher: async () => { throw new Error('MSAL must not run for skype reacquire'); },
      now: () => Date.now(),
      execFile: execFile as never,
    });
    const out = await provider.refresh(ctx(), {
      service: 'az-teams', scheme: 'skype',
      accessToken: jwt(Math.floor(Date.now() / 1000) - 60),
      tokenType: 'Skype', expiresAt: Date.now() - 1000, acquiredAt: Date.now() - 60_000,
    });
    expect(reminted).toBe(true);
    expect(out.scheme).toBe('skype');
    expect(out.accessToken).toBe(skypeTok);
    expect(remintCalls).toHaveLength(1);
    expect(remintCalls[0]!.script).toContain('auth._kdelete("skype_token")');
    expect(remintCalls[0]!.script).toContain('os.environ["HERMES_URL"] = ""');
    expect(remintCalls[0]!.cwd).toBe(projectDir);
  });

  it('validate(skype) returns false when chatsvc returns 403 (treated like 401)', async () => {
    const teamsTok = jwt(Math.floor(Date.now() / 1000) + 3600);
    const skypeTok = jwt(Math.floor(Date.now() / 1000) + 3600);
    const execFile = async (_file: string, args: readonly string[]) => {
      const script = args[1] ?? '';
      if (script.includes('auth._kget')) {
        const key = args[3]!;
        const vals: Record<string, string> = { teams_access_token: teamsTok };
        return { stdout: `${JSON.stringify(vals[key] ?? '')}\n`, stderr: '' };
      }
      throw new Error(`unexpected execFile call: ${args.join(' ')}`);
    };
    const httpFetch = async () => ({ ok: false, status: 403, json: async () => ({}) });
    const provider = new AzTeamsProvider({
      fetcher: async () => { throw new Error('not used'); },
      now: () => Date.now(),
      execFile: execFile as never,
      httpFetch: httpFetch as never,
    });
    const ok = await provider.validate(ctx(), {
      service: 'az-teams', scheme: 'skype', accessToken: skypeTok,
      tokenType: 'Skype', expiresAt: Date.now() + 3600_000, acquiredAt: Date.now(),
    });
    expect(ok).toBe(false);
  });

  it('validate(skype) returns false immediately for an expired skype JWT without any probe', async () => {
    let execCalled = false;
    let fetchCalled = false;
    const execFile = async () => { execCalled = true; return { stdout: '', stderr: '' }; };
    const httpFetch = async () => { fetchCalled = true; return { ok: true, status: 200, json: async () => ({}) }; };
    const provider = new AzTeamsProvider({
      fetcher: async () => { throw new Error('not used'); },
      now: () => Date.now(),
      execFile: execFile as never,
      httpFetch: httpFetch as never,
    });
    const ok = await provider.validate(ctx(), {
      service: 'az-teams', scheme: 'skype', accessToken: jwt(Math.floor(Date.now() / 1000) - 60),
      tokenType: 'Skype', expiresAt: Date.now() - 60_000, acquiredAt: Date.now() - 3600_000,
    });
    expect(ok).toBe(false);
    expect(execCalled).toBe(false);
    expect(fetchCalled).toBe(false);
  });

  it('validate(skype) is inconclusive (true, no probe) when the teams-bearer companion is expired', async () => {
    const expiredTeams = jwt(Math.floor(Date.now() / 1000) - 120);
    const skypeTok = jwt(Math.floor(Date.now() / 1000) + 3600);
    const execFile = async (_file: string, args: readonly string[]) => {
      const script = args[1] ?? '';
      if (script.includes('auth._kget')) {
        const key = args[3]!;
        const vals: Record<string, string> = { teams_access_token: expiredTeams };
        return { stdout: `${JSON.stringify(vals[key] ?? '')}\n`, stderr: '' };
      }
      throw new Error(`unexpected execFile call: ${args.join(' ')}`);
    };
    let probed = false;
    const httpFetch = async () => { probed = true; return { ok: false, status: 401, json: async () => ({}) }; };
    const provider = new AzTeamsProvider({
      fetcher: async () => { throw new Error('not used'); },
      now: () => Date.now(),
      execFile: execFile as never,
      httpFetch: httpFetch as never,
    });
    const ok = await provider.validate(ctx(), {
      service: 'az-teams', scheme: 'skype', accessToken: skypeTok,
      tokenType: 'Skype', expiresAt: Date.now() + 3600_000, acquiredAt: Date.now(),
    });
    expect(ok).toBe(true);
    expect(probed).toBe(false);
  });

  it('validate(substrate) returns true on 200 (RED: old code fell through to default false)', async () => {
    const subTok = jwt(Math.floor(Date.now() / 1000) + 3600);
    const captured: Array<{ url: string; headers: Record<string, string> }> = [];
    const httpFetch = async (url: string, init: { headers: Record<string, string> }) => {
      captured.push({ url, headers: init.headers });
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const provider = new AzTeamsProvider({
      fetcher: async () => { throw new Error('not used'); },
      now: () => Date.now(),
      execFile: (async () => ({ stdout: '', stderr: '' })) as never,
      httpFetch: httpFetch as never,
    });
    const ok = await provider.validate(ctx(), {
      service: 'az-teams', scheme: 'substrate', accessToken: subTok,
      tokenType: 'Bearer', expiresAt: Date.now() + 3600_000, acquiredAt: Date.now(),
    });
    expect(ok).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toContain('substrate.office.com/m365Copilot//GetGptList');
    expect(captured[0]!.headers['Authorization']).toBe(`Bearer ${subTok}`);
  });

  it('validate(substrate) returns false on 401', async () => {
    const subTok = jwt(Math.floor(Date.now() / 1000) + 3600);
    const httpFetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
    const provider = new AzTeamsProvider({
      fetcher: async () => { throw new Error('not used'); },
      now: () => Date.now(),
      execFile: (async () => ({ stdout: '', stderr: '' })) as never,
      httpFetch: httpFetch as never,
    });
    const ok = await provider.validate(ctx(), {
      service: 'az-teams', scheme: 'substrate', accessToken: subTok,
      tokenType: 'Bearer', expiresAt: Date.now() + 3600_000, acquiredAt: Date.now(),
    });
    expect(ok).toBe(false);
  });

  it('validate(substrate) treats a transient probe error as valid (no reacquire storm)', async () => {
    const subTok = jwt(Math.floor(Date.now() / 1000) + 3600);
    const httpFetch = async () => { throw new Error('ETIMEDOUT'); };
    const provider = new AzTeamsProvider({
      fetcher: async () => { throw new Error('not used'); },
      now: () => Date.now(),
      execFile: (async () => ({ stdout: '', stderr: '' })) as never,
      httpFetch: httpFetch as never,
    });
    const ok = await provider.validate(ctx(), {
      service: 'az-teams', scheme: 'substrate', accessToken: subTok,
      tokenType: 'Bearer', expiresAt: Date.now() + 3600_000, acquiredAt: Date.now(),
    });
    expect(ok).toBe(true);
  });

  it('validate(substrate) returns false on 403', async () => {
    const subTok = jwt(Math.floor(Date.now() / 1000) + 3600);
    const httpFetch = async () => ({ ok: false, status: 403, json: async () => ({}) });
    const provider = new AzTeamsProvider({
      fetcher: async () => { throw new Error('not used'); },
      now: () => Date.now(),
      execFile: (async () => ({ stdout: '', stderr: '' })) as never,
      httpFetch: httpFetch as never,
    });
    const ok = await provider.validate(ctx(), {
      service: 'az-teams', scheme: 'substrate', accessToken: subTok,
      tokenType: 'Bearer', expiresAt: Date.now() + 3600_000, acquiredAt: Date.now(),
    });
    expect(ok).toBe(false);
  });

  it('validate(substrate) returns false immediately for an expired JWT without any probe', async () => {
    let fetchCalled = false;
    const httpFetch = async () => { fetchCalled = true; return { ok: true, status: 200, json: async () => ({}) }; };
    const provider = new AzTeamsProvider({
      fetcher: async () => { throw new Error('not used'); },
      now: () => Date.now(),
      execFile: (async () => ({ stdout: '', stderr: '' })) as never,
      httpFetch: httpFetch as never,
    });
    const ok = await provider.validate(ctx(), {
      service: 'az-teams', scheme: 'substrate', accessToken: jwt(Math.floor(Date.now() / 1000) - 60),
      tokenType: 'Bearer', expiresAt: Date.now() - 60_000, acquiredAt: Date.now() - 3600_000,
    });
    expect(ok).toBe(false);
    expect(fetchCalled).toBe(false);
  });
});
