import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { captureDebugState, redactPasswordValues, type CaptureablePage } from '../src/capture-debug-state.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePage(overrides: Partial<{
  url: () => string;
  screenshot: (opts: { path: string; fullPage?: boolean }) => Promise<Buffer | void>;
  content: () => Promise<string>;
}> = {}): CaptureablePage {
  return {
    url: () => 'https://example.com/login',
    screenshot: async (opts) => {
      // Write an empty buffer so the path actually exists
      await fs.writeFile(opts.path, Buffer.alloc(0));
    },
    content: async () => '<html><body>hello</body></html>',
    ...overrides,
  };
}

// Fixed timestamp for deterministic paths
const FIXED_NOW = 1700000000000; // 2023-11-14T22:13:20.000Z
const FIXED_TS = new Date(FIXED_NOW).toISOString().replace(/:/g, '-');
// → "2023-11-14T22-13-20.000Z"

let tmpDir = '';

afterEach(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    tmpDir = '';
  }
});

async function makeTmp(): Promise<string> {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-cap-'));
  return tmpDir;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('captureDebugState', () => {
  it('writes screenshot, dom, url, and step-log files at expected absolute paths', async () => {
    const baseDir = await makeTmp();
    const stepLog = [{ step: 'fill_email', ts: 1 }, { step: 'submit', ts: 2 }];

    const result = await captureDebugState({
      page: makePage(),
      reason: 'stall',
      service: 'servicenow',
      baseDir,
      stepLog,
      now: () => FIXED_NOW,
    });

    expect(result.errors).toEqual([]);

    const expectedDirPrefix = path.join(baseDir, 'diag', 'servicenow', FIXED_TS);
    // captureDir now includes a 4-char hex suffix: FIXED_TS-xxxx
    expect(result.captureDir).toMatch(new RegExp(`^${expectedDirPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-[0-9a-f]{4}$`));

    const captureDir = result.captureDir;
    expect(result.files.url).toBe(path.join(captureDir, 'url.txt'));
    expect(result.files.screenshot).toBe(path.join(captureDir, 'screenshot.png'));
    expect(result.files.dom).toBe(path.join(captureDir, 'dom.html'));
    expect(result.files.stepLog).toBe(path.join(captureDir, 'step-log.jsonl'));

    // Verify files are actually on disk
    await expect(fs.access(result.files.url!)).resolves.toBeUndefined();
    await expect(fs.access(result.files.screenshot!)).resolves.toBeUndefined();
    await expect(fs.access(result.files.dom!)).resolves.toBeUndefined();
    await expect(fs.access(result.files.stepLog!)).resolves.toBeUndefined();

    // Verify url.txt content
    const urlContent = await fs.readFile(result.files.url!, 'utf8');
    expect(urlContent).toBe('https://example.com/login');

    // Verify step-log.jsonl content
    const slContent = await fs.readFile(result.files.stepLog!, 'utf8');
    const lines = slContent.split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({ step: 'fill_email', ts: 1 });
    expect(JSON.parse(lines[1]!)).toEqual({ step: 'submit', ts: 2 });
  });

  it('creates parent directories if baseDir is brand new', async () => {
    const base = await makeTmp();
    const baseDir = path.join(base, 'deeply', 'nested', 'newdir');

    const result = await captureDebugState({
      page: makePage(),
      reason: 'test',
      service: 'svc',
      baseDir,
      now: () => FIXED_NOW,
    });

    expect(result.errors).toEqual([]);
    expect(result.captureDir).toContain(path.join(baseDir, 'diag', 'svc'));
    await expect(fs.access(result.files.url!)).resolves.toBeUndefined();
  });

  it('redacts <input type="password" value="hunter2">', async () => {
    const baseDir = await makeTmp();
    const html = '<html><body><input type="password" value="hunter2"></body></html>';

    const result = await captureDebugState({
      page: makePage({ content: async () => html }),
      reason: 'stall',
      service: 'sn',
      baseDir,
      now: () => FIXED_NOW,
    });

    expect(result.errors).toEqual([]);
    const dom = await fs.readFile(result.files.dom!, 'utf8');
    expect(dom).toContain('***REDACTED***');
    expect(dom).not.toContain('hunter2');
  });

  it('redacts by name attribute containing "passwd"', async () => {
    const baseDir = await makeTmp();
    const html = '<html><body><input name="passwd_new" value="leakme" type="text"></body></html>';

    const result = await captureDebugState({
      page: makePage({ content: async () => html }),
      reason: 'stall',
      service: 'sn',
      baseDir,
      now: () => FIXED_NOW,
    });

    expect(result.errors).toEqual([]);
    const dom = await fs.readFile(result.files.dom!, 'utf8');
    expect(dom).toContain('***REDACTED***');
    expect(dom).not.toContain('leakme');
  });

  it('redacts by name attribute containing "password"', async () => {
    const baseDir = await makeTmp();
    const html = '<html><body><input name="current_password" value="secret123" type="text"></body></html>';

    const result = await captureDebugState({
      page: makePage({ content: async () => html }),
      reason: 'stall',
      service: 'sn',
      baseDir,
      now: () => FIXED_NOW,
    });

    expect(result.errors).toEqual([]);
    const dom = await fs.readFile(result.files.dom!, 'utf8');
    expect(dom).toContain('***REDACTED***');
    expect(dom).not.toContain('secret123');
  });

  it('redacts by id attribute containing "password"', async () => {
    const baseDir = await makeTmp();
    const html = '<html><body><input id="user-password-field" value="leakme"></body></html>';

    const result = await captureDebugState({
      page: makePage({ content: async () => html }),
      reason: 'stall',
      service: 'sn',
      baseDir,
      now: () => FIXED_NOW,
    });

    expect(result.errors).toEqual([]);
    const dom = await fs.readFile(result.files.dom!, 'utf8');
    expect(dom).toContain('***REDACTED***');
    expect(dom).not.toContain('leakme');
  });

  it('does NOT redact inputs unrelated to passwords', async () => {
    const baseDir = await makeTmp();
    const html = '<html><body><input type="text" name="username" value="john_doe"></body></html>';

    const result = await captureDebugState({
      page: makePage({ content: async () => html }),
      reason: 'stall',
      service: 'sn',
      baseDir,
      now: () => FIXED_NOW,
    });

    expect(result.errors).toEqual([]);
    const dom = await fs.readFile(result.files.dom!, 'utf8');
    expect(dom).toContain('john_doe');
    expect(dom).not.toContain('***REDACTED***');
  });

  it('skips step-log file when stepLog is undefined', async () => {
    const baseDir = await makeTmp();

    const result = await captureDebugState({
      page: makePage(),
      reason: 'stall',
      service: 'sn',
      baseDir,
      stepLog: undefined,
      now: () => FIXED_NOW,
    });

    expect(result.errors).toEqual([]);
    expect(result.files.stepLog).toBeUndefined();
  });

  it('skips step-log file when stepLog is an empty array', async () => {
    const baseDir = await makeTmp();

    const result = await captureDebugState({
      page: makePage(),
      reason: 'stall',
      service: 'sn',
      baseDir,
      stepLog: [],
      now: () => FIXED_NOW,
    });

    expect(result.errors).toEqual([]);
    expect(result.files.stepLog).toBeUndefined();

    // The file must not exist on disk
    const stepLogPath = path.join(result.captureDir, 'step-log.jsonl');
    await expect(fs.access(stepLogPath)).rejects.toThrow();
  });

  it('returns errors entry (does NOT throw) when page.screenshot() rejects', async () => {
    const baseDir = await makeTmp();

    const result = await captureDebugState({
      page: makePage({
        screenshot: async () => { throw new Error('screenshot boom'); },
      }),
      reason: 'stall',
      service: 'sn',
      baseDir,
      now: () => FIXED_NOW,
    });

    expect(result.errors.some((e) => e.includes('screenshot failed'))).toBe(true);
    expect(result.errors.some((e) => e.includes('screenshot boom'))).toBe(true);
    expect(result.files.screenshot).toBeUndefined();
    // Other files should still be written
    expect(result.files.url).toBeDefined();
    expect(result.files.dom).toBeDefined();
  });

  it('returns errors entry (does NOT throw) when page.content() rejects', async () => {
    const baseDir = await makeTmp();

    const result = await captureDebugState({
      page: makePage({
        content: async () => { throw new Error('content boom'); },
      }),
      reason: 'stall',
      service: 'sn',
      baseDir,
      now: () => FIXED_NOW,
    });

    expect(result.errors.some((e) => e.includes('dom.html write failed'))).toBe(true);
    expect(result.errors.some((e) => e.includes('content boom'))).toBe(true);
    expect(result.files.dom).toBeUndefined();
    // Other files should still be written
    expect(result.files.url).toBeDefined();
    expect(result.files.screenshot).toBeDefined();
  });

  it('retention: with maxCaptures=2, oldest dir is deleted after 3rd capture', async () => {
    const baseDir = await makeTmp();
    const service = 'sn';

    // Three strictly-increasing timestamps (ISO lexicographic order = chronological)
    const t1 = 1700000000000;
    const t2 = 1700000001000;
    const t3 = 1700000002000;

    await captureDebugState({ page: makePage(), reason: 'r', service, baseDir, now: () => t1, maxCaptures: 2 });
    await captureDebugState({ page: makePage(), reason: 'r', service, baseDir, now: () => t2, maxCaptures: 2 });

    // Confirm both dirs exist after 2 captures
    const afterTwo = await fs.readdir(path.join(baseDir, 'diag', service));
    expect(afterTwo).toHaveLength(2);

    await captureDebugState({ page: makePage(), reason: 'r', service, baseDir, now: () => t3, maxCaptures: 2 });

    // After 3rd capture, oldest should be gone; exactly 2 remain
    const afterThree = await fs.readdir(path.join(baseDir, 'diag', service));
    expect(afterThree).toHaveLength(2);

    // Dir names now have a 4-char hex suffix: match by prefix
    const ts1 = new Date(t1).toISOString().replace(/:/g, '-');
    expect(afterThree.some((d) => d.startsWith(ts1))).toBe(false);

    const ts2 = new Date(t2).toISOString().replace(/:/g, '-');
    const ts3 = new Date(t3).toISOString().replace(/:/g, '-');
    expect(afterThree.some((d) => d.startsWith(ts2))).toBe(true);
    expect(afterThree.some((d) => d.startsWith(ts3))).toBe(true);
  });

  it('writes reason.txt with the reason string as first file', async () => {
    const baseDir = await makeTmp();

    const result = await captureDebugState({
      page: makePage(),
      reason: 'test-stall-reason',
      service: 'sn',
      baseDir,
      now: () => FIXED_NOW,
    });

    expect(result.errors).toEqual([]);
    expect(result.files.reason).toBeDefined();
    expect(result.files.reason).toBe(path.join(result.captureDir, 'reason.txt'));
    const content = await fs.readFile(result.files.reason!, 'utf8');
    expect(content).toBe('test-stall-reason');
  });

  it('BigInt stepLog entry produces _serializationError entry; valid entry is intact', async () => {
    const baseDir = await makeTmp();
    const bigIntEntry = { n: BigInt(1) } as unknown as Record<string, unknown>;
    const validEntry = { valid: true };

    const result = await captureDebugState({
      page: makePage(),
      reason: 'bigint-test',
      service: 'sn',
      baseDir,
      stepLog: [bigIntEntry, validEntry],
      now: () => FIXED_NOW,
    });

    expect(result.files.stepLog).toBeDefined();
    const content = await fs.readFile(result.files.stepLog!, 'utf8');
    const lines = content.split('\n');
    expect(lines).toHaveLength(2);
    const firstParsed = JSON.parse(lines[0]!);
    expect(firstParsed).toHaveProperty('_serializationError');
    const secondParsed = JSON.parse(lines[1]!);
    expect(secondParsed).toEqual({ valid: true });
  });

  it('same now() produces different captureDir paths (hex suffix differs)', async () => {
    const baseDir = await makeTmp();

    const result1 = await captureDebugState({
      page: makePage(),
      reason: 'r',
      service: 'sn',
      baseDir,
      now: () => FIXED_NOW,
    });
    const result2 = await captureDebugState({
      page: makePage(),
      reason: 'r',
      service: 'sn',
      baseDir,
      now: () => FIXED_NOW,
    });

    expect(result1.captureDir).not.toBe(result2.captureDir);
  });

  it('captureDir ends with -[0-9a-f]{4} hex suffix', async () => {
    const baseDir = await makeTmp();

    const result = await captureDebugState({
      page: makePage(),
      reason: 'r',
      service: 'sn',
      baseDir,
      now: () => FIXED_NOW,
    });

    expect(result.captureDir).toMatch(/-[0-9a-f]{4}$/);
  });

  it('retention self-exclude: new capture is preserved; older dir is deleted (maxCaptures=1)', async () => {
    const baseDir = await makeTmp();
    const service = 'sn';
    const t1 = 1700000000000;
    const t2 = 1700000001000;

    await captureDebugState({ page: makePage(), reason: 'r', service, baseDir, now: () => t1, maxCaptures: 1 });

    const result2 = await captureDebugState({ page: makePage(), reason: 'r', service, baseDir, now: () => t2, maxCaptures: 1 });

    const dirs = await fs.readdir(path.join(baseDir, 'diag', service));
    expect(dirs).toHaveLength(1);
    // The remaining dir must be the new one (t2), not the old one (t1)
    expect(dirs[0]).toBe(path.basename(result2.captureDir));

    const ts1 = new Date(t1).toISOString().replace(/:/g, '-');
    expect(dirs.some((d) => d.startsWith(ts1))).toBe(false);
  });

  it('orphan cleanup: captureDir persists when at least reason.txt is written', async () => {
    // When at least one file succeeds, orphan cleanup must NOT delete the dir
    const baseDir = await makeTmp();

    const result = await captureDebugState({
      page: makePage({
        screenshot: async () => { throw new Error('screenshot fail'); },
        content: async () => { throw new Error('content fail'); },
      }),
      reason: 'orphan-test',
      service: 'sn',
      baseDir,
      now: () => FIXED_NOW,
    });

    expect(result.files.reason).toBeDefined();
    // captureDir must still exist because reason.txt was written
    await expect(fs.access(result.captureDir)).resolves.toBeUndefined();
  });

  it('permissions: all files are mode 0600 and captureDir is mode 0700', async () => {
    // Skip when running as root (root ignores file mode restrictions)
    if (process.getuid?.() === 0) return;

    const baseDir = await makeTmp();
    const stepLog = [{ step: 'fill_email', ts: 1 }];

    const result = await captureDebugState({
      page: makePage(),
      reason: 'perm-test',
      service: 'sn',
      baseDir,
      stepLog,
      now: () => FIXED_NOW,
    });

    expect(result.errors).toEqual([]);

    const check = async (filePath: string | undefined, expectedMode: number) => {
      expect(filePath).toBeDefined();
      const stat = await fs.stat(filePath!);
      expect(stat.mode & 0o777).toBe(expectedMode);
    };

    await check(result.files.reason, 0o600);
    await check(result.files.url, 0o600);
    await check(result.files.dom, 0o600);
    await check(result.files.stepLog, 0o600);
    await check(result.files.screenshot, 0o600);

    const dirStat = await fs.stat(result.captureDir);
    expect(dirStat.mode & 0o777).toBe(0o700);
  });
});

// ---------------------------------------------------------------------------
// redactPasswordValues — extended coverage
// ---------------------------------------------------------------------------

describe('redactPasswordValues — extended', () => {
  it('still redacts <input type="password" value="hunter2">', () => {
    const html = '<input type="password" value="hunter2">';
    const out = redactPasswordValues(html);
    expect(out).toContain('***REDACTED***');
    expect(out).not.toContain('hunter2');
  });

  it('redacts <input name="otp" value="839271">', () => {
    const out = redactPasswordValues('<input name="otp" value="839271">');
    expect(out).not.toContain('839271');
    expect(out).toContain('***REDACTED***');
  });

  it('redacts <input name="totp" value="x"> (boundary case)', () => {
    const out = redactPasswordValues('<input name="totp" value="x">');
    expect(out).not.toContain('value="x"');
    expect(out).toContain('***REDACTED***');
  });

  it('redacts <input name="mfa_code" value="123">', () => {
    const out = redactPasswordValues('<input name="mfa_code" value="123">');
    expect(out).not.toContain('"123"');
    expect(out).toContain('***REDACTED***');
  });

  it('redacts <input id="user-secret-field" value="topsecret">', () => {
    const out = redactPasswordValues('<input id="user-secret-field" value="topsecret">');
    expect(out).not.toContain('topsecret');
    expect(out).toContain('***REDACTED***');
  });

  it('redacts <textarea name="password">hunter2</textarea>', () => {
    const out = redactPasswordValues('<textarea name="password">hunter2</textarea>');
    expect(out).not.toContain('hunter2');
    expect(out).toContain('***REDACTED***');
  });

  it('redacts <textarea id="my-token-area">eyJ...</textarea>', () => {
    const out = redactPasswordValues('<textarea id="my-token-area">eyJabc</textarea>');
    expect(out).not.toContain('eyJabc');
    expect(out).toContain('***REDACTED***');
  });

  it('redacts <input type="hidden" name="canary" value="abc">', () => {
    const out = redactPasswordValues('<input type="hidden" name="canary" value="abc">');
    expect(out).not.toContain('"abc"');
    expect(out).toContain('***REDACTED***');
  });

  it('redacts <input type="hidden" name="flowToken" value="xyz">', () => {
    const out = redactPasswordValues('<input type="hidden" name="flowToken" value="xyz">');
    expect(out).not.toContain('"xyz"');
    expect(out).toContain('***REDACTED***');
  });

  it('redacts <input type="hidden" name="SAMLResponse" value="b64stuff">', () => {
    const out = redactPasswordValues('<input type="hidden" name="SAMLResponse" value="b64stuff">');
    expect(out).not.toContain('b64stuff');
    expect(out).toContain('***REDACTED***');
  });

  it('does NOT redact <input type="hidden" name="totally_safe" value="keep_me">', () => {
    const out = redactPasswordValues('<input type="hidden" name="totally_safe" value="keep_me">');
    expect(out).toContain('keep_me');
    expect(out).not.toContain('***REDACTED***');
  });

  it('strips <script> body and replaces with /* REDACTED */', () => {
    const out = redactPasswordValues('<script>window.__token = "eyJabc";</script>');
    expect(out).not.toContain('eyJabc');
    expect(out).toContain('/* REDACTED */');
  });

  it('strips <script type="application/javascript"> body but preserves the type attribute', () => {
    const out = redactPasswordValues('<script type="application/javascript">var p="secret";</script>');
    expect(out).not.toContain('secret');
    expect(out).toContain('type="application/javascript"');
    expect(out).toContain('/* REDACTED */');
  });
});

// ---------------------------------------------------------------------------
// URL sanitization in capture — integration test
// ---------------------------------------------------------------------------

describe('captureDebugState — URL sanitization', () => {
  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
      tmpDir = '';
    }
  });

  it('captured url.txt does not contain SAMLRequest= when page.url() returns a URL with one', async () => {
    const baseDir = await makeTmp();
    const dirtyUrl = 'https://login.microsoftonline.com/abc/saml2?SAMLRequest=bigbase64blob&kept=yes';

    const result = await captureDebugState({
      page: makePage({ url: () => dirtyUrl }),
      reason: 'url-sanitize-test',
      service: 'sn',
      baseDir,
      now: () => FIXED_NOW,
    });

    expect(result.errors).toEqual([]);
    const content = await fs.readFile(result.files.url!, 'utf8');
    expect(content).not.toContain('SAMLRequest=');
    expect(content).toContain('kept=yes');
  });
});
