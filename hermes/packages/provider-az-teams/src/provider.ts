import type { Provider, ProviderCapabilities, ProviderContext, TokenBundle } from '@hermes/broker';
import {
  silentRefresh, type OauthFetcher,
  assertRefreshTokenUsable, refreshTokenAcquiredAt, SPA_REFRESH_TOKEN_MAX_AGE_MS,
} from '@hermes/auth-core';
import {
  AzTeamsConfigSchema,
  CANONICAL_SCHEMES,
  SCHEMES,
  SCOPES,
  normalizeAzTeamsScheme,
  type CanonicalAzTeamsScheme,
} from './config.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import path from 'node:path';

const execFileAsync = promisify(execFile);
type ExecFileAsync = typeof execFileAsync;

export interface AzTeamsProviderDeps {
  fetcher: OauthFetcher;
  now: () => number;
  execFile?: ExecFileAsync;
  httpFetch?: (
    url: string,
    init: { method?: string; headers: Record<string, string>; body?: string },
  ) => Promise<{ ok: boolean; status: number; json(): Promise<Record<string, unknown>> }>;
}


const AZ_TEAMS_CAPABILITIES: ProviderCapabilities = {
  headless: true,
  schemes: SCHEMES.map((scheme) => ({
    scheme,
    credentialSource: 'external-vault' as const,
    refreshStrategy: scheme === 'skype' ? 'reacquire' as const : 'refresh-token' as const,
    supportsRefresh: true,
    supportsValidation: true,
    validationStrategy: 'http' as const,
    ...(scheme === 'skype' ? {} : { refreshTokenMaxAgeMs: SPA_REFRESH_TOKEN_MAX_AGE_MS }),
  })),
  remediation: {
    acquire: 'Hermes reads the host az-teams vault first, then runs auth.py headlessly; if blocked, run the printed auth.py browser command on the host.',
    refresh: 'Graph/files/teams refresh requires a valid az-teams vault refresh token; skype is re-minted on the host via the authsvc exchange (escalating to a host browser capture only if the teams token is stale). Re-run host auth.py if missing or older than 24h.',
    validate: 'Graph/files/teams validation calls their owning APIs; auth failures require az-teams vault reseeding. Skype is validated against the chatsvc conversations endpoint — a 401/403 there triggers a host re-mint/reacquire.',
  },
};

const VAULT_MAP: Record<CanonicalAzTeamsScheme, { at: string; rt?: string; exp?: string }> = {
  graph: { at: 'graph_access_token', rt: 'graph_refresh_token' },
  'teams-bearer': { at: 'teams_access_token', rt: 'teams_refresh_token' },
  skype: { at: 'skype_token', exp: 'skype_token_exp' },
  files: { at: 'graph_access_token', rt: 'graph_refresh_token' },
  substrate: { at: 'substrate_access_token', rt: 'substrate_refresh_token' },
};

// chatsvc auth is a PAIR: `Authorization: Bearer <teams-bearer>` + `x-skypetoken: <skype>`.
// This single-page conversations GET is the lightest authenticated chatsvc probe; region
// 'amer' is the safe default chatsvc uses for user-level (non-chat-scoped) calls. Empirically
// returns HTTP 200 with a valid pair and 401 when the skype token is dead, so validate() can
// actually detect a dead token instead of blindly trusting it.
const CHATSVC_VALIDATE_URL =
  'https://teams.microsoft.com/api/chatsvc/amer/v1/users/ME/conversations' +
  '?view=msnp24Equivalent&pageSize=1&startTime=0' +
  '&targetType=Passport|Skype|Lync|Thread|YOURPHONE|NotificationStream';

