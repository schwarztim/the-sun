import { z } from "zod";
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import Vault from "node-vault";

const SseBackendSchema = z.object({
  transport: z.literal("sse"),
  url: z.string().url(),
  namespace: z.string(),
  enabled: z.boolean().default(true),
  reconnect_interval: z.number().default(5),
  max_restarts: z.number().default(5),
  connect_timeout_ms: z.number().int().positive().default(15_000),
  restart_policy: z
    .enum(["always", "on-failure", "never"])
    .default("on-failure"),
  headers: z.record(z.string()).default({}),
  health_check_interval: z.number().default(30),
  source: z.string().optional(),
  description: z.string().optional(),
  tools_allow: z.array(z.string()).optional(),
  tools_deny: z.array(z.string()).optional(),
});

/** Streamable HTTP transport used by ToolHive-managed MCP servers */
const HttpBackendSchema = z.object({
  transport: z.literal("http"),
  url: z.string().url(),
  namespace: z.string(),
  enabled: z.boolean().default(true),
  reconnect_interval: z.number().default(5),
  max_restarts: z.number().default(5),
  connect_timeout_ms: z.number().int().positive().default(15_000),
  restart_policy: z
    .enum(["always", "on-failure", "never"])
    .default("on-failure"),
  headers: z.record(z.string()).default({}),
  health_check_interval: z.number().default(30),
  /** Informational: source of this backend entry (e.g. "fleet-mcpu") */
  source: z.string().optional(),
  /** Informational: original description from the fleet catalog */
  description: z.string().optional(),
  /**
   * Per-backend client-visibility filter (mirrors ToolHive toolsFilter), by
   * ORIGINAL (backend) tool name. When `tools_allow` is non-empty, ONLY those
   * tools are exposed to the client; `tools_deny` removes tools. Precedence:
   * deny beats allow (a tool in both is hidden). Both undefined (default) =
   * expose all tools, unchanged behavior. Filtered-out tools are never
   * registered, so they never appear in tools/list or gateway_search_tools and
   * are denied fail-closed if somehow called.
   */
  tools_allow: z.array(z.string()).optional(),
  tools_deny: z.array(z.string()).optional(),
});

const BackendSchema = z.discriminatedUnion("transport", [
  SseBackendSchema,
  HttpBackendSchema,
]);

const GatewayConfigSchema = z.object({
  port: z.number().default(3100),
  host: z.string().default("127.0.0.1"),
  name: z.string().default("mcp-gateway"),
  log_level: z.enum(["debug", "info", "warn", "error"]).default("info"),
  tool_prefix: z.string().default(""),
  tool_exposure: z.enum(["namespaced", "mux", "both"]).default("mux"),
  /**
   * gateway_search_tools ranking. When true (default), the facade ranks backend
   * tools by SEMANTIC similarity using a local, in-process embedding model
   * (transformers.js, cached under THESUN_HOME) so a query surfaces relevant
   * tools even without a literal name/description match. If the optional model
   * dependency is missing or fails to load, search transparently degrades to
   * keyword (token-set) ranking. Set false to always use keyword ranking.
   */
  search_semantic: z.boolean().default(true),
  /**
   * Default number of tools gateway_search_tools returns (top-k) when the
   * caller does not pass an explicit limit. Keeps the client context small.
   */
  search_top_k: z.number().int().positive().default(8),
  /**
   * Client-facing tool overrides (mirrors ToolHive tool overrides). Keyed by
   * the ORIGINAL namespaced tool name (e.g. "az_teams_send_message"); each
   * value may override the exposed `name` (rename) and/or the exposed
   * `description` (shorten/disambiguate/cut token cost). ONLY the client-facing
   * surface changes: backend dispatch still routes to the real backend tool, so
   * a rename never breaks call routing. A rename whose target collides with an
   * already-exposed tool name is ignored (the original name is kept and a
   * warning is logged) so a tool is never silently dropped. Default: no
   * overrides.
   */
  tool_overrides: z
    .record(
      z.object({
        name: z.string().optional(),
        description: z.string().optional(),
      })
    )
    .default({}),
  /** Stateless Streamable HTTP prevents stale in-memory session IDs after gateway restarts */
  streamable_http_stateless: z.boolean().default(true),
  /** JSON responses keep facade calls request/response and avoid long-lived per-call SSE streams */
  streamable_http_json_response: z.boolean().default(true),
  /**
   * SEC-5 escape hatch (default false): DISABLES the fail-closed bind guard
   * that refuses to start when the gateway binds a NON-loopback host with
   * auth.mode "none" and no shared_secret (an unauthenticated tool-plane
   * reachable off-box). Set true ONLY when the non-loopback interface is on a
   * network segment you have secured by other means; it does NOT add auth, it
   * only silences the safety check. Loopback binds are unaffected either way.
   */
  allow_insecure_non_loopback: z.boolean().default(false),
});

