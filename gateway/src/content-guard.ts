import type { Logger } from "./logger.js";

/**
 * Content-inspection stage (the "80/20" content layer).
 *
 * Two concerns, both regex-only and bounded — no ML, no network, no schema
 * awareness of the payload beyond "is it JSON":
 *
 *  1. EGRESS SECRET / PCI REDACTION — scans tool RESULTS (backend responses)
 *     for secret-shaped and payment-card-shaped strings and replaces them with
 *     a `[REDACTED:<kind>]` marker before the result reaches the model. This is
 *     the highest-value control: the result path is a surface no client-side
 *     guard can sit on, because the gateway is the last hop before the model
 *     sees the data.
 *
 *  2. OUTBOUND ARG BLOCKING — for HUMAN_OUTBOUND tools (messages, emails,
 *     tickets — anything a human will read), a Luhn-valid card number (or SSN,
 *     when enabled) in the OUTBOUND ARGUMENTS is blocked outright: the call
 *     never reaches the backend. Confirmation authorizes the WRITE; it does
 *     not authorize laundering payment-card data through an outbound channel.
 *     A separate, off-by-default pack blocks destructive SQL statements
 *     (`DROP TABLE`, `DELETE FROM` without `WHERE`) in the arguments of tools
 *     whose manifest tags include "sql" or "exec".
 *
 * All scanning is bounded by `maxScanChars`, but a payload larger than the cap
 * is NOT passed through unscanned. Returning oversized text verbatim was an
 * egress bypass: a malicious or compromised backend could pad a response past
 * the cap to smuggle a secret out to the model in the unscanned tail. Instead
 * the head window up to `maxScanChars` is scanned and redacted, and the
 * remainder is WITHHELD (fail-closed) behind a `[REDACTED:oversize-withheld]`
 * marker. `maxScanChars` is thus a per-string scan budget (bounding regex cost
 * per leaf), not a skip threshold, and unscanned bytes are never emitted.
 */

// ─── Config ────────────────────────────────────────────────────────────────────

export interface ContentGuardConfig {
  /** Egress secret redaction (AWS/GitHub/OpenAI/private-key/Slack/Google/bearer). Default ON. */
  secrets: boolean;
  /** Luhn-validated payment-card detection: block on HUMAN_OUTBOUND args, redact in results. Default ON. */
  luhn: boolean;
  /** US SSN pattern (\d{3}-\d{2}-\d{4}): block on HUMAN_OUTBOUND args, redact in results. Default OFF. */
  ssn: boolean;
  /** Destructive-SQL arg blocking for tools tagged sql/exec. Default OFF. */
  sqlDestructive: boolean;
  /**
   * High-entropy secret detector (Shannon entropy + length + charset heuristic
   * for hex/base64 blobs) applied to tool results. Default OFF — deliberately
   * opt-in because it is false-positive-prone (long hashes, signatures, and
   * other legitimately random values are indistinguishable from secrets).
   * Optional so existing hand-built config fixtures remain valid; absent = off.
   */
  entropy?: boolean;
  /**
   * Per-string scan budget: the head up to this many chars is scanned and
   * redacted; any remainder is withheld (fail-closed), never emitted unscanned.
   * Bounds regex cost per string leaf without leaving an oversized-payload
   * bypass.
   */
  maxScanChars: number;
}

export interface RedactionResult {
  text: string;
  /** Distinct redaction kinds applied (e.g. ["aws-key", "card-number"]); empty if nothing matched. */
  redactedKinds: string[];
}

export interface ArgGuardResult {
  blocked: boolean;
  kind?: string;
  detail?: string;
}

// ─── Secret patterns (egress redaction) ───────────────────────────────────────

interface Pattern {
  kind: string;
  regex: RegExp;
}

/**
 * Every regex here MUST carry the global flag — redactPatterns() relies on
 * String.prototype.replace resetting a global regex's lastIndex to 0 at the
 * start of each call, so the same RegExp object is safely reusable across
 * repeated calls without manual lastIndex bookkeeping.
 */
