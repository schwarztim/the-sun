# Security Controls — thesun MCP Gateway

What the gateway defends against, what it guarantees, and where its guarantees stop.
Written for people deploying or auditing thesun, not for people extending its code — for
the implementation, see `src/manifest.ts` and `src/gateway.ts`.

## The one-sentence version

Every tool call that reaches a backend through the gateway passes through a single
chokepoint that classifies the tool's blast radius and, for anything that isn't a plain
read, refuses to dispatch it until the caller explicitly re-asks with `confirmed: true`.
Guardrails the AI can't talk its way out of — for every client. Claude Code, GitHub
Copilot CLI, OpenCode, or a hand-rolled script all go through the identical gate, because
the gate lives in the gateway process, outside the model's own control plane, not in any
one vendor's client behavior.

## Threat model

This control exists for one scenario: **an agent — misled by a prompt injection, a bad
tool response, a hallucinated plan, or just an aggressive instruction — decides to call a
tool that mutates state, messages a human, touches production, or reads out a secret, and
nothing in its own reasoning stops it.** The agent doesn't have to be malicious or even
wrong about wanting to help; it just has to be wrong about whether it should have asked
first. The gateway doesn't try to detect *bad intent* — it can't. It enforces a much
simpler, checkable property: **calls above a defined blast radius don't execute on the
first ask, from any client, no matter what the model was told to do.**

What this is *not* a defense against: a human operator who deliberately confirms a
destructive call, a compromised backend that misbehaves after a legitimately-authorized
call reaches it, or an attacker with direct access to the gateway's own host filesystem
(see **Scope and limits** below).

## What's gated vs. what's not

Every tool the gateway exposes is classified into one `SafetyClass`
(`src/manifest.ts`):

| Class | Meaning | Example (from a shipped manifest) |
|---|---|---|
| `READ` | No mutation, no side effect. Never gated. | `shodan-go.json` → `shodan_search`, `shodan_host` |
| `WRITE` | Creates, updates, or deletes state. | `az-teams.json` → `teams_send_message` (also see `HUMAN_OUTBOUND` below) |
| `SIDE_EFFECT` | Triggers a downstream process/workflow. | `servicenow.json` → `resolve_incident`, `close_incident` |
| `HUMAN_OUTBOUND` | Sends a message a human will read. | `az-teams.json` → `teams_send_message`, `teams_reply_to_message` |
| `PRODUCTION` | Touches a live production system. | `akamai.json` → `activate_property`; `venafi.json` → `issue_certificate`/`revoke_certificate`; `tufin.json` → `apply_policy`, `approve_request` |
| `VAULT_VALUE` | Returns a secret value. | `azure-key-vault-mcp.json` → `get_secret`, `list_secrets` |
| `UNCLASSIFIED` | No manifest entry, name doesn't match a write verb. | any tool from a backend with no manifest yet |

Everything except `READ` is a **gated class** (`isGatedClass()` — literally
`class !== "READ"`). A manifest author can also force gating on an otherwise-`READ`
tool by setting a non-empty `write_guard` string on its capability entry (e.g.
`az-teams.json`'s `teams_send_message` carries
`write_guard: "router_confirmation_maps_to_downstream"`) — the explicit guard always
wins.

### Fail-closed defaults (no manifest, or a mislabeled one)

Classification has three tiers, in priority order:

1. **Manifest entry** for `(backend, tool)` — the author's explicit `safety_class`.
2. **Name-pattern fallback**: if the tool name contains a write verb
   (`create`, `update`, `delete`, `send`, `approve`, `deploy`, `revoke`, `merge`,
   `terminate`, `escalate`, … — see `WRITE_VERB_REGEX` for the full list), it's
   classified `WRITE` even with zero manifest coverage.
