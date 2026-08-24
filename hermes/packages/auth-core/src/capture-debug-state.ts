import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { sanitizeUrl } from './url-sanitizer.js';

export interface CaptureablePage {
  url(): string;
  screenshot(opts: { path: string; fullPage?: boolean }): Promise<Buffer | void>;
  content(): Promise<string>;
}

export interface CaptureDebugStateOptions {
  page: CaptureablePage;
  reason: string;          // e.g. "stall", "session_info_failed"
  service: string;         // e.g. "servicenow" — used in capture path
  baseDir: string;         // capture writes to <baseDir>/diag/<service>/<timestamp>/
  stepLog?: ReadonlyArray<Record<string, unknown>>;
  now?: () => number;      // defaults to Date.now (for deterministic tests)
  maxCaptures?: number;    // default 5; older capture dirs for this service are deleted
}

export interface CaptureDebugStateResult {
  captureDir: string;
  files: { screenshot?: string; dom?: string; stepLog?: string; url?: string; reason?: string };
  errors: string[];        // best-effort: never throws; per-file failures collected here
}

/**
 * Names that indicate credential-like fields (inputs, textareas, hidden fields).
 * Applied to name and id attributes.
 */
const CREDENTIAL_NAME_PATTERN = /(password|passwd|secret|token|otp|totp|mfa|pin|code)/i;

/**
 * MS-specific hidden input names that carry session state and must be redacted.
 */
const MS_HIDDEN_NAME_PATTERN = /^(canary|flowToken|ctx|sCtx|hpgrequestid|__RequestVerificationToken|SAMLResponse|code|id_token|access_token|refresh_token)$/i;

/**
 * Redact password-like input values from raw HTML.
 * Handles:
 *   type="password"
 *   name/id containing credential keywords (password, passwd, secret, token, otp, totp, mfa, pin, code)
 *   <textarea> with credential-named name/id
 *   <script> block bodies (stripped wholesale, open-tag attributes preserved)
 *   MS-specific hidden inputs (canary, flowToken, ctx, sCtx, etc.)
 */
