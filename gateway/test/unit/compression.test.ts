/**
 * Phase 4 compression unit tests.
 *
 * The pure transform helpers (pruneEmpty, encodeColumnar, decodeColumnar,
 * isHomogeneousObjectArray, applyColumnarEncoding, applyJsonCompression) are
 * exported from gateway.ts and tested directly here — no Gateway instance
 * needed for the transform tests.
 *
 * The Gateway integration tests use a minimal stub that exposes compressToolText
 * through a thin public wrapper so we can verify the disabled-by-default gate,
 * the active/advisory modes, and the artifact store interaction.
 */

import { describe, it, expect } from "vitest";
import {
  pruneEmpty,
  isHomogeneousObjectArray,
  encodeColumnar,
  decodeColumnar,
  applyColumnarEncoding,
  applyJsonCompression,
  type ColumnarEnvelope,
} from "../../src/gateway.js";

// ─── pruneEmpty ───────────────────────────────────────────────────────────────

describe("pruneEmpty", () => {
  it("passes through primitives untouched", () => {
    expect(pruneEmpty(42)).toBe(42);
    expect(pruneEmpty("hello")).toBe("hello");
    expect(pruneEmpty(true)).toBe(true);
  });

  it("returns undefined for null, undefined, empty-string", () => {
    expect(pruneEmpty(null)).toBeUndefined();
    expect(pruneEmpty(undefined)).toBeUndefined();
    expect(pruneEmpty("")).toBeUndefined();
  });

  it("prunes null/empty-string values from objects, preserving non-empty keys", () => {
    const input = { a: 1, b: null, c: "", d: "keep" };
    expect(pruneEmpty(input)).toEqual({ a: 1, d: "keep" });
  });

  it("returns undefined for an object that becomes entirely empty after pruning", () => {
    expect(pruneEmpty({ a: null, b: "" })).toBeUndefined();
  });

  it("prunes empty arrays and empty objects", () => {
    expect(pruneEmpty({ a: [], b: {}, c: 1 })).toEqual({ c: 1 });
  });

  it("recursively prunes nested nulls", () => {
    const input = { outer: { inner: null, keep: 99 }, also: null };
    expect(pruneEmpty(input)).toEqual({ outer: { keep: 99 } });
  });

  it("prunes null elements from arrays, keeps non-null elements", () => {
    expect(pruneEmpty([1, null, 2, undefined, 3])).toEqual([1, 2, 3]);
  });
});

// ─── isHomogeneousObjectArray ─────────────────────────────────────────────────

describe("isHomogeneousObjectArray", () => {
  const makeRow = (i: number) => ({ id: i, name: `item_${i}`, value: i * 10 });

  it("returns true for a large array of same-key objects", () => {
    const arr = Array.from({ length: 10 }, (_, i) => makeRow(i));
    expect(isHomogeneousObjectArray(arr)).toBe(true);
  });

  it("returns false for arrays shorter than the minimum (8)", () => {
    const arr = Array.from({ length: 7 }, (_, i) => makeRow(i));
    expect(isHomogeneousObjectArray(arr)).toBe(false);
  });

  it("returns false when objects have different keys", () => {
    const arr = [
      { id: 1, name: "a" },
      { id: 2, extra: "x" },
      ...Array.from({ length: 8 }, (_, i) => ({ id: i + 3 })),
    ];
    expect(isHomogeneousObjectArray(arr)).toBe(false);
  });

  it("returns false for arrays of primitives", () => {
    expect(isHomogeneousObjectArray([1, 2, 3, 4, 5, 6, 7, 8])).toBe(false);
  });

  it("returns false for arrays containing nested arrays", () => {
    const arr = Array.from({ length: 10 }, (_, i) => [i]);
    expect(isHomogeneousObjectArray(arr)).toBe(false);
  });
});

// ─── encodeColumnar / decodeColumnar round-trip ───────────────────────────────