const ToolHiveFleetConfigSchema = z.object({
  app_support_dir: z.string().optional(),
  mcpu_generated_config: z.string().optional(),
  /** Also ingest static MCPU config entries that are not in generated ToolHive config */
  ingest_static_mcpu_config: z.boolean().default(true),
  /** Static MCPU config path; defaults to ~/.config/mcpu/config.json */
  mcpu_static_config: z.string().optional(),
  /** Additional flat or mcpServers-style MCPU config files to merge after generated/static configs */
  additional_mcpu_configs: z.array(z.string()).default([]),
  docker_ps: z.boolean().default(true),
  endpoint_probe: z.boolean().default(false),
  probe_timeout_ms: z.number().int().positive().default(750),
  /** Auto-ingest fleet entries as gateway backends at startup */
  auto_ingest: z.boolean().default(true),
  /** Prefix for auto-ingested backend namespaces (default: "") */
  ingest_namespace_prefix: z.string().default(""),
  /** Only ingest entries matching these names (empty = all) */
  ingest_only: z.array(z.string()).default([]),
  /** Skip ingesting entries matching these names */
  ingest_skip: z.array(z.string()).default([]),
  /**
   * Remove fleet-ingested backends that have VANISHED from the fleet inventory
   * (STAB-10). Default OFF: this is the only reliability change that alters
   * what an operator sees in gateway_backend_status, so it is opt-in until an
   * install has watched it behave.
   *
   * Pruning keys off ABSENCE FROM THE SOURCE OF TRUTH, never off connection
   * failure: a dead-but-still-listed backend is a health problem, not a reason
   * to forget it exists. Statically configured backends are never pruned at
   * any setting, because the operator wrote them down.
   */
  prune_missing: z.boolean().default(false),
});

const FleetConfigSchema = z.object({
  enabled: z.boolean().default(true),
  toolhive: ToolHiveFleetConfigSchema.default({}),
});

