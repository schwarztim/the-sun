import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig, defaultConfig } from '../src/config.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'hermes-cfg-'));

describe('loadConfig', () => {
  it('returns defaults when no config file exists', async () => {
    const dir = tmp();
    const cfg = await loadConfig({ dataDir: dir });
    expect(cfg.httpPort).toBe(defaultConfig.httpPort);
    expect(cfg.logLevel).toBe(defaultConfig.logLevel);
    expect(cfg.dataDir).toBe(dir);
  });
  it('reads overrides from config.json', async () => {
    const dir = tmp();
    writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ httpPort: 12345, logLevel: 'debug' }));
    const cfg = await loadConfig({ dataDir: dir });
    expect(cfg.httpPort).toBe(12345);
    expect(cfg.logLevel).toBe('debug');
  });
  it('rejects invalid config with CONFIG_ERROR', async () => {
    const dir = tmp();
    writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ httpPort: 'nope' }));
    await expect(loadConfig({ dataDir: dir })).rejects.toThrow(/CONFIG_ERROR|httpPort/);
  });
  it('creates dataDir if missing', async () => {
    const dir = tmp();
    const nested = path.join(dir, 'nested', 'hermes');
    const cfg = await loadConfig({ dataDir: nested });
    expect(cfg.dataDir).toBe(nested);
  });
});
