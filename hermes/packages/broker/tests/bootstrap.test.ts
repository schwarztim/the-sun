import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initDataDir, generateClientToken } from '../src/bootstrap.js';

describe('bootstrap', () => {
  it('initDataDir creates config + client token file', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hermes-boot-'));
    const result = await initDataDir(dir);
    expect(existsSync(path.join(dir, 'config.json'))).toBe(true);
    expect(existsSync(path.join(dir, 'client.token'))).toBe(true);
    expect(result.clientToken.length).toBeGreaterThanOrEqual(32);
  });
  it('initDataDir is idempotent — reuses existing client token', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hermes-boot-'));
    const first = await initDataDir(dir);
    const second = await initDataDir(dir);
    expect(second.clientToken).toBe(first.clientToken);
  });
  it('generateClientToken returns url-safe 32+ char string', () => {
    const t = generateClientToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(t.length).toBeGreaterThanOrEqual(32);
  });
});
