/**
 * Phase 2: deterministic token-set ranking + safety metadata in gateway_search_tools.
 *
 * Tests are structured around a minimal Gateway instance with a manually-wired
 * ToolRegistry (via the private internals) and a hand-crafted set of ToolEntry
 * objects to keep the tests self-contained and fast.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Gateway } from "../../src/gateway.js";
import { createLogger } from "../../src/logger.js";
import type { Config } from "../../src/config.js";
import type { ToolEntry } from "../../src/tool-registry.js";
import type { SafetyClassification } from "../../src/manifest.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const minimalConfig: Config = {
  gateway: {
    port: 3100,
    host: "127.0.0.1",
    name: "mcp-gateway-test",
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
  safety: {
    enforce: "advisory",
  },
  compression: {
    enabled: false,
    min_chars: 20_000,
    mode: "active",
  },
};

function newGateway(): Gateway {
  return new Gateway(minimalConfig, "<test-config>", createLogger("error"));
}

function makeSafety(overrides: Partial<SafetyClassification> = {}): SafetyClassification {
  return {
    safetyClass: "READ",
    tags: [],
    confirmationMapsToDownstream: false,
    source: "manifest",
    ...overrides,
  };
}

/**
 * Register fake tool entries directly into the gateway's private toolRegistry
 * and backends map. This bypasses the network/backend machinery so tests run
 * in-process without external connections.
 */
function wireEntries(gw: any, entries: ToolEntry[]): void {
  // Populate the private toolRegistry tools map directly.
  const registryTools: Map<string, ToolEntry> = (gw.toolRegistry as any).tools;
  registryTools.clear();
  for (const e of entries) {
    registryTools.set(e.namespacedName, e);
  }
}

function makeEntry(opts: {
  namespacedName: string;
  originalName: string;
  backendName: string;
  description: string;
  safety?: SafetyClassification;
}): ToolEntry {
  return {
    namespacedName: opts.namespacedName,
    originalName: opts.originalName,
    backendName: opts.backendName,
    tool: {
      name: opts.namespacedName,
      description: opts.description,
      inputSchema: { type: "object", properties: {} },
    },
    safety: opts.safety,
  };
}

/** Call the private searchRegisteredTools method. */
async function search(gw: any, args: Record<string, unknown>): Promise<any> {
  return (gw as any).searchRegisteredTools(args);
}

// ─── query-required guard ─────────────────────────────────────────────────────

describe("searchRegisteredTools — query-required guard", () => {
  it("returns queryRequired:true when both query and backend are blank", async () => {
    const gw = newGateway();
    const result = await search(gw, {});
    expect(result.queryRequired).toBe(true);
    expect(result.returned).toBe(0);
    expect(result.matches).toHaveLength(0);
  });

  it("returns queryRequired:true when both are empty strings", async () => {
    const gw = newGateway();
    const result = await search(gw, { query: "", backend: "" });
    expect(result.queryRequired).toBe(true);
  });

  it("returns queryRequired:true when both are whitespace-only", async () => {
    const gw = newGateway();
    const result = await search(gw, { query: "   ", backend: "  " });
    expect(result.queryRequired).toBe(true);
  });
});

// ─── token-set ranking: query relevance order ─────────────────────────────────