describe("columnar encode/decode round-trip (cols/v1)", () => {
  function makeMessages(count: number) {
    return Array.from({ length: count }, (_, i) => ({
      id: `msg_${i}`,
      from: `user${i % 5}@example.com`,
      body: `Hello from message ${i}`,
      timestamp: `2026-06-0${(i % 9) + 1}T00:00:00Z`,
      read: i % 2 === 0,
    }));
  }

  it("envelope has __gw_compact__ sentinel, keys list, and rows array", () => {
    const msgs = makeMessages(10);
    const env = encodeColumnar(msgs);
    expect(env.__gw_compact__).toBe("cols/v1");
    expect(Array.isArray(env.keys)).toBe(true);
    expect(Array.isArray(env.rows)).toBe(true);
    expect(env.keys).toEqual(expect.arrayContaining(["id", "from", "body", "timestamp", "read"]));
    expect(env.rows).toHaveLength(10);
  });

  it("decoded output deep-equals the original array (lossless round-trip)", () => {
    const msgs = makeMessages(20);
    const env = encodeColumnar(msgs);
    const decoded = decodeColumnar(env);
    // Sort keys of each object for stable comparison.
    const normalize = (arr: Record<string, unknown>[]) =>
      arr.map((obj) => Object.fromEntries(Object.entries(obj).sort()));
    expect(normalize(decoded)).toEqual(normalize(msgs));
  });

  it("columnar form is shorter than JSON.stringify of the original (typical case)", () => {
    const msgs = makeMessages(50);
    const original = JSON.stringify(msgs);
    const env = encodeColumnar(msgs);
    const columnar = JSON.stringify(env);
    expect(columnar.length).toBeLessThan(original.length);
  });
});

// ─── applyColumnarEncoding (recursive) ────────────────────────────────────────

describe("applyColumnarEncoding — recursive walk", () => {
  it("encodes a top-level homogeneous array", () => {
    const arr = Array.from({ length: 10 }, (_, i) => ({ id: i, v: i * 2 }));
    const result = applyColumnarEncoding(arr) as ColumnarEnvelope;
    expect(result.__gw_compact__).toBe("cols/v1");
  });

  it("encodes a nested homogeneous array inside an object", () => {
    const input = {
      meta: "top",
      items: Array.from({ length: 10 }, (_, i) => ({ id: i, val: i })),
    };
    const result = applyColumnarEncoding(input) as Record<string, unknown>;
    expect((result.items as ColumnarEnvelope).__gw_compact__).toBe("cols/v1");
    expect(result.meta).toBe("top");
  });

  it("leaves small arrays unchanged", () => {
    const arr = [{ id: 1 }, { id: 2 }];
    const result = applyColumnarEncoding(arr);
    expect(result).toEqual(arr);
  });

  it("leaves non-homogeneous arrays unchanged", () => {
    const arr = [{ id: 1 }, { id: 2, extra: "x" }, ...Array.from({ length: 8 }, (_, i) => ({ id: i + 3 }))];
    const result = applyColumnarEncoding(arr);
    expect(result).toEqual(arr);
  });
});

// ─── applyJsonCompression ─────────────────────────────────────────────────────

describe("applyJsonCompression", () => {
  function makeLargeHomogeneousJson(count = 100): string {
    const arr = Array.from({ length: count }, (_, i) => ({
      messageId: `msg-${i}`,
      sender: `user${i % 10}@corp.example.com`,
      recipientCount: (i % 5) + 1,
      bodyText: `This is the content of chat message number ${i}. It is moderately long.`,
      timestamp: `2026-06-01T${String(i % 24).padStart(2, "0")}:00:00.000Z`,
      threadId: `thread-${Math.floor(i / 10)}`,
      edited: false,
      deletedAt: null,
      reactions: [],
      mentions: [],
    }));
    return JSON.stringify(arr, null, 2);
  }

  it("returns compressed text shorter than original for large homogeneous JSON", () => {
    const original = makeLargeHomogeneousJson(100);
    const { compressed, savedPct } = applyJsonCompression(original);
    expect(compressed.length).toBeLessThan(original.length);
    // Expect meaningful savings: nulls/empty arrays pruned + columnar encoding
    // typically saves 30%+ on chat-message-style payloads.
    expect(savedPct).toBeGreaterThanOrEqual(30);
  });

  it("savedPct is rounded to an integer", () => {
    const original = makeLargeHomogeneousJson(50);
    const { savedPct } = applyJsonCompression(original);
    expect(Number.isInteger(savedPct)).toBe(true);
  });

  it("compressed output is valid JSON", () => {
    const original = makeLargeHomogeneousJson(50);
    const { compressed } = applyJsonCompression(original);
    expect(() => JSON.parse(compressed)).not.toThrow();
  });

  it("throws on non-JSON input (caller must guard)", () => {
    expect(() => applyJsonCompression("not json")).toThrow();
  });

  it("returns savedPct=0 and original text for tiny payload with no savings", () => {
    const original = JSON.stringify({ a: 1, b: 2 });
    const { compressed, savedPct } = applyJsonCompression(original);
    // Object with no nulls/empty fields and no arrays — no savings expected.
    expect(savedPct).toBe(0);
    expect(compressed).toBe(original);
  });
});

