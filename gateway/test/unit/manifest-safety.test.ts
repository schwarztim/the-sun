import { describe, it, expect, beforeEach } from "vitest";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createLogger } from "../../src/logger.js";
import {
  ManifestRegistry,
  isGatedClass,
  decideGate,
  validateManifestSemantics,
  ManifestFileSchema,
  WRITE_VERB_REGEX,
} from "../../src/manifest.js";
import type { SafetyClass, SafetyClassification } from "../../src/manifest.js";

const silentLogger = createLogger("silent");

// ─── isGatedClass ──────────────────────────────────────────────────────────────

describe("isGatedClass", () => {
  it("READ is NOT gated", () => {
    expect(isGatedClass("READ")).toBe(false);
  });

  it("every non-READ class IS gated", () => {
    const gated: SafetyClass[] = [
      "WRITE",
      "SIDE_EFFECT",
      "HUMAN_OUTBOUND",
      "PRODUCTION",
      "VAULT_VALUE",
    ];
    for (const c of gated) {
      expect(isGatedClass(c)).toBe(true);
    }
  });
});

// ─── WRITE_VERB_REGEX ──────────────────────────────────────────────────────────

describe("WRITE_VERB_REGEX — verb-set coverage", () => {
  it("matches _send at end of name", () => {
    expect(WRITE_VERB_REGEX.test("teams_send")).toBe(true);
  });
  it("matches _send_ in the middle", () => {
    expect(WRITE_VERB_REGEX.test("teams_send_message")).toBe(true);
  });
  it("matches _delete_", () => {
    expect(WRITE_VERB_REGEX.test("calendar_delete_event")).toBe(true);
  });
  it("does NOT match when verb is a substring (no word boundary)", () => {
    // 'sendgrid' should not match 'send' as a segment
    expect(WRITE_VERB_REGEX.test("sendgrid_get_stats")).toBe(false);
  });
  it("does NOT match a plain read name", () => {
    expect(WRITE_VERB_REGEX.test("teams_get_chat_messages")).toBe(false);
    expect(WRITE_VERB_REGEX.test("list_incidents")).toBe(false);
  });
  it("matches create at start of name", () => {
    expect(WRITE_VERB_REGEX.test("create_incident")).toBe(true);
  });
});

// ─── decideGate ───────────────────────────────────────────────────────────────

describe("decideGate — pure gate decision", () => {
  const readSafety: SafetyClassification = {
    safetyClass: "READ",
    tags: [],
    confirmationMapsToDownstream: false,
    source: "manifest",
  };
  const writeSafety: SafetyClassification = {
    safetyClass: "WRITE",
    tags: [],
    confirmationMapsToDownstream: false,
    source: "manifest",
  };
  const humanOutboundSafety: SafetyClassification = {
    safetyClass: "HUMAN_OUTBOUND",
    tags: [],
    confirmationMapsToDownstream: false,
    source: "manifest",
  };

  it("READ never gates regardless of confirmed or enforce mode", () => {
    expect(decideGate(readSafety, false, "advisory").action).toBe("proceed");
    expect(decideGate(readSafety, false, "blocking").action).toBe("proceed");
    expect(decideGate(readSafety, true, "advisory").action).toBe("proceed");
  });

  it("WRITE + confirmed:true always proceeds regardless of enforce mode", () => {
    expect(decideGate(writeSafety, true, "advisory").action).toBe("proceed");
    expect(decideGate(writeSafety, true, "blocking").action).toBe("proceed");
  });

  it("WRITE + confirmed:false + advisory → warn (advisory proceeds)", () => {
    const decision = decideGate(writeSafety, false, "advisory");
    expect(decision.action).toBe("warn");
    if (decision.action === "warn") {
      expect(decision.safetyClass).toBe("WRITE");
    }
  });

  it("WRITE + confirmed:false + blocking → block", () => {
    const decision = decideGate(writeSafety, false, "blocking");
    expect(decision.action).toBe("block");
    if (decision.action === "block") {
      expect(decision.safetyClass).toBe("WRITE");
    }
  });

  it("HUMAN_OUTBOUND + confirmed:false + blocking → block", () => {
    const decision = decideGate(humanOutboundSafety, false, "blocking");
    expect(decision.action).toBe("block");
  });

  it("undefined safety → proceed (unresolvable tool fails later as unknown-tool, never dispatches)", () => {
    expect(decideGate(undefined, false, "advisory").action).toBe("proceed");
    expect(decideGate(undefined, false, "blocking").action).toBe("proceed");
  });

  // ── Fail-closed inversion (2026-06-10): UNCLASSIFIED is gated ────────────────

  const unclassifiedSafety: SafetyClassification = {
    safetyClass: "UNCLASSIFIED",
    tags: [],
    confirmationMapsToDownstream: false,
    source: "unclassified",
  };

  it("UNCLASSIFIED + confirmed:false + blocking → block (fail-closed)", () => {
    const decision = decideGate(unclassifiedSafety, false, "blocking");
    expect(decision.action).toBe("block");
    if (decision.action === "block") {
      expect(decision.safetyClass).toBe("UNCLASSIFIED");
    }
  });

  it("UNCLASSIFIED + confirmed:false + advisory → warn", () => {
    expect(decideGate(unclassifiedSafety, false, "advisory").action).toBe("warn");
  });

  it("UNCLASSIFIED + confirmed:true → proceed", () => {
    expect(decideGate(unclassifiedSafety, true, "blocking").action).toBe("proceed");
  });

  // ── write_guard enforcement (2026-06-10): guard forces gating ────────────────

  const readWithGuard: SafetyClassification = {
    safetyClass: "READ",
    tags: [],
    writeGuard: "router_confirmation_maps_to_downstream",
    confirmationMapsToDownstream: false,
    source: "manifest",
  };

  it("READ + write_guard + blocking + unconfirmed → block (guard overrides class)", () => {
    expect(decideGate(readWithGuard, false, "blocking").action).toBe("block");
  });

  it("READ + write_guard + confirmed:true → proceed", () => {
    expect(decideGate(readWithGuard, true, "blocking").action).toBe("proceed");
  });

  it("READ without write_guard still never gates", () => {
    expect(decideGate(readSafety, false, "blocking").action).toBe("proceed");
  });
});

