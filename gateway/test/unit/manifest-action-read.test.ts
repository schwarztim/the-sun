import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createLogger } from "../../src/logger.js";
import {
  ManifestRegistry,
  decideGate,
  refineForArgs,
  validateManifestSemantics,
  ManifestFileSchema,
} from "../../src/manifest.js";
import type { SafetyClass, SafetyClassification } from "../../src/manifest.js";
import type { EscalationConfig } from "../../src/escalation.js";

const silentLogger = createLogger("silent");

/**
 * Per-action safety classification (2026-08-19).
 *
 * An orchestrator MCP multiplexes 18 tools over an `action` enum, so every tool was
 * pinned to its most dangerous action and a pure read ("what is job X doing")
 * demanded a confirmation. These tests hold the line the fix must not cross:
 * the carve-out lowers a Tier-A class to READ ONLY for a manifest-declared
 * action value that is present, a string, and an exact match, and it can never
 * touch a Tier-B classification.
 */

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function classification(over: Partial<SafetyClassification> = {}): SafetyClassification {
  return {
    safetyClass: "SIDE_EFFECT",
    tags: ["orchestrator", "memory"],
    confirmationMapsToDownstream: false,
    source: "manifest",
    actionParam: "action",
    readActions: ["load", "search", "manifest"],
    ...over,
  };
}

