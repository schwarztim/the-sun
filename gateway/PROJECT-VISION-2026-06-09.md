# MCP Gateway — From Proxy to Trusted Control Plane

**Date:** 2026-06-09 · **Status:** design vision, not a shipped-state description.
**Method:** Full source read (all 12 modules, ~4,100 LOC), fleet config, manifests, test suite, resilience harness — every architectural claim below is grounded in `file:line`.

---

## 0 · The Organizing Idea: Three Planes

A capability control plane for an autonomous agent fleet is three things at once:

| Plane | Job | State today |
|---|---|---|
| **Data plane** | Dispatch, namespacing, search, compression, artifacts, session healing | **Good.** Genuinely well-built. |
| **Control plane** | Identity, policy, classification, enforcement, isolation | **Half-wired.** Designed, not enforced. |
| **Proof plane** | End-to-end evidence that the other two planes do what they claim | **Absent.** 124 green tests, zero touch the wire. |

The 20x leap is not a bigger data plane. It is making the control plane *structural* and the proof plane *exist* — then using the choke point those two create to make the gateway intelligent. Everything below is sequenced around that.

---

## 1 · Honest Assessment

### What it truly is today

A **single-operator MCP multiplexer with excellent context hygiene and advisory safety**. The facade pattern (8 meta-tools, search→describe→call, capped outputs, artifact paging) is the best part of the design — it solves the real problem that 18 backends × ~50 tools cannot live in any agent's context. The stale-session self-healing (`gateway.ts:1448-1495`) is mature, message-gated, dedup-protected, and the one piece of the wire layer with serious unit coverage.

### The trust ceiling, stated precisely

> **[2026-06-10 STATUS NOTE]** Items 1–5 below described the state of master at commit 96d06f6 (the review date). The following gaps were closed by commit a35e307 and the 2026-06-10 hardening pass:
> - ~~Item 1~~ (bypass recipe in deny response): deny responses no longer include `next: { confirmed: true }` or any remediation hint.
> - ~~Item 2~~ (gate covered only the mux path): the gate now fires on both `gateway_call_tool` and direct namespaced calls.
> - ~~Item 3~~ (default posture advisory/namespaced): `enforce` defaults to `"blocking"` in code and both shipped configs; both configs use `tool_exposure: "mux"`.
> - ~~Item 4~~ (stdio has four live doors): stdio is no longer representable in the config schema; all four entry points are closed.
> - ~~Item 5~~ (verb-less fallback silently becomes READ): unmanifested verb-less tools are now `UNCLASSIFIED` and gated, not promoted to READ. The `unmanifested_read_allowlist` per-backend knob provides a controlled burn-down path.
>
> Items 6 (anonymous callers) and 7 (no per-call deadline) remain open as of 2026-06-10. Item 6 is addressed by the Entra JWT auth block (`auth: mode: entra`) — see "Security configuration" in README — but requires opt-in configuration. Item 7 is deferred to Phase 1 (backend cells / bulkheads).

**Today's gateway can be trusted exactly as far as the calling agent is polite and the operator's YAML is current.** Concretely:

1. ~~**The safety gate trusts the attacker.**~~ `decideGate(safety, confirmed, enforce)` (`manifest.ts:76-88`) takes `confirmed` from the *calling model's own arguments*. Worse, the block response teaches the bypass: it returns `next: { tool: "gateway_call_tool", arguments: { confirmed: true, ... } }` (`gateway.ts:840-847`). For a human in a CLI this is a confirmation prompt. For an autonomous agent it is a one-turn speed bump — the agent re-calls with `confirmed:true` because the gateway told it to. **This is not authorization; it is etiquette.** *[CLOSED 2026-06-10: deny responses no longer carry the bypass recipe.]*
2. ~~**The gate covers one of three call surfaces.**~~ It fires only inside `handleMuxTool`'s `callTool` case (`gateway.ts:811-849`). Direct namespaced calls (`callBackendTool`, `gateway.ts:1372`) have zero gate logic. *[CLOSED 2026-06-10: gate fires on both paths.]*
3. ~~**The default posture is off.**~~ `enforce: "advisory"` (`config.ts:110`), `tool_exposure: "namespaced"` (`config.ts:75`). *[CLOSED 2026-06-10: both defaults flipped; both shipped configs explicit.]*
4. ~~**stdio has four live doors.**~~ Static config schema, fleet ingestion, hot-reload, and `/admin/enable/:name`. *[CLOSED 2026-06-10: stdio removed from type system; all four entry points closed.]*
5. ~~**Classification fails open for verb-less destructive tools.**~~ No match → READ. *[CLOSED 2026-06-10: no match → UNCLASSIFIED → gated; `unmanifested_read_allowlist` for burn-down.]*
6. **Callers are anonymous.** No auth of any kind on `/mcp` or `/sse`. Policy-per-agent is impossible because "agent" doesn't exist as a concept. *[PARTIALLY ADDRESSED 2026-06-10: Entra JWT auth available via `auth: mode: entra`; loopback mode remains `mode: none` by default.]*
7. **One slow backend can hang an agent's turn.** `BackendInstance.callTool` (`backend.ts:258-266`) has no deadline — `withTimeout` guards connect only. No concurrency caps, no circuit breaker. *[OPEN — deferred to Phase 1 backend cells.]*

### Load-bearing vs facade

