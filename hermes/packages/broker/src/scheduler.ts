import type { Logger } from './logger.js';

export interface SchedulerOptions {
  logger: Logger;
  refresh: (service: string, scheme: string) => Promise<void>;
  onRefreshFailed?: (service: string, scheme: string, error: Error) => void;
}

/**
 * Node's maximum setTimeout delay. A larger value silently overflows to a
 * 1ms delay, so the timer fires IMMEDIATELY instead of far in the future.
 */
const TIMEOUT_MAX_MS = 2_147_483_647; // 2^31 - 1, about 24.8 days

export class RefreshScheduler {
  private timers = new Map<string, NodeJS.Timeout>();
  constructor(private readonly opts: SchedulerOptions) {}

  /**
   * Arm a refresh for `key` at `when`.
   *
   * Two guards protect the IdP from an unbounded refresh loop, because nothing
   * downstream would stop one: `provider.refresh` is not behind the broker's
   * acquireGate (only `provider.acquire` is), and the proactive-failure disarm
   * counter only counts FAILURES, so a refresh that keeps SUCCEEDING on a bad
   * timer would loop forever at full speed.
   *
   *  1. A non-finite target (an invalid Date, typically a provider deriving
   *     expiry from a malformed or missing JWT `exp`) is refused outright.
   *     `Math.max(0, NaN)` is NaN, and `setTimeout(NaN)` is coerced to 1ms, so
   *     scheduling it would fire instantly and re-arm the same way on every
   *     success. Logging and skipping leaves the key unarmed, which the caller
   *     already handles; it never spins.
   *  2. A target beyond {@link TIMEOUT_MAX_MS} is armed in chunks rather than
   *     overflowing: each hop re-arms for the remaining time until the real
   *     target is reached.
   */
  schedule(key: string, when: Date): void {
    this.cancel(key);
    const target = when.getTime();
    if (!Number.isFinite(target)) {
      this.opts.logger.warn('refusing to schedule refresh: refresh time is not a valid date', {
        key,
        when: String(when),
      });
      return;
    }
    this.arm(key, target);
  }

  /** Arm one hop toward `target`, clamped to Node's max delay. */
  private arm(key: string, target: number): void {
    const ms = Math.min(Math.max(0, target - Date.now()), TIMEOUT_MAX_MS);
    const parts = key.split(':');
    const service = parts[0] ?? '';
    const scheme = parts[1] ?? '';
    const t = setTimeout(() => {
      this.timers.delete(key);
      // Still short of the real target (clamped hop, or a timer that fired a
      // hair early): re-arm for the remainder instead of refreshing now.
      if (Date.now() < target) {
        this.arm(key, target);
        return;
      }
      this.opts.refresh(service, scheme).catch((err) => {
        this.opts.logger.warn('scheduled refresh failed', { key, error: (err as Error).message });
        this.opts.onRefreshFailed?.(service, scheme, err as Error);
      });
    }, ms);
    if (typeof t.unref === 'function') t.unref();
    this.timers.set(key, t);
  }

  cancel(key: string): void {
    const t = this.timers.get(key);
    if (t) { clearTimeout(t); this.timers.delete(key); }
  }

  cancelAll(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  pendingKeys(): string[] { return Array.from(this.timers.keys()); }
}
