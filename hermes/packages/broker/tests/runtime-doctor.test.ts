import { describe, expect, it, vi } from 'vitest';
import {
  classifyListenerState,
  formatDoctorReport,
  generateLaunchdPlist,
  parseLsofPids,
  parsePsOutput,
  runRuntimeDoctor,
  type CommandResult,
  type RuntimeDoctorDeps,
} from '../src/runtime-doctor.js';

const dataDir = '/Users/testuser/.hermes';
const brokerCommand = 'node /Users/testuser/Projects/hermes/packages/broker/dist/cli.js start --data-dir /Users/testuser/.hermes';

function response(body: unknown, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: vi.fn(async () => body),
    text: vi.fn(async () => JSON.stringify(body)),
  };
}

function healthyFetch() {
  return vi.fn(async (_url: string, init?: { body?: string }) => {
    const request = init?.body ? JSON.parse(init.body) as { method?: string; params?: { name?: string } } : {};
    if (!request.method) return response({ status: 'ok' });
    if (request.method === 'tools/list') {
      return response({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'hermes_status' }] } });
    }
    if (request.method === 'tools/call' && request.params?.name === 'hermes_token_health') {
      return response({
        jsonrpc: '2.0',
        id: 2,
        result: { content: [{ type: 'text', text: JSON.stringify({ tokens: [{ service: 'ms365', scheme: 'graph', status: 'healthy' }] }) }] },
      });
    }
    return response({}, 400);
  });
}

function degradedOperatorFetch() {
  return vi.fn(async (_url: string, init?: { body?: string }) => {
    const request = init?.body ? JSON.parse(init.body) as { method?: string; params?: { name?: string } } : {};
    if (!request.method) return response({ status: 'ok' });
    if (request.method === 'tools/list') {
      return response({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'hermes_status' }] } });
    }
    if (request.method === 'tools/call' && request.params?.name === 'hermes_token_health') {
      return response({
        jsonrpc: '2.0',
        id: 2,
        result: { content: [{ type: 'text', text: JSON.stringify({
          tokens: [{ service: 'ms365', scheme: 'graph', status: 'healthy' }],
          operator: {
            status: 'degraded',
            summary: '1 of 1 auth service(s) degraded',
            nextAction: 'Run: hermes acquire ms365. Do not delete or rotate stored credentials.',
            degradedServices: [{ service: 'ms365', scheme: 'graph' }],
          },
        }) }] },
      });
    }
    return response({}, 400);
  });
}

const CLIENT_TOKEN_FILE = '/Users/testuser/.hermes/client.token';
/** Synthetic, clearly-fake client token for the doctor harness. */
const SYNTHETIC_CLIENT_TOKEN = 'synthetic-doctor-client-token';

/**
 * Wrap the healthy fetch so GET /health/credentials answers with `credentials`,
 * leaving every other route (liveness, MCP) on the healthy stub.
 */
function fetchWithCredentialHealth(credentials: unknown, status = 200) {
  const base = healthyFetch();
  return vi.fn(async (url: string, init?: { body?: string }) => {
    if (url.endsWith('/health/credentials')) return response(credentials, status);
    return base(url, init);
  });
}

/** readFile stub that serves the client token for the token file and the plist otherwise. */
function readFileWithClientToken(plistValue: () => string) {
  return vi.fn(async (file: string) => (file === CLIENT_TOKEN_FILE ? SYNTHETIC_CLIENT_TOKEN : plistValue()));
}