// ─── Gateway.compressToolText integration ─────────────────────────────────────
//
// We test the Gateway integration through a minimal harness that instantiates
// a real Gateway with a stub config and exposes compressToolText via a thin
// public test shim.  This avoids mocking internals while staying fast (no HTTP
// server, no backends).

import { Gateway } from "../../src/gateway.js";
import { createLogger } from "../../src/logger.js";
import type { Config } from "../../src/config.js";

/** Minimal valid Config with compression toggled as specified. */
function makeConfig(overrides: {
  enabled: boolean;
  mode?: "advisory" | "active";
  min_chars?: number;
}): Config {
  return {
    gateway: {
      port: 3100,
      host: "0.0.0.0",
      name: "test-gateway",
      log_level: "error",
      tool_prefix: "",
      tool_exposure: "mux",
      streamable_http_stateless: true,
      streamable_http_json_response: true,
    },
    fleet: {
      enabled: false,
      toolhive: {
        ingest_static_mcpu_config: false,
        additional_mcpu_configs: [],
        docker_ps: false,
        endpoint_probe: false,
        probe_timeout_ms: 750,
        auto_ingest: false,
        ingest_namespace_prefix: "",
        ingest_only: [],
        ingest_skip: [],
      },
    },
    backends: {},
    safety: { enforce: "advisory" },
    compression: {
      enabled: overrides.enabled,
      min_chars: overrides.min_chars ?? 20_000,
      mode: overrides.mode ?? "active",
    },
  };
}

/** Expose compressToolText for testing without modifying the class. */
class TestableGateway extends Gateway {
  public testCompress(text: string, kind: string) {
    // @ts-expect-error — accessing private method for test purposes
    return this.compressToolText(text, kind) as { text: string; marker?: Record<string, unknown> };
  }

  public testFetchArtifact(id: string) {
    // @ts-expect-error — accessing private method for test purposes
    return this.fetchArtifact({ artifactId: id }) as Record<string, unknown>;
  }
}

function makeLargeJson(count = 200): string {
  const arr = Array.from({ length: count }, (_, i) => ({
    id: `item-${i}`,
    sender: `u${i % 8}@example.com`,
    body: `Message body ${i} with some padding to push chars up`,
    ts: `2026-06-01T${String(i % 24).padStart(2, "0")}:00:00Z`,
    seen: true,
    deletedAt: null,
    reactions: [],
    extra: "",
  }));
  return JSON.stringify(arr, null, 2);
}

const silentLogger = createLogger("silent");

describe("Gateway.compressToolText — disabled by default", () => {
  it("returns text unchanged and no marker when compression.enabled=false", () => {
    const gw = new TestableGateway(makeConfig({ enabled: false }), "/fake/config.yaml", silentLogger);
    const text = makeLargeJson(200);
    const { text: out, marker } = gw.testCompress(text, "test");
    expect(out).toBe(text);
    expect(marker).toBeUndefined();
  });

  it("does not store an artifact when disabled", () => {
    const gw = new TestableGateway(makeConfig({ enabled: false }), "/fake/config.yaml", silentLogger);
    const text = makeLargeJson(200);
    gw.testCompress(text, "test");
    // The artifact store is empty — fetching a non-existent id returns an error object.
    const result = gw.testFetchArtifact("gw_artifact_nonexistent");
    expect((result as { error: string }).error).toBe("artifact_not_found");
  });
});

describe("Gateway.compressToolText — non-JSON passthrough", () => {
  it("returns non-JSON text unchanged even when enabled", () => {
    const gw = new TestableGateway(
      makeConfig({ enabled: true, min_chars: 100 }),
      "/fake/config.yaml",
      silentLogger
    );
    const text = "plain text that is definitely not json and is longer than min_chars threshold xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    const { text: out, marker } = gw.testCompress(text, "test");
    expect(out).toBe(text);
    expect(marker).toBeUndefined();
  });
});

describe("Gateway.compressToolText — below min_chars passthrough", () => {
  it("does not compress when text.length < min_chars", () => {
    const gw = new TestableGateway(
      makeConfig({ enabled: true, min_chars: 50_000 }),
      "/fake/config.yaml",
      silentLogger
    );
    const text = makeLargeJson(50); // ~several thousand chars, below 50k
    expect(text.length).toBeLessThan(50_000);
    const { text: out, marker } = gw.testCompress(text, "test");
    expect(out).toBe(text);
    expect(marker).toBeUndefined();
  });
});

