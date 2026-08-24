import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ThvTokenStorage } from '../src/thv-storage.js';
import type { TokenBundle } from '../src/types.js';

// Mock execFile at the child_process level
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));
vi.mock('node:util', async () => {
  const actual = await vi.importActual('node:util');
  return {
    ...actual,
    promisify: (_fn: unknown) => vi.fn(async (...args: unknown[]) => {
      const cmdArgs = args[1] as string[] | undefined;
      if (cmdArgs?.[0] === 'secret' && cmdArgs?.[1] === 'get') {
        return { stdout: JSON.stringify({ service: 'ms365', scheme: 'graph', accessToken: 'tok', tokenType: 'Bearer', expiresAt: 999, acquiredAt: 888 }) };
      }
      return { stdout: '', stderr: '' };
    }),
  };
});

const nullLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => nullLogger };

describe('ThvTokenStorage', () => {
  it('readToken parses JSON from thv secret get', async () => {
    const s = new ThvTokenStorage({ logger: nullLogger as any });
    const result = await s.readToken('MS365_GRAPH_TOKEN');
    expect(result?.accessToken).toBe('tok');
  });
});