function makeDeps(overrides: Partial<RuntimeDoctorDeps> = {}): RuntimeDoctorDeps {
  let plist = generateLaunchdPlist({
    dataDir,
    nodePath: '/usr/local/bin/node',
    brokerCliPath: '/Users/testuser/Projects/hermes/packages/broker/dist/cli.js',
    nodeExtraCaCerts: '/Users/testuser/.claude/combined-ca-certs.pem',
  });
  const exec = vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
    if (command === 'lsof') {
      return { exitCode: 0, stdout: 'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nnode 123 testuser 10u IPv4 0t0 TCP 127.0.0.1:9876 (LISTEN)\n', stderr: '' };
    }
    if (command === 'ps') return { exitCode: 0, stdout: `123 1 02:03:04 ${brokerCommand}\n`, stderr: '' };
    if (command === 'launchctl' && args[0] === 'print') return { exitCode: 0, stdout: 'state = running\npid = 456\n', stderr: '' };
    if (command === 'launchctl') return { exitCode: 0, stdout: '', stderr: '' };
    if (command === 'tail') return { exitCode: 0, stdout: 'http listening\nmcp endpoint ready at /mcp\n', stderr: '' };
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  return {
    exec,
    fetch: healthyFetch() as RuntimeDoctorDeps['fetch'],
    readFile: vi.fn(async () => plist),
    writeFile: vi.fn(async (_file: string, data: string) => { plist = data; }),
    mkdir: vi.fn(async () => undefined),
    access: vi.fn(async (file: string) => {
      if (file === '/Users/testuser/.claude/combined-ca-certs.pem') return;
      throw new Error('missing');
    }),
    killPid: vi.fn(),
    sleep: vi.fn(async () => undefined),
    env: { NODE_EXTRA_CA_CERTS: '/Users/testuser/.claude/combined-ca-certs.pem' },
    homedir: '/Users/testuser',
    uid: 501,
    execPath: '/usr/local/bin/node',
    brokerCliPath: '/Users/testuser/Projects/hermes/packages/broker/dist/cli.js',
    ...overrides,
  };
}

describe('runtime doctor classification', () => {
  it('parses lsof and ps output', () => {
    expect(parseLsofPids('COMMAND PID USER\nnode 123 testuser\nnode 123 testuser\n')).toEqual([123]);
    expect(parsePsOutput(`123 1 01:02:03 ${brokerCommand}`)).toMatchObject({
      pid: 123,
      ppid: 1,
      elapsed: '01:02:03',
      command: brokerCommand,
    });
  });

  it('classifies a PPID 1 Hermes listener as an orphan', () => {
    const state = classifyListenerState([{ pid: 123, ppid: 1, command: brokerCommand }]);
    expect(state.classification).toBe('hermes-orphan');
    expect(state.orphanPids).toEqual([123]);
  });

  it('classifies non-Hermes listeners as foreign', () => {
    const state = classifyListenerState([{ pid: 999, ppid: 1, command: 'python -m http.server 9876' }]);
    expect(state.classification).toBe('foreign-listener');
    expect(state.orphanPids).toEqual([]);
  });
});

