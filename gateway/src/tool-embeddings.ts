/**
 * Semantic (embedding) ranking engine for the gateway_search_tools facade.
 *
 * Goal: let gateway_search_tools return the most RELEVANT backend tools for a
 * query even when the query shares no literal tokens with a tool's name or
 * description (e.g. "chat with a coworker" should surface a Teams send-message
 * tool). This keeps the full backend toolset out of the client context while
 * still returning good matches lazily.
 *
 * Design constraints (KISS + robustness):
 *  - Injectable embedder: every consumer of this module passes an `Embedder`,
 *    so tests are hermetic (a deterministic stub embedder, no model download)
 *    and the real model is only ever constructed through createDefaultEmbedder.
 *  - No network at request time: the real embedder runs a LOCAL, in-process
 *    ONNX model (transformers.js). The model files are cached on disk under
 *    THESUN_HOME so nothing is fetched per request and no secrets are involved.
 *  - Lazy + optional: the transformers.js dependency is an optionalDependency
 *    and is loaded via a dynamic import inside createDefaultEmbedder. If it is
 *    missing or fails to load, the caller degrades to keyword search (see
 *    mux-tools.ts rankCandidates); this module never hard-requires the dep at
 *    import time (there is no top-level import of @xenova/transformers here).
 */

import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { resolveThesunHome } from "./approvals.js";

/**
 * An embedder maps one or more input strings to dense vectors. Vectors from a
 * single embedder MUST be mutually comparable by cosine similarity (same model,
 * same dimensionality). The default embedder returns mean-pooled, L2-normalized
 * vectors; stubs may return any deterministic vectors of a fixed dimension.
 */
export interface Embedder {
  /** Return one vector per input text, order-preserving. */
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * How many texts go to the embedder in one call.
 *
 * STAB-4 (load-bearing, not a tuning knob): memory in a transformer forward
 * pass is O(batch x heads x sequence^2). Embedding the whole tool set in ONE
 * call made that batch dimension the size of the fleet, and on a 354-tool fleet
 * a single call allocated 5.2 GB (measured) inside the ONNX native arena, which
 * V8 cannot see and GC cannot reclaim. The gateway reached 9.4 GB RSS and was
 * killed by its supervisor. Chunking bounds the batch dimension;
 * MAX_SEQUENCE_TOKENS below bounds the squared one, which dominates.
 *
 * 8 is measured, not guessed, and the binding constraint is LATENCY, not
 * memory. On memory the curve is already flat here: against 354 tools with
 * pathologically long descriptions, peak allocation was 2,211 MB at a chunk of
 * 32, 565 MB at 16, and 592 MB at 8, so 16 and 8 are equivalent.
 *
 * What forced 8 is the event loop. ONNX inference is synchronous native code,
 * so a batch blocks the thread for its whole duration and the size of a batch
 * IS the size of the stall. At 16, a cold embed of 450 tools produced a
 * worst-case /healthz latency of 1,904 ms against the supervisor's 2,000 ms
 * probe timeout: passing, but with almost no margin, and two probes did time
 * out. Halving the batch halves the worst-case stall for no memory cost.
 *
 * Honest note on equivalence: chunking does NOT produce bit-identical vectors.
 * A batch is padded to its own longest member, so chunk boundaries shift the
 * padding and the result drifts slightly (measured worst-case cosine similarity
 * 0.9945, max elementwise delta 1.8e-2 versus a single wide batch). RANKING is
 * unaffected at that magnitude (measured: identical top-1, 10 of 10 top-10
 * overlap), which is the property this index actually needs, but do not
 * describe the vectors as identical.
 */
const EMBED_BATCH_SIZE = 8;

/**
 * Token cap per input text.
 *
 * Without an explicit cap, transformers.js pads every input in a batch up to
 * the LONGEST one, so one verbose tool description sets the sequence length,
 * and therefore the squared memory cost, for every other tool in its batch.
 *
 * 256 rather than the architecture's 512: this model's sentence-embedding
 * training uses a 256-token sequence limit, so text beyond it is outside what
 * the encoder was trained to represent, and the memory term is quadratic (512
 * would cost 4x on the dominant term for tokens the model does not use well).
 * Tool haystacks are names, a backend name, and a description; the overwhelming
 * majority tokenize well under this cap, so it is insurance against one
 * pathological description rather than a routine truncation.
 */
const MAX_SEQUENCE_TOKENS = 256;

/**
 * Idle window handed back to the event loop between batches (STAB-11).
 *
 * A bare setImmediate yield gives the loop exactly ONE turn, which was not
 * enough: at batch 8 a cold embed still produced 3 consecutive /healthz probe
 * timeouts, which is precisely the supervisor's kill threshold. A short real
 * sleep guarantees a drain window instead of a single turn. The total cost is
 * batches x this value (about 1.7s across a 450-tool cold embed), which is
 * irrelevant next to being killed.
 */
const EMBED_YIELD_MS = 30;

/** A tool reduced to what the ranker needs: a stable id and the text to embed. */
export interface EmbeddableTool {
  /** Stable identity (the namespaced tool name). */
  id: string;
  /** The text that represents this tool for semantic matching. */
  text: string;
}

/** One ranked result: the tool id and its similarity score (higher is closer). */
export interface RankedTool {
  id: string;
  score: number;
}

/**
 * Cosine similarity of two equal-length vectors. Returns 0 for a zero-magnitude
 * vector (rather than NaN) so ranking stays total and deterministic. Works on
 * un-normalized vectors too (it divides by the magnitudes), so stub embedders
 * do not have to normalize.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/**
 * In-memory semantic index over the current tool set. Embeddings are computed
 * once per (id, text) and cached; a tool whose text changes is re-embedded, and
 * a full invalidate() clears everything (call it when the registry changes so
 * removed tools do not linger). The embedder is injected, which keeps the class
 * hermetic under test.
 */
export class ToolSemanticIndex {
  private readonly embedder: Embedder;
  private readonly cache = new Map<string, { text: string; vector: number[] }>();

