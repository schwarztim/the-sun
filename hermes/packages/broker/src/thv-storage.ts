import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { TokenBundle } from './types.js';
import type { Logger } from './logger.js';

const execFileAsync = promisify(execFile);
const THV = '/opt/homebrew/bin/thv';

export interface ThvStorageOptions {
  logger: Logger;
  thvPath?: string;
  readinessTimeoutMs?: number;
  readinessPollMs?: number;
}

export interface SecretWriteProof {
  secretName: string;
  writtenAt: number;
  tokenType: string;
  expiresAt: number;
  hasRefreshToken: boolean;
}

export interface ContainerRestartProof {
  containerName: string;
  restartedAt: number;
  readyAt: number;
  url: string;
}

/** Spawn a process, write to stdin, resolve on exit. */
function spawnWithInput(cmd: string, args: string[], input: string, timeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${cmd} timed out after ${timeout}ms`)); }, timeout);
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}: ${stderr.trim()}`));
    });
    child.stdin.end(input);
  });
}

export class ThvTokenStorage {
  private readonly thv: string;
  private readonly readinessTimeoutMs: number;
  private readonly readinessPollMs: number;
  constructor(private readonly opts: ThvStorageOptions) {
    this.thv = opts.thvPath ?? THV;
    this.readinessTimeoutMs = opts.readinessTimeoutMs ?? 30_000;
    this.readinessPollMs = opts.readinessPollMs ?? 500;
  }

  async writeToken(secretName: string, bundle: TokenBundle): Promise<SecretWriteProof> {
    const value = JSON.stringify(bundle);
    await spawnWithInput(this.thv, ['secret', 'set', secretName], value, 30_000);
    const proof = {
      secretName,
      writtenAt: Date.now(),
      tokenType: bundle.tokenType,
      expiresAt: bundle.expiresAt,
      hasRefreshToken: Boolean(bundle.refreshToken),
    };
    this.opts.logger.info('wrote token to thv secret', proof);
    return proof;
  }

  async readToken(secretName: string): Promise<TokenBundle | null> {
    try {
      const { stdout } = await execFileAsync(this.thv, ['secret', 'get', secretName], { timeout: 30_000 });
      return JSON.parse(stdout.trim()) as TokenBundle;
    } catch {
      return null;
    }
  }

  async restartContainer(containerName: string): Promise<ContainerRestartProof> {
    this.opts.logger.info('restarting container', { containerName });
    await execFileAsync(this.thv, ['stop', containerName], { timeout: 30_000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 2000));
    await execFileAsync(this.thv, ['start', containerName], { timeout: 30_000 });
    const ready = await this.waitForContainerReady(containerName);
    const proof = {
      containerName,
      restartedAt: Date.now(),
      readyAt: ready.readyAt,
      url: ready.url,
    };
    this.opts.logger.info('container restarted and ready', proof);
    return proof;
  }

  private async waitForContainerReady(containerName: string): Promise<{ readyAt: number; url: string }> {
    const deadline = Date.now() + this.readinessTimeoutMs;
    let lastStatus = 'unknown';
    let lastError: string | undefined;
    while (Date.now() <= deadline) {
      try {
        const ready = await this.inspectContainerReadiness(containerName);
        lastStatus = ready.status;
        if (ready.url) return { readyAt: Date.now(), url: ready.url };
      } catch (err) {
        lastError = (err as Error).message;
      }
      await new Promise(r => setTimeout(r, this.readinessPollMs));
    }
    const detail = lastError ? `last error: ${lastError}` : `last status: ${lastStatus}`;
    throw new Error(`container ${containerName} not ready after ${this.readinessTimeoutMs}ms (${detail})`);
  }

  private async inspectContainerReadiness(containerName: string): Promise<{ status: string; url?: string }> {
    const { stdout } = await execFileAsync(this.thv, ['list'], { timeout: 10_000 });
    for (const line of stdout.split('\n').slice(1)) {
      if (!line.trim()) continue;
      const fields = line.trim().split(/\s+/);
      if (fields[0] !== containerName) continue;
      const status = fields[2] ?? 'unknown';
      const url = fields.find((f) => f.startsWith('http://') || f.startsWith('https://'));
      return status === 'running' && url ? { status, url } : { status };
    }
    return { status: 'missing' };
  }
}
