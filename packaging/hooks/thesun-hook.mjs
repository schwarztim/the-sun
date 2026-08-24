#!/usr/bin/env node
// thesun universal PreToolUse hook — Claude Code / Copilot CLI / Codex CLI (and,
// best-effort/UNVERIFIED, Copilot VS Code). One dependency-free script.
//
// EMPIRICAL per-client DENY mechanism (verified 2026-07-07 against live binaries,
// deny confirmed to block — zero tool calls reached the server):
//   - Claude Code : reads the ENVELOPE
//       {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny"|"ask","permissionDecisionReason":"…"}}
//     and EXIT 0. Supports "ask".
//   - Codex CLI (0.142.4) : does NOT read hookSpecificOutput. It reads the
//     LEGACY Claude hook schema — TOP-LEVEL {"decision":"block","reason":"…"} on
//     stdout and EXIT 0. Proven matrix (tool_name:"Bash", full-auto): envelope+exit0
//     FAIL-OPEN; envelope+exit2 FAIL-OPEN; {"decision":"block"}+exit0 BLOCKED;
//     {"decision":"block"}+exit2 FAIL-OPEN (nonzero exit WITH stdout JSON → Codex
//     treats the hook as errored → fail open); nested hookSpecificOutput.decision
//     FAIL-OPEN. Codex has no "ask" → an "ask" decision degrades to ALLOW.
//   Claude and Codex are INDISTINGUISHABLE from stdin (both use tool_name/tool_input),
//   so a DENY is emitted as ONE combined object carrying BOTH schemas + EXIT 0:
//       {"decision":"block","reason":R,
//        "hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":R}}
//   Claude reads hookSpecificOutput; Codex reads the top-level legacy "decision"
//   (its own legacy field — harmless to Claude). An "ask" emits ONLY the envelope
//   (no top-level "decision"), so Claude asks and Codex degrades to allow.
//   - Copilot CLI : DENY = NONZERO EXIT (exit 2). Its stdout reason was observed
//     IGNORED, but a doc/version stream honors a flat {permissionDecision:"deny"}
//     stdout+exit0 with exit2=warning. RECONCILE ROBUSTLY: emit BOTH — flat
//     {"permissionDecision":"deny","permissionDecisionReason":"…"} on stdout AND
//     process.exit(2), plus the reason on stderr (human-visible). Whichever
//     contract the installed version honors, the call is denied. Copilot is
//     veto-only (no "ask") → an "ask" decision degrades to ALLOW + a stderr note.
//   - Copilot VS Code : no command/PreToolUse shell hook is verifiable; gating is
//     the interactive approval UI. Treated as the envelope family, best-effort.
//
// ALLOW is universal: no stdout, EXIT 0. Never exit(2) on allow. Any internal
// error / empty stdin / timeout → allow (fail-open), matching every client's
// timeout behavior.

import { decide, decideDepScan, isCopilotCamel, loadSnapshot, resolveThesunHome, resolveTierMode, resolveCredMode } from "./core.mjs";

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(data);
    };
    const timer = setTimeout(finish, 500);
    if (timer.unref) timer.unref();
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (c) => {
      data += c;
    });
    process.stdin.on("end", () => {
      clearTimeout(timer);
      finish();
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      finish();
    });
  });
}

/**
 * Emit a decision with the client-correct MECHANISM.
 *   - allow            → no output, exit 0 (all clients).
 *   - Copilot deny     → flat {deny} stdout + reason to stderr + exit 2.
 *   - Copilot ask      → degrade to allow + stderr note, exit 0 (Copilot has no ask).
 *   - envelope deny    → combined object (legacy top-level {decision:"block"} for
 *                        Codex + hookSpecificOutput envelope for Claude) + exit 0.
 *   - envelope ask     → envelope-only (permissionDecision:"ask") + exit 0. Claude
 *                        asks; Codex has no ask and degrades to allow.
 *   (Claude / Codex / VS Code share this path — they are indistinguishable from stdin.)
 */
