import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  withManagedBrowser,
  forceCloseBrowser,
  raceDeadline,
  browserRegistry,
  BrowserAuthTimeoutError,
  resetManagedBrowserStateForTests,
  type ManagedBrowserLike,
  type BrowserRunFileEntry,
} from '../src/managed-browser.js';

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

interface FakeBrowserHandle {
  browser: ManagedBrowserLike;
  close: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
}

function fakeBrowser(opts: { pid?: number; closeBehavior?: 'resolve' | 'hang' } = {}): FakeBrowserHandle {
  const kill = vi.fn(() => true);
  const close = vi.fn(() =>
    opts.closeBehavior === 'hang' ? new Promise<void>(() => { /* wedged */ }) : Promise.resolve());
  const pid = opts.pid ?? 4242;
  return {
    browser: {
      close: close as unknown as () => Promise<void>,
      process: () => ({ pid, kill: kill as unknown as (signal?: NodeJS.Signals | number) => boolean }),
      contexts: () => [],
    },
    close,
    kill,
  };
}

/**
 * Fake timers don't yield to real I/O: fs promises stay pending during
 * `advanceTimersByTimeAsync`. Tests that mix fake timers with the run-file's
 * real fs writes keep `setImmediate` unfaked and flush macrotasks explicitly.
 */
const FAKE_TIMER_CONFIG: Parameters<typeof vi.useFakeTimers>[0] = {
  toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
};

const flushIo = () => new Promise<void>((resolve) => setImmediate(resolve));
async function settleIo(turns = 40): Promise<void> {
  for (let i = 0; i < turns; i++) {
    // A real fs round trip blocks the poll phase long enough for the code
    // under test's own pending fs work to land on each turn.
    await fs.stat(os.tmpdir()).catch(() => {});
    await flushIo();
  }
}

async function readRunFile(dir: string): Promise<BrowserRunFileEntry[]> {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, 'browsers.json'), 'utf8')) as BrowserRunFileEntry[];
  } catch {
    return [];
  }
}

let runDir: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ['HERMES_RUN_DIR', 'HERMES_MAX_CONCURRENT_BROWSERS', 'HERMES_ORPHAN_REAP', 'HERMES_BROWSER_MAX_LIFETIME_MS'];

beforeEach(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-mb-'));
  process.env['HERMES_RUN_DIR'] = runDir;
  delete process.env['HERMES_MAX_CONCURRENT_BROWSERS'];
  delete process.env['HERMES_ORPHAN_REAP'];
  delete process.env['HERMES_BROWSER_MAX_LIFETIME_MS'];
  resetManagedBrowserStateForTests();
});

afterEach(async () => {
  vi.useRealTimers();
  resetManagedBrowserStateForTests();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
});

// ---------------------------------------------------------------------------
// Lifetime timeout → close → SIGKILL escalation
// ---------------------------------------------------------------------------

