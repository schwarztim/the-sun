// thesun universal client-hook decision core (Phase 1b).
//
// ONE policy brain, shared by every client adapter:
//   - thesun-hook.mjs        → Claude Code / Copilot CLI / Copilot VS Code / Codex CLI
//   - opencode-plugin.ts     → OpenCode (tool.execute.before)
//
// Dependency-free, snapshot-read-only, and — on the hot path (reads, non-install
// commands) — NO network I/O, so it finishes well under 100ms (the ceiling both
// Claude and Copilot CLI impose; timeout = fail-open on both). It never
// re-implements gateway classification: the gateway writes policy-snapshot.json
// into THESUN_HOME (gateway/src/policy-snapshot.ts) and this core only reads it.
//
// RULE ORDER (docs/SECURITY-ROADMAP.md Phase 1b + the verified
// copilot-cli-hook-contract memory + operator scope additions):
//   0. self-repair carve-out  — never block edits/reads of the hook's OWN files
//   1. credential-file guard   — deny reads of a credential store (transcript leak)
//   2. tier policy (mcp tools) — Tier-A confirmed→gate, Tier-B→pass-through, READ→pass
//   3. dep-scan (async, exec)  — shift-left vuln veto on package installs
// Steps 0-2 are synchronous (decide); step 3 is async (decideDepScan), run by the
// caller only when decide() already allowed.
//
// FAIL DIRECTION IS ALWAYS ALLOW: a missing/corrupt snapshot, an unreachable
// dep-scan endpoint, an unrecognized tool, or any thrown error → allow. The hook
// is a first line of defense; the gateway floor is the guarantee.

import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export const SNAPSHOT_FILENAME = "policy-snapshot.json";
export const HOOK_MODES = ["off", "ask", "deny"];

// ─── env resolution ────────────────────────────────────────────────────────────
// resolveThesunHome mirrors gateway/src/approvals.ts + fleet paths.go EXACTLY.

export function resolveThesunHome(env = process.env) {
  if (env.THESUN_HOME) return env.THESUN_HOME;
  const home = homedir();
  const plat = platform();
  if (plat === "darwin") return join(home, "Library", "Application Support", "thesun");
  if (plat === "win32") return join(env.APPDATA ?? join(home, "AppData", "Roaming"), "thesun");
  return join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "thesun");
}

function normMode(v, def) {
  const m = (v ?? def).trim().toLowerCase();
  return HOOK_MODES.includes(m) ? m : def;
}
/** Tier-A self-confirm gate mode (THESUN_HOOK_MODE), default "ask". */
export function resolveTierMode(env = process.env) {
  return normMode(env.THESUN_HOOK_MODE, "ask");
}
/** Backward-compatible alias. */
export const resolveMode = resolveTierMode;
/** Credential-file guard mode (THESUN_HOOK_CRED_GUARD), default "deny". */
export function resolveCredMode(env = process.env) {
  return normMode(env.THESUN_HOOK_CRED_GUARD, "deny");
}
/** Dep-scan enabled unless DEP_SCAN_DISABLE=1. */
export function depScanEnabled(env = process.env) {
  return env.DEP_SCAN_DISABLE !== "1";
}
/** Loopback dep-scan endpoint: explicit override, else snapshot.gatewayUrl + /dep-scan. */
export function resolveDepScanUrl(env, snapshot) {
  if (env && env.THESUN_DEPSCAN_URL) return env.THESUN_DEPSCAN_URL;
  const base = snapshot && typeof snapshot.gatewayUrl === "string" ? snapshot.gatewayUrl : "";
  if (!base) return "";
  return base.replace(/\/(mcp\/?)?$/, "") + "/dep-scan";
}

// ─── snapshot load (fail-open: any error → null → allow-everything) ─────────────

export function loadSnapshot(home) {
  try {
    const path = join(home, SNAPSHOT_FILENAME);
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf-8");
    if (!raw.trim()) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || typeof parsed.tools !== "object" || parsed.tools === null) {
      return null;
    }
    return parsed;
  } catch (e) {
    process.stderr.write(`thesun-hook: snapshot load failed (allowing): ${e?.message ?? e}\n`);
    return null;
  }
}

// ─── input-envelope normalization (Claude / Copilot / Codex / VS Code / OpenCode) ─

