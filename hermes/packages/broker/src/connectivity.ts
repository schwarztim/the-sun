import dns from 'node:dns';
import type { Logger } from './logger.js';
import type { ConnectivityConfig } from './config.js';

/**
 * ConnectivityGate — single source of truth for "can we reach the IdP".
 *
 * State machine: online → offline → recovering → online
 *
 *   online      probe results cached `probeTtlMs`; all acquire/refresh/validate
 *               paths proceed. `failuresToOffline` CONSECUTIVE probe failures
 *               transition to offline.
 *   offline     background recheck loop every `offlineRecheckMs` + 0-5s jitter.
 *               `isOnline()` returns false without probing — zero AD touches.
 *   recovering  first successful probe while offline. Emits 'online' exactly
 *               once per offline episode. The recovery orchestrator (cli.ts)
 *               runs its coalesced pass and calls `markOnline()`; as a
 *               fallback the next successful probe also completes the
 *               transition.
 *
 * The gate is passive everywhere except the single 'online' event — consumers
 * consult it; only the recovery orchestrator subscribes.
 *
 * Probe = DNS lookup of `probeHost`, then optional HTTP HEAD of `probeUrl`
 * (5s timeout). Only network-shaped errors count as failures
 * (ENOTFOUND/EAI_AGAIN/ECONNREFUSED/ETIMEDOUT/ENETUNREACH/EHOSTUNREACH/abort);
 * anything else is treated as "network up" so an IdP 5xx never flips us offline.
 *
 * `probeFn` is injectable for tests.
 */

export type ConnectivityState = 'online' | 'offline' | 'recovering';
export type ConnectivityEvent = 'online' | 'offline';

/** Structural subset consumed by Broker / lifecycle — eases test stubbing. */
export interface ConnectivityGateLike {
  isOnline(): Promise<boolean>;
  getState(): ConnectivityState;
}

export interface ConnectivityGateOptions {
  logger: Logger;
  config: ConnectivityConfig;
  /** Injectable probe for tests. Resolve true = network reachable. */
  probeFn?: () => Promise<boolean>;
  /** Injectable jitter (ms) for tests. Default: random 0-5000. */
  jitterFn?: () => number;
}

const NETWORK_ERROR_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNRESET', 'ABORT_ERR',
]);
const HEAD_PROBE_TIMEOUT_MS = 5_000;
const MAX_JITTER_MS = 5_000;

function isNetworkShapedError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code && NETWORK_ERROR_CODES.has(code)) return true;
  const name = (err as Error | undefined)?.name;
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  // undici wraps the syscall error in cause
  const cause = (err as { cause?: unknown } | undefined)?.cause;
  if (cause && cause !== err) return isNetworkShapedError(cause);
  return false;
}

export class ConnectivityGate implements ConnectivityGateLike {
  private state: ConnectivityState = 'online';
  private consecutiveFailures = 0;
  private lastProbeAt = 0;
  private lastProbeResult = true;
  private inFlightProbe: Promise<boolean> | null = null;
  private recheckTimer: NodeJS.Timeout | null = null;
  private started = false;
  private readonly listeners: Record<ConnectivityEvent, Set<() => void>> = {
    online: new Set(),
    offline: new Set(),
  };

  constructor(private readonly opts: ConnectivityGateOptions) {}

  start(): void { this.started = true; }

  stop(): void {
    this.started = false;
    if (this.recheckTimer) { clearTimeout(this.recheckTimer); this.recheckTimer = null; }
  }

  getState(): ConnectivityState { return this.state; }

  on(event: ConnectivityEvent, cb: () => void): void {
    this.listeners[event].add(cb);
  }

  off(event: ConnectivityEvent, cb: () => void): void {
    this.listeners[event].delete(cb);
  }

  /**
   * Consulted by every AD-touching path. While offline, returns false without
   * probing (the recheck loop owns recovery). While online/recovering, probes
   * with `probeTtlMs` caching.
   */
  async isOnline(): Promise<boolean> {
    if (this.state === 'offline') return false;
    return this.probeCached();
  }

