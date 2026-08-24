/**
 * embed-batching.test.ts (STAB-4) — pins the memory bound on tool embedding.
 *
 * The gateway used to embed the ENTIRE tool set in one embedder call. Memory in
 * a transformer forward pass is O(batch x heads x sequence^2), so on a 354-tool
 * fleet that single call allocated multiple gigabytes inside the ONNX native
 * arena (invisible to V8, unreclaimable by GC), and the supervisor killed the
 * process. Reproduced at 87 MB to 9.4 GB RSS from one gateway_search_tools call.
 *
 * These tests pin the two bounds that fixed it, so a future refactor cannot
 * silently restore the wide call:
 *   1. work is split into bounded chunks, never one call over everything
 *   2. the default embedder passes truncation with an explicit max_length
 */
import { describe, expect, it } from "vitest";
import { ToolSemanticIndex, type EmbeddableTool } from "../../src/tool-embeddings.js";

/** Records every batch it is handed, then returns deterministic unit vectors. */
function recordingEmbedder() {
  const batches: string[][] = [];
  return {
    batches,
    embed: async (texts: string[]): Promise<number[][]> => {
      batches.push(texts);
      // Deterministic, distinct, non-zero vectors; content is irrelevant here.
      return texts.map((t) => [t.length % 7, (t.length % 5) + 1, 1]);
    },
  };
}

function tools(n: number): EmbeddableTool[] {
  return Array.from({ length: n }, (_, i) => ({ id: `be_tool_${i}`, text: `tool ${i} description` }));
}

describe("ToolSemanticIndex batching bound (STAB-4)", () => {
  it("splits a large tool set into multiple bounded calls, never one wide call", async () => {
    const embedder = recordingEmbedder();
    const index = new ToolSemanticIndex(embedder);
    const all = tools(354); // the fleet size that triggered the original crash

    await index.rank(all, "find something");

    // The embed calls for tools, excluding the single query embed at the end.
    const toolBatches = embedder.batches.filter((b) => b.length !== 1 || b[0] !== "find something");
    expect(toolBatches.length).toBeGreaterThan(1);

    // The load-bearing assertion: no single call may carry the whole tool set.
    for (const batch of toolBatches) {
      expect(batch.length).toBeLessThanOrEqual(32);
    }
    expect(Math.max(...toolBatches.map((b) => b.length))).toBeLessThan(all.length);

    // Every tool still got embedded exactly once.
    expect(toolBatches.flat().length).toBe(all.length);
    expect(index.size).toBe(all.length);
  });

  it("reports how many embed batches a rank actually triggered", async () => {
    const embedder = recordingEmbedder();
    const index = new ToolSemanticIndex(embedder);

    await index.rank(tools(100), "q");
    expect(index.lastBatchCount).toBeGreaterThan(1);

    // A warm cache must do no embedding work at all, and must say so.
    await index.rank(tools(100), "q");
    expect(index.lastBatchCount).toBe(0);
  });

  it("re-embeds in bounded chunks after invalidate, not in one wide call", async () => {
    // invalidate() runs whenever the tool registry version changes (any
    // successful backend reconnect), so the re-embed path must stay bounded too.
    const embedder = recordingEmbedder();
    const index = new ToolSemanticIndex(embedder);
    const all = tools(200);

    await index.rank(all, "q");
    index.invalidate();
    embedder.batches.length = 0;
    await index.rank(all, "q");

    const toolBatches = embedder.batches.filter((b) => b.length !== 1 || b[0] !== "q");
    expect(toolBatches.length).toBeGreaterThan(1);
    for (const batch of toolBatches) expect(batch.length).toBeLessThanOrEqual(32);
  });

  it("ranks correctly across chunk boundaries", async () => {
    // Chunking must not drop, duplicate, or misalign a tool with its vector.
    const embedder = recordingEmbedder();
    const index = new ToolSemanticIndex(embedder);
    const all = tools(50);

    const ranked = await index.rank(all, "q");
    expect(ranked.length).toBe(all.length);
    expect(new Set(ranked.map((r) => r.id)).size).toBe(all.length);
    for (const r of ranked) expect(Number.isFinite(r.score)).toBe(true);
  });
});

