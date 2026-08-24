/**
 * Gate 5 — Credential scan.
 *
 * Pure filesystem check, no live server needed. Reuses
 * `detectHardcodedConfig` (src/generator/config-abstraction.ts:389) after
 * its pattern set was broadened (Stage 2) to also catch JWTs, AWS access
 * keys, Azure AD client secrets, and generic hardcoded Bearer/high-entropy
 * tokens — previously only domains/`sk-`/`ghp_`/`xoxb-`/emails/IPv4.
 *
 * Coverage note: the file set below must track what the generator actually
 * emits. Go is the default output language, so `.go`, `Dockerfile` and
 * `.env.example` are all in scope; a gate that only reads `.py` on a Go server
 * is a pass that proves nothing.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { detectHardcodedConfig } from "../../generator/config-abstraction.js";
import type { GateFinding } from "../types.js";

// `.go` is first because Go is the generator's DEFAULT output language: without
// it this gate inspected only the three JSON manifests of a generated Go server
// (main.go, Dockerfile and .env.example all fell outside the set) and passed
// vacuously on the very language most servers ship in.
const SCAN_EXTENSIONS = new Set([".go", ".py", ".ts", ".js", ".json", ".env", ".toml", ".yaml", ".yml"]);
// Files a generated server ships whose extension does not classify them:
// `Dockerfile` has no extension at all, and `.env.example`'s extname is
// ".example", not ".env" (the `.env` prefix rule below covers that whole family,
// including `.env.local`).
const SCAN_FILENAMES = new Set(["Dockerfile"]);
const SKIP_DIRS = new Set(["__pycache__", "node_modules", ".git", ".venv", "venv", "dist", "build"]);

function isScannable(name: string): boolean {
  return SCAN_EXTENSIONS.has(path.extname(name)) || SCAN_FILENAMES.has(name) || name.startsWith(".env");
}

async function collectFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await collectFiles(full)));
    } else if (isScannable(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

export async function runCredentialScanGate(serverDir: string): Promise<GateFinding> {
  const files = await collectFiles(serverDir);
  const issues: string[] = [];
  for (const file of files) {
    const content = await fs.readFile(file, "utf-8").catch(() => "");
    for (const issue of detectHardcodedConfig(content)) {
      issues.push(`${path.relative(serverDir, file)}: ${issue}`);
    }
  }
  return {
    gate: "credential-scan",
    passed: issues.length === 0,
    message:
      issues.length === 0
        ? `scanned ${files.length} file(s), no hardcoded credentials found`
        : `${issues.length} potential hardcoded credential(s) found`,
    detail: issues,
  };
}
