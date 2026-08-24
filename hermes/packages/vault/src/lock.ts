/**
 * Cross-process advisory lock via `O_CREAT | O_EXCL` (`fs.open(path, 'wx')`).
 *
 * Atomic on POSIX *and* NTFS with no `fcntl`/`flock` — portable to Windows.
 * The lock file holds `<pid> <timestamp>`. A holder is taken over only when it
 * is genuinely dead — its timestamp is older than `staleMs` AND its PID is no
 * longer alive on this machine (or its timestamp is corrupt). Age alone is not
 * enough: scheduling jitter can push a LIVE holder's lock past a short staleMs,
 * and force-stealing it would put two writers in the critical section at once.
 * Acquisition retries with jittered backoff up to `timeoutMs`, then fails closed
 * (throws) rather than proceeding unlocked.
 *
 * Stale takeover is ATOMIC: a contending waiter moves the stale lock aside with
 * `fs.rename` (only one waiter can move a given inode; the rest see ENOENT) and
 * verifies the moved token still equals the stale one it observed. A blind
 * `read → decide → unlink` would let two waiters both delete-and-recreate the
 * lock — two simultaneous holders and a silent lost write.
 */
import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';

export interface LockOptions {
  /** Age after which a held lock is considered stale and eligible for takeover. Default 10s. */
  staleMs?: number;
  /** Give up (throw) after this long waiting to acquire. Default 15s. */
  timeoutMs?: number;
}

const DEFAULT_STALE_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 15_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential-ish backoff with jitter, capped, to avoid thundering-herd retries. */
function jitterBackoff(attempt: number): number {
  const base = Math.min(20 * 2 ** attempt, 250);
  return base + Math.floor(Math.random() * 30);
}

/**
 * Is `pid` a live process on THIS machine? Signal 0 delivers nothing — it only
 * probes existence. ESRCH ⇒ no such process (dead); EPERM ⇒ the process exists
 * but is owned by another user (still alive). Any unusable pid ⇒ treated dead.
 */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Read the current lock holder token and whether it is stale (eligible for
 * takeover). Returns `null` when the lock vanished/unreadable (let the retry
 * loop re-open it).
 *
 * A holder is stale iff:
 *   - its timestamp is unparseable/non-finite — a corrupt/truncated write must
 *     never wedge every future writer forever (a permanent write DoS); OR
 *   - its timestamp is older than `staleMs` AND its PID is no longer alive.
 *
 * Requiring a DEAD pid for the age path is what prevents force-stealing a live
 * holder that merely ran long: a short staleMs plus scheduling jitter can age a
 * valid lock past the threshold, and stealing it would break mutual exclusion.
 * When the pid is unparseable we cannot probe liveness, so we fall back to
 * age-only (still bounded by staleMs).
 */
async function readLock(lockPath: string, staleMs: number): Promise<{ token: string; stale: boolean } | null> {
  try {
    const token = await fs.readFile(lockPath, 'utf8');
    const [pidField, tsField] = token.trim().split(/\s+/);
    const ts = Number.parseInt(tsField ?? '', 10);
    const pid = Number.parseInt(pidField ?? '', 10);
    let stale: boolean;
    if (!Number.isFinite(ts)) {
      stale = true; // corrupt timestamp → stealable (DoS guard)
    } else if (Date.now() - ts <= staleMs) {
      stale = false; // young enough → assume a live holder
    } else {
      // Old enough to consider — but only steal if the holder process is truly gone.
      stale = Number.isFinite(pid) ? !pidAlive(pid) : true;
    }
    return { token, stale };
  } catch {
    return null; // holder released or unreadable → retry loop handles it
  }
}

/**
 * Atomically take over a lock we observed as STALE (holder token `observed`).
 * Returns true iff THIS caller removed exactly that stale holder — never a fresh
 * one.
 *
 * `fs.rename` is the arbiter: only one waiter can move a given inode aside, and
 * we verify the moved content still equals the stale token we saw before
 * deleting it. If a live holder slipped in between our read and our rename, the
 * moved content differs — we put it back untouched and keep waiting rather than
 * dropping a live lock.
 */
async function stealStaleLock(lockPath: string, observed: string): Promise<boolean> {
  const stealPath = `${lockPath}.${process.pid}.${randomBytes(6).toString('hex')}.steal`;
  try {
    await fs.rename(lockPath, stealPath);
  } catch {
    return false; // another waiter already moved/removed it, or it vanished → keep waiting
  }
  let moved: string;
  try {
    moved = await fs.readFile(stealPath, 'utf8');
  } catch {
    // We moved *something* off lockPath but can't read it back; it is no longer a
    // live holder at the canonical path, so discard it and retry the create.
    await fs.unlink(stealPath).catch(() => { /* best-effort */ });
    return true;
  }
  if (moved === observed) {
    await fs.unlink(stealPath).catch(() => { /* best-effort */ }); // confirmed stale — remove and take over
    return true;
  }
  // We moved a DIFFERENT (fresh) holder — restore it so we never drop a live lock.
  try {
    await fs.rename(stealPath, lockPath);
  } catch {
    await fs.unlink(stealPath).catch(() => { /* best-effort */ }); // a new holder re-created it → discard our copy
  }
  return false; // not our steal — keep waiting
}

/**
 * Acquire the exclusive lock. Resolves to an idempotent release function that
 * unlinks the lock file. Throws if the lock cannot be acquired within the timeout.
 */
export async function acquireLock(lockPath: string, options: LockOptions = {}): Promise<() => Promise<void>> {
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;

  for (;;) {
    try {
      const fh = await fs.open(lockPath, 'wx'); // O_CREAT|O_EXCL|O_WRONLY — atomic create-or-fail
      try {
        await fh.writeFile(`${process.pid} ${Date.now()}\n`);
      } finally {
        await fh.close();
      }
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        try {
          await fs.unlink(lockPath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err; // real error → fail closed
      // Contended. Attempt an ATOMIC takeover of a STALE holder; otherwise back off.
      const info = await readLock(lockPath, staleMs);
      if (info?.stale && (await stealStaleLock(lockPath, info.token))) {
        continue; // we removed the stale holder — retry the exclusive create immediately
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out acquiring vault lock ${lockPath} after ${timeoutMs}ms`);
      }
      await sleep(jitterBackoff(attempt++));
    }
  }
}