function tmpManifestDir(files: Record<string, unknown>): string {
  const dir = join(tmpdir(), `manifest-action-read-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), JSON.stringify(body, null, 2));
  }
  return dir;
}

function cleanDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

// ─── refineForArgs — the read path ───────────────────────────────────────────

describe("refineForArgs — a declared read action resolves READ", () => {
  it("lowers SIDE_EFFECT to READ for a declared read action", () => {
    const refined = refineForArgs(classification(), { action: "load", scope: "job" });
    expect(refined!.safetyClass).toBe("READ");
    expect(refined!.source).toBe("manifest");
  });

  it("tags the refined classification with the action that earned it", () => {
    const refined = refineForArgs(classification(), { action: "search" });
    expect(refined!.tags).toContain("action-read:search");
    // Base tags survive, so content-guard tag rules still apply.
    expect(refined!.tags).toContain("orchestrator");
  });

  it("does not mutate the registry's static classification", () => {
    const base = classification();
    const refined = refineForArgs(base, { action: "load" });
    expect(base.safetyClass).toBe("SIDE_EFFECT");
    expect(base.tags).toEqual(["orchestrator", "memory"]);
    expect(refined).not.toBe(base);
  });

  it("a refined READ proceeds unconfirmed where the base class would block", () => {
    const base = classification();
    expect(decideGate(base, false, "blocking").action).toBe("block");
    expect(decideGate(refineForArgs(base, { action: "load" }), false, "blocking").action).toBe(
      "proceed"
    );
  });
});

// ─── refineForArgs — no privilege escalation ─────────────────────────────────

describe("refineForArgs — a write action still demands confirmation", () => {
  it("keeps the base class for an action that is not declared read", () => {
    const refined = refineForArgs(classification(), { action: "store", content: "x" });
    expect(refined!.safetyClass).toBe("SIDE_EFFECT");
    expect(refined!.tags).not.toContain("action-read:store");
  });

  it("same tool, two calls: the read proceeds and the write blocks", () => {
    const base = classification();
    const read = refineForArgs(base, { action: "load" });
    const write = refineForArgs(base, { action: "store" });
    expect(decideGate(read, false, "blocking").action).toBe("proceed");
    expect(decideGate(write, false, "blocking").action).toBe("block");
  });
});

// ─── refineForArgs — fail closed ─────────────────────────────────────────────

describe("refineForArgs — fail-closed fallbacks", () => {
  const base = classification();

  it("missing action argument falls back to the base class", () => {
    expect(refineForArgs(base, { scope: "job" })!.safetyClass).toBe("SIDE_EFFECT");
  });

  it("empty argument object falls back to the base class", () => {
    expect(refineForArgs(base, {})!.safetyClass).toBe("SIDE_EFFECT");
  });

  it("a non-string action falls back to the base class", () => {
    for (const value of [1, true, null, ["load"], { name: "load" }]) {
      expect(refineForArgs(base, { action: value })!.safetyClass).toBe("SIDE_EFFECT");
    }
  });

  it("an unknown action value falls back to the base class", () => {
    expect(refineForArgs(base, { action: "obliterate" })!.safetyClass).toBe("SIDE_EFFECT");
  });

  it("case and whitespace variants do not match (exact match only)", () => {
    for (const value of ["LOAD", "Load", " load", "load "]) {
      expect(refineForArgs(base, { action: value })!.safetyClass).toBe("SIDE_EFFECT");
    }
  });

  it("non-object arguments fall back to the base class", () => {
    for (const args of [null, undefined, "load", 7, ["load"]]) {
      expect(refineForArgs(base, args)!.safetyClass).toBe("SIDE_EFFECT");
    }
  });

  it("an inherited property is not a declared action (no prototype-chain match)", () => {
    const proto = { action: "load" };
    const args = Object.create(proto) as Record<string, unknown>;
    expect(refineForArgs(base, args)!.safetyClass).toBe("SIDE_EFFECT");
  });

  it("an undefined classification stays undefined", () => {
    expect(refineForArgs(undefined, { action: "load" })).toBeUndefined();
  });
});

// ─── refineForArgs — tools that declare nothing are untouched ────────────────

describe("refineForArgs — a tool with no read_actions is unaffected", () => {
  it("returns the same object when no carve-out is declared", () => {
    const plain = classification({ actionParam: undefined, readActions: undefined });
    const refined = refineForArgs(plain, { action: "load" });
    expect(refined).toBe(plain);
    expect(refined!.safetyClass).toBe("SIDE_EFFECT");
  });

  it("an empty read_actions list is not a carve-out", () => {
    const plain = classification({ readActions: [] });
    expect(refineForArgs(plain, { action: "load" })!.safetyClass).toBe("SIDE_EFFECT");
  });

  it("a declared list with no action_param never fires", () => {
    const plain = classification({ actionParam: undefined });
    expect(refineForArgs(plain, { action: "load" })!.safetyClass).toBe("SIDE_EFFECT");
  });

  it("a name-pattern classification is never refined", () => {
    const guessed = classification({ safetyClass: "WRITE", source: "name-pattern" });
    expect(refineForArgs(guessed, { action: "load" })!.safetyClass).toBe("WRITE");
  });

  it("an already-READ tool is returned untouched", () => {
    const read = classification({ safetyClass: "READ" });
    expect(refineForArgs(read, { action: "load" })).toBe(read);
  });
});

// ─── refineForArgs — Tier-B is never downgraded ──────────────────────────────

describe("refineForArgs — Tier-B refuses the carve-out at dispatch", () => {
  const tierB: SafetyClass[] = ["PRODUCTION", "VAULT_VALUE", "HUMAN_OUTBOUND"];

  it("never lowers a Tier-B class even if a carve-out is somehow present", () => {
    for (const c of tierB) {
      const refined = refineForArgs(classification({ safetyClass: c }), { action: "load" });
      expect(refined!.safetyClass).toBe(c);
    }
  });

  it("never lowers a capability carrying a write_guard", () => {
    const guarded = classification({ writeGuard: "policy:destructive-verb" });
    expect(refineForArgs(guarded, { action: "load" })!.safetyClass).toBe("SIDE_EFFECT");
  });
});

// ─── Manifest semantics — the load-time guards ───────────────────────────────

describe("validateManifestSemantics — action carve-out rules", () => {
  function manifest(cap: Record<string, unknown>) {
    return ManifestFileSchema.parse({
      manifest: "isaac-router-manifest/v1",
      backend: "b",
      capabilities: [{ tool: "t_multiplexed", ...cap }],
    });
  }

  it("accepts a well-formed carve-out", () => {
    const violations = validateManifestSemantics(
      manifest({ safety_class: "SIDE_EFFECT", action_param: "action", read_actions: ["load"] })
    );
    expect(violations).toEqual([]);
  });

  it("rejects read_actions with no action_param (ACTION_PARAM_MISSING)", () => {
    const violations = validateManifestSemantics(
      manifest({ safety_class: "SIDE_EFFECT", read_actions: ["load"] })
    );
    expect(violations.map((v) => v.rule)).toContain("ACTION_PARAM_MISSING");
  });

  it("rejects a blank action_param (ACTION_PARAM_MISSING)", () => {
    const violations = validateManifestSemantics(
      manifest({ safety_class: "SIDE_EFFECT", action_param: "  ", read_actions: ["load"] })
    );
    expect(violations.map((v) => v.rule)).toContain("ACTION_PARAM_MISSING");
  });

  it("rejects a blank read action (ACTION_READ_BLANK)", () => {
    const violations = validateManifestSemantics(
      manifest({ safety_class: "SIDE_EFFECT", action_param: "action", read_actions: ["load", ""] })
    );
    expect(violations.map((v) => v.rule)).toContain("ACTION_READ_BLANK");
  });

  it("rejects a carve-out on a PRODUCTION capability (ACTION_READ_ON_TIER_B)", () => {
    const violations = validateManifestSemantics(
      manifest({ safety_class: "PRODUCTION", action_param: "action", read_actions: ["get"] })
    );
    expect(violations.map((v) => v.rule)).toContain("ACTION_READ_ON_TIER_B");
  });

  it("rejects a carve-out on VAULT_VALUE and HUMAN_OUTBOUND too", () => {
    for (const safety_class of ["VAULT_VALUE", "HUMAN_OUTBOUND"]) {
      const violations = validateManifestSemantics(
        manifest({ safety_class, action_param: "action", read_actions: ["get"] })
      );
      expect(violations.map((v) => v.rule)).toContain("ACTION_READ_ON_TIER_B");
    }
  });

  it("rejects a carve-out on a write_guard capability (ACTION_READ_ON_TIER_B)", () => {
    const violations = validateManifestSemantics(
      manifest({
        safety_class: "SIDE_EFFECT",
        write_guard: "needs-approval",
        action_param: "action",
        read_actions: ["get"],
      })
    );
    expect(violations.map((v) => v.rule)).toContain("ACTION_READ_ON_TIER_B");
  });

  it("a capability that declares no carve-out raises none of these rules", () => {
    const violations = validateManifestSemantics(manifest({ safety_class: "SIDE_EFFECT" }));
    expect(violations).toEqual([]);
  });
});

// ─── ManifestRegistry — end to end through a real manifest file ──────────────

describe("ManifestRegistry — carve-out survives load and classification", () => {
  it("carries action_param and read_actions onto the classification", () => {
    const dir = tmpManifestDir({
      "b.json": {
        manifest: "isaac-router-manifest/v1",
        backend: "b",
        capabilities: [
          {
            tool: "b_memory",
            safety_class: "SIDE_EFFECT",
            action_param: "action",
            read_actions: ["load", "search"],
          },
        ],
      },
    });
    try {
      const reg = new ManifestRegistry(silentLogger, dir);
      const cls = reg.classify("b", "b_memory", "b_b_memory");
      expect(cls.safetyClass).toBe("SIDE_EFFECT");
      expect(cls.actionParam).toBe("action");
      expect(refineForArgs(cls, { action: "search" })!.safetyClass).toBe("READ");
      expect(refineForArgs(cls, { action: "store" })!.safetyClass).toBe("SIDE_EFFECT");
    } finally {
      cleanDir(dir);
    }
  });

  it("a manifest that carves out a Tier-B tool is REJECTED, and the tool stays gated", () => {
    const dir = tmpManifestDir({
      "b.json": {
        manifest: "isaac-router-manifest/v1",
        backend: "b",
        capabilities: [
          {
            tool: "b_executor",
            safety_class: "PRODUCTION",
            action_param: "operation",
            read_actions: ["get_anything"],
          },
        ],
      },
    });
    try {
      const reg = new ManifestRegistry(silentLogger, dir);
      const cls = reg.classify("b", "b_executor", "b_b_executor");
      // Manifest labels ignored: falls back to the fail-closed default, which
      // is still gated, and carries no carve-out to refine.
      expect(cls.source).not.toBe("manifest");
      expect(cls.safetyClass).toBe("UNCLASSIFIED");
      expect(refineForArgs(cls, { operation: "get_anything" })!.safetyClass).toBe("UNCLASSIFIED");
    } finally {
      cleanDir(dir);
    }
  });
});

// ─── Regressions against the REAL shipped manifests ──────────────────────────

const REAL_MANIFEST_DIR = join(process.cwd(), "manifests");

/** Mirrors the live gateway config (config.fleet.yaml safety.escalation). */
const LIVE_ESCALATION: EscalationConfig = {
  enabled: true,
  delete_method_to_tier_b: true,
  destructive_verbs: ["delete", "remove", "purge", "destroy", "drop", "terminate", "kill", "revoke", "wipe", "erase", "shutdown", "deprovision", "force"],
  outbound_verbs: ["send", "reply", "email", "notify", "broadcast", "publish", "comment", "message"],
  production_backends: ["akamai-go"],
  exempt: [],
};

describe("akamai_raw_request stays PRODUCTION after the per-action change", () => {
  it("classifies PRODUCTION from the real manifests directory", () => {
    const reg = new ManifestRegistry(silentLogger, REAL_MANIFEST_DIR);
    const cls = reg.classify("akamai-go", "akamai_raw_request", "akamai_akamai_raw_request");
    expect(cls.safetyClass).toBe("PRODUCTION");
    expect(cls.source).toBe("manifest");
  });

  it("classifies PRODUCTION with the live escalation overlay applied", () => {
    const reg = new ManifestRegistry(silentLogger, REAL_MANIFEST_DIR, {
      escalation: LIVE_ESCALATION,
    });
    expect(
      reg.classify("akamai-go", "akamai_raw_request", "akamai_akamai_raw_request").safetyClass
    ).toBe("PRODUCTION");
  });

  it("declares no carve-out, and no argument can refine it", () => {
    const reg = new ManifestRegistry(silentLogger, REAL_MANIFEST_DIR, {
      escalation: LIVE_ESCALATION,
    });
    const cls = reg.classify("akamai-go", "akamai_raw_request", "akamai_akamai_raw_request");
    expect(cls.readActions).toBeUndefined();
    for (const args of [
      { action: "load" },
      { operation: "akamai_papi_get-properties" },
      { toolName: "akamai_papi_get-properties" },
    ]) {
      expect(refineForArgs(cls, args)!.safetyClass).toBe("PRODUCTION");
    }
  });

  it("the real akamai-go manifest declares read_actions nowhere", () => {
    const raw = readFileSync(join(REAL_MANIFEST_DIR, "akamai-go.json"), "utf-8");
    const manifest = ManifestFileSchema.parse(JSON.parse(raw));
    for (const cap of manifest.capabilities) {
      expect(cap.read_actions).toEqual([]);
    }
  });
});

describe("a per-action classification fixture on a synthetic action-multiplexed backend", () => {
  function orchestratorManifestDir(): string {
    return tmpManifestDir({
      "orchestrator.json": {
        manifest: "isaac-router-manifest/v1",
        backend: "orchestrator",
        capabilities: [
          {
            tool: "orchestrator_memory",
            safety_class: "SIDE_EFFECT",
            action_param: "action",
            read_actions: ["load", "search", "manifest"],
          },
          {
            tool: "orchestrator_job",
            safety_class: "SIDE_EFFECT",
            action_param: "action",
            read_actions: ["list", "get"],
          },
        ],
      },
    });
  }

  it("has zero semantic violations", () => {
    const dir = orchestratorManifestDir();
    try {
      const raw = readFileSync(join(dir, "orchestrator.json"), "utf-8");
      expect(validateManifestSemantics(ManifestFileSchema.parse(JSON.parse(raw)))).toEqual([]);
    } finally {
      cleanDir(dir);
    }
  });

  it("orchestrator_memory: a read action proceeds, a write action blocks", () => {
    const dir = orchestratorManifestDir();
    try {
      const reg = new ManifestRegistry(silentLogger, dir, { escalation: LIVE_ESCALATION });
      const cls = reg.classify("orchestrator", "orchestrator_memory", "orchestrator_orchestrator_memory");
      expect(cls.safetyClass).toBe("SIDE_EFFECT");
      expect(decideGate(refineForArgs(cls, { action: "search" }), false, "blocking").action).toBe(
        "proceed"
      );
      expect(decideGate(refineForArgs(cls, { action: "store" }), false, "blocking").action).toBe(
        "block"
      );
    } finally {
      cleanDir(dir);
    }
  });

  it("orchestrator_job: list and get proceed, create and cancel block", () => {
    const dir = orchestratorManifestDir();
    try {
      const reg = new ManifestRegistry(silentLogger, dir, { escalation: LIVE_ESCALATION });
      const cls = reg.classify("orchestrator", "orchestrator_job", "orchestrator_orchestrator_job");
      for (const action of ["list", "get"]) {
        expect(decideGate(refineForArgs(cls, { action }), false, "blocking").action).toBe("proceed");
      }
      for (const action of ["create", "cancel", "start"]) {
        expect(decideGate(refineForArgs(cls, { action }), false, "blocking").action).toBe("block");
      }
    } finally {
      cleanDir(dir);
    }
  });
});