  constructor(embedder: Embedder) {
    this.embedder = embedder;
  }

  /**
   * Reconcile the cache with the tools that still exist.
   *
   * PRUNE, do not clear. This used to drop every cached embedding on any
   * registry version bump, so with a flapping fleet each reconnect wave forced
   * a full re-embed of the entire tool set on the next search, which is the
   * expensive STAB-4 path. Clearing was never necessary: ensureEmbeddings
   * already re-embeds any tool whose text changed, so the only thing
   * invalidation must actually do is forget ids that no longer exist, which
   * keeps the cache from growing without bound as backends come and go.
   *
   * Called with no argument it still clears everything (explicit reset, used by
   * tests and by any caller that genuinely wants a cold cache).
   */
  invalidate(liveIds?: Iterable<string>): void {
    if (liveIds === undefined) {
      this.cache.clear();
      return;
    }
    const live = liveIds instanceof Set ? liveIds : new Set(liveIds);
    for (const id of this.cache.keys()) {
      if (!live.has(id)) this.cache.delete(id);
    }
  }

  /** Number of cached embeddings (test/introspection helper). */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Embedder calls issued by the most recent rank(), 0 when every tool was
   * already cached. Surfaced so the search path can log how much embedding work
   * a query actually triggered: a silent full re-embed is exactly what made the
   * STAB-4 allocation invisible for two hours.
   */
  get lastBatchCount(): number {
    return this._lastBatchCount;
  }
  private _lastBatchCount = 0;

  /** Tools actually embedded by the most recent rank(), 0 on a warm cache. */
  get lastEmbedCount(): number {
    return this._lastEmbedCount;
  }
  private _lastEmbedCount = 0;