const SECRET_PATTERNS: Pattern[] = [
  { kind: "aws-key", regex: /AKIA[0-9A-Z]{16}/g },
  // Full GitHub token family: ghp_ (classic PAT), gho_ (OAuth), ghu_ (user-to-
  // server), ghs_ (server-to-server), ghr_ (refresh). Tails may contain
  // underscores. The `gh[posur]_` prefix requires the literal underscore after
  // the type letter, so prose like "ghost_writer" or a short "gho_x" never
  // matches (36-char minimum tail).
  { kind: "github-token", regex: /gh[posur]_[A-Za-z0-9_]{36,}/g },
  // Fine-grained GitHub PAT — distinct fixed prefix, shorter minimum tail.
  { kind: "github-token", regex: /github_pat_[A-Za-z0-9_]{22,}/g },
  { kind: "openai-key", regex: /sk-[A-Za-z0-9]{20,}/g },
  // Full PEM block (non-greedy body) — redacting only the header line would
  // leave the actual key material in the response, defeating the purpose.
  { kind: "private-key", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: "slack-token", regex: /xox[baprs]-[A-Za-z0-9-]+/g },
  { kind: "google-api-key", regex: /AIza[0-9A-Za-z_-]{35}/g },
  { kind: "bearer-token", regex: /\b[Bb]earer\s+[A-Za-z0-9._-]{20,}/g },
];

const SSN_PATTERN: Pattern = { kind: "ssn", regex: /\b\d{3}-\d{2}-\d{4}\b/g };

/** Apply a set of patterns to a string, replacing every match with a `[REDACTED:<kind>]` marker. */
function redactPatterns(s: string, patterns: Pattern[]): { text: string; kinds: Set<string> } {
  let text = s;
  const kinds = new Set<string>();
  for (const p of patterns) {
    const before = text;
    text = text.replace(p.regex, `[REDACTED:${p.kind}]`);
    if (text !== before) kinds.add(p.kind);
  }
  return { text, kinds };
}

// ─── High-entropy secret detector (opt-in, false-positive-prone) ──────────────

/**
 * Candidate token runs for the entropy heuristic: unbroken [A-Za-z0-9+/_-]
 * sequences of at least 32 chars, plus up to two trailing `=` padding chars
 * (base64). `=` is deliberately NOT in the core class — `key=value` text would
 * otherwise glue the key onto the value and dilute the entropy measurement.
 * English prose never forms a single 32+ char token, so prose is structurally
 * excluded before any entropy math runs.
 */
const ENTROPY_CANDIDATE_REGEX = /[A-Za-z0-9+/_-]{32,}={0,2}/g;

/** RFC-4122 UUID shape (with dashes) — explicitly excluded: ubiquitous in API
 * responses and low-sensitivity, redacting them would be pure noise. */
const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const HEX_REGEX = /^[0-9a-fA-F]+$/;

/** Shannon entropy in bits per character over the string's char frequencies. */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Heuristic: does this candidate token look like a high-entropy secret?
 *
 * Charset-specific thresholds (length + bits/char):
 *  - hex:    length ≥ 48 AND entropy ≥ 3.0 (random hex ≈ 4.0 max). The 48-char
 *    floor deliberately spares 40-char git SHA-1 commit ids — the single most
 *    common long-hex value in tool output — at the cost of missing 40-hex
 *    secrets. 64-hex (sha256-sized keys/tokens) is squarely covered.
 *  - base64ish: length ≥ 40 AND entropy ≥ 4.5 (random base64 ≈ 6.0 max) AND
 *    mixed character classes (upper+lower+digit, or +/= present) — a long
 *    lowercase identifier like "supercalifragilistic..." fails the class mix.
 *
 * UUIDs are excluded by shape. Everything else that slips through is exactly
 * why this pack ships default-OFF.
 */
export function isHighEntropyToken(token: string): boolean {
  if (UUID_REGEX.test(token)) return false;
  if (HEX_REGEX.test(token)) {
    return token.length >= 48 && shannonEntropy(token) >= 3.0;
  }
  if (token.length < 40) return false;
  const hasUpper = /[A-Z]/.test(token);
  const hasLower = /[a-z]/.test(token);
  const hasDigit = /[0-9]/.test(token);
  const hasB64Punct = /[+/=]/.test(token);
  const classMix = (hasUpper && hasLower && hasDigit) || hasB64Punct;
  if (!classMix) return false;
  return shannonEntropy(token) >= 4.5;
}

/** Find every high-entropy candidate token in a string. Exported for tests. */
export function findHighEntropyTokens(s: string): string[] {
  const matches: string[] = [];
  const re = new RegExp(ENTROPY_CANDIDATE_REGEX.source, ENTROPY_CANDIDATE_REGEX.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (isHighEntropyToken(m[0])) matches.push(m[0]);
  }
  return matches;
}

function redactHighEntropy(s: string): { text: string; matched: boolean } {
  const matches = findHighEntropyTokens(s);
  if (matches.length === 0) return { text: s, matched: false };
  let text = s;
  for (const raw of matches) {
    // split/join: literal replacement, no regex re-interpretation of the matched text.
    text = text.split(raw).join("[REDACTED:high-entropy]");
  }
  return { text, matched: true };
}