const SafetyConfigSchema = z.object({
  enforce: z.enum(["advisory", "blocking"]).default("blocking"),
  manifest_dir: z.string().optional(),
  /**
   * Phase 2 (non-annoyance kit): fire a best-effort OS notification when a
   * NEW Tier-B call parks awaiting out-of-band approval (macOS osascript /
   * Windows PowerShell toast / Linux notify-send), deep-linking the loopback
   * /approve page. Purely advisory — failures are swallowed and never affect
   * dispatch. Default ON.
   */
  notifications: z.boolean().default(true),
  decision_log: z
    .object({
      // Default ON (2026-06-10 hardening): the decision log is the audit trail
      // mandated for every dispatch. Writes are fail-closed — see
      // Gateway.logSafetyDecision.
      enabled: z.boolean().default(true),
      path: z.string().default("~/.mcp-gateway/decisions.jsonl"),
      // Rotation (2026-07 hardening): the fail-closed audit trail must not be
      // able to self-DoS the gateway by filling the disk. Rotate the active
      // file once it crosses max_size_mb, keeping up to max_files rotated
      // copies (decisions.jsonl.1, .2, ... — oldest beyond max_files deleted).
      max_size_mb: z.number().positive().default(50),
      max_files: z.number().int().positive().default(5),
    })
    .default({}),
  /**
   * Backends permitted to keep the legacy fail-open default (unmanifested,
   * verb-less tool → READ) during manifest burn-down. Everything NOT listed
   * here gets the fail-closed default: unmanifested verb-less → UNCLASSIFIED,
   * which is gated. Empty list = fully fail-closed.
   */
  unmanifested_read_allowlist: z.array(z.string()).default([]),
  /**
   * Default-conservative escalation overlay (escalation.ts). Manifests declare
   * facts (safety class, http method, tool name); this policy escalates
   * genuinely-dangerous Tier-A tools to Tier-B so the out-of-band approval —
   * the only control that holds against a full-auto, hook-less client — actually
   * covers them. Monotonic: only Tier-A → Tier-B, never touches READ or an
   * already-Tier-B manifest classification. Setting enabled=false reverts to
   * pre-overlay behavior (Tier-B only via hand-authored manifests).
   */
  escalation: z
    .object({
      enabled: z.boolean().default(true),
      /** http_method DELETE → Tier-B (policy:delete-method). */
      delete_method_to_tier_b: z.boolean().default(true),
      /** Tool-name verbs that escalate to Tier-B (policy:destructive-verb). Trim to tune. */
      destructive_verbs: z
        .array(z.string())
        .default([
          "delete",
          "remove",
          "purge",
          "destroy",
          "drop",
          "terminate",
          "kill",
          "revoke",
          "wipe",
          "erase",
          "shutdown",
          "deprovision",
          "force",
        ]),
      /** Tool-name verbs that escalate class to HUMAN_OUTBOUND (Tier-B + PCI/SSN arg block). */
      outbound_verbs: z
        .array(z.string())
        .default([
          "send",
          "reply",
          "email",
          "notify",
          "broadcast",
          "publish",
          "comment",
          "message",
        ]),
      /** Backend name globs whose non-READ tools escalate to PRODUCTION. Ships empty (operator opt-in). */
      production_backends: z.array(z.string()).default([]),
      /** "backend.tool" entries the operator declares misclassified — skip escalation for them. */
      exempt: z.array(z.string()).default([]),
    })
    .default({}),
  /**
   * Tier-A confirm token (Phase 4, roadmap §2.4) — AUDIT INTEGRITY ONLY, not
   * an adversarial control (an autonomous model echoes the token from the
   * block response). When ON, a Tier-A gated call's block response carries a
   * `confirmToken` HMAC-bound to the challenged args, and a `confirmed: true`
   * re-call must present a valid, unexpired token whose args-hash matches the
   * CURRENT args — otherwise it is treated as unconfirmed and re-challenged.
   * Closes blind first-call self-confirm and confirm-then-swap in the audit
   * trail. Default ON.
   */
  confirm_token: z.boolean().default(true),
});

const AuthConfigSchema = z
  .object({
    /**
     * none  — no tool-plane authentication (loopback / single-operator mode).
     * entra — Bearer JWTs validated against Entra ID (signature via JWKS,
     *         iss/aud/exp) on /mcp, /sse, and /messages. Requests without a
     *         valid token get 401; sessions are bound to the creating identity.
     */
    mode: z.enum(["none", "entra"]).default("none"),
    tenant_id: z.string().default(""),
    audience: z.string().default(""),
    /** Override the expected issuer. Default: https://login.microsoftonline.com/<tenant_id>/v2.0 */
    issuer: z.string().optional(),
    /** Override the JWKS endpoint. Default: https://login.microsoftonline.com/<tenant_id>/discovery/v2.0/keys */
    jwks_uri: z.string().optional(),
    /**
     * Per-install shared secret (bearer token) required on /mcp, /sse, and
     * /messages when set. OPT-IN / default-off (undefined): existing client
     * connectivity (fleet/wire.go) does not yet inject this header, so making
     * it default-required would break every current client. Enabling this by
     * default fleet-wide is Wave-2b — it requires a coordinated wire.go change
     * to inject `Authorization: Bearer <shared_secret>` on outbound gateway
     * connections. Until that lands, this stays an available-but-unused knob.
     * Independent of `mode` — composes with Entra auth if both are set.
     */
    shared_secret: z.string().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.mode === "entra") {
      if (!v.tenant_id) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "auth.tenant_id is required when auth.mode is 'entra'" });
      }
      if (!v.audience) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "auth.audience is required when auth.mode is 'entra'" });
      }
    }
  });

