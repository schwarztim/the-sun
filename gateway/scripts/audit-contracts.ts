/**
 * audit-contracts.ts
 *
 * Offline contract audit for isaac-router-manifest/v1 safety manifests.
 *
 * Checks (in order):
 *  1. Schema validity       — every *.json must parse against ManifestFileSchema.
 *  2. Write-guard non-empty — if write_guard is declared, it must be non-empty.
 *                             (write_guard is optional in the schema; absent is
 *                             accepted. Only an explicitly empty string is a
 *                             violation. If you want to mandate write_guard on
 *                             all gated tools, tighten this check and update the
 *                             manifests in a coordinated Phase 4 pass.)
 *  3. Risky-as-read         — no tool whose name matches WRITE_VERB_REGEX may be
 *                             classified READ (catches write-verb tools mislabeled
 *                             read-safe).
 *  4. Duplicate tool        — no tool name may appear twice within one backend's
 *                             capabilities.
 *  5. Duplicate backend     — no backend name may appear in more than one file.
 *
 * DEFERRED: cross-checking manifest tool names against the live-harvested backend
 * schema (i.e., tools the backend actually advertises) requires a running gateway
 * connection. This is out of scope for this offline audit. Follow-up: add a
 * --live flag that connects to the gateway, fetches tool lists per backend, and
 * compares them against the manifest capabilities.
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { ManifestFileSchema, validateManifestSemantics } from "../src/manifest.js";

// ─── Public types ──────────────────────────────────────────────────────────────

export interface Violation {
  file: string;
  backend?: string;
  tool?: string;
  rule: string;
  detail: string;
}

export interface AuditResult {
  filesAudited: number;
  capabilitiesAudited: number;
  violations: Violation[];
}

// ─── Core audit function ───────────────────────────────────────────────────────

/**
 * Load and validate every *.json in manifestDir, returning structured
 * violations for every constraint that fails.
 *
 * @param manifestDir  Absolute path to the directory containing *.json
 *                     manifests.  Defaults to <cwd>/manifests.
 */
export function auditContracts(
  manifestDir: string = resolve(process.cwd(), "manifests")
): AuditResult {
  const violations: Violation[] = [];
  let filesAudited = 0;
  let capabilitiesAudited = 0;

  // Track backend → file for duplicate-backend check (check 5).
  const backendSeen = new Map<string, string>();

  let files: string[];
  try {
    files = readdirSync(manifestDir).filter((f) => f.endsWith(".json"));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    violations.push({
      file: manifestDir,
      rule: "DIR_UNREADABLE",
      detail: `Cannot read manifest directory: ${msg}`,
    });
    return { filesAudited: 0, capabilitiesAudited: 0, violations };
  }

  for (const filename of files) {
    const filePath = join(manifestDir, filename);
    filesAudited++;

    // ── Check 1: schema validity ──────────────────────────────────────────────
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf-8");
    } catch (err: unknown) {
      violations.push({
        file: filename,
        rule: "FILE_UNREADABLE",
        detail: `Cannot read file: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err: unknown) {
      violations.push({
        file: filename,
        rule: "INVALID_JSON",
        detail: `JSON parse error: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    const result = ManifestFileSchema.safeParse(parsed);
    if (!result.success) {
      violations.push({
        file: filename,
        rule: "SCHEMA_INVALID",
        detail: result.error.message,
      });
      continue;
    }

    const manifest = result.data;
    const { backend, capabilities } = manifest;

    // ── Check 5: duplicate backend across files ───────────────────────────────
    const priorFile = backendSeen.get(backend);
    if (priorFile !== undefined) {
      violations.push({
        file: filename,
        backend,
        rule: "DUPLICATE_BACKEND",
        detail: `Backend "${backend}" already declared in ${priorFile}`,
      });
      // Continue auditing — still check the capabilities in this file.
    } else {
      backendSeen.set(backend, filename);
    }

    // ── Checks 2-4: shared semantic validation ────────────────────────────────
    // Same checks the gateway runs at manifest load time (and rejects on) —
    // single source of truth in src/manifest.ts:validateManifestSemantics.
    capabilitiesAudited += capabilities.length;
    for (const v of validateManifestSemantics(manifest)) {
      violations.push({
        file: filename,
        backend,
        tool: v.tool,
        rule: v.rule,
        detail: v.detail,
      });
    }
  }

  return { filesAudited, capabilitiesAudited, violations };
}

// ─── CLI entry point ───────────────────────────────────────────────────────────

// ESM direct-invocation guard: compare this module's URL to argv[1].
const isMain =
  import.meta.url === pathToFileURL(process.argv[1] ?? "").href;

if (isMain) {
  const result = auditContracts();
  const { filesAudited, capabilitiesAudited, violations } = result;

  console.log(`\nmcp-gateway contract audit`);
  console.log(`  manifests dir : ${resolve(process.cwd(), "manifests")}`);
  console.log(`  files audited : ${filesAudited}`);
  console.log(`  capabilities  : ${capabilitiesAudited}`);
  console.log("");

  if (violations.length === 0) {
    console.log(`✓ All ${filesAudited} manifest(s) pass all checks — ${capabilitiesAudited} capabilities clean`);
  } else {
    // Group violations by file for readability.
    const byFile = new Map<string, Violation[]>();
    for (const v of violations) {
      const list = byFile.get(v.file) ?? [];
      list.push(v);
      byFile.set(v.file, list);
    }

    for (const [file, vList] of byFile) {
      console.log(`✗ ${file} (${vList.length} violation${vList.length === 1 ? "" : "s"})`);
      for (const v of vList) {
        const loc = [v.backend, v.tool].filter(Boolean).join(" > ");
        const prefix = loc ? `  [${v.rule}] ${loc}: ` : `  [${v.rule}] `;
        console.log(`${prefix}${v.detail}`);
      }
      console.log("");
    }

    console.error(`✗ ${violations.length} violation${violations.length === 1 ? "" : "s"} found — fix manifests before deploy`);
  }

  process.exit(violations.length > 0 ? 1 : 0);
}
