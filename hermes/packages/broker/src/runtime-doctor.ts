import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERMES_LAUNCHD_LABEL = 'com.hermes.broker';

export type DoctorStatus = 'ok' | 'warn' | 'fail';

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ProcessInfo {
  pid: number;
  ppid: number | null;
  elapsed?: string;
  command?: string;
}

export type ListenerClassification =
  | 'not-listening'
  | 'hermes'
  | 'hermes-orphan'
  | 'foreign-listener'
  | 'multiple-listeners'
  | 'unknown-listener';

export interface ListenerState {
  classification: ListenerClassification;
  processes: ProcessInfo[];
  orphanPids: number[];
}

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  summary: string;
  details?: Record<string, unknown>;
  remediation?: string[];
}

export interface DoctorAction {
  name: string;
  status: DoctorStatus;
  summary: string;
  details?: Record<string, unknown>;
}

export interface DoctorReport {
  ok: boolean;
  actions: DoctorAction[];
  checks: DoctorCheck[];
}

export interface RuntimeDoctorOptions {
  dataDir: string;
  host: string;
  port: number;
  recoverOrphan?: boolean;
  installLaunchd?: boolean;
  nodeExtraCaCerts?: string;
}

export interface RuntimeDoctorDeps {
  exec: (command: string, args: string[]) => Promise<CommandResult>;
  fetch: (url: string, init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  }) => Promise<{ status: number; ok: boolean; json(): Promise<unknown>; text(): Promise<string> }>;
  readFile: (file: string) => Promise<string>;
  writeFile: (file: string, data: string, opts?: { mode?: number }) => Promise<void>;
  mkdir: (dir: string, opts?: { recursive?: boolean }) => Promise<void>;
  access: (file: string) => Promise<void>;
  killPid: (pid: number, signal: NodeJS.Signals) => void;
  sleep: (ms: number) => Promise<void>;
  env: NodeJS.ProcessEnv;
  homedir: string;
  uid: number;
  execPath: string;
  brokerCliPath: string;
}

export function defaultBrokerCliPath(): string {
  const here = fileURLToPath(import.meta.url);
  const dir = path.dirname(here);
  const brokerRoot = path.basename(dir) === 'src' || path.basename(dir) === 'dist'
    ? path.dirname(dir)
    : dir;
  return path.join(brokerRoot, 'dist', 'cli.js');
}

function defaultDeps(): RuntimeDoctorDeps {
  return {
    exec: execCommand,
    fetch: globalThis.fetch as RuntimeDoctorDeps['fetch'],
    readFile: (file) => fs.readFile(file, 'utf8'),
    writeFile: (file, data, opts) => fs.writeFile(file, data, opts),
    mkdir: (dir, opts) => fs.mkdir(dir, opts).then(() => undefined),
    access: (file) => fs.access(file),
    killPid: (pid, signal) => process.kill(pid, signal),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    env: process.env,
    homedir: os.homedir(),
    uid: typeof process.getuid === 'function' ? process.getuid() : 0,
    execPath: process.execPath,
    brokerCliPath: defaultBrokerCliPath(),
  };
}

async function execCommand(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(command, args, { encoding: 'utf8', maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const exitCode = typeof (error as { code?: unknown } | null)?.code === 'number'
        ? (error as { code: number }).code
        : 0;
      resolve({
        exitCode,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
      });
    });
  });
}