const ContentGuardConfigSchema = z.object({
  /** Egress secret redaction (AWS/GitHub/OpenAI/private-key/Slack/Google/bearer) on tool RESULTS. Default ON. */
  secrets: z.object({ enabled: z.boolean().default(true) }).default({}),
  /** Luhn-validated card detection: BLOCK on HUMAN_OUTBOUND args, redact in results. Default ON. */
  luhn: z.object({ enabled: z.boolean().default(true) }).default({}),
  /** US SSN pattern: BLOCK on HUMAN_OUTBOUND args, redact in results. Default OFF (opt-in). */
  ssn: z.object({ enabled: z.boolean().default(false) }).default({}),
  /** Destructive-SQL arg blocking, scoped to tools tagged sql/exec. Default OFF (opt-in). */
  sql_destructive: z.object({ enabled: z.boolean().default(false) }).default({}),
  /**
   * High-entropy secret detector (Phase 4): Shannon-entropy + length + charset
   * heuristic for hex/base64 blobs in tool results. Default OFF — deliberately
   * opt-in because it is false-positive-prone (hashes, signatures, and other
   * legitimately random-looking values will be redacted too).
   */
  entropy: z.object({ enabled: z.boolean().default(false) }).default({}),
  /** Payloads larger than this are passed through unscanned (bounded scan cost). */
  max_scan_chars: z.number().int().positive().default(1_000_000),
});

const ApprovalsConfigSchema = z.object({
  /**
   * Override the directory holding approvals.json / grants.json /
   * install-identity.json (SC-4 Tier-B out-of-band approval store). Absent =
   * resolveThesunHome() (approvals.ts): $THESUN_HOME, else the OS user-config
   * dir + "thesun" — the same root fleetd/paths.go resolves. Primarily a test
   * seam; operators should not normally need to set this.
   */
  dir: z.string().optional(),
  /**
   * Phase 3 (SECURITY-ROADMAP §2.2): capability-gated elicitation upgrade for
   * Tier-B approvals. When "on" AND the session's client declared the
   * `elicitation` capability, a parked Tier-B call ALSO sends an in-editor
   * `elicitation/create` dialog; a human Approve lets the same in-flight call
   * proceed. The park record is created first regardless and remains the
   * source of truth — every elicitation failure path degrades to the park.
   *
   * DEFAULT "off": promotion to default-on is gated on the manual
   * auto-accept verification evidence (docs/elicitation-verification.md) —
   * a client that auto-accepts elicitations in a full-auto mode would
   * silently convert Tier-B to Tier-A on that client.
   */
  elicitation: z.enum(["off", "on"]).default("off"),
  /**
   * clientInfo.name values for which elicitation is never attempted (they
   * park exactly as if the capability were absent). Escape hatch for clients
   * found to auto-accept elicitations in full-auto modes.
   */
  elicitation_blocklist: z.array(z.string()).default([]),
  /**
   * How long to wait for the human to answer the elicitation dialog before
   * degrading to the park. Production default 120s (roadmap §2.2); primarily
   * a test seam — tests override it so timeout paths run fast.
   */
  elicitation_timeout_ms: z.number().int().positive().default(120_000),
  /**
   * Grant-identity scope (Phase 4, addresses G4):
   *  "install"        — (default) grants are keyed by the per-install identity
   *                     (or Entra oid) only; any MCP client on this install
   *                     shares them.
   *  "install+client" — grants are additionally keyed by the connecting MCP
   *                     client's clientInfo.name (from the initialize
   *                     handshake), so a grant issued while Claude Code was
   *                     connected does not authorize the same tool for Codex.
   *                     clientInfo is only observable on stateful transports
   *                     (session-mode streamable HTTP, SSE); on the stateless
   *                     streamable path there is no per-call client identity,
   *                     so the identity falls back to install scope.
   */
  identity_scope: z.enum(["install", "install+client"]).default("install"),
});

