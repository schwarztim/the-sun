// thesun OpenCode plugin (Phase 1b) — the deny-only adapter.
//
// OpenCode has no PreToolUse "ask" primitive: its `tool.execute.before` plugin
// hook can only THROW to block a call. So this adapter wraps the SAME decision
// core (core.mjs — one policy brain across all five clients) and maps its
// verdict onto OpenCode's single lever:
//   - decide()==="deny"  → throw (block, explanatory message)
//   - decide()==="ask"   → OpenCode can't ask; degrade to ALLOW + stderr warning
//                          (deny only ever fires when THESUN_HOOK_MODE=deny)
//   - decide()==="allow" → return (pass through — READ, unlisted, Tier-B, and
//                          unconfirmed Tier-A all pass, exactly as elsewhere)
//
// Install drops this file AND core.mjs into OpenCode's plugin dir so the
// `./core.mjs` import resolves at load time.
//
// Known limit (documented, not fixable here): OpenCode does NOT intercept
// `task`-tool subagent calls (opencode #5894) — those bypass this plugin. The
// gateway floor is what carries that gap.

// @ts-nocheck — OpenCode plugins are loaded by OpenCode's own (Bun) runtime;
// this file is not part of the gateway tsc build. Kept as .ts for OpenCode's
// loader; the shared logic lives in the dependency-free core.mjs next to it.
import {
  decide,
  decideDepScan,
  loadSnapshot,
  resolveThesunHome,
  resolveTierMode,
  resolveCredMode,
} from "./core.mjs";

export const ThesunPolicyPlugin = async () => {
  return {
    "tool.execute.before": async (input, output) => {
      let decision;
      try {
        const snapshot = loadSnapshot(resolveThesunHome());
        // OpenCode passes the tool id on `input.tool` and the resolved args on
        // `output.args`. Normalize into the envelope shape core.mjs expects.
        const envelope = {
          toolName: input?.tool,
          tool_input: output?.args ?? {},
        };
        const opts = { mode: resolveTierMode(), credMode: resolveCredMode(), env: process.env };
        // Steps 0-2 (self-repair, credential guard, tier), then step 3 (dep-scan).
        decision = decide(envelope, snapshot, opts);
        if (decision.action === "allow") {
          decision = await decideDepScan(envelope, snapshot, { env: process.env });
        }
      } catch (e) {
        // Fail-open: never block on an internal error.
        try {
          process.stderr.write(`thesun-opencode: error (allowing): ${e?.message ?? e}\n`);
        } catch {
          /* ignore */
        }
        return;
      }

      if (decision.action === "deny") {
        throw new Error(decision.reason || "thesun policy: this gated call requires human approval.");
      }
      if (decision.action === "ask") {
        // OpenCode has no interactive ask at this layer — surface the intent and
        // allow. To hard-block on OpenCode instead, install with THESUN_HOOK_MODE=deny.
        try {
          process.stderr.write(`thesun-opencode: ${decision.reason} (allowed — OpenCode has no ask; set THESUN_HOOK_MODE=deny to block)\n`);
        } catch {
          /* ignore */
        }
      }
      // allow → return (pass through)
    },
  };
};

export default ThesunPolicyPlugin;
