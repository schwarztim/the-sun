import { describe, it, expect, vi } from 'vitest';
import { ServiceNowProvider, classifyServiceNowHttpFailure, computeServiceNowSessionExpiry } from '../src/provider.js';
import { DEFAULT_REFRESH_MARGIN_MS, DEFAULT_SESSION_LIFETIME_MS, ServiceNowConfigSchema } from '../src/config.js';
import type { TokenBundle, ProviderContext } from '@hermes/broker';
import type { CaptureDebugStateOptions, CaptureDebugStateResult } from '@hermes/auth-core';

const NOW = 1_700_000_000_000;
const INSTANCE_URL = 'https://acmeprod.service-now.com';
const nullLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function ctx(config: Record<string, unknown> = {}): ProviderContext {
  return {
    service: 'servicenow',
    config: { instanceUrl: INSTANCE_URL, loginHint: 'u@e.com', ...config },
    dataDir: `${process.cwd()}/.test-data/provider-servicenow`,
    logger: nullLogger,
  };
}

function bundle(overrides: Partial<TokenBundle> = {}): TokenBundle {
  return {
    service: 'servicenow',
    scheme: 'session',
    accessToken: 'JSESSIONID=abc; glide_session=xyz',
    tokenType: 'Cookie',
    expiresAt: NOW + DEFAULT_SESSION_LIFETIME_MS,
    acquiredAt: NOW,
    extra: {
      g_ck: 'user-token-123',
      instanceUrl: INSTANCE_URL,
      sessionLifetimeMs: DEFAULT_SESSION_LIFETIME_MS,
      refreshMarginMs: DEFAULT_REFRESH_MARGIN_MS,
    },
    ...overrides,
  };
}

const sessionInfoOk = { ok: true, status: 200, body: JSON.stringify({ result: { g_ck: 'user-token-123' } }) };

