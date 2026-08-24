import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { EmbeddableTool, RankedTool, ToolSemanticIndex } from "./tool-embeddings.js";

export const MUX_TOOL_NAMES = {
  searchTools: "gateway_search_tools",
  describeTool: "gateway_describe_tool",
  callTool: "gateway_call_tool",
  fetchArtifact: "gateway_fetch_artifact",
  backendStatus: "gateway_backend_status",
  fleetInventory: "gateway_fleet_inventory",
  mcpuConfig: "gateway_mcpu_config",
  reconnectBackend: "gateway_reconnect_backend",
} as const;

export type MuxToolName = (typeof MUX_TOOL_NAMES)[keyof typeof MUX_TOOL_NAMES];

export function isMuxToolName(name: string): name is MuxToolName {
  return Object.values(MUX_TOOL_NAMES).includes(name as MuxToolName);
}

/**
 * Pure helper that extracts the target tool name and forwarded arguments from
 * gateway_call_tool input args. Exported for unit testing.
 *
 * The `arguments` field must be a plain object nested under the `arguments` key —
 * extra top-level properties are intentionally ignored. This documents the
 * original failure mode: passing pageId at the top level (instead of under
 * `arguments`) silently produces an empty targetArgs and causes the backend to
 * receive no arguments (e.g. Confluence 404).
 */
export function extractCallToolArgs(args: Record<string, unknown>): {
  target: string;
  targetArgs: Record<string, unknown>;
} {
  const target = typeof args.tool === "string" ? args.tool : "";
  const targetArgs =
    typeof args.arguments === "object" &&
    args.arguments !== null &&
    !Array.isArray(args.arguments)
      ? (args.arguments as Record<string, unknown>)
      : {};
  return { target, targetArgs };
}

// ─── Tool search ranking (semantic with keyword fallback) ─────────────────────

/**
 * Bonus that forces an exact namespaced-name match to the top of the ranking,
 * regardless of semantic or token score. Mirrors the gateway's existing
 * exact-match pin so behavior is preserved when semantic search degrades to
 * keyword search.
 */
export const EXACT_MATCH_BONUS = 100_000;

/** Which ranking path produced a search result (surfaced for observability). */
export type SearchMode = "semantic" | "keyword";

/**
 * A search candidate: a stable id (the namespaced tool name) plus the haystack
 * text the caller has already assembled (name, description, tags, backend...).
 * The same text is used for keyword tokens and for the embedding, so the two
 * ranking paths see identical inputs.
 */
export interface SearchCandidate {
  id: string;
  text: string;
}

export interface RankOptions {
  /** When false, always use keyword ranking (never touch the embedder). */
  semantic: boolean;
  /** Prebuilt semantic index (embedder injected). Absent => keyword only. */
  index?: ToolSemanticIndex | null;
  /** Log sink for the fallback warning and the re-embed warning. */
  logger?: { warn: (msg: string) => void };
  /**
   * Reports embedding work done by this rank: (batches, toolsEmbedded). Both 0
   * on a warm cache. Wired to the metrics registry so the expensive path is
   * observable at any log level.
   */
  onEmbedStats?: (batches: number, toolsEmbedded: number) => void;
  /** Test/observability hook fired once when semantic falls back to keyword. */
  onFallback?: (reason: string) => void;
}

export interface RankOutcome {
  mode: SearchMode;
  /** Ranked ids with scores, descending. Keyword drops zero-score token hits. */
  ranked: RankedTool[];
}

/** Tokenize like the gateway's lexical search: lowercase, split, dedupe. */
export function keywordTokens(value: string): string[] {
  const tokens = value.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 0);
  return [...new Set(tokens)];
}

/**
 * Deterministic token-set ranking, behavior-compatible with the gateway's
 * existing lexical search: score = number of query tokens present in the
 * candidate's token set; entries with zero score are dropped when the query has
 * tokens; an exact id match is pinned to the top; ties break on id ascending.
 */
export function keywordRank(candidates: SearchCandidate[], query: string): RankedTool[] {
  const queryTokens = keywordTokens(query);
  const queryHasTokens = queryTokens.length > 0;
  const normalizedQuery = query.trim().toLowerCase();

  const scored: RankedTool[] = [];
  for (const c of candidates) {
    const haystack = new Set(keywordTokens(c.text));
    let score = 0;
    for (const t of queryTokens) if (haystack.has(t)) score++;
    if (c.id.toLowerCase() === normalizedQuery && normalizedQuery.length > 0) {
      score += EXACT_MATCH_BONUS;
    }
    // When the query carries tokens, drop pure non-matches (keeps parity with
    // the lexical path). With no query tokens (backend-only listing) keep all.
    if (queryHasTokens && score === 0) continue;
    scored.push({ id: c.id, score });
  }
  scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.id.localeCompare(b.id)));
  return scored;
}