// ─── ManifestRegistry — helpers ───────────────────────────────────────────────

function makeTempManifestDir(): string {
  const dir = join(tmpdir(), `mcp-gw-test-manifests-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeManifest(dir: string, filename: string, content: object): void {
  writeFileSync(join(dir, filename), JSON.stringify(content));
}

function cleanDir(dir: string): void {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

// ─── ManifestRegistry — missing directory ─────────────────────────────────────

describe("ManifestRegistry — missing manifest directory", () => {
  it("tolerates a missing dir and classifies everything by name-pattern", () => {
    const reg = new ManifestRegistry(silentLogger, "/nonexistent/path/that/never/exists");

    // Name-pattern fallback: send → WRITE
    const sendResult = reg.classify("any-backend", "send_notification", "any_send_notification");
    expect(sendResult.safetyClass).toBe("WRITE");
    expect(sendResult.source).toBe("name-pattern");

    // Verb-less fallback: get → UNCLASSIFIED, which is GATED (fail-closed inversion)
    const getResult = reg.classify("any-backend", "get_status", "any_get_status");
    expect(getResult.safetyClass).toBe("UNCLASSIFIED");
    expect(getResult.source).toBe("unclassified");
  });
});

// ─── ManifestRegistry — unmanifested READ allowlist (burn-down staging) ───────

describe("ManifestRegistry — unmanifested_read_allowlist", () => {
  it("allowlisted backend keeps legacy READ default for verb-less tools", () => {
    const reg = new ManifestRegistry(silentLogger, "/nonexistent/path", {
      unmanifestedReadAllowlist: ["legacy-backend"],
    });

    const allowlisted = reg.classify("legacy-backend", "get_status", "lb_get_status");
    expect(allowlisted.safetyClass).toBe("READ");
    expect(allowlisted.source).toBe("unclassified");
    expect(allowlisted.tags).toContain("unmanifested-read-allowlist");

    // Allowlist does NOT defeat the write-verb heuristic
    const writeStillCaught = reg.classify("legacy-backend", "delete_thing", "lb_delete_thing");
    expect(writeStillCaught.safetyClass).toBe("WRITE");
    expect(writeStillCaught.source).toBe("name-pattern");

    // Other backends are fail-closed
    const other = reg.classify("other-backend", "get_status", "ob_get_status");
    expect(other.safetyClass).toBe("UNCLASSIFIED");
  });
});

// ─── ManifestRegistry — semantic rejection at load (lying manifests) ──────────

describe("ManifestRegistry — semantic validation rejects lying manifests at load", () => {
  it("rejects a manifest labeling a write-verb tool READ; backend falls back fail-closed", () => {
    const dir = makeTempManifestDir();
    try {
      // Lying manifest: delete_* labeled READ would launder a destructive tool past the gate
      writeManifest(dir, "liar.json", {
        manifest: "isaac-router-manifest/v1",
        backend: "liar-backend",
        capabilities: [
          { tool: "delete_enrollment", safety_class: "READ", tags: [] },
          { tool: "get_info", safety_class: "READ", tags: [] },
        ],
      });
      // Honest manifest in the same dir still loads
      writeManifest(dir, "honest.json", {
        manifest: "isaac-router-manifest/v1",
        backend: "honest-backend",
        capabilities: [{ tool: "get_thing", safety_class: "READ", tags: [] }],
      });

      const reg = new ManifestRegistry(silentLogger, dir);

      // Rejected manifest's labels are NOT honored — write verb caught by name-pattern…
      const destructive = reg.classify("liar-backend", "delete_enrollment", "lb_delete_enrollment");
      expect(destructive.safetyClass).toBe("WRITE");
      expect(destructive.source).toBe("name-pattern");
      // …and its verb-less tools are UNCLASSIFIED (gated), not manifest-READ
      const verbless = reg.classify("liar-backend", "get_info", "lb_get_info");
      expect(verbless.safetyClass).toBe("UNCLASSIFIED");
      expect(verbless.source).toBe("unclassified");

      // Honest manifest unaffected
      const honest = reg.classify("honest-backend", "get_thing", "hb_get_thing");
      expect(honest.safetyClass).toBe("READ");
      expect(honest.source).toBe("manifest");
    } finally {
      cleanDir(dir);
    }
  });
});

// ─── ManifestRegistry — manifest hit (READ) ───────────────────────────────────

describe("ManifestRegistry — manifest hit: READ classification", () => {
  let dir: string;
  let reg: ManifestRegistry;

  beforeEach(() => {
    dir = makeTempManifestDir();
    writeManifest(dir, "az-teams.json", {
      manifest: "isaac-router-manifest/v1",
      backend: "az-teams",
      capabilities: [
        {
          tool: "teams_get_chat_messages",
          safety_class: "READ",
          locality: "remote",
          tags: ["teams", "chat", "read"],
        },
      ],
    });
    reg = new ManifestRegistry(silentLogger, dir);
  });

  it("returns manifest READ for a classified tool", () => {
    const result = reg.classify(
      "az-teams",
      "teams_get_chat_messages",
      "az_teams_teams_get_chat_messages"
    );
    expect(result.safetyClass).toBe("READ");
    expect(result.source).toBe("manifest");
    expect(result.tags).toContain("teams");
    expect(result.confirmationMapsToDownstream).toBe(false);
  });

  it("falls back to name-pattern for a tool not in the manifest", () => {
    // 'delete_something' would be WRITE by name-pattern but is not in the manifest
    const result = reg.classify("az-teams", "delete_something", "az_teams_delete_something");
    expect(result.safetyClass).toBe("WRITE");
    expect(result.source).toBe("name-pattern");
  });
});

// ─── ManifestRegistry — manifest hit (HUMAN_OUTBOUND) ────────────────────────

describe("ManifestRegistry — manifest hit: HUMAN_OUTBOUND classification", () => {
  let dir: string;
  let reg: ManifestRegistry;

  beforeEach(() => {
    dir = makeTempManifestDir();
    writeManifest(dir, "az-teams.json", {
      manifest: "isaac-router-manifest/v1",
      backend: "az-teams",
      capabilities: [
        {
          tool: "teams_send_message",
          safety_class: "HUMAN_OUTBOUND",
          locality: "remote",
          tags: ["teams", "chat", "send", "outbound"],
          write_guard: "router_confirmation_maps_to_downstream",
          confirmation_maps_to_downstream: false,
        },
      ],
    });
    reg = new ManifestRegistry(silentLogger, dir);
  });

  it("returns HUMAN_OUTBOUND from manifest with correct metadata", () => {
    const result = reg.classify(
      "az-teams",
      "teams_send_message",
      "az_teams_teams_send_message"
    );
    expect(result.safetyClass).toBe("HUMAN_OUTBOUND");
    expect(result.source).toBe("manifest");
    expect(result.tags).toContain("outbound");
    expect(result.writeGuard).toBe("router_confirmation_maps_to_downstream");
    expect(result.confirmationMapsToDownstream).toBe(false);
    expect(result.locality).toBe("remote");
  });
});

// ─── ManifestRegistry — name-pattern fallback ────────────────────────────────

describe("ManifestRegistry — name-pattern fallback (no manifest for backend)", () => {
  let dir: string;
  let reg: ManifestRegistry;

  beforeEach(() => {
    dir = makeTempManifestDir();
    // No manifest for "unknown-backend"
    reg = new ManifestRegistry(silentLogger, dir);
  });

  it("classifies _send_ tool as WRITE by name-pattern", () => {
    const result = reg.classify("unknown-backend", "teams_send_message", "ub_teams_send_message");
    expect(result.safetyClass).toBe("WRITE");
    expect(result.source).toBe("name-pattern");
    expect(result.confirmationMapsToDownstream).toBe(false);
  });

  it("classifies _get_ tool as UNCLASSIFIED (verb-less, no write-verb match)", () => {
    const result = reg.classify("unknown-backend", "get_status", "ub_get_status");
    expect(result.safetyClass).toBe("UNCLASSIFIED");
    expect(result.source).toBe("unclassified");
  });

  it("classifies _delete tool as WRITE by name-pattern", () => {
    const result = reg.classify("unknown-backend", "record_delete", "ub_record_delete");
    expect(result.safetyClass).toBe("WRITE");
    expect(result.source).toBe("name-pattern");
  });

  it("classifies list_ tool as UNCLASSIFIED (verb-less, no write-verb match)", () => {
    const result = reg.classify("unknown-backend", "list_items", "ub_list_items");
    expect(result.safetyClass).toBe("UNCLASSIFIED");
    expect(result.source).toBe("unclassified");
  });
});

// ─── ManifestRegistry — malformed manifest is skipped ────────────────────────

describe("ManifestRegistry — malformed manifest is skipped without crash", () => {
  it("loads other manifests and skips the malformed one", () => {
    const dir = makeTempManifestDir();
    try {
      // Write a good manifest
      writeManifest(dir, "good.json", {
        manifest: "isaac-router-manifest/v1",
        backend: "good-backend",
        capabilities: [
          { tool: "get_thing", safety_class: "READ", tags: [] },
        ],
      });
      // Write a broken manifest (wrong schema version)
      writeFileSync(join(dir, "bad.json"), JSON.stringify({ manifest: "wrong", backend: "bad" }));

      const reg = new ManifestRegistry(silentLogger, dir);

      // Good manifest is loaded
      const result = reg.classify("good-backend", "get_thing", "good_get_thing");
      expect(result.safetyClass).toBe("READ");
      expect(result.source).toBe("manifest");

      // Bad backend falls back to name-pattern (not a crash)
      const fallback = reg.classify("bad", "send_x", "bad_send_x");
      expect(fallback.source).toBe("name-pattern");
    } finally {
      cleanDir(dir);
    }
  });
});

// ─── ManifestRegistry — confirmationMapsToDownstream defaults false ───────────

describe("ManifestRegistry — confirmationMapsToDownstream defaults", () => {
  it("defaults confirmation_maps_to_downstream to false when absent", () => {
    const dir = makeTempManifestDir();
    try {
      writeManifest(dir, "test.json", {
        manifest: "isaac-router-manifest/v1",
        backend: "test-svc",
        capabilities: [
          // No confirmation_maps_to_downstream field
          { tool: "send_alert", safety_class: "HUMAN_OUTBOUND", tags: ["alert"] },
        ],
      });
      const reg = new ManifestRegistry(silentLogger, dir);
      const result = reg.classify("test-svc", "send_alert", "test_send_alert");
      expect(result.confirmationMapsToDownstream).toBe(false);
    } finally {
      cleanDir(dir);
    }
  });
});

// ─── ManifestRegistry — VAULT_VALUE classification ───────────────────────────

describe("ManifestRegistry — VAULT_VALUE classification", () => {
  it("returns VAULT_VALUE for secret reads", () => {
    const dir = makeTempManifestDir();
    try {
      writeManifest(dir, "vault.json", {
        manifest: "isaac-router-manifest/v1",
        backend: "azure-key-vault-mcp",
        capabilities: [
          { tool: "get_secret", safety_class: "VAULT_VALUE", tags: ["vault"] },
        ],
      });
      const reg = new ManifestRegistry(silentLogger, dir);
      const result = reg.classify("azure-key-vault-mcp", "get_secret", "vault_get_secret");
      expect(result.safetyClass).toBe("VAULT_VALUE");
      expect(isGatedClass("VAULT_VALUE")).toBe(true);
    } finally {
      cleanDir(dir);
    }
  });
});

// ─── http_method field — RISKY_AS_READ exemption for GET-backed tools ────────

describe("validateManifestSemantics — http_method GET exempts RISKY_AS_READ", () => {
  it("flags a write-verb tool classified READ when http_method is absent (unchanged behavior)", () => {
    const manifest = ManifestFileSchema.parse({
      manifest: "isaac-router-manifest/v1",
      backend: "test-backend",
      capabilities: [{ tool: "svc_dns_resolve", safety_class: "READ", tags: [] }],
    });
    const violations = validateManifestSemantics(manifest);
    expect(violations.some((v) => v.rule === "RISKY_AS_READ" && v.tool === "svc_dns_resolve")).toBe(true);
  });

  it("does NOT flag the same tool when http_method is GET", () => {
    const manifest = ManifestFileSchema.parse({
      manifest: "isaac-router-manifest/v1",
      backend: "test-backend",
      capabilities: [
        { tool: "svc_dns_resolve", safety_class: "READ", tags: [], http_method: "GET" },
      ],
    });
    const violations = validateManifestSemantics(manifest);
    expect(violations).toEqual([]);
  });

  it("still flags a write-verb tool classified READ when http_method is a non-GET method", () => {
    const manifest = ManifestFileSchema.parse({
      manifest: "isaac-router-manifest/v1",
      backend: "test-backend",
      capabilities: [
        { tool: "svc_dns_resolve", safety_class: "READ", tags: [], http_method: "POST" },
      ],
    });
    const violations = validateManifestSemantics(manifest);
    expect(violations.some((v) => v.rule === "RISKY_AS_READ")).toBe(true);
  });

  it("a manifest with the GET exemption now LOADS instead of being rejected fail-closed", () => {
    const dir = makeTempManifestDir();
    try {
      writeManifest(dir, "svc.json", {
        manifest: "isaac-router-manifest/v1",
        backend: "svc-backend",
        capabilities: [
          { tool: "svc_dns_resolve", safety_class: "READ", tags: [], http_method: "GET" },
        ],
      });
      const reg = new ManifestRegistry(silentLogger, dir);
      const result = reg.classify("svc-backend", "svc_dns_resolve", "svc_svc_dns_resolve");
      // If the manifest had been rejected, this would fall back to
      // name-pattern WRITE (svc_dns_resolve matches the "resolve" write-verb
      // segment) instead of manifest READ.
      expect(result.safetyClass).toBe("READ");
      expect(result.source).toBe("manifest");
    } finally {
      cleanDir(dir);
    }
  });
});

// ─── shodan-go.json regression — shodan_dns_resolve RISKY_AS_READ fix ────────

describe("shodan-go.json manifest — shodan_dns_resolve RISKY_AS_READ regression fix", () => {
  it("shodan_dns_resolve declares http_method: GET", () => {
    const raw = readFileSync(join(process.cwd(), "manifests", "shodan-go.json"), "utf-8");
    const manifest = ManifestFileSchema.parse(JSON.parse(raw));
    const cap = manifest.capabilities.find((c) => c.tool === "shodan_dns_resolve");
    expect(cap).toBeDefined();
    expect(cap!.http_method).toBe("GET");
  });

  it("the real shodan-go.json manifest has zero semantic violations", () => {
    const raw = readFileSync(join(process.cwd(), "manifests", "shodan-go.json"), "utf-8");
    const manifest = ManifestFileSchema.parse(JSON.parse(raw));
    expect(validateManifestSemantics(manifest)).toEqual([]);
  });

  it("loading the real manifests dir classifies shodan_dns_resolve as manifest READ (not name-pattern WRITE)", () => {
    const manifestDir = join(process.cwd(), "manifests");
    const reg = new ManifestRegistry(silentLogger, manifestDir);
    const result = reg.classify("shodan-go", "shodan_dns_resolve", "shodan_shodan_dns_resolve");
    expect(result.safetyClass).toBe("READ");
    expect(result.source).toBe("manifest");
  });
});
