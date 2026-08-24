import { describe, it, expect } from 'vitest';
import { KeyedMutex } from '../src/mutex.js';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('KeyedMutex', () => {
  it('serializes concurrent runs for the same key', async () => {
    const m = new KeyedMutex();
    const events: string[] = [];
    const job = (id: string) => async () => {
      events.push(`start:${id}`);
      await tick(20);
      events.push(`end:${id}`);
      return id;
    };
    const results = await Promise.all([
      m.run('k', job('a')),
      m.run('k', job('b')),
      m.run('k', job('c')),
    ]);
    expect(results).toEqual(['a', 'b', 'c']);
    expect(events).toEqual([
      'start:a', 'end:a',
      'start:b', 'end:b',
      'start:c', 'end:c',
    ]);
  });

  it('runs different keys in parallel', async () => {
    const m = new KeyedMutex();
    const events: string[] = [];
    const job = (id: string) => async () => {
      events.push(`start:${id}`);
      await tick(20);
      events.push(`end:${id}`);
    };
    await Promise.all([m.run('a', job('a')), m.run('b', job('b'))]);
    expect(events.slice(0, 2).sort()).toEqual(['start:a', 'start:b']);
  });

  it('releases the lock when the job throws', async () => {
    const m = new KeyedMutex();
    await expect(m.run('k', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    const ok = await m.run('k', async () => 'ok');
    expect(ok).toBe('ok');
  });

  it('coalesces waiters via runDedup', async () => {
    const m = new KeyedMutex();
    let calls = 0;
    const job = async () => { calls++; await tick(30); return calls; };
    const results = await Promise.all([
      m.runDedup('k', job),
      m.runDedup('k', job),
      m.runDedup('k', job),
    ]);
    expect(calls).toBe(1);
    expect(results).toEqual([1, 1, 1]);
  });
});