3. **`UNCLASSIFIED`** — verb-less name, no manifest entry. Gated by default (a
   backend can opt into the legacy behavior of treating these as `READ` via
   `safety.unmanifested_read_allowlist`, but that is an explicit, visible, per-backend
   opt-out an operator has to write into config — not a silent default).

**Manifest integrity gate:** a manifest is validated at load time
(`validateManifestSemantics`) and rejected wholesale if it lies about safety —
specifically if it labels a write-verb tool `READ` (`RISKY_AS_READ`), declares an empty
`write_guard` (`WRITE_GUARD_EMPTY`), lists the same tool twice (`DUPLICATE_TOOL`), or
breaks one of the three per-action carve-out rules below (`ACTION_PARAM_MISSING`,
`ACTION_READ_BLANK`, `ACTION_READ_ON_TIER_B`). A rejected manifest doesn't get "reduced
trust" — its backend's tools fall back to the fail-closed name-pattern/`UNCLASSIFIED`
path above, so a bad manifest can only make a tool *more* gated, never less.

### Per-action classification (action-multiplexed tools)

A tool that multiplexes many operations behind one `action` argument can only be
classified as a whole, so its class gets pinned to the most dangerous action it can
reach. An orchestrator MCP may be 18 such tools: `orchestrator_memory` alone covers 19 actions from
`search` to `store`, which meant asking a question cost a confirmation. A capability
may therefore declare a closed list of action values that classify `READ` for that
call only:

```json
{
  "tool": "orchestrator_memory",
  "safety_class": "SIDE_EFFECT",
  "action_param": "action",
  "read_actions": ["load", "search", "search_semantic", "resume", "manifest", "index_status"]
}
```

`action_param` names the argument to inspect and is never inferred; `read_actions`
lists the audited values. `refineForArgs` (`src/manifest.ts`) applies it once per
dispatch, inside the Policy Enforcement Point, and returns the declared class
unchanged unless the call came from a manifest capability that declares both fields,
is not Tier-B, and carries that argument as an own property whose value is a string
matching a listed value exactly. Absent, non-string, unknown, or differently-cased
arguments all keep the base class, so the mechanism can only ever lower one Tier-A
class to `READ` for one call; a write action still gets the write class, and the
registry's stored classification is never mutated. A `READ` produced this way is
recorded in the decision log with an `actionRead` field naming the action, so the
audit trail never reads as though the whole tool were read-safe.

**Only sound for a closed enum.** This is not a general argument-conditional escape
hatch. It works because those action values come from a known, finite list that can be
audited one at a time. It must never be pointed at an open-ended executor: Akamai's
`akamai_raw_request` dispatches any of 1145 catalogued operations by name, including
live CDN activation, so there is no finite set to audit and its own class is the only
honest answer. Two guards enforce that: a capability that is `PRODUCTION` /
`VAULT_VALUE` / `HUMAN_OUTBOUND` or carries a `write_guard` may not declare
`read_actions` at all (`ACTION_READ_ON_TIER_B`, rejected at load), and `refineForArgs`
refuses those same cases again at dispatch, including a class the escalation overlay
promoted after the manifest was read.

## How confirmation works

When a gated tool is called without `confirmed: true`, the gateway does not call the
backend. It returns a JSON payload instead:

```json
{
  "confirmationRequired": true,
  "tool": "fakebe_fake_delete_item",
  "safetyClass": "WRITE",
  "source": "name-pattern",
  "reason": "This tool is classified WRITE and requires confirmation to authorize the call.",
  "redactedArguments": { "id": "<string>" }
}
```

Argument values are never echoed back pre-confirmation — `redactedArguments` keeps the
argument keys but replaces every value with a type tag (`<string>`, `<number>`,
`<null>`, `<array>`). The deny payload also carries no bypass instructions (no `remedy`,
no `next` field) — the gate doesn't teach a caller how to get around itself.

**To proceed, the caller re-invokes the exact same tool call with `confirmed: true`
added.** That's the entire mechanism:

```json
{ "tool": "fakebe_fake_delete_item", "arguments": { "id": "42" }, "confirmed": true }
```

This is a stateless retry, not an interactive prompt, elicitation, or sampling
round-trip. It requires nothing beyond what every MCP client already has: the ability to
call a tool with an argument. That's the entire point — it means the control works
**identically** whether the calling agent is Claude Code (which has its own permission
UI), GitHub Copilot CLI (which doesn't), OpenCode, or any other MCP client. thesun's
gate doesn't depend on, or defer to, whatever safety behavior a given AI vendor shipped;
it is the safety behavior, enforced once, for every client that connects.

## One gate, two doors

The gateway exposes backend tools two ways, and both roads lead through the same
enforcement point:

- **Mux path** — `gateway_call_tool({ tool, arguments, confirmed })`, handled in
  `handleMuxTool()`.
- **Direct path** — calling a namespaced tool by name directly (e.g.
  `fakebe_fake_delete_item`) via the standard MCP `CallToolRequest`, with a top-level
  `confirmed: true` on the arguments object. The gateway strips the `confirmed` flag
  before forwarding args to the backend (the backend never sees the gateway's internal
  flag), and the gate verdict is byte-identical to the mux path.

Both call `dispatchToolCall()` (`src/gateway.ts`) — there is exactly one Policy
Enforcement Point in the codebase, and `callBackendTool` (the function that actually
talks to a backend) has no other caller. A client cannot reach a backend tool by a route
that skips classification, and adding a new way to expose tools in the future only stays
safe if it also routes through `dispatchToolCall()`.

## Mechanism guarantees

These are the specific, checkable properties this control provides — not aspirational
goals, but things the code in `src/gateway.ts` / `src/manifest.ts` actually does:

- **No audit record, no dispatch.** `logSafetyDecision()` writes before
  `callBackendTool()` is ever invoked. If the write fails — disk full, bad path,
  permissions — `dispatchToolCall()` returns an `audit_unavailable` error and the
  backend is never called. There is no code path that executes a tool call without
  first successfully recording (or being explicitly configured to skip) that decision.
- **Metadata-only logging, never argument values.** The decision log line contains
  `{ ts, path, user, tool, backend, safetyClass, source, decision, enforce }` — no
  argument payload, not even redacted. The typed `redactedArguments` preview shown in a
  *deny response* is a transient value returned to the caller; it is never written to
  disk.
- **The gate cannot be turned off from inside a tool call.** There is no tool, argument,
  or MCP method exposed by the gateway that changes `safety.enforce`, edits a manifest,
  or clears the decision log. Policy lives in `config.yaml` and `manifests/*.json` on
  the gateway host — files an MCP client has no protocol-level way to reach, regardless
  of what an agent using that client is told to do.
- **Confirmation is a second explicit act, not an inference.** `confirmed: true` is
  never assumed from context, prior turns, or the client's own judgment — it must be
  present on the specific call being gated, every time.

## Why this is stronger than an in-client hook

Claude Code's own hook system (`~/.claude/settings.json` + hook scripts) is a real and
useful control, but it is **user-editable inside the agent's own environment**: it's a
file on the same filesystem an agent with sufficient permissions could read, and in some
configurations write. A sufficiently-manipulated session, or an operator who disables a
hook to "just get past" a block, changes enforcement for that session going forward.

The gateway's Policy Enforcement Point is a separate process the client only ever talks
to over the MCP wire protocol. There is no `edit_settings` tool, no file the client can
write to change what's gated, and no prompt that convinces `dispatchToolCall()` to skip
itself — the decision is made in a process the model's own token stream never touches.
That's what makes it usable as a control for clients (Copilot CLI, OpenCode, anything
else) that have **no hook system of their own to harden in the first place**: the
guarantee doesn't live in the client at all.

## Scope and limits — read this before assuming coverage

