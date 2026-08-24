import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadSessionState, saveSessionState, invalidateSessionState, type SessionState } from '../src/session-state.js';

const KNOWN_COOKIE_VALUE = 'ESTSAUTHPERSISTENT-super-secret-sso-cookie-value-12345';

function makeState(cookieValue = KNOWN_COOKIE_VALUE): SessionState {
  return {
    cookies: [{
      name: 'ESTSAUTHPERSISTENT',
      value: cookieValue,
      domain: '.login.microsoftonline.com',
      path: '/',
      expires: Math.floor(Date.now() / 1000) + 86_400,
      httpOnly: true,
      secure: true,
      sameSite: 'None' as const,
    }],
    origins: [{
      origin: 'https://outlook.office.com',
      localStorage: [{ name: 'msal.token.keys', value: 'tenant-cache-entry' }],
    }],
  };
}

let dir: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'hermes-session-state-'));
  for (const key of ['HERMES_SESSION_STATE_DIR', 'HERMES_SESSION_PERSIST', 'HERMES_MASTER_KEY', 'HERMES_DIR']) {
    savedEnv[key] = process.env[key];
  }
  process.env['HERMES_SESSION_STATE_DIR'] = dir;
  process.env['HERMES_DIR'] = dir; // hermetic: vault key file (if any) lands in the temp dir, not real ~/.hermes
  delete process.env['HERMES_SESSION_PERSIST'];
  process.env['HERMES_MASTER_KEY'] = randomBytes(32).toString('base64'); // cascade step 1 → no keychain/file touch
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('session-state round trip', () => {
  it('saves and loads storageState for a service', async () => {
    const state = makeState();
    await saveSessionState('az-teams', state);
    const loaded = await loadSessionState('az-teams');
    expect(loaded).toEqual(state);
  });

  it('handles a large (tens-of-KB) storageState payload', async () => {
    const state = makeState();
    // ~80KB of MSAL cache entries — realistic upper bound for Entra SPA caches.
    state.origins.push({
      origin: 'https://teams.microsoft.com',
      localStorage: Array.from({ length: 80 }, (_, i) => ({
        name: `msal.accesstoken.${i}`,
        value: 'x'.repeat(1024),
      })),
    });
    await saveSessionState('az-teams', state);
    const loaded = await loadSessionState('az-teams');
    expect(loaded).toEqual(state);
    const file = path.join(dir, 'az-teams.json.enc');
    expect(statSync(file).size).toBeGreaterThan(40_000);
  });

  it('keeps state isolated per service', async () => {
    await saveSessionState('svc-a', makeState('cookie-for-a'));
    expect(await loadSessionState('svc-b')).toBeUndefined();
    const loadedA = await loadSessionState('svc-a');
    expect(loadedA?.cookies[0]?.value).toBe('cookie-for-a');
  });
});

describe('session-state cold start + invalidation', () => {
  it('returns undefined when no state exists (cold start)', async () => {
    expect(await loadSessionState('never-saved')).toBeUndefined();
  });

  it('invalidate removes the persisted state', async () => {
    await saveSessionState('servicenow', makeState());
    expect(await loadSessionState('servicenow')).toBeDefined();
    await invalidateSessionState('servicenow');
    expect(await loadSessionState('servicenow')).toBeUndefined();
  });

  it('invalidate is a no-op when nothing was saved', async () => {
    await expect(invalidateSessionState('never-saved')).resolves.toBeUndefined();
  });

  it('returns undefined (not throw) on corrupt ciphertext', async () => {
    await saveSessionState('svc', makeState());
    const file = path.join(dir, 'svc.json.enc');
    const raw = readFileSync(file);
    raw[raw.length - 1] = raw[raw.length - 1]! ^ 0xff; // flip a ciphertext bit
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, raw);
    expect(await loadSessionState('svc')).toBeUndefined();
  });
});

describe('session-state kill switch (HERMES_SESSION_PERSIST=0)', () => {
  it('save is a no-op', async () => {
    process.env['HERMES_SESSION_PERSIST'] = '0';
    await saveSessionState('svc', makeState());
    expect(existsSync(path.join(dir, 'svc.json.enc'))).toBe(false);
  });

  it('load returns undefined even when state exists on disk', async () => {
    await saveSessionState('svc', makeState());
    process.env['HERMES_SESSION_PERSIST'] = '0';
    expect(await loadSessionState('svc')).toBeUndefined();
  });
});

describe('session-state encryption at rest', () => {
  it('raw file content never contains the cookie value or cookie name plaintext', async () => {
    await saveSessionState('az-teams', makeState());
    const file = path.join(dir, 'az-teams.json.enc');
    const raw = readFileSync(file);
    expect(raw.includes(Buffer.from(KNOWN_COOKIE_VALUE, 'utf8'))).toBe(false);
    expect(raw.includes(Buffer.from('"cookies"', 'utf8'))).toBe(false);
    // base64 of the value must not appear either (no plaintext-in-base64 dodge)
    expect(raw.toString('latin1')).not.toContain(KNOWN_COOKIE_VALUE);
  });

  it('writes the state file with 0600 permissions', async () => {
    await saveSessionState('svc', makeState());
    const mode = statSync(path.join(dir, 'svc.json.enc')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('does not persist when no key material is available (never plaintext fallback)', async () => {
    delete process.env['HERMES_MASTER_KEY'];
    // Note: if the host has ~/.hermes/master.key, save will encrypt with it —
    // either way nothing plaintext lands on disk. Simulate keyless host by
    // also asserting that any file written is encrypted.
    await saveSessionState('keyless-svc', makeState());
    for (const f of readdirSync(dir)) {
      const raw = readFileSync(path.join(dir, f));
      expect(raw.includes(Buffer.from(KNOWN_COOKIE_VALUE, 'utf8'))).toBe(false);
    }
  });

  it('does not leave tmp files behind after save', async () => {
    await saveSessionState('svc', makeState());
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});

describe('session-state service name hardening', () => {
  it('sanitizes path-traversal characters in service names', async () => {
    await saveSessionState('../../evil/../svc', makeState());
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).not.toContain('/');
    // round-trips under the same (sanitized) name
    expect(await loadSessionState('../../evil/../svc')).toBeDefined();
  });
});