export function redactPasswordValues(html: string): string {
  // Pass 1: Redact <textarea> credential fields (before script-strip changes boundaries)
  let result = html.replace(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi, (full, attrs: string, _body: string) => {
    const hasCredentialName = /\bname\s*=\s*["'][^"']*\b(password|passwd|secret|token|otp|totp|mfa|pin|code)[^"']*["']/i.test(attrs);
    const hasCredentialId = /\bid\s*=\s*["'][^"']*\b(password|passwd|secret|token|otp|totp|mfa|pin|code)[^"']*["']/i.test(attrs);
    if (hasCredentialName || hasCredentialId) {
      return `<textarea${attrs}>***REDACTED***</textarea>`;
    }
    return full;
  });

  // Pass 2: Redact <input> credential fields and MS-specific hidden fields
  result = result.replace(/<input\b([^>]*)>/gi, (fullMatch, attrs: string) => {
    const isPasswordType = /\btype\s*=\s*["']password["']/i.test(attrs);
    const hasPasswordName = CREDENTIAL_NAME_PATTERN.test(
      (/\bname\s*=\s*["']([^"']*)["']/i.exec(attrs) ?? [])[1] ?? '',
    );
    const hasPasswordId = CREDENTIAL_NAME_PATTERN.test(
      (/\bid\s*=\s*["']([^"']*)["']/i.exec(attrs) ?? [])[1] ?? '',
    );

    // MS-specific hidden input: type="hidden" AND name matches the MS pattern
    const isHiddenType = /\btype\s*=\s*["']hidden["']/i.test(attrs);
    const hiddenName = (/\bname\s*=\s*["']([^"']*)["']/i.exec(attrs) ?? [])[1] ?? '';
    const isMsHidden = isHiddenType && MS_HIDDEN_NAME_PATTERN.test(hiddenName);

    if (!isPasswordType && !hasPasswordName && !hasPasswordId && !isMsHidden) {
      return fullMatch;
    }

    // Replace value="..." or value='...' with the redacted placeholder
    const redactedAttrs = attrs.replace(
      /\bvalue\s*=\s*(?:"[^"]*"|'[^']*')/gi,
      'value="***REDACTED***"',
    );
    return `<input${redactedAttrs}>`;
  });

  // Pass 3: Strip <script> block bodies (preserves open-tag attributes)
  result = result.replace(/<script\b([^>]*)>[\s\S]*?<\/script>/gi, '<script$1>/* REDACTED */</script>');

  return result;
}

export async function captureDebugState(
  opts: CaptureDebugStateOptions,
): Promise<CaptureDebugStateResult> {
  const {
    page,
    reason,
    service,
    baseDir,
    stepLog,
    now = Date.now,
    maxCaptures = 5,
  } = opts;

  const errors: string[] = [];
  const files: CaptureDebugStateResult['files'] = {};

  // Build the capture directory path with a 4-char hex suffix to avoid same-ms collisions
  const rawTs = new Date(now()).toISOString();
  const safeTs = `${rawTs.replace(/:/g, '-')}-${randomBytes(2).toString('hex')}`;
  const serviceDir = path.join(baseDir, 'diag', service);
  const captureDir = path.join(serviceDir, safeTs);

  // Create the capture directory with restricted permissions (best-effort)
  // serviceDir is created as part of the recursive mkdir; we set mode 0o700 on captureDir.
  try {
    await fs.mkdir(serviceDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(captureDir, { recursive: true, mode: 0o700 });
  } catch (e) {
    errors.push(`mkdir failed: ${String(e)}`);
    // Without a directory we cannot write files — return early with what we have
    return { captureDir, files, errors };
  }

  // Write reason.txt first (anchors the capture intent)
  try {
    const reasonPath = path.join(captureDir, 'reason.txt');
    await fs.writeFile(reasonPath, reason, { encoding: 'utf8', mode: 0o600 });
    files.reason = reasonPath;
  } catch (e) {
    errors.push(`reason.txt write failed: ${String(e)}`);
  }

  // Write url.txt (sanitized to strip OAuth/SAML params)
  try {
    const urlPath = path.join(captureDir, 'url.txt');
    await fs.writeFile(urlPath, sanitizeUrl(page.url()), { encoding: 'utf8', mode: 0o600 });
    files.url = urlPath;
  } catch (e) {
    errors.push(`url.txt write failed: ${String(e)}`);
  }

  // Write screenshot.png (Playwright has no mode option; chmod after write)
  const screenshotPath = path.join(captureDir, 'screenshot.png');
  try {
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await fs.chmod(screenshotPath, 0o600).catch((e) =>
      errors.push(`chmod screenshot failed: ${String(e)}`),
    );
    files.screenshot = screenshotPath;
  } catch (e) {
    errors.push(`screenshot failed: ${String(e)}`);
  }

  // Write dom.html (with password redaction)
  const domPath = path.join(captureDir, 'dom.html');
  try {
    const rawHtml = await page.content();
    const safeHtml = redactPasswordValues(rawHtml);
    await fs.writeFile(domPath, safeHtml, { encoding: 'utf8', mode: 0o600 });
    files.dom = domPath;
  } catch (e) {
    errors.push(`dom.html write failed: ${String(e)}`);
  }

  // Write step-log.jsonl (only when non-empty)
  if (stepLog !== undefined && stepLog.length > 0) {
    const stepLogPath = path.join(captureDir, 'step-log.jsonl');
    try {
      const lines = stepLog.map((entry) => {
        try {
          return JSON.stringify(entry);
        } catch (e) {
          return JSON.stringify({ _serializationError: e instanceof Error ? e.message : String(e) });
        }
      }).join('\n');
      await fs.writeFile(stepLogPath, lines, { encoding: 'utf8', mode: 0o600 });
      files.stepLog = stepLogPath;
    } catch (e) {
      errors.push(`step-log.jsonl write failed: ${String(e)}`);
    }
  }

  // Retention: keep only the most recent maxCaptures dirs
  try {
    const entries = await fs.readdir(serviceDir, { withFileTypes: true });
    const captureDirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort(); // ISO timestamps + hex suffix sort lexicographically = chronologically

    // Exclude the current capture from deletion candidates to defend against edge cases
    const currentBasename = path.basename(captureDir);
    const candidates = captureDirs.filter((d) => d !== currentBasename);

    if (candidates.length > maxCaptures - 1) {
      const toDelete = candidates.slice(0, candidates.length - (maxCaptures - 1));
      for (const dirName of toDelete) {
        try {
          await fs.rm(path.join(serviceDir, dirName), { recursive: true, force: true });
        } catch (e) {
          errors.push(`retention delete failed for ${dirName}: ${String(e)}`);
        }
      }
    }
  } catch (e) {
    errors.push(`retention scan failed: ${String(e)}`);
  }

  // Orphan cleanup: if no files were written, remove the empty capture dir
  if (Object.keys(files).length === 0) {
    await fs.rm(captureDir, { recursive: true, force: true }).catch((e) =>
      errors.push(`orphan cleanup failed: ${String(e)}`),
    );
  }

  return { captureDir, files, errors };
}