describe("searchRegisteredTools — token-set ranking: send > get", () => {
  let gw: any;

  const sendEntry = makeEntry({
    namespacedName: "az_teams_send_message",
    originalName: "send_message",
    backendName: "az-teams",
    description: "Send a Teams message to a channel or user.",
    safety: makeSafety({
      safetyClass: "HUMAN_OUTBOUND",
      tags: ["teams", "send", "outbound", "message"],
      confirmationMapsToDownstream: false,
      source: "manifest",
    }),
  });

  const getEntry = makeEntry({
    namespacedName: "az_teams_get_chat_messages",
    originalName: "get_chat_messages",
    backendName: "az-teams",
    description: "Retrieve chat messages from a Teams channel.",
    safety: makeSafety({
      safetyClass: "READ",
      tags: ["teams", "chat", "read"],
    }),
  });

  beforeEach(() => {
    gw = newGateway();
    wireEntries(gw, [getEntry, sendEntry]); // wire get first to prove sort is not insertion order
  });

  it("ranks az_teams_send_message above az_teams_get_chat_messages for 'send a teams message'", async () => {
    const result = await search(gw, { query: "send a teams message" });
    expect(result.returned).toBeGreaterThan(0);
    expect(result.matches[0].name).toBe("az_teams_send_message");
  });

  it("send tool scores higher than get tool for 'send a teams message'", async () => {
    const result = await search(gw, { query: "send a teams message" });
    const sendMatch = result.matches.find((m: any) => m.name === "az_teams_send_message");
    const getMatch = result.matches.find((m: any) => m.name === "az_teams_get_chat_messages");
    expect(sendMatch).toBeDefined();
    expect(getMatch).toBeDefined();
    expect(sendMatch.score).toBeGreaterThan(getMatch.score);
  });

  it("each match carries safetyClass, tags, and score fields", async () => {
    const result = await search(gw, { query: "send a teams message" });
    for (const match of result.matches) {
      expect(match).toHaveProperty("safetyClass");
      expect(match).toHaveProperty("tags");
      expect(Array.isArray(match.tags)).toBe(true);
      expect(match).toHaveProperty("score");
      expect(typeof match.score).toBe("number");
    }
  });

  it("safetyClass reflects the entry's safety classification", async () => {
    const result = await search(gw, { query: "send a teams message" });
    const sendMatch = result.matches.find((m: any) => m.name === "az_teams_send_message");
    expect(sendMatch.safetyClass).toBe("HUMAN_OUTBOUND");
    const getMatch = result.matches.find((m: any) => m.name === "az_teams_get_chat_messages");
    expect(getMatch.safetyClass).toBe("READ");
  });

  it("tags are surfaced from safety metadata", async () => {
    const result = await search(gw, { query: "send a teams message" });
    const sendMatch = result.matches.find((m: any) => m.name === "az_teams_send_message");
    expect(sendMatch.tags).toContain("outbound");
    expect(sendMatch.tags).toContain("send");
  });
});

// ─── exact-match pin ──────────────────────────────────────────────────────────

describe("searchRegisteredTools — exact-match pin", () => {
  let gw: any;

  const targetEntry = makeEntry({
    namespacedName: "az_teams_send_message",
    originalName: "send_message",
    backendName: "az-teams",
    description: "Send a Teams message.",
    safety: makeSafety({ safetyClass: "HUMAN_OUTBOUND", tags: ["send"] }),
  });

  const highScoreEntry = makeEntry({
    namespacedName: "az_teams_az_teams_send_message_helper",
    originalName: "az_teams_send_message_helper",
    backendName: "az-teams",
    description: "az_teams_send_message helper utility with many matching tokens",
    safety: makeSafety({ tags: ["az", "teams", "send", "message"] }),
  });

  beforeEach(() => {
    gw = newGateway();
    wireEntries(gw, [highScoreEntry, targetEntry]);
  });

  it("pins the exact-match tool to rank 0 regardless of other scores", async () => {
    const result = await search(gw, { query: "az_teams_send_message" });
    expect(result.matches[0].name).toBe("az_teams_send_message");
  });

  it("exact-match query: the pinned tool appears first even if another entry has more token overlap", async () => {
    // highScoreEntry's description contains the full query string as tokens,
    // so without the pin bonus it would outscore targetEntry. The pin must win.
    const result = await search(gw, { query: "az_teams_send_message" });
    const pinned = result.matches[0];
    expect(pinned.name).toBe("az_teams_send_message");
  });
});

// ─── backend-only listing (empty query + backendFilter) ───────────────────────

