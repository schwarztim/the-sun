/**
 * Multi-PROCESS master-key race test.
 *
 * The in-process test (`master-key.test.ts`) proves the interleaving of two
 * concurrent async resolves; this one proves the real-world catastrophe the fix
 * targets: several independent OS processes cold-starting at once (a daemon +
 * CLI launched together) must never mint DIVERGENT keys where one is clobbered.
 *
 * Each child cold-starts `resolveMasterKey` (no env, no keychain) against a
 * shared fresh temp dir and prints the resolved key. Every child must return the
 * exact key that survives on disk — the cross-process arbiter invariant.
 *
 * The package is compiled once (beforeAll) so the children import the CURRENT
 * source via the built `dist/`, not a stale artifact.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const packageDir = fileURLToPath(new URL('..', import.meta.url)); // packages/vault
const distMasterKey = path.join(packageDir, 'dist', 'master-key.js');

// A tiny ESM worker: cold-start resolveMasterKey against argv[2] and print the key.
const WORKER_SRC = `
import { resolveMasterKey } from ${JSON.stringify(distMasterKey)};
const key = await resolveMasterKey({ hermesDir: process.argv[2], keychain: null });
process.stdout.write(key.toString('base64'));
`;

let workerPath: string;

beforeAll(() => {
  // Build the package so the children exercise the current source, not a stale dist.
  const tscBin = require.resolve('typescript/bin/tsc');
  execFileSync(process.execPath, [tscBin, '-p', path.join(packageDir, 'tsconfig.json')], { stdio: 'ignore' });
  const workerDir = mkdtempSync(path.join(tmpdir(), 'hermes-mkworker-'));
  workerPath = path.join(workerDir, 'worker.mjs');
  writeFileSync(workerPath, WORKER_SRC);
}, 120_000);

function spawnResolve(dir: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`worker exit ${code}: ${err}`))));
  });
}

describe('resolveMasterKey — multi-process cold start (no divergent keys)', () => {
  it('N separate processes converge on ONE key equal to the persisted master.key', async () => {
    const TRIALS = 6;
    const PROCS = 4;
    for (let t = 0; t < TRIALS; t++) {
      const dir = mkdtempSync(path.join(tmpdir(), 'hermes-mkmp-'));
      const results = await Promise.all(Array.from({ length: PROCS }, () => spawnResolve(dir)));
      const onDisk = readFileSync(path.join(dir, 'master.key')).toString('base64');
      for (const r of results) {
        expect(r).toBe(onDisk); // every process returned the key that survived on disk
        expect(r).toBe(results[0]); // ...and they all agree with each other
      }
    }
  }, 120_000);
});