// ─── Luhn / PCI card detection ─────────────────────────────────────────────────

/** Candidate digit runs (13-19 digits, single space/dash separators tolerated). */
const CARD_CANDIDATE_REGEX = /\b(?:\d[ -]?){12,18}\d\b/g;

/** Visa / Mastercard / Amex / Discover IIN prefixes — near-zero false positives combined with Luhn. */
function isKnownCardPrefix(digits: string): boolean {
  if (/^4/.test(digits)) return true; // Visa
  if (/^5[1-5]/.test(digits)) return true; // Mastercard (legacy range)
  if (/^2(2[2-9]\d|[3-6]\d{2}|7[01]\d|720)/.test(digits)) return true; // Mastercard (2221-2720)
  if (/^3[47]/.test(digits)) return true; // Amex
  if (/^6011/.test(digits)) return true; // Discover
  if (/^65/.test(digits)) return true; // Discover
  return false;
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48; // '0'
    if (n < 0 || n > 9) return false;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** Find every Luhn-valid, prefix-matched card number in a string. Returns the raw matched text (with separators). */
export function findLuhnCardMatches(s: string): string[] {
  const matches: string[] = [];
  const re = new RegExp(CARD_CANDIDATE_REGEX.source, CARD_CANDIDATE_REGEX.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const raw = m[0];
    const digits = raw.replace(/[ -]/g, "");
    if (digits.length < 13 || digits.length > 19) continue;
    if (!isKnownCardPrefix(digits)) continue;
    if (!luhnValid(digits)) continue;
    matches.push(raw);
  }
  return matches;
}

function redactLuhn(s: string): { text: string; matched: boolean } {
  const matches = findLuhnCardMatches(s);
  if (matches.length === 0) return { text: s, matched: false };
  let text = s;
  for (const raw of matches) {
    // split/join: literal replacement, no regex re-interpretation of the matched text.
    text = text.split(raw).join("[REDACTED:card-number]");
  }
  return { text, matched: true };
}

// ─── Destructive SQL (arg blocking only — sql/exec-tagged tools) ─────────────

// Tolerates comment-injection between keywords, e.g. `DROP/**/TABLE`.
const SQL_DROP_TABLE_REGEX = /DROP(?:\s|\/\*[\s\S]*?\*\/)+TABLE/i;
const SQL_DELETE_FROM_REGEX = /DELETE\s+FROM\s+[^\s;]+([^;]*)/gi;

function containsDestructiveSql(text: string): { matched: boolean; detail?: string } {
  if (SQL_DROP_TABLE_REGEX.test(text)) {
    return { matched: true, detail: "argument values contain a DROP TABLE statement" };
  }
  const deleteMatches = text.match(SQL_DELETE_FROM_REGEX);
  if (deleteMatches) {
    for (const stmt of deleteMatches) {
      if (!/\bWHERE\b/i.test(stmt)) {
        return {
          matched: true,
          detail: "argument values contain a DELETE FROM statement without a WHERE clause",
        };
      }
    }
  }
  return { matched: false };
}

// ─── Recursive value-tree redaction (nested JSON string leaves) ───────────────

/** Marker kind for the withheld tail of an oversized payload (see redactString). */
const OVERSIZE_KIND = "oversize-withheld";

/**
 * Scan and redact a single string, bounded by cfg.maxScanChars.
 *
 * OVERSIZE BYPASS FIX: before this, applyResultRedaction returned any payload
 * longer than maxScanChars UNSCANNED, so a malicious or compromised backend
 * could append (or pad past the cap with) a secret and exfiltrate it verbatim
 * to the model. Fail-closed instead: scan and redact the head window up to the
 * budget, then WITHHOLD the remainder behind a [REDACTED:oversize-withheld]
 * marker rather than emit unscanned bytes. maxScanChars is a per-string scan
 * budget, not a skip threshold.
 *
 * Tradeoff: a legitimately large text loses its tail. That is the intended
 * fail-closed default here (the result path is the last hop before the model,
 * where a leaked secret is unrecoverable); truncating benign output is the
 * lesser harm. A secret straddling the cut has at most its truncated prefix
 * (never a usable full credential) in the scanned head, and its remainder is
 * withheld.
 */
function redactString(
  s: string,
  cfg: ContentGuardConfig,
  kinds: Set<string>,
  logger?: Logger
): string {
  if (s.length > cfg.maxScanChars) {
    const withheldChars = s.length - cfg.maxScanChars;
    logger?.warn(
      `content-guard: string (${s.length} chars) exceeds maxScanChars (${cfg.maxScanChars}); scanning head and withholding the ${withheldChars}-char remainder (fail-closed, no unscanned bytes emitted)`
    );
    const head = redactStringUnbounded(s.slice(0, cfg.maxScanChars), cfg, kinds);
    kinds.add(OVERSIZE_KIND);
    return `${head}[REDACTED:${OVERSIZE_KIND}]`;
  }
  return redactStringUnbounded(s, cfg, kinds);
}

/** Apply every enabled redaction pack to a string, in order (unbounded scan). */
function redactStringUnbounded(s: string, cfg: ContentGuardConfig, kinds: Set<string>): string {
  let text = s;
  if (cfg.secrets) {
    const r = redactPatterns(text, SECRET_PATTERNS);
    text = r.text;
    r.kinds.forEach((k) => kinds.add(k));
  }
  if (cfg.luhn) {
    const r = redactLuhn(text);
    if (r.matched) {
      text = r.text;
      kinds.add("card-number");
    }
  }
  if (cfg.ssn) {
    const r = redactPatterns(text, [SSN_PATTERN]);
    text = r.text;
    r.kinds.forEach((k) => kinds.add(k));
  }
  // Entropy pack runs LAST: known-format patterns above claim their matches
  // first, so the generic detector only fires on blobs no specific pattern
  // recognized. Opt-in (default OFF, false-positive-prone).
  if (cfg.entropy === true) {
    const r = redactHighEntropy(text);
    if (r.matched) {
      text = r.text;
      kinds.add("high-entropy");
    }
  }
  return text;
}

function redactValueTree(
  value: unknown,
  cfg: ContentGuardConfig,
  kinds: Set<string>,
  logger?: Logger
): unknown {
  if (typeof value === "string") return redactString(value, cfg, kinds, logger);
  // Numeric leaves: previously only string leaves were scanned, so a backend
  // could smuggle a secret as an unquoted JSON number (e.g. a 16-digit card
  // number in `{"amount": 4111...}`). Stringify and scan; only replace when a
  // pattern actually matched, so benign numbers keep their numeric type.
  if (typeof value === "number" || typeof value === "bigint") {
    const localKinds = new Set<string>();
    const redacted = redactString(String(value), cfg, localKinds, logger);
    if (localKinds.size === 0) return value;
    localKinds.forEach((k) => kinds.add(k));
    return redacted;
  }
  if (Array.isArray(value)) return value.map((v) => redactValueTree(v, cfg, kinds, logger));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Object KEYS are attacker-controlled too: a secret can hide in a key
      // (e.g. `{ "<secret>": true }`), not just a value. Scan and redact the
      // key as well as recursing into the value.
      const redactedKey = redactString(k, cfg, kinds, logger);
      out[redactedKey] = redactValueTree(v, cfg, kinds, logger);
    }
    return out;
  }
  return value;
}