const CompressionConfigSchema = z.object({
  /** Master switch — defaults OFF so behavior is byte-identical to pre-Phase-4. */
  enabled: z.boolean().default(false),
  /** Only compress text payloads at least this large (chars); smaller text passes through unchanged. */
  min_chars: z.number().int().positive().default(20_000),
  /**
   * advisory — measure savings and log them, but return the ORIGINAL text unchanged.
   * active   — apply compression and return the compacted text with a marker.
   */
  mode: z.enum(["advisory", "active"]).default("active"),
});

const ConfigFileSchema = z.object({
  gateway: GatewayConfigSchema.default({}),
  fleet: FleetConfigSchema.default({}),
  backends: z.record(BackendSchema).default({}),
  safety: SafetyConfigSchema.default({}),
  compression: CompressionConfigSchema.default({}),
  auth: AuthConfigSchema.default({}),
  content_guard: ContentGuardConfigSchema.default({}),
  approvals: ApprovalsConfigSchema.default({}),
});

export type SseBackendConfig = z.infer<typeof SseBackendSchema>;
export type HttpBackendConfig = z.infer<typeof HttpBackendSchema>;
export type BackendConfig = z.infer<typeof BackendSchema>;
export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;
export type ToolHiveFleetConfig = z.infer<typeof ToolHiveFleetConfigSchema>;
export type FleetConfig = z.infer<typeof FleetConfigSchema>;
export type SafetyConfig = z.infer<typeof SafetyConfigSchema>;
export type CompressionConfig = z.infer<typeof CompressionConfigSchema>;
export type AuthConfig = z.infer<typeof AuthConfigSchema>;
export type ContentGuardConfigFile = z.infer<typeof ContentGuardConfigSchema>;
export type ApprovalsConfig = z.infer<typeof ApprovalsConfigSchema>;
export type Config = z.infer<typeof ConfigFileSchema>;

/** Resolve ${VAR} references in a string from process.env */
function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, varName) => {
    const envVal = process.env[varName];
    if (envVal === undefined) {
      throw new Error(`Environment variable ${varName} is not set`);
    }
    return envVal;
  });
}

/** Recursively resolve env vars in an object */
function resolveEnvInObject(obj: unknown): unknown {
  if (typeof obj === "string") return resolveEnvVars(obj);
  if (Array.isArray(obj)) return obj.map(resolveEnvInObject);
  if (obj && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = resolveEnvInObject(v);
    }
    return result;
  }
  return obj;
}

/** Vault secret cache to avoid redundant fetches */
const vaultCache = new Map<string, Record<string, string>>();

/**
 * Resolve vault:path#key references.
 * Syntax: vault:secret/mcp/akamai#client_secret
 * Or shorthand: vault:mcp/akamai#client_secret (auto-prefixes secret/)
 */