// substrate auth is a single Bearer token against substrate.office.com. GetGptList is a
// read-only, fixed-parameter endpoint (HAR-verified in the connector) — the lightest
// substrate probe with no side effects. The connector's _substrate_call treats 401 as the
// auth-failure signal, so validate returns false only on 401/403. The double slash before
// GetGptList mirrors the real client URL.
const SUBSTRATE_VALIDATE_URL =
  'https://substrate.office.com/m365Copilot//GetGptList?request=' +
  encodeURIComponent(JSON.stringify({
    optionsSets: ['flux_gpt_data_retriever_enterprise'],
    traceId: '00000000-0000-0000-0000-000000000000',
    source: 'teamshub',
    locale: 'en-us',
  }));

function decodeJwt(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function azTeamsProjectDir(): string {
  // AZ_TEAMS_PROJECT_DIR is the canonical contract — set it in your launch
  // script. The fallback points at unified-m365-mcp-server (the consolidated
  // host as of 2026-05-22) so existing deployments keep working after the
  // legacy ~/Projects/az-teams/ directory is archived. If neither exists,
  // execFile calls into Python/auth.py will fail loudly with ENOENT.
  return process.env['AZ_TEAMS_PROJECT_DIR'] ?? path.join(process.env['HOME'] ?? '', 'Projects', 'unified-m365-mcp-server');
}

function azTeamsPython(): string {
  if (process.env['AZ_TEAMS_PYTHON']) return process.env['AZ_TEAMS_PYTHON']!;
  const venvPython = path.join(azTeamsProjectDir(), '.venv', 'bin', 'python');
  return existsSync(venvPython) ? venvPython : 'python3';
}

function azTeamsAuthPy(): string {
  return process.env['AZ_TEAMS_AUTH_PY'] ?? path.join(azTeamsProjectDir(), 'auth.py');
}

async function authVaultGet(execFileFn: ExecFileAsync, key: string): Promise<string | null> {
  const python = azTeamsPython();
  const projectDir = azTeamsProjectDir();
  try {
    const { stdout } = await execFileFn(python, [
      '-c',
      [
        'import json, sys',
        'sys.path.insert(0, sys.argv[1])',
        'import auth',
        'v = auth._kget(sys.argv[2])',
        'print(json.dumps(v or ""))',
      ].join('; '),
      projectDir,
      key,
    ], { cwd: projectDir, timeout: 10000 });
    const val = JSON.parse(stdout.trim() || '""') as string;
    return val || null;
  } catch {
    return null;
  }
}

async function authVaultSet(execFileFn: ExecFileAsync, key: string | undefined, value: string | undefined): Promise<void> {
  if (!key || !value) return;
  const python = azTeamsPython();
  const projectDir = azTeamsProjectDir();
  await execFileFn(python, [
    '-c',
    [
      'import sys',
      'sys.path.insert(0, sys.argv[1])',
      'import auth',
      'auth._kset(sys.argv[2], sys.argv[3])',
    ].join('; '),
    projectDir,
    key,
    value,
  ], { cwd: projectDir, timeout: 10000 });
}

async function persistToAzTeamsVault(
  execFileFn: ExecFileAsync,
  scheme: CanonicalAzTeamsScheme,
  bundle: TokenBundle,
): Promise<void> {
  const map = VAULT_MAP[scheme];
  await authVaultSet(execFileFn, map.at, bundle.accessToken);
  await authVaultSet(execFileFn, map.rt, bundle.refreshToken);
  if (map.exp) {
    await authVaultSet(execFileFn, map.exp, String(Math.floor(bundle.expiresAt / 1000)));
  }
}

async function readFromVault(execFileFn: ExecFileAsync, scheme: CanonicalAzTeamsScheme): Promise<TokenBundle | null> {
  const map = VAULT_MAP[scheme];
  const at = await authVaultGet(execFileFn, map.at);
  if (!at) return null;

  const now = Date.now();
  let expiresAt: number;

  if (map.exp) {
    const expStr = await authVaultGet(execFileFn, map.exp);
    expiresAt = expStr ? parseFloat(expStr) * 1000 : now + 3600_000;
  } else {
    const jwt = decodeJwt(at);
    expiresAt = jwt?.exp ? (jwt.exp as number) * 1000 : now + 3600_000;
  }

  const rt = map.rt ? await authVaultGet(execFileFn, map.rt) : undefined;

  return {
    service: 'az-teams',
    scheme,
    accessToken: at,
    ...(rt ? { refreshToken: rt } : {}),
    tokenType: scheme === 'skype' ? 'Skype' : 'Bearer',
    expiresAt,
    acquiredAt: now,
    ...(rt ? { extra: { refreshTokenAcquiredAt: now } } : {}),
  };
}

function browserAuthCommandForScheme(scheme: CanonicalAzTeamsScheme): string {
  if (scheme === 'teams-bearer' || scheme === 'skype') return 'browser_teams';
  // files uses the OWA path (browser_x): browser_files navigates OneDrive only
  // and captures just the access token, never the graph refresh token Hermes
  // needs to keep files self-healing. The OWA handshake captures both (proven
  // 2026-05-29). The acquire() last-resort calls browser_auth_x inline; this
  // string is the operator-facing remediation (auth.py browser_x CLI command).
  if (scheme === 'files') return 'browser_x';
  if (scheme === 'substrate') return 'browser_teams';
  return 'browser';
}

function assertAzTeamsRefreshTokenUsable(bundle: TokenBundle, scheme: CanonicalAzTeamsScheme, now: number): void {
  const cmd = browserAuthCommandForScheme(scheme);
  assertRefreshTokenUsable(
    bundle, now,
    `az-teams:${scheme} refresh requires refreshToken. Remediation: run host auth.py ${cmd} to reseed the az-teams vault.`,
    `az-teams:${scheme} refresh token is older than ${Math.floor(SPA_REFRESH_TOKEN_MAX_AGE_MS / 3600_000)}h. ` +
    `Remediation: run host auth.py ${cmd} to reseed the az-teams vault.`,
  );
}

function withRefreshTokenAge(refreshed: TokenBundle, previous: TokenBundle, now: number): TokenBundle {
  const oldRtAcquiredAt = refreshTokenAcquiredAt(previous);
  const refreshTokenChanged = !!refreshed.refreshToken && refreshed.refreshToken !== previous.refreshToken;
  return {
    ...refreshed,
    extra: {
      ...((previous.extra as Record<string, unknown> | undefined) ?? {}),
      refreshTokenAcquiredAt: refreshTokenChanged ? now : oldRtAcquiredAt,
    },
  };
}

export class AzTeamsProvider implements Provider {
  readonly name = 'az-teams';
  readonly schemes = SCHEMES;
  readonly capabilities = AZ_TEAMS_CAPABILITIES;

  constructor(private readonly deps: AzTeamsProviderDeps) {}

  private get execFile(): ExecFileAsync {
    return this.deps.execFile ?? execFileAsync;
  }

  async acquire(ctx: ProviderContext, scheme: string): Promise<TokenBundle> {
    const s = normalizeAzTeamsScheme(scheme);

    // First try reading from the host az-teams vault (seeded by auth.py browser_teams/browser_files).
    const cached = await readFromVault(this.execFile, s);
    if (cached && cached.expiresAt > Date.now() + 60_000) {
      ctx.logger.info(`az-teams:${s} read from az-teams vault (valid)`);
      return { ...cached, service: ctx.service };
    }

    // Try silent refresh if we have a refresh token
    if (cached?.refreshToken && s !== 'skype') {
      try {
        ctx.logger.info(`az-teams:${s} attempting silent refresh`);
        return await this.refresh(ctx, { ...cached, service: ctx.service });
      } catch (err) {
        ctx.logger.warn(`az-teams:${s} silent refresh failed`, {
          error: (err as Error).message,
        });
      }
    }

    // For skype: authsvc exchange requires xms_rp_ipaddr which only exists
    // in browser-acquired tokens, not MSAL-refreshed ones. Two strategies:
    //   1. Read from vault (auth.py browser_teams does the exchange and stores it)
    //   2. Run browser_teams to get a fresh browser token, then read from vault
    // Direct exchange from a refreshed token will always 401.
    if (s === 'skype') {
      // Strategy 1: auth.py browser_teams already ran and stored the skype token
      const vaultSkype = await readFromVault(this.execFile, 'skype');
      if (vaultSkype && vaultSkype.expiresAt > Date.now() + 60_000) {
        ctx.logger.info('az-teams:skype read from az-teams vault (valid)');
        return { ...vaultSkype, service: ctx.service };
      }

      // Strategy 2: run browser_teams then force authsvc exchange.
      // browser_teams gets a token WITH xms_rp_ipaddr (required by authsvc).
      // After browser_teams, we run a Python snippet that clears the stale skype
      // token and calls get_skype_token() which does the authsvc exchange.
      ctx.logger.info('az-teams:skype running browser_teams + authsvc exchange');
      try {
        const config = AzTeamsConfigSchema.parse(ctx.config);
        const authPyPath = azTeamsAuthPy();
        const pythonPath = azTeamsPython();
        const projectDir = azTeamsProjectDir();

        // Step 1: browser_teams to get a fresh SPA token with xms_rp_ipaddr
        await this.execFile(pythonPath, [authPyPath, 'browser_teams'], {
          cwd: projectDir,
          timeout: config.authTimeoutMs,
          env: {
            ...process.env,
            AZ_TEAMS_DISABLE_HERMES_FALLBACK: '1',
            HERMES_AZ_TEAMS_PROVIDER: '1',
            PYTHONUNBUFFERED: '1',
          },
        });

        // Step 2: force authsvc exchange with the fresh browser token
        await this.execFile(pythonPath, [
          '-c',
          [
            'import os; os.environ["HERMES_URL"] = ""',
            'import sys; sys.path.insert(0, sys.argv[1])',
            'import auth',
            'auth._kdelete("skype_token")',
            'auth._kdelete("skype_token_exp")',
            'token = auth.get_skype_token()',
            'print(f"skype_token_len={len(token)}")',
          ].join('; '),
          projectDir,
        ], { cwd: projectDir, timeout: 30000 });

        // Re-read from vault
        const fresh = await readFromVault(this.execFile, 'skype');
        if (fresh && fresh.expiresAt > Date.now() + 60_000) {
          ctx.logger.info('az-teams:skype captured via browser_teams + authsvc exchange');
          return { ...fresh, service: ctx.service };
        }
      } catch (err) {
        ctx.logger.warn('az-teams:skype browser_teams + exchange failed', {
          error: (err as Error).message,
        });
      }
    }

    // For substrate, derive from teams-bearer refresh token with substrate scopes.
    // Same SPA client ID (5e3ce6c0), different resource (outlook.office.com/search).
    if (s === 'substrate') {
      const teamsCached = await readFromVault(this.execFile, 'teams-bearer');
      if (teamsCached?.refreshToken) {
        try {
          const config = AzTeamsConfigSchema.parse(ctx.config);
          assertAzTeamsRefreshTokenUsable(teamsCached, 'teams-bearer', this.deps.now());
          ctx.logger.info('az-teams:substrate refreshing from teams-bearer RT with substrate scopes');
          const refreshed = await silentRefresh({
            fetcher: this.deps.fetcher,
            tenant: config.tenant,
            clientId: config.teamsClientId,
            bundle: { ...teamsCached, service: ctx.service, scheme: 'substrate', tokenType: 'Bearer' },
            scopes: SCOPES['substrate'],
          });
          const now = this.deps.now();
          const bundle = {
            ...refreshed,
            service: ctx.service,
            scheme: 'substrate' as const,
            extra: { refreshTokenAcquiredAt: now },
          };
          await persistToAzTeamsVault(this.execFile, 'substrate', bundle);
          return bundle;
        } catch (err) {
          ctx.logger.warn('az-teams:substrate silent refresh from teams-bearer RT failed', {
            error: (err as Error).message,
          });
        }
      }
    }

    // For graph, try az CLI on the host (always works when az login is active)
    if (s === 'graph') {
      try {
        ctx.logger.info('az-teams:graph trying az CLI');
        const { stdout } = await execFileAsync('az', [
          'account', 'get-access-token',
          '--resource', 'https://graph.microsoft.com',
          '--query', 'accessToken',
          '-o', 'tsv',
        ], { timeout: 15000 });
        const token = stdout.trim();
        if (token) {
          const jwt = decodeJwt(token);
          const now = this.deps.now();
          return {
            service: ctx.service,
            scheme: 'graph',
            accessToken: token,
            tokenType: 'Bearer',
            expiresAt: jwt?.exp ? (jwt.exp as number) * 1000 : now + 3600_000,
            acquiredAt: now,
          };
        }
      } catch (err) {
        ctx.logger.warn('az-teams:graph az CLI failed', { error: (err as Error).message });
      }
    }

    // Last resort: run host auth.py headlessly. Do not install Playwright inside
    // the az-teams MCP container; Hermes owns host-side Conditional Access auth.
    const authCommand = browserAuthCommandForScheme(s);
    ctx.logger.info(`az-teams:${s} running auth.py ${authCommand} (headless)`);
    try {
      const config = AzTeamsConfigSchema.parse(ctx.config);
      const authPyPath = azTeamsAuthPy();
      const pythonPath = azTeamsPython();
      const projectDir = azTeamsProjectDir();
      const browserEnv = {
        ...process.env,
        AZ_TEAMS_DISABLE_HERMES_FALLBACK: '1',
        HERMES_AZ_TEAMS_PROVIDER: '1',
        PYTHONUNBUFFERED: '1',
      };
      if (s === 'files') {
        // OWA path captures the graph refresh token; the OneDrive CLI command
        // (browser_files) captures only the access token, leaving Hermes unable
        // to silent-refresh and forcing a reacquire on every expiry (the 409
        // loop). browser_auth_x is a public function with no CLI subcommand, so
        // call it inline — same pattern as the skype browser_teams+exchange path.
        await this.execFile(pythonPath, [
          '-c',
          [
            'import sys',
            'sys.path.insert(0, sys.argv[1])',
            'import auth',
            'auth.browser_auth_x(headless=True, timeout_ms=int(sys.argv[2]))',
          ].join('; '),
          projectDir,
          String(config.authTimeoutMs),
        ], { cwd: projectDir, timeout: config.authTimeoutMs + 15_000, env: browserEnv });
      } else {
        await this.execFile(pythonPath, [authPyPath, authCommand], {
          cwd: projectDir,
          timeout: config.authTimeoutMs,
          env: browserEnv,
        });
      }
      // Re-read from the vault after browser auth.
      const fresh = await readFromVault(this.execFile, s);
      if (fresh && fresh.expiresAt > Date.now() + 60_000) {
        return { ...fresh, service: ctx.service };
      }
    } catch (err) {
      ctx.logger.error(`az-teams:${s} auth.py browser failed`, {
        error: (err as Error).message,
      });
    }

    throw new Error(
      `az-teams:${s} -- no valid token available. ` +
        `Hermes attempted host auth.py ${authCommand} from ${azTeamsProjectDir()}. ` +
        `Operator action if Conditional Access or host prerequisites blocked it: run ` +
        `"cd ${azTeamsProjectDir()} && ${azTeamsPython()} auth.py ${authCommand}" on the host, then retry Hermes. ` +
        `Do not install Playwright in the MCP container.`,
    );
  }

  async acquireAll(ctx: ProviderContext): Promise<TokenBundle[]> {
    const bundles: TokenBundle[] = [];
    for (const scheme of CANONICAL_SCHEMES) {
      try {
        const bundle = await this.acquire(ctx, scheme);
        bundles.push(bundle);
      } catch (err) {
        ctx.logger.warn(`az-teams:${scheme} acquire failed`, {
          error: (err as Error).message,
        });
      }
    }
    return bundles;
  }

  async refresh(ctx: ProviderContext, bundle: TokenBundle): Promise<TokenBundle> {
    const config = AzTeamsConfigSchema.parse(ctx.config);
    const s = normalizeAzTeamsScheme(bundle.scheme);
    const now = this.deps.now();

    if (s === 'skype') {
      // skype uses the 'reacquire' strategy (see capabilities). The previous path did
      // an MSAL teams refresh + authsvc exchange — which acquire()'s own comment
      // documents "will always 401" for non-browser-origin tokens, so it minted dead
      // skype tokens that the old blind `validate() => true` never caught.
      //
      // Re-mint from the host keyring instead: invalidate the stale skype token, then
      // call auth.get_skype_token(), which performs the authsvc exchange from the
      // host's current teams token. get_skype_token() escalates to a host browser
      // capture ONLY when the teams token is itself stale, so this does not
      // double-authenticate with the host browser refresher when the keyring is fresh.
      // HERMES_URL is blanked so auth.py cannot recurse back into this broker.
      const projectDir = azTeamsProjectDir();
      const pythonPath = azTeamsPython();
      try {
        await this.execFile(pythonPath, [
          '-c',
          [
            'import os; os.environ["HERMES_URL"] = ""',
            'import sys; sys.path.insert(0, sys.argv[1])',
            'import auth',
            'auth._kdelete("skype_token")',
            'auth._kdelete("skype_token_exp")',
            'auth.get_skype_token()',
          ].join('; '),
          projectDir,
        ], { cwd: projectDir, timeout: config.authTimeoutMs });
        const fresh = await readFromVault(this.execFile, 'skype');
        if (fresh && fresh.expiresAt > now + 60_000) {
          ctx.logger.info('az-teams:skype re-minted via host authsvc exchange');
          return { ...fresh, service: bundle.service };
        }
      } catch (err) {
        ctx.logger.warn('az-teams:skype re-mint failed; falling back to full reacquire', {
          error: (err as Error).message,
        });
      }
      // Re-mint did not yield a usable token (e.g. teams token unrecoverable) — fall
      // back to the full host browser reacquire path (acquire's skype strategy 2).
      return this.acquire(ctx, 'skype');
    }

    const clientId = s === 'graph' || s === 'files' ? config.filesClientId : config.teamsClientId;
    const scopes = s === 'graph' ? SCOPES.files : SCOPES[s];
    assertAzTeamsRefreshTokenUsable(bundle, s, now);

    const refreshed = await silentRefresh({
      fetcher: this.deps.fetcher,
      tenant: config.tenant,
      clientId,
      bundle: { ...bundle, scheme: s },
      scopes,
    });
    const canonicalBundle = { ...withRefreshTokenAge(refreshed, bundle, now), service: bundle.service, scheme: s };
    await persistToAzTeamsVault(this.execFile, s, canonicalBundle);
    return canonicalBundle;
  }

  async validate(ctx: ProviderContext, bundle: TokenBundle): Promise<boolean> {
    const jwt = decodeJwt(bundle.accessToken);
    if (jwt?.exp && (jwt.exp as number) * 1000 <= this.deps.now()) return false;

    const doFetch =
      this.deps.httpFetch ??
      (async (url: string, init: { method?: string; headers: Record<string, string> }) => {
        const r = await globalThis.fetch(url, init);
        return {
          ok: r.ok,
          status: r.status,
          json: () => r.json() as Promise<Record<string, unknown>>,
        };
      });

    const s = normalizeAzTeamsScheme(bundle.scheme);
    try {
      switch (s) {
        case 'graph': {
          const resp = await doFetch('https://graph.microsoft.com/v1.0/me', {
            headers: { Authorization: `Bearer ${bundle.accessToken}` },
          });
          return resp.ok;
        }
        case 'teams-bearer': {
          const resp = await doFetch(
            'https://teams.microsoft.com/api/csa/api/v1/teams/users/me?isPrefetch=false',
            { headers: { Authorization: `Bearer ${bundle.accessToken}` } },
          );
          return resp.ok || resp.status === 403;
        }
        case 'skype': {
          // chatsvc auth is a PAIR: Bearer <teams-bearer> + x-skypetoken <skype>. Probe
          // the real chatsvc endpoint so a dead skype token is actually detected and
          // triggers a reacquire — the old blind `return true` masked every 401 and
          // defeated autoReacquire. Reacquire fires ONLY on a definitive 401/403, so a
          // transient/network blip never causes an auth storm.
          const teams = await readFromVault(this.execFile, 'teams-bearer');
          if (!teams?.accessToken || teams.expiresAt <= this.deps.now() + 60_000) {
            // A stale teams-bearer companion would send a dead Authorization header and
            // yield a false 401 — marking a possibly-valid skype token invalid and
            // triggering a needless reacquire. Treat a missing/stale companion as
            // inconclusive (valid); a separate teams-bearer refresh restores the pair.
            ctx.logger.warn('az-teams:skype validate inconclusive — teams-bearer missing or stale');
            return true;
          }
          try {
            const resp = await doFetch(CHATSVC_VALIDATE_URL, {
              headers: {
                Authorization: `Bearer ${teams.accessToken}`,
                'x-skypetoken': bundle.accessToken,
              },
            });
            return !(resp.status === 401 || resp.status === 403);
          } catch (err) {
            ctx.logger.warn('az-teams:skype validate probe errored (transient) — treating as valid', {
              error: (err as Error).message,
            });
            return true;
          }
        }
        case 'files': {
          const resp = await doFetch('https://graph.microsoft.com/v1.0/me/drive', {
            headers: { Authorization: `Bearer ${bundle.accessToken}` },
          });
          return resp.ok;
        }
        case 'substrate': {
          // substrate auth is a single Bearer token. Probe the read-only GetGptList
          // endpoint; reacquire fires ONLY on a definitive 401/403, and a transient/
          // network error is treated as valid to avoid a reacquire storm. Previously
          // substrate fell through to `default: return false`, forcing the broker to
          // reacquire a perfectly valid substrate token on every refresh cycle.
          try {
            const resp = await doFetch(SUBSTRATE_VALIDATE_URL, {
              // Mirror the connector's _substrate_headers exactly so the probe behaves
              // identically to a known-working substrate call.
              headers: {
                Authorization: `Bearer ${bundle.accessToken}`,
                'Content-Type': 'application/json',
                Accept: 'application/json',
              },
            });
            return !(resp.status === 401 || resp.status === 403);
          } catch (err) {
            ctx.logger.warn('az-teams:substrate validate probe errored (transient) — treating as valid', {
              error: (err as Error).message,
            });
            return true;
          }
        }
        default:
          return false;
      }
    } catch (err) {
      ctx.logger.warn(`az-teams validate (${s}) failed`, {
        error: (err as Error).message,
      });
      return false;
    }
  }

  nextRefreshAt(bundle: TokenBundle): Date {
    const jwt = decodeJwt(bundle.accessToken);
    const expMs = jwt?.exp ? (jwt.exp as number) * 1000 : bundle.expiresAt;
    const lifetime = expMs - bundle.acquiredAt;
    const margin = Math.max(300_000, Math.floor(lifetime * 0.2));
    const accessRefreshAt = expMs - margin;

    // Skype uses reacquire strategy and has no refreshTokenMaxAgeMs —
    // only access-token scheduling applies.
    const schemeCap = this.capabilities?.schemes.find(s => s.scheme === bundle.scheme);
    if (schemeCap?.refreshTokenMaxAgeMs) {
      const rtAcquiredAt = refreshTokenAcquiredAt(bundle);
      const rtDeadline = rtAcquiredAt + schemeCap.refreshTokenMaxAgeMs;
      const REACQUIRE_MARGIN_MS = 2 * 60 * 60 * 1000;
      const rtReacquireAt = rtDeadline - REACQUIRE_MARGIN_MS;
      return new Date(Math.min(accessRefreshAt, rtReacquireAt));
    }

    return new Date(accessRefreshAt);
  }
}
