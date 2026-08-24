/**
 * Managed browser lifecycle for headless auth flows.
 *
 * Every headless browser launched for authentication MUST go through
 * `withManagedBrowser` (or, for the persistent enterprise-proxy/EDR agent case,
 * register directly in `browserRegistry`). This guarantees:
 *
 *  - a global concurrency cap (HERMES_MAX_CONCURRENT_BROWSERS, default 2)
 *    with a bounded queue wait (120s) so auth storms cannot fork-bomb,
 *  - a hard per-browser lifetime ceiling (HERMES_BROWSER_MAX_LIFETIME_MS,
 *    default 180s) raced against the auth callback — hung polling loops can
 *    no longer keep a browser alive forever,
 *  - close → SIGKILL escalation (`forceCloseBrowser`) so a wedged Playwright
 *    `browser.close()` cannot leak the child process,
 *  - an in-process registry (reaper + shutdown killAll) and an on-disk
 *    run-file (~/.hermes/run/browsers.json, override HERMES_RUN_DIR) so a
 *    restarted broker can reap orphans left by a dead prior incarnation.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { clearProfileLock } from './browser-auth.js';

export type BrowserEngine = 'chromium' | 'firefox';

/** Minimal logger surface — `ProviderLogger` and pino-style loggers satisfy it structurally. */
export interface ManagedBrowserLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
}

/** Minimal structural surface of a Playwright Browser that lifecycle management needs. */
export interface ManagedBrowserLike {
  close(): Promise<void>;
  process?(): { pid?: number | undefined; kill(signal?: NodeJS.Signals | number): boolean } | null;
  contexts?(): unknown[];
}

const DEFAULT_MAX_CONCURRENT = 2;
const QUEUE_WAIT_MS = 120_000;
const DEFAULT_MAX_LIFETIME_MS = 180_000;
const DEFAULT_FORCE_CLOSE_GRACE_MS = 5_000;
const DEFAULT_REAPER_INTERVAL_MS = 60_000;
const DEFAULT_REAPER_MAX_AGE_MS = 600_000;
/** Conservative match for Playwright-launched browser processes (PID-reuse guard). */
const PLAYWRIGHT_CMD_PATTERN = /ms-playwright|playwright_.*_profile/;

export class BrowserAuthTimeoutError extends Error {
  /** Rides the broker's existing transient classification (`retryable === true`). */
  readonly retryable = true;
  readonly service: string;
  readonly limitMs: number;
  readonly phase: 'queue' | 'auth';

  constructor(service: string, limitMs: number, phase: 'queue' | 'auth') {
    super(phase === 'queue'
      ? `browser slot queue wait exceeded ${limitMs}ms for service ${service}`
      : `browser auth lifetime exceeded ${limitMs}ms for service ${service}; browser was force-closed`);
    this.name = 'BrowserAuthTimeoutError';
    this.service = service;
    this.limitMs = limitMs;
    this.phase = phase;
  }
}

/** Race `p` against an absolute wall-clock deadline; reject with a labeled error past it. */
export async function raceDeadline<T>(p: Promise<T>, deadlineAt: number, label: string): Promise<T> {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) {
    // Don't leave p's eventual rejection unhandled.
    void Promise.resolve(p).catch(() => {});
    throw new Error(`deadline exceeded before ${label}`);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          void Promise.resolve(p).catch(() => {});
          reject(new Error(`deadline exceeded during ${label} (deadline +${Date.now() - deadlineAt}ms)`));
        }, remainingMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Close a browser with a bounded grace window; on expiry SIGKILL the child
 * process. Never throws.
 *
 * Playwright's public `Browser` type does not expose `process()` (Puppeteer
 * does) — pass the launch-time resolved `pid` so escalation works for real
 * Playwright browsers. `browser.process?.()` is still tried first for fakes
 * and Puppeteer-shaped objects.
 */
