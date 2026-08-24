/**
 * Autonomous Exploration
 *
 * For UNDOCUMENTED targets (no OpenAPI spec, no operator-supplied HAR or
 * `actions`), an agent autonomously enumerates the app's functionality
 * itself — crawling navigation/links/forms, triggering XHR/fetch calls, and
 * capturing the resulting network traffic. The captured request set becomes
 * the OBSERVED endpoint set: the authoritative coverage denominator consumed
 * by src/coverage/manifest.ts.
 *
 * thesun's own runtime never drives a browser directly. Generation is
 * carried out by an LLM agent ("bob") that calls playwright-mcp tools
 * (mcp__plugin_playwright_playwright__browser_navigate,
 * _browser_snapshot, _browser_network_requests, etc.) — see the existing
 * HAR-capture flow in src/mcp-server/index.ts (handleInteractiveMode,
 * PHASE 3.5) and the browser-auth template's captureAuthWithPlaywright.
 * `playwright` is not a thesun runtime dependency (see package.json);
 * browser automation is always delegated to whichever agent is generating,
 * via its MCP tool access.
 *
 * This module supplies the autonomous-crawl variant of that existing
 * pattern:
 *
 *   1. buildExplorationPlaybook() — the instruction prompt handed to bob in
 *      place of (or alongside) operator-supplied `actions`, telling it to
 *      enumerate the app itself instead of waiting for a human-provided
 *      action list. Wiring this into handleInteractiveMode is out of scope
 *      here (owned by src/mcp-server/index.ts).
 *   2. exploreAutonomously() — a real (not stubbed) orchestrator that drives
 *      the crawl given an injected MCP tool caller. It isn't wire-tested in
 *      this repo (no live playwright-mcp connection in unit tests), so it's
 *      built against a small, explicit `McpToolCaller` interface and is
 *      unit-tested with a mock.
 *   3. normalizeCapturedRequests() — a PURE, fully unit-testable core: raw
 *      HAR-shaped capture entries -> the deduplicated, {id}-templated
 *      Observed endpoint set. No I/O.
 */

import { logger } from '../observability/logger.js';
import { HarEntrySchema, type HarEntry } from '../types/index.js';

// ============================================================================
// Observed endpoint set — the coverage denominator for undocumented targets
// ============================================================================

/**
 * The observed endpoint set produced by autonomous exploration. Consumed by
 * src/coverage/manifest.ts as the authoritative "intended" operation list
 * when no OpenAPI spec exists (basis: 'observed' / 'observed-only').
 */
export interface Observed {
  endpoints: Array<{
    method: string;
    path: string;
    sampleRequest?: unknown;
    sampleResponse?: unknown;
  }>;
  source: 'exploration';
}

// ============================================================================
// Pure, unit-testable normalization core
// ============================================================================

const NUMERIC_SEGMENT = /^\d+$/;
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isIdLikeSegment(segment: string): boolean {
  return NUMERIC_SEGMENT.test(segment) || UUID_SEGMENT.test(segment);
}

/**
 * Split a URL (or bare path) into its path segments, dropping origin, query
 * string, and fragment. Relative/malformed URLs fall back to a plain
 * string split on `?`/`#`.
 */
