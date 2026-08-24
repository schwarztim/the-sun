# thesun Security Roadmap: Universal Enforcement at the Gateway PEP

> ## ✅ SHIPPED (banner added 2026-07-08)
> This roadmap has been IMPLEMENTED. The core layers landed in commits `6d3ea2f..0102d65`:
> the Tier-A → Tier-B escalation overlay (`gateway/src/escalation.ts`), the near-universal
> client hook layer, trust/TTL approval grants, and capability-gated elicitation. The
> follow-on hardening in this cycle added the fail-closed content guard, the canary hook
> verification, the non-loopback bind guard, and grant TTLs. Treat the acceptance table
> below as the original design targets, not current build state: rows it still marks
> "Designed-only" are shipped. For the authoritative current model read
> [`SECURITY-MODEL.md`](SECURITY-MODEL.md); this document is retained for design rationale.

**Date:** 2026-07-07 (shipped; banner 2026-07-08)
**Status:** SHIPPED (escalation overlay, client hook layer, trust/TTL grants, elicitation, plus this cycle's hardening). Originally: DECISION-GRADE DESIGN, approved-pending-operator-review.
**Scope:** gateway/, generator/, fleet/ CLI, packaging. Grounded in code as of commit 8455d33 plus the uncommitted Windows control-channel split.
**Operator goals (verbatim):** "I want the security controls to be legitimately useful and not annoying." "I want the hooks to work with GitHub Copilot as well as Claude universally. And OpenCode."

---

## ⚠️ ADDENDUM 2026-07-07 — VERIFIED CORRECTION (supersedes the "no universal hooks" premise below)

Three independent researchers re-verified the "these clients have no hook layer" claim against **primary-source docs**, tasked to refute it. **The claim is FALSE for all of them.** Every major client shipped a blocking, client-side pre-tool-execution hook in 2026 that can DENY an MCP tool call before it leaves the client — the direct analog of Claude Code's `PreToolUse`. Three of them even reuse Claude's exact schema (`mcp__server__tool` matcher + `hookSpecificOutput` + `permissionDecision: "deny"`).

| Client | Client-side blocking hook (can deny an MCP tool call)? | Mechanism / primary source |
|---|---|---|
| Claude Code | Yes | PreToolUse hook |
| **Copilot CLI** | **Yes (was claimed No)** | `preToolUse` hook (fail-closed: crash/non-zero exit = deny) + `permissionRequest` hook for non-interactive `-p` mode; `.github/hooks/*.json` or `~/.copilot/hooks/`. GA 2026-02. [docs.github.com/copilot/reference/hooks-configuration] |
| **Copilot VS Code** | **Yes, Preview (was claimed No)** | Agent-mode PreToolUse hooks, `permissionDecision:"deny"`; doc 2026-07-01, format may change. [code.visualstudio.com/docs/agent-customization/hooks] |
| **Codex CLI** | **Yes (was claimed No)** | `PreToolUse` + `PermissionRequest` hooks, explicitly cover `mcp__server__tool`; `~/.codex/hooks.json` or `[hooks]` in config.toml; enterprise `allow_managed_hooks_only`. [developers.openai.com/codex/hooks] |
| **OpenCode** | **Yes (was claimed No)** | `tool.execute.before` plugin hook — throw to block; MCP coverage fixed PR #2320 (2025-08-30). Caveat: does NOT intercept `task`-tool subagent calls (#5894). [opencode.ai/docs/plugins] |

**What this changes:** the "gateway is the ONLY possible universal enforcer" framing in Section 0 is wrong. The corrected architecture is **two real layers, not one**:
1. **Near-universal client-side hook layer (NEW, ship it):** thesun can ship one shared policy script wired into Claude + Copilot (CLI & VS Code) + Codex — they share the `mcp__server__tool`/`permissionDecision` convention — plus an OpenCode plugin variant. This gives a genuine client-side deny/human-gate on **every** client, and (per each hook's design) it fires as a layer *separate from* the client's auto-approve/YOLO permission mode. This directly satisfies the operator's "hooks work universally" goal.
2. **Gateway PEP remains the authoritative floor (unchanged keystone):** client hooks are opt-in per install, bypassable (OpenCode subagents #5894, Codex enforcement bug #4152), and some are Preview. So the Tier-B escalation-overlay work (Section 2) is still required and still the un-bypassable guarantee. Belt **and** suspenders, not either/or.

**One thing to confirm empirically before shipping hooks:** that each client's PreToolUse hook actually fires while that client is in its full-auto mode (Copilot `--allow-all-tools`, Codex `danger-full-access`/approval-never, OpenCode blanket-allow). The docs strongly imply yes (the hook is a separate layer from the approval prompt; Copilot's is fail-closed and its `permissionRequest` hook is purpose-built for non-interactive mode), but it was not each agent's tested combination. Also confirm the exact runtime `toolName` string each client emits for a remote streamable-http tool, and pin versions (Copilot GA 2026-02, Codex ≥ v0.141, OpenCode current).

**Reconciliation status:** the body below has been revised to match this correction. Section 0 now states the two-layer model, Section 3 reflects each client's real hook capability, Phase 1b ships the universal client hook layer, and Sections 5 and 6 carry the corresponding proof rows and shipped defaults. The threat model, Tier-A vs Tier-B analysis, escalation-overlay keystone, and non-annoyance kit stand unchanged: client hooks add a near-universal first line of defense, and the gateway floor remains the only un-bypassable guarantee.

---

## 0. The Central Reframe (read this first)

The operator asked for "hooks that work universally." As of 2026 that goal is achievable at the client layer, more literally than this document first assessed: every one of the five clients ships a blocking, client-side pre-tool-execution hook that can deny an MCP tool call before it leaves the client (see the addendum matrix above for mechanisms and primary sources). Three of them (Copilot CLI, Copilot VS Code, Codex CLI) reuse Claude Code's exact schema: an `mcp__server__tool` matcher plus a `hookSpecificOutput` envelope carrying `permissionDecision: "deny"`. OpenCode exposes the same power through a `tool.execute.before` plugin hook that throws to block.

That gives thesun two real enforcement layers, and they are not interchangeable:

1. **The client hook layer (near-universal, opt-in, first line of defense).** One shared policy script, wired into all five clients, firing independently of each client's auto-approve/YOLO permission mode. Its unique value is restoring a human gate on exactly the step the gateway deliberately leaves friction-free (the Tier-A self-confirm), in each client's native UX. Phase 1b ships it. It is also honestly limited: installation is per-machine opt-in; the hook configs live in user-writable files, so a fully autonomous agent with filesystem access can remove them unless the client's managed mode is in force (Claude `allowManagedHooksOnly`, Codex `allow_managed_hooks_only`; no verified Copilot or OpenCode equivalent); OpenCode does not intercept `task`-tool subagent calls (issue #5894); Codex had an MCP-enforcement bug fixed in v0.141 (#4152); the VS Code hook is Preview and its format may change.
2. **The gateway PEP (universal, un-bypassable, the authoritative floor).** All five clients speak streamable-http to one URL (docs/INSTALL.md:107-112) and every tool call funnels through exactly one method, `dispatchToolCall()` (gateway.ts:1650), with `callBackendTool` having no other caller (gateway.ts:1648). Whatever must be GUARANTEED, regardless of client version, hook installation state, subagent path, or full-auto mode, must be enforced here. The Tier-B out-of-band approval is the only control in the system with that property.

So the operator's requirement translates to:

> **Belt and suspenders. The gateway is the authoritative enforcement floor; the client hook layer is a shipped, near-universal human gate that thesun installs everywhere it can and depends on nowhere.**

The design discipline that follows: any control whose failure would be a security incident is specified at the gateway. Any control whose purpose is human awareness, native UX, or defense-in-depth is specified at the hook layer. The field consensus still applies (LLMs and their clients are probabilistic; guarantees must be deterministic and external to the agent), which is why every guarantee below is proven against a full-auto client **with no hooks installed**: that is the state of any machine thesun does not control.

---

## 1. Threat Model & Framing

### 1.1 What the gateway architecture looks like today

Classification pipeline (manifest.ts): manifest entry → `WRITE_VERB_REGEX` name-pattern fallback (manifest.ts:72-73) → UNCLASSIFIED fail-closed (manifest.ts:330-335, with a per-backend legacy-READ allowlist escape at manifest.ts:321-328). Manifests that mislabel a write-verb tool as READ are rejected at load time (manifest.ts:238-249) unless the capability declares `http_method: "GET"` (manifest.ts:167-174).

Two enforcement tiers with very different strength:

| Tier | Classes | Mechanism | Holds against full-auto non-Claude client? |
|---|---|---|---|
| **Tier-A** | WRITE, SIDE_EFFECT, UNCLASSIFIED | Block response `{confirmationRequired:true, ...}` with type-tag-redacted args (gateway.ts:1722-1729); model re-invokes with `confirmed:true`; `decideGate()` is stateless, `if (confirmed) return proceed` (manifest.ts:108-110) | **NO.** The model reads the hint and re-calls. Zero friction in full-auto. |
| **Tier-B** | PRODUCTION, VAULT_VALUE, HUMAN_OUTBOUND, any non-empty write_guard (approvals.ts:98-108) | `dispatchTierB()` ignores model-supplied `confirmed:true` entirely (logged as `agentConfirmedIgnored`, gateway.ts:1788), parks an `approvalPending` (gateway.ts:1819-1831), requires out-of-band human approval via loopback-only `/approve` (gateway.ts:825-841) or `thesun approve` CLI. Not in the MCP tool surface (proven: tier-b-approvals.test.ts). PRODUCTION additionally refuses ALL standing authority (`NO_STANDING_GRANT_CLASSES`, approvals.ts): a standing grant, a class grant, and a backend-wide trust wildcard are each rejected at resolve time, so every call parks for its own approval | **YES.** The authorization channel is unreachable by any model on any client. Holds even in `enforce: advisory` mode, since `dispatchTierB` never consults the enforce flag for the park decision. |
| **Content-guard** | All tool results; HUMAN_OUTBOUND args; sql/exec-tagged args | Regex egress redaction of secrets/cards (content-guard.ts:70-82, applied at gateway.ts result path), Luhn card + optional SSN arg blocking that runs even on confirmed calls (gateway.ts:1874-1923) | **YES.** Standard JSON tool results, client-agnostic by construction. |

Supporting properties already in place and worth preserving: fail-closed audit (unwritable decision log denies dispatch, gateway.ts:1689-1699), fail-closed UNCLASSIFIED inversion, park deduplication per identity×backend×tool (approvals.ts:209-212, so a looping agent cannot flood the approval queue), value-free persistence of approval records (type-tag `summarizeArgs`, approvals.ts:122-130), 0700/0600 file modes with atomic writes (approvals.ts:170-175), and Windows-correct THESUN_HOME resolution (approvals.ts:40-53).

Scoping note for both tables in this section: the "holds against a full-auto client?" columns evaluate the **gateway floor alone**, i.e. the worst reachable state (full-auto client, no thesun hooks installed). The Phase 1b client hook layer adds a human gate on the Tier-A confirm step wherever it is installed, but per Section 0 it is opt-in and bypassable, so it never changes a verdict below.

### 1.2 Threats, mapped to tiers, with honest verdicts

| # | Threat | Defending tier | Holds under full-auto non-Claude client? | Standards anchor |
|---|---|---|---|---|
| T1 | **Prompt injection → destructive write** (injected content convinces the agent to delete/deploy/purge) | Tier-B only. Tier-A is self-confirmed by the injected agent itself. | Only if the tool is classified into Tier-B. **Today, generated servers never are** (see 1.3 gap G1). | OWASP LLM01; NIST AI RMF MANAGE 2.x |
| T2 | **Secret exfiltration via tool results** (backend response contains a key; model repeats it into an outbound channel or transcript) | Content-guard egress redaction on every result | Yes, with limits: 7 known-format patterns + PEM + bearer, no entropy detection; payloads over `maxScanChars` pass unscanned by design (content-guard.ts:238-243) | OWASP LLM02/LLM05 |
| T3 | **PCI/PII egress to humans** (card number laundered into an email/ticket/message) | Content-guard HUMAN_OUTBOUND arg block, independent of confirmation (gateway.ts:1880-1899) | Yes, **but only for tools classified HUMAN_OUTBOUND**, which no generated manifest ever emits today (gap G1) | OWASP LLM02; PCI-DSS scope |
| T4 | **Runaway full-auto agent** (agent in `--allow-all-tools` chains many writes) | Tier-A provides zero friction here; Tier-B parks the dangerous subset; decision log records everything | Partially. Reads and Tier-A writes flow freely (by design, that is the non-annoying 80%); Tier-B subset is hard-stopped | OWASP LLM06 (excessive agency) |
| T5 | **Confused deputy / lethal trifecta** (private data + untrusted content + external comms) | Tier-B on HUMAN_OUTBOUND severs the external-comms leg at the moment of exfiltration | Yes, once HUMAN_OUTBOUND classification actually covers messaging/email tools (gap G1) | Willison lethal-trifecta model; OWASP LLM01 |
| T6 | **Production writes** | PRODUCTION → Tier-B | Yes, but nothing assigns PRODUCTION today except hand-authored manifests (gap G1/G2) | NIST AI RMF GOVERN; change-management |
| T7 | **Vault value disclosure** | VAULT_VALUE → Tier-B | Yes, same manifest caveat | OWASP LLM02 |
| T8 | **Approval-queue flooding / token-bombing** | Park dedup (one pending per identity×backend×tool) + 24h TTL (approvals.ts:86) | Yes, already structurally bounded | Availability |
| T9 | **Human social-engineered by the agent** ("run `thesun approve --always` for me") | Out of scope for the gateway to prevent; the approve UX must give the human enough context to make an informed call | Partially. Today the human sees only type tags, not values (see gap G5) | EU AI Act Art. 14 human oversight |

### 1.3 Blunt gap list (what is currently overclaimed or missing)

- **G1 (the big one): the generator emits only READ and WRITE.** `renderGatewayManifest` hard-types `safety_class: "READ" | "WRITE"` (go-generator.ts:1668) and derives it purely from GET/HEAD vs everything else (go-generator.ts:1700-1703). No generated server ever receives PRODUCTION, VAULT_VALUE, HUMAN_OUTBOUND, or a write_guard. **Consequence: the entire Tier-B machinery, the only control that holds universally, currently protects zero generated tools.** A `github_delete_repo`, a `servicenow_send_email`, a `venafi_revoke_certificate` all land in Tier-A, where a full-auto Copilot client self-confirms straight through. This is the keystone gap and Section 2's classifier exists to close it.
- **G2: PRODUCTION is a class with no assignment path.** There is no config surface that says "this backend is production." It only exists if someone hand-edits a manifest.
- **G3: Tier-A is described in places as a guard; on non-Claude clients it is a speed bump plus an audit event.** Its legitimate value: it forces a deliberate second invocation (preventing single-shot accidental writes), it guarantees the model saw the warning and redacted args before proceeding, and it creates an audit pair. It is not a security boundary and the docs should stop implying it is.
- **G4: identity granularity.** Without Entra, grant identity is a per-install UUID (approvals.ts:307-325, gateway.ts:1862-1865). A standing grant approved while using Claude also authorizes the same tool from Copilot or OpenCode on the same machine. Acceptable for a single-operator install; must be stated, and client-scoped identity is a cheap future refinement (clientInfo is available at initialize).
- **G5: informed consent is thin.** The approve page shows `{issueKey: "<string>"}`, never which issue. Value-free persistence is the right default for a disk file, but the human is approving blind. An in-memory, redacted, never-persisted arg preview is worth designing (Phase 2).
- **G6: content-guard pattern coverage** is known-format only; a hex/base64 high-entropy credential passes. Documented limit, optional entropy pack later.
- **Windows residuals (minor, mostly fixed):** control channel now platform-split (control.go/control_unix.go/control_windows.go, verified building on all three targets); remaining items are install.ps1, an INSTALL.md Windows section, the installer's Claude detection via ~/.zshrc, and optional VS Code workspace `.vscode/mcp.json` wiring. Folded into Phase 5.

---

## 2. The Core Design Decision: Un-bypassable Where It Matters, Silent Everywhere Else

The tension resolves once you notice two facts working together:

1. **Tier-B is the only un-bypassable control** (the client hook layer of Phase 1b is near-universal but opt-in, user-space, and bypassable in known ways; see Section 0), so anything genuinely dangerous must land in Tier-B.
2. **Standing grants already amortize Tier-B friction to one human prompt per identity×backend×tool, ever** (approvals.ts: approve once, `--always` persists, TTL supported via `ttlMs`). Annoyance is therefore bounded and front-loaded, not per-call. **Exception, added 2026-08-19: PRODUCTION holds no standing authority at all** (`NO_STANDING_GRANT_CLASSES`, approvals.ts). Every PRODUCTION call needs its own fresh one-time approval, because a PRODUCTION tool can be a universal executor whose blast radius one grant would silently blanket.

That combination means the classifier can be aggressive about escalating dangerous operations without violating the non-annoyance goal: the 80% (reads, benign writes) never prompt a human; the 20% (destructive, outbound, production, vault) prompt **once** and are then remembered for as long as the human chose.

### 2.1 Option (a), the keystone: gateway-side default-conservative escalation policy — **ADOPT**

**Principle: manifests declare facts, the gateway declares policy.** The generator should keep emitting facts it can derive deterministically (http_method, verb-bearing tool names, tags). The escalation from "fact" to "friction tier" belongs at the PEP, in gateway config, so the operator can tune policy centrally without regenerating 37 backends, and so hand-authored and generated manifests get identical treatment.

**Mechanism (deliberately minimal):** an escalation overlay that runs immediately after `ManifestRegistry.classify()` and, when a rule matches, injects a synthetic `writeGuard` value (`"policy:<rule-name>"`). This single mutation makes the tool Tier-B through the **existing** predicate (`isTierBClass` returns true for any non-empty writeGuard, approvals.ts:107) and the existing `decideGate` gating (manifest.ts:104), with zero changes to approvals.ts or the dispatch paths. The rule name lands in the decision log via the existing writeGuard field (gateway.ts:1781). One new module, no new enforcement plumbing.

**The shipped classification policy:**

| Rule | Trigger (facts) | Result | Rationale |
|---|---|---|---|
| **R1 delete-method** | `http_method: "DELETE"` | Tier-B (`policy:delete-method`) | HTTP semantics say irreversible removal. Requires the generator to keep emitting http_method (it already does, go-generator.ts:1707-1709) and manifest.ts to carry it into `SafetyClassification` (today `classify()` drops it; small schema addition). |
| **R2 destructive-verb** | tool name matches DESTRUCTIVE_VERB_REGEX, a strict subset of WRITE_VERB_REGEX: `delete, remove, purge, destroy, drop, terminate, kill, revoke, wipe, erase, shutdown, deprovision, force` | Tier-B (`policy:destructive-verb`) | Name says irreversible. `remove` is the borderline inclusion (often benign, e.g. remove-label); keep it in the shipped default because grants amortize the cost, and the verb list is a config knob the operator can trim. |
| **R3 human-outbound-verb** | tool name matches OUTBOUND_VERB_REGEX: `send, reply, email, notify, broadcast, publish, comment, message` | escalate class to HUMAN_OUTBOUND | Puts messaging/email tools under both Tier-B approval AND the existing PCI/SSN arg guard (gateway.ts:1880-1899), which currently never fires on generated tools. Severs the lethal-trifecta exfil leg. |
| **R4 production-backend** | backend name matches operator-listed globs in `safety.escalation.production_backends` | escalate class to PRODUCTION (all non-READ tools of that backend) | Closes G2. Ships empty; the operator names their production backends once. |
| **R5 exemptions** | `safety.escalation.exempt: ["backend.tool", ...]` | skip escalation for the listed tool | Policy-level opt-out, distinct from grants (grants are per-identity and audited per approval; exemptions are a deliberate operator statement that a tool is misclassified by the heuristics). |

Config sketch (config.ts `SafetyConfigSchema` addition, all defaults shown):

```yaml
safety:
  enforce: blocking            # existing, stays default (config.ts:89)
  escalation:
    enabled: true
    delete_method_to_tier_b: true
    destructive_verbs: [delete, remove, purge, destroy, drop, terminate, kill, revoke, wipe, erase, shutdown, deprovision, force]
    outbound_verbs: [send, reply, email, notify, broadcast, publish, comment, message]
    production_backends: []    # operator opt-in globs
    exempt: []                 # "backend.tool" entries
```

**Resulting tier layout (the friction budget):**

- **READ (GET/HEAD): zero friction, ever.** No change.
- **Tier-A (benign writes: POST/PUT/PATCH, non-destructive, non-outbound): zero human friction.** One model round-trip in blocking mode (the confirmed re-call), which costs tokens, not human attention. Honestly documented as a deliberate-action + audit mechanism, not a security control (fixes G3).
- **Tier-B (DELETE, destructive verbs, outbound, vault): one human prompt per tool, ever** (or per TTL window if the human prefers `--ttl`), then silent.
- **PRODUCTION: one human prompt per CALL, always.** It is the single class that refuses standing authority (`NO_STANDING_GRANT_CLASSES`), so `--always`, a class grant, and a backend-wide `thesun trust` wildcard all fail to authorize it.

Estimated impact on a typical generated REST server: DELETE endpoints plus destructive/outbound verbs are roughly 10-25% of tools. First-session setup on a new backend might park three or four tools; `thesun approve --always` on each (or the Phase 2 `thesun trust` shortcut) and the backend is silent thereafter, with every grant on record.

### 2.2 Option (b): capability-gated MCP elicitation — **ADOPT as UX upgrade, Phase 3, opt-in at first**

Elicitation is a real server→client→human prompt, supported by exactly two of the five clients (VS Code Copilot and Codex CLI; not Copilot CLI, not OpenCode). So it can never be the universal mechanism, but where available it converts "call parks, agent tells human to run a CLI command, human approves, agent retries" into "dialog appears in the editor, human clicks Approve, the in-flight call proceeds immediately." That is a large annoyance reduction on the clients that support it.

**Design:**

1. **Capability capture:** the gateway already creates a per-session server (`createSessionServer`, gateway.ts:272/525) and learns the session id at `onsessioninitialized` (gateway.ts:517-523). At initialize, capture the client's declared capabilities and `clientInfo` (the SDK exposes client capabilities on the server object post-initialize) into the session map.
2. **Flow:** `dispatchTierB` with no grant → create the PendingApproval exactly as today (the park record is the source of truth and the fallback) → if the session declared the `elicitation` capability AND config allows it, send an `elicitInput` request: message = `describeApproval(pending)` (type-tagged summary, approvals.ts:133-135), schema = `{approve: boolean, standing: boolean}`, timeout 120s. On accept → `approvalStore.approve(id, {standing})` → continue the still-open dispatch inline (unlike the CLI path, the request is in flight, so no retry needed). On decline, timeout, or any error → return the parked response verbatim as today.
3. **Security invariant preserved:** the elicitation response is produced by the client's UI from human input; it does not travel through the model. The Tier-B constraint ("nothing that authorizes may travel through the model") holds, **conditional on the client actually presenting the dialog to a human**. That is a trust assumption about the client binary that the out-of-band path does not require.
4. **Because of that assumption, ship it off by default** (`approvals.elicitation: "off" | "on"`), and gate promotion to default-on behind an explicit acceptance test: run Codex CLI in its full-auto approval mode and VS Code Copilot with per-tool always-allow, and verify the elicitation dialog still requires a human click and is not auto-accepted. If any client auto-accepts elicitations in a full-auto mode, add a `clientInfo.name` blocklist. Elicitation must degrade to the park, never replace it.

Do NOT use elicitation for Tier-A. Tier-A fires on every gated write; prompting a human per write is exactly the dialog fatigue the operator forbade. (A "first Tier-A call per tool per session elicits once" variant is a possible later refinement; it is explicitly out of scope until the Tier-B flow is proven.)

### 2.3 Option (c): non-annoyance mechanisms — **ADOPT selectively**

Already exists and is the backbone: one-time grants, standing grants (`--always`, refused for PRODUCTION), TTL grants (`ttlMs` in approvals.ts, `ttlMinutes` parsed by the /approve route), dedup of pending approvals, an HTML approve page. Extensions worth building, in value order:

1. **Park notification (highest value per line of code).** Today the human learns a call parked only if the agent relays it. Add an OS notification on `tierb.parked` (macOS `osascript`, Windows toast via PowerShell, Linux `notify-send`; all best-effort, config-off-able) deep-linking to the /approve page. This collapses the real-world annoyance, which is not the approval itself but the discovery latency.
2. **`thesun trust <backend> [--ttl 30d]`:** backend-wide standing grant (identity × backend × `*`). Requires a tool-glob dimension in `findGrant` (approvals.ts:278-280). Deliberately CLI-only and explicit (never offered in the parked JSON the model sees; keep the model's suggested remedy per-tool). Warn on creation that it covers future tools of that backend.
3. **In-memory arg preview on the approve page (fixes G5):** show content-guard-redacted actual values for pending approvals in the HTML/CLI view only, sourced from a RAM map keyed by approval id, never written to approvals.json. The disk file keeps type tags. Informed consent without persistence risk.
4. **`thesun approvals watch`:** a foreground CLI mode that tails parks and prompts y/N/always inline, for terminal-centric operators. Nice-to-have after 1-3.

### 2.4 Option (d): Tier-A nonce — **DEFER, and be honest about why**

A nonce (gateway issues a challenge token in the block response; the confirmed re-call must echo it) adds **zero security against a full-auto model**: the model reads the nonce from the tool result and echoes it, exactly as it reads the `confirmationRequired` hint today. Any claim that a nonce "hardens" Tier-A against autonomous clients would be a soft control dressed as hard.

What a nonce genuinely buys, and the only honest justification, is **audit integrity**:

- It eliminates blind first-call self-confirm. Today `confirmed:true` on the very first call proceeds (manifest.ts:108-110) and the challenge text was never seen. With a nonce, every executed Tier-A call provably had a prior challenge round-trip: the model demonstrably received the warning and the redacted args before proceeding.
- Bound to an args-hash (stateless HMAC over tool + canonical-args-hash + expiry, no store needed), it closes confirm-then-swap: confirm with benign args A, then execute with different args B under the same confirmed flag. With binding, the audit pair (challenge, execution) is guaranteed to describe the same arguments.

Verdict: worth doing eventually because it is cheap (one stateless HMAC helper, one field) and makes the decision log truthful, but it changes no adversarial outcome. Phase 4, after everything that changes real outcomes. If audit truthfulness is ever a compliance requirement (e.g. demonstrating informed agent action for an assessor), pull it forward.

---

## 3. The Universal-Enforcement Architecture

One path, in prose. Layer 1 (client hooks, Phase 1b) sits inside each client and fires before the call leaves it; Layer 2 (the gateway PEP) is the floor everything funnels through:

```
[each client: optional thesun hook fires BEFORE the call leaves the client — Phase 1b:
 Claude/Copilot/Codex PreToolUse (shared mcp__server__tool + permissionDecision schema),
 OpenCode tool.execute.before plugin. Reads, and Tier-B calls, pass through untouched.]

Claude Code ──(streamable-http, ~/.claude.json or ./.mcp.json)──────┐
Copilot CLI ──(streamable-http, ~/.copilot/mcp-config.json)─────────┤
Copilot VS Code ──(streamable-http, .vscode/mcp.json)───────────────┤
Codex CLI ──(streamable-http, ~/.codex/config.toml)─────────────────┼──► gateway :3100 /mcp
OpenCode ──(streamable-http, ~/.config/opencode/opencode.json)──────┘        │
                                                                             ▼
                                            per-session server + identity + client capabilities
                                                                             │
                                                                             ▼
                                        dispatchToolCall()  ◄── THE universal PEP (gateway.ts:1650)
                                                                             │
                    ┌────────────────────────────────────────────────────────┤
                    ▼                                                        ▼
     classify (manifest → name-pattern → UNCLASSIFIED)          fail-closed audit line
     + escalation overlay (Phase 1: policy → writeGuard)        (no log write = no dispatch,
                    │                                            gateway.ts:1689-1699)
        ┌───────────┴──────────────┐
        ▼                          ▼
   Tier-B? (isTierBClass)     decideGate (Tier-A)
        │ no grant                 │ unconfirmed
        ▼                          ▼
   PARK (approvalPending)     block-response hint
   human channel ONLY:        (model self-confirms;
   loopback /approve,         speed bump + audit,
   thesun approve CLI,        NOT a security boundary)
   [Phase 3: elicitation           │
    on capable clients]            ▼
        │ grant               content-guard args (HUMAN_OUTBOUND PCI/SSN, sql/exec)
        └──────────┬───────────────┘
                   ▼
            callBackendTool (no other caller)
                   ▼
            content-guard result redaction (secrets/Luhn/SSN) ──► model
```

**What each client can and cannot enforce locally (corrected per the addendum):**

| Client | Local enforcement available | Role in thesun's two-layer design |
|---|---|---|
| Claude Code | PreToolUse hooks (deny/ask); managed settings incl. `allowManagedHooksOnly` | Phase 1b hook adapter (reference schema). Defense-in-depth, never the guarantee. |
| Copilot CLI | `preToolUse` hook, fail-closed on crash; `permissionRequest` hook for non-interactive `-p` mode; `.github/hooks/*.json` or `~/.copilot/hooks/` (GA 2026-02) | Phase 1b hook adapter (shared schema). Still the canonical proof-bar client because hooks are opt-in and user-removable. |
| Copilot VS Code | Agent-mode PreToolUse hooks (Preview, `permissionDecision:"deny"`); per-tool always-allow; MCP elicitation UI | Phase 1b hook adapter (Preview caveat) + elicitation UX (Phase 3). |
| Codex CLI | `PreToolUse` + `PermissionRequest` hooks covering `mcp__server__tool` (`~/.codex/hooks.json`, pin ≥ v0.141, enforcement bug #4152); enterprise `allow_managed_hooks_only`; MCP elicitation | Phase 1b hook adapter + elicitation UX (Phase 3). |
| OpenCode | `tool.execute.before` plugin hook (throw = block; MCP coverage since PR #2320); no `ask` decision; subagent bypass #5894; no elicitation | Phase 1b plugin adapter, deny-only. Weakest local layer; the gateway floor carries it. |

**Design rule that falls out:** every GUARANTEE is specified, tested, and documented against Copilot CLI with `--allow-all-tools` **and no thesun hooks installed**. If it holds there, it holds everywhere. The hook layer is proven separately (Phase 1b acceptance) as an additive layer, never as a precondition for any Section 5 claim.

**The client hook layer (ship it everywhere, depend on it nowhere):** thesun packages ONE shared policy script wired into Claude, Copilot CLI, Copilot VS Code, and Codex via their common `mcp__server__tool` matcher + `permissionDecision` convention, plus an OpenCode plugin variant wrapping the same core module (full design in Phase 1b). It human-gates the Tier-A self-confirm step in each client's native UX and deliberately passes Tier-B calls through so the gateway can park them (a client-side Tier-B deny would starve the approval queue; see Phase 1b). Composition: gateway Tier-B remains the floor for everyone; the hook raises Tier-A to human-gated on every client that has it installed. The packaging must state plainly that an uninstalled or removed hook changes nothing about the gateway guarantees.

---

## 4. Phased Roadmap

Priority function: real-world harm reduction × universality × non-annoyance, then cost. Phases 1, 1b, and 2 are the payload; everything after is refinement. Phase 1 (the gateway floor) strictly precedes Phase 1b (the hook layer) because the hook layer consumes the escalation pipeline's classification output; Phase 1b and Phase 2 can then run in parallel.

### Phase 0: Truth in documentation + shipped defaults (days, no code risk)

- **Objective:** stop overclaiming; make the security model legible to users and assessors.
- **Work:** a `docs/SECURITY-MODEL.md` stating: gateway = universal PEP; Tier-A = deliberate-action + audit (not a boundary); Tier-B = the universal hard control and how to approve; content-guard scope and its known limits (pattern list, maxScanChars pass-through, no entropy detection); identity granularity caveat (G4). Add the Windows section to docs/INSTALL.md (paths for all five clients are already known, including `%USERPROFILE%` variants). Document the shipped defaults from Section 6.
- **Acceptance:** a new user can answer "what stops a full-auto Copilot from deleting a repo?" correctly from the docs alone.
- **Do NOT build yet:** anything.

### Phase 1: Escalation policy overlay (the keystone, ~1 week)

- **Objective:** genuinely dangerous generated tools become Tier-B by default; close G1/G2.
- **Files:** `gateway/src/manifest.ts` (carry `http_method` into `SafetyClassification`; escalation applied at classify time or in a thin `escalation.ts` wrapper; escalation injects `writeGuard: "policy:<rule>"` and, for R3/R4, rewrites the class), `gateway/src/config.ts` (schema per 2.1), generator: none required for R1-R3 (http_method already emitted, go-generator.ts:1707-1709). Tests: unit tests on the overlay rules; e2e in `gateway/test/e2e/` proving a generated `*_delete_*` tool parks.
- **Sketch:** pure function `applyEscalation(classification, facts, cfg): SafetyClassification`, called once per classification, tagged so the decision log shows `writeGuard: "policy:delete-method"`. Exemption list checked first. No changes to approvals.ts, dispatchTierB, or decideGate (reuse of the writeGuard predicate is the whole trick).
- **Acceptance (the universal proof):** Copilot CLI with `--allow-all-tools` invokes a DELETE-backed tool on a freshly generated backend → response is `approvalPending`, backend never called, decision log shows `tierB:true, decision:"parked", agentConfirmedIgnored:true` when the model tried `confirmed:true`; after `thesun approve <id>`, retry succeeds; after `--always`, third call is silent.
- **Risk:** over-escalation annoyance on verb false-positives (`remove`). Mitigations: exemption list, configurable verb list, grants amortization. Monitor via decision log: count of parks per tool per week is the tuning signal.
- **Do NOT build yet:** elicitation, nonce, entropy detection, backend-wide grants.

### Phase 1b: Ship the universal client-side hook layer (~1-2 weeks, parallel with Phase 2 once Phase 1 lands)

- **Objective:** deliver the operator's "hooks work universally" goal literally: one thesun policy hook installed into all five clients that human-gates or denies dangerous gateway tool calls before they leave the client, firing independently of the client's full-auto mode. First line of defense in front of the gateway floor, never a replacement for it.
- **Design principle, one policy brain:** the hook must not re-implement classification. The gateway writes a `policy-snapshot.json` into THESUN_HOME on startup and config reload (tool → {tier, class, escalation rule}), derived from the exact classify + escalation pipeline that gates dispatch (Section 2.1). The hook reads that snapshot locally: no network on the hot path, deterministic, fast, and structurally incapable of disagreeing with the gateway about what is dangerous.
- **Hook behavior (the part that must be designed carefully):**
  - **READ and unlisted tools: silent pass.** The hook is invisible on the 80%; non-annoyance preserved.
  - **Tier-A gated tools invoked with `confirmed:true`: `ask`** via the client's native permission prompt where the schema supports it (Claude, Copilot, Codex `permissionDecision`/`permissionRequest`), **`deny` with an explanatory message on OpenCode** (plugin throw is the only primitive). This restores human-in-the-loop on exactly the step full-auto removed, at the moment of highest signal (a self-confirm of a gated write), in native client UX. Configurable per install: `off | ask | deny`.
  - **Tier-B tools: PASS THROUGH, deliberately.** A client-side deny would prevent the call from ever reaching the gateway, so no PendingApproval would be created, no park notification would fire, and the human would have nothing to approve. The gateway park IS the control; a hook stepping in front of it would break the approval workflow while adding zero security.
- **Delivery:** `thesun hooks install [--client all|claude|copilot|copilot-vscode|codex|opencode]` plus `thesun hooks status` (installation + version-drift report per client); `thesun doctor` gains a hooks section. One shared Node script (the bundle already ships a Node runtime) serves the four schema-compatible clients: Claude settings hook entry, `~/.copilot/hooks/thesun.json` (optionally repo-level `.github/hooks/`), `~/.codex/hooks.json`, the VS Code hooks file. OpenCode gets a thin TS plugin wrapping the same core module, dropped into its plugins directory. Offered during onboarding, never forced.
- **Files:** new fleet CLI subcommands (`hooks install/status`, doctor section), `packaging/hooks/` (shared script + OpenCode plugin), gateway (small snapshot writer reusing the classification pipeline), docs.
- **Acceptance (the empirical gate the vendor docs do not settle):** for EACH client in its full-auto mode (Copilot `--allow-all-tools`, Codex `danger-full-access`/approval-never, OpenCode blanket `permission:"allow"`, Claude `bypassPermissions`), a `confirmed:true` call to a Tier-A gateway tool fires the hook and the ask/deny actually takes effect. Record the exact runtime `toolName` string each client emits for a remote streamable-http tool (the matcher depends on it) and pin minimum client versions (Copilot hooks GA 2026-02, Codex ≥ v0.141, VS Code Preview build noted). Regression: with hooks uninstalled, every Phase 1 gateway acceptance test passes unchanged.
- **Honest caveats to document verbatim:** opt-in per machine; hook configs are user-writable files, so a fully autonomous agent with filesystem access can remove them unless the client's managed mode is enforced (Claude `allowManagedHooksOnly`, Codex `allow_managed_hooks_only`; no verified Copilot or OpenCode equivalent); OpenCode `task`-tool subagent calls bypass the plugin (#5894); VS Code hook format is Preview and may change; Codex MCP enforcement requires ≥ v0.141 (#4152). None of these caveats weaken the gateway floor, which is why the floor remains the guarantee.
- **Risk:** per-client schema drift (especially the Preview surface); mitigate with version pinning, `thesun hooks status` drift detection, and per-client schema fixtures in CI. Failure-mode asymmetry: Copilot's `preToolUse` is fail-closed on hook crash while Claude hook timeouts fail open; keep the script dependency-free, snapshot-read-only, and under 100ms so neither mode is exercised in practice.
- **What NOT to build:** client-side Tier-B denial (breaks the park workflow, above); client-side grant or memory state (grants live at the gateway, one source of truth); any hook logic requiring network calls; any Section 5 guarantee that assumes the hook is present.

### Phase 2: Non-annoyance kit (~1 week)

- **Objective:** make Tier-B approvals fast, discoverable, and informed.
- **Work:** (1) OS notification on `tierb.parked` (best-effort, `notifications: true` config default on); (2) `thesun trust <backend> [--ttl]` backend-wide grants with tool-glob support in `findGrant`; (3) in-memory redacted arg preview on the /approve HTML page and `thesun approve` listing (RAM map keyed by approval id, content-guard redaction applied, never persisted; fixes G5); (4) surface `--ttl` in `thesun approve` help.
- **Files:** gateway.ts (notification emit, approve-page render), approvals.ts (glob grants; preview map lives in gateway.ts, not the store), fleet CLI (`thesun trust`).
- **Acceptance:** median human time from park to approval under 15 seconds with the notification path; approving shows redacted real values; `grants.json` and `approvals.json` still contain zero argument values (grep the files in the test).
- **Risk:** glob grants widen blast radius; mitigate with explicit flag, creation warning, and `thesun grants` visibility.
- **Do NOT build yet:** approvals watch mode (build only if notification telemetry shows demand).

### Phase 3: Capability-gated elicitation (~1-2 weeks)

- **Objective:** in-editor human approval on VS Code Copilot and Codex; park fallback everywhere else.
- **Work:** per-session capability + clientInfo capture at initialize (gateway.ts:512-540 region); elicitation branch in `dispatchTierB` per 2.2; config `approvals.elicitation` default `off`; the auto-accept verification tests; clientInfo blocklist knob if needed.
- **Acceptance:** VS Code Copilot: Tier-B call → in-editor dialog → Approve → same in-flight call completes without retry, grant recorded. Codex in full-auto approval mode: dialog still requires the human (verified manually, recorded in the test plan). Copilot CLI/OpenCode: behavior byte-identical to Phase 1 (regression tests). Decline/timeout paths return the parked response.
- **Risk:** a client auto-accepting elicitation would silently convert Tier-B to Tier-A on that client. This is why the park record is created first, the feature is opt-in, and promotion to default-on requires the verification evidence.
- **Do NOT build yet:** elicitation for Tier-A; sampling anything.

### Phase 4: Audit integrity + hardening (opportunistic)

- **Work:** (1) Tier-A stateless HMAC nonce bound to tool + args-hash + expiry (per 2.4; documented as audit integrity, explicitly not an adversarial control); (2) optional high-entropy secret detector pack in content-guard (off by default, false-positive-prone); (3) client-scoped grant identity option (`identity = install-uuid + clientInfo.name`) for operators who want per-client grants (addresses G4); (4) managed-hooks hardening guidance for enterprise installs, layered on the Phase 1b artifacts (Claude `allowManagedHooksOnly`, Codex `allow_managed_hooks_only` in requirements.toml), documenting that Copilot and OpenCode currently lack a managed equivalent.
- **Acceptance:** every executed Tier-A gated call in the decision log has a matching prior challenge with identical args-hash; managed-hooks guidance verified on Claude and Codex (hook removal by the agent is denied under the managed setting).

### Phase 5: Windows + packaging residuals (low priority, fold into releases)

- install.ps1 for dev-from-source (shipping path is prebuilt binaries, so this is convenience); the installer's Claude detection: replace the ~/.zshrc probe with platform-aware detection (`~/.claude.json` / `%USERPROFILE%\.claude.json` presence); optional `.vscode/mcp.json` workspace wiring in the installer for the VS Code Copilot path; Windows CI job running the gateway e2e suite so approvals.json/grants.json paths (approvals.ts:49-51) are exercised on `%AppData%`.

---

## 5. Acceptance / Proof Standard

The proof bar for every GUARANTEE: **demonstrate it on Copilot CLI with `--allow-all-tools` and no thesun hooks installed** (the least-governed reachable state). Claude-only proof proves nothing about universality, and hook-present proof proves nothing about machines where the hook was never installed or was removed. The hook layer is proven separately, as an additive layer.

| Control | Universal proof test | Status |
|---|---|---|
| Tier-B ignores model self-confirm | Tier-B tool called with `confirmed:true` → parked, backend not called, `agentConfirmedIgnored:true` logged | **Proven** (tier-b-approvals.test.ts; e2e harness), plus code path gateway.ts:1666-1668 runs before decideGate |
| Approval channel unreachable by model | /approve absent from MCP tool surface | **Proven** (tier-b-approvals.test.ts:229-236); loopback + admin gate at gateway.ts:825-841 |
| Tier-B holds in advisory mode | `enforce: advisory` + Tier-B call → still parks | **Implemented-unproven** (dispatchTierB never consults enforce for the park; add one unit test) |
| Egress secret/PCI redaction on all clients | Backend returns a planted `AKIA...` + Luhn card via Copilot CLI → result contains `[REDACTED:*]` | **Proven** at gateway level (content-guard.test.ts); client-agnostic by construction; add one live non-Claude smoke test to the release checklist |
| HUMAN_OUTBOUND PCI arg block | Outbound-classified tool with a Luhn-valid card in args, `confirmed:true` → `content_guard_blocked`, backend not called | **Proven** mechanism (gateway.ts:1880-1899 + tests); **not reachable on generated tools until Phase 1 R3** |
| Escalation: DELETE/destructive/outbound → Tier-B | Phase 1 acceptance test above, run against a generated backend from Copilot CLI full-auto | **Designed-only** |
| Grants lifecycle (one-time consume, standing, TTL expiry) | approve → one dispatch → re-park; `--always` → persistent; TTL → expiry re-parks | **Implemented-unproven** for TTL-expiry re-park (store logic at approvals.ts:266-272; add the time-travel unit test) |
| Fail-closed audit | decision log unwritable → all dispatch denied | **Implemented** (gateway.ts:1689-1699); verify a test exists in invariants.test.ts, else add |
| Elicitation approval + fallback | Phase 3 acceptance tests incl. the auto-accept verification | **Designed-only** |
| Windows approval store | e2e suite green on windows runner with `%AppData%\thesun` | **Implemented-unproven** (paths correct at approvals.ts:49-51; no Windows CI yet) |
| Client hook layer fires in full-auto (all 5 clients) | Per client, in its full-auto mode: `confirmed:true` Tier-A call → hook ask/deny takes effect; runtime `toolName` string for a remote streamable-http tool recorded; minimum versions pinned (Copilot GA 2026-02, Codex ≥ v0.141, VS Code Preview) | **Designed-only** (Phase 1b empirical gate; vendor docs imply yes but did not test this combination) |
| Hook layer honors the Tier-B pass-through | Hook installed + Tier-B call → call reaches the gateway and parks normally (approval workflow intact) | **Designed-only** (Phase 1b) |
| Gateway floor independent of hooks | Full Phase 1 acceptance suite passes with hooks uninstalled/removed | **Designed-only** (Phase 1b regression suite) |

Every "implemented-unproven" row is a named test away from proven; schedule those tests inside the phase that touches the nearest file.

---

## 6. Shipped Defaults (conservative, not annoying)

| Knob | Ship as | Rationale / operator dial |
|---|---|---|
| `safety.enforce` | `blocking` | Already the schema default (config.ts:89). `advisory` remains available for burn-in; Tier-B parks regardless. |
| `safety.escalation.enabled` | `true` | The keystone. Turning it off reverts to today's behavior (Tier-B only via hand manifests). |
| delete-method / destructive-verbs / outbound-verbs rules | `true` / full lists per 2.1 | Trim verb lists or use `exempt` per tool if a backend's naming causes false positives. |
| `safety.escalation.production_backends` | `[]` | Operator names production backends once; everything non-READ there becomes Tier-B. |
| `safety.unmanifested_read_allowlist` | `[]` | Keep the fail-closed inversion; the allowlist exists only for manifest burn-down (config.ts:107-112). |
| `content_guard.secrets` / `luhn` | `on` / `on` | Current defaults, universal, near-zero false positives (Luhn + IIN prefix, content-guard.ts:102-126). |
| `content_guard.ssn` / `sql_destructive` | `off` / `off` | False-positive-prone (9-digit patterns; "delete from" prose). Document how to enable; enable `ssn` for US-PII-heavy deployments. |
| Grants | one-time by default; `--always` and `--ttl` opt-in | Matches "prompt once, remember only when the human says so." |
| Park notifications | `on` (Phase 2) | Best-effort, silent failure, config-off-able. |
| `approvals.elicitation` | `off` until Phase 3 verification evidence, then `on` | The auto-accept check is the promotion gate. |
| Client hook layer (all 5 clients) | shipped via `thesun hooks install`, offered at onboarding, never forced | Tier-A confirm = `ask` (native prompt; `deny` on OpenCode), Tier-B = pass-through, READ = silent. First line of defense; the gateway floor is the guarantee. Enterprise installs: enable Claude `allowManagedHooksOnly` / Codex `allow_managed_hooks_only` per Phase 4 guidance. |

---

## 7. Summary for the Operator

1. "Hooks that work universally" is achievable more literally than first assessed: every client now ships a blocking pre-tool hook, three of them on Claude's exact schema, so thesun ships one shared policy script wired into all five (Phase 1b). But hooks are opt-in, user-space, and bypassable in documented ways, so they are the first line of defense, not the guarantee.
2. The guarantee lives at the gateway, the one place all five clients funnel through, and its Tier-B path is the only model-unreachable, un-bypassable control (proven in tests today). The single most important change remains small: an escalation policy overlay (~1 module + config) that routes DELETE-method, destructive-verb, outbound, and production operations into the Tier-B machinery that already exists. Without it, Tier-B protects zero generated tools; with it, the dangerous 20% is un-bypassable on every client even with no hooks installed, and standing grants keep it to one prompt per tool, ever.
3. The two layers divide cleanly: the gateway owns everything whose failure is a security incident (Tier-B, content-guard, audit); the hook layer owns human awareness and native UX (the Tier-A confirm gate), and deliberately passes Tier-B through so the approval workflow stays intact. Belt and suspenders, never either/or.
4. Annoyance is solved by amortization plus discoverability: grants front-load friction to a single approval, a park notification removes the "nothing happened and I didn't know why" failure mode, hooks prompt only on gated self-confirms, and elicitation makes the two capable clients feel native.
5. Say the honest thing in the docs: Tier-A at the gateway is a deliberate-action speed bump and audit pair, not a boundary (the client hook is what upgrades it to a human gate, where installed). The nonce can make the audit truthful later; it will never stop a full-auto agent, and pretending otherwise would be a soft control dressed as hard. The same honesty applies to the hook layer itself: one empirical verification (hooks firing in each client's full-auto mode, with recorded toolName strings and pinned versions) is mandatory before shipping, because the vendor docs imply it but did not prove it.