export async function forceCloseBrowser(browser: ManagedBrowserLike, graceMs = DEFAULT_FORCE_CLOSE_GRACE_MS, pid?: number): Promise<void> {
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<'grace-expired'>((resolve) => {
      timer = setTimeout(() => resolve('grace-expired'), graceMs);
    });
    const closed = browser.close().then(() => 'closed' as const, () => 'closed' as const);
    const outcome = await Promise.race([closed, grace]);
    if (timer) clearTimeout(timer);
    if (outcome === 'grace-expired') {
      let killed = false;
      try {
        const proc = browser.process?.();
        if (proc) {
          proc.kill('SIGKILL');
          killed = true;
        }
      } catch { /* process already gone */ }
      if (!killed && pid !== undefined) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* process already gone */ }
      }
    }
  } catch { /* never throws */ }
}

// ---------------------------------------------------------------------------
// Browser PID resolution (Playwright client hides the child process)
// ---------------------------------------------------------------------------

/** Direct children of this process whose command line matches a Playwright browser. */
export function snapshotPlaywrightChildPids(): Set<number> {
  const pids = new Set<number>();
  try {
    const out = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', timeout: 5_000, maxBuffer: 16 * 1024 * 1024 });
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (!m) continue;
      if (Number(m[2]) !== process.pid) continue;
      if (PLAYWRIGHT_CMD_PATTERN.test(m[3] ?? '')) pids.add(Number(m[1]));
    }
  } catch { /* ps unavailable — pid resolution degrades gracefully */ }
  return pids;
}

/** The single new Playwright child since `before`, or undefined when ambiguous/none. */
export function diffNewPlaywrightChildPid(before: ReadonlySet<number>): number | undefined {
  const after = snapshotPlaywrightChildPids();
  const fresh = [...after].filter((pid) => !before.has(pid));
  return fresh.length === 1 ? fresh[0] : undefined;
}

// Serialize real launches so the before/after child-pid diff attributes the
// new browser process to the launch that created it.
let launchChain: Promise<void> = Promise.resolve();
async function withLaunchLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = launchChain;
  let release!: () => void;
  launchChain = new Promise<void>((resolve) => { release = resolve; });
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

// ---------------------------------------------------------------------------
// Concurrency semaphore
// ---------------------------------------------------------------------------

let activeSlots = 0;
const waitQueue: Array<() => void> = [];

function maxConcurrentBrowsers(): number {
  const raw = process.env['HERMES_MAX_CONCURRENT_BROWSERS'];
  if (!raw) return DEFAULT_MAX_CONCURRENT;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_CONCURRENT;
}

function makeRelease(): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeSlots -= 1;
    const next = waitQueue.shift();
    if (next) next();
  };
}

async function acquireBrowserSlot(service: string): Promise<() => void> {
  if (activeSlots < maxConcurrentBrowsers()) {
    activeSlots += 1;
    return makeRelease();
  }
  return new Promise<() => void>((resolve, reject) => {
    let settled = false;
    const grant = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeSlots += 1;
      resolve(makeRelease());
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const idx = waitQueue.indexOf(grant);
      if (idx >= 0) waitQueue.splice(idx, 1);
      reject(new BrowserAuthTimeoutError(service, QUEUE_WAIT_MS, 'queue'));
    }, QUEUE_WAIT_MS);
    waitQueue.push(grant);
  });
}

// ---------------------------------------------------------------------------
// Run-file (~/.hermes/run/browsers.json) — survives broker restarts
// ---------------------------------------------------------------------------

export interface BrowserRunFileEntry {
  pid: number;
  service: string;
  startedAt: number;
  brokerPid: number;
}

function runFilePath(): string {
  const dir = process.env['HERMES_RUN_DIR'] ?? path.join(os.homedir(), '.hermes', 'run');
  return path.join(dir, 'browsers.json');
}