function extractPathSegments(rawUrl: string): string[] {
  let pathname: string;
  try {
    pathname = new URL(rawUrl).pathname;
  } catch {
    pathname = rawUrl.split(/[?#]/)[0];
  }
  return pathname.split('/').filter((segment) => segment.length > 0);
}

interface CapturedRequest {
  method: string;
  path: string; // always starts with "/"
  segments: string[];
  sampleRequest?: unknown;
  sampleResponse?: unknown;
}

/**
 * Convert HAR-shaped capture entries (the same shape thesun already uses
 * for auth capture — see types/index.ts HarEntrySchema, and
 * src/auth/credential-wizard.ts / src/security/har-auth.ts for prior art)
 * into the raw per-request records used for templating.
 */
function toCapturedRequests(entries: HarEntry[]): CapturedRequest[] {
  return entries
    .filter((entry) => Boolean(entry?.request?.url) && Boolean(entry?.request?.method))
    .map((entry) => {
      const segments = extractPathSegments(entry.request.url);
      return {
        method: entry.request.method.toUpperCase(),
        path: `/${segments.join('/')}`,
        segments,
        sampleRequest: {
          url: entry.request.url,
          headers: entry.request.headers,
          postData: entry.request.postData,
        },
        sampleResponse: entry.response
          ? {
              status: entry.response.status,
              statusText: entry.response.statusText,
              content: entry.response.content,
            }
          : undefined,
      };
    });
}

/**
 * Infer {id}-style path templates from a set of captured requests: group by
 * method + segment count, then collapse any segment position where every
 * distinct value observed across the group is numeric or UUID-shaped.
 * Positions that vary but aren't id-shaped are left as distinct literal
 * paths — collapsing those would be guessing at an enum, not inferring an
 * id parameter.
 */
function templatizePaths(requests: CapturedRequest[]): CapturedRequest[] {
  const groups = new Map<string, CapturedRequest[]>();
  for (const req of requests) {
    const key = `${req.method}::${req.segments.length}`;
    const group = groups.get(key);
    if (group) group.push(req);
    else groups.set(key, [req]);
  }

  const templatized: CapturedRequest[] = [];
  for (const group of groups.values()) {
    const segmentCount = group[0].segments.length;
    const idPositions = new Set<number>();

    for (let i = 0; i < segmentCount; i++) {
      const valuesAtPosition = new Set(group.map((r) => r.segments[i]));
      if (valuesAtPosition.size <= 1) continue; // constant across the group — leave literal
      const allIdLike = Array.from(valuesAtPosition).every(isIdLikeSegment);
      if (allIdLike) idPositions.add(i);
    }

    for (const req of group) {
      const templatedSegments = req.segments.map((segment, i) =>
        idPositions.has(i) ? '{id}' : segment
      );
      templatized.push({
        ...req,
        path: `/${templatedSegments.join('/')}`,
      });
    }
  }
  return templatized;
}

/**
 * Pure, unit-testable normalization core: raw HAR-shaped capture entries ->
 * the deduplicated, templated Observed endpoint set. No I/O, no browser —
 * safe to unit test directly with fixture entries. Dedup key is normalized
 * method+templated-path; the first-seen sample request/response for that
 * key is kept as the representative sample.
 */
export function normalizeCapturedRequests(entries: HarEntry[]): Observed {
  const raw = toCapturedRequests(entries);
  const templated = templatizePaths(raw);

  const byKey = new Map<string, Observed['endpoints'][number]>();
  for (const req of templated) {
    const key = `${req.method} ${req.path}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        method: req.method,
        path: req.path,
        sampleRequest: req.sampleRequest,
        sampleResponse: req.sampleResponse,
      });
    }
  }

  return {
    endpoints: Array.from(byKey.values()),
    source: 'exploration',
  };
}

// ============================================================================
// Autonomous-crawl playbook (prompt handed to the generating agent)
// ============================================================================

export interface ExplorationPlaybookOptions {
  target: string;
  siteUrl: string;
  /** Max link-follow depth from the entry page. Keeps autonomous crawling bounded. */
  maxDepth?: number;
  /** Max distinct interactive elements (links/buttons/forms) triggered per page. */
  maxActionsPerPage?: number;
}

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_ACTIONS_PER_PAGE = 15;

/** Action labels exploration must never invoke — crawling must not mutate state. */
const DESTRUCTIVE_ACTION_PATTERN = /\b(delete|remove|cancel|archive|destroy|purge|revoke)\b/i;

/**
 * Build the autonomous-exploration instruction playbook: the prompt handed
 * to the generating agent ("bob") in place of operator-supplied `actions`
 * (parallels handleInteractiveMode's PHASE 3.5 "USER ACTION CAPTURE" in
 * src/mcp-server/index.ts, which currently requires a human-provided action
 * list). Wiring this playbook into handleInteractiveMode is out of scope
 * for this module.
 */
export function buildExplorationPlaybook(options: ExplorationPlaybookOptions): string {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxActionsPerPage = options.maxActionsPerPage ?? DEFAULT_MAX_ACTIONS_PER_PAGE;

  return `## AUTONOMOUS EXPLORATION: ${options.target}

No operator-supplied actions or OpenAPI spec exist for this target — you are
the coverage denominator. Enumerate the app's functionality yourself instead
of waiting for instructions.

### Loop (breadth-first, depth <= ${maxDepth}, <= ${maxActionsPerPage} actions/page)

1. Navigate to the entry point:
   Call: mcp__plugin_playwright_playwright__browser_navigate
   Args: { "url": "${options.siteUrl}" }

2. Snapshot the page to enumerate interactive elements (nav links, buttons,
   forms — use the accessibility snapshot, not raw HTML):
   Call: mcp__plugin_playwright_playwright__browser_snapshot

3. For each same-origin link and each form/button not yet visited this
   session (cap ${maxActionsPerPage} per page — breadth over exhaustiveness):
   - Links: navigate, then capture network traffic (step 5).
   - Forms: fill with synthetic placeholder data (never real credentials or
     PII), submit, then capture.
   - Buttons/menu items that trigger XHR/fetch without navigation: click,
     then capture.

4. Skip destructive-looking actions (delete/remove/cancel/archive/destroy/
   purge/revoke buttons, or forms whose submit label matches those words) —
   exploration must not mutate state. Note skipped actions in your final
   report; do not invoke them.

5. After each interaction, capture network traffic:
   Call: mcp__plugin_playwright_playwright__browser_network_requests

6. Recurse into newly discovered same-origin links up to depth ${maxDepth}.
   Do not follow external-origin links.

7. Stop when: no new same-origin links/actions remain, depth ${maxDepth} is
   reached, or ${maxActionsPerPage} actions have been triggered on every
   visited page.

### Output

Return the accumulated network_requests captures (HAR-shaped entries) from
every step 5 call, unmodified. Do not deduplicate or summarize them —
normalizeCapturedRequests() (src/discovery/exploration.ts) does that
deterministically from the raw capture set.`;
}

// ============================================================================
// Live orchestrator (dependency-injected MCP tool caller)
// ============================================================================

/**
 * A single MCP tool invocation, as available to whatever context is
 * actually driving the browser (bob via playwright-mcp today; a direct MCP
 * client in a future stage). Matches the `callMcpTool` shape already used
 * in generated templates (see the mcp-tool-caller.js references in
 * src/mcp-server/index.ts's browser-auth template injection).
 */
export type McpToolCaller = (
  toolName: string,
  args: Record<string, unknown>
) => Promise<unknown>;

export interface ExploreOptions extends ExplorationPlaybookOptions {
  runTool: McpToolCaller;
}

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Best-effort link extraction from a browser_snapshot result. The
 * playwright-mcp accessibility snapshot's exact shape is a third-party MCP
 * server's response format, not part of this repo's type surface, so this
 * walks the response defensively: it accepts a pre-structured
 * `{ links: Array<string | { href, text? }> }` shape, or falls back to
 * regex-scanning any string/serialized content for `href="..."` tokens.
 * Drops links whose visible text matches DESTRUCTIVE_ACTION_PATTERN and any
 * link that isn't same-origin.
 */
function extractSameOriginLinks(snapshot: unknown, origin: string | null): string[] {
  if (!origin) return [];
  const originStr: string = origin;

  const candidates: Array<{ href: string; text?: string }> = [];

  if (
    snapshot &&
    typeof snapshot === 'object' &&
    Array.isArray((snapshot as Record<string, unknown>).links)
  ) {
    for (const entry of (snapshot as Record<string, unknown>).links as unknown[]) {
      if (typeof entry === 'string') {
        candidates.push({ href: entry });
      } else if (entry && typeof entry === 'object') {
        const e = entry as Record<string, unknown>;
        if (typeof e.href === 'string') {
          candidates.push({
            href: e.href,
            text: typeof e.text === 'string' ? e.text : undefined,
          });
        }
      }
    }
  } else {
    const text = typeof snapshot === 'string' ? snapshot : JSON.stringify(snapshot ?? '');
    const hrefPattern = /href=["']([^"']+)["']/gi;
    let match: RegExpExecArray | null;
    while ((match = hrefPattern.exec(text)) !== null) {
      candidates.push({ href: match[1] });
    }
  }

  const links = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.text && DESTRUCTIVE_ACTION_PATTERN.test(candidate.text)) continue;
    try {
      const resolved: URL = new URL(candidate.href, originStr);
      if (resolved.origin === originStr) {
        links.add(resolved.toString());
      }
    } catch {
      continue; // not a resolvable URL — skip
    }
  }
  return Array.from(links);
}

/**
 * Coerce a browser_network_requests result into HAR-shaped entries.
 * playwright-mcp's actual return shape isn't part of this repo's type
 * surface; this accepts entries already matching HarEntrySchema, or a
 * looser `{ url, method, status?, statusText?, postData?, response?/body? }`
 * shape which it upgrades to the HarEntry contract with deterministic
 * placeholder timing fields (exploration doesn't need real timings — only
 * normalizeCapturedRequests' method+path templating does).
 */
function coerceHarEntries(raw: unknown): HarEntry[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>).entries)
      ? ((raw as Record<string, unknown>).entries as unknown[])
      : [];

  const entries: HarEntry[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;

    const parsed = HarEntrySchema.safeParse(item);
    if (parsed.success) {
      entries.push(parsed.data);
      continue;
    }

    const loose = item as Record<string, unknown>;
    if (typeof loose.url === 'string' && typeof loose.method === 'string') {
      entries.push({
        request: {
          method: loose.method,
          url: loose.url,
          headers: [],
          postData: loose.postData,
        },
        response: {
          status: typeof loose.status === 'number' ? loose.status : 0,
          statusText: typeof loose.statusText === 'string' ? loose.statusText : '',
          headers: [],
          content: loose.response ?? loose.body,
        },
        startedDateTime: new Date(0).toISOString(),
        time: 0,
      });
    }
  }
  return entries;
}

/**
 * Drive a real autonomous crawl using an injected MCP tool caller. This is
 * the actual browser-automation entry point — not a stub — but it depends on
 * a live playwright-mcp connection to do anything useful, so it isn't
 * wire-tested in this repo's unit suite. It IS unit-testable: pass a mock
 * `McpToolCaller` that returns canned browser_snapshot / browser_
 * network_requests payloads to exercise the crawl/dedup logic end-to-end
 * without a real browser.
 *
 * Strategy: breadth-first from siteUrl, same-origin only, bounded by
 * maxDepth and maxActionsPerPage. Destructive-looking links (matched by
 * DESTRUCTIVE_ACTION_PATTERN) are dropped before they're ever queued —
 * exploration never invokes them. A failed step for one page is logged and
 * skipped, not fatal to the overall crawl.
 */
export async function exploreAutonomously(options: ExploreOptions): Promise<Observed> {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxActionsPerPage = options.maxActionsPerPage ?? DEFAULT_MAX_ACTIONS_PER_PAGE;

  const visited = new Set<string>();
  const queue: Array<{ url: string; depth: number }> = [{ url: options.siteUrl, depth: 0 }];
  const capturedEntries: HarEntry[] = [];
  const origin = safeOrigin(options.siteUrl);

  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) break;
    const { url, depth } = next;
    if (visited.has(url) || depth > maxDepth) continue;
    visited.add(url);

    try {
      await options.runTool('mcp__plugin_playwright_playwright__browser_navigate', { url });

      const snapshot = await options.runTool(
        'mcp__plugin_playwright_playwright__browser_snapshot',
        {}
      );

      const links = extractSameOriginLinks(snapshot, origin).slice(0, maxActionsPerPage);
      for (const link of links) {
        if (!visited.has(link) && depth + 1 <= maxDepth) {
          queue.push({ url: link, depth: depth + 1 });
        }
      }

      const networkResult = await options.runTool(
        'mcp__plugin_playwright_playwright__browser_network_requests',
        {}
      );
      capturedEntries.push(...coerceHarEntries(networkResult));
    } catch (error) {
      logger.warn(
        `Autonomous exploration step failed for ${url} (non-fatal, continuing crawl)`,
        { error: error instanceof Error ? error.message : String(error) }
      );
    }
  }

  return normalizeCapturedRequests(capturedEntries);
}
