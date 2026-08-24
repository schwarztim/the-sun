import { describe, it, expect } from 'vitest';
import { Ms365ConfigSchema, SCHEMES } from '../src/config.js';

describe('Ms365Config', () => {
  it('parses minimal valid config', () => {
    const parsed = Ms365ConfigSchema.parse({ loginHint: 'user@example.com' });
    expect(parsed.loginHint).toBe('user@example.com');
    expect(parsed.tenant).toBe('common');
  });
  it('requires loginHint', () => {
    expect(() => Ms365ConfigSchema.parse({})).toThrow(/loginHint/);
  });
  it('exposes all ms365 schemes', () => {
    expect(SCHEMES).toContain('graph');
    expect(SCHEMES).toContain('teams');
    expect(SCHEMES).toContain('outlook');
  });

  it('rejects headless: false in config', () => {
    expect(() => Ms365ConfigSchema.parse({ loginHint: 'user@example.com', headless: false })).toThrow();
  });
});