export function parseLsofPids(output: string): number[] {
  const pids = new Set<number>();
  for (const line of output.split(/\r?\n/).slice(1)) {
    const parts = line.trim().split(/\s+/);
    const pid = Number(parts[1]);
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

export function parsePsOutput(output: string): ProcessInfo | null {
  const line = output.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  if (!line) return null;
  const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
  if (!match) return null;
  return {
    pid: Number(match[1]),
    ppid: Number(match[2]),
    elapsed: match[3],
    command: match[4],
  };
}

export function isHermesBrokerCommand(command = ''): boolean {
  return /(?:^|\s)(?:node|tsx)(?:\s|$)/.test(command)
    && /(?:packages\/broker|@hermes\/broker|hermes).*cli\.(?:js|ts)\s+start\b/.test(command);
}

export function classifyListenerState(processes: ProcessInfo[]): ListenerState {
  if (processes.length === 0) {
    return { classification: 'not-listening', processes, orphanPids: [] };
  }
  if (processes.length > 1) {
    const orphanPids = processes
      .filter((p) => p.ppid === 1 && isHermesBrokerCommand(p.command))
      .map((p) => p.pid);
    return { classification: 'multiple-listeners', processes, orphanPids };
  }
  const [proc] = processes;
  if (!proc) return { classification: 'unknown-listener', processes, orphanPids: [] };
  if (!proc.command) return { classification: 'unknown-listener', processes, orphanPids: [] };
  if (!isHermesBrokerCommand(proc.command)) {
    return { classification: 'foreign-listener', processes, orphanPids: [] };
  }
  if (proc.ppid === 1) {
    return { classification: 'hermes-orphan', processes, orphanPids: [proc.pid] };
  }
  return { classification: 'hermes', processes, orphanPids: [] };
}

async function inspectListener(host: string, port: number, deps: RuntimeDoctorDeps): Promise<DoctorCheck & { state: ListenerState }> {
  const lsof = await deps.exec('lsof', ['-nP', `-iTCP@${host}:${port}`, '-sTCP:LISTEN']);
  let pids = parseLsofPids(lsof.stdout);
  if (pids.length === 0) {
    const fallback = await deps.exec('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN']);
    pids = parseLsofPids(fallback.stdout);
  }
  const processes: ProcessInfo[] = [];
  for (const pid of pids) {
    const ps = await deps.exec('ps', ['-o', 'pid=,ppid=,etime=,command=', '-p', String(pid)]);
    const parsed = parsePsOutput(ps.stdout);
    processes.push(parsed ?? { pid, ppid: null });
  }

  const state = classifyListenerState(processes);
  const base = { name: 'listener', details: { classification: state.classification, processes } };
  if (state.classification === 'hermes') {
    return { ...base, state, status: 'ok', summary: `Hermes is listening on ${host}:${port}` };
  }
  if (state.classification === 'hermes-orphan') {
    return {
      ...base,
      state,
      status: 'warn',
      summary: `Hermes listener is orphaned on ${host}:${port}`,
      remediation: ['Run: hermes doctor --recover-orphan', 'This sends SIGTERM only to the classified orphan PID, then kickstarts launchd.'],
    };
  }
  if (state.classification === 'foreign-listener' || state.classification === 'multiple-listeners') {
    return {
      ...base,
      state,
      status: 'fail',
      summary: `Unexpected listener owns ${host}:${port}`,
      remediation: ['Inspect the listed PID(s) manually before changing Hermes. Do not use pkill or killall.'],
    };
  }
  return {
    ...base,
    state,
    status: 'fail',
    summary: `No Hermes listener on ${host}:${port}`,
    remediation: [`Start launchd: launchctl kickstart -k gui/${deps.uid}/${HERMES_LAUNCHD_LABEL}`],
  };
}

export function parseLaunchctlPrint(output: string): { state?: string; pid?: number; lastExitCode?: number } {
  const state = output.match(/\bstate = ([^\s]+)/)?.[1];
  const pidText = output.match(/\bpid = (\d+)/)?.[1];
  const exitText = output.match(/\blast exit code = (-?\d+)/)?.[1];
  return {
    ...(state ? { state } : {}),
    ...(pidText ? { pid: Number(pidText) } : {}),
    ...(exitText ? { lastExitCode: Number(exitText) } : {}),
  };
}

async function inspectLaunchd(deps: RuntimeDoctorDeps): Promise<DoctorCheck> {
  const target = `gui/${deps.uid}/${HERMES_LAUNCHD_LABEL}`;
  const print = await deps.exec('launchctl', ['print', target]);
  if (print.exitCode !== 0) {
    return {
      name: 'launchd',
      status: 'warn',
      summary: `${HERMES_LAUNCHD_LABEL} is not loaded in launchd`,
      details: { target, stderr: print.stderr.trim() },
      remediation: ['Run: hermes doctor --install-launchd', `Or load manually: launchctl load ${launchAgentPath(deps.homedir)}`],
    };
  }
  const parsed = parseLaunchctlPrint(print.stdout);
  const status: DoctorStatus = parsed.state === 'running' ? 'ok' : 'warn';
  return {
    name: 'launchd',
    status,
    summary: parsed.state === 'running'
      ? `${HERMES_LAUNCHD_LABEL} is running under launchd`
      : `${HERMES_LAUNCHD_LABEL} is loaded but not running`,
    details: { target, ...parsed },
    remediation: status === 'ok' ? undefined : [`Run: launchctl kickstart -k ${target}`],
  };
}

export function launchAgentPath(homedir: string): string {
  return path.join(homedir, 'Library', 'LaunchAgents', `${HERMES_LAUNCHD_LABEL}.plist`);
}

function defaultNodeExtraCaCerts(deps: RuntimeDoctorDeps, requested?: string): string | undefined {
  return requested ?? deps.env.NODE_EXTRA_CA_CERTS ?? path.join(deps.homedir, '.claude', 'combined-ca-certs.pem');
}

function extractPlistNodeExtraCaCerts(plist: string): string | undefined {
  const match = plist.match(/<key>NODE_EXTRA_CA_CERTS<\/key>\s*<string>([^<]+)<\/string>/);
  return match?.[1]?.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}

async function inspectNodeExtraCaCerts(deps: RuntimeDoctorDeps, requested?: string): Promise<DoctorCheck> {
  const plistPath = launchAgentPath(deps.homedir);
  let plist: string;
  try {
    plist = await deps.readFile(plistPath);
  } catch {
    return {
      name: 'node-extra-ca-certs',
      status: 'warn',
      summary: 'LaunchAgent plist is missing; cannot verify NODE_EXTRA_CA_CERTS',
      details: { plistPath },
      remediation: ['Run: hermes doctor --install-launchd', 'If corporate TLS interception is required, set NODE_EXTRA_CA_CERTS or pass --node-extra-ca-certs.'],
    };
  }

  const expected = defaultNodeExtraCaCerts(deps, requested);
  const actual = extractPlistNodeExtraCaCerts(plist);
  const expectedExists = expected ? await deps.access(expected).then(() => true, () => false) : false;
  if (!actual) {
    return {
      name: 'node-extra-ca-certs',
      status: 'warn',
      summary: 'LaunchAgent plist does not set NODE_EXTRA_CA_CERTS',
      details: { plistPath, expected, expectedExists },
      remediation: ['Run: hermes doctor --install-launchd after exporting NODE_EXTRA_CA_CERTS, or pass --node-extra-ca-certs <path>.'],
    };
  }
  if (expected && expectedExists && actual !== expected) {
    return {
      name: 'node-extra-ca-certs',
      status: 'warn',
      summary: 'LaunchAgent NODE_EXTRA_CA_CERTS differs from the expected certificate bundle',
      details: { plistPath, expected, actual },
      remediation: [`Run: hermes doctor --install-launchd --node-extra-ca-certs ${expected}`],
    };
  }
  const actualExists = await deps.access(actual).then(() => true, () => false);
  return {
    name: 'node-extra-ca-certs',
    status: actualExists ? 'ok' : 'warn',
    summary: actualExists ? 'LaunchAgent NODE_EXTRA_CA_CERTS is configured' : 'LaunchAgent NODE_EXTRA_CA_CERTS points to a missing file',
    details: { plistPath, actual, actualExists },
    remediation: actualExists ? undefined : ['Update the plist with a valid certificate bundle path using hermes doctor --install-launchd --node-extra-ca-certs <path>.'],
  };
}

async function fetchWithTimeout(deps: RuntimeDoctorDeps, url: string, init: Parameters<RuntimeDoctorDeps['fetch']>[1] = {}, timeoutMs = 2_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await deps.fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function inspectHttpHealth(host: string, port: number, deps: RuntimeDoctorDeps): Promise<DoctorCheck> {
  const url = `http://${host}:${port}/health`;
  try {
    const response = await fetchWithTimeout(deps, url);
    const body = await response.json().catch(() => ({}));
    const ok = response.ok && (body as { status?: unknown }).status === 'ok';
    return {
      name: 'http-health',
      status: ok ? 'ok' : 'fail',
      summary: ok ? '/health returned ok' : `/health returned HTTP ${response.status}`,
      details: { url, status: response.status, body },
      remediation: ok ? undefined : ['If listener is orphaned, run hermes doctor --recover-orphan; otherwise inspect broker logs.'],
    };
  } catch (err) {
    return {
      name: 'http-health',
      status: 'fail',
      summary: `/health is unreachable: ${(err as Error).message}`,
      details: { url },
      remediation: ['Confirm launchd is running and no stale listener owns the port.'],
    };
  }
}

async function inspectMcpToolsList(host: string, port: number, deps: RuntimeDoctorDeps): Promise<DoctorCheck> {
  const url = `http://${host}:${port}/mcp`;
  try {
    const response = await fetchWithTimeout(deps, url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const body = await response.json().catch(() => ({}));
    const tools = (body as { result?: { tools?: Array<{ name?: string }> } }).result?.tools ?? [];
    const ok = response.ok && tools.some((tool) => tool.name === 'hermes_status');
    return {
      name: 'mcp-tools-list',
      status: ok ? 'ok' : 'fail',
      summary: ok ? 'Stateless MCP tools/list returned Hermes tools' : 'Stateless MCP tools/list failed',
      details: { url, status: response.status, toolCount: tools.length, body: ok ? undefined : body },
      remediation: ok ? undefined : ['Restart the broker via launchd after resolving listener classification.'],
    };
  } catch (err) {
    return {
      name: 'mcp-tools-list',
      status: 'fail',
      summary: `Stateless MCP tools/list is unreachable: ${(err as Error).message}`,
      details: { url },
      remediation: ['Inspect listener and launchd checks first.'],
    };
  }
}

async function inspectTokenHealth(host: string, port: number, deps: RuntimeDoctorDeps): Promise<DoctorCheck> {
  const url = `http://${host}:${port}/mcp`;
  try {
    const response = await fetchWithTimeout(deps, url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'hermes_token_health', arguments: {} } }),
    });
    const body = await response.json().catch(() => ({}));
    const text = (body as { result?: { content?: Array<{ text?: string }> } }).result?.content?.[0]?.text;
     const parsed = text ? JSON.parse(text) as {
       status?: string;
       tokens?: Array<{ service?: string; scheme?: string; status?: string }>;
       operator?: { status?: string; summary?: string; nextAction?: string; degradedServices?: unknown[] };
     } : {};
     const tokens = parsed.tokens ?? [];
     const degraded = parsed.status === 'degraded'
       || parsed.operator?.status === 'degraded'
       || tokens.filter((token) => token.status && token.status !== 'healthy');
     const degradedTokens = Array.isArray(degraded) ? degraded : [];
     const ok = response.ok && parsed.status !== 'degraded' && parsed.operator?.status !== 'degraded' && degradedTokens.length === 0;
     return {
       name: 'token-health',
       status: ok ? 'ok' : 'warn',
       summary: ok
         ? 'Token health has no degraded entries'
         : parsed.operator?.summary ?? 'Token health reports degraded entries',
       details: {
         status: response.status,
         tokenCount: tokens.length,
         degradedTokens,
         brokerStatus: parsed.status,
         operator: parsed.operator,
       },
       remediation: ok ? undefined : [parsed.operator?.nextAction ?? 'Do not delete credentials. For expired refresh tokens, run: hermes acquire <service>.'],
     };
  } catch (err) {
    return {
      name: 'token-health',
      status: 'warn',
      summary: `Token health check could not run: ${(err as Error).message}`,
      details: { url },
      remediation: ['Resolve MCP tools/list first, then re-run hermes doctor.'],
    };
  }
}

