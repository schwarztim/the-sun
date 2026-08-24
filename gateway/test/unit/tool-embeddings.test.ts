/**
 * Hermetic tests for the semantic ranking engine (tool-embeddings.ts).
 *
 * The real transformers.js model is NEVER loaded here. A deterministic stub
 * embedder maps known texts to fixed vectors, so ranking is fully reproducible
 * and requires no network or model download (CI-safe).
 */
import { describe, it, expect } from "vitest";
import {
  cosineSimilarity,
  ToolSemanticIndex,
  type Embedder,
  type EmbeddableTool,
} from "../../src/tool-embeddings.js";

/**
 * Stub embedder: maps a text to a fixed vector by keyword. A query about
 * "messaging" is placed near the "send" tool and far from the "weather" tool,
 * proving semantic ranking works on meaning, not literal token overlap.
 */
function stubEmbedder(): Embedder {
  const vectors: Record<string, number[]> = {
    // axis 0 = messaging, axis 1 = weather, axis 2 = filler
    send_tool: [1, 0, 0],
    weather_tool: [0, 1, 0],
    // A query with NO literal token overlap with "send_tool" but semantically
    // closest to the messaging axis.
    "contact a colleague": [0.9, 0.1, 0],
    "forecast for tomorrow": [0.1, 0.9, 0],
  };
  return {
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((t) => vectors[t] ?? [0, 0, 1]);
    },
  };
}

describe("cosineSimilarity", () => {
  it("returns 1 for identical direction", () => {
    expect(cosineSimilarity([1, 0], [2, 0])).toBeCloseTo(1);
  });
  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });
  it("returns 0 (not NaN) for a zero-magnitude vector", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe("ToolSemanticIndex.rank", () => {
  const tools: EmbeddableTool[] = [
    { id: "send_tool", text: "send_tool" },
    { id: "weather_tool", text: "weather_tool" },
  ];

  it("ranks the semantically closer tool first even with no literal token overlap", async () => {
    const index = new ToolSemanticIndex(stubEmbedder());
    const ranked = await index.rank(tools, "contact a colleague");
    expect(ranked[0].id).toBe("send_tool");
    expect(ranked[1].id).toBe("weather_tool");
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  it("ranks the weather tool first for a weather query", async () => {
    const index = new ToolSemanticIndex(stubEmbedder());
    const ranked = await index.rank(tools, "forecast for tomorrow");
    expect(ranked[0].id).toBe("weather_tool");
  });

  it("respects top-k", async () => {
    const index = new ToolSemanticIndex(stubEmbedder());
    const ranked = await index.rank(tools, "contact a colleague", 1);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].id).toBe("send_tool");
  });

  it("returns [] for an empty tool set", async () => {
    const index = new ToolSemanticIndex(stubEmbedder());
    expect(await index.rank([], "anything")).toEqual([]);
  });
});

describe("ToolSemanticIndex caching", () => {
  it("embeds each (id,text) once and reuses the cache across queries", async () => {
    let embedCalls = 0;
    const counting: Embedder = {
      async embed(texts: string[]): Promise<number[][]> {
        embedCalls++;
        return texts.map(() => [1, 0, 0]);
      },
    };
    const index = new ToolSemanticIndex(counting);
    const tools: EmbeddableTool[] = [{ id: "a", text: "alpha" }];
    await index.rank(tools, "q1"); // one call for tools + one for query = 2
    const afterFirst = embedCalls;
    await index.rank(tools, "q2"); // tools cached; only the query is embedded
    // Second rank must NOT re-embed the (unchanged) tool set.
    expect(embedCalls).toBe(afterFirst + 1);
    expect(index.size).toBe(1);
  });

  it("re-embeds a tool when its text changes", async () => {
    let embeddedTexts: string[] = [];
    const recording: Embedder = {
      async embed(texts: string[]): Promise<number[][]> {
        embeddedTexts.push(...texts);
        return texts.map(() => [1, 0, 0]);
      },
    };
    const index = new ToolSemanticIndex(recording);
    await index.rank([{ id: "a", text: "old text" }], "q");
    embeddedTexts = [];
    await index.rank([{ id: "a", text: "new text" }], "q");
    expect(embeddedTexts).toContain("new text");
  });

  it("invalidate() clears the cache", async () => {
    const index = new ToolSemanticIndex(stubEmbedder());
    await index.rank([{ id: "send_tool", text: "send_tool" }], "contact a colleague");
    expect(index.size).toBe(1);
    index.invalidate();
    expect(index.size).toBe(0);
  });
});
