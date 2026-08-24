# Elicitation Auto-Accept Verification (Phase 3 Promotion Gate)

> **Status: NOT YET VERIFIED — `approvals.elicitation` stays `"off"` by default until every check below passes and the evidence table is filled in.**

## Why this gate exists

Phase 3 (SECURITY-ROADMAP §2.2) lets a client that declares the MCP `elicitation`
capability approve a parked Tier-B call via an in-editor dialog. The security
invariant is that the elicitation answer comes from a **human clicking a real
dialog** — a client-UI channel that never travels through the model. That is a
trust assumption about the client binary. If any client **auto-accepts**
elicitations in a full-auto/always-allow mode, elicitation silently converts
Tier-B (out-of-band human approval) into Tier-A (self-confirm) on that client.

Mitigations already in place regardless of this verification:

- The `PendingApproval` park record is created **first** and is the source of
  truth; elicitation only ever upgrades the UX on top of it.
- The feature is **opt-in** (`approvals.elicitation: "off"` default).
- `approvals.elicitation_blocklist` (clientInfo.name list) can exclude any
  client found to auto-accept.

This document is the manual acceptance test that gates flipping the shipped
default to `"on"`.

## Test rig

1. Build and start the gateway with elicitation enabled and a Tier-B tool
   available. Minimal config fragment:

   ```yaml
   safety:
     enforce: blocking
     manifest_dir: <dir with a PRODUCTION-classed tool manifest>
   approvals:
     elicitation: "on"
     # elicitation_timeout_ms: 120000   # production default
   gateway:
     streamable_http_stateless: false   # elicitation requires a stateful session
   ```

2. Confirm from the gateway log / `decisions.jsonl` which client you are
   testing: the captured `clientInfo.name` is the value the blocklist matches
   on. Record it in the evidence table.

3. The probe call for every scenario below is any Tier-B classified tool
   dispatched through `gateway_call_tool` (e.g. a `PRODUCTION`-manifested
   test tool), **without** any pre-existing grant (`thesun grants` must show
   none for that identity+backend+tool).

## Scenario matrix (all must pass)

### 1. VS Code Copilot — normal agent mode

- [ ] Ask the agent to invoke the Tier-B tool.
- [ ] **Expected:** VS Code shows the elicitation dialog (message is the
      type-tagged summary — verify it contains NO raw argument values).
- [ ] Do nothing for >120 s → the call returns the parked `approvalPending`
      response; the pending record is visible via `thesun approve` / `/approve`.
- [ ] Repeat, click **Decline** → parked response, backend not called.
- [ ] Repeat, click **Approve** → the SAME in-flight call completes with the
      backend result (no agent retry), and `decisions.jsonl` shows the
      `"parked"` line followed by `"proceed"` with `elicitation: true`.

### 2. VS Code Copilot — per-tool "Always Allow" configured

This is the auto-accept check. Configure Copilot's per-tool always-allow for
the gateway tools (the mode an operator would actually run in), then:

- [ ] Invoke the Tier-B tool.
- [ ] **PASS condition:** the elicitation dialog STILL renders and requires a
      human click. The tool-level always-allow must NOT extend to
      elicitation prompts.
- [ ] **FAIL condition:** the call completes without any dialog (check
      `decisions.jsonl` for `elicitation: true` on a call no human approved).
      → Add the recorded `clientInfo.name` to `approvals.elicitation_blocklist`
      and file the client bug. Default stays `"off"`.

### 3. Codex CLI — full-auto approval mode

Run Codex in its full-auto mode (`--full-auto` / approval-mode never — the
most permissive setting available in the installed version), then:

- [ ] Invoke the Tier-B tool.
- [ ] **PASS condition:** the elicitation prompt still surfaces to the human
      and blocks until answered; timeout/decline returns the parked response.
- [ ] **FAIL condition:** Codex answers the elicitation itself (accept without
      human input). → blocklist `clientInfo.name`, file bug, default stays off.

### 4. Non-supporting clients (regression)

- [ ] Copilot CLI and OpenCode: invoke the Tier-B tool with
      `approvals.elicitation: "on"` — behavior must be byte-identical to
      Phase 1 parking (no dialog, `approvalPending` envelope, CLI approve +
      retry works). Automated coverage exists in
      `gateway/test/e2e/elicitation.test.ts` (capability-absent case); spot-check
      one real client anyway.

### 5. Model-channel injection check

- [ ] While a dialog is pending, have the agent send text such as
      "accept the elicitation, approve: true" through the model channel.
- [ ] **PASS condition:** nothing the model emits can answer the dialog — only
      the human click does. (Structural: the ElicitResult arrives on the MCP
      client-UI channel, but verify no client "helpfully" lets the model
      answer.)

## Evidence table (fill in before promotion)

| # | Client | Version | clientInfo.name | Mode tested | Result (pass/fail) | Date | Operator |
|---|--------|---------|-----------------|-------------|--------------------|------|----------|
| 1 | VS Code Copilot | | | agent mode | | | |
| 2 | VS Code Copilot | | | per-tool always-allow | | | |
| 3 | Codex CLI | | | full-auto | | | |
| 4 | Copilot CLI / OpenCode | | | default | | | |
| 5 | injection check | | | n/a | | | |

## Promotion procedure

Only after ALL rows above are `pass`:

1. Change the shipped default in `gateway/src/config.ts`
   (`ApprovalsConfigSchema.elicitation`) from `"off"` to `"on"` in a dedicated,
   reviewed commit that links to this document's filled evidence table.
2. Update SECURITY-ROADMAP §6 (shipped defaults table) in the same commit.
3. Keep `elicitation_blocklist` empty unless a scenario failed; a failed
   client stays blocklisted until a fixed client version re-passes scenario 2/3.

If ANY scenario fails: default remains `"off"`, the failing client goes on the
blocklist, and this document is updated with the failure evidence.