describe("invalidate prunes rather than clears (STAB-7)", () => {
  it("keeps cached embeddings for tools that still exist", async () => {
    const embedder = recordingEmbedder();
    const index = new ToolSemanticIndex(embedder);
    const all = tools(40);

    await index.rank(all, "q");
    expect(index.size).toBe(40);

    // A registry version bump where nothing was actually removed must NOT force
    // a re-embed: clearing here is what made every reconnect wave expensive.
    index.invalidate(new Set(all.map((t) => t.id)));
    expect(index.size).toBe(40);

    embedder.batches.length = 0;
    await index.rank(all, "q");
    expect(index.lastBatchCount).toBe(0);
    expect(index.lastEmbedCount).toBe(0);
  });

  it("drops only the ids that no longer exist", async () => {
    const embedder = recordingEmbedder();
    const index = new ToolSemanticIndex(embedder);
    const all = tools(40);
    await index.rank(all, "q");

    const survivors = all.slice(0, 25);
    index.invalidate(new Set(survivors.map((t) => t.id)));
    expect(index.size).toBe(25);

    // Only the survivors are warm; a rank over just them does no embedding.
    await index.rank(survivors, "q");
    expect(index.lastEmbedCount).toBe(0);
  });

  it("still clears everything when called with no argument", async () => {
    const embedder = recordingEmbedder();
    const index = new ToolSemanticIndex(embedder);
    await index.rank(tools(10), "q");
    index.invalidate();
    expect(index.size).toBe(0);
  });

  it("re-embeds a tool whose text changed even though its id survived", async () => {
    const embedder = recordingEmbedder();
    const index = new ToolSemanticIndex(embedder);
    const before = tools(5);
    await index.rank(before, "q");

    const after = before.map((t, i) => (i === 2 ? { ...t, text: `${t.text} CHANGED` } : t));
    index.invalidate(new Set(after.map((t) => t.id)));
    await index.rank(after, "q");

    // Pruning must not defeat the existing per-tool staleness check.
    expect(index.lastEmbedCount).toBe(1);
  });
});

describe("default embedder sequence bound (STAB-4)", () => {
  it("passes truncation and an explicit max_length to the extractor", async () => {
    // Without these, transformers.js pads a batch to its LONGEST member, so one
    // verbose tool description sets the squared sequence cost for every tool
    // batched with it. Asserted against the source because constructing the real
    // extractor would download and run an ONNX model in unit tests.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../src/tool-embeddings.ts", import.meta.url), "utf-8");

    expect(src).toMatch(/truncation:\s*true/);
    expect(src).toMatch(/max_length:\s*MAX_SEQUENCE_TOKENS/);
    expect(src).toMatch(/const MAX_SEQUENCE_TOKENS = \d+/);
  });
});

describe("embedding yields to the event loop (STAB-11)", () => {
  it("lets timer and IO callbacks run BETWEEN batches", async () => {
    // The regression this pins: chunking bounded memory but the batches still
    // ran back to back, so a cold embed blocked the loop for ~20 seconds,
    // /healthz stopped answering, and the supervisor killed the process after 3
    // failed probes. Every respawn started cold, so the loop sustained itself.
    const embedder = recordingEmbedder();
    const index = new ToolSemanticIndex(embedder);

    let timerFired = 0;
    const timer = setInterval(() => { timerFired++; }, 5);
    try {
      await index.rank(tools(64), "q");
    } finally {
      clearInterval(timer);
    }

    // With a real yield between batches the loop reaches its timer phase during
    // the embed. A microtask-only yield (awaiting an already-resolved promise)
    // would leave this at 0, which is exactly the bug.
    expect(timerFired).toBeGreaterThan(0);
  });

  it("yields between every batch, not only once", async () => {
    const embedder = recordingEmbedder();
    const index = new ToolSemanticIndex(embedder);
    const ticks: number[] = [];
    const timer = setInterval(() => { ticks.push(Date.now()); }, 5);
    try {
      await index.rank(tools(200), "q");   // many batches
    } finally {
      clearInterval(timer);
    }
    // Several separate opportunities for the loop to run, not a single window.
    expect(ticks.length).toBeGreaterThan(2);
  });

  it("uses a macrotask yield, never a bare microtask await", async () => {
    // Asserted against the source: a bare `await Promise.resolve()` looks like a
    // yield and changes nothing, because microtasks drain before the loop ever
    // returns to its poll phase. That distinction IS the bug.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../src/tool-embeddings.ts", import.meta.url), "utf-8");
    expect(src).toMatch(/from "node:timers\/promises"/);
    expect(src).toMatch(/await sleep\(EMBED_YIELD_MS\)/);
    expect(src).toMatch(/const EMBED_YIELD_MS = \d+/);
  });
});