describe('runRuntimeDoctor', () => {
  it('reports orphan remediation without killing by default', async () => {
    const deps = makeDeps();
    const report = await runRuntimeDoctor({ dataDir, host: '127.0.0.1', port: 9876 }, deps);
    const listener = report.checks.find((check) => check.name === 'listener');
    expect(listener).toMatchObject({ status: 'warn' });
    expect(listener?.remediation?.join('\n')).toContain('hermes doctor --recover-orphan');
    expect(deps.killPid).not.toHaveBeenCalled();
  });

  it('recovers only one explicitly classified orphan PID when requested', async () => {
    let recovered = false;
    const deps = makeDeps({
      exec: vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
        if (command === 'lsof') {
          const pid = recovered ? 456 : 123;
          return { exitCode: 0, stdout: `COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nnode ${pid} testuser 10u IPv4 0t0 TCP 127.0.0.1:9876 (LISTEN)\n`, stderr: '' };
        }
        if (command === 'ps' && args.at(-1) === '123') return { exitCode: 0, stdout: `123 1 02:03:04 ${brokerCommand}\n`, stderr: '' };
        if (command === 'ps' && args.at(-1) === '456') return { exitCode: 0, stdout: `456 100 00:00:02 ${brokerCommand}\n`, stderr: '' };
        if (command === 'launchctl' && args[0] === 'print') return { exitCode: 0, stdout: 'state = running\npid = 456\n', stderr: '' };
        if (command === 'launchctl' && args[0] === 'kickstart') return { exitCode: 0, stdout: '', stderr: '' };
        if (command === 'tail') return { exitCode: 0, stdout: 'http listening\nmcp endpoint ready at /mcp\n', stderr: '' };
        return { exitCode: 0, stdout: '', stderr: '' };
      }),
      killPid: vi.fn(() => { recovered = true; }),
    });

    const report = await runRuntimeDoctor({ dataDir, host: '127.0.0.1', port: 9876, recoverOrphan: true }, deps);
    expect(deps.killPid).toHaveBeenCalledWith(123, 'SIGTERM');
    expect(report.actions.find((action) => action.name === 'recover-orphan')).toMatchObject({ status: 'ok' });
    expect(report.checks.find((check) => check.name === 'listener')).toMatchObject({ status: 'ok' });
  });

  it('installs launchd plist with NODE_EXTRA_CA_CERTS when explicitly requested', async () => {
    let written = '';
    const deps = makeDeps({
      writeFile: vi.fn(async (_file: string, data: string) => { written = data; }),
      readFile: vi.fn(async () => written),
      exec: vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
        if (command === 'launchctl' && args[0] === 'print') return { exitCode: 1, stdout: '', stderr: 'not loaded' };
        if (command === 'launchctl' && args[0] === 'load') return { exitCode: 0, stdout: '', stderr: '' };
        if (command === 'lsof') return { exitCode: 1, stdout: 'COMMAND PID USER\n', stderr: '' };
        if (command === 'tail') return { exitCode: 0, stdout: 'http listening\nmcp endpoint ready at /mcp\n', stderr: '' };
        return { exitCode: 0, stdout: '', stderr: '' };
      }),
    });

    const report = await runRuntimeDoctor({
      dataDir,
      host: '127.0.0.1',
      port: 9876,
      installLaunchd: true,
      nodeExtraCaCerts: '/Users/testuser/.claude/combined-ca-certs.pem',
    }, deps);

    expect(written).toContain('<key>NODE_EXTRA_CA_CERTS</key>');
    expect(written).toContain('/Users/testuser/.claude/combined-ca-certs.pem');
    expect(report.actions.find((action) => action.name === 'install-launchd')).toMatchObject({ status: 'ok' });
  });

  it('reports the NODE_EXTRA_CA_CERTS plist gap', async () => {
    const deps = makeDeps({
      readFile: vi.fn(async () => generateLaunchdPlist({
        dataDir,
        nodePath: '/usr/local/bin/node',
        brokerCliPath: '/Users/testuser/Projects/hermes/packages/broker/dist/cli.js',
      })),
    });

    const report = await runRuntimeDoctor({ dataDir, host: '127.0.0.1', port: 9876 }, deps);
    const caCheck = report.checks.find((check) => check.name === 'node-extra-ca-certs');
    expect(caCheck).toMatchObject({ status: 'warn' });
    expect(caCheck?.summary).toContain('does not set NODE_EXTRA_CA_CERTS');
  });

  it('surfaces auth operator next action from token health', async () => {
    const deps = makeDeps({ fetch: degradedOperatorFetch() as RuntimeDoctorDeps['fetch'] });
    const report = await runRuntimeDoctor({ dataDir, host: '127.0.0.1', port: 9876 }, deps);
    const tokenHealth = report.checks.find((check) => check.name === 'token-health');
    expect(tokenHealth).toMatchObject({
      status: 'warn',
      summary: '1 of 1 auth service(s) degraded',
      remediation: ['Run: hermes acquire ms365. Do not delete or rotate stored credentials.'],
    });
    expect(formatDoctorReport(report)).toContain('remediation: Run: hermes acquire ms365');
  });
});