// ─── Public entry points ───────────────────────────────────────────────────────

/**
 * Egress redaction for a single tool-result text blob. Applied to EVERY tool
 * result (not just HUMAN_OUTBOUND) — the result path is the surface no client
 * can sit on.
 *
 * If the text is valid JSON, redaction recurses into every string leaf (so a
 * secret nested three levels deep in a JSON response is caught, not just a
 * top-level field). If the text is not JSON, the patterns are applied to the
 * raw string directly — this is the common case for plain-text tool output.
 *
 * Bounded per string leaf by cfg.maxScanChars: an oversized leaf has its head
 * scanned and its tail WITHHELD (fail-closed) rather than passed through
 * unscanned. Oversized text is never returned verbatim (that was the egress
 * bypass this control closes); see redactString.
 */
export function applyResultRedaction(
  text: string,
  cfg: ContentGuardConfig,
  logger?: Logger
): RedactionResult {
  if (!cfg.secrets && !cfg.luhn && !cfg.ssn && cfg.entropy !== true) return { text, redactedKinds: [] };

  const kinds = new Set<string>();
  try {
    const parsed: unknown = JSON.parse(text);
    const redacted = redactValueTree(parsed, cfg, kinds, logger);
    if (kinds.size === 0) return { text, redactedKinds: [] };
    return { text: JSON.stringify(redacted), redactedKinds: [...kinds] };
  } catch {
    const redacted = redactString(text, cfg, kinds, logger);
    if (kinds.size === 0) return { text, redactedKinds: [] };
    return { text: redacted, redactedKinds: [...kinds] };
  }
}