describe("Gateway.compressToolText — active mode", () => {
  it("compressed text is meaningfully smaller (savedPct ≥ 30%)", () => {
    const gw = new TestableGateway(
      makeConfig({ enabled: true, mode: "active", min_chars: 1_000 }),
      "/fake/config.yaml",
      silentLogger
    );
    const original = makeLargeJson(200);
    const { text: compressed, marker } = gw.testCompress(original, "test");

    expect(marker).toBeDefined();
    expect(marker!.savedPct as number).toBeGreaterThanOrEqual(30);
    expect(compressed.length).toBeLessThan(original.length);
  });

  it("marker contains correct metadata fields", () => {
    const gw = new TestableGateway(
      makeConfig({ enabled: true, mode: "active", min_chars: 1_000 }),
      "/fake/config.yaml",
      silentLogger
    );
    const original = makeLargeJson(100);
    const { marker } = gw.testCompress(original, "my-kind");

    expect(marker).toBeDefined();
    expect(marker!.compressed).toBe(true);
    expect(typeof marker!.artifactId).toBe("string");
    expect((marker!.artifactId as string).startsWith("gw_artifact_")).toBe(true);
    expect(marker!.originalChars).toBe(original.length);
    expect(typeof marker!.compressedChars).toBe("number");
    expect(typeof marker!.savedPct).toBe("number");
  });

  it("full uncompressed original is retrievable from the artifact store", () => {
    const gw = new TestableGateway(
      makeConfig({ enabled: true, mode: "active", min_chars: 1_000 }),
      "/fake/config.yaml",
      silentLogger
    );
    const original = makeLargeJson(100);
    const { marker } = gw.testCompress(original, "test");
    const artifactId = marker!.artifactId as string;

    const artifact = gw.testFetchArtifact(artifactId);
    // The stored text is a page; retrieve from offset 0 with a large maxChars.
    // testFetchArtifact calls fetchArtifact({artifactId}) — default offset=0,
    // maxChars=DEFAULT_MUX_RESPONSE_CHAR_LIMIT (6000).
    // For large originals we need to check originalChars matches.
    expect((artifact as { originalChars: number }).originalChars).toBe(original.length);
    expect((artifact as { error?: string }).error).toBeUndefined();
  });

  it("compressed output is valid JSON and round-trips back to original shape", () => {
    // Use min_chars=100 so even a short array triggers compression; the key
    // assertion is that the cols/v1 envelope decodes back to the original objects.
    const gw = new TestableGateway(
      makeConfig({ enabled: true, mode: "active", min_chars: 100 }),
      "/fake/config.yaml",
      silentLogger
    );
    const items = Array.from({ length: 20 }, (_, i) => ({
      id: i,
      sender: `user${i}@example.com`,
      body: `message body ${i}`,
      ts: `2026-06-01T00:${String(i).padStart(2, "0")}:00Z`,
    }));
    const original = JSON.stringify(items, null, 2);
    // Sanity: make sure original is above our min_chars.
    expect(original.length).toBeGreaterThan(100);

    const { text: compressed, marker } = gw.testCompress(original, "test");
    expect(marker).toBeDefined();

    const parsed = JSON.parse(compressed) as ColumnarEnvelope;
    expect(parsed.__gw_compact__).toBe("cols/v1");

    // Decode and verify round-trip.
    const decoded = decodeColumnar(parsed);
    expect(decoded).toHaveLength(items.length);
    for (let i = 0; i < items.length; i++) {
      expect(decoded[i].id).toBe(items[i].id);
      expect(decoded[i].sender).toBe(items[i].sender);
      expect(decoded[i].body).toBe(items[i].body);
    }
  });
});

describe("Gateway.compressToolText — advisory mode", () => {
  it("returns original text unchanged in advisory mode", () => {
    const gw = new TestableGateway(
      makeConfig({ enabled: true, mode: "advisory", min_chars: 1_000 }),
      "/fake/config.yaml",
      silentLogger
    );
    const original = makeLargeJson(200);
    const { text: out, marker } = gw.testCompress(original, "test");

    // Text must be unchanged in advisory mode.
    expect(out).toBe(original);
    // Marker is still present so the model can inspect potential savings.
    expect(marker).toBeDefined();
    expect(marker!.savedPct as number).toBeGreaterThan(0);
  });

  it("artifact is stored even in advisory mode (for opt-in retrieval)", () => {
    const gw = new TestableGateway(
      makeConfig({ enabled: true, mode: "advisory", min_chars: 1_000 }),
      "/fake/config.yaml",
      silentLogger
    );
    const original = makeLargeJson(100);
    const { marker } = gw.testCompress(original, "test");

    const artifactId = marker!.artifactId as string;
    const artifact = gw.testFetchArtifact(artifactId);
    expect((artifact as { error?: string }).error).toBeUndefined();
    expect((artifact as { originalChars: number }).originalChars).toBe(original.length);
  });
});