describe("searchRegisteredTools — backend-only listing", () => {
  let gw: any;

  const entriesAzTeams = [
    makeEntry({
      namespacedName: "az_teams_send_message",
      originalName: "send_message",
      backendName: "az-teams",
      description: "Send a Teams message.",
    }),
    makeEntry({
      namespacedName: "az_teams_get_chats",
      originalName: "get_chats",
      backendName: "az-teams",
      description: "List Teams chats.",
    }),
  ];

  const entryOther = makeEntry({
    namespacedName: "other_svc_do_thing",
    originalName: "do_thing",
    backendName: "other-svc",
    description: "Something unrelated.",
  });

  beforeEach(() => {
    gw = newGateway();
    wireEntries(gw, [...entriesAzTeams, entryOther]);
  });

  it("returns only az-teams tools when backend='az-teams' and query is empty", async () => {
    const result = await search(gw, { query: "", backend: "az-teams" });
    expect(result.queryRequired).toBeUndefined();
    expect(result.returned).toBe(2);
    const names = result.matches.map((m: any) => m.name);
    expect(names).toContain("az_teams_send_message");
    expect(names).toContain("az_teams_get_chats");
    expect(names).not.toContain("other_svc_do_thing");
  });

  it("backend-only results have score 0", async () => {
    const result = await search(gw, { query: "", backend: "az-teams" });
    for (const m of result.matches) {
      expect(m.score).toBe(0);
    }
  });
});

// ─── deterministic tie-break (alphabetical) ───────────────────────────────────

describe("searchRegisteredTools — deterministic tie-break on equal score", () => {
  let gw: any;

  // Three entries that all match "teams" with a score of 1.
  const entries = [
    makeEntry({
      namespacedName: "az_teams_zebra",
      originalName: "zebra",
      backendName: "az-teams",
      description: "Teams zebra.",
    }),
    makeEntry({
      namespacedName: "az_teams_alpha",
      originalName: "alpha",
      backendName: "az-teams",
      description: "Teams alpha.",
    }),
    makeEntry({
      namespacedName: "az_teams_middle",
      originalName: "middle",
      backendName: "az-teams",
      description: "Teams middle.",
    }),
  ];

  beforeEach(() => {
    gw = newGateway();
    // Wire in reverse-alphabetical insertion order to prove sort is not insertion order.
    wireEntries(gw, [entries[0], entries[2], entries[1]]);
  });

  it("returns results in alphabetical order when all have identical score", async () => {
    const result = await search(gw, { query: "teams" });
    const names = result.matches.map((m: any) => m.name);
    // All have score 1; alphabetical tie-break: alpha, middle, zebra.
    expect(names).toEqual(["az_teams_alpha", "az_teams_middle", "az_teams_zebra"]);
  });
});

// ─── zero-score entries excluded when query has tokens ────────────────────────

describe("searchRegisteredTools — zero-score entries excluded by query", () => {
  let gw: any;

  beforeEach(() => {
    gw = newGateway();
    wireEntries(gw, [
      makeEntry({
        namespacedName: "az_teams_send_message",
        originalName: "send_message",
        backendName: "az-teams",
        description: "Send a Teams message.",
      }),
      makeEntry({
        namespacedName: "snow_get_incident",
        originalName: "get_incident",
        backendName: "servicenow",
        description: "Get a ServiceNow incident.",
      }),
    ]);
  });

  it("returns only the teams tool when searching 'send teams'", async () => {
    const result = await search(gw, { query: "send teams" });
    const names = result.matches.map((m: any) => m.name);
    expect(names).toContain("az_teams_send_message");
    expect(names).not.toContain("snow_get_incident");
  });

  it("returns only the snow tool when searching 'servicenow incident'", async () => {
    const result = await search(gw, { query: "servicenow incident" });
    const names = result.matches.map((m: any) => m.name);
    expect(names).toContain("snow_get_incident");
    expect(names).not.toContain("az_teams_send_message");
  });
});

// ─── safety metadata on entries with no safety classification ─────────────────