/** Best-effort JSON serialization of arbitrary tool arguments for pattern scanning. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    try {
      return String(value);
    } catch {
      return "";
    }
  }
}

/**
 * SEC-9: fail-closed oversize handling shared by the outbound-arg guards.
 *
 * Before this, both guards early-returned blocked:false when the serialized
 * args exceeded maxScanChars, so a padded HUMAN_OUTBOUND arg (e.g. a card
 * number buried in a large message) skipped the block entirely. That is the
 * same oversize-skip bypass closed for egress redaction in SEC-3, applied here
 * on the BLOCKING path: scan the head window, and treat an oversized arg as
 * blockable regardless (the unscanned tail could carry a card/SSN/destructive
 * statement; confirmation authorizes the write, not exfiltration through it).
 *
 * Returns the head window to scan plus whether the arg was oversized. When
 * `oversized` is true the caller BLOCKS even if the head scan is clean.
 */
function scanWindow(
  text: string,
  cfg: ContentGuardConfig,
  logger: Logger | undefined,
  label: string
): { scan: string; oversized: boolean } {
  if (text.length <= cfg.maxScanChars) return { scan: text, oversized: false };
  logger?.warn(
    `content-guard: ${label} (${text.length} chars) exceed maxScanChars (${cfg.maxScanChars}); scanning head and blocking fail-closed (SEC-9)`
  );
  return { scan: text.slice(0, cfg.maxScanChars), oversized: true };
}

/** Block result for an oversized, not-fully-scannable outbound arg (SEC-9 fail-closed). */
function oversizeBlock(kind: string, totalChars: number, cfg: ContentGuardConfig): ArgGuardResult {
  return {
    blocked: true,
    kind,
    detail: `outbound argument (${totalChars} chars) exceeds the ${cfg.maxScanChars}-char scan budget and cannot be fully scanned; blocked fail-closed`,
  };
}

/**
 * Outbound-argument guard for HUMAN_OUTBOUND tools (messages, emails, tickets
 * — anything a human will read on the other end). Blocks the call BEFORE it
 * reaches the backend when a Luhn-valid card number (or, if enabled, an
 * SSN-shaped value) appears anywhere in the arguments.
 *
 * This runs independently of the write-guard confirmation: a confirmed:true
 * HUMAN_OUTBOUND call is still blocked here — confirmation authorizes the
 * WRITE, not the exfiltration of payment-card data through it.
 */
export function checkHumanOutboundArgs(args: unknown, cfg: ContentGuardConfig, logger?: Logger): ArgGuardResult {
  if (!cfg.luhn && !cfg.ssn) return { blocked: false };
  const text = safeStringify(args);
  // SEC-9: scan the head window; an oversized arg is fail-closed (see below).
  const { scan, oversized } = scanWindow(text, cfg, logger, "outbound args");
  if (cfg.luhn) {
    const matches = findLuhnCardMatches(scan);
    if (matches.length > 0) {
      return {
        blocked: true,
        kind: "card-number",
        detail: `argument values contain ${matches.length} Luhn-valid card number(s)`,
      };
    }
  }
  if (cfg.ssn) {
    const re = new RegExp(SSN_PATTERN.regex.source, SSN_PATTERN.regex.flags);
    if (re.test(scan)) {
      return { blocked: true, kind: "ssn", detail: "argument values contain a US SSN-shaped value" };
    }
  }
  // SEC-9: nothing matched in the scanned head, but an oversized arg has an
  // unscanned tail that could still carry a card/SSN. Block fail-closed rather
  // than pass it through (the pre-fix behavior was to skip and allow).
  if (oversized) return oversizeBlock("oversize", text.length, cfg);
  return { blocked: false };
}

/**
 * Destructive-SQL argument guard. Callers apply this ONLY to tools whose
 * manifest capability tags include "sql" or "exec" — off by default
 * (cfg.sqlDestructive), and scoped by tag even when enabled so it never
 * fires on unrelated tools whose text arguments happen to contain the words
 * "drop" or "delete".
 */
export function checkSqlDestructiveArgs(args: unknown, cfg: ContentGuardConfig, logger?: Logger): ArgGuardResult {
  if (!cfg.sqlDestructive) return { blocked: false };
  const text = safeStringify(args);
  // SEC-9: scan the head window; an oversized arg is fail-closed (see below).
  const { scan, oversized } = scanWindow(text, cfg, logger, "outbound args");
  const result = containsDestructiveSql(scan);
  if (result.matched) {
    return { blocked: true, kind: "sql-destructive", detail: result.detail };
  }
  // SEC-9: nothing matched in the scanned head, but an oversized arg has an
  // unscanned tail that could still carry a destructive statement. Block
  // fail-closed rather than pass it through (pre-fix behavior was to skip).
  if (oversized) return oversizeBlock("oversize", text.length, cfg);
  return { blocked: false };
}