interface CredentialHealthEntry {
  service?: string;
  scheme?: string;
  healthy?: boolean;
  blockedBy?: string;
  retryAfterMs?: number;
  proactiveRefresh?: { disarmed?: boolean; consecutiveFailures?: number };
  nextAction?: string;
}

/**
 * Credential-degradation check, the operator-facing companion to the
 * http-health liveness check.
 *
 * These are deliberately SEPARATE probes. GET /health is a pure liveness probe
 * that fleetd supervises, so credential state may never reach its status code;
 * GET /health/credentials is the route that MAY go red. Without this check an
 * operator running `hermes doctor` would see a healthy broker while a
 * credential sits disarmed or cooled down, which is exactly the signal the
 * liveness split removed from http-health.
 *
 * Bearer-authed with the client token the broker wrote at init, read from the
 * data dir the same way every other CLI consumer reads it.
 *
 * COMPATIBILITY: a doctor built from this source may run against an OLDER
 * broker with no such route. A 404 is reported as ok-and-unavailable, never as
 * a failure or a warning, because `runRuntimeDoctor` gates its exit code on
 * every check being exactly 'ok'; degrading an older-but-fine broker into a
 * non-zero exit would be noise reported as failure.
 */
async function inspectCredentialHealth(dataDir: string, host: string, port: number, deps: RuntimeDoctorDeps): Promise<DoctorCheck> {
  const url = `http://${host}:${port}/health/credentials`;
  let clientToken: string;
  try {
    clientToken = (await deps.readFile(path.join(dataDir, 'client.token'))).trim();
    if (!clientToken) throw new Error('client token file is empty');
  } catch (err) {
    return {
      name: 'credential-health',
      status: 'warn',
      summary: `Credential health check could not run: ${(err as Error).message}`,
      details: { url },
      remediation: ['Run hermes init to create the client token, then re-run hermes doctor.'],
    };
  }

  try {
    const response = await fetchWithTimeout(deps, url, {
      headers: { authorization: `Bearer ${clientToken}` },
    });

    if (response.status === 404) {
      return {
        name: 'credential-health',
        status: 'ok',
        summary: 'Credential health endpoint is not available; this broker predates /health/credentials',
        details: { url, status: 404 },
      };
    }
    if (response.status === 401) {
      return {
        name: 'credential-health',
        status: 'warn',
        summary: 'Credential health check was rejected: the client token did not match the running broker',
        details: { url, status: 401 },
        remediation: ['The running broker was started with a different client token. Restart it via launchd so it reloads the current one.'],
      };
    }

    const body = await response.json().catch(() => ({})) as {
      status?: string;
      total?: number;
      degraded?: number;
      disarmed?: number;
      credentials?: CredentialHealthEntry[];
    };
    const entries = body.credentials ?? [];
    const degraded = entries.filter((entry) => entry.healthy === false);
    if (body.status === undefined) {
      return {
        name: 'credential-health',
        status: 'warn',
        summary: `Credential health returned HTTP ${response.status} with no readable body`,
        details: { url, status: response.status },
        remediation: ['Inspect the http-health and mcp checks first, then re-run hermes doctor.'],
      };
    }
    if (degraded.length === 0) {
      return {
        name: 'credential-health',
        status: 'ok',
        summary: `All ${body.total ?? entries.length} credential(s) can be refreshed`,
        details: { url, status: response.status, total: body.total, disarmed: body.disarmed },
      };
    }

    // Name each degraded credential and WHY, so the summary is actionable on its own.
    const described = degraded.map((entry) => {
      const name = `${entry.service ?? 'unknown'}/${entry.scheme ?? 'unknown'}`;
      if (entry.proactiveRefresh?.disarmed === true) return `${name} (background refresh disarmed)`;
      return entry.blockedBy ? `${name} (blocked by ${entry.blockedBy})` : name;
    });
    // Prefer the exact command the broker already computed for a disarm.
    const remediation = Array.from(new Set(degraded.map((entry) => entry.nextAction).filter((action): action is string => typeof action === 'string' && action.length > 0)));
    return {
      name: 'credential-health',
      status: 'warn',
      summary: `${degraded.length} of ${body.total ?? entries.length} credential(s) degraded: ${described.join(', ')}`,
      details: {
        url,
        status: response.status,
        total: body.total,
        degraded: body.degraded,
        disarmed: body.disarmed,
        degradedCredentials: degraded,
      },
      remediation: remediation.length > 0
        ? remediation
        : ['Do not delete credentials. Inspect the blocked reason above; a cooldown or budget window clears on its own, a disarm needs: hermes acquire <service>.'],
    };
  } catch (err) {
    return {
      name: 'credential-health',
      status: 'warn',
      summary: `Credential health check could not run: ${(err as Error).message}`,
      details: { url },
      remediation: ['Resolve the listener and http-health checks first, then re-run hermes doctor.'],
    };
  }
}

