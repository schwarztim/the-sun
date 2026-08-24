import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import type { Logger } from './logger.js';

const execFileAsync = promisify(execFile);
const THV = '/opt/homebrew/bin/thv';
const CONFIG_PATH = path.join(os.homedir(), '.config', 'mcpu', 'config.generated.json');

export interface FleetSyncOptions {
  logger: Logger;
  thvPath?: string;
  configPath?: string;
  gatewayUrl?: string;
  checkIntervalMs?: number;
}

interface ThvContainer {
  name: string;
  url: string;
}

export interface FleetSyncStatus {
  lastSync: number | null;
  lastHash: string;
  backendCount: number;
  gatewayReachable: boolean;
  gatewayBackends: number;
  lastContainerNames: string[];
  lastSyncError?: string;
  lastGatewayReloadAt: number | null;
  lastGatewayReloadStatus: GatewayReloadStatus;
  lastGatewayReloadStatusCode?: number;
}

export type GatewayReloadStatus = 'ok' | 'non_ok' | 'unreachable' | 'skipped';

export interface GatewayReloadProof {
  status: GatewayReloadStatus;
  at: number;
  loaded?: number;
  httpStatus?: number;
  error?: string;
}

export interface FleetSyncResult {
  changed: boolean;
  backends: number;
  configHash: string;
  configPath: string;
  containerNames: string[];
  gatewayReload: GatewayReloadProof;
}

/**
 * GatewayFleetSync keeps the MCP Gateway's fleet manifest in sync with
 * running ToolHive containers. It periodically reads `thv list`, regenerates
 * config.generated.json when ports change, and reloads the gateway.
 *
 * Triggered by:
 *   1. Periodic timer (default: every 60s)
 *   2. After token refresh causes a container restart (via syncNow())
 */
export class GatewayFleetSync {
  private timer: NodeJS.Timeout | null = null;
  private lastHash = '';
  private lastSync: number | null = null;
  private lastBackendCount = 0;
  private lastGatewayReachable = false;
  private lastGatewayBackends = 0;
  private lastContainerNames: string[] = [];
  private lastSyncError: string | undefined;
  private lastGatewayReloadAt: number | null = null;
  private lastGatewayReloadStatus: GatewayReloadStatus = 'skipped';
  private lastGatewayReloadStatusCode: number | undefined;
  private readonly thv: string;
  private readonly configPath: string;
  private readonly gatewayUrl: string;
  private readonly checkIntervalMs: number;

  constructor(private readonly opts: FleetSyncOptions) {
    this.thv = opts.thvPath ?? THV;
    this.configPath = opts.configPath ?? CONFIG_PATH;
    this.gatewayUrl = opts.gatewayUrl ?? 'http://127.0.0.1:3100';
    this.checkIntervalMs = opts.checkIntervalMs ?? 60_000;
  }

