#!/usr/bin/env node
/**
 * CI/regression guard for the Hermes credential-vault migration.
 *
 * Asserts that no package source tree (each `packages/<name>/src`) references the old
 * shared external vault dependency (`node-vault-mcp`) or hardcodes a path into
 * the shared operator-wide `~/.claude/` vault (`secrets.vault` / `master.key`).
 * Both were replaced by the self-contained `@hermes/vault` package — see
 * `~/.claude/plans/draft-the-implementation-plan-cosmic-moth.md`.
 *
 * Usage:  node scripts/check-no-shared-vault.mjs
 * Exit:   0 = clean, 1 = one or more forbidden references found
 *
 * Deliberately dependency-free (walks the filesystem with `node:fs` directly)
 * so this guard has nothing else that can go stale or need installing.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const packagesDir = join(repoRoot, 'packages');

const FORBIDDEN_PATTERNS = [
  { name: 'node-vault-mcp reference', pattern: /node-vault-mcp/ },
  { name: 'hardcoded ~/.claude/ path', pattern: /~\/\.claude\// },
  { name: 'hardcoded .claude/secrets.vault path', pattern: /\.claude\/secrets\.vault/ },
  { name: 'hardcoded .claude/master.key path', pattern: /\.claude\/master\.key/ },
];

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);

/**
 * Recursive directory walk. Does NOT use `fs.readdirSync(dir, {recursive:
 * true})` — verified empirically that it aborts (SIGABRT) when it encounters
 * pnpm's symlink-heavy `node_modules` layout. Walking manually and skipping
 * symlinks and `node_modules`/`dist` by name avoids that entirely; `src`
 * directories never legitimately contain either.
 */
function walk(dir, files = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return files;
    throw err;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, files);
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(fullPath.slice(fullPath.lastIndexOf('.')))) {
      files.push(fullPath);
    }
  }
  return files;
}

function findSrcDirs() {
  let packageDirs;
  try {
    packageDirs = readdirSync(packagesDir, { withFileTypes: true });
  } catch (err) {
    throw new Error(`cannot read ${packagesDir}: ${err.message}`);
  }
  return packageDirs
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(packagesDir, entry.name, 'src'));
}

const hits = [];
for (const srcDir of findSrcDirs()) {
  for (const file of walk(srcDir)) {
    const text = readFileSync(file, 'utf8');
    for (const { name, pattern } of FORBIDDEN_PATTERNS) {
      if (pattern.test(text)) {
        const lineNumber = text.slice(0, text.search(pattern)).split('\n').length;
        hits.push({ file: relative(repoRoot, file), line: lineNumber, name });
      }
    }
  }
}

if (hits.length > 0) {
  console.error(`check-no-shared-vault: ${hits.length} forbidden reference(s) found:\n`);
  for (const hit of hits) {
    console.error(`  ${hit.file}:${hit.line}  ${hit.name}`);
  }
  console.error('\nThese must be removed/replaced with @hermes/vault before this check passes.');
  process.exit(1);
}

console.log('check-no-shared-vault: clean — no node-vault-mcp or ~/.claude/ references in packages/<name>/src');