function writeDecision(decision, input) {
  if (decision.action === "allow") process.exit(0);
  const permissionDecision = decision.action; // "ask" | "deny"
  const permissionDecisionReason = decision.reason ?? "";

  if (isCopilotCamel(input)) {
    if (decision.action === "ask") {
      // Copilot is veto-only — no native ask. Degrade to allow, surface the note.
      try {
        process.stderr.write(`thesun-hook: ${permissionDecisionReason} (allowed — Copilot has no ask; set THESUN_HOOK_MODE=deny to block)\n`);
      } catch {
        /* ignore */
      }
      process.exit(0);
    }
    // Copilot deny: flat stdout AND exit 2 AND stderr — robust across versions.
    process.stdout.write(JSON.stringify({ permissionDecision, permissionDecisionReason }));
    try {
      process.stderr.write(`thesun-hook: DENY — ${permissionDecisionReason}\n`);
    } catch {
      /* ignore */
    }
    process.exit(2);
  }

  // Claude / Codex / VS Code: envelope + (for deny) legacy top-level decision, exit 0.
  //
  // CRITICAL (empirically pinned, Codex 0.142.4, 5-probe deterministic): the
  // permissionDecision/permissionDecisionReason keys must live ONLY inside
  // hookSpecificOutput, NEVER at the top level. Top-level permissionDecision
  // POISONS Codex — it treats the hook as errored ("PreToolUse Failed") and
  // FAILS OPEN (command runs). Nested-only envelope is harmless to Codex, and
  // Claude reads permissionDecision from hookSpecificOutput anyway (verified
  // live). So the envelope is nested-only; deny additionally carries the legacy
  // top-level {"decision":"block"} that Codex honors.
  // Echo the client's OWN event name back rather than hardcoding Claude's.
  // Claude and Codex send "PreToolUse"; Gemini CLI sends "BeforeTool" (verified
  // in the 0.46.0 bundle: createBaseInput sets hook_event_name, and the payload
  // is otherwise byte-identical to Claude's tool_name/tool_input schema).
  // Gemini ignores hookEventName when deciding to block, so this is correctness
  // rather than a fix, and it keeps the response honest for any client that
  // starts validating it.
  const hookEventName = typeof input?.hook_event_name === "string" && input.hook_event_name
    ? input.hook_event_name
    : "PreToolUse";
  const payload = {
    hookSpecificOutput: { hookEventName, permissionDecision, permissionDecisionReason },
  };
  if (decision.action === "deny") {
    // EXIT STAYS 0 — a nonzero exit WITH stdout JSON makes Codex treat the hook
    // as errored → fail open. "ask" omits "decision" so Codex degrades to allow
    // (it has no native ask) while Claude still asks via the nested envelope.
    payload.decision = "block";
    payload.reason = permissionDecisionReason;
  }
  process.stdout.write(JSON.stringify(payload));
  process.exit(0);
}

async function main() {
  try {
    const raw = await readStdin();
    let input = {};
    if (raw && raw.trim()) {
      try {
        input = JSON.parse(raw);
      } catch {
        process.exit(0); // malformed stdin → fail open
      }
    }
    const snapshot = loadSnapshot(resolveThesunHome());
    const opts = { mode: resolveTierMode(), credMode: resolveCredMode(), env: process.env };

    // Steps 0-2 (sync): self-repair carve-out, credential guard, tier policy.
    const d = decide(input, snapshot, opts);
    if (d.action !== "allow") return writeDecision(d, input);

    // Step 3 (async): shift-left dep-scan on package installs. Fail-open always.
    const dep = await decideDepScan(input, snapshot, { env: process.env });
    return writeDecision(dep, input);
  } catch (e) {
    try {
      process.stderr.write(`thesun-hook: error (allowing): ${e?.message ?? e}\n`);
    } catch {
      /* ignore */
    }
    process.exit(0);
  }
}

main();