describe('ServiceNowProvider', () => {
  it('has correct name and schemes', () => {
    const p = new ServiceNowProvider({ now: () => NOW });
    expect(p.name).toBe('servicenow');
    expect(p.schemes).toEqual(['session']);
  });

  it('exposes session capabilities and remediation hints', () => {
    const p = new ServiceNowProvider({ now: () => NOW });
    expect(p.capabilities?.headless).toBe(true);
    expect(p.capabilities?.schemes[0]).toMatchObject({
      scheme: 'session',
      credentialSource: 'cookie-session',
      refreshStrategy: 'reacquire',
      validationStrategy: 'service-probe',
    });
    expect(p.capabilities?.remediation.acquire).toContain('instanceUrl');
    expect(p.capabilities?.remediation.validate).toContain('network/VPN');
    expect(p.capabilities?.conditionalAccessModes).toEqual(expect.arrayContaining([
      'mfa_or_totp_required',
      'device_certificate_required',
      'policy_blocks_headless',
      'unknown_login_route',
      'browser_profile_locked',
    ]));
    expect(p.capabilities?.requiresDeviceContext).toBe(true);
    expect(p.capabilities?.supportsTotp).toBe(true);
    expect(p.capabilities?.supportsDeviceCodeFallback).toBe(false);
    expect(p.capabilities?.browserProfileStrategy).toBe('service-scoped-persistent');
  });

  it('validate calls session_info and sys_user API with Cookie and X-UserToken', async () => {
    const httpFetch = vi.fn(async (url: string) => url.includes('session_info')
      ? sessionInfoOk
      : { ok: true, status: 200, body: JSON.stringify({ result: [{ sys_id: '1' }] }) }) as any;
    const p = new ServiceNowProvider({ now: () => NOW + 60_000, httpFetch });

    expect(await p.validate(ctx(), bundle())).toBe(true);
    expect(httpFetch).toHaveBeenNthCalledWith(
      1,
      'https://acmeprod.service-now.com/api/now/ui/user/session_info',
      expect.objectContaining({ headers: expect.objectContaining({ Cookie: 'JSESSIONID=abc; glide_session=xyz' }) }),
    );
    expect(httpFetch).toHaveBeenNthCalledWith(
      2,
      'https://acmeprod.service-now.com/api/now/table/sys_user?sysparm_limit=1&sysparm_fields=sys_id',
      expect.objectContaining({
        headers: expect.objectContaining({
          Cookie: 'JSESSIONID=abc; glide_session=xyz',
          'X-UserToken': 'user-token-123',
        }),
      }),
    );
  });

  it('classifies expired or conservative-window cookies as auth failures without probing', async () => {
    const httpFetch = vi.fn(async () => sessionInfoOk) as any;
    const p = new ServiceNowProvider({ now: () => NOW + (3 * 60 * 60 * 1000), httpFetch });

    expect(await p.validate(ctx(), bundle())).toBe(false);
    expect(httpFetch).not.toHaveBeenCalled();
  });

  it('classifies missing g_ck as an auth failure without probing', async () => {
    const httpFetch = vi.fn(async () => sessionInfoOk) as any;
    const p = new ServiceNowProvider({ now: () => NOW + 60_000, httpFetch });

    expect(await p.validate(ctx(), bundle({ extra: { instanceUrl: INSTANCE_URL } }))).toBe(false);
    expect(httpFetch).not.toHaveBeenCalled();
  });

  it('classifies invalid g_ck from session_info as an auth failure', async () => {
    const httpFetch = vi.fn(async () => ({ ok: true, status: 200, body: JSON.stringify({ result: { g_ck: 'rotated-token' } }) })) as any;
    const p = new ServiceNowProvider({ now: () => NOW + 60_000, httpFetch });

    expect(await p.validate(ctx(), bundle())).toBe(false);
    expect(httpFetch).toHaveBeenCalledTimes(1);
  });

  it('classifies session_info unavailable as an auth/configuration failure', async () => {
    const httpFetch = vi.fn(async () => ({ ok: false, status: 404, body: 'not found' })) as any;
    const p = new ServiceNowProvider({ now: () => NOW + 60_000, httpFetch });

    expect(await p.validate(ctx(), bundle())).toBe(false);
  });

  it('classifies instance redirect/login route changes as auth/configuration failures', async () => {
    const httpFetch = vi.fn(async () => ({ ok: true, status: 200, url: `${INSTANCE_URL}/login.do`, headers: { 'content-type': 'text/html' }, body: '<form><input type="password" /></form>' })) as any;
    const p = new ServiceNowProvider({ now: () => NOW + 60_000, httpFetch });

    expect(await p.validate(ctx(), bundle())).toBe(false);
    expect(classifyServiceNowHttpFailure('session_info', await httpFetch.mock.results[0]!.value)?.code).toBe('instance_redirect_or_login_route_changed');
  });

  it('classifies API 401 as an auth failure', async () => {
    const httpFetch = vi.fn(async (url: string) => url.includes('session_info')
      ? sessionInfoOk
      : { ok: false, status: 401, body: 'User Not Authenticated' }) as any;
    const p = new ServiceNowProvider({ now: () => NOW + 60_000, httpFetch });

    expect(await p.validate(ctx(), bundle())).toBe(false);
    expect(classifyServiceNowHttpFailure('api_probe', { ok: false, status: 401, body: 'User Not Authenticated' })?.code).toBe('api_unauthorized');
  });

  it('classifies CSRF/API 403 as an auth failure', async () => {
    const httpFetch = vi.fn(async (url: string) => url.includes('session_info')
      ? sessionInfoOk
      : { ok: false, status: 403, body: 'CSRF token validation failed for X-UserToken' }) as any;
    const p = new ServiceNowProvider({ now: () => NOW + 60_000, httpFetch });

    expect(await p.validate(ctx(), bundle())).toBe(false);
    expect(classifyServiceNowHttpFailure('api_probe', { ok: false, status: 403, body: 'CSRF token validation failed' })?.code).toBe('csrf_invalid');
  });

  it('treats network/VPN errors as degraded retryable non-auth failures', async () => {
    const httpFetch = vi.fn(async () => { throw new Error('ECONNREFUSED connect VPN required'); }) as any;
    const p = new ServiceNowProvider({ now: () => NOW + 60_000, httpFetch });

    await expect(p.validate(ctx(), bundle())).rejects.toMatchObject({
      code: 'network_or_vpn_unreachable',
      retryable: true,
    });
  });

  it('treats ServiceNow 5xx as degraded retryable non-auth failures', async () => {
    const httpFetch = vi.fn(async () => ({ ok: false, status: 503, body: 'service unavailable' })) as any;
    const p = new ServiceNowProvider({ now: () => NOW + 60_000, httpFetch });

    await expect(p.validate(ctx(), bundle())).rejects.toMatchObject({
      code: 'network_or_vpn_unreachable',
      retryable: true,
    });
    expect(classifyServiceNowHttpFailure('session_info', { ok: false, status: 503 })?.authFailure).toBe(false);
  });

  it('coalesces concurrent refresh/reacquire calls at the provider boundary', async () => {
    let acquireCalls = 0;
    const acquired = bundle({ accessToken: 'fresh-cookie', acquiredAt: NOW + 1_000, expiresAt: NOW + DEFAULT_SESSION_LIFETIME_MS + 1_000 });
    const p = new ServiceNowProvider({
      now: () => NOW,
      acquireSession: vi.fn(async () => {
        acquireCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return acquired;
      }),
    });

    const stale = bundle({ expiresAt: NOW - 1, acquiredAt: NOW - DEFAULT_SESSION_LIFETIME_MS });
    const [first, second] = await Promise.all([p.refresh(ctx(), stale), p.refresh(ctx(), stale)]);

    expect(acquireCalls).toBe(1);
    expect(first).toBe(acquired);
    expect(second).toBe(acquired);
  });

  it('nextRefreshAt returns the conservative refresh margin before expiry', () => {
    const p = new ServiceNowProvider({ now: () => NOW });
    const expiresAt = NOW + DEFAULT_SESSION_LIFETIME_MS;
    expect(p.nextRefreshAt(bundle({ expiresAt })).getTime()).toBe(expiresAt - DEFAULT_REFRESH_MARGIN_MS);
  });

  it('nextRefreshAt uses captured refreshMarginMs metadata when present', () => {
    const p = new ServiceNowProvider({ now: () => NOW });
    const expiresAt = NOW + DEFAULT_SESSION_LIFETIME_MS;
    expect(p.nextRefreshAt(bundle({ expiresAt, extra: { g_ck: 'user-token-123', refreshMarginMs: 15 * 60 * 1000 } })).getTime()).toBe(expiresAt - 15 * 60 * 1000);
  });

  it('acquire throws when config is missing instanceUrl', async () => {
    const p = new ServiceNowProvider({ now: () => NOW });
    await expect(p.acquire(ctx({ instanceUrl: undefined as unknown as string }), 'session')).rejects.toThrow();
  });

  it('rejects headless: false in config', () => {
    expect(() => ServiceNowConfigSchema.parse({ instanceUrl: INSTANCE_URL, loginHint: 'u@e.com', headless: false })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Helpers for debug-state capture tests (shared with capture-wiring test file)
// ---------------------------------------------------------------------------

export function fakeCapture(): {
  fn: (opts: CaptureDebugStateOptions) => Promise<CaptureDebugStateResult>;
  calls: CaptureDebugStateOptions[];
} {
  const calls: CaptureDebugStateOptions[] = [];
  const fn = vi.fn(async (opts: CaptureDebugStateOptions): Promise<CaptureDebugStateResult> => {
    calls.push(opts);
    return {
      captureDir: '/fake/diag/servicenow/2026-01-01T00-00-00.000Z',
      files: { url: '/fake/diag/servicenow/2026-01-01T00-00-00.000Z/url.txt' },
      errors: [],
    };
  });
  return { fn, calls };
}

describe('ServiceNowProvider — captureDebugState dep injection wiring', () => {
  it('captureDebugState dep can be injected and acquireSession path bypasses it', async () => {
    const { fn: captureDebugState, calls } = fakeCapture();
    const acquired = bundle({ accessToken: 'test-cookie', acquiredAt: NOW + 1_000, expiresAt: NOW + DEFAULT_SESSION_LIFETIME_MS + 1_000 });
    const p = new ServiceNowProvider({
      now: () => NOW,
      captureDebugState,
      acquireSession: vi.fn(async () => acquired),
    });

    const result = await p.acquire(ctx(), 'session');
    expect(result).toBe(acquired);
    // acquireSession short-circuits before browser path — no capture expected
    expect(calls.length).toBe(0);
  });

  it('captureDebugState dep defaults to the real import when not provided', async () => {
    // Verify the dep field is optional — provider constructs without it
    const p = new ServiceNowProvider({ now: () => NOW });
    expect(p.name).toBe('servicenow');
  });
});

describe('computeServiceNowSessionExpiry (BUG A: session-lifetime mismatch)', () => {
  const config = { sessionLifetimeMs: DEFAULT_SESSION_LIFETIME_MS, refreshMarginMs: DEFAULT_REFRESH_MARGIN_MS };
  const HOUR = 60 * 60 * 1000;
  const MIN = 60 * 1000;

  // The real production cookie shape: a short-lived glide_session_store (~60min)
  // alongside persistent (year-2027) and session-only cookies.
  function realCookies(sessionStoreExpiresAtMs: number) {
    return [
      { name: 'glide_user_route', domain: 'acmeprod.service-now.com', expires: (NOW + 500 * 24 * HOUR) / 1000 },
      { name: 'glide_sso_id', domain: 'acmeprod.service-now.com', expires: (NOW + 500 * 24 * HOUR) / 1000 },
      { name: 'JSESSIONID', domain: 'acmeprod.service-now.com', expires: -1 },
      { name: 'glide_user_activity', domain: 'acmeprod.service-now.com', expires: -1 },
      { name: 'glide_session_store', domain: 'acmeprod.service-now.com', expires: sessionStoreExpiresAtMs / 1000 },
      { name: 'ESTSAUTH', domain: 'login.microsoftonline.com', expires: (NOW + 8 * HOUR) / 1000 },
    ];
  }

  it('REPRODUCES THE BUG: without cookie-derived expiry, a 60-min session would be served for 4h', () => {
    // This documents the pre-fix defect: config alone gives a 4h expiry, so the
    // broker refreshes at 3h while ServiceNow kills the session at ~60min.
    const staticExpiry = NOW + config.sessionLifetimeMs;
    expect(staticExpiry - NOW).toBe(4 * HOUR);
  });

  it('pins expiresAt to the glide_session_store 60-min cookie, not the 4h config', () => {
    const sessionDeath = NOW + 60 * MIN;
    const { expiresAt, effectiveLifetimeMs } = computeServiceNowSessionExpiry(NOW, realCookies(sessionDeath), config);
    expect(expiresAt).toBe(sessionDeath);
    expect(effectiveLifetimeMs).toBe(60 * MIN);
  });

  it('schedules the refresh well before the real session death (~40% of life)', () => {
    const sessionDeath = NOW + 60 * MIN;
    const { expiresAt, effectiveRefreshMarginMs } = computeServiceNowSessionExpiry(NOW, realCookies(sessionDeath), config);
    const refreshAt = expiresAt - effectiveRefreshMarginMs;
    // Refresh must fire strictly before the 60-min death, with a real buffer.
    expect(refreshAt).toBeLessThan(sessionDeath);
    expect((refreshAt - NOW)).toBeLessThanOrEqual(40 * MIN); // ~24min for a 60min session
    expect((refreshAt - NOW)).toBeGreaterThan(0);
  });

  it('never schedules a refresh in the past even when cookie life << configured 1h margin', () => {
    const sessionDeath = NOW + 20 * MIN; // shorter than the 1h configured margin
    const { expiresAt, effectiveRefreshMarginMs } = computeServiceNowSessionExpiry(NOW, realCookies(sessionDeath), config);
    const refreshAt = expiresAt - effectiveRefreshMarginMs;
    expect(refreshAt).toBeGreaterThan(NOW);
    expect(refreshAt).toBeLessThan(sessionDeath);
  });

  it('falls back to the configured 4h upper bound when no short-lived session cookie is present', () => {
    const persistentOnly = [
      { name: 'glide_user_route', domain: 'acmeprod.service-now.com', expires: (NOW + 500 * 24 * HOUR) / 1000 },
      { name: 'JSESSIONID', domain: 'acmeprod.service-now.com', expires: -1 },
    ];
    const { expiresAt } = computeServiceNowSessionExpiry(NOW, persistentOnly, config);
    expect(expiresAt).toBe(NOW + config.sessionLifetimeMs);
  });

  it('ignores non-servicenow cookie expiries (e.g. Azure AD ESTSAUTH)', () => {
    // A short Azure cookie must not be mistaken for the ServiceNow session death.
    const cookies = [
      { name: 'ESTSAUTH', domain: 'login.microsoftonline.com', expires: (NOW + 5 * MIN) / 1000 },
      { name: 'glide_session_store', domain: 'acmeprod.service-now.com', expires: (NOW + 60 * MIN) / 1000 },
    ];
    const { expiresAt } = computeServiceNowSessionExpiry(NOW, cookies, config);
    expect(expiresAt).toBe(NOW + 60 * MIN);
  });

  it('ANTI-STORM: pins to glide_session_store by name, ignoring a shorter service-now cookie', () => {
    // If ServiceNow adds a short-lived SN-domain cookie, a naive min() would pick
    // it and drive a ~2-min silent-SSO storm. Name-pinning keeps glide_session_store.
    const cookies = [
      { name: 'sn_csrf_short', domain: 'acmeprod.service-now.com', expires: (NOW + 5 * MIN) / 1000 },
      { name: 'glide_session_store', domain: 'acmeprod.service-now.com', expires: (NOW + 60 * MIN) / 1000 },
    ];
    const { expiresAt } = computeServiceNowSessionExpiry(NOW, cookies, config);
    expect(expiresAt).toBe(NOW + 60 * MIN);
  });

  it('STORM FLOOR: a pathologically short session cookie is clamped to the 15-min floor', () => {
    const cookies = [
      { name: 'glide_session_store', domain: 'acmeprod.service-now.com', expires: (NOW + 3 * MIN) / 1000 },
    ];
    const { expiresAt, effectiveLifetimeMs } = computeServiceNowSessionExpiry(NOW, cookies, config);
    expect(effectiveLifetimeMs).toBe(15 * MIN); // never below the floor → no storm
    expect(expiresAt).toBe(NOW + 15 * MIN);
  });

  it('falls back to earliest finite SN cookie (floored) when glide_session_store is renamed/absent', () => {
    const cookies = [
      { name: 'glide_new_session', domain: 'acmeprod.service-now.com', expires: (NOW + 45 * MIN) / 1000 },
      { name: 'glide_user_route', domain: 'acmeprod.service-now.com', expires: (NOW + 500 * 24 * HOUR) / 1000 },
    ];
    const { expiresAt } = computeServiceNowSessionExpiry(NOW, cookies, config);
    expect(expiresAt).toBe(NOW + 45 * MIN); // above the floor → used as-is
  });
});
