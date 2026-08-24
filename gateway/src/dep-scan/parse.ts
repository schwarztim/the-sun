/**
 * parseInstallCommand — pure, no-I/O extraction of the packages an install
 * command would fetch. Deliberately over-splits and over-strips: false
 * negatives (miss an install) fail open; the parser never throws.
 */
import type { Ecosystem, ParsedInstall, PkgSpec } from "./types.js";

/** Split a compound command into segments on any shell separator. */
function dechain(cmd: string): string[] {
  // Deliberately over-split, even inside quotes — we only read package tokens,
  // so an over-split segment at worst yields no install match.
  return cmd.split(/&&|\|\||;|\||\n/g);
}

/** Tokenize a segment on whitespace, dropping empties. */
function tokenize(segment: string): string[] {
  return segment.trim().split(/\s+/).filter((t) => t.length > 0);
}

const BARE_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Strip leading command wrappers: sudo / time / command / nohup, env VAR=val…,
 * xargs [flags], and bare VAR=VAL assignments. Returns the residual tokens.
 */
function stripLeadingWrappers(tokens: string[]): string[] {
  const t = [...tokens];
  for (;;) {
    const head = t[0];
    if (head === undefined) break;

    if (BARE_ASSIGN.test(head)) {
      t.shift();
      continue;
    }
    if (head === "sudo" || head === "time" || head === "command" || head === "nohup") {
      t.shift();
      continue;
    }
    if (head === "env") {
      t.shift();
      // Drop env's inline VAR=val assignments.
      while (t[0] !== undefined && BARE_ASSIGN.test(t[0])) t.shift();
      continue;
    }
    if (head === "xargs") {
      t.shift();
      // Drop xargs flags (best-effort — xargs' real payload follows).
      while (t[0] !== undefined && t[0].startsWith("-")) t.shift();
      continue;
    }
    break;
  }
  return t;
}

interface InstallMatch {
  ecosystem: Ecosystem;
  /** Index into the residual tokens where package args begin. */
  argStart: number;
}

/**
 * Match the install allowlist against the head of the residual tokens.
 * Returns null when the segment is not an install we scan.
 */
function matchInstall(t: string[]): InstallMatch | null {
  const [a, b, c, d] = t;

  // npm install|i|add  (NOT ci / run / uninstall / remove)
  if (a === "npm") {
    if (b === "install" || b === "i" || b === "add") return { ecosystem: "npm", argStart: 2 };
    return null;
  }
  if (a === "yarn" && b === "add") return { ecosystem: "npm", argStart: 2 };
  if (a === "pnpm" && b === "add") return { ecosystem: "npm", argStart: 2 };

  // pip / pip3 install
  if ((a === "pip" || a === "pip3") && b === "install") return { ecosystem: "PyPI", argStart: 2 };
  // python[3] -m pip install
  if ((a === "python" || a === "python3") && b === "-m" && c === "pip" && d === "install")
    return { ecosystem: "PyPI", argStart: 4 };
  if (a === "poetry" && b === "add") return { ecosystem: "PyPI", argStart: 2 };
  // uv add  /  uv pip install
  if (a === "uv" && b === "add") return { ecosystem: "PyPI", argStart: 2 };
  if (a === "uv" && b === "pip" && c === "install") return { ecosystem: "PyPI", argStart: 3 };

  if (a === "cargo" && b === "add") return { ecosystem: "crates.io", argStart: 2 };
  if (a === "go" && b === "get") return { ecosystem: "Go", argStart: 2 };
  if (a === "gem" && b === "install") return { ecosystem: "RubyGems", argStart: 2 };

  return null;
}

// Redirection operators with no attached target: consume themselves + next token.
const REDIR_PURE = /^([0-9]*|&)>>?$/;
// Self-contained redirection (operator + target in one token, e.g. 2>&1, 2>/dev/null, >out.log).
// Anchored so package specs like `hono@>=4.12` (start with a name) never match.
const REDIR_SELF = /^([0-9]*|&)>>?(&[0-9]+|.+)$/;

/** Remove shell redirections from residual args before reading package names. */
function stripRedirections(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (REDIR_PURE.test(tok)) {
      i++; // also drop the redirection target that follows
      continue;
    }
    if (REDIR_SELF.test(tok)) {
      continue; // self-contained — drop only this token
    }
    out.push(tok);
  }
  return out;
}

// Flags that consume the following token as their value.
const VALUE_FLAGS = new Set([
  "--registry",
  "--index-url",
  "--extra-index-url",
  "--index",
  "--default-index",
  "--prefix",
  "--target",
  "--python",
  "--proxy",
  "--timeout",
  "--cache-dir",
  "-i",
  "-p",
  "-t",
]);

/** Tokens that are never package names. */
function isNonPackageTarget(tok: string): boolean {
  return (
    /^https?:/.test(tok) ||
    /^git\+/.test(tok) ||
    /^file:/.test(tok) ||
    /^\.\//.test(tok) ||
    /^\//.test(tok) ||
    /^~\//.test(tok) ||
    /\.txt$/.test(tok) ||
    /\.whl$/.test(tok) ||
    /\.tar\.gz$/.test(tok) ||
    /\.tgz$/.test(tok)
  );
}

// Pip-style comparison operators, longest first so `>=` beats `>`.
const PIP_OP = /^(.+?)(===|==|>=|<=|~=|!=|>|<)(.*)$/;

/** Split a single package token into name + optional version spec. */
function parsePackageToken(token: string, ecosystem: Ecosystem): PkgSpec {
  if (ecosystem === "PyPI") {
    const m = token.match(PIP_OP);
    if (m) return { name: m[1], versionSpec: `${m[2]}${m[3]}` };
    return { name: token };
  }
  // npm / crates.io / Go / RubyGems: split on the LAST '@' so npm scopes
  // (@scope/foo@1.2.3) and Go module versions (mod@v1.2.3) parse correctly.
  const at = token.lastIndexOf("@");
  if (at > 0) return { name: token.slice(0, at), versionSpec: token.slice(at + 1) };
  return { name: token };
}

/** Extract package specs from the residual (post-redirection) args. */
function extractPackages(args: string[], ecosystem: Ecosystem): PkgSpec[] {
  const cleaned = stripRedirections(args);
  const pkgs: PkgSpec[] = [];
  for (let i = 0; i < cleaned.length; i++) {
    const tok = cleaned[i];
    if (tok.startsWith("-")) {
      // A value-taking flag consumes the next token too (unless it uses `=`).
      if (VALUE_FLAGS.has(tok)) i++;
      continue;
    }
    if (isNonPackageTarget(tok)) continue;
    const spec = parsePackageToken(tok, ecosystem);
    if (spec.name.length > 0) pkgs.push(spec);
  }
  return pkgs;
}

/**
 * Parse an install command. Returns the first install match in the chain, or
 * null when there is no install / no named packages (bare install → null).
 */
export function parseInstallCommand(cmd: string): ParsedInstall | null {
  if (typeof cmd !== "string" || cmd.trim() === "") return null;

  for (const segment of dechain(cmd)) {
    const tokens = stripLeadingWrappers(tokenize(segment));
    if (tokens.length === 0) continue;
    const match = matchInstall(tokens);
    if (!match) continue;

    // First install match governs: extract its packages; a bare install
    // (zero named packages) resolves to null and short-circuits the chain.
    const packages = extractPackages(tokens.slice(match.argStart), match.ecosystem);
    if (packages.length === 0) return null;
    return { ecosystem: match.ecosystem, packages };
  }
  return null;
}