async function resolveVaultRef(ref: string): Promise<string> {
  const match = ref.match(/^vault:(.+)#(.+)$/);
  if (!match) throw new Error(`Invalid vault reference: ${ref}`);

  let [, path, key] = match;

  // Shorthand: vault:mcp/x#y → secret/data/mcp/x
  if (!path.startsWith("secret/")) {
    path = `secret/data/${path}`;
  } else if (!path.includes("/data/")) {
    // vault:secret/mcp/x#y → secret/data/mcp/x
    path = path.replace("secret/", "secret/data/");
  }

  if (!vaultCache.has(path)) {
    const vaultAddr = process.env.VAULT_ADDR || "http://127.0.0.1:8200";
    const vaultToken = process.env.VAULT_TOKEN;
    if (!vaultToken) throw new Error("VAULT_TOKEN environment variable is required for vault: references");

    const client = Vault({ endpoint: vaultAddr, token: vaultToken });
    const result = await client.read(path);
    vaultCache.set(path, result.data?.data || result.data || {});
  }

  const data = vaultCache.get(path)!;
  if (!(key in data)) {
    throw new Error(`Vault secret at ${path} does not contain key "${key}". Available: ${Object.keys(data).join(", ")}`);
  }
  return data[key];
}

/** Recursively resolve vault: refs in an object */
async function resolveVaultInObject(obj: unknown): Promise<unknown> {
  if (typeof obj === "string" && obj.startsWith("vault:")) {
    return resolveVaultRef(obj);
  }
  if (Array.isArray(obj)) {
    return Promise.all(obj.map(resolveVaultInObject));
  }
  if (obj && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = await resolveVaultInObject(v);
    }
    return result;
  }
  return obj;
}

/**
 * Pre-parse quarantine filter: stdio is not representable in the config schema
 * (the discriminated union has only sse/http). Any backend entry declaring
 * `transport: stdio` — or a bare `command:` with no `url:` (implicit stdio) — is
 * stripped BEFORE schema validation. stdio deadlocks under gateway/process-
 * supervisor management (MCP Transport Rule — global CLAUDE.md): the handshake
 * hangs, zero tools are exposed, and consumers burn tokens retrying. Stripping
 * is fail-closed for the entry (it never becomes a live backend) and fail-open
 * for the gateway (it still boots on the remaining backends instead of crash-
 * looping). This is the project's "transport constitution" — see
 * test/unit/config-transport.test.ts.
 */
function quarantineStdioBackends(resolved: unknown): unknown {
  if (!resolved || typeof resolved !== "object" || Array.isArray(resolved)) {
    return resolved;
  }
  const root = resolved as Record<string, unknown>;
  const backends = root.backends;
  if (!backends || typeof backends !== "object" || Array.isArray(backends)) {
    return resolved;
  }
  const backendsRecord = backends as Record<string, unknown>;
  for (const [name, entry] of Object.entries(backendsRecord)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    const isStdio =
      e.transport === "stdio" ||
      (e.command !== undefined && e.url === undefined);
    if (isStdio) {
      delete backendsRecord[name];
      // loadConfig has no logger — index.ts creates the logger after loadConfig.
      console.error(
        `[config] quarantined backend "${name}": reason=stdio-unsupported remedy="re-front behind streamable-http"`
      );
    }
  }
  return resolved;
}

export async function loadConfig(filePath: string): Promise<Config> {
  const raw = await readFile(filePath, "utf-8");
  const parsed = parseYaml(raw);

  // First resolve env vars, then resolve vault references
  const envResolved = resolveEnvInObject(parsed);
  const resolved = await resolveVaultInObject(envResolved);

  // Quarantine stdio entries before schema parse — stdio is unrepresentable and
  // deadlocks under gateway management; strip it so the gateway boots without it.
  const quarantined = quarantineStdioBackends(resolved);

  vaultCache.clear(); // free memory after load

  const config = ConfigFileSchema.parse(quarantined);

  // Reject duplicate namespaces among ENABLED backends — two enabled backends
  // sharing a namespace would silently collide in the tool registry.
  const namespaceOwners = new Map<string, string[]>();
  for (const [name, backend] of Object.entries(config.backends)) {
    if (!backend.enabled) continue;
    const owners = namespaceOwners.get(backend.namespace) ?? [];
    owners.push(name);
    namespaceOwners.set(backend.namespace, owners);
  }
  const collisions = Array.from(namespaceOwners.entries()).filter(
    ([, owners]) => owners.length > 1
  );
  if (collisions.length > 0) {
    const detail = collisions
      .map(([ns, owners]) => `namespace "${ns}" used by backends [${owners.join(", ")}]`)
      .join("; ");
    throw new Error(`Duplicate backend namespace among enabled backends: ${detail}`);
  }

  return config;
}