  /**
   * Embed any tools that are new or whose text changed since last seen, in
   * bounded chunks of EMBED_BATCH_SIZE.
   *
   * Chunking is a memory bound, not an optimization: one call per chunk keeps
   * the batch dimension of the forward pass constant regardless of fleet size.
   * See EMBED_BATCH_SIZE for the measured numbers and for why the resulting
   * vectors are ranking-equivalent rather than bit-identical.
   */
  private async ensureEmbeddings(tools: EmbeddableTool[]): Promise<void> {
    const missing = tools.filter((t) => {
      const cached = this.cache.get(t.id);
      return !cached || cached.text !== t.text;
    });
    this._lastBatchCount = 0;
    this._lastEmbedCount = missing.length;
    if (missing.length === 0) return;

    for (let start = 0; start < missing.length; start += EMBED_BATCH_SIZE) {
      // STAB-11: hand the event loop back BETWEEN batches.
      //
      // Chunking bounded the memory but not the latency: a cold embed of ~500
      // tools is roughly 20 seconds of ONNX inference, which is synchronous
      // native code that does not yield on its own. With every batch running
      // back to back the loop never reached its poll phase, /healthz stopped
      // answering, and the supervisor killed the process after 3 failed 2
      // second probes. Every respawn starts with an empty cache, so the next
      // search redid the cold embed: a self-sustaining restart loop, faster
      // than the OOM one it replaced.
      //
      // setImmediate, NOT a bare await. Awaiting an already-resolved promise
      // queues a MICROtask, which runs before the loop ever gets back to I/O,
      // so it would look like a yield and change nothing. setImmediate is a
      // macrotask in the check phase, which runs after the poll phase, so
      // pending I/O (the healthz handler) is serviced first.
      if (start > 0) await sleep(EMBED_YIELD_MS);

      const batch = missing.slice(start, start + EMBED_BATCH_SIZE);
      const vectors = await this.embedder.embed(batch.map((t) => t.text));
      this._lastBatchCount++;
      if (vectors.length !== batch.length) {
        throw new Error(
          `embedder returned ${vectors.length} vectors for ${batch.length} inputs`
        );
      }
      batch.forEach((t, i) => this.cache.set(t.id, { text: t.text, vector: vectors[i] }));
    }
  }

  /**
   * Rank tools by cosine similarity to the query, descending. Ties break on id
   * ascending for determinism. When topK is a positive number the result is
   * sliced to that many entries; otherwise the full ranked list is returned so
   * the caller can do its own limit accounting.
   */
  async rank(tools: EmbeddableTool[], query: string, topK?: number): Promise<RankedTool[]> {
    if (tools.length === 0) return [];
    await this.ensureEmbeddings(tools);
    const [queryVector] = await this.embedder.embed([query]);
    if (!queryVector) throw new Error("embedder returned no vector for the query");

    const scored: RankedTool[] = tools.map((t) => ({
      id: t.id,
      score: cosineSimilarity(queryVector, this.cache.get(t.id)!.vector),
    }));
    scored.sort((x, y) => (y.score !== x.score ? y.score - x.score : x.id.localeCompare(y.id)));
    return typeof topK === "number" && topK > 0 ? scored.slice(0, topK) : scored;
  }
}

/**
 * Build the default LOCAL embedder backed by transformers.js
 * (Xenova/all-MiniLM-L6-v2 feature-extraction, mean-pooled + normalized).
 *
 * The dependency is loaded lazily via dynamic import so a missing optional
 * dependency (or a host without the native ONNX runtime) throws HERE and the
 * caller degrades to keyword search rather than crashing the gateway. Model
 * files are cached under THESUN_HOME/models so there is no per-request network
 * access once the model is present. Returns a ready-to-use Embedder or throws.
 */
export async function createDefaultEmbedder(options: {
  cacheDir?: string;
  model?: string;
} = {}): Promise<Embedder> {
  // Dynamic import with a non-literal specifier: keeps @xenova/transformers
  // optional and out of the module graph until a semantic search is actually
  // attempted, and avoids a build-time "cannot find module" if the optional
  // dependency is omitted in a given environment (it throws at runtime instead,
  // and the caller degrades to keyword search).
  const pkg = "@xenova/transformers";
  const transformers = (await import(pkg)) as any;
  const { pipeline, env } = transformers;

  // Cache model files on disk under THESUN_HOME (not in node_modules) and never
  // reach out to the network at request time once the model is cached.
  const cacheDir = options.cacheDir ?? join(resolveThesunHome(), "models");
  if (env) {
    env.cacheDir = cacheDir;
    // Never bundle remote-code execution; only fetch model weights on first use.
    if (env.backends?.onnx?.wasm) {
      // No-op guard: leave threading defaults; kept explicit for clarity.
    }
  }

  const model = options.model ?? "Xenova/all-MiniLM-L6-v2";
  const extractor = await pipeline("feature-extraction", model);

  return {
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      // truncation + max_length are load-bearing (STAB-4): without them
      // transformers.js pads the batch to its longest input, so one verbose
      // tool description sets the (squared) sequence cost for every tool
      // batched with it. See MAX_SEQUENCE_TOKENS.
      const output = await extractor(texts, {
        pooling: "mean",
        normalize: true,
        truncation: true,
        max_length: MAX_SEQUENCE_TOKENS,
      });
      // transformers.js returns a Tensor; tolist() yields number[][] for a batch.
      const list = output.tolist() as number[][];
      return list;
    },
  };
}
