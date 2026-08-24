import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { acquireLock } from './lock.js';

function tempLockPath(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), 'hermes-lock-')), 'vault.enc.lock');
}

describe('acquireLock', () => {
  it('acquires, then a re-acquire succeeds after release', async () => {
    const lockPath = tempLockPath();
    const release1 = await acquireLock(lockPath);
    expect(existsSync(lockPath)).toBe(true);
    await release1();
    expect(existsSync(lockPath)).toBe(false);
    const release2 = await acquireLock(lockPath);
    await release2();
  });

  it('release is idempotent', async () => {
    const lockPath = tempLockPath();
    const release = await acquireLock(lockPath);
    await release();
    await expect(release()).resolves.toBeUndefined(); // second call is a no-op
  });

  it('times out while another holder is active and not stale', async () => {
    const lockPath = tempLockPath();
    const release = await acquireLock(lockPath);
    try {
      await expect(
        acquireLock(lockPath, { timeoutMs: 150, staleMs: 60_000 }),
      ).rejects.toThrow(/timed out acquiring vault lock/);
    } finally {
      await release();
    }
  });

  it('takes over a stale lock (holder timestamp older than staleMs)', async () => {
    const lockPath = tempLockPath();
    writeFileSync(lockPath, `999999 ${Date.now() - 60_000}\n`); // 60s-old holder
    const release = await acquireLock(lockPath, { staleMs: 10_000, timeoutMs: 2_000 });
    expect(existsSync(lockPath)).toBe(true);
    await release();
  });

  it('serializes two acquirers: the second proceeds only after the first releases', async () => {
    const lockPath = tempLockPath();
    const order: string[] = [];
    const r1 = await acquireLock(lockPath);
    order.push('first-acquired');
    const second = acquireLock(lockPath, { timeoutMs: 5_000 }).then(async (release) => {
      order.push('second-acquired');
      await release();
    });
    // Give the second acquirer time to spin on the lock, then release the first.
    await new Promise((r) => setTimeout(r, 50));
    order.push('first-releasing');
    await r1();
    await second;
    expect(order).toEqual(['first-acquired', 'first-releasing', 'second-acquired']);
  });
});

describe('acquireLock — concurrent stale takeover (mutual exclusion preserved)', () => {
  it('never lets two acquirers hold a pre-seeded stale lock simultaneously', async () => {
    // Mirrors /tmp/lock-race-repro.mjs: a blind read→decide→unlink lets two waiters
    // both delete+recreate the lock → two simultaneous holders. The atomic steal must not.
    const TRIALS = 60;
    const ACQUIRERS = 4;
    let doubleHeld = 0;
    for (let t = 0; t < TRIALS; t++) {
      const lockPath = tempLockPath();
      writeFileSync(lockPath, `99999 ${Date.now() - 100_000}\n`); // stale (crashed) holder
      let concurrent = 0;
      let maxConcurrent = 0;
      await Promise.all(
        Array.from({ length: ACQUIRERS }, async () => {
          const release = await acquireLock(lockPath, { staleMs: 10, timeoutMs: 3_000 });
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await new Promise((r) => setTimeout(r, 5)); // hold briefly to overlap any racer
          concurrent--;
          await release();
        }),
      );
      if (maxConcurrent > 1) doubleHeld++;
    }
    expect(doubleHeld).toBe(0);
  }, 30_000);

  it('serializes a critical section under stale-lock contention (no lost increments)', async () => {
    const lockPath = tempLockPath();
    writeFileSync(lockPath, `99999 ${Date.now() - 100_000}\n`);
    const shared = { n: 0 };
    const WORKERS = 8;
    await Promise.all(
      Array.from({ length: WORKERS }, async () => {
        const release = await acquireLock(lockPath, { staleMs: 10, timeoutMs: 8_000 });
        const seen = shared.n; // read-modify-write must be exclusive
        await new Promise((r) => setTimeout(r, 2));
        shared.n = seen + 1;
        await release();
      }),
    );
    expect(shared.n).toBe(WORKERS); // every increment survived → true mutual exclusion
  }, 30_000);
});

describe('acquireLock — corrupt lock timestamp (treated as stale, not fresh)', () => {
  it('takes over a lock whose timestamp is unparseable instead of wedging forever', async () => {
    const lockPath = tempLockPath();
    writeFileSync(lockPath, `99999 not-a-timestamp\n`); // e.g. a truncated/garbled write
    const release = await acquireLock(lockPath, { staleMs: 10_000, timeoutMs: 2_000 });
    expect(existsSync(lockPath)).toBe(true);
    await release();
  });

  it('takes over a lock with a missing timestamp field', async () => {
    const lockPath = tempLockPath();
    writeFileSync(lockPath, `99999\n`); // no second (timestamp) field at all
    const release = await acquireLock(lockPath, { staleMs: 10_000, timeoutMs: 2_000 });
    await release();
    expect(existsSync(lockPath)).toBe(false);
  });
});
