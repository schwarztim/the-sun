/**
 * Hermetic tests for the search orchestrator (mux-tools.ts rankCandidates) and
 * its keyword-fallback robustness contract. No real embedding model is loaded:
 * a deterministic stub index provides semantic scores, and a throwing stub
 * proves the fallback fires and one warning is logged.
 */
import { describe, it, expect, vi } from "vitest";
import {
  rankCandidates,
  keywordRank,
  keywordTokens,
  EXACT_MATCH_BONUS,
  type SearchCandidate,
} from "../../src/mux-tools.js";
import { ToolSemanticIndex, type Embedder } from "../../src/tool-embeddings.js";

const CANDIDATES: SearchCandidate[] = [
  { id: "az_teams_send_message", text: "az_teams_send_message send a teams message outbound" },
  { id: "snow_get_incident", text: "snow_get_incident get a servicenow incident read" },
];

/** Stub embedder placing a "messaging" query nearest the teams send tool. */
function semanticIndex(): ToolSemanticIndex {
  const vectors: Record<string, number[]> = {
    "az_teams_send_message send a teams message outbound": [1, 0],
    "snow_get_incident get a servicenow incident read": [0, 1],
    "notify a coworker": [0.95, 0.05],
  };
  const embedder: Embedder = {
    async embed(texts) {
      return texts.map((t) => vectors[t] ?? [0.5, 0.5]);
    },
  };
  return new ToolSemanticIndex(embedder);
}

// ─── keyword primitives ───────────────────────────────────────────────────────

describe("keywordTokens", () => {
  it("lowercases, splits on non-alphanumerics, and dedupes", () => {
    expect(keywordTokens("Send_A Teams-message send")).toEqual(["send", "a", "teams", "message"]);
  });
});

describe("keywordRank", () => {
  it("scores by token-set intersection and drops zero-score entries for a token query", () => {
    const ranked = keywordRank(CANDIDATES, "send teams");
    expect(ranked.map((r) => r.id)).toEqual(["az_teams_send_message"]);
  });

  it("pins an exact id match to the top with the bonus", () => {
    const ranked = keywordRank(CANDIDATES, "az_teams_send_message");
    expect(ranked[0].id).toBe("az_teams_send_message");
    expect(ranked[0].score).toBeGreaterThanOrEqual(EXACT_MATCH_BONUS);
  });

  it("keeps all candidates (score 0) when the query has no tokens", () => {
    const ranked = keywordRank(CANDIDATES, "");
    expect(ranked).toHaveLength(2);
    expect(ranked.every((r) => r.score === 0)).toBe(true);
  });
});

// ─── semantic path ────────────────────────────────────────────────────────────

describe("rankCandidates — semantic path", () => {
  it("ranks by cosine similarity, surfacing the relevant tool for a non-literal query", async () => {
    const outcome = await rankCandidates(CANDIDATES, "notify a coworker", {
      semantic: true,
      index: semanticIndex(),
    });
    expect(outcome.mode).toBe("semantic");
    expect(outcome.ranked[0].id).toBe("az_teams_send_message");
    expect(outcome.ranked[0].score).toBeGreaterThan(outcome.ranked[1].score);
  });

  it("pins an exact id match to the top in semantic mode", async () => {
    const outcome = await rankCandidates(CANDIDATES, "snow_get_incident", {
      semantic: true,
      index: semanticIndex(),
    });
    expect(outcome.mode).toBe("semantic");
    expect(outcome.ranked[0].id).toBe("snow_get_incident");
    expect(outcome.ranked[0].score).toBeGreaterThanOrEqual(EXACT_MATCH_BONUS);
  });
});

// ─── keyword fallback (robustness) ────────────────────────────────────────────

describe("rankCandidates — keyword fallback", () => {
  it("uses keyword ranking when semantic is disabled (index untouched)", async () => {
    const outcome = await rankCandidates(CANDIDATES, "send teams", {
      semantic: false,
      index: semanticIndex(),
    });
    expect(outcome.mode).toBe("keyword");
    expect(outcome.ranked.map((r) => r.id)).toEqual(["az_teams_send_message"]);
  });

  it("uses keyword ranking when no index is available", async () => {
    const outcome = await rankCandidates(CANDIDATES, "servicenow incident", {
      semantic: true,
      index: null,
    });
    expect(outcome.mode).toBe("keyword");
    expect(outcome.ranked.map((r) => r.id)).toEqual(["snow_get_incident"]);
  });

  it("falls back to keyword and logs exactly one warning when the embedder throws", async () => {
    const throwingIndex = new ToolSemanticIndex({
      async embed() {
        throw new Error("model load failed");
      },
    });
    const warn = vi.fn();
    const onFallback = vi.fn();
    const outcome = await rankCandidates(CANDIDATES, "send teams", {
      semantic: true,
      index: throwingIndex,
      logger: { warn },
      onFallback,
    });
    expect(outcome.mode).toBe("keyword");
    expect(outcome.ranked.map((r) => r.id)).toEqual(["az_teams_send_message"]);
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/falling back to keyword/i);
  });

  it("fallback keyword results match a direct keywordRank call (behavior parity)", async () => {
    const throwingIndex = new ToolSemanticIndex({
      async embed() {
        throw new Error("boom");
      },
    });
    const outcome = await rankCandidates(CANDIDATES, "send teams", {
      semantic: true,
      index: throwingIndex,
      logger: { warn: () => {} },
    });
    expect(outcome.ranked).toEqual(keywordRank(CANDIDATES, "send teams"));
  });
});