async function inspectStartupLogs(dataDir: string, deps: RuntimeDoctorDeps): Promise<DoctorCheck> {
  const stderrPath = path.join(dataDir, 'logs', 'hermes-stderr.log');
  const tail = await deps.exec('tail', ['-n', '80', stderrPath]);
  if (tail.exitCode !== 0) {
    return {
      name: 'startup-logs',
      status: 'warn',
      summary: 'Startup log is not readable yet',
      details: { stderrPath, stderr: tail.stderr.trim() },
      remediation: ['After launchd starts Hermes, re-run hermes doctor.'],
    };
  }
  const hasHttp = tail.stdout.includes('http listening');
  const hasMcp = tail.stdout.includes('mcp endpoint ready at /mcp');
  return {
    name: 'startup-logs',
    status: hasHttp && hasMcp ? 'ok' : 'warn',
    summary: hasHttp && hasMcp ? 'Startup logs show HTTP and MCP readiness' : 'Startup logs do not show full readiness',
    details: { stderrPath, hasHttp, hasMcp },
    remediation: hasHttp && hasMcp ? undefined : ['Inspect the recent stderr log for startup failures.'],
  };
}

export function generateLaunchdPlist(options: {
  dataDir: string;
  nodePath: string;
  brokerCliPath: string;
  nodeExtraCaCerts?: string;
}): string {
  const envBlock = options.nodeExtraCaCerts ? `
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_EXTRA_CA_CERTS</key>
    <string>${xmlEscape(options.nodeExtraCaCerts)}</string>
  </dict>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${HERMES_LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(options.nodePath)}</string>
    <string>${xmlEscape(options.brokerCliPath)}</string>
    <string>start</string>
    <string>--data-dir</string>
    <string>${xmlEscape(options.dataDir)}</string>
  </array>${envBlock}
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(path.join(options.dataDir, 'logs', 'hermes-stdout.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(path.join(options.dataDir, 'logs', 'hermes-stderr.log'))}</string>
</dict>
</plist>
`;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

async function installLaunchd(options: RuntimeDoctorOptions, deps: RuntimeDoctorDeps): Promise<DoctorAction> {
  const plistPath = launchAgentPath(deps.homedir);
  const caCandidate = defaultNodeExtraCaCerts(deps, options.nodeExtraCaCerts);
  const caExists = caCandidate ? await deps.access(caCandidate).then(() => true, () => false) : false;
  const nodeExtraCaCerts = caExists ? caCandidate : undefined;
  await deps.mkdir(path.dirname(plistPath), { recursive: true });
  await deps.mkdir(path.join(options.dataDir, 'logs'), { recursive: true });
  const plist = generateLaunchdPlist({
    dataDir: options.dataDir,
    nodePath: deps.execPath,
    brokerCliPath: deps.brokerCliPath,
    nodeExtraCaCerts,
  });
  await deps.writeFile(plistPath, plist, { mode: 0o644 });

  const target = `gui/${deps.uid}/${HERMES_LAUNCHD_LABEL}`;
  const loaded = await deps.exec('launchctl', ['print', target]);
  const launch = loaded.exitCode === 0
    ? await deps.exec('launchctl', ['kickstart', '-k', target])
    : await deps.exec('launchctl', ['load', plistPath]);
  return {
    name: 'install-launchd',
    status: launch.exitCode === 0 ? 'ok' : 'warn',
    summary: launch.exitCode === 0 ? 'LaunchAgent plist installed/updated' : 'LaunchAgent plist written but launchctl returned a warning',
    details: { plistPath, target, nodeExtraCaCerts, launchctlExitCode: launch.exitCode, stderr: launch.stderr.trim() },
  };
}

async function recoverOrphan(listener: ListenerState, options: RuntimeDoctorOptions, deps: RuntimeDoctorDeps): Promise<DoctorAction> {
  if (listener.orphanPids.length !== 1) {
    return {
      name: 'recover-orphan',
      status: 'fail',
      summary: 'Recovery requires exactly one classified Hermes orphan listener',
      details: { classification: listener.classification, orphanPids: listener.orphanPids },
    };
  }
  const pid = listener.orphanPids[0]!;
  const stderrTail = await deps.exec('tail', ['-n', '200', path.join(options.dataDir, 'logs', 'hermes-stderr.log')]);
  const brokerTail = await deps.exec('tail', ['-n', '200', path.join(options.dataDir, 'broker.log')]);

  deps.killPid(pid, 'SIGTERM');
  let released = false;
  for (let i = 0; i < 5; i += 1) {
    await deps.sleep(2_000);
    const current = await inspectListener(options.host, options.port, deps);
    if (!current.state.processes.some((proc) => proc.pid === pid)) {
      released = true;
      break;
    }
  }
  if (!released) {
    return {
      name: 'recover-orphan',
      status: 'fail',
      summary: `Sent SIGTERM to PID ${pid}, but it still appears to own the listener`,
      details: { pid },
    };
  }

  const target = `gui/${deps.uid}/${HERMES_LAUNCHD_LABEL}`;
  const kickstart = await deps.exec('launchctl', ['kickstart', '-k', target]);
  return {
    name: 'recover-orphan',
    status: kickstart.exitCode === 0 ? 'ok' : 'warn',
    summary: kickstart.exitCode === 0
      ? `Recovered orphan listener PID ${pid} and kickstarted launchd`
      : `Recovered orphan listener PID ${pid}, but launchctl kickstart returned a warning`,
    details: {
      pid,
      target,
      kickstartExitCode: kickstart.exitCode,
      kickstartStderr: kickstart.stderr.trim(),
      capturedLogs: {
        stderrLines: stderrTail.stdout ? stderrTail.stdout.split(/\r?\n/).filter(Boolean).length : 0,
        brokerLines: brokerTail.stdout ? brokerTail.stdout.split(/\r?\n/).filter(Boolean).length : 0,
      },
    },
  };
}

async function inspectRuntime(options: RuntimeDoctorOptions, deps: RuntimeDoctorDeps): Promise<{ checks: DoctorCheck[]; listener: ListenerState }> {
  const listenerCheck = await inspectListener(options.host, options.port, deps);
  const checks: DoctorCheck[] = [
    listenerCheck,
    await inspectLaunchd(deps),
    await inspectHttpHealth(options.host, options.port, deps),
    await inspectMcpToolsList(options.host, options.port, deps),
    await inspectTokenHealth(options.host, options.port, deps),
    await inspectCredentialHealth(options.dataDir, options.host, options.port, deps),
    await inspectNodeExtraCaCerts(deps, options.nodeExtraCaCerts),
    await inspectStartupLogs(options.dataDir, deps),
  ];
  return { checks, listener: listenerCheck.state };
}

export async function runRuntimeDoctor(options: RuntimeDoctorOptions, deps: RuntimeDoctorDeps = defaultDeps()): Promise<DoctorReport> {
  const actions: DoctorAction[] = [];
  if (options.installLaunchd) actions.push(await installLaunchd(options, deps));

  let inspected = await inspectRuntime(options, deps);
  if (options.recoverOrphan) {
    actions.push(await recoverOrphan(inspected.listener, options, deps));
    inspected = await inspectRuntime(options, deps);
  }

  const ok = [...actions, ...inspected.checks].every((entry) => entry.status === 'ok');
  return { ok, actions, checks: inspected.checks };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  for (const action of report.actions) {
    lines.push(`${symbol(action.status)} action ${action.name}: ${action.summary}`);
  }
  for (const check of report.checks) {
    lines.push(`${symbol(check.status)} ${check.name}: ${check.summary}`);
    for (const item of check.remediation ?? []) lines.push(`  remediation: ${item}`);
  }
  const firstRemediation = [...report.actions, ...report.checks]
    .find((entry) => entry.status !== 'ok' && 'remediation' in entry && Array.isArray(entry.remediation)) as DoctorCheck | undefined;
  if (firstRemediation?.remediation?.[0]) lines.push(`Next action: ${firstRemediation.remediation[0]}`);
  lines.push(report.ok ? 'Hermes doctor: ok' : 'Hermes doctor: attention required');
  return lines.join('\n');
}

function symbol(status: DoctorStatus): string {
  if (status === 'ok') return '✓';
  if (status === 'warn') return '!';
  return '✗';
}