/** Re-pin an exact id match to the top of an already-ranked list (semantic path). */
function applyExactMatchPin(ranked: RankedTool[], query: string): RankedTool[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return ranked;
  let pinnedFound = false;
  const pinned = ranked.map((r) => {
    if (r.id.toLowerCase() === normalizedQuery) {
      pinnedFound = true;
      return { id: r.id, score: r.score + EXACT_MATCH_BONUS };
    }
    return r;
  });
  if (!pinnedFound) return ranked;
  pinned.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.id.localeCompare(b.id)));
  return pinned;
}

/**
 * Rank search candidates semantically when enabled and an embedding index is
 * available, otherwise (or on ANY embedding failure) fall back to keyword
 * ranking. This is the robustness contract for the facade: the search never
 * breaks, it only degrades. Exactly one warning is logged on fallback.
 */
export async function rankCandidates(
  candidates: SearchCandidate[],
  query: string,
  opts: RankOptions
): Promise<RankOutcome> {
  if (opts.semantic && opts.index) {
    try {
      const ranked = await opts.index.rank(
        candidates.map<EmbeddableTool>((c) => ({ id: c.id, text: c.text })),
        query
      );
      // A successful semantic rank used to log NOTHING, which is how a full
      // re-embed of the entire tool set stayed invisible (STAB-4).
      //
      // Counters, not an info line: production runs at log level "warn" (capped
      // deliberately after a 1 GB log incident), so an info line is invisible
      // exactly where this matters. onEmbedStats feeds the metrics registry,
      // which is level-independent and already scraped.
      const batches = opts.index.lastBatchCount;
      opts.onEmbedStats?.(batches, opts.index.lastEmbedCount);

      // The one case that IS worth a log line is the rare, expensive one: a
      // cold or invalidated cache forcing a re-embed. Warn level so it survives
      // the production cap. Routine warm-cache ranking stays silent.
      if (batches > 0) {
        opts.logger?.warn(
          `gateway_search_tools: re-embedded ${opts.index.lastEmbedCount} of ${candidates.length} tool(s) in ${batches} batch(es) (cold or invalidated cache)`
        );
      }
      return { mode: "semantic", ranked: applyExactMatchPin(ranked, query) };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      opts.logger?.warn(
        `gateway_search_tools: semantic ranking unavailable, falling back to keyword search (${reason})`
      );
      opts.onFallback?.(reason);
    }
  }
  return { mode: "keyword", ranked: keywordRank(candidates, query) };
}