// The credential-degradation signal that the /health liveness split removed
// from http-health. Without this check an operator sees a healthy broker while
// a credential sits disarmed or cooled down.
describe('runRuntimeDoctor credential health', () => {
  const plist = () => '<plist/>';

  it('reports a disarmed credential with the exact recovery command', async () => {
    const deps = makeDeps({
      readFile: readFileWithClientToken(plist),
      fetch: fetchWithCredentialHealth({
        status: 'degraded',
        total: 2,
        degraded: 1,
        disarmed: 1,
        credentials: [
          { service: 'ms365', scheme: 'graph', healthy: true, proactiveRefresh: { disarmed: false, consecutiveFailures: 0 } },
          {
            service: 'servicenow', scheme: 'session', healthy: false,
            proactiveRefresh: { disarmed: true, consecutiveFailures: 2 },
            nextAction: 'hermes acquire servicenow',
          },
        ],
      }, 503) as RuntimeDoctorDeps['fetch'],
    });
    const report = await runRuntimeDoctor({ dataDir, host: '127.0.0.1', port: 9876 }, deps);
    const check = report.checks.find((c) => c.name === 'credential-health');
    expect(check).toMatchObject({ status: 'warn', remediation: ['hermes acquire servicenow'] });
    expect(check?.summary).toContain('servicenow/session (background refresh disarmed)');
    expect(check?.summary).toContain('1 of 2');
  });

  it('names the blocking gate when a credential is cooled down rather than disarmed', async () => {
    const deps = makeDeps({
      readFile: readFileWithClientToken(plist),
      fetch: fetchWithCredentialHealth({
        status: 'degraded', total: 1, degraded: 1, disarmed: 0,
        credentials: [{
          service: 'ms365', scheme: 'graph', healthy: false,
          blockedBy: 'cooldown', retryAfterMs: 45_000,
          proactiveRefresh: { disarmed: false, consecutiveFailures: 1 },
        }],
      }, 503) as RuntimeDoctorDeps['fetch'],
    });
    const report = await runRuntimeDoctor({ dataDir, host: '127.0.0.1', port: 9876 }, deps);
    const check = report.checks.find((c) => c.name === 'credential-health');
    expect(check?.status).toBe('warn');
    expect(check?.summary).toContain('ms365/graph (blocked by cooldown)');
  });

  it('passes when every credential can be refreshed', async () => {
    const deps = makeDeps({
      readFile: readFileWithClientToken(plist),
      fetch: fetchWithCredentialHealth({
        status: 'ok', total: 3, degraded: 0, disarmed: 0,
        credentials: [
          { service: 'ms365', scheme: 'graph', healthy: true },
          { service: 'ms365', scheme: 'teams', healthy: true },
          { service: 'servicenow', scheme: 'session', healthy: true },
        ],
      }) as RuntimeDoctorDeps['fetch'],
    });
    const report = await runRuntimeDoctor({ dataDir, host: '127.0.0.1', port: 9876 }, deps);
    const check = report.checks.find((c) => c.name === 'credential-health');
    expect(check).toMatchObject({ status: 'ok' });
    expect(check?.summary).toContain('All 3 credential(s)');
  });

  // Compatibility: this doctor may run against a broker that predates the
  // endpoint. runRuntimeDoctor gates report.ok on every check being exactly
  // 'ok', so a 404 must not report as fail OR warn; noise reported as failure
  // would make the exit code lie about an otherwise-fine older broker.
  it('degrades to ok, not failure, when the broker predates /health/credentials', async () => {
    const older = makeDeps({
      readFile: readFileWithClientToken(plist),
      fetch: fetchWithCredentialHealth({ error: 'Not Found' }, 404) as RuntimeDoctorDeps['fetch'],
    });
    const current = makeDeps({
      readFile: readFileWithClientToken(plist),
      fetch: fetchWithCredentialHealth({ status: 'ok', total: 0, degraded: 0, disarmed: 0, credentials: [] }) as RuntimeDoctorDeps['fetch'],
    });

    const olderReport = await runRuntimeDoctor({ dataDir, host: '127.0.0.1', port: 9876 }, older);
    const currentReport = await runRuntimeDoctor({ dataDir, host: '127.0.0.1', port: 9876 }, current);
    const check = olderReport.checks.find((c) => c.name === 'credential-health');

    expect(check?.status).toBe('ok');
    expect(check?.summary).toContain('predates /health/credentials');
    expect(check?.remediation).toBeUndefined();
    // The 404 adds no gating: the overall verdict matches a current broker.
    expect(olderReport.ok).toBe(currentReport.ok);
  });

  it('warns that the check could not run when the client token cannot be read', async () => {
    const deps = makeDeps({
      readFile: vi.fn(async (file: string) => {
        if (file === CLIENT_TOKEN_FILE) throw new Error('ENOENT: no such file');
        return plist();
      }),
    });
    const report = await runRuntimeDoctor({ dataDir, host: '127.0.0.1', port: 9876 }, deps);
    const check = report.checks.find((c) => c.name === 'credential-health');
    expect(check?.status).toBe('warn');
    expect(check?.summary).toContain('could not run');
  });
});
