import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Server as HttpServer } from "node:http";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  isInitializeRequest,
  ElicitResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import type { Tool, ClientCapabilities, Implementation } from "@modelcontextprotocol/sdk/types.js";
import type { BackendConfig, Config } from "./config.js";
import type { Logger } from "./logger.js";
import { ToolRegistry, type ToolEntry } from "./tool-registry.js";
import { ManifestRegistry, decideGate, refineForArgs, type SafetyClassification, type SafetyClass } from "./manifest.js";
import { Metrics, COUNTERS } from "./metrics.js";
import { BackendInstance } from "./backend.js";
import {
  ApprovalStore,
  isTierBClass,
  allowsStandingGrant,
  summarizeArgs,
  describeApproval,
  resolveThesunHome,
  type PendingApproval,
  type StandingGrant,
  composeGrantIdentity,
} from "./approvals.js";
import { writePolicySnapshot, type PolicySnapshotInput } from "./policy-snapshot.js";
import { registerDepScanRoute } from "./dep-scan/index.js";
import { notifyPark } from "./notify.js";
import { ConfirmTokenIssuer, canonicalArgsHash } from "./nonce.js";
import { watch, type FSWatcher } from "chokidar";
import { loadConfig } from "./config.js";
import { buildToolHiveFleetInventory, type FleetEntry } from "./fleet-inventory.js";
import { buildFleetMcpuConfig } from "./fleet-mcpu-config.js";
import { loadFleetBackendsFromMcpuConfig, type FleetIngestResult, type QuarantineRecord } from "./fleet-backend-ingestion.js";
import { getMuxTools, isMuxToolName, MUX_TOOL_NAMES, type MuxToolName, extractCallToolArgs, rankCandidates, type SearchCandidate } from "./mux-tools.js";
import { ToolSemanticIndex, createDefaultEmbedder } from "./tool-embeddings.js";
import { createEntraAuthMiddleware, type AuthedRequest, type Identity } from "./auth.js";
import {
  applyResultRedaction,
  checkHumanOutboundArgs,
  checkSqlDestructiveArgs,
  type ContentGuardConfig,
} from "./content-guard.js";

// ── Phase 4: Content-aware compression helpers (zero-dependency, native TS) ────
//
// Exported so unit tests can exercise the pure transform without a full Gateway
// instance. The Gateway.compressToolText() private method is the integration
// point; it calls these helpers and wraps them with the artifact store.

/**
 * cols/v1 columnar envelope format.
 *
 * A homogeneous object-array is encoded as:
 *   { "__gw_compact__": "cols/v1", "keys": [k0,k1,...], "rows": [[v0,v1,...], ...] }
 *
 * This eliminates repeated key strings — the dominant redundancy in large
 * arrays of chat messages, Jira issues, calendar events, etc. where N objects
 * share the same M keys. For N=200 objects with M=10 keys, key strings appear
 * once instead of 200 times.
 *
 * Round-trip guarantee: decodeColumnar(encodeColumnar(arr)) deep-equals arr.
 */
export interface ColumnarEnvelope {
  __gw_compact__: "cols/v1";
  keys: string[];
  rows: unknown[][];
}

/** Minimum array length to attempt columnar encoding (not worth it below this). */
const COLUMNAR_MIN_ROWS = 8;

/**
 * Return true if every element of arr is a non-null plain object and all
 * objects share exactly the same set of own-enumerable keys.
 */
export function isHomogeneousObjectArray(arr: unknown[]): arr is Record<string, unknown>[] {
  if (arr.length < COLUMNAR_MIN_ROWS) return false;
  const first = arr[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) return false;
  const keys = Object.keys(first as object).sort();
  if (keys.length === 0) return false;
  const keySet = keys.join("\0");
  for (let i = 1; i < arr.length; i++) {
    const el = arr[i];
    if (!el || typeof el !== "object" || Array.isArray(el)) return false;
    if (Object.keys(el as object).sort().join("\0") !== keySet) return false;
  }
  return true;
}

/**
 * Encode a homogeneous object-array into a cols/v1 envelope.
 * Caller MUST verify isHomogeneousObjectArray before calling.
 */
export function encodeColumnar(arr: Record<string, unknown>[]): ColumnarEnvelope {
  const keys = Object.keys(arr[0]).sort();
  const rows = arr.map((obj) => keys.map((k) => obj[k]));
  return { __gw_compact__: "cols/v1", keys, rows };
}

/**
 * Decode a cols/v1 envelope back to a plain object-array.
 * Used in tests to verify lossless round-trip.
 */
export function decodeColumnar(env: ColumnarEnvelope): Record<string, unknown>[] {
  return env.rows.map((row) => {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < env.keys.length; i++) {
      obj[env.keys[i]] = row[i];
    }
    return obj;
  });
}

/**
 * Recursively prune null / undefined / empty-string / empty-array /
 * empty-object fields from a value.  These are low-information tokens that
 * inflate serialised size without adding meaning.
 *
 * Arrays of primitives are pruned only of null/undefined elements.
 * Objects lose keys whose pruned value is null/undefined/""/{}/[].
 */
export function pruneEmpty(value: unknown): unknown {
  if (value === null || value === undefined || value === "") return undefined;

  if (Array.isArray(value)) {
    const pruned = value
      .map(pruneEmpty)
      .filter((v) => v !== undefined);
    return pruned.length === 0 ? undefined : pruned;
  }

  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const pv = pruneEmpty(v);
      if (pv !== undefined) result[k] = pv;
    }
    return Object.keys(result).length === 0 ? undefined : result;
  }

  return value;
}

/**
 * Recursively apply columnar encoding to any homogeneous object-array found
 * in the value tree.  Leaves non-homogeneous arrays and scalars unchanged.
 */
export function applyColumnarEncoding(value: unknown): unknown {
  if (Array.isArray(value)) {
    if (isHomogeneousObjectArray(value)) {
      return encodeColumnar(value as Record<string, unknown>[]);
    }
    return value.map(applyColumnarEncoding);
  }
  if (value && typeof value === "object" && !(value as Record<string, unknown>).__gw_compact__) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = applyColumnarEncoding(v);
    }
    return result;
  }
  return value;
}

/**
 * Apply the full compression pipeline to a JSON-parseable text string:
 *   1. Prune null/empty fields
 *   2. Columnar-encode homogeneous object-arrays
 *   3. Minify (JSON.stringify without indentation)
 *
 * Returns the compressed string, or the original if the pipeline produces no
 * meaningful reduction (savedPct ≤ 0).
 *
 * Throws if `text` is not valid JSON — callers must guard.
 */
export function applyJsonCompression(text: string): { compressed: string; savedPct: number } {
  const parsed = JSON.parse(text) as unknown;
  const pruned = pruneEmpty(parsed) ?? parsed; // if pruneEmpty returns undefined (e.g. empty root), keep original
  const columnar = applyColumnarEncoding(pruned);
  const compressed = JSON.stringify(columnar);
  const savedPct = Math.round(100 * (1 - compressed.length / text.length));
  if (savedPct <= 0) {
    return { compressed: text, savedPct: 0 };
  }
  return { compressed, savedPct };
}

// ── End Phase 4 compression helpers ────────────────────────────────────────────

/**
 * CTX-2 per-backend tool visibility filter (mirrors ToolHive toolsFilter).
 * Filters a backend's tool list by ORIGINAL tool name before it is registered/
 * exposed. Precedence: deny beats allow. When `allow` is non-empty ONLY those
 * tools survive; `deny` always removes. Both empty/undefined = expose all.
 * Pure and exported for unit testing.
 */
export function applyToolVisibility(
  tools: Tool[],
  allow?: string[],
  deny?: string[]
): Tool[] {
  const denySet = new Set(deny ?? []);
  const hasAllow = Array.isArray(allow) && allow.length > 0;
  const allowSet = hasAllow ? new Set(allow) : null;
  return tools.filter((t) => {
    if (denySet.has(t.name)) return false; // deny beats allow
    if (allowSet) return allowSet.has(t.name); // allow non-empty: only these
    return true; // no allow filter: expose all (minus deny)
  });
}

const DEFAULT_MUX_RESPONSE_CHAR_LIMIT = 6_000;
const STATUS_RESPONSE_CHAR_LIMIT = 4_000;
const DESCRIBE_RESPONSE_CHAR_LIMIT = 12_000;
const MAX_MUX_RESPONSE_CHAR_LIMIT = 2_000_000;
const DEFAULT_MUX_LIST_LIMIT = 10;
const MAX_MUX_LIST_LIMIT = 50;
const MAX_ARTIFACTS = 100;
const MAX_ARTIFACT_CHARS = 2_000_000;

/**
 * Retry backoff bounds (STAB-8). The exponent is capped so the delay series is
 * finite (with the default 5s reconnect_interval: 5s, 10s, 20s ... 320s), and
 * the ceiling is an absolute cap for installs configured with a large
 * reconnect_interval. 15 minutes keeps a recovered backend discoverable within
 * a reasonable window without hammering a dead one.
 */
const BACKOFF_MAX_EXPONENT = 6;
const BACKOFF_CEILING_MS = 15 * 60 * 1000;

/**
 * How often to re-read the fleet inventory (STAB-9). Deliberately its OWN timer
 * rather than a branch in the 30 second health callback: an inventory read
 * shells out to docker and can be slow, and it must never delay reconnects.
 * 3 minutes is frequent enough to adopt a newly started server promptly and
 * infrequent enough that the steady state costs almost nothing (the ingest
 * reports "no backend changes" and returns).
 */
const FLEET_REFRESH_INTERVAL_MS = 3 * 60 * 1000;

/**
 * Consecutive inventory reads a fleet backend must be absent from before it is
 * pruned (STAB-10). Two, so a container restarting between reads survives.
 */
const PRUNE_ABSENCE_THRESHOLD = 2;
const STREAMABLE_SESSION_IDLE_TTL_MS = 60 * 60 * 1000;

interface GatewayArtifact {
  id: string;
  kind: string;
  text: string;
  originalChars: number;
  storedAt: string;
}

/**
 * Client-declared capabilities + clientInfo captured per session at
 * initialize (Phase 3, SECURITY-ROADMAP §2.2). Used by the Tier-B
 * elicitation upgrade to decide whether the session's client can present an
 * in-editor approval dialog, and by the clientInfo.name blocklist.
 */
interface SessionClientMeta {
  capabilities?: ClientCapabilities;
  clientInfo?: Implementation;
}

/**
 * Per-dispatch handle on the session that issued the tool call — threaded
 * from the CallToolRequest handler closure into dispatchToolCall/dispatchTierB
 * so the Tier-B elicitation branch can (a) read the client's declared
 * capabilities/clientInfo and (b) send an `elicitation/create` request
 * correlated to the STILL-OPEN in-flight call (extra.sendRequest attaches
 * relatedRequestId, so the dialog rides the same stream as the call).
 */
interface DispatchSessionContext {
  /** Transport session id, when the transport is stateful (undefined in stateless mode). */
  sessionId?: string;
  /** The per-session McpServer — source of getClientCapabilities()/getClientVersion(). */
  server: McpServer;
  /** RequestHandlerExtra.sendRequest — sends a server→client request related to the in-flight call. */
  sendRequest: (request: unknown, resultSchema: unknown, options?: { timeout?: number }) => Promise<unknown>;
}

/**
 * A host binds only this machine's loopback interface (unreachable off-box).
 * These three literals are the only forms the gateway ever configures; a
 * non-loopback value (0.0.0.0, a LAN IP, a hostname) is reachable from the
 * network.
 */
export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

export interface BindGuardDecision {
  /** true = safe to bind; false = the gateway must refuse to start. */
  allowed: boolean;
  /**
   * true only when a non-loopback + no-auth bind is being permitted SOLELY
   * because the allow_insecure_non_loopback escape hatch is set. The caller
   * must still log a loud warning in this case.
   */
  insecureOverride: boolean;
  /** Remediation text (on refusal) or warning text (on override). */
  reason?: string;
}

/**
 * SEC-5 fail-closed bind guard. A non-loopback bind with NO tool-plane auth
 * (auth.mode "none" and no shared_secret) exposes an unauthenticated tool-
 * plane on the network — the only default boundary would be gone. This pure,
 * side-effect-free function decides whether start() may bind; keeping it pure
 * lets start() call it before binding and lets unit tests exercise every
 * branch without opening a socket.
 *
 * Auth counts as enabled under exactly the two conditions that mount tool-
 * plane middleware in start(): auth.mode === "entra" OR a truthy shared_secret.
 */
export function evaluateBindGuard(params: {
  host: string;
  authMode: "none" | "entra";
  sharedSecret?: string;
  allowInsecureNonLoopback?: boolean;
}): BindGuardDecision {
  if (isLoopbackHost(params.host)) {
    return { allowed: true, insecureOverride: false };
  }

  const authEnabled =
    params.authMode === "entra" || Boolean(params.sharedSecret);
  if (authEnabled) {
    return { allowed: true, insecureOverride: false };
  }

  if (params.allowInsecureNonLoopback) {
    return {
      allowed: true,
      insecureOverride: true,
      reason: `gateway.host="${params.host}" is NOT loopback and auth.mode is "none" with no shared_secret; binding an UNAUTHENTICATED tool-plane on the network because gateway.allow_insecure_non_loopback=true. This is your explicit opt-out of the SEC-5 safety check.`,
    };
  }

  return {
    allowed: false,
    insecureOverride: false,
    reason: `Refusing to start: gateway.host="${params.host}" is NOT loopback (127.0.0.1 / ::1 / localhost) and no tool-plane auth is configured (auth.mode="none", no shared_secret). Binding here would expose an UNAUTHENTICATED tool-plane on the network. Remediation: set auth.mode="entra" (with tenant_id + audience) or set auth.shared_secret, OR bind a loopback host, OR (only if the interface is secured by other means) set gateway.allow_insecure_non_loopback=true.`,
  };
}

export class Gateway {
  private config: Config;
  private configPath: string;
  private logger: Logger;
  private app = express();
  private manifests: ManifestRegistry;
  private toolRegistry: ToolRegistry;
  // Lazy semantic-search index for gateway_search_tools (CTX-1). Built on first
  // search when gateway.search_semantic is enabled and the optional embedding
  // model loads; a one-shot failure flag prevents retrying a broken embedder on
  // every call. Invalidated when the tool registry changes (tracked by version).
  private semanticIndex: ToolSemanticIndex | null = null;
  private semanticInitTried = false;
  private semanticIndexVersion = -1;
  private backends = new Map<string, BackendInstance>();
  private streamableTransports = new Map<string, StreamableHTTPServerTransport>();
  // Wall-clock at gateway construction; drives the /healthz uptime field.
  private readonly bootTimeMs = Date.now();
  // GW-1: in-process counters exposed at GET /metrics (Prometheus text).
  private readonly metrics = new Metrics();
  private sessions = new Map<string, McpServer>();
  private streamableSessionLastSeen = new Map<string, number>();
  // Session-owner binding (N2): sessionId → oid of the identity that created
  // the session (null when auth.mode = none). With auth on, a request bearing
  // a foreign sessionId is rejected 403 — knowing a UUID is not authorization.
  private sessionOwners = new Map<string, string | null>();
  // Phase 3 (SECURITY-ROADMAP §2.2): sessionId → client capabilities +
  // clientInfo, captured post-initialize (Server.oninitialized). Consulted by
  // the Tier-B elicitation branch; absence of an entry (or of the elicitation
  // capability) means the session parks exactly as before Phase 3.
  private sessionMeta = new Map<string, SessionClientMeta>();
  private artifacts = new Map<string, GatewayArtifact>();
  // Deduplicates concurrent reconnects of the same backend so N parallel
  // stale-session errors trigger one reconnect, not N. Keyed by backend name;
  // entry is the in-flight reconnect promise, deleted in its finally block.
  private reconnectInflight = new Map<string, Promise<number>>();

  private healthTimer?: ReturnType<typeof setInterval>;
  private httpServer?: HttpServer;
  private configWatcher?: FSWatcher;
  /**
   * Any in-flight mutation of the backend set: a config reload OR a periodic
   * fleet re-ingest (STAB-9).
   *
   * ONE guard for both, deliberately. A second, independent guard would let a
   * reload and a re-ingest interleave, and both rewrite `this.backends`, so
   * they would race on exactly the state the gateway routes on. Reload keeps
   * its original dedup semantics (a concurrent reload awaits the in-flight
   * one); the periodic tick instead SKIPS when this is set, because a queued
   * re-ingest running immediately after a reload is duplicated work against a
   * set that was just refreshed.
   */
  private mutationInFlight?: Promise<void>;
  private fleetRefreshTimer?: ReturnType<typeof setInterval>;
  /** Consecutive inventory reads each fleet backend has been absent from (STAB-10). */
  private backendAbsenceCounts = new Map<string, number>();
  private fleetIngestInFlight?: Promise<FleetIngestResult>;
  // Quarantined fleet entries from the most recent ingest (Deliverable 16) —
  // surfaced via gateway_backend_status so unsafe/unroutable backends stay visible.
  private fleetQuarantined: QuarantineRecord[] = [];
  // Decision-log bookkeeping: create the parent dir once, log a write error once.
  private decisionLogDirReady = false;
  private decisionLogErrorLogged = false;
  // OPS-4: cached byte size of the active decision-log file so the per-dispatch
  // rotation check does not statSync on every tool call (that syscall on the hot
  // path blocked the event loop under load). null means "unknown, re-stat on next
  // write"; the counter self-heals via a periodic re-stat every N writes.
  private decisionLogSizeBytes: number | null = null;
  private decisionLogWritesSinceStat = 0;
  private static readonly DECISION_LOG_RESTAT_EVERY = 100;
  // SC-4 Tier-B out-of-band approval store (approvals.ts) — file-backed,
  // survives gateway restarts. See dispatchTierB() / setupApprovalRoutes().
  private approvalStore: ApprovalStore;
  // Phase 2 (fixes G5): in-memory redacted arg previews for pending Tier-B
  // approvals, keyed by approval id. RAM ONLY, deliberately NOT part of the
  // ApprovalStore — approvals.json on disk stays value-free (type tags only);
  // this map holds content-guard-REDACTED actual values so the human approves
  // informed instead of blind. Populated at park time, shown on the /approve
  // page + CLI listing, evicted on approval and pruned against expiry. Lost
  // on gateway restart by design (the disk record is the source of truth).
  private readonly approvalArgPreviews = new Map<string, string>();
  // Phase 4 Tier-A confirm token issuer (nonce.ts) — per-boot random HMAC key,
  // stateless. AUDIT INTEGRITY ONLY, explicitly not an adversarial control:
  // an autonomous model echoes the token from the block response. It exists
  // so the decision log is truthful (no blind first-call self-confirm, no
  // confirm-then-swap), not to stop a full-auto agent.
  private confirmTokens = new ConfirmTokenIssuer();