describe('withManagedBrowser lifetime ceiling', () => {
  it('force-closes a hung auth fn and escalates a wedged close() to SIGKILL', async () => {
    vi.useFakeTimers(FAKE_TIMER_CONFIG);
    const { browser, close, kill } = fakeBrowser({ closeBehavior: 'hang' });

    const outcome = withManagedBrowser<never, ManagedBrowserLike>({
      service: 'hung-svc',
      engine: 'chromium',
      maxLifetimeMs: 1_000,
      launch: async () => browser,
    }, () => new Promise<never>(() => { /* auth poll loop hangs forever */ }))
      .then(() => 'resolved' as const, (err: unknown) => err);

    await settleIo();                              // launch + register + run-file write
    await vi.advanceTimersByTimeAsync(1_000);      // lifetime ceiling fires
    await settleIo();
    await vi.advanceTimersByTimeAsync(5_000);      // close grace expires → SIGKILL (timeout path)
    await settleIo();                              // run-file prune in finally
    await vi.advanceTimersByTimeAsync(5_000);      // close grace expires (finally path)
    await settleIo();

    const err = await outcome;
    expect(err).toBeInstanceOf(BrowserAuthTimeoutError);
    const timeoutErr = err as BrowserAuthTimeoutError;
    expect(timeoutErr.phase).toBe('auth');
    expect(timeoutErr.retryable).toBe(true);
    expect(timeoutErr.service).toBe('hung-svc');
    expect(timeoutErr.limitMs).toBe(1_000);
    expect(close).toHaveBeenCalled();
    expect(kill).toHaveBeenCalledWith('SIGKILL');
    // registry must not retain the dead browser
    expect(browserRegistry.list()).toHaveLength(0);
  });

  it('returns fn result and closes the browser on the happy path', async () => {
    const { browser, close, kill } = fakeBrowser();
    const result = await withManagedBrowser<string, ManagedBrowserLike>({
      service: 'ok-svc',
      engine: 'firefox',
      maxLifetimeMs: 5_000,
      launch: async () => browser,
    }, async () => 'token');
    expect(result).toBe('token');
    expect(close).toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
    expect(browserRegistry.list()).toHaveLength(0);
  });

  it('does not close persistent browsers when fn returns', async () => {
    const { browser, close } = fakeBrowser();
    await withManagedBrowser<string, ManagedBrowserLike>({
      service: 'persistent-svc',
      engine: 'firefox',
      maxLifetimeMs: 5_000,
      persistent: true,
      launch: async () => browser,
    }, async () => 'ok');
    expect(close).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Concurrency cap + queue timeout
// ---------------------------------------------------------------------------

describe('withManagedBrowser concurrency cap', () => {
  it('queues beyond the cap and rejects with phase=queue after the bounded wait', async () => {
    vi.useFakeTimers(FAKE_TIMER_CONFIG);
    process.env['HERMES_MAX_CONCURRENT_BROWSERS'] = '1';

    const first = fakeBrowser({ pid: 111 });
    let releaseFirst!: () => void;
    const firstRun = withManagedBrowser<void, ManagedBrowserLike>({
      service: 'slot-holder',
      engine: 'chromium',
      maxLifetimeMs: 600_000,
      launch: async () => first.browser,
    }, () => new Promise<void>((resolve) => { releaseFirst = resolve; }));

    // let the first launch + registration settle so it owns the only slot
    await settleIo();
    expect(releaseFirst).toBeTypeOf('function');

    const second = fakeBrowser({ pid: 222 });
    const secondLaunch = vi.fn(async () => second.browser);
    const secondOutcome = withManagedBrowser<string, ManagedBrowserLike>({
      service: 'queued-svc',
      engine: 'chromium',
      maxLifetimeMs: 600_000,
      launch: secondLaunch,
    }, async () => 'never').then((v) => v, (err: unknown) => err);

    await settleIo();
    await vi.advanceTimersByTimeAsync(120_000);
    const err = await secondOutcome;
    expect(err).toBeInstanceOf(BrowserAuthTimeoutError);
    expect((err as BrowserAuthTimeoutError).phase).toBe('queue');
    expect((err as BrowserAuthTimeoutError).limitMs).toBe(120_000);
    expect(secondLaunch).not.toHaveBeenCalled(); // never got a slot, never launched

    releaseFirst();
    await settleIo();
    await firstRun;
    expect(first.close).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Profile lock cleanup
// ---------------------------------------------------------------------------

describe('withManagedBrowser profile lock cleanup', () => {
  it('clears stale firefox profile lock files before launch', async () => {
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-profile-'));
    for (const name of ['lock', '.parentlock', 'parent.lock']) {
      await fs.writeFile(path.join(profileDir, name), 'stale');
    }
    const { browser } = fakeBrowser();
    await withManagedBrowser<string, ManagedBrowserLike>({
      service: 'lock-svc',
      engine: 'firefox',
      profileDir,
      maxLifetimeMs: 5_000,
      launch: async () => browser,
    }, async () => 'ok');
    for (const name of ['lock', '.parentlock', 'parent.lock']) {
      await expect(fs.access(path.join(profileDir, name))).rejects.toThrow();
    }
    await fs.rm(profileDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Registry: killAll / reapOlderThan
// ---------------------------------------------------------------------------

describe('browserRegistry', () => {
  it('killAll closes every registered browser including persistent ones', async () => {
    const a = fakeBrowser({ pid: 11 });
    const b = fakeBrowser({ pid: 22 });
    browserRegistry.register(a.browser, { service: 'a', persistent: false, pid: 11 });
    browserRegistry.register(b.browser, { service: 'b', persistent: true, pid: 22 });
    const killedCount = await browserRegistry.killAll();
    expect(killedCount).toBe(2);
    expect(a.close).toHaveBeenCalled();
    expect(b.close).toHaveBeenCalled();
    expect(browserRegistry.list()).toHaveLength(0);
  });

  it('reapOlderThan closes only stale non-persistent browsers', async () => {
    vi.useFakeTimers(FAKE_TIMER_CONFIG);
    const stale = fakeBrowser({ pid: 33 });
    const persistent = fakeBrowser({ pid: 44 });
    browserRegistry.register(stale.browser, { service: 'stale', persistent: false, pid: 33 });
    browserRegistry.register(persistent.browser, { service: 'keep', persistent: true, pid: 44 });

    await vi.advanceTimersByTimeAsync(700_000); // age both entries past the cutoff
    const fresh = fakeBrowser({ pid: 55 });
    browserRegistry.register(fresh.browser, { service: 'fresh', persistent: false, pid: 55 });

    const reaped = await browserRegistry.reapOlderThan(600_000);
    expect(reaped).toBe(1);
    expect(stale.close).toHaveBeenCalled();
    expect(persistent.close).not.toHaveBeenCalled(); // persistent skipped
    expect(fresh.close).not.toHaveBeenCalled(); // too young
    expect(browserRegistry.list().map((e) => e.service).sort()).toEqual(['fresh', 'keep']);
  });

  it('register returns an idempotent unregister handle', () => {
    const { browser } = fakeBrowser();
    const unregister = browserRegistry.register(browser, { service: 'x' });
    expect(browserRegistry.list()).toHaveLength(1);
    unregister();
    unregister();
    expect(browserRegistry.list()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Run-file round-trip
// ---------------------------------------------------------------------------

describe('run-file', () => {
  it('records the browser during fn and prunes the entry on completion', async () => {
    const { browser } = fakeBrowser({ pid: 31337 });
    let during: BrowserRunFileEntry[] = [];
    await withManagedBrowser<void, ManagedBrowserLike>({
      service: 'runfile-svc',
      engine: 'chromium',
      maxLifetimeMs: 5_000,
      launch: async () => browser,
    }, async () => {
      during = await readRunFile(runDir);
    });
    expect(during).toHaveLength(1);
    expect(during[0]).toMatchObject({ pid: 31337, service: 'runfile-svc', brokerPid: process.pid });
    expect(typeof during[0]?.startedAt).toBe('number');

    const after = await readRunFile(runDir);
    expect(after.filter((e) => e.pid === 31337)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// reapPriorIncarnations
// ---------------------------------------------------------------------------

describe('browserRegistry.reapPriorIncarnations', () => {
  const DEAD_BROKER = 909_001;
  const LIVE_BROKER = 909_002;

  async function writeFixture(): Promise<void> {
    const entries: BrowserRunFileEntry[] = [
      { pid: 101, service: 'a', startedAt: 1, brokerPid: DEAD_BROKER }, // dead broker, pid alive, playwright cmd → kill + drop
      { pid: 102, service: 'b', startedAt: 1, brokerPid: DEAD_BROKER }, // dead broker, pid alive, foreign cmd → skip kill, drop
      { pid: 103, service: 'c', startedAt: 1, brokerPid: LIVE_BROKER }, // live broker → keep
      { pid: 104, service: 'd', startedAt: 1, brokerPid: DEAD_BROKER }, // dead broker, pid dead → drop
    ];
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(path.join(runDir, 'browsers.json'), JSON.stringify(entries), 'utf8');
  }

  const seams = () => ({
    procAlive: (pid: number) => [101, 102, LIVE_BROKER].includes(pid),
    procCommand: (pid: number) =>
      pid === 101 ? '/Users/x/Library/Caches/ms-playwright/firefox-1234/firefox' : '/usr/bin/unrelated-daemon',
    killPid: vi.fn<(pid: number, signal: NodeJS.Signals) => void>(),
  });

  it('kills playwright orphans of dead brokers, guards PID reuse, keeps live-broker entries', async () => {
    await writeFixture();
    const s = seams();
    const killed = await browserRegistry.reapPriorIncarnations(s);
    expect(killed).toBe(1);
    expect(s.killPid).toHaveBeenCalledTimes(1);
    expect(s.killPid).toHaveBeenCalledWith(101, 'SIGKILL');

    const remaining = await readRunFile(runDir);
    expect(remaining.map((e) => e.pid)).toEqual([103]); // only the live broker's entry survives
  });

  it('is skipped entirely when HERMES_ORPHAN_REAP=0', async () => {
    await writeFixture();
    process.env['HERMES_ORPHAN_REAP'] = '0';
    const s = seams();
    const killed = await browserRegistry.reapPriorIncarnations(s);
    expect(killed).toBe(0);
    expect(s.killPid).not.toHaveBeenCalled();
    const remaining = await readRunFile(runDir);
    expect(remaining).toHaveLength(4); // untouched
  });

  it('returns 0 when the run-file is absent', async () => {
    const s = seams();
    await expect(browserRegistry.reapPriorIncarnations(s)).resolves.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// raceDeadline / forceCloseBrowser primitives
// ---------------------------------------------------------------------------

describe('raceDeadline', () => {
  it('passes through a promise that settles before the deadline', async () => {
    await expect(raceDeadline(Promise.resolve(42), Date.now() + 1_000, 'fast')).resolves.toBe(42);
  });

  it('rejects with a labeled error when the deadline passes', async () => {
    await expect(raceDeadline(new Promise(() => { /* hang */ }), Date.now() + 50, 'hung-classify'))
      .rejects.toThrow(/deadline exceeded during hung-classify/);
  });

  it('rejects immediately when the deadline is already past', async () => {
    await expect(raceDeadline(new Promise(() => { /* hang */ }), Date.now() - 1, 'already-late'))
      .rejects.toThrow(/deadline exceeded before already-late/);
  });
});

describe('forceCloseBrowser', () => {
  it('does not SIGKILL when close resolves within the grace window', async () => {
    const { browser, kill } = fakeBrowser();
    await forceCloseBrowser(browser, 1_000);
    expect(kill).not.toHaveBeenCalled();
  });

  it('SIGKILLs via the provided pid when the browser exposes no process()', async () => {
    vi.useFakeTimers();
    const killPid = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const browser: ManagedBrowserLike = { close: () => new Promise<void>(() => { /* wedged */ }) };
    const closing = forceCloseBrowser(browser, 1_000, 777_777);
    await vi.advanceTimersByTimeAsync(1_000);
    await closing;
    expect(killPid).toHaveBeenCalledWith(777_777, 'SIGKILL');
    killPid.mockRestore();
  });
});
