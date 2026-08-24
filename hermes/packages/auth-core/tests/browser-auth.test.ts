import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { clearProfileLock, parseOAuthRedirect, PlaywrightBrowserAuth } from '../src/browser-auth.js';

describe('clearProfileLock', () => {
  it('removes lock files if present', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hermes-prof-'));
    writeFileSync(path.join(dir, 'lock'), 'x');
    expect(existsSync(path.join(dir, 'lock'))).toBe(true);
    await clearProfileLock(dir);
    expect(existsSync(path.join(dir, 'lock'))).toBe(false);
  });

  it('does not throw when lock files are missing', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hermes-prof-'));
    await expect(clearProfileLock(dir)).resolves.toBeUndefined();
  });

  it('removes .parentlock and parent.lock variants', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hermes-prof-'));
    writeFileSync(path.join(dir, '.parentlock'), 'x');
    writeFileSync(path.join(dir, 'parent.lock'), 'x');
    await clearProfileLock(dir);
    expect(existsSync(path.join(dir, '.parentlock'))).toBe(false);
    expect(existsSync(path.join(dir, 'parent.lock'))).toBe(false);
  });
});

describe('parseOAuthRedirect', () => {
  const redirectUri = 'https://login.microsoftonline.com/common/oauth2/nativeclient';

  it('captures authorization code from nativeclient query redirect', () => {
    expect(parseOAuthRedirect(`${redirectUri}?code=abc&state=expected&session_state=xyz`, redirectUri, 'expected')).toEqual({ code: 'abc' });
  });

  it('captures authorization code from hash redirect', () => {
    expect(parseOAuthRedirect(`${redirectUri}#code=abc&state=expected`, redirectUri, 'expected')).toEqual({ code: 'abc' });
  });

  it('returns null for the wrongplace warning after Azure strips query params', () => {
    expect(parseOAuthRedirect('https://login.microsoftonline.com/common/wrongplace', redirectUri, 'expected')).toBeNull();
  });

  it('rejects mismatched OAuth state', () => {
    expect(parseOAuthRedirect(`${redirectUri}?code=abc&state=other`, redirectUri, 'expected')).toEqual({ error: 'OAuth state mismatch during browser auth' });
  });
});

describe('headless enforcement', () => {
  it('rejects non-headless params in _runOAuth2AuthCode via login()', async () => {
    const auth = new PlaywrightBrowserAuth();
    await expect(auth.login({
      loginHint: 'test@test.com', tenant: 'common', clientId: 'fake',
      scheme: 'graph', headless: false, authTimeoutMs: 5000, profileDir: '/tmp/test',
      scopes: ['openid'],
    })).rejects.toThrow('HEADLESS_REQUIRED');
  });

  it('rejects non-headless params in loginAll()', async () => {
    const auth = new PlaywrightBrowserAuth();
    await expect(auth.loginAll({
      loginHint: 'test@test.com', tenant: 'common', clientId: 'fake',
      headless: false, authTimeoutMs: 5000, profileDir: '/tmp/test',
    })).rejects.toThrow('HEADLESS_REQUIRED');
  });
});