**Load-bearing (amplify, don't touch logic):** facade meta-tool surface and its UX breadcrumbs (`describeWith`/`callWith`); token-set search ranking (`gateway.ts:1176-1272`); stale-session detection + `ensureReconnected` dedup; compression pipeline as pure functions (`gateway.ts:30-173`); manifest schema and the az-teams manifest's granularity (HUMAN_OUTBOUND on sends, READ on lists — exactly right); vault/env reference resolution (`config.ts:146-225`); stateless-HTTP default (smart: gateway restarts don't strand client sessions).

**Facade (looks like assurance, isn't):** the 124-test green suite — every test exercises pure functions or private-map-injected fakes; no test starts the server, opens a socket, or proves the gate fires (`gateway-call-tool.test.ts` tests schema *shapes*); the resilience harness — 500 *simulated in-memory objects*, asserts on a pure config transform (`resilience-harness.ts:111-153`); the `write_guard` manifest field — parsed, surfaced, read by nothing in the call path; the NEVER-stdio YAML comment block (`config.fleet.yaml:47-52`) — sincere, structurally inert; `max_restarts` — defeated by the code that invokes restarts.

### The precise gap

The review's bottleneck holds: **structural enforcement and end-to-end proof of the two invariants.** This document adds the deeper cut: even once wired and proven, the *confirmation model itself* cannot carry an autonomous fleet — `confirmed:true` must become something an agent **cannot self-issue**. That is the difference between a gateway that survives polite agents and one you trust blindly.

---

## 2 · The Target State — What 20x Looks Like

### The agent experience

An agent (orchestrator worker, Claude session, Copilot CLI, opencode) connects to one URL with a bearer token that *is* its identity. Its entire tool universe is ~9 meta-tools. It asks for a **capability**, not a name: `gateway_resolve_capability("create a Jira ticket about the cert expiry")` returns 2-3 candidates with schemas, safety classes, and — critically — *whether this agent may call them and what it would need if not*. Malformed arguments are rejected at the gateway with the schema echoed back (one cheap round-trip instead of a backend 404 cycle). READ results it requested an hour ago come back instantly from a content-hash cache. A 400KB ServiceNow dump arrives as a 6KB summary with a durable artifact reference that survives gateway restarts. When the agent attempts `teams_send_message`, the gateway doesn't ask "are you sure?" — it checks whether this agent holds a live grant for HUMAN_OUTBOUND on az-teams; if not, the call is **denied with a remedy** ("operator approval required; request queued as approval #142"), and the operator gets an S2 whisper. The agent cannot talk itself past the gate, because the gate doesn't take the agent's word for anything.

### The operator experience

One place answers every question about the fleet's tool use. `gateway_trace` (or `/admin/trace`) replays any incident: which agent, which tool, what classification, what decision, what grant, what latency, what the backend returned, what was compressed. Per-backend health is a **cell** with a state machine you can see: closed/half-open/open/quarantined, with budgets. At 3am a backend starts flapping; its breaker opens, its 40 tools vanish from search results with a `degraded` annotation, the rest of the fleet never notices, a background probe restores it at 3:07, and the flight recorder has the whole story. A new backend onboards by dropping a URL in config; the gateway discovers its tools, finds 12 unclassified, **quarantines those 12 from every agent**, and emits a draft manifest for the operator to review — classification is now a *gate to exposure*, not an afterthought. A `command:`-style stdio entry in someone's MCPU config produces a quarantined entry with a remedy string — *the gateway is structurally incapable of speaking stdio because no code path, type, or schema can represent a stdio connection.*

And the operator trusts all of it for one reason: **every sentence in the two paragraphs above is a named end-to-end test that boots the real server.** The suite is the trust.

### The architecture that delivers it

```
            agents (orchestrator / claude / copilot / opencode)
                 │  bearer token = identity
                 ▼
   ┌──────────── /mcp (streamable-http, stateless) ────────────┐
   │  identity middleware → AgentContext                        │
   │                                                            │
   │   meta-tools ─┐                                            │
   │   namespaced ─┼──▶ dispatchToolCall() ──▶ THE GATE (PEP)   │
   │   resources ──┘         │                  policy.yaml +   │
   │                         │                  manifests +     │
   │                         │                  grants ledger   │
   │                         ▼                                  │
   │                 BackendCell[name]                          │
   │                  semaphore · deadline · breaker ·          │
   │                  quarantine · single reconnect path        │
   │                         │                                  │
   │                         ▼                                  │
   │             BackendInstance (http/sse ONLY —               │
   │             stdio unrepresentable in the type system)      │
   │                                                            │
   │   every decision + call ──▶ flight recorder (SQLite)       │
   │   READ results ──▶ content-hash cache                      │
   │   oversized output ──▶ artifact store (SQLite, TTL)        │
   └────────────────────────────────────────────────────────────┘
              proof plane: e2e harness boots THIS server,
              fake http backends, ~14 named invariant tests,
              chaos suite incl. "the az-teams test" — CI-gated
```

---

## 3 · The Step-Changes (highest leverage per unit effort)

### S1 — The Gate: one Policy Enforcement Point on the only door
**What changes:** All three call surfaces (mux `gateway_call_tool`, direct namespaced, resources/prompts) already converge structurally — `CallToolRequestSchema` has exactly one handler (`gateway.ts:252-261`). Introduce `dispatchToolCall(ctx: CallContext): Decision` and make `callBackendTool` unreachable except through it. The gate evaluates *(agent, tool, classification, grant)* and returns allow-with-obligations (record, redact, cap) or deny-with-remedy. `UNCLASSIFIED` becomes a first-class gated outcome — the regex fallback stops being able to silently bless a destructive tool as READ.
**Why a step-change:** Safety stops being a property of *which path the agent happened to take* and becomes a property of *the dispatch function existing*. Every later capability (identity, grants, recorder, cache, quotas) lands at this single point. This is the literal embodiment of the operator's Structural Determinism Mandate.
**Builds on:** `decideGate()` is already a tested pure function; the convergent handler already exists. This is a wiring move, not a rewrite — the review's C3/H1/H2 dissolve as side effects.

### S2 — The Transport Constitution: stdio unrepresentable, not unfashionable
**What changes:** Remove `StdioBackendSchema` from the config union; remove the `StdioClientTransport` import and `connectStdio()` from `backend.ts`; in fleet ingestion, `command:`-only entries map to a **quarantined entry** (`{ status: "quarantined", reason: "stdio-unsupported", remedy: "re-front behind streamable-http" }`) — visible in `gateway_backend_status`, never connected; `BackendInstance` constructor throws `TransportViolation` on any non-http/sse transport as defense-in-depth against future config paths. Boot proceeds (a quarantined entry must not crash the fleet's front door — fail-closed for the entry, fail-open for the gateway).
**Why a step-change:** Closes the documented 2026-05-28 outage class *permanently and by construction* across all four current doors (static config, ingestion, hot-reload, admin enable) and all future ones. "Grep the config for stdio before restarting" stops being an operator ritual.
**Builds on:** The discriminated union in `config.ts` makes this a deletion, not a redesign. The fleet ingestion `skipped[]` array is already the right shape for quarantine reporting.

### S3 — The Proof Harness: the trust mechanism, not a test suite
**What changes:** A `test/e2e/` fixture that boots the **real** gateway (`gateway.start()`, ephemeral port) against **real in-process HTTP MCP backends** (the SDK's server classes — ~60 lines each: echo, slow, dying, vault-shaped), drives a **real MCP client** through the wire, and proves the invariants by name:
`boots-and-serves` · `roundtrip-mux-path` · `roundtrip-direct-path` · `write-without-grant-blocks-on-BOTH-paths` · `unclassified-tool-is-gated` · `stdio-config-quarantined-at-boot` · `stdio-mcpu-ingestion-quarantined` · `vault-class-never-inlines` · `backend-hang-cannot-stall-sibling-call` · `backend-death-opens-breaker-then-heals` · `stale-session-reconnects-exactly-once` · `truncation-artifact-roundtrips-lossless` · `two-clients-no-crosstalk` · `unauthenticated-caller-rejected`.
Plus the chaos suite, headlined by **"the az-teams test"**: inject a stdio entry into a fake MCPU config, assert gateway stays healthy, entry quarantined, alert event emitted, zero crash-loop — the 2026-05-28 outage, encoded as a regression test forever. CI refuses green without this file passing.
**Why a step-change:** This is the single thing that converts "well-designed" into "trusted blindly." After S3, a safety regression *cannot ship green* — the review's entire "UNPROVEN" column retires, and every future feature lands with its invariant test or doesn't land.
**Builds on:** `streamable_http_stateless` makes the harness trivial (no session choreography); the SDK ships both client and server; `TestableGateway` patterns get retired, not extended.

### S4 — Backend Cells: zero-trust bulkheads around every backend
**What changes:** Wrap each `BackendInstance` in a cell: per-call **deadline** (default 30s — today there is none), **concurrency semaphore** (default 4), **circuit breaker** (5 failures/30s → open; half-open probe; trips also on deadline exhaustion), **quarantine** state (manual, stdio, or flap-detection), and **one reconnect path** — health monitor, stale-retry, admin, and meta-tool all route through `ensureReconnected()` (which already exists and dedups; today the health monitor bypasses it, ignores `restart_policy`, and resets the restart counter — `gateway.ts:2000`, `backend.ts:322`). Open/quarantined cells annotate or drop their tools from search results so agents stop wasting turns on dead backends.
**Why a step-change:** "Never the cause of a fleet outage" becomes an enforced resource property: no backend can consume more than its cell's budget, hang more than its deadline, or thrash more than its breaker allows. The review's H4/H5/M1 dissolve as side effects of having one path.
**Builds on:** Reconnect dedup, `connectionGeneration`, restart policies, and per-backend status — all present, currently fighting each other instead of composing.

### S5 — Identity & Grants: authorization an agent cannot self-issue

> **[2026-06-10 STATUS NOTE]** The static bearer-token identity model described below is **superseded as the end-state** by Entra ID JWT validation, per the architecture decision (PART III §2) adopted 2026-06-10. The gateway now supports `auth: mode: entra` with Bearer JWT validation on `/mcp`, `/sse`, and `/messages` (JWKS-verified signature, iss/aud/exp, identity flowing into the decision log, session binding).
>
> The **grant/lease design** — single-use, short-TTL confirmation tokens bound to `hash(identity, tool, args)` — is **retained** for the G3 phase, re-bound to Entra principals rather than static tokens. Static bearer tokens survive only as a possible loopback/single-operator mode (`auth: mode: none`). The `policy.yaml` and per-agent grant model below remains the target for Phase 2 (G3), with Entra principals as the identity source.

**What changes:** Bearer-token middleware on `/mcp`/`/sse`; tokens map to agent identities (`orchestrator`, `claude-main`, `copilot`, `opencode`) via vault-referenced config. A declarative `policy.yaml` replaces the self-attested `confirmed` flag as the source of authority:
```yaml
agents:
  orchestrator:       { token_ref: "vault:mcp/gateway#orchestrator_token" }
  claude-main: { token_ref: "vault:mcp/gateway#claude_token" }
grants:
  - { agent: orchestrator,  allow: { backend: atlassian, class: [READ, WRITE] } }   # Jira CRUD, standing
  - { agent: "*",    allow: { class: [READ] } }
defaults:           # absent grant ⇒ these floors apply
  WRITE: needs_grant
  SIDE_EFFECT: needs_grant
  HUMAN_OUTBOUND: operator_approval      # S2 whisper / admin CLI approve; short-lived lease on approval
  PRODUCTION: operator_approval
  VAULT_VALUE: deny                      # never inline to any agent — mirrors ISAAC "no vault_get by design"
  UNCLASSIFIED: deny
```
Approvals issue **short-lived leases** (scope: agent × backend × class × TTL), recorded in the flight recorder. `confirmed:true` survives only as a UX nicety *on top of* a valid grant, never instead of one. Per-agent rate limits and `gateway_reconnect_backend` cooldowns hang off the same identity.
**Why a step-change:** This is the move that makes *autonomous* write access sane. Today the gate asks the agent's permission to stop it. After S5, write powers are scoped, revocable, audited, and expire — the operator pre-authorizes the orchestrator's Jira writes once, while Teams messages still require a per-occasion human yes. The fleet can be *given* power instead of *trusted not to use* it.
**Builds on:** The six-class taxonomy (already the right vocabulary), the manifests, vault references in config, the stateless-HTTP design (identity per request via header — no session state needed), and the operator's existing whisper severity model (S2 = response required) as the approval channel.

### S6 — Capability Intelligence & Context Economy: the gateway gets smarter
**What changes:** (a) `gateway_resolve_capability`: hybrid retrieval over tool metadata — the existing token-set ranking plus a local embedding index (manifests' tags/descriptions; no cloud dependency) — returning candidates *with the caller's authorization status attached*. (b) **Schema validation pre-dispatch**: validate args against the tool's `inputSchema` at the gate; reject with the schema echoed (the Confluence-404 flat-args footgun documented at `mux-tools.ts:24-29` becomes a structured one-turn error instead of a silent empty-args backend call). (c) **READ cache**: content-hash keyed (backend, tool, args), short TTL, per-backend opt-in — fleet agents repeat identical reads constantly. (d) **Durable artifacts**: SQLite, content-addressed, TTL'd (today: in-memory, 100-entry FIFO, dead on restart — `gateway.ts:183,1094`); fix M3 so paging always references the lossless original. (e) Compression on by default once `pruneEmpty` stops eating semantically meaningful `null`s (M2) — prune only `undefined`, keep the columnar win. (f) Outcome feedback: the flight recorder's success/failure per (query → tool chosen) tunes ranking over time.
**Why a step-change:** This is where the order-of-magnitude *capability* gain lives: agents stop spending context on tool plumbing and wrong-tool retries. But it is deliberately **last** — every one of these features is only trustworthy because it sits behind the gate (S1), inside cells (S4), under identity (S5), proven by the harness (S3).
**Builds on:** Search/describe/call breadcrumb UX, the artifact store, the compression pipeline, manifest tags — all existing assets, amplified.

*(Threaded through S1/S4/S5, not a separate phase: the **flight recorder** — one SQLite append per decision/call at the gate. It costs ~20 lines once the PEP exists and feeds the trace tool, SLOs, ranking feedback, and approvals audit.)*

---

## 4 · Roadmap — dependency-ordered, each phase names its unlock

### Phase 0 — "The invariants become real" *(days; do first, do now)*
Merge `fix/never-stdio-copilot-studio` → master. S2 transport constitution (schema deletion, ingestion quarantine, constructor assert). S1 gate-on-every-path with `enforce: blocking` default and `UNCLASSIFIED → gated` (boot prints a per-backend unclassified-tool report so manifests can be filled within days). First e2e file: `boots-and-serves`, both roundtrips, `write-blocks-on-both-paths`, `stdio-quarantined`. De-bloat git (`git rm -r --cached node_modules dist`). JSONL decision log at the gate (recorder seed).
**Unlock:** *A safety regression can no longer ship green; the documented outage class is closed by construction.* Trust floor established.
**Acceptance:** clean clone + `npm run start:fleet` boots with the stdio entry quarantined and visible; e2e suite red if anyone re-adds a stdio schema member or removes the gate from either path.

### Phase 1 — "No backend can hurt the fleet" *(~1 week)*
S4 cells: deadlines, semaphores, breakers, quarantine; unify all four reconnect/restart paths through `ensureReconnected`; fix H4/H5/M1 as side effects. Chaos tests join the harness: hang, death, flood, malformed SSE, **the az-teams test**. Recorder moves JSONL → SQLite; `gateway_backend_status` grows cell state.
**Unlock:** *Zero-trust toward backends — one bad backend degrades only itself, observably.*
**Acceptance:** `backend-hang-cannot-stall-sibling-call` and `backend-death-opens-breaker-then-heals` pass on the real wire; kill -9 of a fake backend mid-call leaves every other cell serving.

### Phase 2 — "Authorization, not confirmation" *(~1-2 weeks)*
S5: bearer identity middleware, `policy.yaml`, grants/leases, default-deny floors (HUMAN_OUTBOUND/PRODUCTION = operator approval; VAULT_VALUE = deny), approval flow (admin CLI first; whisper S2 integration after), `gateway_trace` meta-tool over the recorder, per-agent rate limits + reconnect cooldown.
**Unlock:** *The fleet can hold standing write powers safely — scoped, revocable, expiring, audited per agent.*
**Acceptance:** e2e proves an agent without a grant is denied-with-remedy on both paths while a granted agent proceeds; revoking a lease takes effect on the next call; every write in the recorder names its agent and grant.

### Phase 3 — "The gateway gets smart" *(~2 weeks)*
S6: capability resolution (hybrid lexical+embedding), pre-dispatch schema validation, READ cache, SQLite artifacts with TTL + lossless-original paging (M3), compression default-on with `null`-safe pruning (M2), ranking feedback from recorder outcomes.
**Unlock:** *Agents spend tokens on work, not plumbing — fewer wrong-tool calls, instant repeat reads, durable artifacts.*
**Acceptance:** capability query → correct tool in top-3 across a golden set; malformed args rejected in one round-trip with schema; cache hit serves without a backend call (proven on the wire); artifact paging survives a gateway restart.

### Phase 4 — "Operate it like a product" *(ongoing)*
Manifest-coverage CI gate (no backend exposed with unclassified tools; LLM-drafted manifest PRs for new backends, operator approves). Per-backend SLOs from recorder data. Config canary (validate-then-swap on hot reload). Docker hardening (non-root, HEALTHCHECK). A status dashboard — *now* justified, because events exist. Close the 9 stale Dependabot PRs.
**Unlock:** *Onboarding a new backend is a config line plus an approved manifest — safe by default, observed from minute one.*

---

## 5 · Enforcement & Safety Architecture (non-negotiable design)

### The Gate (single PEP)

```ts
// src/policy/gate.ts
export interface CallContext {
  agent: AgentIdentity;                  // from bearer token; "anonymous" allowed only if policy says so
  path: "mux" | "direct" | "resource" | "prompt";
  backend: string; tool: string; originalName: string;
  args: Record<string, unknown>;
  safety: SafetyClassification | { safetyClass: "UNCLASSIFIED" };
  grant?: Grant;                         // resolved from the lease ledger
}
export type Decision =
  | { allow: true;  obligations: Obligation[] }          // record · redact-vault · cap-output · cache-eligible
  | { allow: false; code: "needs_grant" | "needs_approval" | "denied_class"
                        | "unclassified" | "unknown_tool" | "rate_limited";
      remedy: string };                                   // machine-actionable, never "set confirmed:true"
```

Rules: `callBackendTool` is private to the dispatch module — **no caller can reach a backend without producing a `Decision`**. Resources/prompts construct a `CallContext` with `path: "resource"`; cross-backend URI probing is replaced by namespace-resolved routing. Deny responses never include self-satisfiable bypass instructions. Every `Decision` is appended to the recorder *before* dispatch (fail-closed: recorder write failure blocks the call — mirrors ISAAC's enforcement-determinism rule).

### The Transport Constitution

`z.discriminatedUnion("transport", [SseBackendSchema, HttpBackendSchema])` — stdio is not a member; a config containing it fails schema parse with a remedy message and the entry is quarantined rather than crashing boot. `backend.ts` no longer imports `StdioClientTransport` — the capability to speak stdio is deleted, not disabled. Ingestion maps `command:` entries to quarantine records surfaced in `gateway_backend_status` and `/admin/backends`. The e2e suite holds two tests on this forever (config path + ingestion path). Re-introducing stdio would require touching schema, backend, ingestion, *and* two named tests — that is what "by construction" means.

### Backend Cells

Per-backend state machine: `closed → open (5 failures or deadline-exhaustions / 30s) → half-open (probe @60s) → closed`, plus `quarantined` (stdio / manual / flap ≥3 open-events per hour). All entry points to reconnection — health monitor, stale-retry, `/admin/reload`, `gateway_reconnect_backend` — funnel through `ensureReconnected()`; `restart()` stops resetting `_restartCount`; `restart_policy: never` is honored everywhere. Cell budgets (deadline 30s, concurrency 4, breaker thresholds) are config with safe defaults, reported in `gateway_backend_status`.

### The Proof Plane

The e2e harness is a **first-class module** (`test/e2e/harness.ts`): `bootGateway(configOverrides)` + `fakeBackend(behavior: "echo" | "slow" | "dying" | "vault" | "flaky")` + a real SDK client. The 14 named invariant tests above are the *definition of trustworthy*; CI (GitHub + Stash) gates merge on them. Policy gets its own table-driven unit layer — `(agent, tool, class, grant) → expected Decision` — so policy changes are reviewed as test diffs. The unit pyramid inverts deliberately: for a gateway, **the wire is the product**, so wire tests are the primary suite and pure-logic tests are the fast inner loop.

### Defense-in-depth position

This gateway becomes the *tool-boundary* enforcement tier of the operator's existing governance stack: ISAAC hooks govern agent behavior at the client; the gateway governs capability at the boundary; the vault governs secrets beneath both. Agent tokens live as vault references; approval requests ride the whisper severity model (S2); the flight recorder follows the isaac.db pattern (SQLite as derived, queryable operational truth). Two independent layers must now fail for an unsafe call to land.

---

## 6 · Quickest Compounding Wins (start now — each is foundation, not triage)

1. **Merge `fix/never-stdio-copilot-studio` + delete stdio from the type system** (S2 seed). ~Hours. Closes C1/C2 permanently, not advisorily.
2. **Move the gate into the dispatch path** so direct calls hit `decideGate` too, and **flip the default to `blocking`** (S1 seed). ~Hours. C3/H1 die; the YAML safety model becomes code.
3. **Write `test/e2e/invariants.test.ts` with the first four tests** (boot, both roundtrips, write-blocks, stdio-quarantine) (S3 seed). ~Half a day. The trust mechanism exists from this commit forward.
4. **Stop teaching the bypass**: remove the `confirmed:true` recipe from deny responses; return a remedy string pointing at grants/approval instead (S5 seed). ~Minutes. Symbolic and real.
5. **`git rm -r --cached node_modules dist`** + real `.gitignore`. ~Minutes. Restores meaningful diffs for everything above.
6. **Ten-line JSONL decision log at the gate** (flight-recorder seed). Every later intelligence feature feeds on this data; start accumulating it now.

---

## 7 · Where I'd Bet Differently Than the Current Design

1. **`confirmed:true` as the safety primitive — wrong for the stated mission.** It models a human at a CLI, not an autonomous fleet; the deny response even includes the bypass recipe (`gateway.ts:840-847`). Replace with grants (S5). Keep `confirmed` only as a belt-and-suspenders UX layer on top of a valid grant.
2. **Advisory-by-default — a safety gateway that defaults to logging is a demo.** Default `blocking`; make advisory an explicit, loudly-logged opt-out (`config.ts:110`).
3. **Name-pattern fallback fails open.** "No write verb → READ" (`manifest.ts:182-191`) silently blesses `purge`/`execute`/`revoke`-style tools. Unmanifested non-READ-obvious tools should be `UNCLASSIFIED → gated`, with manifest coverage as a CI gate. Classification becomes a *precondition of exposure*, not a heuristic.
4. **`tool_exposure: "namespaced"` as the schema default** exposes everything with no facade and (today) no gate. After S1 the gate covers it anyway, but the default should be `mux` — the facade is the product's best idea; lead with it.
5. **In-memory artifacts/recorder.** An agent told "fetch artifact X for the rest of this data" must not lose X to a restart or a 100-entry FIFO (`gateway.ts:183`). SQLite for both; content-addressing makes caching fall out for free.
6. **The health monitor as an independent restart actor.** A second writer to connection state is how M1's double-bump wedge happens. One reconnect path, policy-aware (S4).
7. **What I would *not* change:** Express + SDK transports (boring is correct here); the 8-meta-tool facade (resist tool sprawl — `resolve_capability` and `trace` earn slots 9-10, nothing else does); single-process single-host (no clustering/HA — KISS; fast boot + stateless sessions + durable artifacts make restarts non-events); no external policy engine (OPA et al. — `policy.yaml` + TypeScript + table-driven tests is proportionate for a single-operator fleet).

### What NOT to build yet
No new backends or compression modes during Phases 0-1 (the review is right: breadth is not the bottleneck). No dashboard before the recorder exists (Phase 4, not Phase 1). No async approval *queue* — synchronous deny-with-remedy plus out-of-band lease issuance is enough until proven otherwise. ~~No multi-gateway federation until a second host actually needs it.~~ *[ANNOTATED 2026-06-10: a second host now exists by mandate (two-FQDN decision). Gateway-to-gateway federation remains banned. Multiple policy-scoped **instances** of the single gateway artifact are in scope — each host runs its own instance; federation between gateway instances is not the model.]*

---

## 8 · Grounding Coverage

Read in full for this document: `gateway.ts` (all 2,022 lines), `config.ts`, `backend.ts`, `manifest.ts`, `mux-tools.ts`, `tool-registry.ts`, `fleet-backend-ingestion.ts`, `resilience-harness.ts`, `config.fleet.yaml`, `manifests/az-teams.json`, `gateway-call-tool.test.ts`, plus the full project review. Skimmed (no recommendation depends on their internals): `fleet-inventory.ts`, `fleet-mcpu-config.ts`, remaining manifests/tests. If Phase 2's approval-channel design proceeds, the one external module worth handing over is the whisper/federation sender contract from the ISAAC repo (`tools.py` whisper interface) to bind `operator_approval` to S2 whispers correctly.

---

**The one-sentence version:** Keep the data plane, build the control plane into the only door, prove both on the real wire, and only then make it intelligent — at which point the gateway stops being a proxy the fleet *uses* and becomes the nervous system the fleet *trusts*.