The gateway governs exactly one thing: **tool calls that flow through its MCP dispatch
path to a backend it routes.** Be precise about what that does and doesn't cover:

- **In scope:** any call to a backend tool exposed through this gateway, via the mux
  facade or the direct namespaced path — regardless of which MCP client made the call.
- **Not in scope:** an agent's local shell commands, local file reads/writes, or any
  other action that doesn't go through this gateway's MCP tool dispatch. If an agent has
  independent shell or filesystem access on its own host, this control has no visibility
  into that at all.
- **Not in scope:** the gateway's own config and manifests are protected *from MCP
  clients*, not from someone with direct filesystem or shell access to the gateway host
  itself. Host-level access control (who can SSH in, who can edit `config.yaml`) is a
  deployment concern outside this document.
- **For Claude Code specifically:** local actions outside MCP tool calls may be separately
  gated by Claude Code's own hook system, if the operator has configured one — that's a
  different, client-side control layered on top of, not provided by, this gateway.
- **For GitHub Copilot CLI, OpenCode, and most other MCP clients:** there is typically
  **no equivalent local guard at all**. For those clients, this gateway is the only
  programmatic security layer standing between the model and every tool it can call — not
  a supplement to something else the client already provides.

## Enforcement mode

`safety.enforce` is `"blocking"` by default (`src/config.ts`). In `"advisory"` mode, an
unconfirmed gated call still proceeds, but the decision is logged as
`safety.would_block` — useful for onboarding a new backend's manifest without breaking
existing callers while its classifications are being written. Advisory mode is a
deliberate, visible config choice an operator makes per deployment — it is not a hidden
default and should not be treated as equivalent to the guarantees above.

## Verifying this yourself

`test/e2e/invariants.test.ts` boots a real gateway against a real in-process MCP backend
(no mocks) and proves the behavior above end-to-end:

- `write-without-confirmed-blocks-mux-path` — an unconfirmed `WRITE` call via
  `gateway_call_tool` is denied, the backend records zero invocations, and the same call
  with `confirmed: true` proceeds and reaches the backend.
- `write-without-confirmed-blocks-direct-path` — the same proof against the direct
  namespaced dispatch path.
- `read-never-gated-both-paths` — a `READ`-classified tool proceeds without
  `confirmed` on both paths, even in blocking mode.

Run them with:

```bash
npm run test:e2e
```

---

## Appendix: illustrative enterprise-risk mapping (not a compliance attestation)

The table below maps specific mechanisms above to language enterprise risk/compliance
teams commonly use, to help internal conversations about where this control fits. **This
is not a certification, an audit finding, or a claim that thesun satisfies any framework
in full** — none of these frameworks have been formally assessed against this codebase.
Treat every row as "this mechanism is relevant to that control area," not "this control
is satisfied."

| Mechanism | Relevant to | Framework area (illustrative only) |
|---|---|---|
| Fail-closed confirm gate on mutating/outbound/production/vault-value tools | Requiring a deliberate second act before high-impact actions execute | PCI-DSS least-privilege concepts; SOX change-control concepts; ISO 27001 change-management concepts |
| Append-only, fail-closed decision log | Recording who/what/when for gated actions | Audit-trail concepts referenced in SOX, PCI-DSS, ISO 27001 logging controls |
| Manifest integrity gate rejecting mislabeled tools | Preventing a config error from silently weakening a control | Secure-configuration-management concepts |
| Fail-closed default for unmanifested tools | Defaulting new/unreviewed capability to "ask first" rather than "allow" | Least-privilege / default-deny concepts referenced in NIST AI RMF and ISO 27001 |
| Metadata-only audit log (no argument values persisted) | Not persisting potentially sensitive call arguments in logs | Data-minimization concepts referenced in GDPR |

If your organization needs a formal control mapping for procurement or audit purposes,
that requires a dedicated assessment against the specific framework in question — this
appendix is a starting point for that conversation, not a substitute for it.