async function readRunFile(): Promise<BrowserRunFileEntry[]> {
  try {
    const raw = await fs.readFile(runFilePath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is BrowserRunFileEntry =>
      typeof e === 'object' && e !== null &&
      typeof (e as BrowserRunFileEntry).pid === 'number' &&
      typeof (e as BrowserRunFileEntry).brokerPid === 'number');
  } catch {
    return [];
  }
}

async function writeRunFile(entries: BrowserRunFileEntry[]): Promise<void> {
  const file = runFilePath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(entries, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

async function appendRunFileEntry(entry: BrowserRunFileEntry, logger?: ManagedBrowserLogger): Promise<void> {
  try {
    const entries = await readRunFile();
    entries.push(entry);
    await writeRunFile(entries);
  } catch (err) {
    logger?.warn('failed to record browser in run-file', { error: (err as Error).message, pid: entry.pid });
  }
}

async function pruneRunFileEntry(pid: number, logger?: ManagedBrowserLogger): Promise<void> {
  try {
    const entries = await readRunFile();
    const next = entries.filter((e) => e.pid !== pid);
    if (next.length !== entries.length) await writeRunFile(next);
  } catch (err) {
    logger?.warn('failed to prune browser from run-file', { error: (err as Error).message, pid });
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface BrowserRegistryEntry {
  browser: ManagedBrowserLike;
  service: string;
  startedAt: number;
  persistent: boolean;
  pid?: number | undefined;
}

export interface ReapPriorIncarnationsSeams {
  /** Returns true when `pid` is a live process. Default: `process.kill(pid, 0)`. */
  procAlive?: (pid: number) => boolean;
  /** Returns the command line of `pid` ('' when unavailable). Default: `ps -o command= -p <pid>`. */
  procCommand?: (pid: number) => string;
  /** Sends `signal` to `pid`. Default: `process.kill`. */
  killPid?: (pid: number, signal: NodeJS.Signals) => void;
  logger?: ManagedBrowserLogger;
}

function defaultProcAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultProcCommand(pid: number): string {
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 5_000 }).trim();
  } catch {
    return '';
  }
}

const registryEntries = new Set<BrowserRegistryEntry>();

export const browserRegistry = {
  /** Register a live browser. Returns an unregister function (idempotent). */
  register(browser: ManagedBrowserLike, opts: { service: string; persistent?: boolean; pid?: number | undefined }): () => void {
    const entry: BrowserRegistryEntry = {
      browser,
      service: opts.service,
      startedAt: Date.now(),
      persistent: opts.persistent ?? false,
      pid: opts.pid,
    };
    registryEntries.add(entry);
    return () => { registryEntries.delete(entry); };
  },

  list(): ReadonlyArray<Omit<BrowserRegistryEntry, 'browser'>> {
    return [...registryEntries].map(({ service, startedAt, persistent, pid }) => ({ service, startedAt, persistent, pid }));
  },

  /** Force-close every registered browser (including persistent ones — shutdown path). */
  async killAll(graceMs = DEFAULT_FORCE_CLOSE_GRACE_MS): Promise<number> {
    const entries = [...registryEntries];
    registryEntries.clear();
    await Promise.all(entries.map(async (entry) => {
      await forceCloseBrowser(entry.browser, graceMs, entry.pid);
      if (entry.pid !== undefined) await pruneRunFileEntry(entry.pid);
    }));
    return entries.length;
  },

  /** Force-close non-persistent browsers older than `maxAgeMs`. Returns count reaped. */
  async reapOlderThan(maxAgeMs: number, graceMs = DEFAULT_FORCE_CLOSE_GRACE_MS): Promise<number> {
    const now = Date.now();
    const stale = [...registryEntries].filter((e) => !e.persistent && now - e.startedAt > maxAgeMs);
    await Promise.all(stale.map(async (entry) => {
      registryEntries.delete(entry);
      await forceCloseBrowser(entry.browser, graceMs, entry.pid);
      if (entry.pid !== undefined) await pruneRunFileEntry(entry.pid);
    }));
    return stale.length;
  },

  /** Start the periodic age-based reaper. Returns a stop function. */
  startReaper(intervalMs = DEFAULT_REAPER_INTERVAL_MS, maxAgeMs = DEFAULT_REAPER_MAX_AGE_MS): () => void {
    const timer = setInterval(() => {
      void browserRegistry.reapOlderThan(maxAgeMs);
    }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  },

  /**
   * Reap browser processes left behind by dead prior broker incarnations.
   * Reads the run-file; entries whose brokerPid is dead are dropped, and if
   * the browser pid is still alive AND its command line matches a Playwright
   * signature (PID-reuse guard), it is SIGKILLed. Set HERMES_ORPHAN_REAP=0
   * to skip. Returns the number of processes killed.
   */
  async reapPriorIncarnations(seams: ReapPriorIncarnationsSeams = {}): Promise<number> {
    if (process.env['HERMES_ORPHAN_REAP'] === '0') return 0;
    const procAlive = seams.procAlive ?? defaultProcAlive;
    const procCommand = seams.procCommand ?? defaultProcCommand;
    const killPid = seams.killPid ?? ((pid: number, signal: NodeJS.Signals) => { process.kill(pid, signal); });
    const logger = seams.logger;

    const entries = await readRunFile();
    if (entries.length === 0) return 0;

    const kept: BrowserRunFileEntry[] = [];
    let killed = 0;
    for (const entry of entries) {
      const brokerAlive = entry.brokerPid === process.pid || procAlive(entry.brokerPid);
      if (brokerAlive && entry.brokerPid !== process.pid) {
        // Another live broker owns this browser — leave it alone.
        kept.push(entry);
        continue;
      }
      if (entry.brokerPid === process.pid) {
        // Same pid as us, but we just started — a prior incarnation cannot share
        // our pid AND still have live state; treat as stale and fall through.
      }
      // Prior incarnation is dead — entry is stale either way; kill only when
      // the pid is alive and provably a Playwright browser (PID-reuse guard).
      if (procAlive(entry.pid)) {
        const cmd = procCommand(entry.pid);
        if (PLAYWRIGHT_CMD_PATTERN.test(cmd)) {
          try {
            killPid(entry.pid, 'SIGKILL');
            killed += 1;
            logger?.info('reaped orphaned browser from dead broker incarnation', { pid: entry.pid, service: entry.service, brokerPid: entry.brokerPid });
          } catch (err) {
            logger?.warn('failed to kill orphaned browser', { pid: entry.pid, error: (err as Error).message });
          }
        } else {
          logger?.warn('skipping orphan reap: pid alive but command does not match a Playwright browser (PID reuse?)', { pid: entry.pid, service: entry.service });
        }
      }
      // Stale entry is dropped from the run-file in all dead-broker branches.
    }
    try {
      await writeRunFile(kept);
    } catch (err) {
      logger?.warn('failed to rewrite run-file after orphan reap', { error: (err as Error).message });
    }
    return killed;
  },
};

/** Test-only: reset semaphore + registry module state between tests. */
export function resetManagedBrowserStateForTests(): void {
  activeSlots = 0;
  waitQueue.length = 0;
  registryEntries.clear();
}

// ---------------------------------------------------------------------------
// withManagedBrowser
// ---------------------------------------------------------------------------

export interface WithManagedBrowserOptions<B extends ManagedBrowserLike = import('patchright').Browser> {
  service: string;
  engine: BrowserEngine;
  /** Passed through to `patchright.<engine>.launch()`. */
  launchOptions?: Record<string, unknown>;
  /** When set, stale profile lock files are cleared before launch. */
  profileDir?: string;
  /** Hard ceiling on fn(browser); default HERMES_BROWSER_MAX_LIFETIME_MS or 180s. */
  maxLifetimeMs?: number;
  /** Persistent browsers are not closed when fn returns (enterprise-proxy/EDR agent pattern). */
  persistent?: boolean;
  logger?: ManagedBrowserLogger;
  /** Injectable launcher for tests. Default: dynamic import('patchright'). */
  launch?: (engine: BrowserEngine, launchOptions?: Record<string, unknown>) => Promise<B>;
}

function resolveMaxLifetimeMs(opts: { maxLifetimeMs?: number }): number {
  if (typeof opts.maxLifetimeMs === 'number' && opts.maxLifetimeMs > 0) return opts.maxLifetimeMs;
  const raw = process.env['HERMES_BROWSER_MAX_LIFETIME_MS'];
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_MAX_LIFETIME_MS;
}

async function defaultLaunch(engine: BrowserEngine, launchOptions?: Record<string, unknown>): Promise<import('patchright').Browser> {
  const pw = await import('patchright');
  return pw[engine].launch(launchOptions as Parameters<typeof pw.chromium.launch>[0]);
}

/**
 * Launch a browser under full lifecycle management and run `fn` against it.
 * The browser is force-closed (close → SIGKILL) when `fn` settles or when
 * the lifetime ceiling expires — a hung `fn` can no longer leak the browser.
 */
export async function withManagedBrowser<T, B extends ManagedBrowserLike = import('patchright').Browser>(
  opts: WithManagedBrowserOptions<B>,
  fn: (browser: B) => Promise<T>,
): Promise<T> {
  const release = await acquireBrowserSlot(opts.service); // throws BrowserAuthTimeoutError(phase: 'queue')
  let browser: B | undefined;
  let unregister: (() => void) | undefined;
  let pid: number | undefined;
  try {
    if (opts.profileDir) await clearProfileLock(opts.profileDir);

    if (opts.launch) {
      browser = await opts.launch(opts.engine, opts.launchOptions);
      pid = browser.process?.()?.pid ?? undefined;
    } else {
      // Real launch: resolve the child pid via before/after diff under a lock
      // (Playwright's Browser does not expose its child process).
      ({ browser, pid } = await withLaunchLock(async () => {
        const before = snapshotPlaywrightChildPids();
        const launched = (await defaultLaunch(opts.engine, opts.launchOptions)) as unknown as B;
        const resolvedPid = launched.process?.()?.pid ?? diffNewPlaywrightChildPid(before);
        return { browser: launched, pid: resolvedPid };
      }));
    }
    unregister = browserRegistry.register(browser, { service: opts.service, persistent: opts.persistent ?? false, pid });
    if (pid !== undefined) {
      await appendRunFileEntry({ pid, service: opts.service, startedAt: Date.now(), brokerPid: process.pid }, opts.logger);
    }

    const limitMs = resolveMaxLifetimeMs(opts);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const lifetime = new Promise<'lifetime-expired'>((resolve) => {
      timer = setTimeout(() => resolve('lifetime-expired'), limitMs);
    });
    // Capture fn's settlement so a late rejection after timeout is never unhandled.
    const work = fn(browser).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const raced = await Promise.race([work, lifetime]);
    if (timer) clearTimeout(timer);
    if (raced === 'lifetime-expired') {
      opts.logger?.warn('browser auth exceeded lifetime ceiling; force-closing', { service: opts.service, limitMs });
      await forceCloseBrowser(browser, DEFAULT_FORCE_CLOSE_GRACE_MS, pid);
      throw new BrowserAuthTimeoutError(opts.service, limitMs, 'auth');
    }
    if (!raced.ok) throw raced.error;
    return raced.value;
  } finally {
    unregister?.();
    if (pid !== undefined) await pruneRunFileEntry(pid, opts.logger);
    if (browser && !opts.persistent) await forceCloseBrowser(browser, DEFAULT_FORCE_CLOSE_GRACE_MS, pid);
    release();
  }
}