  constructor(config: Config, configPath: string, logger: Logger) {
    this.config = config;
    this.configPath = configPath;
    this.logger = logger;
    this.manifests = new ManifestRegistry(logger, config.safety?.manifest_dir, {
      unmanifestedReadAllowlist: config.safety?.unmanifested_read_allowlist,
      escalation: config.safety?.escalation,
    });
    this.toolRegistry = new ToolRegistry(
      logger,
      config.gateway.tool_prefix,
      this.manifests.classify.bind(this.manifests),
      // CTX-3: operator tool rename/description overrides (config default {}).
      config.gateway.tool_overrides
    );
    this.approvalStore = new ApprovalStore(config.approvals?.dir);

    this.setupHttpRoutes();
    this.setupApprovalRoutes();
  }

  /**
   * Create the per-session MCP server. The identity that authenticated the
   * creating HTTP request (auth.mode = entra) is captured in the handler
   * closures so every dispatch from this session is user-attributed in the
   * decision log. Identity is undefined in auth.mode = none.
   */
  private createSessionServer(identity?: Identity): McpServer {
    const server = new McpServer(
      { name: this.config.gateway.name, version: "1.0.0" },
      { capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} } }
    );
    this.setupMcpHandlers(server, identity);
    return server;
  }

  /** Identity attached by the auth middleware, if any. */
  private requestIdentity(req: Request): Identity | undefined {
    return (req as AuthedRequest).identity;
  }

  private setupMcpHandlers(mcpServer: McpServer, identity?: Identity): void {
    const lowLevel = mcpServer.server;

    lowLevel.setRequestHandler(
      ListToolsRequestSchema,
      async (): Promise<{ tools: any[] }> => {
        return { tools: this.getExposedTools() };
      }
    );

    lowLevel.setRequestHandler(
      CallToolRequestSchema,
      async (request: any, extra: any): Promise<{ content: any[]; isError?: boolean }> => {
        const toolName: string = request.params.name;
        const args: Record<string, unknown> = request.params.arguments ?? {};

        // Phase 3: hand dispatch a handle on this session so the Tier-B
        // elicitation branch can query client capabilities and send an
        // elicitation/create related to THIS in-flight request. In stateless
        // mode the per-request server never saw an initialize, so its
        // capabilities are undefined and elicitation degrades to the park.
        const session: DispatchSessionContext | undefined =
          typeof extra?.sendRequest === "function"
            ? {
                sessionId: extra.sessionId,
                server: mcpServer,
                sendRequest: (req: unknown, schema: unknown, options?: { timeout?: number }) =>
                  extra.sendRequest(req, schema, options),
              }
            : undefined;

        // clientInfo.name from the initialize handshake, read at dispatch time
        // (it is not yet set when handlers are registered). Only observable on
        // stateful transports (session-mode streamable HTTP, SSE) — on the
        // stateless streamable path each POST gets a fresh server that never
        // saw initialize, so this is undefined there. Consumed by
        // approvals.identity_scope = "install+client" (Phase 4).
        const clientName: string | undefined = lowLevel.getClientVersion()?.name;

        if (isMuxToolName(toolName)) return this.handleMuxTool(toolName, args, identity, session, clientName);
        // Direct (namespaced) path: a top-level `confirmed: true` authorizes a
        // write-class call exactly as the mux envelope does, and is stripped
        // before forwarding so the backend never sees the gateway's flag — keeps
        // the gate verdict byte-identical with the mux path (invariant I2).
        // `confirmToken` (Phase 4 audit nonce) rides the same way and is
        // stripped identically.
        const directConfirmed = args.confirmed === true;
        const directToken = typeof args.confirmToken === "string" ? args.confirmToken : undefined;
        const stripControls = directConfirmed || directToken !== undefined;
        const directArgs = stripControls ? { ...args } : args;
        if (stripControls) {
          delete (directArgs as Record<string, unknown>).confirmed;
          delete (directArgs as Record<string, unknown>).confirmToken;
        }
        return this.dispatchToolCall(toolName, directArgs, {
          path: "direct",
          confirmed: directConfirmed,
          confirmToken: directToken,
          identity,
          session,
          clientName,
        });
      }
    );

    // Resource handlers
    lowLevel.setRequestHandler(
      ListResourcesRequestSchema,
      async (): Promise<{ resources: any[] }> => {
        if (this.isFacadeMode()) return { resources: [] };

        const allResources: any[] = [];
        for (const [name, backend] of this.backends) {
          if (backend.status !== "connected") continue;
          try {
            const resources = await backend.listResources();
            const ns = this.config.backends[name]?.namespace ?? name;
            const prefix = this.config.gateway.tool_prefix ? `${this.config.gateway.tool_prefix}${ns}` : ns;
            for (const r of resources) {
              allResources.push({ ...r, name: `${prefix}_${r.name}` });
            }
          } catch {
            // skip backends that don't support resources
          }
        }
        return { resources: allResources };
      }
    );

    lowLevel.setRequestHandler(
      ReadResourceRequestSchema,
      async (request: any): Promise<{ contents: any[] }> => {
        const uri: string = request.params.uri;
        if (this.isFacadeMode()) {
          return { contents: [{ uri, text: "Resource passthrough is disabled in mcp-gateway mux facade mode." }] };
        }

        // Try each backend until one handles the URI
        for (const [, backend] of this.backends) {
          if (backend.status !== "connected") continue;
          try {
            const result = await backend.readResource(uri);
            return result as { contents: any[] };
          } catch {
            // try next
          }
        }
        return { contents: [{ uri, text: `Resource not found: ${uri}` }] };
      }
    );

    // Prompt handlers
    lowLevel.setRequestHandler(
      ListPromptsRequestSchema,
      async (): Promise<{ prompts: any[] }> => {
        if (this.isFacadeMode()) return { prompts: [] };

        const allPrompts: any[] = [];
        for (const [name, backend] of this.backends) {
          if (backend.status !== "connected") continue;
          try {
            const prompts = await backend.listPrompts();
            const ns = this.config.backends[name]?.namespace ?? name;
            const prefix = this.config.gateway.tool_prefix ? `${this.config.gateway.tool_prefix}${ns}` : ns;
            for (const p of prompts) {
              allPrompts.push({ ...p, name: `${prefix}_${p.name}` });
            }
          } catch {
            // skip backends that don't support prompts
          }
        }
        return { prompts: allPrompts };
      }
    );

    lowLevel.setRequestHandler(
      GetPromptRequestSchema,
      async (request: any): Promise<{ messages: any[] }> => {
        const promptName: string = request.params.name;
        if (this.isFacadeMode()) {
          return {
            messages: [
              {
                role: "assistant" as const,
                content: {
                  type: "text" as const,
                  text: "Prompt passthrough is disabled in mcp-gateway mux facade mode.",
                },
              },
            ],
          };
        }

        // Find the backend by namespace prefix
        for (const [name, backend] of this.backends) {
          if (backend.status !== "connected") continue;
          const ns = this.config.backends[name]?.namespace ?? name;
          const prefix = this.config.gateway.tool_prefix ? `${this.config.gateway.tool_prefix}${ns}` : ns;
          if (promptName.startsWith(`${prefix}_`)) {
            const originalName = promptName.slice(prefix.length + 1);
            try {
              const result = await backend.getPrompt(
                originalName,
                request.params.arguments
              );
              return result as { messages: any[] };
            } catch (err) {
              return {
                messages: [
                  {
                    role: "assistant" as const,
                    content: {
                      type: "text" as const,
                      text: `Error: ${err instanceof Error ? err.message : String(err)}`,
                    },
                  },
                ],
              };
            }
          }
        }
        return {
          messages: [
            {
              role: "assistant" as const,
              content: {
                type: "text" as const,
                text: `Unknown prompt: ${promptName}`,
              },
            },
          ],
        };
      }
    );
  }

  private setupHttpRoutes(): void {
    // OPS-1: unauthenticated liveness endpoint. Mounted FIRST, before any
    // tool-plane auth middleware, so a load balancer / process supervisor can
    // probe it without the admin token or a bearer secret. It reports only
    // coarse liveness (uptime) and backend health counts — never tokens,
    // secrets, config, or per-backend detail — so it is safe to expose
    // unauthenticated. Cheap and non-blocking: pure in-memory reads.
    this.app.get("/healthz", (_req: Request, res: Response) => {
      // STAB-3: report an HONEST denominator. `connected` and `total` keep their
      // original meaning (existing consumers, incl. `thesun status` / `thesun
      // doctor`, read exactly those two), and the per-status breakdown is added
      // alongside so a gap like "17 of 37 connected" is self-explaining: it says
      // how many of the missing backends are still being retried versus given up
      // on versus deliberately disabled.
      res.json({
        status: "ok",
        uptime_s: Math.floor((Date.now() - this.bootTimeMs) / 1000),
        backends: this.backendHealthCounts(),
      });
    });

    // GW-1: unauthenticated loopback Prometheus scrape endpoint. Mounted here
    // alongside /healthz, before any tool-plane auth, so a metrics collector
    // can probe it without the admin token. Emits metric NAMES and integer
    // counts only (never tokens, secrets, config, or argument values), so it
    // is safe to expose unauthenticated. Cheap and non-blocking: reads the
    // in-memory counters plus a point-in-time backend-connectivity snapshot.
    this.app.get("/metrics", (_req: Request, res: Response) => {
      // STAB-3: same breakdown as /healthz, as additional gauge series. The two
      // original series keep their names and meaning; new series are additive,
      // which is safe for any scraper.
      const counts = this.backendHealthCounts();
      res
        .type("text/plain; version=0.0.4; charset=utf-8")
        .send(
          this.metrics.renderPrometheus({
            backendsConnected: counts.connected,
            backendsTotal: counts.total,
            backendsStarting: counts.starting,
            backendsRetrying: counts.retrying,
            backendsAbandoned: counts.abandoned,
            backendsDisabled: counts.disabled,
          })
        );
    });

    // Per-install shared secret (2026-07 hardening): OPT-IN — the mechanism is
    // implemented here so an operator can turn it on today, but it is NOT
    // wired as a default-required gate. Making it default-on requires a
    // coordinated fleet/wire.go change (Wave-2b) to inject the bearer token on
    // every gateway connection; without that, defaulting this on would break
    // every existing client. Mounted before body parsing, same surfaces as
    // the Entra middleware, and composes with it (both can be set at once).
    if (this.config.auth?.shared_secret) {
      const sharedSecret = this.config.auth.shared_secret;
      this.app.use(["/mcp"], (req: Request, res: Response, next: NextFunction) => {
        const provided = (req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
        if (this.timingSafeStringEqual(provided, sharedSecret)) {
          next();
          return;
        }
        res.status(401).json({ error: "Shared-secret authorization required" });
      });
      this.logger.info("Tool-plane auth enabled (per-install shared secret) on /mcp");
    }

    // Tool-plane authentication (auth.mode = entra): the gateway validates
    // Entra-issued JWTs ITSELF on every tool-plane surface. Mounted before
    // body parsing so unauthenticated requests are rejected cheaply. Edge-
    // injected headers are never an authorization input — a bypassed edge
    // fails to 401 here, not to silent access.
    if (this.config.auth?.mode === "entra") {
      const authMiddleware = createEntraAuthMiddleware(this.config.auth, this.logger);
      this.app.use(["/mcp"], authMiddleware);
      this.logger.info("Tool-plane auth enabled (Entra JWT) on /mcp");
    }

    // Apply JSON parsing only to admin routes.
    this.app.use("/admin", express.json());
    this.app.use("/admin", this.requireAdminAccess.bind(this));
    this.app.use("/mcp", express.json({ limit: "10mb" }));

    // Streamable HTTP endpoint for MCP clients that support type=http (Claude Code, Copilot CLI)
    this.app.all("/mcp", async (req: Request, res: Response) => {
      if (this.config.gateway.streamable_http_stateless) {
        await this.handleStatelessStreamableRequest(req, res);
        return;
      }

      const sessionId = this.headerValue(req.headers["mcp-session-id"]);
      let transport: StreamableHTTPServerTransport | undefined;

      try {
        if (sessionId) {
          transport = this.streamableTransports.get(sessionId);
          if (!transport) {
            res.status(404).json({
              jsonrpc: "2.0",
              error: { code: -32001, message: "Session not found" },
              id: null,
            });
            return;
          }
          if (!this.requestMatchesSessionOwner(req, sessionId)) {
            res.status(403).json({
              jsonrpc: "2.0",
              error: { code: -32003, message: "Session does not belong to the authenticated identity" },
              id: null,
            });
            return;
          }
          this.touchStreamableSession(sessionId);
        } else if (req.method === "POST" && isInitializeRequest(req.body)) {
          const identity = this.requestIdentity(req);
          let initializedSessionId: string | undefined;
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (newSessionId) => {
              initializedSessionId = newSessionId;
              this.streamableTransports.set(newSessionId, transport!);
              this.sessionOwners.set(newSessionId, identity?.oid ?? null);
              this.touchStreamableSession(newSessionId);
            },
          });

          const sessionServer = this.createSessionServer(identity);
          // Phase 3: capture the client's declared capabilities + clientInfo
          // once the MCP initialize handshake completes (oninitialized fires
          // on notifications/initialized, after the SDK has populated
          // getClientCapabilities()/getClientVersion()).
          sessionServer.server.oninitialized = () => {
            const sid = initializedSessionId ?? transport?.sessionId;
            if (!sid) return;
            this.sessionMeta.set(sid, {
              capabilities: sessionServer.server.getClientCapabilities(),
              clientInfo: sessionServer.server.getClientVersion(),
            });
          };
          transport.onclose = () => {
            const sid = initializedSessionId ?? transport?.sessionId;
            if (sid) {
              this.dropStreamableSession(sid);
            }
          };

          await sessionServer.server.connect(transport);
          await transport.handleRequest(req, res, req.body);

          const sid = initializedSessionId ?? transport.sessionId;
          if (sid) {
            this.sessions.set(sid, sessionServer);
            this.touchStreamableSession(sid);
          }
          return;
        } else {
          res.status(400).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Bad Request: No valid session ID provided" },
            id: null,
          });
          return;
        }

        await transport.handleRequest(req, res, req.body);
      } catch (err) {
        this.logger.error(`Streamable HTTP request failed: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          });
        }
      }
    });

    // CLN-2: the legacy server-side SSE transport (GET /sse + POST /messages,
    // SSEServerTransport) has been removed. streamable-http (/mcp) is the ONLY
    // supported client transport in this workspace (SSE is prohibited: an SSE
    // client against a streamable-http surface 405-fails the handshake). No
    // supported client path and no test exercised these handlers, so they were
    // dead surface area; removing them shrinks the auth-gated attack surface.

    // Admin API
    this.app.get("/admin/backends", (_req: Request, res: Response) => {
      const backends = Array.from(this.backends.values()).map((b) => ({
        name: b.name,
        namespace: b.config.namespace,
        transport: b.config.transport,
        status: b.status,
        toolCount: b.tools.length,
        error: b.error,
        restartCount: b.restartCount,
        lastConnected: b.lastConnected,
        enabled: b.config.enabled,
      }));
      res.json({ backends });
    });

    this.app.post(
      "/admin/reload/:name",
      async (req: Request, res: Response) => {
        const backendName = req.params.name as string;
        const backend = this.backends.get(backendName);
        if (!backend) {
          res.status(404).json({ error: `Backend "${backendName}" not found` });
          return;
        }

        try {
          const toolCount = await this.ensureReconnected(backendName);
          res.json({
            status: "ok",
            message: `Backend "${backendName}" reloaded`,
            toolCount,
          });
        } catch (err) {
          res.status(500).json({
            error: `Failed to reload backend "${backendName}": ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    );

    this.app.post(
      "/admin/enable/:name",
      async (req: Request, res: Response) => {
        const backendName = req.params.name as string;
        const backend = this.backends.get(backendName);
        if (!backend) {
          res.status(404).json({ error: `Backend "${backendName}" not found` });
          return;
        }

        backend.config.enabled = true;
        try {
          backend.resetRestartBudget();
          await backend.restart();
          this.toolRegistry.registerBackend(
            backendName,
            backend.config.namespace,
            this.visibleTools(backend.config, backend.tools)
          );
          this.notifyToolsChanged();
          res.json({ status: "ok", message: `Backend "${backendName}" enabled` });
        } catch (err) {
          res.status(500).json({
            error: `Failed to enable backend "${backendName}"`,
          });
        }
      }
    );

    this.app.post(
      "/admin/disable/:name",
      async (req: Request, res: Response) => {
        const backendName = req.params.name as string;
        const backend = this.backends.get(backendName);
        if (!backend) {
          res.status(404).json({ error: `Backend "${backendName}" not found` });
          return;
        }

        await backend.disconnect();
        backend.config.enabled = false;
        this.toolRegistry.unregisterBackend(backendName);
        this.notifyToolsChanged();
        res.json({ status: "ok", message: `Backend "${backendName}" disabled` });
      }
    );

    this.app.get("/admin/status", (_req: Request, res: Response) => {
      const toolStats = this.toolRegistry.getStats();
      const totalTools = this.toolRegistry.getAllTools().length;
      const connectedBackends = Array.from(this.backends.values()).filter(
        (b) => b.status === "connected"
      ).length;

      res.json({
        gateway: this.config.gateway.name,
        totalBackends: this.backends.size,
        connectedBackends,
        totalTools,
        toolsByBackend: toolStats,
        activeSessions: this.streamableTransports.size,
      });
    });

    this.app.get("/admin/fleet/inventory", async (req: Request, res: Response) => {
      if (!this.config.fleet.enabled) {
        res.status(404).json({ error: "Fleet inventory is disabled" });
        return;
      }

      try {
        const probe = req.query.probe === "true" || req.query.probe === "1";
        const inventory = await this.buildFleetInventory(probe);
        res.json(inventory);
      } catch (err) {
        res.status(500).json({
          error: `Failed to build fleet inventory: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    this.app.get("/admin/fleet/mcpu-config", async (req: Request, res: Response) => {
      if (!this.config.fleet.enabled) {
        res.status(404).json({ error: "Fleet inventory is disabled" });
        return;
      }

      try {
        const probe = req.query.probe === "true" || req.query.probe === "1";
        const configOnly = req.query.configOnly === "true" || req.query.configOnly === "1";
        const inventory = await this.buildFleetInventory(probe);
        const report = buildFleetMcpuConfig(inventory);
        res.json(configOnly ? report.config : report);
      } catch (err) {
        res.status(500).json({
          error: `Failed to build MCPU config report: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    this.app.get("/admin/fleet/summary", async (_req: Request, res: Response) => {
      if (!this.config.fleet.enabled) {
        res.status(404).json({ error: "Fleet inventory is disabled" });
        return;
      }

      try {
        const inventory = await this.buildFleetInventory(false);
        res.json({
          generatedAt: inventory.generatedAt,
          paths: inventory.paths,
          probeEnabled: inventory.probeEnabled,
          dockerPsEnabled: inventory.dockerPsEnabled,
          summary: inventory.summary,
          errors: inventory.errors,
        });
      } catch (err) {
        res.status(500).json({
          error: `Failed to build fleet summary: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    this.app.get("/admin/fleet/backends", (_req: Request, res: Response) => {
      const fleetBackends = Array.from(this.backends.entries())
        .filter(([, b]) => this.isFleetIngestedConfig(b.config))
        .map(([name, b]) => ({
          name,
          namespace: b.config.namespace,
          url: this.getBackendUrl(b.config),
          status: b.status,
          toolCount: b.tools.length,
          error: b.error,
          restartCount: b.restartCount,
          lastConnected: b.lastConnected,
        }));

      res.json({
        fleetBackendCount: fleetBackends.length,
        totalBackends: this.backends.size,
        backends: fleetBackends,
      });
    });

    this.app.post("/admin/fleet/reload", async (_req: Request, res: Response) => {
      if (!this.config.fleet.enabled || !this.config.fleet.toolhive.auto_ingest) {
        res.status(404).json({ error: "Fleet auto-ingestion is disabled" });
        return;
      }

      try {
        const result = await this.ingestFleetBackends();
        res.json({
          status: "ok",
          ingestResult: {
            source: result.source,
            generatedAt: result.generatedAt,
            loaded: Object.keys(result.backends).length,
            skipped: result.skipped.length,
            skippedDetails: result.skipped,
          },
          totalBackends: this.backends.size,
        });
      } catch (err) {
        res.status(500).json({
          error: `Fleet reload failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    this.app.post("/admin/reload-config", async (_req: Request, res: Response) => {
      try {
        await this.reloadConfig();
        res.json({ status: "ok", message: "Configuration reloaded" });
      } catch (err) {
        res.status(500).json({
          error: `Failed to reload config: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });
  }

  /**
   * SC-4 Tier-B out-of-band approval channel: /approve and /grants.
   *
   * Loopback-only (reuses requireAdminAccess — the SAME loopback/admin-token
   * gate the rest of the /admin surface uses), and deliberately mounted
   * OUTSIDE the /mcp tool plane — there is no MCP tool that exposes these
   * paths, so the model has no channel to reach them. Only a human at the
   * console (or the `thesun approve` / `thesun grants` CLI, which is itself a
   * separate local process a human runs) can approve a pending Tier-B
   * request or manage standing grants. This is the "nothing that authorizes
   * may travel through the model" constraint made structural.
   */
  private setupApprovalRoutes(): void {
    const jsonBody = express.json();
    const formBody = express.urlencoded({ extended: false });

    // Shift-left dependency guard (Phase 1b): the universal client hook POSTs
    // shell install commands here so a malicious/typosquatted/vulnerable
    // dependency is caught BEFORE it is installed. Mounted alongside /approve
    // and /trust — the route self-gates to loopback (its own requireLoopback
    // mirrors requireAdminAccess, honoring MCP_GATEWAY_ADMIN_TOKEN), so the
    // model has no channel to reach it. Fail-open by contract: a non-install
    // command or any error responds null (allow).
    registerDepScanRoute(this.app, this.logger);

    this.app.get(
      "/approve",
      this.requireAdminAccess.bind(this),
      (req: Request, res: Response) => {
        const pending = this.approvalStore.listPending();
        this.pruneArgPreviews(pending);
        if (this.prefersHtml(req)) {
          res.type("html").send(this.renderApprovePage(pending));
          return;
        }
        res.json({
          pending: pending.map((p) => ({
            ...p,
            summary: describeApproval(p),
            // Phase 2 (G5): RAM-only content-guard-redacted actual values —
            // present only while this gateway process has them (never
            // persisted, absent after a restart).
            ...(this.approvalArgPreviews.has(p.id) && this.approvalArgPreviews.get(p.id) !== ""
              ? { argsPreview: this.approvalArgPreviews.get(p.id) }
              : {}),
          })),
        });
      }
    );

    this.app.post(
      "/approve",
      jsonBody,
      formBody,
      this.requireAdminAccess.bind(this),
      (req: Request, res: Response) => {
        const body = req.body ?? {};
        const id = typeof body.id === "string" ? body.id : "";
        const standing = body.standing === true || body.standing === "true" || body.standing === "on";
        const ttlMinutesRaw = body.ttlMinutes ?? body.ttl;
        const ttlMinutes =
          typeof ttlMinutesRaw === "number"
            ? ttlMinutesRaw
            : typeof ttlMinutesRaw === "string" && ttlMinutesRaw.trim() !== ""
              ? Number(ttlMinutesRaw)
              : undefined;
        const ttlMs = typeof ttlMinutes === "number" && Number.isFinite(ttlMinutes) && ttlMinutes > 0
          ? ttlMinutes * 60_000
          : undefined;

        if (!id) {
          if (this.prefersHtml(req)) {
            res.status(400).type("html").send(this.renderApproveResult(false, "missing id"));
            return;
          }
          res.status(400).json({ error: "missing id" });
          return;
        }

        const result = this.approvalStore.approve(id, { standing, ttlMs });
        if (!result) {
          if (this.prefersHtml(req)) {
            res.status(404).type("html").send(this.renderApproveResult(false, `unknown or expired approval id "${id}"`));
            return;
          }
          res.status(404).json({ error: "not_found", id });
          return;
        }

        // Evict the RAM preview the moment the approval is actioned — the
        // redacted values existed solely to inform this decision.
        this.approvalArgPreviews.delete(id);

        // Report the grant that was actually created, not the flag that was
        // requested: a no-standing class (NO_STANDING_GRANT_CLASSES) downgrades
        // --always to one-time, and a response claiming standing:true for a
        // grant that is consumed on first use would be a lie the operator acts
        // on. `standingDowngraded` names the difference explicitly.
        const grantedStanding = result.grant.oneTime !== true;
        const standingDowngraded = standing && !grantedStanding;

        this.logger.info({
          event: "tierb.approved",
          id,
          backend: result.approval.backend,
          tool: result.approval.tool,
          identity: result.approval.identity,
          standing: grantedStanding,
          ...(standingDowngraded ? { standingDowngraded: true, safetyClass: result.approval.safetyClass } : {}),
          msg: standingDowngraded
            ? "Tier-B approval granted by a human via the loopback /approve endpoint; standing request downgraded to one-time by the safety class"
            : "Tier-B approval granted by a human via the loopback /approve endpoint",
        });

        if (this.prefersHtml(req)) {
          res.redirect(303, "/approve");
          return;
        }
        res.json({
          status: "approved",
          id,
          standing: grantedStanding,
          ...(standingDowngraded
            ? {
                standingDowngraded: true,
                reason: `Safety class ${result.approval.safetyClass} cannot hold standing authority; this approval was recorded one-time and authorizes exactly one call.`,
              }
            : {}),
          grant: result.grant,
        });
      }
    );

    // Phase 2: `thesun trust <backend>` — backend-wide standing grant
    // (identity × backend × "*"). Same loopback/admin gate as /approve; same
    // structural property: no MCP tool exposes this path, and the parked
    // response the model sees never mentions it (the model's suggested remedy
    // stays per-tool `thesun approve`). Only a human at the console reaches
    // this, via the CLI.
    this.app.post(
      "/trust",
      jsonBody,
      formBody,
      this.requireAdminAccess.bind(this),
      (req: Request, res: Response) => {
        const body = req.body ?? {};
        const backend = typeof body.backend === "string" ? body.backend.trim() : "";
        if (!backend) {
          res.status(400).json({ error: "missing backend" });
          return;
        }
        // Reject unknown backends: a typo here would otherwise create a
        // dangling wildcard grant that silently activates if a backend with
        // that name ever appears — the wrong failure mode for a blast-radius-
        // widening operation.
        if (!this.backends.has(backend)) {
          res.status(404).json({
            error: "unknown_backend",
            backend,
            knownBackends: Array.from(this.backends.keys()).sort(),
          });
          return;
        }
        const ttlMinutesRaw = body.ttlMinutes ?? body.ttl;
        const ttlMinutes =
          typeof ttlMinutesRaw === "number"
            ? ttlMinutesRaw
            : typeof ttlMinutesRaw === "string" && ttlMinutesRaw.trim() !== ""
              ? Number(ttlMinutesRaw)
              : undefined;
        const ttlMs =
          typeof ttlMinutes === "number" && Number.isFinite(ttlMinutes) && ttlMinutes > 0
            ? ttlMinutes * 60_000
            : undefined;

        // UX-1: when the request names a safetyClass, mint a CLASS-scoped grant
        // (identity × backend × safetyClass) instead of a backend-wide trust.
        // A class grant authorizes every tool of that one class on the backend
        // for a short (store-capped) TTL, so a human can silence a burst of
        // same-class Tier-B prompts without opening the whole backend. Only the
        // three always-Tier-B classes are meaningful here: a class grant is
        // consulted solely on the Tier-B dispatch path, and READ/WRITE/
        // SIDE_EFFECT/UNCLASSIFIED never reach it. Same loopback/admin gate and
        // backend-existence check as the trust path above.
        const rawClass =
          typeof body.safetyClass === "string" ? body.safetyClass.trim().toUpperCase() : "";
        if (rawClass) {
          const tierBClasses: SafetyClass[] = ["PRODUCTION", "VAULT_VALUE", "HUMAN_OUTBOUND"];
          if (!tierBClasses.includes(rawClass as SafetyClass)) {
            res.status(400).json({
              error: "invalid_safety_class",
              safetyClass: rawClass,
              allowed: tierBClasses,
            });
            return;
          }
          // A class grant is standing authority over every current and future
          // tool of this class on the backend. NO_STANDING_GRANT_CLASSES names
          // the classes for which that must never exist (PRODUCTION: its tools
          // include universal executors reaching live CDN activation), so the
          // request is refused here rather than minted and then ignored by the
          // resolver. createClassGrant throws on the same condition as the
          // fail-closed backstop.
          if (!allowsStandingGrant(rawClass as SafetyClass)) {
            res.status(400).json({
              error: "standing_grant_not_allowed",
              safetyClass: rawClass,
              reason: `Safety class ${rawClass} cannot be covered by a standing or class-scoped grant; every call requires a fresh one-time human approval via \`thesun approve <id>\` (without --always).`,
            });
            return;
          }
          const classIdentity = this.resolveApprovalIdentity(this.requestIdentity(req));
          const classGrant = this.approvalStore.createClassGrant({
            identity: classIdentity,
            backend,
            safetyClass: rawClass as SafetyClass,
            ttlMs,
          });
          this.logger.warn({
            event: "tierb.class_granted",
            backend,
            identity: classIdentity,
            safetyClass: rawClass,
            grantId: classGrant.id,
            expiresAt: classGrant.expiresAt ?? null,
            msg: "Class-scoped Tier-B grant created via the loopback /trust endpoint — covers ALL tools of this safety class on this backend until the grant TTL expires",
          });
          res.json({
            status: "class_trusted",
            grant: classGrant,
            warning: `This grant authorizes EVERY ${rawClass} Tier-B tool of backend "${backend}" for this identity until ${classGrant.expiresAt}. Revoke with: thesun grants rm ${classGrant.id}`,
          });
          return;
        }

        const identity = this.resolveApprovalIdentity(this.requestIdentity(req));
        const grant = this.approvalStore.createTrustGrant({ identity, backend, ttlMs });

        this.logger.warn({
          event: "tierb.trust_granted",
          backend,
          identity,
          grantId: grant.id,
          expiresAt: grant.expiresAt ?? null,
          msg: "Backend-wide Tier-B trust grant created via the loopback /trust endpoint — covers ALL current and future tools of this backend",
        });

        res.json({
          status: "trusted",
          grant,
          warning: `This standing grant authorizes EVERY Tier-B tool of backend "${backend}" for this identity — including tools the backend adds in the future. Revoke with: thesun grants rm ${grant.id}`,
        });
      }
    );

    this.app.get(
      "/grants",
      this.requireAdminAccess.bind(this),
      (_req: Request, res: Response) => {
        res.json({ grants: this.approvalStore.listGrants() });
      }
    );

    this.app.delete(
      "/grants/:id",
      this.requireAdminAccess.bind(this),
      (req: Request, res: Response) => {
        const id = String(req.params.id);
        const revoked = this.approvalStore.revokeGrant(id);
        if (!revoked) {
          res.status(404).json({ error: "not_found", id });
          return;
        }
        this.logger.info({ event: "tierb.grant_revoked", id, msg: "Standing grant revoked via /grants" });
        res.json({ status: "revoked", id });
      }
    );
  }

  /** True when the request's Accept header prefers HTML over JSON (browser navigation vs. CLI/API call). */
  private prefersHtml(req: Request): boolean {
    const accepted = req.accepts(["html", "json"]);
    return accepted === "html";
  }

  private renderApprovePage(pending: import("./approvals.js").PendingApproval[]): string {
    const rows = pending
      .map(
        (p) => `
        <tr>
          <td>${this.escapeHtml(p.id)}</td>
          <td>${this.escapeHtml(p.backend)}.${this.escapeHtml(p.tool)}</td>
          <td>${this.escapeHtml(p.safetyClass)}</td>
          <td>${this.escapeHtml(p.identity)}</td>
          <td><code>${this.escapeHtml(p.argsSummary)}</code></td>
          <td><code>${this.escapeHtml(this.approvalArgPreviews.get(p.id) || "(no preview — parked before this gateway start)")}</code></td>
          <td>${this.escapeHtml(p.expiresAt)}</td>
          <td>
            <form method="post" action="/approve" style="display:inline">
              <input type="hidden" name="id" value="${this.escapeHtml(p.id)}" />
              <button type="submit">Approve once</button>
            </form>
            <form method="post" action="/approve" style="display:inline">
              <input type="hidden" name="id" value="${this.escapeHtml(p.id)}" />
              <input type="hidden" name="standing" value="true" />
              <button type="submit">Approve + always allow</button>
            </form>
          </td>
        </tr>`
      )
      .join("");
    return `<!doctype html><html><head><meta charset="utf-8"><title>thesun gateway — pending approvals</title></head>
<body>
<h1>Pending Tier-B approvals</h1>
${pending.length === 0 ? "<p>No pending approvals.</p>" : `
<table border="1" cellpadding="6" cellspacing="0">
<thead><tr><th>id</th><th>tool</th><th>class</th><th>identity</th><th>args (types)</th><th>args preview (redacted, in-memory only)</th><th>expires</th><th>action</th></tr></thead>
<tbody>${rows}</tbody>
</table>`}
<p><a href="/grants">View standing grants</a></p>
</body></html>`;
  }

  private renderApproveResult(ok: boolean, detail: string): string {
    return `<!doctype html><html><head><meta charset="utf-8"><title>thesun gateway — approve</title></head>
<body><p>${ok ? "Approved." : "Error: "}${this.escapeHtml(detail)}</p><p><a href="/approve">Back to pending approvals</a></p></body></html>`;
  }

  private escapeHtml(s: string): string {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  private headerValue(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
  }

  /**
   * Session-owner binding check (N2). With auth.mode = none this always
   * passes (no identity model). With auth on, the request's authenticated oid
   * must equal the oid recorded when the session was created; an unknown
   * session (no owner record) fails closed.
   */
  private requestMatchesSessionOwner(req: Request, sessionId: string): boolean {
    if (this.config.auth?.mode !== "entra") return true;
    if (!this.sessionOwners.has(sessionId)) return false;
    const owner = this.sessionOwners.get(sessionId) ?? null;
    return owner === (this.requestIdentity(req)?.oid ?? null);
  }

  private async handleStatelessStreamableRequest(
    req: Request,
    res: Response
  ): Promise<void> {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: this.config.gateway.streamable_http_json_response,
    });
    // Stateless: identity rides per-request — each request's authenticated
    // principal is captured for the lifetime of this one dispatch.
    const sessionServer = this.createSessionServer(this.requestIdentity(req));

    try {
      await sessionServer.server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      this.logger.error(
        `Stateless Streamable HTTP request failed: ${err instanceof Error ? err.message : String(err)}`
      );
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    } finally {
      try {
        await sessionServer.close();
      } catch (err) {
        this.logger.debug(`Stateless session cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      try {
        await transport.close();
      } catch (err) {
        this.logger.debug(`Stateless transport cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private isFacadeMode(): boolean {
    return this.config.gateway.tool_exposure === "mux";
  }

  private getExposedTools(): Tool[] {
    const mode = this.config.gateway.tool_exposure;
    if (mode === "mux") return getMuxTools();
    if (mode === "both") return [...getMuxTools(), ...this.toolRegistry.getAllTools()];
    return this.toolRegistry.getAllTools();
  }

  private jsonToolResult(value: unknown, maxChars = DEFAULT_MUX_RESPONSE_CHAR_LIMIT): { content: any[] } {
    const text = JSON.stringify(value, null, 2);
    const safeText = this.compactJsonText(text, maxChars);
    return {
      content: [
        {
          type: "text" as const,
          text: safeText,
        },
      ],
    };
  }

  private async handleMuxTool(
    toolName: MuxToolName,
    args: Record<string, unknown>,
    identity?: Identity,
    session?: DispatchSessionContext,
    clientName?: string
  ): Promise<{ content: any[]; isError?: boolean }> {
    // Every mux facade call funnels through here. Counted separately from
    // COUNTERS.toolCalls, which only ever counted backend dispatches inside
    // dispatchToolCall: a facade call like gateway_search_tools never reaches
    // that counter, so a zero there does NOT mean the gateway is idle. That
    // inference cost a crash investigation hours; this counter closes it.
    this.metrics.inc(COUNTERS.facadeCalls);

    switch (toolName) {
      case MUX_TOOL_NAMES.searchTools:
        return this.jsonToolResult(await this.searchRegisteredTools(args));
      case MUX_TOOL_NAMES.describeTool:
        return this.jsonToolResult(
          this.describeRegisteredTool(args),
          DESCRIBE_RESPONSE_CHAR_LIMIT
        );
      case MUX_TOOL_NAMES.callTool: {
        const { target, targetArgs } = extractCallToolArgs(args);
        if (!target) {
          return {
            content: [{ type: "text" as const, text: "gateway_call_tool requires a string 'tool' argument." }],
            isError: true,
          };
        }

        // confirmationMapsToDownstream: only when caller confirmed AND the manifest
        // says the downstream tool also expects a confirmation flag. Tier-B
        // classes are EXCLUDED here (SC-4 honesty requirement): a raw
        // agent-supplied confirmed:true is never a real authorization for
        // PRODUCTION/VAULT_VALUE/HUMAN_OUTBOUND/write_guard tools — only a
        // standing grant is. dispatchTierB injects this same flag itself,
        // but only after finding a grant.
        const confirmed = args.confirmed === true;
        // Phase 4 audit nonce: `confirmToken` is a sibling of `confirmed` on
        // the mux envelope — never part of targetArgs, so it is never
        // forwarded to the backend.
        const confirmToken = typeof args.confirmToken === "string" ? args.confirmToken : undefined;
        const safety = this.toolRegistry.resolve(target)?.safety;
        const dispatchArgs = { ...targetArgs };
        if (confirmed && safety?.confirmationMapsToDownstream === true && !isTierBClass(safety)) {
          dispatchArgs.confirmed = true;
        }

        // All gating happens inside dispatchToolCall — the single Policy
        // Enforcement Point shared with the direct path.
        return this.dispatchToolCall(target, dispatchArgs, {
          path: "mux",
          confirmed,
          confirmToken,
          identity,
          session,
          clientName,
          maxOutputChars: this.getCharLimit(args, "maxOutputChars"),
        });
      }
      case MUX_TOOL_NAMES.fetchArtifact:
        return this.jsonToolResult(this.fetchArtifact(args), DEFAULT_MUX_RESPONSE_CHAR_LIMIT);
      case MUX_TOOL_NAMES.backendStatus:
        return this.jsonToolResult(this.getBackendStatus(args), STATUS_RESPONSE_CHAR_LIMIT);
      case MUX_TOOL_NAMES.fleetInventory: {
        if (!this.config.fleet.enabled) {
          return {
            content: [{ type: "text" as const, text: "Fleet inventory is disabled." }],
            isError: true,
          };
        }
        const probe = args.probe === true;
        const inventory = await this.buildFleetInventory(probe);
        const includeEntries = args.includeEntries === true || args.summaryOnly === false;
        const limit = this.getListLimit(args);
        const compact = {
          generatedAt: inventory.generatedAt,
          paths: inventory.paths,
          probeEnabled: inventory.probeEnabled,
          dockerPsEnabled: inventory.dockerPsEnabled,
          summary: inventory.summary,
          errors: inventory.errors,
          ...(includeEntries
            ? {
                entries: inventory.entries.slice(0, limit).map((entry) => this.compactFleetEntry(entry)),
                returnedEntries: Math.min(inventory.entries.length, limit),
                omittedEntries: Math.max(0, inventory.entries.length - limit),
                note: "MCP output is capped to avoid context bloat. Use the loopback admin API /admin/fleet/inventory for full raw inventory when needed outside model context.",
              }
            : {}),
        };
        return this.jsonToolResult(compact, DEFAULT_MUX_RESPONSE_CHAR_LIMIT);
      }
      case MUX_TOOL_NAMES.reconnectBackend: {
        const backendName = typeof args.backend === "string" ? args.backend : "";
        if (!backendName) {
          return {
            content: [{ type: "text" as const, text: "gateway_reconnect_backend requires a string 'backend' argument." }],
            isError: true,
          };
        }
        if (!this.backends.has(backendName)) {
          return {
            content: [{ type: "text" as const, text: `Backend "${backendName}" not found. Use gateway_backend_status to list connected backends.` }],
            isError: true,
          };
        }
        try {
          const toolCount = await this.ensureReconnected(backendName);
          return this.jsonToolResult({
            backend: backendName,
            status: "reconnected",
            toolCount,
          }, DEFAULT_MUX_RESPONSE_CHAR_LIMIT);
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `Failed to reconnect backend "${backendName}": ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          };
        }
      }
      case MUX_TOOL_NAMES.mcpuConfig: {
        if (!this.config.fleet.enabled) {
          return {
            content: [{ type: "text" as const, text: "Fleet inventory is disabled." }],
            isError: true,
          };
        }
        const inventory = await this.buildFleetInventory(args.probe === true);
        const report = buildFleetMcpuConfig(inventory);
        const limit = this.getListLimit(args);
        const configEntries = Object.entries(report.config);
        const payload = {
          mode: report.mode,
          generatedAt: report.generatedAt,
          summary: report.summary,
          returnedConfigEntries: args.configOnly === true ? Math.min(configEntries.length, limit) : 0,
          omittedConfigEntries: args.configOnly === true ? Math.max(0, configEntries.length - limit) : configEntries.length,
          ...(args.configOnly === true
            ? {
                config: Object.fromEntries(configEntries.slice(0, limit)),
              }
            : {}),
          ...(args.includeEntries === true
            ? {
                entries: report.entries.slice(0, limit),
                returnedEntries: Math.min(report.entries.length, limit),
                omittedEntries: Math.max(0, report.entries.length - limit),
              }
            : {}),
          note: "MCP output is capped to avoid loading the full ToolHive/MCPU fleet into model context. Use the loopback admin API /admin/fleet/mcpu-config?configOnly=1 for full machine-consumable config outside model context.",
        };
        return this.jsonToolResult(payload, DEFAULT_MUX_RESPONSE_CHAR_LIMIT);
      }
    }
  }

  private buildFleetInventory(probe: boolean) {
    return buildToolHiveFleetInventory({
      ...this.config.fleet.toolhive,
      endpoint_probe: probe || this.config.fleet.toolhive.endpoint_probe,
    });
  }

  private getListLimit(args: Record<string, unknown>): number {
    const raw = args.limit;
    if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_MUX_LIST_LIMIT;
    return Math.max(1, Math.min(Math.floor(raw), MAX_MUX_LIST_LIMIT));
  }

  private getCharLimit(args: Record<string, unknown>, key: string): number {
    const raw = args[key];
    if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_MUX_RESPONSE_CHAR_LIMIT;
    return Math.max(1_000, Math.min(Math.floor(raw), MAX_MUX_RESPONSE_CHAR_LIMIT));
  }

  private truncateText(value: string | undefined, maxChars: number): string | undefined {
    if (value === undefined || value.length <= maxChars) return value;
    return `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars by mcp-gateway]`;
  }

  /**
   * Phase 4: Content-aware compression of tool-output text.
   *
   * Gate: disabled by default (compression.enabled defaults to false).
   * When disabled the method is a pure pass-through — zero behavior change.
   *
   * When active, applies applyJsonCompression() (prune→columnar→minify),
   * stores the FULL UNCOMPRESSED ORIGINAL in the artifact store for lossless
   * retrieval via gateway_fetch_artifact, and returns the compressed text with
   * a self-describing marker object.
   *
   * In mode:"advisory" the original text is returned unchanged — only the
   * savings are logged.  The artifact is still stored so the model can opt in
   * to retrieval.
   *
   * @param text  The raw text content from a backend tool response.
   * @param kind  Artifact kind label (e.g. "backend-tool-compressed").
   * @returns     { text, marker? } — marker is present when compression engaged.
   */
  private compressToolText(
    text: string,
    kind: string
  ): { text: string; marker?: Record<string, unknown> } {
    // Defensive: older configs (e.g. test fixtures) may not have the compression
    // block.  Treat missing as { enabled: false }.
    const cfg = this.config.compression ?? { enabled: false, min_chars: 20_000, mode: "active" as const };

    // Gate 1: feature disabled (default) — pure pass-through.
    if (!cfg.enabled) return { text };

    // Gate 2: text below min_chars threshold — not worth compressing.
    if (text.length < cfg.min_chars) return { text };

    // Gate 3: must be valid JSON — non-JSON text passes through unchanged.
    let result: { compressed: string; savedPct: number };
    try {
      result = applyJsonCompression(text);
    } catch {
      return { text };
    }

    const { compressed, savedPct } = result;

    // Gate 4: no meaningful reduction — return original.
    if (savedPct <= 0) return { text };

    // Store the FULL UNCOMPRESSED ORIGINAL for lossless retrieval.
    const artifactId = this.storeArtifact(kind, text);

    const marker: Record<string, unknown> = {
      compressed: true,
      format: "gw-compress/v1 (prune+cols/v1+minify)",
      originalChars: text.length,
      compressedChars: compressed.length,
      savedPct,
      artifactId,
      note: "Full uncompressed original retrievable via gateway_fetch_artifact.",
    };

    if (cfg.mode === "advisory") {
      this.logger.info({
        event: "compression.advisory",
        kind,
        originalChars: text.length,
        compressedChars: compressed.length,
        savedPct,
        artifactId,
        msg: `compression advisory: would save ${savedPct}% (${text.length - compressed.length} chars)`,
      });
      // Advisory: return original text (do not alter output yet).
      return { text, marker };
    }

    // Active mode: return the compressed text with the marker.
    return { text: compressed, marker };
  }

  private compactJsonText(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    const artifactId = this.storeArtifact("json-response", text);
    return JSON.stringify(
      {
        gatewayTruncated: true,
        originalChars: text.length,
        maxChars,
        preview: text.slice(0, maxChars),
        artifactId,
        next: {
          tool: MUX_TOOL_NAMES.fetchArtifact,
          artifactId,
          offset: maxChars,
          maxChars: DEFAULT_MUX_RESPONSE_CHAR_LIMIT,
        },
        note: "Response exceeded the MCP gateway safe payload cap. Narrow the request or use the loopback admin API outside model context for full raw data.",
      },
      null,
      2
    );
  }

  private storeArtifact(kind: string, value: string): string {
    const id = `gw_artifact_${randomUUID()}`;
    const text = value.length > MAX_ARTIFACT_CHARS
      ? `${value.slice(0, MAX_ARTIFACT_CHARS)}\n...[artifact truncated ${value.length - MAX_ARTIFACT_CHARS} chars at storage boundary]`
      : value;
    this.artifacts.set(id, {
      id,
      kind,
      text,
      originalChars: value.length,
      storedAt: new Date().toISOString(),
    });

    while (this.artifacts.size > MAX_ARTIFACTS) {
      const oldest = this.artifacts.keys().next().value as string | undefined;
      if (!oldest) break;
      this.artifacts.delete(oldest);
    }

    return id;
  }

  private fetchArtifact(args: Record<string, unknown>): unknown {
    const artifactId = typeof args.artifactId === "string" ? args.artifactId : "";
    const artifact = this.artifacts.get(artifactId);
    if (!artifact) {
      return {
        error: "artifact_not_found",
        artifactId,
        note: "Artifacts are in-memory and may disappear after gateway restart or artifact cache eviction.",
      };
    }

    const rawOffset = args.offset;
    const offset = typeof rawOffset === "number" && Number.isFinite(rawOffset)
      ? Math.max(0, Math.floor(rawOffset))
      : 0;
    const maxChars = this.getCharLimit(args, "maxChars");
    const text = artifact.text.slice(offset, offset + maxChars);
    const nextOffset = offset + text.length;
    return {
      artifactId,
      kind: artifact.kind,
      storedAt: artifact.storedAt,
      originalChars: artifact.originalChars,
      storedChars: artifact.text.length,
      offset,
      returnedChars: text.length,
      text,
      hasMore: nextOffset < artifact.text.length,
      next: nextOffset < artifact.text.length
        ? { tool: MUX_TOOL_NAMES.fetchArtifact, artifactId, offset: nextOffset, maxChars }
        : undefined,
    };
  }

  private compactFleetEntry(entry: FleetEntry): unknown {
    return {
      name: entry.name,
      health: entry.health,
      reasons: entry.reasons.slice(0, 5),
      mcpuExposed: entry.mcpu.exposed,
      endpoint: {
        checked: entry.endpoint.checked,
        tcpOpen: entry.endpoint.tcpOpen,
        error: this.truncateText(entry.endpoint.error, 240),
      },
      runConfig: entry.runConfig
        ? {
            image: entry.runConfig.image,
            host: entry.runConfig.host,
            port: entry.runConfig.port,
            proxyMode: entry.runConfig.proxyMode,
            envKeyCount: entry.runConfig.envKeys.length,
            secretRefCount: entry.runConfig.secretRefs.length,
          }
        : undefined,
      docker: entry.docker
        ? {
            name: entry.docker.name,
            image: entry.docker.image,
            state: entry.docker.state,
            status: this.truncateText(entry.docker.status, 160),
          }
        : undefined,
      safeAutomaticRepairHints: entry.repairHints.filter((hint) => hint.safeAutomatic).length,
    };
  }

  /**
   * Lazily obtain the semantic-search index. Returns null when semantic search
   * is disabled or the optional embedding model cannot be loaded (in which case
   * the caller degrades to keyword ranking). The load is attempted at most once
   * (semanticInitTried), so a broken/absent embedder does not retry every call.
   * The index is rebuilt when the tool registry changes (version bump).
   */
  private async getSemanticIndex(): Promise<ToolSemanticIndex | null> {
    if (!this.config.gateway.search_semantic) return null;
    if (!this.semanticInitTried) {
      this.semanticInitTried = true;
      try {
        const embedder = await createDefaultEmbedder();
        this.semanticIndex = new ToolSemanticIndex(embedder);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `gateway_search_tools: semantic embedder unavailable, using keyword search for this session (${reason})`
        );
        this.semanticIndex = null;
      }
    }
    // Reconcile the embedding cache when the registry has changed since the
    // last index build. PRUNE to the tools that still exist rather than
    // clearing: ensureEmbeddings already re-embeds any tool whose text changed,
    // so clearing only forced a full, expensive re-embed of the whole fleet
    // every time a flapping backend bumped the version.
    const version = this.toolRegistry.getVersion();
    if (this.semanticIndex && version !== this.semanticIndexVersion) {
      this.semanticIndex.invalidate(
        new Set(this.toolRegistry.getAllEntries().map((entry) => entry.namespacedName))
      );
      this.semanticIndexVersion = version;
    }
    return this.semanticIndex;
  }

  private async searchRegisteredTools(args: Record<string, unknown>): Promise<unknown> {
    const query = typeof args.query === "string" ? args.query : "";
    const backendFilter = typeof args.backend === "string" ? args.backend : "";
    const limit = this.getListLimit(args);
    const totalRegisteredTools = this.toolRegistry.getAllTools().length;

    // Query-required guard — keep exactly as before.
    if (!query.trim() && !backendFilter.trim()) {
      return {
        totalRegisteredTools,
        returned: 0,
        matches: [],
        queryRequired: true,
        note: "gateway_search_tools requires a query or backend filter in facade mode; it will not dump the full backend tool inventory into model context.",
      };
    }

    // Phase 1: backendFilter pre-filter (unchanged behaviour, still uses matchesSearch).
    const backendFiltered = this.toolRegistry.getAllEntries().filter((entry) => {
      if (!backendFilter) return true;
      const backendConfig = this.backends.get(entry.backendName)?.config;
      return this.matchesSearch(
        [
          entry.backendName,
          backendConfig?.namespace ?? "",
          backendConfig && "description" in backendConfig ? backendConfig.description ?? "" : "",
        ].join(" "),
        backendFilter
      );
    });

    // Phase 2: build search candidates from the same haystack text used before,
    // so the semantic and keyword paths see identical inputs, then rank. When a
    // query is present, ranking is semantic (embedding top-k) if the model is
    // available, else keyword; either way it degrades gracefully. When there is
    // no query (backend-only listing), keyword ranking keeps every candidate.
    const entryById = new Map<string, (typeof backendFiltered)[number]>();
    const candidates: SearchCandidate[] = backendFiltered.map((entry) => {
      const backendConfig = this.backends.get(entry.backendName)?.config;
      entryById.set(entry.namespacedName, entry);
      return {
        id: entry.namespacedName,
        text: [
          entry.namespacedName,
          entry.originalName,
          entry.backendName,
          backendConfig?.namespace ?? "",
          backendConfig && "description" in backendConfig ? backendConfig.description ?? "" : "",
          entry.tool.description ?? "",
          ...(entry.safety?.tags ?? []),
        ].join(" "),
      };
    });

    // Semantic ranking only helps when there is an actual query; a backend-only
    // listing has no query text to embed, so keep it on the keyword path.
    const index = query.trim() ? await this.getSemanticIndex() : null;
    const { mode, ranked: rankedIds } = await rankCandidates(candidates, query, {
      semantic: this.config.gateway.search_semantic,
      index,
      logger: this.logger,
      onEmbedStats: (batches, toolsEmbedded) => {
        if (batches > 0) this.metrics.inc(COUNTERS.embedBatches, batches);
        if (toolsEmbedded > 0) this.metrics.inc(COUNTERS.embedTools, toolsEmbedded);
      },
    });

    const rankedEntries = rankedIds
      .map((r) => ({ entry: entryById.get(r.id), score: r.score }))
      .filter((r): r is { entry: (typeof backendFiltered)[number]; score: number } => r.entry !== undefined);

    const shown = rankedEntries.slice(0, limit);
    const matches = shown.map(({ entry, score }) => ({
      name: entry.namespacedName,
      backend: entry.backendName,
      originalName: entry.originalName,
      description: this.truncateText(entry.tool.description, 180),
      safetyClass: entry.safety?.safetyClass ?? null,
      tags: entry.safety?.tags ?? [],
      score,
      describeWith: {
        tool: MUX_TOOL_NAMES.describeTool,
        arguments: { tool: entry.namespacedName },
      },
    }));

    return {
      totalRegisteredTools,
      returned: matches.length,
      rankingMode: mode,
      omittedByLimit: Math.max(0, rankedEntries.length - matches.length),
      matches,
    };
  }

  private describeRegisteredTool(args: Record<string, unknown>): unknown {
    const toolName = typeof args.tool === "string" ? args.tool : "";
    const entry = this.toolRegistry.resolve(toolName);
    if (!entry) {
      return {
        error: "unknown_tool",
        tool: toolName,
        note: `Use ${MUX_TOOL_NAMES.searchTools} with a specific query to find a namespaced backend tool.`,
      };
    }

    const backendConfig = this.backends.get(entry.backendName)?.config;
    return {
      name: entry.namespacedName,
      backend: entry.backendName,
      namespace: backendConfig?.namespace,
      transport: backendConfig?.transport,
      originalName: entry.originalName,
      description: entry.tool.description,
      inputSchema: entry.tool.inputSchema,
      callWith: {
        tool: MUX_TOOL_NAMES.callTool,
        arguments: {
          tool: entry.namespacedName,
          arguments: {},
        },
      },
      note: "This is a lazy, single-tool description. Backend-wide schema dumps are intentionally not exposed in facade mode.",
    };
  }

  private getBackendStatus(args: Record<string, unknown>): unknown {
    const backendFilter = typeof args.backend === "string" ? args.backend : "";
    const limit = this.getListLimit(args);
    const includeBackends = args.includeBackends === true || Boolean(backendFilter.trim());
    const includeErrors = args.includeErrors === true;
    const includeDescriptions = args.includeDescriptions === true;
    const toolStats = this.toolRegistry.getStats();
    const allBackends = Array.from(this.backends.entries());
    const statusCounts = allBackends.reduce<Record<string, number>>((acc, [, backend]) => {
      acc[backend.status] = (acc[backend.status] ?? 0) + 1;
      return acc;
    }, {});
    const matchedBackends = allBackends
      .filter(([name, backend]) =>
        !backendFilter ||
        this.matchesSearch(
          [
            name,
            backend.config.namespace,
            backend.config.transport,
            "description" in backend.config ? backend.config.description ?? "" : "",
          ].join(" "),
          backendFilter
        )
      );
    const compactBackends = matchedBackends
      .slice(0, limit)
      .map(([name, backend]) => ({
        name,
        namespace: backend.config.namespace,
        transport: backend.config.transport,
        status: backend.status,
        toolCount: toolStats[name] ?? 0,
        ...(includeErrors ? { error: this.truncateText(backend.error, 500) } : {}),
        restartCount: backend.restartCount,
        lastConnected: backend.lastConnected?.toISOString(),
        ...(includeDescriptions && "description" in backend.config
          ? { description: this.truncateText(backend.config.description, 300) }
          : {}),
      }));
    const degradedBackends = allBackends
      .filter(([, backend]) => backend.status !== "connected")
      .slice(0, limit)
      .map(([name, backend]) => ({
        name,
        status: backend.status,
        transport: backend.config.transport,
        toolCount: toolStats[name] ?? 0,
        restartCount: backend.restartCount,
        ...(includeErrors ? { error: this.truncateText(backend.error, 300) } : {}),
      }));

    return {
      totalBackends: this.backends.size,
      connectedBackends: statusCounts.connected ?? 0,
      statusCounts,
      totalRegisteredTools: this.toolRegistry.getAllTools().length,
      returnedBackends: includeBackends ? compactBackends.length : 0,
      omittedBackends: includeBackends ? Math.max(0, matchedBackends.length - compactBackends.length) : matchedBackends.length,
      degradedBackends,
      quarantined: this.fleetQuarantined.slice(0, limit),
      backends: includeBackends ? compactBackends : undefined,
      note: includeBackends
        ? "Backend list is capped. Omit includeBackends for summary-only status."
        : "Summary-only facade response. Set backend=<name> or includeBackends=true for a capped backend list.",
    };
  }

  /**
   * Single Policy Enforcement Point for backend tool dispatch (C5).
   *
   * EVERY tool-dispatch path — the mux facade (gateway_call_tool) and the
   * direct namespaced path (CallToolRequest with a backend tool name) — must
   * route through this method. It resolves the registry entry, computes the
   * gate decision, emits the safety decision log line, and only then calls
   * the strictly-internal callBackendTool.
   *
   * callBackendTool MUST have no caller other than this method.
   */
  private async dispatchToolCall(
    toolName: string,
    targetArgs: Record<string, unknown>,
    opts: {
      path: "mux" | "direct";
      confirmed: boolean;
      confirmToken?: string;
      identity?: Identity;
      session?: DispatchSessionContext;
      clientName?: string;
      maxOutputChars?: number;
    }
  ): Promise<{ content: any[]; isError?: boolean }> {
    const entry = this.toolRegistry.resolve(toolName);
    // Per-action refinement for THIS call (manifest.ts refineForArgs). An
    // action-multiplexed tool can only be classified as a whole, so its class
    // is pinned to the most dangerous action it can reach and every read pays
    // a confirmation; a capability may declare a closed list of read actions
    // that classify READ instead. Fail-closed in every branch, and the only
    // rewrite it can make is one Tier-A class down to READ for this call: the
    // registry's static entry.safety is never mutated, a write action keeps
    // the write class, and a Tier-B classification is refused outright, so
    // running it ahead of the Tier-B interception below cannot let anything
    // past that path.
    const safety = refineForArgs(entry?.safety, targetArgs);
    const actionReadTag = safety?.tags.find((t) => t.startsWith("action-read:"));

    // GW-1: every dispatch (mux and direct) funnels through here.
    this.metrics.inc(COUNTERS.toolCalls);

    // SC-4 Tier-B interception: PRODUCTION / VAULT_VALUE / HUMAN_OUTBOUND and
    // any write_guard-flagged capability route to a completely separate path
    // that ignores confirmed:true and requires an out-of-band human approval
    // (grant or fresh /approve). This must run BEFORE decideGate — decideGate
    // treats confirmed:true as sufficient authorization for every gated class,
    // which is exactly the self-confirm bypass Tier-B exists to close. Tier-A
    // (WRITE/SIDE_EFFECT/READ/UNCLASSIFIED) never enters this branch and its
    // existing decideGate-based flow below is completely unchanged.
    if (entry && isTierBClass(safety)) {
      this.metrics.inc(COUNTERS.tierB);
      return this.dispatchTierB(toolName, targetArgs, entry, safety!, opts);
    }
    this.metrics.inc(COUNTERS.tierA);

    const enforce = this.config.safety.enforce;

    // ── Phase 4 Tier-A confirm token (AUDIT INTEGRITY ONLY — roadmap §2.4).
    // NOT an adversarial control: an autonomous model reads the token out of
    // the block response and echoes it. What it buys is a truthful decision
    // log — no blind first-call self-confirm (every executed gated call had a
    // prior challenge round-trip) and no confirm-then-swap (the token is
    // HMAC-bound to the challenged args-hash, verified against the CURRENT
    // args). decideGate itself stays stateless and untouched; the token check
    // only downgrades `confirmed` to false when the presented token does not
    // cover this exact (tool, args) pair, which re-issues the challenge.
    const tokenEnabled = this.config.safety.confirm_token !== false;
    const gatedIfUnconfirmed = decideGate(safety, false, "blocking").action === "block";
    let effectiveConfirmed = opts.confirmed;
    let tokenStatus: string | undefined;
    if (tokenEnabled && gatedIfUnconfirmed && opts.confirmed) {
      const verdict = this.confirmTokens.verify(toolName, targetArgs, opts.confirmToken);
      if (verdict.valid) {
        tokenStatus = "valid";
      } else {
        tokenStatus = opts.confirmToken === undefined ? "missing" : verdict.reason;
        effectiveConfirmed = false; // treat as unconfirmed → re-challenge
      }
    }

    const decision = decideGate(safety, effectiveConfirmed, enforce);

    // C3: append-only safety decision log — one line per dispatch decision,
    // emitted BEFORE dispatch so blocked calls are recorded too. FAIL-CLOSED
    // (2026-06-10): if the audit record cannot be written, the dispatch is
    // denied — no audit trail, no tool call.
    const logged = this.logSafetyDecision({
      ts: new Date().toISOString(),
      path: opts.path,
      user: opts.identity?.upn ?? opts.identity?.oid ?? null,
      tool: toolName,
      backend: entry?.backendName ?? null,
      safetyClass: safety?.safetyClass ?? null,
      source: safety?.source ?? null,
      // A READ produced by a per-action carve-out is recorded as such, so the
      // audit trail never reads as though the whole tool were read-safe.
      ...(actionReadTag
        ? { actionRead: actionReadTag.slice("action-read:".length) }
        : {}),
      ...(safety?.writeGuard ? { writeGuard: safety.writeGuard } : {}),
      decision: decision.action,
      // Audit-integrity fields (Phase 4): for gated Tier-A calls with the
      // token feature on, record the canonical args-hash on every challenge
      // AND every execution so the log provably pairs them, plus the token
      // verdict on confirmed attempts.
      ...(tokenEnabled && gatedIfUnconfirmed
        ? { argsHash: canonicalArgsHash(targetArgs) }
        : {}),
      ...(tokenStatus ? { confirmToken: tokenStatus } : {}),
      enforce,
    });
    if (!logged) {
      return {
        ...this.jsonToolResult({
          error: "audit_unavailable",
          tool: toolName,
          reason:
            "The safety decision log is enabled but unwritable; dispatch denied (fail-closed audit). Fix the decision_log path or disk and retry.",
        }),
        isError: true,
      };
    }

    if (decision.action === "warn") {
      this.logger.warn({
        event: decision.safetyClass === "UNCLASSIFIED" ? "safety.unclassified" : "safety.would_block",
        tool: toolName,
        path: opts.path,
        safetyClass: decision.safetyClass,
        source: decision.source,
        msg:
          decision.safetyClass === "UNCLASSIFIED"
            ? "unclassified tool call — no manifest entry and no write-verb match; proceeding with telemetry"
            : "advisory: unconfirmed write-class tool call — would block in blocking mode",
      });
      // Warn = proceed + log. Fall through to dispatch.
    } else if (decision.action === "block") {
      this.metrics.inc(COUNTERS.denies); // GW-1: Tier-A confirmation-required block
      // Redact argument values: keep keys, replace values with type tags.
      const redacted: Record<string, string> = {};
      for (const [k, v] of Object.entries(targetArgs)) {
        if (v === null) redacted[k] = "<null>";
        else if (Array.isArray(v)) redacted[k] = "<array>";
        else redacted[k] = `<${typeof v}>`;
      }
      return this.jsonToolResult({
        confirmationRequired: true,
        tool: toolName,
        safetyClass: decision.safetyClass,
        source: decision.source,
        reason: `This tool is classified ${decision.safetyClass} and requires confirmation to authorize the call.`,
        // The contract was previously undocumented at every surface a caller
        // reads; models either dropped the token or reworded the arguments,
        // and an args-bound token can never validate reworded arguments.
        nextStep: tokenEnabled
          ? "Re-call gateway_call_tool with the SAME tool and BYTE-IDENTICAL arguments, plus top-level confirmed:true and this confirmToken. Any argument change invalidates the token. It expires 10 minutes after issue."
          : "Re-call gateway_call_tool with the SAME tool and arguments, plus top-level confirmed:true.",
        redactedArguments: redacted,
        // Phase 4 audit nonce: the confirmed re-call must present this token
        // with UNCHANGED arguments. Audit integrity only — it proves the
        // challenge round-trip happened and covered these exact args; it does
        // not (and cannot) stop an autonomous caller from confirming.
        ...(tokenEnabled
          ? { confirmToken: this.confirmTokens.issue(toolName, targetArgs) }
          : {}),
      });
    }

    // ── Content-inspection stage (outbound args) ──────────────────────────────
    // Runs AFTER the write-guard decision above resolves to "proceed" — i.e.
    // for READ/other ungated tools always, and for gated tools only once
    // confirmed:true or advisory mode let the dispatch through. This is
    // deliberately independent of confirmation: a confirmed:true HUMAN_OUTBOUND
    // call is still blocked here if its arguments carry a PCI-shaped value —
    // confirming a WRITE authorizes the write, not exfiltration of payment-card
    // data through it. Blocked calls return an error result and NEVER reach
    // callBackendTool.
    const cgBlock = this.applyContentGuardStage(toolName, safety, targetArgs);
    if (cgBlock) {
      this.metrics.inc(COUNTERS.denies); // GW-1: content-guard block (Tier-A path)
      return cgBlock;
    }

    const tierAResult = await this.callBackendTool(toolName, targetArgs, opts.maxOutputChars);
    return tierAResult;
  }

  /**
   * SC-4 Tier-B dispatch path (PRODUCTION / VAULT_VALUE / HUMAN_OUTBOUND /
   * write_guard-flagged capabilities). Separate from the Tier-A decideGate
   * flow above by design: confirmed:true from the model is never consulted
   * here. Authorization comes from ONLY two sources, neither reachable by the
   * model itself:
   *   - a pre-existing StandingGrant (identity × backend × tool), or
   *   - a fresh human approval via the loopback /approve endpoint or the
   *     `thesun approve` CLI, which is checked on the NEXT dispatch attempt
   *     (this call still parks — approving does not retroactively execute
   *     the in-flight request, there is no persistent connection to resume).
   *
   * The content-inspection stage still runs identically to the Tier-A path
   * (shared via applyContentGuardStage) once a grant authorizes dispatch.
   */
  private async dispatchTierB(
    toolName: string,
    targetArgs: Record<string, unknown>,
    entry: ToolEntry,
    safety: SafetyClassification,
    opts: {
      path: "mux" | "direct";
      confirmed: boolean;
      confirmToken?: string;
      identity?: Identity;
      session?: DispatchSessionContext;
      clientName?: string;
      maxOutputChars?: number;
    }
  ): Promise<{ content: any[]; isError?: boolean }> {
    const backend = entry.backendName;
    const identity = this.resolveApprovalIdentity(opts.identity, opts.clientName);
    // SEC-2 TOCTOU fix: resolve AND consume in one atomic step at
    // authorization time, BEFORE the backend tool call. A one-time grant is
    // spliced out and persisted before it is returned, so two concurrent
    // Tier-B dispatches can no longer both ride the same single approval (the
    // second sees the grant already gone and re-parks). Standing / wildcard
    // grants are returned without consumption. Replaces the old findGrant +
    // (post-backend) consumeIfOneTime two-step, which had an await gap.
    // UX-1: pass this call's safetyClass so a class-scoped grant (identity ×
    // backend × safetyClass, created via /trust with a safetyClass) authorizes
    // matching-class Tier-B calls; precedence stays exact > class > wildcard.
    const grant = this.approvalStore.findAndConsume(identity, backend, toolName, safety.safetyClass);

    const logged = this.logSafetyDecision({
      ts: new Date().toISOString(),
      path: opts.path,
      user: opts.identity?.upn ?? opts.identity?.oid ?? null,
      tool: toolName,
      backend,
      safetyClass: safety.safetyClass,
      source: safety.source,
      ...(safety.writeGuard ? { writeGuard: safety.writeGuard } : {}),
      decision: grant ? "proceed" : "parked",
      tierB: true,
      // Visible in the audit trail even though it has no bearing on the
      // decision: if an agent set confirmed:true on a Tier-B call, that is
      // worth knowing about (a confused/injected agent believing self-confirm
      // would work here), but it never authorizes anything on this path.
      agentConfirmedIgnored: opts.confirmed === true,
      enforce: this.config.safety.enforce,
    });
    if (!logged) {
      return {
        ...this.jsonToolResult({
          error: "audit_unavailable",
          tool: toolName,
          reason:
            "The safety decision log is enabled but unwritable; dispatch denied (fail-closed audit). Fix the decision_log path or disk and retry.",
        }),
        isError: true,
      };
    }

    if (!grant) {
      // New-park detection BEFORE createPending: the store dedups parks (a
      // repeat dispatch of an already-parked identity+backend+tool reuses the
      // existing record), and the OS notification must fire ONLY for an
      // actually-new park — never once per retry of the same parked call.
      const alreadyParked = this.approvalStore
        .listPending()
        .some((a) => a.identity === identity && a.backend === backend && a.tool === toolName);
      // GW-1: count only DISTINCT parked approvals (a retry of an
      // already-parked call reuses the record and must not double-count).
      if (!alreadyParked) this.metrics.inc(COUNTERS.approvalsParked);
      const pending = this.approvalStore.createPending({
        identity,
        backend,
        tool: toolName,
        argsSummary: summarizeArgs(targetArgs),
        safetyClass: safety.safetyClass,
      });
      // Refresh the RAM-only redacted preview on every park (latest args are
      // what a grant would authorize next); never persisted (see field doc).
      this.approvalArgPreviews.set(pending.id, this.redactArgsForPreview(targetArgs));
      if (!alreadyParked && this.config.safety.notifications) {
        // Best-effort by contract: notifyPark never throws, never blocks,
        // and carries NO argument values (value-free notification pipeline).
        notifyPark({
          backend,
          tool: toolName,
          safetyClass: safety.safetyClass,
          approveUrl: `http://127.0.0.1:${this.config.gateway.port}/approve`,
        });
      }
      this.logger.warn({
        event: "tierb.parked",
        tool: toolName,
        backend,
        id: pending.id,
        safetyClass: safety.safetyClass,
        msg: "Tier-B call parked pending out-of-band human approval — the calling agent cannot authorize this itself",
      });
      // The parked response is built BEFORE the elicitation attempt and is
      // returned verbatim on every non-accept outcome — the park record above
      // is the source of truth and the universal fallback (roadmap §2.2).
      const parkedResponse = this.jsonToolResult({
        approvalPending: true,
        id: pending.id,
        tool: toolName,
        backend,
        safetyClass: safety.safetyClass,
        reason: `This tool is classified ${safety.safetyClass} and requires out-of-band human approval — a model-supplied confirmed:true is not accepted for this safety class.`,
        summary: describeApproval(pending),
        expiresAt: pending.expiresAt,
        approveWith: `thesun approve ${pending.id}`,
        approveUrl: `http://127.0.0.1:${this.config.gateway.port}/approve`,
        note: allowsStandingGrant(safety.safetyClass)
          ? "Ask the human operator to run `thesun approve` (optionally with --always for a standing grant) or open the approve URL in a browser. This call has NOT been forwarded to the backend."
          : `Ask the human operator to run \`thesun approve\` or open the approve URL in a browser. ${safety.safetyClass} cannot hold standing authority: --always is downgraded to one-time, so every call of this tool needs its own approval. This call has NOT been forwarded to the backend.`,
      });

      // ── Phase 3: capability-gated elicitation upgrade (SECURITY-ROADMAP
      // §2.2). Opt-in (approvals.elicitation = "on"), and only for sessions
      // whose client declared the `elicitation` capability and is not
      // blocklisted. SECURITY INVARIANT: the elicitation response is produced
      // by the CLIENT'S UI from direct human input — it is a client-UI
      // channel that never travels through the model, so the Tier-B
      // constraint ("nothing that authorizes may travel through the model")
      // holds. Every failure path — capability absent, config off,
      // blocklisted client, decline, timeout, transport error — degrades to
      // the already-created park (fail-closed to the park, never past it).
      const elicited = await this.tryElicitApproval(pending, opts.session);
      if (elicited) {
        const approved = this.approvalStore.approve(pending.id, { standing: elicited.standing });
        if (approved) {
          // Second decision-log line for this dispatch: the park was already
          // logged above; this records that a human approved via elicitation
          // and the SAME in-flight call proceeded. Fail-closed like every
          // other decision write: no audit record, no dispatch.
          const approvalLogged = this.logSafetyDecision({
            ts: new Date().toISOString(),
            path: opts.path,
            user: opts.identity?.upn ?? opts.identity?.oid ?? null,
            tool: toolName,
            backend,
            safetyClass: safety.safetyClass,
            source: safety.source,
            ...(safety.writeGuard ? { writeGuard: safety.writeGuard } : {}),
            decision: "proceed",
            tierB: true,
            elicitation: true,
            approvalId: approved.approval.id,
            standing: elicited.standing,
            enforce: this.config.safety.enforce,
          });
          if (!approvalLogged) return parkedResponse;
          this.logger.info({
            event: "tierb.elicitation_approved",
            tool: toolName,
            backend,
            id: approved.approval.id,
            standing: elicited.standing,
            msg: "Tier-B call approved by a human via in-editor elicitation — continuing the in-flight dispatch",
          });
          // Continue the STILL-OPEN dispatch inline — unlike the CLI path,
          // the request is in flight, so no agent retry is needed.
          return this.proceedWithGrant(toolName, targetArgs, safety, approved.grant, opts);
        }
        // Pending vanished between park and approve (expired/actioned
        // elsewhere) — degrade to the park; the agent retries as usual.
      }
      return parkedResponse;
    }

    this.logger.info({
      event: "tierb.grant_used",
      tool: toolName,
      backend,
      identity,
      oneTime: Boolean(grant.oneTime),
      msg: "Tier-B call proceeded via a standing grant",
    });

    return this.proceedWithGrant(toolName, targetArgs, safety, grant, opts);
  }

  /**
   * Shared Tier-B grant-authorized dispatch tail — used by BOTH the
   * pre-existing-grant path and the Phase 3 elicitation-accept path so the
   * two cannot drift. Behavior is byte-identical to what dispatchTierB
   * inlined before the Phase 3 refactor.
   */
  private async proceedWithGrant(
    toolName: string,
    targetArgs: Record<string, unknown>,
    safety: SafetyClassification,
    grant: StandingGrant,
    opts: { maxOutputChars?: number }
  ): Promise<{ content: any[]; isError?: boolean }> {
    // Mirrors the Tier-A confirmationMapsToDownstream behavior, but the
    // signal that authorizes it is the grant, never the model's own
    // confirmed:true (see the isTierBClass exclusion in handleMuxTool).
    const dispatchArgs = { ...targetArgs };
    if (safety.confirmationMapsToDownstream === true) {
      dispatchArgs.confirmed = true;
    }

    // One-time approvals authorize exactly one dispatch; consume it now so a
    // second attempt re-parks rather than silently reusing the same approval.
    // The pre-existing-grant path already consumed atomically via
    // findAndConsume (SEC-2), so this is an idempotent no-op there; it still
    // does the real consumption for the elicitation-accept path, whose grant
    // is freshly minted by approve() just above and not yet consumed.
    this.approvalStore.consumeIfOneTime(grant.id);

    const cgBlock = this.applyContentGuardStage(toolName, safety, dispatchArgs);
    if (cgBlock) {
      this.metrics.inc(COUNTERS.denies); // GW-1: content-guard block (Tier-B path)
      return cgBlock;
    }

    const tierBResult = await this.callBackendTool(toolName, dispatchArgs, opts.maxOutputChars);
    return tierBResult;
  }

  /**
   * Phase 3 (SECURITY-ROADMAP §2.2): attempt an in-editor elicitation for a
   * just-parked Tier-B call. Returns `{ standing }` ONLY when a human
   * explicitly accepted the dialog with approve=true; returns undefined on
   * every other outcome (config off, no session handle, capability absent,
   * blocklisted client, decline, cancel, timeout, malformed content, or any
   * transport error). The caller degrades undefined to the parked response —
   * elicitation can only ever upgrade the UX, never weaken the park.
   *
   * SECURITY INVARIANT (do not weaken): the ElicitResult consumed here comes
   * from the client's UI layer answering `elicitation/create` — a
   * server→client→HUMAN channel. It is never model output. The dialog message
   * is describeApproval(pending), a type-tagged summary that carries argument
   * TYPE TAGS only, never raw argument values.
   */
  private async tryElicitApproval(
    pending: PendingApproval,
    session?: DispatchSessionContext
  ): Promise<{ standing: boolean } | undefined> {
    const approvalsCfg = this.config.approvals;
    if (approvalsCfg?.elicitation !== "on") return undefined;
    if (!session) return undefined;

    // Capability + clientInfo: prefer the record captured at initialize
    // (sessionMeta, stateful sessions); fall back to the live server
    // accessors (covers any session initialized before this gateway build).
    // Stateless per-request servers never saw an initialize, so both sources
    // are undefined → park.
    const meta: SessionClientMeta =
      (session.sessionId ? this.sessionMeta.get(session.sessionId) : undefined) ?? {
        capabilities: session.server.server.getClientCapabilities(),
        clientInfo: session.server.server.getClientVersion(),
      };
    if (!meta.capabilities?.elicitation) return undefined;

    const clientName = meta.clientInfo?.name;
    const blocklist = approvalsCfg?.elicitation_blocklist ?? [];
    if (clientName && blocklist.includes(clientName)) {
      this.logger.info({
        event: "tierb.elicitation_blocklisted",
        client: clientName,
        id: pending.id,
        msg: "Client is on approvals.elicitation_blocklist — parking without elicitation",
      });
      return undefined;
    }

    const timeoutMs = approvalsCfg?.elicitation_timeout_ms ?? 120_000;
    try {
      // Sent via the request-handler's sendRequest so the elicitation rides
      // the SAME stream as the still-open tool call (relatedRequestId) —
      // deterministic delivery without depending on a standalone GET stream.
      const raw = await session.sendRequest(
        {
          method: "elicitation/create",
          params: {
            // Type-tagged, value-free summary (approvals.ts) — raw argument
            // values must NEVER appear in the dialog.
            message: `Tier-B approval requested: ${describeApproval(pending)}`,
            requestedSchema: {
              type: "object",
              properties: {
                approve: {
                  type: "boolean",
                  description: "Approve this call? (false or dismiss = keep it parked)",
                },
                standing: {
                  type: "boolean",
                  description: "Also create a standing grant for this identity+backend+tool (persists until revoked)",
                },
              },
              required: ["approve"],
            },
          },
        },
        ElicitResultSchema,
        { timeout: timeoutMs }
      );
      const result = ElicitResultSchema.parse(raw);
      if (result.action !== "accept") {
        this.logger.info({
          event: "tierb.elicitation_declined",
          id: pending.id,
          action: result.action,
          msg: "Elicitation not accepted — call remains parked",
        });
        return undefined;
      }
      if (result.content?.approve !== true) return undefined;
      return { standing: result.content?.standing === true };
    } catch (err) {
      // Timeout, unsupported client behavior, transport failure, schema
      // mismatch — all degrade to the park. Never let an elicitation error
      // surface as a dispatch error.
      this.logger.warn({
        event: "tierb.elicitation_failed",
        id: pending.id,
        error: err instanceof Error ? err.message : String(err),
        msg: "Elicitation attempt failed — call remains parked (fail-closed to the park)",
      });
      return undefined;
    }
  }

  /**
   * Resolve the identity used for Tier-B grant matching: Entra oid when
   * authenticated, else a stable per-install identity. Under
   * approvals.identity_scope = "install+client" the connecting MCP client's
   * clientInfo.name is appended (see composeGrantIdentity), so grants issued
   * while client A was connected never authorize client B. Falls back to
   * install scope when the client name is unobservable (stateless streamable
   * HTTP has no per-call client identity).
   */
  private resolveApprovalIdentity(identity?: Identity, clientName?: string): string {
    const base = identity?.oid ?? this.approvalStore.getInstallIdentity();
    const scope = this.config.approvals?.identity_scope ?? "install";
    return composeGrantIdentity(base, scope, clientName);
  }

  /** Cap on a single in-memory arg preview (chars) — bounds RAM, previews are for human eyes. */
  private static readonly ARG_PREVIEW_MAX_CHARS = 4_000;

  /**
   * Phase 2 (G5): content-guard-redacted ACTUAL argument values for the
   * in-memory approve-page preview. Reuses the same redaction pipeline
   * applied to every tool result (secrets/Luhn/SSN patterns per config), so
   * anything the guard would strip from a response is stripped here too.
   * The result goes ONLY into approvalArgPreviews (RAM) — never to disk.
   */
  private redactArgsForPreview(args: Record<string, unknown>): string {
    try {
      const raw = JSON.stringify(args) ?? "{}";
      const { text } = applyResultRedaction(raw, this.contentGuardConfig(), this.logger);
      return text.length > Gateway.ARG_PREVIEW_MAX_CHARS
        ? `${text.slice(0, Gateway.ARG_PREVIEW_MAX_CHARS)}… [truncated]`
        : text;
    } catch {
      // A preview is a nicety; a serialization failure must never affect the
      // park. Fall back to "no preview" (the value-free summary still shows).
      return "";
    }
  }

  /**
   * Drop preview entries whose pending approval no longer exists (expired or
   * actioned through a path that didn't evict inline). Called on every
   * /approve listing so the RAM map tracks the store's expiry behavior.
   */
  private pruneArgPreviews(pending: import("./approvals.js").PendingApproval[]): void {
    const live = new Set(pending.map((p) => p.id));
    for (const id of this.approvalArgPreviews.keys()) {
      if (!live.has(id)) this.approvalArgPreviews.delete(id);
    }
  }

  /**
   * Shared content-inspection stage for BOTH the Tier-A path (dispatchToolCall)
   * and the Tier-B path (dispatchTierB) — extracted so the two dispatch paths
   * cannot drift. Behavior is byte-identical to what dispatchToolCall inlined
   * before this refactor: HUMAN_OUTBOUND arg scanning + sql/exec-tagged arg
   * scanning, blocking result returned on a hit, undefined when clear.
   */
  private applyContentGuardStage(
    toolName: string,
    safety: SafetyClassification | undefined,
    targetArgs: Record<string, unknown>
  ): { content: any[]; isError?: boolean } | undefined {
    const cgCfg = this.contentGuardConfig();
    if (safety?.safetyClass === "HUMAN_OUTBOUND") {
      const argCheck = checkHumanOutboundArgs(targetArgs, cgCfg, this.logger);
      if (argCheck.blocked) {
        this.logger.warn({
          event: "content_guard.blocked_args",
          tool: toolName,
          kind: argCheck.kind,
          msg: argCheck.detail,
        });
        return {
          ...this.jsonToolResult({
            error: "content_guard_blocked",
            tool: toolName,
            kind: argCheck.kind,
            reason: argCheck.detail,
            note: "The gateway's content-inspection stage blocked this call because its arguments appear to contain payment-card or PII data. Remove the sensitive value and retry.",
          }),
          isError: true,
        };
      }
    }
    if (safety?.tags?.some((t) => t === "sql" || t === "exec")) {
      const sqlCheck = checkSqlDestructiveArgs(targetArgs, cgCfg, this.logger);
      if (sqlCheck.blocked) {
        this.logger.warn({
          event: "content_guard.blocked_args",
          tool: toolName,
          kind: sqlCheck.kind,
          msg: sqlCheck.detail,
        });
        return {
          ...this.jsonToolResult({
            error: "content_guard_blocked",
            tool: toolName,
            kind: sqlCheck.kind,
            reason: sqlCheck.detail,
            note: "The gateway's content-inspection stage blocked this call because its arguments contain a destructive SQL statement.",
          }),
          isError: true,
        };
      }
    }
    return undefined;
  }

  /** Resolve the content-guard rule-pack config for this dispatch (config.content_guard → ContentGuardConfig). */
  private contentGuardConfig(): ContentGuardConfig {
    // Defensive: hand-built Config fixtures (some unit tests construct a
    // Config literal directly rather than going through loadConfig()'s zod
    // parse) may not carry content_guard. Missing means "schema defaults" —
    // secrets+luhn on, ssn+sql off — not a crash. Mirrors the same defensive
    // pattern compressToolText() uses for config.compression.
    const cfg = this.config.content_guard ?? {
      secrets: { enabled: true },
      luhn: { enabled: true },
      ssn: { enabled: false },
      sql_destructive: { enabled: false },
      entropy: { enabled: false },
      max_scan_chars: 1_000_000,
    };
    return {
      secrets: cfg.secrets.enabled,
      luhn: cfg.luhn.enabled,
      ssn: cfg.ssn.enabled,
      sqlDestructive: cfg.sql_destructive.enabled,
      entropy: cfg.entropy?.enabled ?? false,
      maxScanChars: cfg.max_scan_chars,
    };
  }

  /**
   * C3: append one JSONL line to the configured safety decision log.
   * Default-ON (safety.decision_log.enabled = true) and FAIL-CLOSED
   * (2026-06-10): returns false on any write error, and dispatchToolCall
   * denies the dispatch — an unauditable gateway does not execute tools.
   * Returns true when the line was written, or when logging is explicitly
   * disabled (operator opt-out).
   */
  private logSafetyDecision(line: Record<string, unknown>): boolean {
    const cfg = this.config.safety.decision_log;
    if (!cfg?.enabled) return true;
    try {
      let logPath = cfg.path;
      if (logPath.startsWith("~")) {
        logPath = join(homedir(), logPath.slice(1));
      }
      if (!this.decisionLogDirReady) {
        mkdirSync(dirname(logPath), { recursive: true });
        this.decisionLogDirReady = true;
      }
      const record = `${JSON.stringify(line)}\n`;
      const recordBytes = Buffer.byteLength(record);
      // OPS-4: rotation reads a CACHED size (see rotateDecisionLogIfNeeded), so
      // the common path does zero existsSync/statSync syscalls. The append below
      // stays synchronous on purpose: the fail-closed contract needs the write
      // to be durably attempted (and any failure surfaced) BEFORE the caller
      // proceeds to dispatch. Returning false here is what denies the dispatch.
      this.rotateDecisionLogIfNeeded(logPath, cfg.max_size_mb, cfg.max_files);
      appendFileSync(logPath, record);
      if (this.decisionLogSizeBytes !== null) {
        this.decisionLogSizeBytes += recordBytes;
      }
      return true;
    } catch (err) {
      if (!this.decisionLogErrorLogged) {
        this.logger.error(
          `Safety decision log write failed — denying dispatches until writable (fail-closed audit): ${err instanceof Error ? err.message : String(err)}`
        );
        this.decisionLogErrorLogged = true;
      }
      return false;
    }
  }

  /**
   * Size-based rotation for the decision log (2026-07 hardening): the
   * fail-closed audit trail must never be able to fill the disk and DoS the
   * gateway. When the active file crosses max_size_mb, shift the rotation
   * chain (path.N-1 -> path.N, ... -> path.1) and start a fresh active file.
   * Copies beyond max_files are deleted. Runs BEFORE the append that
   * triggered it, so the file that gets rotated out never exceeds the
   * configured cap by more than one line.
   *
   * Best-effort: any error here is swallowed (logged once) rather than
   * propagated — a rotation failure must not turn into a fail-closed audit
   * denial for an otherwise-healthy log file. The append that follows will
   * still surface its own errors via the normal fail-closed path.
   *
   * OPS-4: the size is read from an in-memory counter (this.decisionLogSizeBytes)
   * that logSafetyDecision keeps current, NOT from a statSync on every call.
   * The counter is seeded from disk once (lazily) and re-synced every
   * DECISION_LOG_RESTAT_EVERY writes so any external truncation/rotation drift
   * self-heals within a bounded window. This removes the per-dispatch
   * existsSync+statSync that blocked the event loop under load, while keeping
   * the same rotation semantics (rotate once the active file has reached the
   * cap, so it overshoots by at most one line).
   */
  private rotateDecisionLogIfNeeded(logPath: string, maxSizeMb: number, maxFiles: number): void {
    try {
      // Periodic re-stat: force a fresh disk read so a long-lived process cannot
      // drift indefinitely from the true on-disk size.
      if (this.decisionLogWritesSinceStat >= Gateway.DECISION_LOG_RESTAT_EVERY) {
        this.decisionLogSizeBytes = null;
      }
      // Lazy seed / re-sync from disk (one stat, not one-per-write).
      if (this.decisionLogSizeBytes === null) {
        this.decisionLogSizeBytes = existsSync(logPath) ? statSync(logPath).size : 0;
        this.decisionLogWritesSinceStat = 0;
      }
      this.decisionLogWritesSinceStat++;

      if (this.decisionLogSizeBytes < maxSizeMb * 1024 * 1024) return;

      // Delete the oldest rotated copy if it would overflow max_files.
      const oldest = `${logPath}.${maxFiles}`;
      if (existsSync(oldest)) unlinkSync(oldest);

      // Shift path.(N-1) -> path.N, ..., path.1 -> path.2.
      for (let i = maxFiles - 1; i >= 1; i--) {
        const src = `${logPath}.${i}`;
        const dst = `${logPath}.${i + 1}`;
        if (existsSync(src)) renameSync(src, dst);
      }
      renameSync(logPath, `${logPath}.1`);
      // Fresh active file: reset the cached size so the next append counts from 0.
      this.decisionLogSizeBytes = 0;
    } catch (err) {
      // Force a re-stat next time so a failed rotation cannot leave the counter
      // wedged at a stale value.
      this.decisionLogSizeBytes = null;
      this.logger.warn(
        `Decision log rotation failed (continuing without rotation): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private async callBackendTool(
    toolName: string,
    args: Record<string, unknown>,
    maxOutputChars = DEFAULT_MUX_RESPONSE_CHAR_LIMIT
  ): Promise<{ content: any[]; isError?: boolean }> {
    const entry = this.toolRegistry.resolve(toolName);
    if (!entry) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Unknown tool: ${toolName}. Use tools/list or ${MUX_TOOL_NAMES.searchTools} to see available tools.`,
          },
        ],
        isError: true,
      };
    }

    const backend = this.backends.get(entry.backendName);
    if (!backend || backend.status !== "connected") {
      return {
        content: [
          {
            type: "text" as const,
            text: `Backend "${entry.backendName}" is not connected (status: ${backend?.status ?? "unknown"}).`,
          },
        ],
        isError: true,
      };
    }

    try {
      const result = await backend.callTool(entry.originalName, args);
      return this.compactBackendToolResult(result, maxOutputChars);
    } catch (err) {
      if (this.isStaleSessionError(err)) {
        this.logger.warn(
          `Backend "${entry.backendName}" returned stale-session error on ${entry.originalName}, auto-reconnecting and retrying once...`
        );
        try {
          await this.ensureReconnected(entry.backendName);
          const result = await backend.callTool(entry.originalName, args);
          return this.compactBackendToolResult(result, maxOutputChars);
        } catch (retryErr) {
          this.logger.error(
            `Backend "${entry.backendName}" retry after auto-reconnect failed: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`
          );
          // Surface the RETRY error, not the healed stale-session error
          // (invariant I5b: retryErr text surfaced, not /session not found/i).
          return {
            content: [
              {
                type: "text" as const,
                text: `Error calling ${entry.originalName} on backend "${entry.backendName}" after auto-reconnect retry: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
              },
            ],
            isError: true,
          };
        }
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `Error calling ${entry.originalName} on backend "${entry.backendName}": ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }

  // Detect transport-layer stale-session errors that a reconnect can heal.
  // Two shapes surface after a streamable-http backend is bounced and the
  // gateway's cached mcp-session-id is invalidated:
  //   1. JSON-RPC -32001 "Session not found" (transport-level code) — fast-path.
  //   2. JSON-RPC -32000 "Bad Request: No valid session ID provided" — the
  //      backend rejects the next forwarded call with a generic server-error
  //      code but a stale-session message.
  // The matcher is MESSAGE-GATED for the -32000 case: -32000 is the generic
  // "server error" code, so matching it alone would misclassify unrelated
  // application failures as stale sessions. We only treat it as stale when the
  // message names a missing/invalid session. The textual regex covers both the
  // "session not found" and "no valid session" variants and is robust to where
  // the SDK puts the text — McpError stringifies as
  // "MCP error <code>: <message>", so err.message carries the original text.
  private isStaleSessionError(err: unknown): boolean {
    if (!err || typeof err !== "object") return false;
    const code = (err as { code?: unknown }).code;
    // Fast-path: transport-level "Session not found" code.
    if (code === -32001) return true;
    const message = (err as { message?: unknown }).message;
    // Message-gated: covers -32000 "No valid session ID" and the textual
    // "Session not found" variant regardless of code, but never matches a bare
    // -32000 whose message is unrelated (e.g. "internal error").
    if (typeof message === "string" && /(session not found|no valid session)/i.test(message)) return true;
    return false;
  }

  // Dedup wrapper around reconnectBackend: if a reconnect for this backend is
  // already in flight, await it instead of starting a new one. Prevents
  // thundering-herd reconnects when N concurrent calls all hit -32001 from the
  // same dead session. Returns the registered tool count after reconnect.
  private async ensureReconnected(backendName: string): Promise<number> {
    const existing = this.reconnectInflight.get(backendName);
    if (existing) return existing;
    const inflight = (async () => {
      try {
        return await this.reconnectBackend(backendName);
      } finally {
        this.reconnectInflight.delete(backendName);
      }
    })();
    this.reconnectInflight.set(backendName, inflight);
    return inflight;
  }

  // Restart one backend (drop transport session, reinitialize), re-register
  // its tools, and notify clients. Throws if the backend is unknown or the
  // restart fails — callers handle surfacing.
  private async reconnectBackend(backendName: string): Promise<number> {
    const backend = this.backends.get(backendName);
    if (!backend) {
      throw new Error(`Backend "${backendName}" not found`);
    }
    // STAB-3: bound the reconnect exactly as connectBackend bounds the initial
    // connect. backend.restart() awaits client.connect() then client.listTools(),
    // neither of which self-times-out, so against a hung endpoint (a filtered
    // port, a half-open socket) this await never settles. That mattered on three
    // paths: the health sweep (one hung backend stalled the whole sweep), the
    // gateway_reconnect_backend tool, and the dead-session recovery inside
    // dispatch, where it could hang a live tool call indefinitely.
    const timeoutMs = backend.config.connect_timeout_ms;
    try {
      await this.withTimeout(
        backend.restart(),
        timeoutMs,
        `Backend "${backendName}" reconnect timed out after ${timeoutMs}ms`
      );
    } catch (err) {
      // withTimeout races, it does not cancel. Without this the losing
      // connect() is still pending and the backend is stranded in "starting",
      // which isRetryEligible excludes, so the health monitor stops considering
      // it until the underlying request finally errors on its own. disconnect()
      // aborts the transport and lands the backend on "disconnected", where the
      // next sweep will pick it up. Mirrors what connectBackend already does on
      // its own timeout.
      await backend.disconnect().catch(() => {
        /* teardown failure must not mask the original timeout */
      });
      throw err;
    }
    const visible = this.visibleTools(backend.config, backend.tools);
    this.toolRegistry.registerBackend(
      backendName,
      backend.config.namespace,
      visible
    );
    this.notifyToolsChanged();
    return visible.length;
  }

  private compactBackendToolResult(result: unknown, maxOutputChars: number): { content: any[]; isError?: boolean } {
    const record = result && typeof result === "object" ? result as Record<string, unknown> : {};
    const content = Array.isArray(record.content) ? record.content : [];
    let remaining = maxOutputChars;
    let truncated = false;
    // Collect compression markers to prepend once, even if multiple text items compressed.
    const compressionMarkers: Record<string, unknown>[] = [];

    const compactContent = content.map((item) => {
      if (!item || typeof item !== "object") return item;
      const entry = item as Record<string, unknown>;
      if (entry.type === "text" && typeof entry.text === "string") {
        if (remaining <= 0) {
          truncated = true;
          return { ...entry, text: "[mcp-gateway truncated additional text content]" };
        }

        // Content-inspection stage (egress): redact secret-shaped and
        // PCI-shaped values from EVERY backend result — not just
        // HUMAN_OUTBOUND tools — before compression/truncation or the model
        // ever sees the raw text. This is the highest-value control: the
        // result path is a surface no client-side guard can sit on.
        const { text: guardedText, redactedKinds } = applyResultRedaction(
          entry.text,
          this.contentGuardConfig(),
          this.logger
        );
        if (redactedKinds.length > 0) {
          this.logger.warn({
            event: "content_guard.redacted_result",
            kinds: redactedKinds,
          });
        }

        // Phase 4: attempt compression BEFORE applying the char-cap.
        // compressToolText is a pure pass-through when compression.enabled=false.
        const { text: maybeCompressed, marker } = this.compressToolText(
          guardedText,
          "backend-tool-compressed"
        );
        const workingText = maybeCompressed;
        if (marker) compressionMarkers.push(marker);

        if (workingText.length > remaining) {
          truncated = true;
          // Store the working text (compressed if active, original if advisory/disabled).
          const artifactId = this.storeArtifact("backend-tool-text", workingText);
          const text = `${workingText.slice(0, remaining)}\n...[truncated ${workingText.length - remaining} chars by mcp-gateway; artifactId=${artifactId}; fetch next page with ${MUX_TOOL_NAMES.fetchArtifact}]`;
          remaining = 0;
          return { ...entry, text };
        }
        remaining -= workingText.length;
        return { ...entry, text: workingText };
      }

      const serialized = JSON.stringify(entry);
      if (serialized.length > Math.max(1_000, remaining)) {
        truncated = true;
        const artifactId = this.storeArtifact("backend-tool-json", serialized);
        remaining = 0;
        return {
          type: "text" as const,
          text: `[mcp-gateway stored oversized non-text content item as ${artifactId}: ${serialized.length} serialized chars; fetch a page with ${MUX_TOOL_NAMES.fetchArtifact}]`,
        };
      }
      remaining -= serialized.length;
      return entry;
    });

    if (truncated) {
      compactContent.unshift({
        type: "text" as const,
        text: `mcp-gateway compacted the backend response to stay under ${maxOutputChars} chars. Narrow the request, use ${MUX_TOOL_NAMES.describeTool} before calling schema-heavy tools, or fetch a referenced artifact page explicitly.`,
      });
    }

    // Phase 4: prepend compression marker(s) so the model sees compaction metadata.
    // Only present when compression.enabled=true and active mode engaged at least once.
    for (const marker of compressionMarkers) {
      compactContent.unshift({
        type: "text" as const,
        text: JSON.stringify(marker),
      });
    }

    return {
      content: compactContent,
      ...(record.isError === true ? { isError: true } : {}),
    };
  }

  private touchStreamableSession(sessionId: string): void {
    this.streamableSessionLastSeen.set(sessionId, Date.now());
  }

  private dropStreamableSession(sessionId: string): void {
    this.streamableTransports.delete(sessionId);
    this.streamableSessionLastSeen.delete(sessionId);
    this.sessions.delete(sessionId);
    this.sessionOwners.delete(sessionId);
    this.sessionMeta.delete(sessionId);
  }

  private async reapIdleStreamableSessions(now = Date.now()): Promise<void> {
    for (const [sessionId, lastSeen] of this.streamableSessionLastSeen) {
      if (now - lastSeen < STREAMABLE_SESSION_IDLE_TTL_MS) continue;
      const transport = this.streamableTransports.get(sessionId);
      const sessionServer = this.sessions.get(sessionId);
      this.logger.info(`Reaping idle streamable MCP session ${sessionId}`);
      this.dropStreamableSession(sessionId);
      try {
        await sessionServer?.close();
      } catch {
        // ignore cleanup failures
      }
      try {
        await transport?.close();
      } catch {
        // ignore cleanup failures
      }
    }
  }

  private notifyToolsChanged(): void {
    // Notify all connected SSE clients that tool list changed
    for (const [sessionId, sessionServer] of this.sessions) {
      try {
        sessionServer.server
          .notification({
            method: "notifications/tools/list_changed",
          })
          .catch(() => {});
      } catch {
        // ignore notification errors
      }
    }
  }

  /**
   * CTX-2: the client-visible subset of a backend's tools after applying its
   * per-backend tools_allow/tools_deny filter. Filtered-out tools are never
   * registered, so they never reach tools/list, gateway_search_tools, or
   * dispatch (an unregistered tool is denied fail-closed by callBackendTool).
   */
  private visibleTools(config: BackendConfig, tools: Tool[]): Tool[] {
    return applyToolVisibility(tools, config.tools_allow, config.tools_deny);
  }

  private async connectBackend(
    name: string,
    config: BackendConfig
  ): Promise<void> {
    const backend = new BackendInstance(name, config, this.logger, () => {
      // On reconnect, re-register tools (filtered to the visible subset).
      this.toolRegistry.registerBackend(
        name,
        config.namespace,
        this.visibleTools(config, backend.tools)
      );
      this.notifyToolsChanged();
    });

    this.backends.set(name, backend);

    try {
      await this.withTimeout(
        backend.connect(),
        config.connect_timeout_ms,
        `Backend "${name}" connection timed out after ${config.connect_timeout_ms}ms`
      );
      if (backend.status === "connected") {
        this.toolRegistry.registerBackend(
          name,
          config.namespace,
          this.visibleTools(config, backend.tools)
        );
      }
    } catch (err) {
      await backend.disconnect();
      this.logger.warn(
        `Backend "${name}" startup did not complete: ${err instanceof Error ? err.message : String(err)}`
      );
      this.logger.warn(
        `Backend "${name}" failed to start — will retry per restart policy`
      );
    }
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    });

    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private isFleetIngestedConfig(config: BackendConfig): boolean {
    return "source" in config && typeof config.source === "string" && config.source.startsWith("fleet-mcpu");
  }

  private getBackendUrl(config: BackendConfig): string | undefined {
    if (config.transport === "http" || config.transport === "sse") {
      return config.url;
    }
    return undefined;
  }

  private normalizeSearchText(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
  }

  private matchesSearch(haystack: string, query: string): boolean {
    if (!query) return true;
    const normalizedQuery = this.normalizeSearchText(query);
    if (!normalizedQuery) return true;
    const normalizedHaystack = this.normalizeSearchText(haystack);
    return normalizedQuery
      .split(" ")
      .every((term) => normalizedHaystack.includes(term));
  }

  private backendConfigChanged(current: BackendConfig, next: BackendConfig): boolean {
    return JSON.stringify(current) !== JSON.stringify(next);
  }

  private requireAdminAccess(
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    const configuredToken = process.env.MCP_GATEWAY_ADMIN_TOKEN;
    if (configuredToken) {
      const expected = `Bearer ${configuredToken}`;
      const provided = req.header("authorization") ?? "";
      if (this.timingSafeStringEqual(provided, expected)) {
        next();
        return;
      }
      res.status(401).json({ error: "Admin API authorization required" });
      return;
    }

    const remoteAddress = req.socket.remoteAddress ?? req.ip ?? "";
    if (this.isLoopbackAddress(remoteAddress)) {
      next();
      return;
    }

    res.status(403).json({
      error:
        "Admin API is restricted to loopback clients unless MCP_GATEWAY_ADMIN_TOKEN is set",
    });
  }

  /**
   * Constant-time string comparison via fixed-length sha256 digests —
   * timingSafeEqual alone throws on length mismatch, which itself leaks length.
   */
  private timingSafeStringEqual(a: string, b: string): boolean {
    const digestA = createHash("sha256").update(a).digest();
    const digestB = createHash("sha256").update(b).digest();
    return timingSafeEqual(digestA, digestB);
  }

  private isLoopbackAddress(address: string): boolean {
    return (
      address === "::1" ||
      address === "127.0.0.1" ||
      address === "::ffff:127.0.0.1" ||
      address.startsWith("127.")
    );
  }

  async reloadConfig(): Promise<void> {
    // Waits for ANY in-flight backend-set mutation, not just another reload:
    // the periodic fleet re-ingest shares this guard (STAB-9).
    if (this.mutationInFlight) {
      this.logger.warn(
        "Backend-set mutation already in progress; waiting for it before reloading"
      );
      return this.mutationInFlight;
    }

    const inflight = this.reloadConfigUnlocked().finally(() => {
      if (this.mutationInFlight === inflight) this.mutationInFlight = undefined;
    });
    this.mutationInFlight = inflight;
    return inflight;
  }

  /**
   * Periodic fleet re-ingest (STAB-9).
   *
   * The backend set was materialized ONCE at boot: `ingestFleetBackends` was
   * only ever called from start(), a config reload, or the admin endpoint. So a
   * server that fleetd started after the gateway booted stayed invisible until
   * an operator forced a reload, which is the structural reason the gateway and
   * fleetd drifted apart.
   *
   * SKIP, do not queue: if a mutation is already running, drop this tick
   * entirely. A re-ingest queued behind a reload would re-scan a set that was
   * just refreshed, for nothing. Missing one tick costs at most one interval.
   */
  private startFleetRefreshTimer(): void {
    const intervalMs = FLEET_REFRESH_INTERVAL_MS;
    this.fleetRefreshTimer = setInterval(() => {
      if (this.mutationInFlight) {
        this.logger.debug(
          "Fleet refresh tick skipped: a backend-set mutation is already in progress"
        );
        return;
      }
      const inflight = this.ingestFleetBackends()
        .then(() => undefined)
        .catch((err: unknown) => {
          // Never throw out of a timer: a failed inventory read is expected
          // (Docker down, socket gone) and must not take the gateway with it.
          this.logger.warn(
            `Fleet refresh failed: ${err instanceof Error ? err.message : String(err)}`
          );
        })
        .finally(() => {
          if (this.mutationInFlight === inflight) this.mutationInFlight = undefined;
        });
      this.mutationInFlight = inflight;
    }, intervalMs);
  }

  private async reloadConfigUnlocked(): Promise<void> {
    this.logger.info("Reloading configuration...");
    const newConfig = await loadConfig(this.configPath);
    const fleetAutoIngest =
      newConfig.fleet.enabled && newConfig.fleet.toolhive.auto_ingest;

    // OPS-3: hot-reload safety manifests so edited/added manifests take effect
    // without a gateway restart. Fail-safe (never throws): a bad manifest keeps
    // the prior good index. Done BEFORE (re-)connecting backends so freshly
    // connected/replaced backends classify against the reloaded manifests, and
    // followed by a re-registration pass below so already-connected backends
    // are reclassified too.
    this.manifests.reload();

    // Find backends to add, remove, or update
    const currentNames = new Set(this.backends.keys());
    const newNames = new Set(Object.keys(newConfig.backends));

    // Remove backends no longer in config
    for (const name of currentNames) {
      const backend = this.backends.get(name)!;
      const isFleetBackend = this.isFleetIngestedConfig(backend.config);
      if (!newNames.has(name) && (!isFleetBackend || !fleetAutoIngest)) {
        this.logger.info(`Removing backend "${name}"`);
        await backend.disconnect();
        this.toolRegistry.unregisterBackend(name);
        this.backends.delete(name);
      }
    }

    // Add or replace static backends
    for (const name of newNames) {
      const existing = this.backends.get(name);
      if (!existing) {
        this.logger.info(`Adding new backend "${name}"`);
        await this.connectBackend(name, newConfig.backends[name]);
        continue;
      }

      if (
        this.isFleetIngestedConfig(existing.config) ||
        this.backendConfigChanged(existing.config, newConfig.backends[name])
      ) {
        this.logger.info(`Replacing backend "${name}" from reloaded config`);
        await existing.disconnect();
        this.toolRegistry.unregisterBackend(name);
        this.backends.delete(name);
        await this.connectBackend(name, newConfig.backends[name]);
      }
    }

    this.config = newConfig;
    if (fleetAutoIngest) {
      await this.ingestFleetBackends();
    }

    // OPS-3: re-register every connected backend's tools so the reloaded
    // manifests reclassify EXISTING (unchanged) backends too — registerBackend
    // re-runs the safety classifier. Idempotent (clears + re-adds), and applies
    // the same CTX-2 visibility filter. Backends replaced/added above already
    // registered against the reloaded manifests; re-registering them is a
    // harmless no-op on the same tool set.
    for (const [name, backend] of this.backends) {
      if (backend.status === "connected") {
        this.toolRegistry.registerBackend(
          name,
          backend.config.namespace,
          this.visibleTools(backend.config, backend.tools)
        );
      }
    }

    this.notifyToolsChanged();
    // Re-emit the policy snapshot so the client hook tracks the reloaded
    // backend/manifest set (best-effort — never throws into the reload path).
    this.writePolicySnapshotBestEffort();
    this.logger.info("Configuration reloaded successfully");
  }

  /**
   * Ingest fleet backends from MCPU generated config.
   * Skips any backend already registered (static config takes precedence).
   * Returns the raw ingest result for admin/logging use.
   */
  private async ingestFleetBackends(): Promise<FleetIngestResult> {
    if (this.fleetIngestInFlight) {
      this.logger.warn("Fleet ingestion already in progress; waiting for existing ingestion");
      return this.fleetIngestInFlight;
    }

    this.fleetIngestInFlight = this.ingestFleetBackendsUnlocked().finally(() => {
      this.fleetIngestInFlight = undefined;
    });
    return this.fleetIngestInFlight;
  }

  /**
   * Remove fleet-ingested backends that have vanished from the inventory
   * (STAB-10). Opt-in via fleet.toolhive.prune_missing.
   *
   * Removal requires ALL of: the entry is fleet-ingested (never a static one,
   * the operator wrote those down); it is absent from the current inventory;
   * and it is not connected. Two guards make that safe against a transient
   * inventory failure:
   *
   *   1. Never prune on an EMPTY read. A Docker daemon that is down reads as
   *      "nothing exists", which would otherwise wipe the entire fleet in one
   *      tick. (An inventory read that THROWS never reaches here at all.)
   *   2. Require absence from PRUNE_ABSENCE_THRESHOLD consecutive reads, so a
   *      container restarting between two reads is not evicted.
   *
   * Every removal is logged with the name and the reason, and counted, so a
   * pruning storm is visible rather than inferred from backends going quiet.
   */
  private pruneVanishedBackends(present: Set<string>): void {
    if (!this.config.fleet.toolhive.prune_missing) return;

    // Guard 1: an empty inventory is indistinguishable from a broken reader.
    if (present.size === 0) {
      this.logger.warn(
        "Fleet prune skipped: inventory read returned zero entries (treating as a failed read, not as an empty fleet)"
      );
      return;
    }

    for (const [name, backend] of this.backends) {
      if (present.has(name)) {
        this.backendAbsenceCounts.delete(name);
        continue;
      }
      // Static backends are never pruned, however dead.
      if (!this.isFleetIngestedConfig(backend.config)) continue;
      // A connected backend is serving traffic; absence from the inventory is
      // an inventory problem, not a reason to drop a working route.
      if (backend.status === "connected") {
        this.backendAbsenceCounts.delete(name);
        continue;
      }

      const absences = (this.backendAbsenceCounts.get(name) ?? 0) + 1;
      // Guard 2: require consecutive absences before acting.
      if (absences < PRUNE_ABSENCE_THRESHOLD) {
        this.backendAbsenceCounts.set(name, absences);
        continue;
      }

      this.backendAbsenceCounts.delete(name);
      void backend.disconnect().catch(() => {
        /* teardown failure must not block removal */
      });
      this.backends.delete(name);
      this.toolRegistry.unregisterBackend(name);
      this.metrics.inc(COUNTERS.backendsPruned);
      this.logger.info(
        `Pruned backend "${name}": absent from the fleet inventory for ${PRUNE_ABSENCE_THRESHOLD} consecutive reads and not connected`
      );
    }
  }

  private async ingestFleetBackendsUnlocked(): Promise<FleetIngestResult> {
    const result = await loadFleetBackendsFromMcpuConfig(
      this.config.fleet.toolhive,
      this.logger
    );

    // STAB-10: reconcile removals against this read before adding/updating, so
    // a backend that vanished stops being retried instead of lingering forever.
    this.pruneVanishedBackends(new Set(Object.keys(result.backends)));

    // Deliverable 16: retain quarantined entries from the latest ingest so
    // gateway_backend_status can surface them.
    this.fleetQuarantined = result.quarantined;

    const connectEntries: Array<[string, BackendConfig]> = [];
    let unchanged = 0;
    let updated = 0;

    for (const [name, config] of Object.entries(result.backends)) {
      const existing = this.backends.get(name);
      if (!existing) {
        connectEntries.push([name, config]);
        continue;
      }

      if (!this.isFleetIngestedConfig(existing.config)) {
        result.skipped.push({
          name,
          reason: "static backend with same name takes precedence",
        });
        continue;
      }

      if (!this.backendConfigChanged(existing.config, config)) {
        unchanged++;
        continue;
      }

      this.logger.info(`Fleet ingestion: refreshing backend "${name}"`);
      await existing.disconnect();
      this.toolRegistry.unregisterBackend(name);
      this.backends.delete(name);
      updated++;
      connectEntries.push([name, config]);
    }

    const retainedMissing = Array.from(this.backends.entries()).filter(
      ([name, backend]) =>
        this.isFleetIngestedConfig(backend.config) && !(name in result.backends)
    );

    if (retainedMissing.length > 0) {
      this.logger.warn(
        `Fleet ingestion: retaining ${retainedMissing.length} existing fleet backend(s) missing from generated MCPU config`
      );
    }

    if (connectEntries.length === 0) {
      this.logger.info(
        `Fleet ingestion: no backend changes (${unchanged} unchanged)`
      );
      return result;
    }

    this.logger.info(
      `Fleet ingestion: connecting ${connectEntries.length} backend(s) (${updated} refreshed, ${unchanged} unchanged)`
    );
    await Promise.allSettled(
      connectEntries.map(([name, config]) => this.connectBackend(name, config))
    );

    const connected = connectEntries.filter(([name]) => {
      const b = this.backends.get(name);
      return b && b.status === "connected";
    }).length;

    this.logger.info(
      `Fleet ingestion: ${connected}/${connectEntries.length} changed backend(s) connected`
    );

    this.notifyToolsChanged();
    return result;
  }

  async start(): Promise<void> {
    this.logger.info(
      `Starting MCP Gateway "${this.config.gateway.name}" on ${this.config.gateway.host}:${this.config.gateway.port}`
    );

    // Hardened-shipping-defaults audit (2026-07): loosening any of these from
    // their safe-by-default value is a deliberate, visible operator choice —
    // log LOUDLY (error level, not a quiet info line) so it can't slip by
    // unnoticed in a config diff.
    this.logHardenedDefaultsAudit();

    // SEC-5 fail-closed bind guard: the loud audit above WARNS about a non-
    // loopback bind, but a warning alone still binds an unauthenticated tool-
    // plane on the network. Before touching the socket, refuse to start when
    // the resolved host is non-loopback AND no tool-plane auth is configured,
    // unless the operator has explicitly opted out via
    // gateway.allow_insecure_non_loopback. Thrown here (not process.exit) so it
    // rides the same start-failure path as index.ts main().catch → exit(1).
    const bindGuard = evaluateBindGuard({
      host: this.config.gateway.host,
      authMode: this.config.auth?.mode ?? "none",
      sharedSecret: this.config.auth?.shared_secret,
      allowInsecureNonLoopback: this.config.gateway.allow_insecure_non_loopback,
    });
    if (!bindGuard.allowed) {
      this.logger.fatal(
        { host: this.config.gateway.host, authMode: this.config.auth?.mode ?? "none" },
        `SEC-5 bind guard: ${bindGuard.reason}`
      );
      throw new Error(bindGuard.reason);
    }
    if (bindGuard.insecureOverride) {
      this.logger.warn(`SEC-5 bind guard OVERRIDDEN: ${bindGuard.reason}`);
    }

    // Bind the HTTP listener FIRST so the gateway is responsive immediately. A
    // slow or failing backend connect (a dead backend can take its full connect
    // timeout) must NEVER delay accepting requests — previously the listener was
    // bound LAST, after awaiting every backend connect, so a few dead backends
    // left the whole gateway unresponsive for minutes on cold start. Requests to
    // a backend that has not connected yet get an honest "not connected" error
    // until it comes up.
    await new Promise<void>((resolve, reject) => {
      this.httpServer = this.app.listen(this.config.gateway.port, this.config.gateway.host, () => {
        this.logger.info(
          `MCP Gateway listening on http://${this.config.gateway.host}:${this.config.gateway.port}`
        );
        this.logger.info(`  Streamable HTTP endpoint: /mcp`);
        this.logger.info(`  Liveness:     /healthz`);
        this.logger.info(`  Admin API:    /admin/status`);
        resolve();
      });
      // STAB-3 fix: a listen() failure (EADDRINUSE from a stale process, or an
      // unbindable host) emits 'error' on the server and never fires the
      // success callback. Without this handler the Promise never settled: the
      // error escaped to the process-level swallow, the process stayed alive
      // but never listening, and launchd/systemd KeepAlive never restarted it
      // (a silent hang). Reject the startup Promise AND exit non-zero so the
      // supervisor sees a crashed process and restarts it — fail loudly.
      this.httpServer.on("error", (err: Error) => {
        this.logger.fatal(
          { err, host: this.config.gateway.host, port: this.config.gateway.port },
          `MCP Gateway failed to bind ${this.config.gateway.host}:${this.config.gateway.port} — exiting so the supervisor can restart it`
        );
        reject(err);
        process.exit(1);
      });
    });

    // Connect all statically-configured backends (parallel). The listener is
    // already up, so this no longer blocks request serving.
    const entries = Object.entries(this.config.backends);
    this.logger.info(`Connecting ${entries.length} static backend(s)...`);

    await Promise.allSettled(
      entries.map(([name, config]) => this.connectBackend(name, config))
    );

    // Auto-ingest fleet backends (ToolHive / MCPU)
    if (this.config.fleet.enabled && this.config.fleet.toolhive.auto_ingest) {
      await this.ingestFleetBackends();
    }

    const connected = Array.from(this.backends.values()).filter(
      (b) => b.status === "connected"
    ).length;
    this.logger.info(
      `${connected}/${this.backends.size} backends connected, ${this.toolRegistry.getAllTools().length} tools available`
    );

    // Boot report: per-backend UNCLASSIFIED tool counts + names so missing
    // manifest coverage is visible at startup.
    this.logUnclassifiedBootReport();

    // Start health monitoring
    this.startHealthMonitor();

    // STAB-9: adopt fleet changes without waiting for an operator-triggered
    // reload. Only meaningful when fleet auto-ingest is on; otherwise the
    // backend set is purely static and there is nothing to re-read.
    if (this.config.fleet.enabled && this.config.fleet.toolhive.auto_ingest) {
      this.startFleetRefreshTimer();
    }

    // Watch config file, the manifests directory, and the generated fleet
    // config for changes (OPS-3). An edited/added safety manifest or a new
    // fleet server now triggers a hot reload without a gateway restart. Only
    // paths that currently exist are watched; chokidar on a directory reports
    // per-file add/change/unlink.
    const watchPaths = [this.configPath];
    const manifestDir = this.manifests.getManifestDir();
    if (existsSync(manifestDir)) {
      watchPaths.push(manifestDir);
    }
    if (this.config.fleet.enabled) {
      const fleetConfigPath =
        this.config.fleet.toolhive.mcpu_generated_config ??
        join(homedir(), ".config", "mcpu", "config.generated.json");
      if (existsSync(fleetConfigPath)) {
        watchPaths.push(fleetConfigPath);
      }
    }

    this.configWatcher = watch(watchPaths, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 500 },
    });
    // Reload on any file add/change/unlink under the watched paths (config,
    // manifests dir, fleet config). Ignore directory-level and internal events.
    const reloadEvents = new Set(["add", "change", "unlink"]);
    this.configWatcher.on("all", async (event, changedPath) => {
      if (!reloadEvents.has(event)) return;
      this.logger.info(`Watched path ${event}: ${changedPath}, reloading...`);
      try {
        await this.reloadConfig();
      } catch (err) {
        this.logger.error(
          `Config reload failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    });

    // Emit the policy snapshot now that backends are connected, tools are
    // classified, and the admin/loopback routes (incl. /dep-scan) are up. The
    // client-side hook reads this file to gate tool calls locally without
    // re-implementing classification and to find the loopback /dep-scan URL.
    this.writePolicySnapshotBestEffort();
  }

  /**
   * Write the policy snapshot (Phase 1b) into THESUN_HOME: a flat map of
   * gateway tool name → {tier, class, rule?} derived from the SAME
   * classification the dispatch path uses (toolRegistry entry.safety), plus
   * the gateway's loopback base URL so the hook can reach /dep-scan. Called
   * once at the end of start() and again on every config reload so the file
   * tracks backend/manifest changes.
   *
   * Best-effort by design: a snapshot-write failure must NEVER crash startup
   * or dispatch (the gateway must run even if it cannot write the file — the
   * hook then fails open on the missing snapshot). Wrapped in try/catch; a
   * failure logs a warning and is otherwise swallowed.
   */
  private writePolicySnapshotBestEffort(): void {
    try {
      const inputs: PolicySnapshotInput[] = this.toolRegistry
        .getAllEntries()
        .map((entry) => ({ tool: entry.namespacedName, classification: entry.safety }));
      const dir = this.config.approvals?.dir ?? resolveThesunHome();
      const gatewayUrl = `http://${this.config.gateway.host}:${this.config.gateway.port}/mcp`;
      const path = writePolicySnapshot(inputs, dir, { gatewayUrl });
      this.logger.info(
        `Policy snapshot written to ${path} (${inputs.length} tool(s) scanned)`
      );
    } catch (err) {
      this.logger.warn(
        `Failed to write policy snapshot (fail-open — gateway continues): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  /**
   * Hardened-shipping-defaults audit (2026-07): the gateway ships safe by
   * default (loopback bind, enforce:"blocking", empty read-allowlist). This
   * is advisory-only — it does not block startup — but any deviation from
   * the safe default is logged at ERROR level so it is impossible to miss in
   * a config review, unlike the surrounding INFO-level boot chatter.
   */
  private logHardenedDefaultsAudit(): void {
    const host = this.config.gateway.host;
    if (!isLoopbackHost(host)) {
      this.logger.error(
        `HARDENED-DEFAULTS: gateway.host="${host}" is NOT loopback-only (default: 127.0.0.1). The tool-plane is reachable beyond this machine — confirm this is intentional and that auth (Entra or shared_secret) is configured.`
      );
    }

    if (this.config.safety.enforce !== "blocking") {
      this.logger.error(
        `HARDENED-DEFAULTS: safety.enforce="${this.config.safety.enforce}" (default: "blocking"). Unconfirmed WRITE/HUMAN_OUTBOUND/etc. calls will PROCEED with only a warning logged, not be denied.`
      );
    }

    const allowlist = this.config.safety.unmanifested_read_allowlist;
    if (allowlist.length > 0) {
      this.logger.error(
        `HARDENED-DEFAULTS: safety.unmanifested_read_allowlist is non-empty (default: []) — backend(s) [${allowlist.join(", ")}] keep the legacy fail-open default for unmanifested verb-less tools instead of the fail-closed UNCLASSIFIED gate.`
      );
    }
  }

  /**
   * Log per-backend UNCLASSIFIED tool counts and names (one info line per
   * backend with any). Telemetry for manifest coverage gaps — no enforcement.
   */
  private logUnclassifiedBootReport(): void {
    const byBackend = new Map<string, string[]>();
    for (const entry of this.toolRegistry.getAllEntries()) {
      if (entry.safety?.safetyClass !== "UNCLASSIFIED") continue;
      const list = byBackend.get(entry.backendName) ?? [];
      list.push(entry.namespacedName);
      byBackend.set(entry.backendName, list);
    }
    for (const [backendName, tools] of byBackend) {
      this.logger.info(
        `Safety boot report: backend "${backendName}" has ${tools.length} UNCLASSIFIED tool(s): ${tools.join(", ")}`
      );
    }
  }

  async stop(): Promise<void> {
    this.logger.info("Shutting down gateway...");
    if (this.healthTimer) clearInterval(this.healthTimer);
    if (this.fleetRefreshTimer) clearInterval(this.fleetRefreshTimer);
    await this.configWatcher?.close();
    this.configWatcher = undefined;
    for (const backend of this.backends.values()) {
      await backend.disconnect();
    }
    for (const [sessionId, sessionServer] of this.sessions) {
      try {
        await sessionServer.close();
      } catch {
        // ignore
      }
    }
    for (const transport of this.streamableTransports.values()) {
      try {
        await transport.close();
      } catch {
        // ignore
      }
    }
    this.streamableSessionLastSeen.clear();
    if (this.httpServer) {
      const server = this.httpServer;
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
        // Node's http.Server.close() stops accepting new connections but its
        // callback does not fire until every EXISTING connection has drained.
        // A streamable-http client keeps a long-lived GET /mcp stream open, so
        // without forcing those sockets closed here, stop() would block
        // forever whenever a client is still connected (e.g. a test that
        // hasn't closed its client, or a real client that outlives shutdown).
        // closeAllConnections() destroys the lingering sockets so close()
        // completes deterministically.
        server.closeAllConnections();
      });
      this.httpServer = undefined;
    }
  }

  /**
   * Is this backend a candidate for an automatic reconnect attempt?
   *
   * Single source of truth for retry eligibility, shared by the health monitor
   * and the /healthz and /metrics status breakdown so the two can never drift:
   * a backend reported as "retrying" is exactly one the health sweep will pick
   * up, and one reported "abandoned" is exactly one it will skip.
   *
   * Respects the restart policy: "never"-policy backends are never retried, and
   * an "on-failure" backend that has burned its restart budget is left alone
   * rather than thrashed.
   */
  /**
   * Will this backend NEVER be retried again? (restart_policy=never, or the
   * restart budget is spent). Distinct from isRetryEligible, which additionally
   * asks whether the backoff window has elapsed: a backend can be
   * not-yet-due-but-still-coming, and that is not the same as abandoned.
   */
  private isTerminallyAbandoned(backend: BackendInstance): boolean {
    const policy = backend.config.restart_policy;
    if (policy === "never") return true;
    return policy === "on-failure" && backend.restartCount >= backend.config.max_restarts;
  }

  private isRetryEligible(backend: BackendInstance, now = Date.now()): boolean {
    if (backend.status !== "disconnected" && backend.status !== "error") return false;
    // Terminal state, unchanged: a backend that has burned its restart budget is
    // abandoned, and stays reportable as such on /healthz and /metrics.
    if (this.isTerminallyAbandoned(backend)) return false;
    // STAB-8: due-time check. Eligibility is no longer "is it down" but "is it
    // down AND due", so a permanently dead backend decays from a retry every 30
    // seconds to a retry every few minutes instead of being hammered forever.
    return now >= this.nextAttemptAt(backend);
  }

  /**
   * Earliest epoch ms at which this backend should be retried.
   *
   * Exponential backoff on CONSECUTIVE FAILED CONNECTS (not on restartCount,
   * which never moves for a backend that has never connected): delay is
   * reconnect_interval * 2^(failures - 1), capped at BACKOFF_CEILING_MS. A
   * backend with no recorded failure is due immediately, which keeps the first
   * retry after a fresh drop as fast as it has always been.
   */
  private nextAttemptAt(backend: BackendInstance): number {
    const lastFailureAt = backend.lastFailureAt;
    const failures = backend.consecutiveFailures;
    if (lastFailureAt === undefined || failures <= 0) return 0;
    const baseMs = Math.max(1, backend.config.reconnect_interval) * 1000;
    const exponent = Math.min(failures - 1, BACKOFF_MAX_EXPONENT);
    const delayMs = Math.min(baseMs * 2 ** exponent, BACKOFF_CEILING_MS);
    return lastFailureAt + delayMs;
  }

  /**
   * Point-in-time backend connectivity breakdown for /healthz and /metrics.
   *
   * `connected` and `total` keep exactly the meaning they have always had (the
   * count in the connected state, and the size of the known-backend map), so
   * existing consumers of those two fields are unaffected. The remaining fields
   * are additive and answer the question the bare pair could not: of the
   * backends that are not connected, how many is the gateway still retrying,
   * how many has it given up on, and how many were never meant to be up.
   *
   * Cheap and non-blocking: one pass over an in-memory map, no IO.
   */
  private backendHealthCounts(): {
    connected: number;
    total: number;
    starting: number;
    retrying: number;
    abandoned: number;
    disabled: number;
  } {
    let connected = 0;
    let starting = 0;
    let retrying = 0;
    let abandoned = 0;
    let disabled = 0;

    for (const backend of this.backends.values()) {
      switch (backend.status) {
        case "connected":
          connected++;
          break;
        case "starting":
          starting++;
          break;
        case "disabled":
          disabled++;
          break;
        default:
          // disconnected or error: split by whether the health sweep will EVER
          // retry it, not by whether it is due right now. A backend waiting out
          // its STAB-8 backoff is still going to be retried, so it belongs in
          // "retrying"; only a terminally abandoned one (restart_policy=never,
          // or restart budget burned) belongs in "abandoned". Using
          // isRetryEligible here would have flapped every backend between the
          // two buckets on each backoff window, which is exactly the kind of
          // lying denominator this breakdown was added to eliminate.
          if (this.isTerminallyAbandoned(backend)) abandoned++;
          else retrying++;
          break;
      }
    }

    return {
      connected,
      total: this.backends.size,
      starting,
      retrying,
      abandoned,
      disabled,
    };
  }

  private startHealthMonitor(): void {
    const interval = 30_000; // 30 seconds
    this.healthTimer = setInterval(async () => {
      await this.reapIdleStreamableSessions();

      const eligible = Array.from(this.backends.entries()).filter(([, backend]) =>
        this.isRetryEligible(backend)
      );

      // STAB-3: reconnect eligible backends CONCURRENTLY. The previous
      // sequential loop let one slow backend delay every later backend in the
      // same sweep (head-of-line blocking): with an N-second connect timeout and
      // many dead backends, a sweep could overrun its own 30s interval and the
      // next sweep would start on top of it. ensureReconnected already
      // single-flights per backend name, so overlapping sweeps cannot stack
      // duplicate reconnects for the same backend. allSettled because one
      // backend's failure must never abort the others.
      await Promise.allSettled(
        eligible.map(async ([name, backend]) => {
          this.logger.info(
            `Health check: backend "${name}" is ${backend.status}, attempting reconnect...`
          );
          try {
            const toolCount = await this.ensureReconnected(name);
            if ((backend.status as string) === "connected") {
              this.notifyToolsChanged();
              this.logger.info(
                `Health check: backend "${name}" reconnected, ${toolCount} tools`
              );
            }
          } catch {
            this.logger.warn(`Health check: backend "${name}" reconnect failed`);
          }
        })
      );
    }, interval);
  }
}