export function extractToolName(input) {
  if (!input || typeof input !== "object") return "";
  const candidates = [
    input.toolName,
    input.tool_name,
    input.name,
    input.tool && (typeof input.tool === "string" ? input.tool : input.tool.name),
    input.params && input.params.name,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c) return c;
  }
  return "";
}

export function extractArgs(input) {
  if (!input || typeof input !== "object") return {};
  const raw =
    input.toolArgs ??
    input.tool_input ??
    input.toolInput ??
    input.arguments ??
    (input.params && input.params.arguments) ??
    input.input;
  if (raw == null) return {};
  if (typeof raw === "string") {
    // Copilot CLI camelCase mode: toolArgs is a JSON STRING — parse it.
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof raw === "object" ? raw : {};
}

/** True when the input looks like Copilot CLI's camelCase envelope (flat-output client). */
export function isCopilotCamel(input) {
  if (!input || typeof input !== "object") return false;
  if (input.hook_event_name || input.tool_name || input.tool_input) return false; // vscode-alias / Claude
  return input.toolName != null || input.toolArgs != null || input.sessionId != null;
}

// ─── gateway tool-name → snapshot key candidates ────────────────────────────────
//
// EMPIRICAL per-client runtime tool-name shapes (verified 2026-07-07, remote
// server `echo`, tool `echo`):
//   Claude Code : mcp__echo__echo   (mcp__<server>__<tool>, double underscore)
//   Codex CLI   : mcp__echo__echo   (identical to Claude)
//   Copilot CLI : echo-echo         (<server>-<tool>, HYPHEN)
//   OpenCode    : echo_echo         (<server>_<tool>, single underscore)
// In thesun the <server> is the gateway ("mcp-gateway") and the <tool> is the
// gateway namespacedName (the snapshot key, e.g. "gh_delete_repo"). The tool key
// is therefore a SUFFIX of the runtime string after a separator. We emit the
// tail after every '-' and '_' (longest/leftmost first) plus the mcp__ form, and
// look each up; the exact snapshot key is guaranteed to be among the candidates
// regardless of which join style the client used. Do NOT rely on "mcp__" for
// Copilot/OpenCode.

export function lookupKeys(rawToolName) {
  const keys = [];
  const push = (k) => {
    if (typeof k === "string" && k && !keys.includes(k)) keys.push(k);
  };
  const name = String(rawToolName ?? "");
  push(name);
  // Claude / Codex: mcp__<server>__<tool> → drop the first two "__" segments.
  if (name.startsWith("mcp__")) {
    const segs = name.split("__");
    if (segs.length > 2) push(segs.slice(2).join("__"));
  }
  // Copilot (hyphen) / OpenCode (underscore) / any mixed join: the tool key is a
  // suffix after a separator. Emit the tail after each '-' and '_', left to right
  // so the longest (correct) tail is tried before shorter ambiguous ones.
  for (let i = 0; i < name.length; i++) {
    const ch = name[i];
    if (ch === "-" || ch === "_") push(name.slice(i + 1));
  }
  return keys;
}

export function lookupEntry(snapshot, rawToolName) {
  if (!snapshot || !snapshot.tools) return null;
  for (const key of lookupKeys(rawToolName)) {
    const e = snapshot.tools[key];
    if (e) return e;
  }
  return null;
}

// ─── built-in client tool classification (file-read vs exec) ────────────────────

// Tool names are per-client and they do NOT converge. A name missing from these
// sets is not a cosmetic gap: builtinToolKind returns null, every guard below
// short-circuits, and the call is ALLOWED. That is silent, so treat these sets
// as the real allowlist boundary. Gemini CLI's names (run_shell_command,
// read_many_files, list_directory, search_file_content, replace) were verified
// against the 0.46.0 bundle, not guessed.
const EXEC_TOOLS = new Set([
  "bash", "shell", "sh", "exec", "run", "command", "powershell",
  "local_shell", "execute_command", "executecommand",
  "run_shell_command", // Gemini CLI
]);
const FILE_TOOLS = new Set([
  "read", "view", "cat", "grep", "glob", "readfile", "read_file", "fs_read",
  "read_many_files", "list_directory", "search_file_content", // Gemini CLI
]);

// Built-in tools that WRITE. Deliberately absent from FILE_TOOLS above: the
// credential guard is about reads, and classifying a write as "file" would deny
// writing a file whose path merely resembles a credential store. The transport
// guard needs them, though, because a bad backend config does its damage when it
// is written, not when it is read.
const WRITE_TOOLS = new Set([
  "write", "edit", "multiedit", "notebookedit", "notebook_edit",
  "create_file", "write_file", "writefile", "str_replace_editor",
  "apply_patch", "fs_write", "update_file", "edit_file",
  "replace", // Gemini CLI's in-place edit tool
]);

/** True for a client BUILT-IN tool that writes file content (not an mcp__ tool). */
export function isBuiltinWriteTool(toolName) {
  const n = String(toolName ?? "").toLowerCase();
  if (n.startsWith("mcp__") || n.includes("(")) return false;
  return WRITE_TOOLS.has(n);
}

/** "exec" | "file" | null — classifies a client BUILT-IN tool (not an mcp__ tool). */
export function builtinToolKind(toolName) {
  const n = String(toolName ?? "").toLowerCase();
  if (n.startsWith("mcp__") || n.includes("(")) return null; // mcp gateway tool, not a built-in
  if (EXEC_TOOLS.has(n)) return "exec";
  if (FILE_TOOLS.has(n)) return "file";
  return null;
}

/** Pull the shell command string out of an exec tool's args, if any. */
export function extractCommand(args) {
  if (!args || typeof args !== "object") return "";
  const c = args.command ?? args.cmd ?? args.script ?? args.command_line ?? args.commandLine;
  if (Array.isArray(c)) return c.join(" ");
  return typeof c === "string" ? c : "";
}

/** All string-valued args (shallow) + the command — the surface cred/self-repair scan. */
export function candidateStrings(input) {
  const args = extractArgs(input);
  const out = [];
  const command = extractCommand(args);
  if (command) out.push(command);
  for (const v of Object.values(args)) {
    if (typeof v === "string" && v) out.push(v);
    else if (Array.isArray(v)) for (const x of v) if (typeof x === "string" && x) out.push(x);
  }
  return { candidates: out, command };
}

// ─── path normalization ─────────────────────────────────────────────────────────

function expandHome(s, home) {
  return String(s)
    .replace(/\$\{HOME\}/g, home)
    .replace(/\$HOME/g, home)
    .replace(/(^|[\s"'=:])~(?=[\/\\])/g, `$1${home}`);
}

// ─── self-repair carve-out ───────────────────────────────────────────────────────
// Never deny (or dep-scan-veto) a call that touches the hook's OWN files/config —
// otherwise a session could be deadlocked out of fixing the hook.

const SELF_REPAIR_FRAGMENTS = [
  "packaging/hooks",
  "packaging\\hooks",
  "thesun-hook.mjs",
  "thesun-opencode-plugin.ts",
  "opencode-plugin.ts",
  "/hooks/thesun.json",
  "\\hooks\\thesun.json",
  ".codex/hooks.json",
  ".codex\\hooks.json",
  "opencode/plugin",
  "opencode\\plugin",
  "Code/User/hooks.json",
  "Code\\User\\hooks.json",
  ".claude/settings.json",
  ".claude\\settings.json",
];

export function isSelfRepairTarget(candidates) {
  for (const c of candidates) {
    const s = String(c);
    for (const frag of SELF_REPAIR_FRAGMENTS) {
      if (s.includes(frag)) return true;
    }
  }
  return false;
}

// Write/edit tools name their target file in one of these args. Exec/shell tools
// do NOT: their only string is a free-form command, which must never be treated
// as a self-repair target (see the SEC-1 bypass cited in decide() step 0).
const WRITE_TARGET_ARG_KEYS = ["file_path", "filePath", "path", "notebook_path", "notebookPath"];

/**
 * Resolved TARGET PATHS of a file-write/edit call (file_path/path/notebook_path),
 * with ~ and $HOME expanded. Returns [] for exec/shell tools (they carry a command,
 * not a write target) and for tools with no recognized target arg. This is the ONLY
 * surface the self-repair carve-out may match against: matching fragments against a
 * whole shell command is the SEC-1 credential-guard bypass.
 */
export function selfRepairTargets(input) {
  const args = extractArgs(input);
  if (!args || typeof args !== "object") return [];
  const home = homedir();
  const out = [];
  for (const k of WRITE_TARGET_ARG_KEYS) {
    const v = args[k];
    if (typeof v === "string" && v) out.push(expandHome(v, home));
  }
  return out;
}

// ─── credential-file denylist ────────────────────────────────────────────────────

function credSignatures(env = process.env) {
  const sigs = [
    /\.copilot[/\\]config\.json/i,
    /\.codex[/\\]auth\.json/i,
    /\.claude[/\\]\.credentials/i,
    /\.config[/\\]opencode[/\\][^"'\s]*auth/i,
    /\.aws[/\\]credentials/i,
    /(^|[/\\"'\s])\.netrc(\b|$)/i,
    /\.hermes[/\\]master\.key/i,
    /\.hermes[/\\]vault\.enc/i,
    /(^|[/\\])secrets\.vault/i,
    /(^|[/\\])id_rsa/i,
    /\.pem(["'\s)]|$)/i,
    // .env and .env.<x> but NOT .env.example / .env.sample
    /(^|[/\\])\.env(\.(?!example|sample)[A-Za-z0-9_]+)?(?=$|["'\s:)])/i,
  ];
  const extra = env.THESUN_HOOK_CRED_PATHS;
  if (extra) {
    for (const raw of String(extra).split(/[:,]/)) {
      const p = raw.trim();
      if (!p) continue;
      // Use the tail fragment as a substring signature (handles ~, $HOME, absolute).
      const tail = p.replace(/^~[/\\]?/, "").replace(/^\$\{?HOME\}?[/\\]?/, "");
      const esc = tail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      sigs.push(new RegExp(esc, "i"));
    }
  }
  return sigs;
}

export function hitsCredDenylist(candidates, env = process.env) {
  const home = homedir();
  const sigs = credSignatures(env);
  for (const c of candidates) {
    const raw = String(c);
    const expanded = expandHome(raw, home);
    for (const re of sigs) {
      if (re.test(raw) || re.test(expanded)) return true;
    }
  }
  return false;
}

// ─── forbidden-transport guard ──────────────────────────────────────────────────
//
// Ported from a Claude-only hook so it covers Copilot, Codex, and OpenCode too,
// which previously had no transport enforcement at all. Detection is anchored to
// MCP configuration syntax (a transport key, then a separator, then the value)
// so ordinary prose containing those letters never fires: "session", "assess",
// and "messages" are not matches, and neither is a sentence about stdio.
//
// The value literals are assembled from fragments rather than written inline for
// the same reason the credential fixtures are: this file would otherwise match
// its own patterns, and every edit to it would have to fight the guard it
// defines. Keep it that way.
// `type: <bad>` is deliberately NOT a trigger on its own. A client spawning its
// own MCP server that way is ordinary usage and is not what the deadlock rule
// targets: the rule is about a backend placed BEHIND the gateway, where the
// supervisor owns the process and the handshake deadlocks. Keying on `type`
// alone would block a legitimate managed client config, so only the explicit
// transport keys and CLI flags fire.
const TRANSPORT_KEY = String.raw`\b(?:transport|proxy[_-]?mode|mcp_transport)["']?\s*[:=]\s*["']?`;
const TRANSPORT_FLAG = String.raw`--(?:proxy-mode|transport)[=\s]+["']?`;
const BAD_VALUES = ["s" + "se", "std" + "io"];

/**
 * Returns the offending transport name when a candidate string configures an MCP
 * backend with a prohibited transport, or null when nothing matches.
 */
export function hitsForbiddenTransport(candidates) {
  for (const value of BAD_VALUES) {
    const keyed = new RegExp(TRANSPORT_KEY + value + String.raw`\b`, "i");
    const flag = new RegExp(TRANSPORT_FLAG + value + String.raw`\b`, "i");
    for (const c of candidates) {
      const s = String(c);
      if (keyed.test(s) || flag.test(s)) return value;
    }
  }
  return null;
}

// ─── metadata-only exec carve-out ───────────────────────────────────────────────
//
// Naming a credential path is not reading one. Listing a directory, testing a
// file for existence, or globbing for a filename all trip the denylist while
// emitting nothing but a name and a size. Denying those is a false positive
// that teaches operators to switch the guard off, which is strictly worse than
// a narrow carve-out.
//
// The carve-out is deliberately paranoid, because the SEC-1 bypass above came
// from a permissive matcher: EVERY segment of the command must lead with a
// metadata verb, and any construct that can smuggle a content read (command
// substitution, redirection, find's -exec) disqualifies the whole command. The
// content-reading verbs are absent from the verb set, so an actual read of a
// credential file is still denied.

const METADATA_VERBS = new Set([
  "ls", "find", "stat", "test", "[", "du", "wc", "file", "basename",
  "dirname", "realpath", "readlink", "tree", "echo", "true", "cd", "pwd",
]);

// Constructs that can execute or emit file CONTENT despite a metadata verb.
const CONTENT_ESCAPE_RE = /\$\(|`|>|<|\bxargs\b|-exec(dir)?\b|-delete\b|-ok(dir)?\b|-fprint\b/;

// Redirections that cannot carry bytes anywhere a reader can pick them up:
// stderr onto stdout, or either stream into the bit bucket. Stripped before the
// escape test so the ubiquitous `2>/dev/null` idiom is not treated as an exfil path.
const INERT_REDIRECT_RE = /\d?>>?\s*(&\d|\/dev\/null)/g;

/** True when a shell command can only reveal that a path exists, never its bytes. */
export function isMetadataOnlyCommand(command) {
  const cmd = String(command ?? "").trim();
  if (!cmd) return false;
  if (CONTENT_ESCAPE_RE.test(cmd.replace(INERT_REDIRECT_RE, " "))) return false;
  for (const seg of cmd.split(/\|\||&&|\||;|\n/)) {
    const trimmed = seg.trim().replace(/^[({\s]+/, "");
    if (!trimmed) continue;
    // Drop any leading VAR=value assignment prefix, then take the verb.
    const words = trimmed.split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
    const verb = (words[0] ?? "").replace(/^.*[/\\]/, "");
    if (!METADATA_VERBS.has(verb)) return false;
  }
  return true;
}

// ─── dep-scan pre-filter ─────────────────────────────────────────────────────────

const DEP_INSTALL_RE =
  /\b(npm|yarn|pnpm|pip|pip3|poetry|uv|cargo|go|gem)\b[\s\S]*?\b(install|add|get)\b|\bnpm\s+i\b/;

export function looksLikeInstall(command) {
  return DEP_INSTALL_RE.test(String(command ?? ""));
}

// ─── the synchronous decision (steps 0-2) ───────────────────────────────────────
//
// opts: a string (legacy = tier mode) OR { mode, credMode, env }.
// Returns {action:"allow"|"ask"|"deny", reason}.

function normOpts(opts) {
  if (typeof opts === "string") return { mode: opts, credMode: "deny" };
  return {
    mode: opts?.mode ?? "ask",
    credMode: opts?.credMode ?? "deny",
    env: opts?.env,
  };
}

export function decide(input, snapshot, opts = {}) {
  const { mode, credMode, env } = normOpts(opts);
  const toolName = extractToolName(input);
  const { candidates } = candidateStrings(input);
  const kind = builtinToolKind(toolName);

  // 0. self-repair carve-out — allow edits of the hook's OWN files so a session is
  //    never locked out of fixing the hook. WRITE-TARGET ONLY, and NEVER for
  //    exec/shell tools. It matches SELF_REPAIR_FRAGMENTS against the RESOLVED
  //    write/edit target path (file_path/path/notebook_path), not against the whole
  //    command or arbitrary string args. The old form matched every candidate
  //    string (incl. the entire shell command), so appending a benign fragment
  //    defeated the credential guard, e.g. `cat ~/.aws/credentials # packaging/hooks`
  //    or `cat ~/.aws/credentials && echo .claude/settings.json` were ALLOWED
  //    (SEC-1 live bypass). A carve-out is a file-write concern; an exec command is
  //    never self-repair, so exec tools skip this and fall through to the deny rules.
  if (kind !== "exec" && isSelfRepairTarget(selfRepairTargets(input))) {
    return { action: "allow", reason: "self-repair (hook's own files)" };
  }

  // 0b. transport guard: a forbidden MCP transport is a configuration mistake
  //     that cannot be recovered at runtime: stdio deadlocks the handshake under
  //     a supervisor, and the legacy event-stream binding 405-fails against a
  //     streamable-http server. Either way the backend exposes ZERO tools and
  //     every consumer burns tokens retrying a path that can never succeed.
  //     Runs after self-repair (this file necessarily contains the patterns it
  //     matches) and before the credential guard, and applies to file writes as
  //     well as commands, since the damage is done by what gets written.
  if (kind || isBuiltinWriteTool(toolName)) {
    const bad = hitsForbiddenTransport(candidates);
    if (bad) {
      return {
        action: "deny",
        reason:
          `thesun: refusing to wire an MCP backend over ${bad}. Streamable-http is the ` +
          `only permitted transport: set transport to "http" and point at the server's ` +
          `/mcp url. stdio deadlocks under supervision; the event-stream binding returns ` +
          `405 and exposes no tools.`,
      };
    }
  }

  // 1. credential-file guard — only on built-in file/exec tools.
  if (kind) {
    if (hitsCredDenylist(candidates, env ?? process.env)) {
      // A read-only existence or enumeration command names the path without
      // revealing it. Allow those rather than train operators to disable the guard.
      if (kind === "exec" && isMetadataOnlyCommand(extractCommand(extractArgs(input)))) {
        return { action: "allow", reason: "metadata-only command, no content read" };
      }
      const reason = `thesun: ${toolName || "this call"} reads a credential store; use the vault/broker instead (thesun secrets).`;
      if (credMode === "off") return { action: "allow", reason: "cred-guard off" };
      if (credMode === "ask") return { action: "ask", reason };
      return { action: "deny", reason };
    }
    // A normal file/exec call — not tier-gated. Dep-scan (async) may still speak.
    return { action: "allow", reason: "builtin tool, no credential hit" };
  }

  // 2. tier policy — mcp gateway tools only.
  if (!snapshot) return { action: "allow", reason: "no snapshot" };
  if (!toolName) return { action: "allow", reason: "no tool name" };
  const entry = lookupEntry(snapshot, toolName);
  if (!entry) return { action: "allow", reason: "unlisted" };
  if (entry.tier === "B") return { action: "allow", reason: "tier-b pass-through" };

  const args = extractArgs(input);
  const confirmed = args && args.confirmed === true;
  if (!confirmed) return { action: "allow", reason: "tier-a unconfirmed (gateway speed-bump handles it)" };

  const reason =
    `thesun: ${toolName} is a gated ${entry.class} operation (Tier-A). ` +
    `A human should confirm this self-approved call before it runs` +
    (entry.rule ? ` [${entry.rule}]` : "") + ".";
  if (mode === "off") return { action: "allow", reason: "mode=off" };
  if (mode === "deny") return { action: "deny", reason };
  return { action: "ask", reason };
}

// ─── the async dep-scan decision (step 3) ───────────────────────────────────────
//
// Called by the adapter ONLY when decide() already returned allow. Fail-open
// absolute: any non-veto response, error, timeout, or unreachable endpoint → allow.

export async function runDepScan(command, { url, fetchImpl, timeoutMs = 4000 }) {
  if (!url || !fetchImpl) return { action: "allow", reason: "no dep-scan endpoint" };
  const ac = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command }),
      signal: ac ? ac.signal : undefined,
    });
    if (!res || !res.ok) return { action: "allow", reason: "dep-scan non-ok" };
    const data = await res.json();
    if (data && data.action === "veto") {
      return { action: "deny", reason: data.message || "thesun dep-scan: this install is vetoed by policy." };
    }
    return { action: "allow", reason: "dep-scan warn/clear" };
  } catch (e) {
    return { action: "allow", reason: `dep-scan unreachable (allowing): ${e?.message ?? e}` };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function decideDepScan(input, snapshot, opts = {}) {
  const env = opts.env ?? process.env;
  if (!depScanEnabled(env)) return { action: "allow", reason: "dep-scan disabled" };

  const toolName = extractToolName(input);
  if (builtinToolKind(toolName) !== "exec") return { action: "allow", reason: "not an exec tool" };

  const { command } = candidateStrings(input);
  // No self-repair carve-out here. This path only ever sees exec install
  // commands (guarded above), and an install command is never "editing the
  // hook's own files"; a command that merely mentions a hook path (e.g.
  // `npm install --prefix packaging/hooks`, or a trailing `# packaging/hooks`
  // comment) must still be scanned, otherwise the fragment is a trivial bypass
  // of the vulnerability veto (same bypass class as SEC-1).
  if (!looksLikeInstall(command)) return { action: "allow", reason: "not an install command" };

  const url = resolveDepScanUrl(env, snapshot);
  const fetchImpl = opts.fetchImpl ?? (typeof fetch !== "undefined" ? fetch : null);
  return runDepScan(command, { url, fetchImpl, timeoutMs: opts.timeoutMs ?? 4000 });
}