describe("searchRegisteredTools — null safety on unclassified entries", () => {
  let gw: any;

  beforeEach(() => {
    gw = newGateway();
    wireEntries(gw, [
      makeEntry({
        namespacedName: "unclassified_do_thing",
        originalName: "do_thing",
        backendName: "unclassified",
        description: "Does a thing.",
        // no safety field
      }),
    ]);
  });

  it("safetyClass is null and tags is [] when no safety classification present", async () => {
    const result = await search(gw, { query: "thing" });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].safetyClass).toBeNull();
    expect(result.matches[0].tags).toEqual([]);
  });
});

// ─── omittedByLimit accounting ────────────────────────────────────────────────

describe("searchRegisteredTools — omittedByLimit accounting", () => {
  let gw: any;

  beforeEach(() => {
    gw = newGateway();
    const entries: ToolEntry[] = [];
    for (let i = 0; i < 15; i++) {
      entries.push(
        makeEntry({
          namespacedName: `az_teams_tool_${String(i).padStart(2, "0")}`,
          originalName: `tool_${i}`,
          backendName: "az-teams",
          description: "A teams tool.",
        })
      );
    }
    wireEntries(gw, entries);
  });

  it("omittedByLimit = ranked - returned when limit is less than total matches", async () => {
    const result = await search(gw, { query: "teams", limit: 5 });
    expect(result.returned).toBe(5);
    // All 15 match "teams"; 15 - 5 = 10 omitted.
    expect(result.omittedByLimit).toBe(10);
  });

  it("omittedByLimit is 0 when all matches fit within limit", async () => {
    const result = await search(gw, { query: "teams", limit: 50 });
    expect(result.omittedByLimit).toBe(0);
  });
});

// ─── describeWith shape preserved ─────────────────────────────────────────────

describe("searchRegisteredTools — describeWith shape", () => {
  let gw: any;

  beforeEach(() => {
    gw = newGateway();
    wireEntries(gw, [
      makeEntry({
        namespacedName: "az_teams_send_message",
        originalName: "send_message",
        backendName: "az-teams",
        description: "Send a Teams message.",
      }),
    ]);
  });

  it("each match carries a describeWith with the correct tool name and namespaced argument", async () => {
    const result = await search(gw, { query: "teams" });
    const match = result.matches[0];
    expect(match.describeWith).toBeDefined();
    expect(match.describeWith.tool).toBe("gateway_describe_tool");
    expect(match.describeWith.arguments.tool).toBe("az_teams_send_message");
  });
});

// ─── safety tags contribute to ranking ───────────────────────────────────────

describe("searchRegisteredTools — safety tags contribute to score", () => {
  let gw: any;

  const withTagEntry = makeEntry({
    namespacedName: "az_teams_send_message",
    originalName: "send_message",
    backendName: "az-teams",
    description: "Post a message.", // no 'outbound' in description
    safety: makeSafety({
      safetyClass: "HUMAN_OUTBOUND",
      tags: ["outbound", "teams"],
    }),
  });

  const withoutTagEntry = makeEntry({
    namespacedName: "az_teams_other_tool",
    originalName: "other_tool",
    backendName: "az-teams",
    description: "Reads chat history for a Teams channel.",
  });

  beforeEach(() => {
    gw = newGateway();
    wireEntries(gw, [withoutTagEntry, withTagEntry]);
  });

  it("tool with 'outbound' safety tag scores higher when querying 'outbound'", async () => {
    const result = await search(gw, { query: "outbound teams" });
    const taggedMatch = result.matches.find((m: any) => m.name === "az_teams_send_message");
    const untaggedMatch = result.matches.find((m: any) => m.name === "az_teams_other_tool");
    expect(taggedMatch).toBeDefined();
    // untaggedMatch has no 'outbound' token — it may or may not appear depending on 'teams' scoring
    if (untaggedMatch) {
      expect(taggedMatch.score).toBeGreaterThan(untaggedMatch.score);
    }
    expect(result.matches[0].name).toBe("az_teams_send_message");
  });
});