export function getMuxTools(): Tool[] {
  return [
    {
      name: MUX_TOOL_NAMES.searchTools,
      description: "Search connected backend tools without exposing every backend tool schema in tools/list. Ranks by semantic relevance (local embedding model) so a query finds the most relevant tools even without a literal name/description match; falls back to keyword ranking when the embedding model is unavailable. Requires query or backend filter.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural-language or keyword search text for tool name, description, or backend." },
          backend: { type: "string", description: "Optional backend name filter." },
          limit: { type: "number", description: "Maximum matches to return.", default: 10 },
        },
      },
    },
    {
      name: MUX_TOOL_NAMES.describeTool,
      description: "Describe one namespaced backend tool returned by gateway_search_tools. Full schema is capped and referenced if oversized.",
      inputSchema: {
        type: "object",
        properties: {
          tool: { type: "string", description: "Namespaced tool name to describe." },
        },
        required: ["tool"],
      },
    },
    {
      name: MUX_TOOL_NAMES.callTool,
      description: "Call one namespaced backend tool returned by gateway_search_tools. Large responses are compacted with artifact refs. Safety contract: tools classified as WRITE, SIDE_EFFECT, HUMAN_OUTBOUND, PRODUCTION, or VAULT_VALUE require confirmed:true to authorize the call. Blocking is the default posture: an unconfirmed write-class call returns a confirmationRequired response with a redacted argument preview and is not dispatched. READ tools need no confirmation. UNCLASSIFIED tools (no manifest entry, no write-verb match) proceed with a logged warning in every mode. In advisory mode unconfirmed write-class calls are logged but still proceed. Two-step confirm flow: a blocked call returns a confirmToken; authorize it by re-calling the SAME tool with BYTE-IDENTICAL arguments plus top-level confirmed:true and confirmToken. Any change to the arguments invalidates the token (it is bound to the exact argument bytes); tokens expire 10 minutes after issue.",
      inputSchema: {
        type: "object",
        properties: {
          tool: { type: "string", description: "Namespaced tool name to call." },
          arguments: { type: "object", description: "Arguments to pass to the backend tool.", additionalProperties: true },
          maxOutputChars: {
            type: "number",
            description: "Optional response text budget. Defaults to the gateway facade cap and is bounded by a hard max.",
          },
          confirmed: {
            type: "boolean",
            description: "Set true to authorize a tool the gateway classifies as WRITE/SIDE_EFFECT/HUMAN_OUTBOUND/PRODUCTION/VAULT_VALUE. READ and UNCLASSIFIED tools need no confirmation.",
          },
          confirmToken: {
            type: "string",
            description: "Echo the confirmToken from a confirmationRequired response, together with confirmed:true and BYTE-IDENTICAL arguments, to authorize the blocked call. Any argument change invalidates the token; it expires 10 minutes after issue.",
          },
        },
        required: ["tool"],
      },
    },
    {
      name: MUX_TOOL_NAMES.fetchArtifact,
      description: "Fetch a capped page from an oversized response artifact previously returned by the gateway.",
      inputSchema: {
        type: "object",
        properties: {
          artifactId: { type: "string", description: "Artifact ID returned by another gateway tool." },
          offset: { type: "number", description: "Character offset to start reading from.", default: 0 },
          maxChars: { type: "number", description: "Maximum characters to return.", default: 8000 },
        },
        required: ["artifactId"],
      },
    },
    {
      name: MUX_TOOL_NAMES.backendStatus,
      description: "Return compact gateway backend health counts. Backend lists are returned only with a filter or includeBackends=true.",
      inputSchema: {
        type: "object",
        properties: {
          backend: { type: "string", description: "Optional backend name filter." },
          limit: { type: "number", description: "Maximum backends to return when listing.", default: 10 },
          includeBackends: { type: "boolean", description: "Include a capped backend list. Defaults to false unless backend is set.", default: false },
          includeErrors: { type: "boolean", description: "Include truncated backend error text.", default: false },
          includeDescriptions: { type: "boolean", description: "Include truncated backend descriptions.", default: false },
        },
      },
    },
    {
      name: MUX_TOOL_NAMES.fleetInventory,
      description: "Return the read-only ToolHive fleet inventory or summary, including degraded backend reasons and repair hints.",
      inputSchema: {
        type: "object",
        properties: {
          summaryOnly: { type: "boolean", description: "Return only summary counts and source paths. Defaults to true.", default: true },
          includeEntries: { type: "boolean", description: "Return a capped compact entry list. Full raw inventory is available only through the local admin API.", default: false },
          limit: { type: "number", description: "Maximum compact fleet entries to return.", default: 10 },
          probe: { type: "boolean", description: "Run TCP endpoint checks while building the inventory.", default: false },
        },
      },
    },
    {
      name: MUX_TOOL_NAMES.mcpuConfig,
      description: "Generate a read-only MCPU-compatible server config from the durable ToolHive fleet catalog, preserving degraded entries with reasons.",
      inputSchema: {
        type: "object",
        properties: {
          probe: { type: "boolean", description: "Run TCP endpoint checks while building the source inventory.", default: false },
          configOnly: { type: "boolean", description: "Return a capped compact mcpServers-compatible config preview.", default: false },
          includeEntries: { type: "boolean", description: "Include a capped compact source-entry preview.", default: false },
          limit: { type: "number", description: "Maximum config/entry previews to return.", default: 10 },
        },
      },
    },
    {
      name: MUX_TOOL_NAMES.reconnectBackend,
      description: "Force a fresh transport session to one backend without bouncing the whole gateway. Use after a backend container restart (cookie reauth, image upgrade) when the gateway is still holding a stale session and tool calls return -32001 'Session not found'. Other backends are untouched.",
      inputSchema: {
        type: "object",
        properties: {
          backend: { type: "string", description: "Backend name to reconnect (e.g. 'servicenow')." },
        },
        required: ["backend"],
      },
    },
  ];
}