  /** Recovery orchestrator calls this after the recovery pass is scheduled. */
  markOnline(): void {
    if (this.state === 'recovering') {
      this.state = 'online';
      this.opts.logger.info('connectivity: recovery complete — online');
    }
  }

  private async probeCached(): Promise<boolean> {
    const now = Date.now();
    if (now - this.lastProbeAt < this.opts.config.probeTtlMs) return this.lastProbeResult;
    if (this.inFlightProbe) return this.inFlightProbe;
    this.inFlightProbe = this.runProbe().finally(() => { this.inFlightProbe = null; });
    return this.inFlightProbe;
  }

  private async runProbe(): Promise<boolean> {
    const ok = await this.executeProbe();
    this.lastProbeAt = Date.now();
    this.lastProbeResult = ok;
    if (ok) {
      this.consecutiveFailures = 0;
      if (this.state === 'recovering') {
        // Fallback completion in case the orchestrator never calls markOnline().
        this.state = 'online';
      }
      return true;
    }
    this.consecutiveFailures++;
    if (this.state !== 'offline' && this.consecutiveFailures >= this.opts.config.failuresToOffline) {
      this.transitionOffline();
    }
    return false;
  }

  private async executeProbe(): Promise<boolean> {
    if (this.opts.probeFn) {
      try { return await this.opts.probeFn(); }
      catch { return false; }
    }
    try {
      await dns.promises.lookup(this.opts.config.probeHost);
    } catch (err) {
      if (isNetworkShapedError(err)) return false;
      // Non-network error from the resolver — fail open (assume reachable).
      this.opts.logger.warn('connectivity: dns probe threw a non-network error — assuming online', { error: (err as Error).message });
      return true;
    }
    if (this.opts.config.probeUrl) {
      try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), HEAD_PROBE_TIMEOUT_MS);
        if (typeof t.unref === 'function') t.unref();
        try {
          await fetch(this.opts.config.probeUrl, { method: 'HEAD', signal: controller.signal });
        } finally {
          clearTimeout(t);
        }
      } catch (err) {
        if (isNetworkShapedError(err)) return false;
        // HTTP-level failures (4xx/5xx throw nothing; only transport errors land
        // here) — anything non-network-shaped means the network path exists.
        return true;
      }
    }
    return true;
  }

  private transitionOffline(): void {
    this.state = 'offline';
    this.opts.logger.warn('connectivity: OFFLINE — suppressing all IdP interactions', {
      probeHost: this.opts.config.probeHost,
      consecutiveFailures: this.consecutiveFailures,
      recheckMs: this.opts.config.offlineRecheckMs,
    });
    this.emit('offline');
    this.armRecheck();
  }

  private armRecheck(): void {
    if (this.recheckTimer) clearTimeout(this.recheckTimer);
    const jitter = this.opts.jitterFn ? this.opts.jitterFn() : Math.floor(Math.random() * MAX_JITTER_MS);
    const t = setTimeout(() => {
      this.recheckTimer = null;
      void this.recheck();
    }, this.opts.config.offlineRecheckMs + jitter);
    if (typeof t.unref === 'function') t.unref();
    this.recheckTimer = t;
  }

  private async recheck(): Promise<void> {
    if (this.state !== 'offline') return;
    let ok = false;
    try { ok = await this.executeProbe(); }
    catch { ok = false; }
    this.lastProbeAt = Date.now();
    this.lastProbeResult = ok;
    if (!ok) {
      this.armRecheck();
      return;
    }
    // offline → recovering: exactly one 'online' event per offline episode.
    this.consecutiveFailures = 0;
    this.state = 'recovering';
    this.opts.logger.info('connectivity: probe succeeded — recovering', { probeHost: this.opts.config.probeHost });
    this.emit('online');
  }

  private emit(event: ConnectivityEvent): void {
    for (const cb of this.listeners[event]) {
      try { cb(); }
      catch (err) {
        this.opts.logger.warn(`connectivity: ${event} listener threw`, { error: (err as Error).message });
      }
    }
  }
}
