import { describe, it, expect } from 'vitest';
import { AzTeamsConfigSchema, normalizeAzTeamsScheme } from '../src/config.js';

describe('AzTeamsConfig', () => {
  it('rejects headless: false in config', () => {
    expect(() => AzTeamsConfigSchema.parse({ loginHint: 'u@e.com', headless: false })).toThrow();
  });

  it('normalizes teams alias to teams-bearer', () => {
    expect(normalizeAzTeamsScheme('teams')).toBe('teams-bearer');
    expect(normalizeAzTeamsScheme('teams-bearer')).toBe('teams-bearer');
    expect(normalizeAzTeamsScheme('graph')).toBe('graph');
    expect(normalizeAzTeamsScheme('skype')).toBe('skype');
    expect(normalizeAzTeamsScheme('files')).toBe('files');
  });

  it('rejects unsupported az-teams schemes', () => {
    expect(() => normalizeAzTeamsScheme('calendar')).toThrow(/unsupported az-teams scheme/);
  });
});