  start(): void {
    if (this.timer) return;
    // Run immediately on start
    this.syncNow().catch((err) =>
      this.opts.logger.warn('fleet sync failed', { error: (err as Error).message }),
    );
    const t = setInterval(() => {
      this.syncNow().catch((err) =>
        this.opts.logger.warn('fleet sync failed', { error: (err as Error).message }),
      );
    }, this.checkIntervalMs);
    if (typeof t.unref === 'function') t.unref();
    this.timer = t;
    this.opts.logger.info('fleet sync started', { intervalMs: this.checkIntervalMs });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  status(): FleetSyncStatus {
    return {
      lastSync: this.lastSync,
      lastHash: this.lastHash,
      backendCount: this.lastBackendCount,
      gatewayReachable: this.lastGatewayReachable,
      gatewayBackends: this.lastGatewayBackends,
      lastContainerNames: this.lastContainerNames,
      ...(this.lastSyncError ? { lastSyncError: this.lastSyncError } : {}),
      lastGatewayReloadAt: this.lastGatewayReloadAt,
      lastGatewayReloadStatus: this.lastGatewayReloadStatus,
      ...(this.lastGatewayReloadStatusCode ? { lastGatewayReloadStatusCode: this.lastGatewayReloadStatusCode } : {}),
    };
  }

  /** Parse running containers from `thv list` output */
  private async listContainers(): Promise<ThvContainer[]> {
    const { stdout } = await execFileAsync(this.thv, ['list'], { timeout: 10_000 });
    const containers: ThvContainer[] = [];

    for (const line of stdout.split('\n').slice(1)) {
      if (!line.trim()) continue;
      const fields = line.trim().split(/\s+/);
      if (fields.length < 5) continue;
      const name = fields[0];
      const status = fields[2];
      if (status !== 'running') continue;

      // Find the URL field (http://127.0.0.1:PORT/mcp)
      const urlField = fields.find((f) => f.startsWith('http://'));
      if (!urlField) continue;

      const portMatch = urlField.match(/:(\d+)(?:\/|$)/);
      if (!portMatch) continue;

      containers.push({
        name: name!,
        url: urlField,
      });
    }
    return containers;
  }

  /** Build the config JSON from container list */
  private buildConfig(containers: ThvContainer[]): string {
    const mcpServers: Record<string, { url: string; transport: { type: string } }> = {};
    for (const c of containers) {
      mcpServers[c.name] = {
        url: c.url,
        transport: { type: 'http' },
      };
    }
    return JSON.stringify({ mcpServers }, null, 2);
  }

  /** Write config and reload gateway if contents changed */
  async syncNow(opts: { forceReload?: boolean } = {}): Promise<FleetSyncResult> {
    let containers: ThvContainer[];
    try {
      containers = await this.listContainers();
    } catch (err) {
      this.lastSync = Date.now();
      this.lastSyncError = (err as Error).message.slice(0, 500);
      this.opts.logger.warn('fleet sync container inventory failed', { error: this.lastSyncError });
      throw err;
    }
    const config = this.buildConfig(containers);
    const hash = createHash('sha256').update(config).digest('hex').slice(0, 16);
    const names = containers.map((c) => c.name);

    this.lastBackendCount = containers.length;
    this.lastContainerNames = names;
    this.lastSync = Date.now();
    this.lastSyncError = undefined;

    const changed = hash !== this.lastHash;

    if (changed) {
      // Config changed — write it
      await fs.mkdir(path.dirname(this.configPath), { recursive: true });
      await fs.writeFile(this.configPath, config + '\n', 'utf8');
      this.lastHash = hash;
      this.opts.logger.info('fleet config updated', {
        backends: containers.length,
        names,
      });
    }

    const gatewayReload = changed || opts.forceReload
      ? await this.reloadGateway()
      : this.recordSkippedGatewayReload();

    return {
      changed,
      backends: containers.length,
      configHash: hash,
      configPath: this.configPath,
      containerNames: names,
      gatewayReload,
    };
  }

  /** Reload the gateway's fleet backends */
  private async reloadGateway(): Promise<GatewayReloadProof> {
    const at = Date.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);
      const res = await fetch(`${this.gatewayUrl}/admin/fleet/reload`, {
        method: 'POST',
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout));
      this.lastGatewayReachable = true;
      this.lastGatewayReloadAt = at;
      this.lastGatewayReloadStatusCode = res.status;

      if (res.ok) {
        const body = await res.json().catch(() => ({})) as { ingestResult?: { loaded?: number } };
        this.lastGatewayBackends = body.ingestResult?.loaded ?? 0;
        this.lastGatewayReloadStatus = 'ok';
        this.opts.logger.info('gateway reloaded', { loaded: this.lastGatewayBackends });
        return { status: 'ok', at, loaded: this.lastGatewayBackends, httpStatus: res.status };
      } else {
        this.lastGatewayReloadStatus = 'non_ok';
        this.opts.logger.warn('gateway reload returned non-ok', { status: res.status });
        return { status: 'non_ok', at, httpStatus: res.status };
      }
    } catch (err) {
      this.lastGatewayReachable = false;
      this.lastGatewayReloadAt = at;
      this.lastGatewayReloadStatus = 'unreachable';
      this.lastGatewayReloadStatusCode = undefined;
      this.opts.logger.warn('gateway unreachable', { error: (err as Error).message });
      return { status: 'unreachable', at, error: (err as Error).message.slice(0, 500) };
    }
  }

  private recordSkippedGatewayReload(): GatewayReloadProof {
    const proof = { status: 'skipped' as const, at: Date.now() };
    this.lastGatewayReloadStatus = 'skipped';
    return proof;
  }
}
