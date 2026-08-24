# Phase 1b — Universal Client Hook: Manual Verification Checklist

The automated tests (gateway `pnpm test` unit suite + Go `go test ./internal/cli`)
prove the decision core, the snapshot writer, and the per-client file-merge logic.
They **cannot** prove the one thing only a live client settles: that each client's
PreToolUse hook actually **fires while the client is in its full-auto mode**, and
what exact `toolName` string it emits for a remote streamable-http tool. This
checklist is that empirical gate. Run it once per client before shipping.

## ✅ Empirical Results — Live Client Runs (2026-07-07)

Four parallel verifications drove each real client (isolated configs — the
operator's real `~/.claude`, `~/.copilot/hooks/other-hook.json`, `~/.codex`, and
`~/.config/opencode` were never modified) against the **real**
`packaging/hooks/{thesun-hook.mjs,core.mjs,opencode-plugin.ts}` reading a real
`policy-snapshot.json`, with a local dep-scan stub. The tested surface is the
**credential-file guard + dep-scan guard on built-in tools** plus the Tier-A/B
snapshot matrix (via direct-pipe where a live model turn wasn't reachable).

| Client (version) | Proof level | Cred-deny | Non-annoy | Dep-veto | Dep-fail-open | Built-in tool name (hook-facing) | Deny mech |
|---|---|---|---|---|---|---|---|
| **Claude Code 2.1.197** | LIVE `--dangerously-skip-permissions` | ✅ PASS | ✅ PASS | ✅ PASS | ✅ PASS | `Bash` / `Read` | envelope + exit 0 ✅ |
| **Copilot CLI 1.0.68** | LIVE `--allow-all-tools` | ✅ PASS | ✅ PASS | ✅ PASS | ✅ PASS | `bash` | **exit 2** (+ flat stdout, now honored on 1.0.68) ✅ |
| **OpenCode 1.17.11** | plugin-contract (live model turn env-blocked) | ✅ PASS | ✅ PASS | ✅ PASS | ✅ PASS | `bash` / `read` | `throw` ✅ |
| **Codex CLI 0.142.4** | LIVE (mock Responses, 3/3) | ✅ PASS (after fix) | ✅ | ✅ | ✅ | `Bash` (Codex normalizes `exec_command`→`Bash`) | top-level `{decision:block}`+exit0 (P4); envelope **nested-only** |
| Copilot VS Code | n/a (no headless command hook) | — | — | — | — | — | **gateway PEP** |

**Per-client notes**
- **Claude** — all four rows live-passed under bypassPermissions; deny took effect, credential contents never surfaced, dep-scan POSTed and vetoed, fail-open on stub-down (no wedge), `npm run build` never scanned. Matcher `Read|Bash|Grep|Glob|mcp__mcp-gateway__.*` fired on `Bash`.
- **Copilot CLI** — all four rows live-passed under `--allow-all-tools`; **exit 2** deny takes effect (`✗ Denied by preToolUse hook: <reason>`). Refinement vs prior note: on **1.0.68 the flat-stdout reason is honored** (surfaces verbatim) — 1.0.65 ignored it; the dual-emit (flat JSON + exit 2 + stderr) is correct and version-robust. other-hook.json byte-unchanged. Subagent hooks not enforced (#2392 — gateway floor covers).
- **OpenCode** — every plugin decision (cred-deny throw, non-annoyance, dep-veto/fail-open, Tier-A/B matrix, `mcp-gateway_<tool>` single-underscore resolution, `ask`→allow+stderr degrade, throw-blocks-under-blanket-allow) confirmed against the real `core.mjs` + byte-faithful plugin. Only the live `opencode run` model turn was **BLOCKED (environmental)** — the Azure provider startup hung before any tool dispatched; not a plugin fault. `task`-subagent bypass (#5894) is a documented gap the gateway floor covers.
- **Codex** — ⚠️ **discovered bug (see below).** Config `[hooks]` shape works, matcher `.*` fires, and Codex normalizes its exec tool to hook-facing `tool_name:"Bash"` (so the matcher covers it — correcting the assumed `shell|read|grep|glob`). `--dangerously-bypass-hook-trust` is required for the hook to run in automation. But the deny did **not** block.

### ✅ FIXED & LIVE-VERIFIED — Codex 0.142.4 fail-open on the thesun deny
**Root cause (5-probe deterministic):** Codex 0.142.4 reads the LEGACY top-level `{"decision":"block"}`+exit0 schema, and the top-level `permissionDecision`/`permissionDecisionReason` keys the hook used to emit POISON it (Codex treats the hook as errored → `PreToolUse Failed` → fail-open, creds executed/read). Two dead ends proven: envelope+exit0 (original) fails open; the first fix (combined object *with* top-level permissionDecision) STILL failed open. **Fix:** `thesun-hook.mjs` emits the envelope keys NESTED-ONLY inside `hookSpecificOutput`, plus top-level `decision:"block"`+`reason`, exit 0 — no top-level `permissionDecision`.
**Live re-verify (2026-07-07, both PASS, same hook md5 `882adc2d…`):** Codex 3/3 — cred read BLOCKED every run (`PreToolUse Blocked`, sentinel absent, canary never shown, zero `PreToolUse Failed`), allow-case clean. Claude 2.1.197 3/3 — still blocks (reads `permissionDecision:"deny"` from inside `hookSpecificOutput`, surfaced the exact thesun reason), no regression. Plus 55 hook unit tests + full gateway suite (453 pass), tsc clean. Historical detail below retained for context.

### ⚠️ (historical) Codex 0.142.4 fails open on the thesun deny (built-in tool)
Live run (`--dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust`): the hook received `tool_name:"Bash"` and returned the correct Claude-style `permissionDecision:"deny"` envelope + exit 0, but Codex printed `hook: PreToolUse Failed`, **executed the command anyway, and the credential file was read into the transcript** (n=1 clean capture). This contradicts the prior assumption (below, and memory `ai-client-mcp-hook-verification`) that Codex honors Claude's envelope+exit0 — that was verified for a *remote MCP* tool, and the *built-in-tool* path appears to differ in 0.142.4. **Consequence: the credential guard and dep-scan guard do not currently block on Codex built-in tools.** The direct-pipe hook logic is correct (A′/B/C/D/E pass); the gap is the client-side deny *contract*. A follow-up is pinning the mechanism Codex 0.142.4 actually honors (likely non-zero exit, like Copilot) and applying the same dual-emit to the Codex path — **without regressing Claude** (which honors envelope+exit0). Until fixed, **Codex built-ins are covered only by the gateway PEP floor**, not the client hook. Status of the mentions of Codex honoring envelope+exit0 elsewhere in this doc: **PROVISIONAL / under correction.**

## Preconditions (all clients)

1. Stack up: `thesun up` (gateway on `:3100`, at least one generated backend with a
   Tier-A write tool and a Tier-B `*_delete_*` tool).
2. Snapshot present: confirm `policy-snapshot.json` exists in THESUN_HOME
   (macOS `~/Library/Application Support/thesun`, Linux `~/.config/thesun`,
   Windows `%AppData%\thesun`). If absent, the gateway snapshot-writer wiring
   (see the integration note in the Phase 1b handoff) has not landed yet — the
   hook fails **open** (allows everything) until it exists, which is the intended
   safe default but means this checklist tests nothing.
3. Install the hook: `thesun hooks install --client all`, then `thesun hooks status`
   shows `installed` for every client you will test. Default mode is `ask`
   (`THESUN_HOOK_MODE=ask`).
4. Pick a **Tier-A** tool (a plain POST/PUT/PATCH write, e.g. `<backend>_update_*`)
   and a **Tier-B** tool (a DELETE-backed or destructive-verb tool, e.g.
   `<backend>_delete_*`). Confirm their tiers in `policy-snapshot.json`.

## What to observe (the pass criteria, identical across clients)

| Call | Expected hook behavior | Expected end state |
|---|---|---|
| Tier-A tool, model self-confirms (`confirmed:true`) | hook returns `ask` (or `deny` if you set `THESUN_HOOK_MODE=deny`) | client shows a native permission prompt / denies the call **even in full-auto** |
| Tier-A tool, first (unconfirmed) call | hook is silent (allow) | gateway returns its Tier-A `confirmationRequired` block as usual |
| Tier-B tool (even with `confirmed:true`) | hook is silent (allow — pass-through) | call reaches the gateway and **parks** (`thesun approve` lists it) |
| READ tool | hook is silent (allow) | call proceeds with zero friction |
| Snapshot deleted mid-run | hook is silent (allow — fail open) | no client is ever hard-broken by a missing snapshot |
| **Built-in read/exec of a credential store** (e.g. `cat ~/.copilot/config.json`, Read `~/.aws/credentials`) | hook returns **deny** (`THESUN_HOOK_CRED_GUARD=deny`, default) | the cred file is NOT read into the transcript |
| Built-in read of a normal file / `.env.example` | hook is silent (allow) | zero friction (non-annoyance) |
| **Built-in `npm/pip/... install` command** | hook POSTs the command to the gateway `/dep-scan`; `veto`→deny, everything else→allow | a known-vulnerable install is blocked with a prescriptive message; all others proceed |
| Built-in non-install command (`npm run build`, `git install-hooks`) | hook is silent (allow), no POST | zero friction, hot path <100ms |

The critical, non-obvious assertions:
- Row 1 (**Tier-A confirm gate**) must fire **in full-auto mode** — independently of
  the client's auto-approve/YOLO permission mode.
- The **credential-file guard** and **dep-scan guard** operate on the client's
  **built-in** tools (Read/Bash/Grep/Glob, `view`/`bash`/`grep`/`glob`, `shell`,
  etc.), so the installed matcher regex per client MUST cover those built-in tool
  names — this is the **#1 thing to record per client** (see the matcher note in
  each client section). Self-repair (editing the hook's own files/config) is always
  allowed, so a session can never lock itself out of fixing the hook.

## Per-client procedure

### Claude Code — `bypassPermissions`
- Hook config: `~/.claude/settings.json` → `hooks.PreToolUse[]` with matcher
  `mcp__mcp-gateway__.*` (this is the **confirmed** toolName form for Claude).
- Run Claude with `--dangerously-skip-permissions` (bypassPermissions) and prompt it
  to call the Tier-A tool and confirm.
- **Observe:** despite bypassPermissions, an `ask` prompt appears for the confirmed
  Tier-A call. Set `THESUN_HOOK_MODE=deny` and re-run → the call is denied with the
  thesun reason string.
- **Record:** the exact `tool_name` Claude passed the hook (add a temporary
  `console.error(input.tool_name)` to a copy of `thesun-hook.mjs`, or check the
  transcript). Confirm it is `mcp__mcp-gateway__<tool>`.

### GitHub Copilot CLI (v ≥ GA 2026-02) — `--allow-all-tools`
- Hook config: `~/.copilot/hooks/thesun.json` (dedicated file; the operator's other
  hook files like `other-hook.json` are untouched). FLAT schema, `hooks.preToolUse[]`,
  matcher `mcp-gateway` (broad — the Copilot MCP toolName form is **unconfirmed**).
- Run `copilot --allow-all-tools` and prompt the Tier-A confirmed call.
- **Observe:** the flat `{"permissionDecision":"ask",...}` output takes effect
  (prompt or, in `-p` non-interactive mode, the `permissionRequest` path). With
  `THESUN_HOOK_MODE=deny`, the call is denied.
- **Record:** the runtime `toolName` (Copilot passes it in stdin as `toolName`, and
  its permission layer may use `ServerName(tool)` — cf. `--deny-tool='MyMCP(tool)'`).
  If the matcher `mcp-gateway` does **not** fire, capture the actual string and
  widen the matcher. The decision core already tries `mcp__s__t`, `s(t)`, and bare
  `t` as snapshot keys, so only the client-side **matcher** may need adjustment.
- **Note:** Copilot `preToolUse` is fail-closed on a hook **crash/non-zero exit**,
  but fail-open on **timeout/malformed stdout**. The script always exits 0 and emits
  valid JSON well under the 5s `timeoutSec`, so neither failure mode should trigger.
- Subagent caveat: Copilot does **not** run hooks inside subagents (copilot-cli #2392).

### Copilot VS Code (Preview) — per-tool always-allow
- Hook config: VS Code user dir `hooks.json` (`~/Library/Application Support/Code/User/`
  on macOS, `~/.config/Code/User/` on Linux, `%APPDATA%\Code\User\` on Windows).
  Envelope schema, matcher `mcp__mcp-gateway__.*`.
- **Preview caveat:** the VS Code agent-mode hook format may change; if the entry
  does not fire, re-check `code.visualstudio.com/docs/agent-customization/hooks`
  for the current shape and update `mergeEnvelopeHook`'s target path/shape.
- Enable per-tool always-allow for the Tier-A tool, then trigger the confirmed call.
- **Observe:** the `permissionDecision:"ask"|"deny"` still surfaces despite always-allow.
- **Record:** the runtime `toolName` (confirm `mcp__mcp-gateway__<tool>`).

### Codex CLI (v ≥ 0.141 — enforcement bug #4152 fixed) — `danger-full-access` / approval-never
- Hook config: `~/.codex/hooks.json`, envelope schema, matcher `mcp__mcp-gateway__.*`.
- Run Codex in `danger-full-access` (or approval-mode `never`) and trigger the
  confirmed Tier-A call.
- **Observe:** the ask/deny takes effect. Codex also has a `PermissionRequest` hook;
  confirm the `PreToolUse` path is the one firing.
- **Record:** the runtime `toolName` (Codex docs state it covers `mcp__server__tool`
  — confirm `mcp__mcp-gateway__<tool>`). Pin the installed version ≥ 0.141.

### OpenCode — blanket `permission: "allow"`
- Plugin: `~/.config/opencode/plugin/thesun-opencode-plugin.ts` + `core.mjs`
  (both copied by `thesun hooks install`). **Deny-only** — no `ask` primitive.
- Because OpenCode cannot `ask`, install with `THESUN_HOOK_MODE=deny` to actually
  block; in the default `ask` mode the plugin **allows + warns on stderr** (visible
  in OpenCode's logs).
- Set OpenCode to blanket-allow, then trigger the confirmed Tier-A call with
  `THESUN_HOOK_MODE=deny`.
- **Observe:** the plugin throws and the call is blocked with the thesun reason.
- **Record:** the runtime `input.tool` string OpenCode passes the plugin (its MCP
  tool id form). The core tries `mcp__s__t`, `s(t)`, and bare `t` as snapshot keys.
- Subagent caveat: OpenCode does **not** intercept `task`-tool subagent calls
  (opencode #5894) — those bypass the plugin. The gateway floor carries that gap.

## Credential-file guard + dep-scan — per-client confirmation

Both guards ride the SAME installed matcher, so the one thing to confirm per client
is that the matcher fires on that client's **built-in** file/exec tool names:

| Client | Built-in tools the matcher must cover | Confirm |
|---|---|---|
| Claude Code | `Read` `Bash` `Grep` `Glob` | matcher `Read\|Bash\|Grep\|Glob\|mcp__mcp-gateway__.*` |
| Copilot CLI | `bash` `view` `grep` `glob` | matcher `bash\|shell\|view\|grep\|glob\|mcp-gateway` — **confirm the real built-in names** (the operator's other-hook.json uses `edit\|create\|task\|bash`) |
| Copilot VS Code | (Preview — same as Claude assumed) | verify against the current VS Code hooks doc |
| Codex CLI | `shell` `read` `grep` `glob` (assumed) | **confirm** Codex's built-in tool names; widen matcher if different |
| OpenCode | (plugin sees every tool — no matcher) | n/a — but note OpenCode has no `ask`, so cred-guard `ask` degrades to allow+warn; use `THESUN_HOOK_CRED_GUARD=deny` |

Verification commands (run in each client's full-auto mode, hooks installed):
- Credential deny: ask the agent to `cat ~/.copilot/config.json` (or Read `~/.aws/credentials`).
  Expect a **deny** with "reads a credential store; use the vault/broker instead".
- Non-annoyance: ask it to Read `./package.json` and `./.env.example` — both proceed silently.
- Dep-scan veto: with the DepScan engine returning `veto` for a pinned-bad package,
  ask the agent to `npm install <that package>` — expect deny with the "use >=X.Y.Z" message.
- Dep-scan fail-open: stop the gateway, then `npm install left-pad` — expect it to proceed
  (allow) with no wedge. `git install-hooks` and `npm run build` must never trigger a scan.
- Env knobs: `THESUN_HOOK_CRED_GUARD=off` disables the cred guard; `DEP_SCAN_DISABLE=1`
  disables dep-scan; `THESUN_HOOK_CRED_PATHS=~/.mytool/token.json` extends the denylist.

Known Copilot limits to note in the record: hooks are NOT enforced in Copilot
subagents (#2392); MCP-plugin-defined hooks may not fire (#2540); the hook is
veto-only (no arg rewrite, #2585/#1819/#2643). Copilot `preToolUse` is fail-closed
on a crash/non-zero exit (except exit 2 = warning) but **fail-open on timeout or
malformed stdout** — the script always exits 0 with valid JSON, well under the 5s
`timeoutSec`, so neither failure mode should trigger.

## Regression (mandatory)

With hooks **uninstalled/removed** (`rm` the entries or a fresh machine), re-run the
Phase 1 gateway acceptance suite. Every guarantee must pass unchanged — the hook
layer is additive and never a precondition for a gateway guarantee.

## Runtime toolName + deny mechanism — EMPIRICALLY VERIFIED (2026-07-07)

Verified against live binaries with a real echo MCP + isolated hook; deny confirmed
to block (zero tool-calls reached the server). The gateway `<server>` is
`mcp-gateway`; the `<tool>` is the gateway namespacedName (the snapshot key).

| Client | Runtime toolName (gateway tool) | Deny mechanism | `ask`? |
|---|---|---|---|
| Claude Code | `mcp__mcp-gateway__<tool>` (mcp__s__t) | envelope `hookSpecificOutput.permissionDecision:"deny"` + **exit 0** | yes |
| Codex CLI | `mcp__mcp-gateway__<tool>` (identical to Claude) | same envelope + **exit 0** | yes |
| Copilot CLI | `mcp-gateway-<tool>` (**hyphen**) | flat `{permissionDecision:"deny"}` stdout **+ EXIT 2** + stderr (both emitted for version-robustness) | **no** — `ask` degrades to allow + stderr note |
| OpenCode | `mcp-gateway_<tool>` (**single underscore**) | **throw** inside `tool.execute.before` | **no** — `ask` degrades to allow + stderr note |
| Copilot VS Code | (no verifiable command hook) | **n/a — gateway PEP enforces** | n/a |

The core's `lookupKeys()` emits the tail after every `-`/`_` plus the `mcp__` form,
so all three join styles resolve to the same snapshot key. A wrong toolName still
degrades to **silent allow** (fail-open), never a wrong deny. The installed
per-client matcher must additionally cover that client's built-in tool names (for
the cred + dep guards) — see the matcher table above.

### Codex trust gotcha (record during Codex verification)
A freshly written Codex hook is **untrusted** and silently will NOT run in
automation unless Codex is invoked with `--dangerously-bypass-hook-trust`. Also,
Codex defaults to `mcp__…` toolNames but the `NonPrefixedMcpToolNames` /
`DeferMcpTools` feature flags could change the emitted string — record the actual
string and pin the config.

### Copilot VS Code (agent mode)
No command/PreToolUse shell hook is verifiable headlessly; gating there is the
interactive approval UI. `thesun hooks install --client copilot-vscode` writes the
Preview hook **best-effort** and both `hooks status` and this doc label it
**UNVERIFIED — enforced by the gateway PEP, not this hook**. Do not count it as a
working client-side deny.
