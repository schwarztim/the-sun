# The Fleet Control Plane — mcp-gateway at 20x

**Date:** 2026-06-09 · **Status:** design vision, not a shipped-state description.
**Grounding:** full read of `config.ts`, `manifest.ts`, `mux-tools.ts`, `tool-registry.ts`, `backend.ts`, the dispatch/session/reload/health regions of `gateway.ts` (2,022 lines), plus verification inside the installed MCP SDK (request-timeout default, `authInfo` propagation slot).

---

## 0 · Thesis

mcp-gateway sits at the **narrow waist** of the operator's entire agent architecture: it is the only point in the fleet where *who is calling* (identity), *what they intend* (tool + args), *what the contract allows* (manifest), and *what actually happened* (outcome) are all visible in one place. Nothing else — not the agents, not the backends, not the harnesses — ever sees all four. That is why enforcement, intelligence, and evidence belong here and nowhere else, and why every unit of trust built into the gateway multiplies across every agent and every tool downstream.

Today the gateway is a well-built **convenience aggregator**. The 20x target is a **self-enforcing, self-proving capability fabric**: a control plane an autonomous fleet can trust blindly because it structurally cannot be made to do the wrong thing — and continuously proves it.

The distance between the two is not features. It is three properties the current system lacks:

1. **Singularity of enforcement** — one gated path, not N paths that each remember to gate.
2. **Identity** — the gateway cannot currently distinguish the orchestrator from a stray `curl`.
3. **Proof** — a green 124-test suite that never starts the server is confidence, not evidence.

---

## 1 · Honest Assessment

### 1.1 The trust ceiling, stated precisely

Today you may trust the gateway to: aggregate and namespace tools for **cooperative** local clients; recover stale backend sessions elegantly; rank/search a small tool corpus; classify tools correctly **when asked via `gateway_call_tool` in blocking mode**; keep secrets out of config via Vault refs.

You may **not** trust it to: refuse its own worst transport (stdio is a first-class schema member, fully implemented, ingestible from MCPU config, and *enabled on master*); gate a write on the default path (`tool_exposure` defaults to `namespaced` — the ungated path — and `enforce` defaults to `advisory`); distinguish or limit any caller (no identity, no rate limits, no budgets); contain a misbehaving backend (no breaker, no per-call timeout policy beyond the SDK's blanket 60s, health monitor that overrides `restart_policy: never` and resets `max_restarts`); resist a malicious backend (tool descriptions flow verbatim from backend to agent context — the classic MCP tool-poisoning vector); preserve payload fidelity under compression (`pruneEmpty` deletes meaningful `null`/`""`/`[]`; the truncation artifact stores the pruned text, not the original); or **prove any of the above** (zero end-to-end tests; the wire has never been exercised by automation).

### 1.2 Load-bearing vs. facade

| Genuinely load-bearing (amplify) | Facade today (make real) |
|---|---|
| Manifest safety model + `decideGate()` — clean, pure, well-tested | `write_guard` field — parsed, displayed, read by no enforcement code |
| Stale-session detection (message-gated `-32000`) + dedup `ensureReconnected()` | "Never stdio" — a YAML comment; schema, connector, and fleet ingestion all accept it |
| Per-connection `McpServer` isolation (the multi-session fix is real) | The safety gate — real code, but wired on 1 of 2 call paths and advisory by default |
| 8-meta-tool facade + capped outputs + artifact refs (context economy v1) | The 124-test suite as "verification" — pure logic via private-map injection; never boots the server |
| Vault refs, env resolution, hot reload skeleton | `confirmed: true` — the agent confirming itself; no provenance |
| Fleet inventory/ingestion plumbing | `/admin` loopback trust + nothing at all on `/mcp` — "authentication" |

### 1.3 The gap in one sentence

The gateway has the **shape** of a control plane and the **defaults, enforcement topology, identity model, and proof apparatus** of a dev tool — and the four open defaults (`advisory`, `namespaced`, `0.0.0.0`, stdio-representable) mean the most dangerous legal configuration is the default one.

---

## 2 · Design Tenets for the Target State

1. **One path.** Every tool invocation — mux, namespaced, future transports — traverses one dispatch spine. There is no second door to forget to lock.
2. **Illegal states are unrepresentable.** Danger that can be deleted from the type system is deleted (stdio). What can't be deleted is rejected at parse time, not call time.
3. **Default-deny posture.** Out of the box: blocking, mux-only exposure, loopback bind, authenticated callers. Opt *into* risk, never out of safety.
4. **Zero-trust both directions.** Clients are authenticated and budgeted; backends are contract-pinned, bulkheaded, and quarantined on drift. Neither side can harm the fleet.
5. **Proof or it didn't happen.** Every invariant has an end-to-end test that boots the real server; production re-proves the invariants on a timer. "Trust me" is replaced by `invariants_proven_at`.
6. **The gateway is the fleet's memory of what happened.** One evidence event per dispatch, queryable through the same front door.
7. **Smarter, not louder.** Agents ask for capabilities and budgets; the gateway resolves, validates, caches, and compresses — losslessly, always.

---

## 3 · The Target State, Concretely

### 3.1 An agent's hour at 20x

The orchestrator connects to `/mcp` with its bearer token; every call it makes is attributed. It does not grep tool names — it calls `gateway_resolve_capability("file a P2 incident for the checkout latency regression")` and gets back two candidates with schemas, safety classes, success rates, and an example invocation. It dry-runs the winner (`dry_run: true`) and learns it would block: `PRODUCTION` class, its identity requires an operator confirmation token, here is the request handle. The operator approves via one whisper; it re-calls with the token; the gateway validates its args against the *pinned* schema before the backend ever sees them, forwards, and returns a compact result with a lossless artifact ID. Its next forty status polls cost ~2ms each — manifest-declared 30s READ cache. When ServiceNow's container is mid-upgrade, it gets `backend_unavailable, retry_after: 20s` in 5ms — the breaker is open — instead of a 60-second hang. Its retried Teams message sends **once**: idempotency key.

### 3.2 The operator's view

`/admin/status` reads: `invariants_proven_at: 11m ago (canary) · 0 contract drifts · 2 breakers half-open · spend: orchestrator 412 calls / $0.84 today`. "What did orchestrator write today?" is one `gateway_tail_events` call. A backend starts crash-looping at 3am: its breaker opens, its restart budget exhausts into `quarantined`, one CRITICAL evidence event fires — and the other 17 backends never notice. A rogue experiment agent loops: its per-identity budget throttles *it*, nobody else. True emergency: `POST /admin/lockdown` — every gated class denies fleet-wide, instantly. The gateway has not caused an outage since the spine landed, and the operator can prove it, because the gateway proves it to itself every fifteen minutes.

### 3.3 Architecture: four planes around one spine

```
            CLIENTS (orchestrator · Claude Code · Copilot · opencode · CI)
                          │  bearer token per identity
   ╔══════════════════════▼══════════════════════════════════════╗
   ║ FRONT DOOR   authn middleware → req.auth → SDK authInfo      ║
   ╟───────────────────────────────────────────────────────────────╢
   ║ THE DISPATCH SPINE — the only road to a backend               ║
   ║  1 Authenticate │ 2 Resolve+Validate │ 3 Policy │ 4 Gate      ║
   ║  5 Bulkhead     │ 6 Execute          │ 7 Shape  │ 8 Evidence  ║
   ╟──────────────┬───────────────┬───────────────┬───────────────╢
   ║ POLICY PLANE │ FLEET PLANE   │ EVIDENCE PLANE│ ECONOMY PLANE  ║
   ║ manifests as │ breakers,     │ NDJSON audit, │ READ cache,    ║
   ║ pinned       │ budgets,      │ /metrics,     │ coalescing,    ║
   ║ contracts;   │ quarantine,   │ tail_events,  │ artifact store ║
   ║ identity     │ single        │ canary        │ v2 (lossless,  ║
   ║ scopes;      │ reconnect     │ self-proof    │ TTL, spill)    ║
   ║ confirmation │ authority     │               │                ║
   ║ provenance   │               │               │                ║
   ╚══════════════╧═══════════════╧═══════════════╧═══════════════╝
            BACKENDS (streamable-http / sse ONLY — stdio is not a type)
```

---

## 4 · The Seven Step-Changes

Ordered by leverage. Each names what it changes, why it is a step-change rather than a patch, and what existing asset it amplifies.

### SC-1 · The Dispatch Spine — one gated road
**What:** Extract a `dispatch(call: {identity, tool, args, confirmation, options})` pipeline (new `src/dispatch.ts`) with the eight stages above. `handleMuxTool`'s call branch and the `CallToolRequestSchema` handler's namespaced branch (`gateway.ts:258-259`) become 3-line adapters into it. `BackendInstance.callTool` is invoked from exactly one site.
**Why a step-change:** The review's per-finding fix ("also add the gate to `callBackendTool`") leaves two paths that must agree forever — and every future entry point (resources? a websocket transport? an admin test-call route?) re-opens the hole. Singularity converts "did we remember to gate this path?" from an eternal review question into a structural impossibility. It also gives every later capability (identity, budgets, breakers, evidence, caching, dry-run) **one** insertion point — the spine is what makes the rest of this document cheap.
**Builds on:** `decideGate()`, `ToolRegistry.resolve()`, `extractCallToolArgs()`, the existing stale-retry block — all of it moves intact into stages 3–6.

### SC-2 · Config that cannot express danger
**What:** Delete `StdioBackendSchema` from the union (`config.ts:6-24,63-67`) — `transport: stdio` becomes a parse error with a pointed message ("stdio deadlocks under gateway management; re-front behind streamable-http"). Fleet ingestion (`fleet-backend-ingestion.ts:115-119,190-213`) skips `command:`-style entries into `result.skipped` with the same error. Flip four defaults: `enforce: "blocking"`, `tool_exposure: "mux"`, `host: "127.0.0.1"`, and add `auth.required: true`. Add post-parse cross-validation: namespace collisions fatal; manifest `backend:` keys that match no configured backend fatal in strict mode; `enabled` stdio anywhere fatal (belt over the deleted-schema braces).
**Why a step-change:** This is the operator's Structural Determinism Mandate applied literally — the rule stops living in a YAML comment and starts living in the type system, where compaction, model drift, and 3am edits cannot erase it. Flipping defaults inverts the failure mode of every future deployment: forgetting configuration now yields the *safest* gateway, not the most exposed one.
**Builds on:** Zod schemas already in place; the working-tree `enabled: false` fix and `fix/never-stdio-copilot-studio` branch become permanent instead of disciplinary.

### SC-3 · The Invariant Harness — proof as the trust mechanism
**What:** A stub MCP backend (`test/stub-backend.ts`, ~150 lines: streamable-http server exposing `read_echo`, `write_echo`, `slow_tool(ms)`, `crash_now`, `huge_output(chars)`, `drop_session`) plus `test/invariants/*.e2e.test.ts` that **boots the real gateway** on an ephemeral port and proves, over the wire: round-trip works; WRITE-unconfirmed blocks identically on mux *and* namespaced paths; stdio config fails startup with the exact error; tokenless calls get 401; two concurrent clients don't bleed state; `drop_session` triggers recovery and a successful retry (and a failed retry surfaces `retryErr`, not the stale error); a crashed backend leaves its neighbors' calls green. CI gates merges on `npm run test:invariants`. Then point the same stub at production: the gateway mounts it as a hidden `_canary` backend and **re-proves the gate and round-trip every 15 minutes**, publishing `invariants_proven_at` in `/admin/status` and the evidence stream; failure fires a CRITICAL event and (configurable) auto-lockdown.
**Why a step-change:** It converts the test suite from coverage into a **trust instrument** — a safety regression becomes un-shippable (CI) and un-survivable in silence (canary). "The fleet trusts it blindly" is only rational when the gateway is the most-audited component in the system, continuously, by itself. No other single artifact buys more trust per line.
**Builds on:** vitest, the resilience harness's spirit (`resilience-harness.ts`), `test-client.mjs`'s manual probes — promoted from folklore to law.

### SC-4 · Identity at the front door + graduated confirmation provenance
**What:** Express middleware on `/mcp`, `/sse`, `/messages` validates `Authorization: Bearer <token>` against a `clients:` config block (`token: vault:secret/mcp-gateway/clients#orchestrator`), sets `req.auth = {clientId, scopes}` — which the installed SDK already forwards as `authInfo` into handler context (verified: `streamableHttp.js:61,131`). Identity flows down the spine: policy scoping (`orchestrator: allow [READ, WRITE, HUMAN_OUTBOUND]; experiment-*: allow [READ]; deny_backends: [venafi]`), per-identity rate/concurrency/budget limits, and evidence attribution. Then fix the deepest conceptual hole in the current gate: `confirmed: true` is **the agent confirming itself**. Replace with graduated provenance per class × identity: WRITE → self-confirmation suffices (today's semantics); HUMAN_OUTBOUND / PRODUCTION / VAULT_VALUE → require an **operator-issued confirmation token** (single-use, short-TTL, bound to hash(identity, tool, args), minted via admin endpoint or whisper) or a standing per-identity grant. `confirmation_maps_to_downstream` keeps working unchanged.
**Why a step-change:** Without identity there is no policy, no budget, no audit, no autonomy story — "any local process holds the fleet's full capability" is a confused-deputy machine, and for *autonomous* operation, self-confirmation is theater. Provenance is what makes `blocking` mode mean something when no human is in the loop. This is the single largest unlock for letting agents run unattended.
**Builds on:** Vault ref resolution (tokens never touch disk in plaintext); the verified `req.auth → authInfo` SDK slot; the existing gate becomes stage 4 with a provenance check.

### SC-5 · Contract pinning — manifests become the served contract (the immune system)
**What:** Today `ToolRegistry.registerBackend` serves backend-supplied descriptions verbatim to agents (`tool-registry.ts:54`) — the canonical MCP tool-poisoning / rug-pull vector: a compromised backend swaps a benign description for one carrying injected instructions, *after* review. Invert ownership: `npm run audit:contracts -- --pin` snapshots `description_sha256` + `schema_sha256` per tool into the manifest at review time. At registration, diff live vs. pinned: match → serve the **pinned** description (agents only ever see reviewed text); drift → strict mode quarantines the tool (`contract_drift`, calls denied, CRITICAL event), advisory warns. Unmanifested *new* tools on a manifested backend surface as `unreviewed` (listed but deny-by-default in blocking). Stage 2 of the spine additionally compiles the pinned `inputSchema` (ajv — one new dep, justified: contract enforcement requires a JSON-Schema validator; Zod can't consume arbitrary JSON Schema) and validates args *at the gateway*, rejecting malformed calls without a backend round-trip.
**Why a step-change:** It flips the trust model from "the gateway trusts whatever the backend says it is" to "the backend may only be what the operator reviewed" — zero-trust toward backends, mechanically. The manifest stops being annotation and becomes the **contract of record**; the review's "decorative write_guard" critique is answered by making the whole manifest load-bearing. Also kills the silent-misclassification bug class (manifest/backend name mismatch → fail loud, not fall back quietly).
**Builds on:** The manifest registry, `audit-contracts.ts` (gains `--pin` and `--live`), the seven existing manifests — instantly upgraded from documentation to enforcement.

### SC-6 · Bulkheads — no shared fate, in either direction
**What:** Per-backend: circuit breaker (CLOSED→OPEN on failure-rate window, instant `backend_unavailable + retry_after` while OPEN, HALF_OPEN probe); in-flight semaphore (default 8); per-call timeout from manifest/config (default 30s, overriding the SDK's invisible blanket 60s — `protocol.js:704` — via `callTool` options); restart budget with exponential backoff + jitter that **honors** `restart_policy` (today `restart()` resets `_restartCount=0` at `backend.ts:322` and the health monitor ignores policy entirely at `gateway.ts:1994-2001` — the cap is fiction); terminal state `quarantined` requiring explicit operator revival; **all** reconnect triggers (health monitor, stale-retry, mux tool, admin) funneled through `ensureReconnected()` — one authority, with per-backend cooldown so `gateway_reconnect_backend` can't be flood-abused. Per-identity: token-bucket rate limits, concurrency caps, daily call/byte budgets with policy actions (throttle → deny → alert). Plus `POST /admin/lockdown` (deny all gated classes fleet-wide, one call) and optional idempotency keys on write-class calls (gateway-side replay suppression window — the "agent retried and sent it five times" killer).
**Why a step-change:** "Never the cause of a fleet outage" becomes an architectural property instead of an aspiration: every failure domain — one backend, one client, one runaway loop — is boxed. The breaker also transforms agent experience: hung backends cost 5ms, not 60s of a stalled turn.
**Builds on:** `ensureReconnected`'s dedup pattern (generalized), `connectionGeneration`, existing status tracking; fixes review findings H4/H5/M1 as side effects of the design rather than as patches.

### SC-7 · Capability intelligence + context economy v2
**What:** *(a) Resolution:* `gateway_resolve_capability(goal, constraints?)` — hybrid retrieval: existing token-set ranking + embeddings of `name+description+tags+aliases` computed at registration behind an `Embedder` interface (local MiniLM-class ONNX or remote — operator's pick), fused with **outcome priors** from the evidence plane (success rate, p50 latency, truncation rate — a tool failing 40% of the time ranks down). Manifests gain `aliases` and `exemplar` (one canonical invocation per important tool — gold for agents). `dry_run: true` on `gateway_call_tool` runs stages 1–4 and reports the would-be decision + validated args without executing. *(b) Economy:* manifest-declared READ caching (`cache: {ttl_s: 30}`, key = tool+args) with in-flight coalescing — a fleet polling the same status endpoints stops re-paying latency and tokens; artifact store v2 — disk spill under a state dir, byte-budget eviction + TTL, provenance (`{call_id, identity, tool, kind: original|compressed}`), and two hard fidelity rules: the **lossless original is always retrievable** (truncation markers reference the *original* artifact, fixing the pruned-truncation trap at `gateway.ts:1516-1529`) and `pruneEmpty` becomes opt-in per-backend (default off — `{"assignee": null}` ≠ `{}` in ITSM land).
**Why a step-change:** The gateway stops being a name-forwarder and becomes the fleet's **capability layer**: agents express intent, get the right tool with proof of its reliability, pre-flight risky calls, and spend tokens only on novel information. Outcome-aware ranking is a moat that compounds — every dispatch makes the gateway smarter, and only the narrow waist has the data to do it.
**Builds on:** `searchRegisteredTools`, the tag system, compression + artifact machinery, the evidence plane (SC-3/SC-6's events become the prior).

---

## 5 · The Enforcement & Safety Architecture

### 5.1 The spine, stage by stage

| # | Stage | Does | Denies with |
|---|---|---|---|
| 1 | **Authenticate** | Bearer → `{clientId, scopes}`; reject missing/unknown; attach to call context | `401 unauthenticated` |
| 2 | **Resolve + Validate** | Name (or intent) → `ToolEntry`; quarantine check; ajv-validate args vs pinned schema | `unknown_tool` · `contract_drift` · `invalid_args` (+ field detail) |
| 3 | **Policy** | class × identity table: allowed classes, backend deny-lists, budget state | `policy_denied` (+ which rule) |
| 4 | **Gate** | `decideGate` + confirmation **provenance** (self vs operator-token vs standing grant); `dry_run` exits here with the verdict | `confirmationRequired` (+ how to obtain) |
| 5 | **Bulkhead** | breaker state, per-backend semaphore, per-identity rate/budget, per-call timeout assembly | `backend_unavailable + retry_after` · `rate_limited` · `budget_exhausted` |
| 6 | **Execute** | `backend.callTool(name, args, {timeout})`; stale-session retry (surfacing `retryErr`); idempotency-key replay check | structured backend error |
| 7 | **Shape** | cache write (READ+cacheable), compression (lossless rules), char-cap, artifact refs | — |
| 8 | **Evidence** | emit `{ts, call_id, identity, session, tool, backend, class, decision, latency_ms, bytes_in/out, saved_pct, error_class, artifact_ids}` — **unconditionally**, including denials | — |

Singularity is held two ways: *convention* (only `dispatch.ts` imports `BackendInstance.callTool`; a lint boundary rule flags any other import) and *proof* (an invariant test asserts mux and namespaced paths return byte-identical gate verdicts for the same call).

### 5.2 The policy model (table-driven, no DSL)

```yaml
auth:
  required: true
  clients:
    orchestrator:        { token: "vault:secret/mcp-gateway/clients#orchestrator" }
    claude-code:  { token: "vault:secret/mcp-gateway/clients#claude_code" }
policy:
  defaults: { allow_classes: [READ], unmanifested_write: deny }
  identities:
    orchestrator:
      allow_classes: [READ, WRITE, SIDE_EFFECT, HUMAN_OUTBOUND]
      confirmation: { HUMAN_OUTBOUND: operator_token, WRITE: self }
      budgets: { calls_per_hour: 600, concurrent: 8 }
    claude-code:
      allow_classes: [READ, WRITE]
      deny_backends: [venafi]
```

Kept deliberately boring: a YAML table evaluated by ~80 lines of code. No OPA, no DSL, until a real policy outgrows the table.

### 5.3 Zero-trust toward backends

Transport: stdio unrepresentable (SC-2). Contract: descriptions and schemas pinned at review, served from the manifest, drift → quarantine (SC-5). Blast radius: breaker + semaphore + timeout + restart budget + quarantine (SC-6). Failure of any one backend degrades exactly one namespace, provably (invariant test: `crash_now` on stub A, concurrent green round-trip on stub B).

### 5.4 Proof: every invariant, its mechanism, its test

| Invariant | Structural mechanism | End-to-end proof |
|---|---|---|
| stdio cannot run | not in schema union; ingestion skips `command:` entries | boot with stdio YAML → exact parse error; MCPU fixture with `command:` → skipped + error event |
| every call is gated | single spine; lint boundary | WRITE unconfirmed via mux **and** namespaced → identical block |
| blocking by default | Zod default | boot empty safety block → blocking active |
| no anonymous calls | front-door middleware | tokenless → 401; bad token → 401; good → attributed evidence event |
| no caller exceeds scope | policy stage | experiment identity calling WRITE → `policy_denied` |
| no backend shared fate | breaker/semaphore/timeout | stub crash-loop → breaker OPEN, neighbor calls green, `retry_after` honored |
| restart policy honored | budget in one reconnect authority | `restart_policy: never` stub killed → zero auto-restarts (today: restarted every 30s) |
| payload fidelity | lossless-original artifact rule; prune opt-in | property test: fetch(artifact) == raw backend bytes for every compressed/truncated path |
| contract integrity | pin + serve-from-manifest + quarantine | stub mutates description live → quarantined in strict, pinned text still served |
| session isolation | per-connection `McpServer` | two concurrent clients, interleaved calls, zero bleed |
| recovery is real | stale-retry through spine | `drop_session` → next call succeeds; forced retry-failure surfaces `retryErr` |
| **the proof itself runs** | canary backend + scheduler | `/admin/status.invariants_proven_at` < 20m, else CRITICAL (+ optional lockdown) |

### 5.5 Failure-mode walkthroughs

**Poisoned backend** (supply-chain compromise rewrites `servicenow_create_incident`'s description to exfiltrate): registration diff fails the pin → tool quarantined, CRITICAL event, agents keep seeing the reviewed description; nothing reaches agent context. **Rogue client** (leaked token loops on `gateway_reconnect_backend` + WRITE calls): per-identity rate limit throttles, reconnect cooldown holds, budget denies, evidence attributes everything to the identity, operator revokes one Vault entry. **Hung backend**: 30s manifest timeout → breaker opens after the window → subsequent calls fail in 5ms with `retry_after` → half-open probe recovers it silently. **The gateway's own regression** (a refactor accidentally bypasses the gate): the invariant suite fails CI; if it somehow ships, the canary's next 15-minute pass fails → CRITICAL → lockdown. Four different attackers, one shared property: the blast radius is a single identity or a single namespace, never the fleet.

---

## 6 · Roadmap — dependency-ordered, proof-gated

> Effort in focused dev-days. Each phase ends with its invariants in the e2e suite — a phase isn't done when the code lands; it's done when the proof runs.

| Phase | Unlocks | Contents | Exit criterion (proof) | Effort |
|---|---|---|---|---|
| **P0 · Stop the bleeding** | master is safe to clone | merge `fix/never-stdio-copilot-studio`; `git rm -r --cached node_modules dist` + real `.gitignore`; close 9 superseded Dependabot PRs | clean clone + `start:fleet` attempts zero stdio connects; `git status` clean after `npm install` | 0.5 |
| **P1 · One Path, One Gate** (SC-1, SC-2) | invariants become structural | dispatch spine; delete stdio schema; ingestion skip; flip 4 defaults; cross-validation; seed the evidence event (one structured pino line in stage 8); fix H5 (`retryErr`) in passing | all dispatch flows through `dispatch.ts`; stdio YAML = parse error; both paths gate identically (unit-level until P2) | 4 |
| **P2 · Proof** (SC-3) | regressions cannot ship green | stub backend; invariant e2e suite; CI gate; fix health-monitor policy violations + single reconnect authority (proven by the suite) | `npm run test:invariants` boots real server, all §5.4 rows green that exist so far | 3 |
| **P3 · Identity** (SC-4) | per-agent trust; autonomy-grade confirmation | bearer middleware → `authInfo`; clients/policy blocks; per-identity attribution in evidence; operator confirmation tokens + standing grants | 401/policy/provenance rows green; every evidence event carries identity | 2 |
| **P4 · Bulkheads** (SC-6) | zero shared fate; fleet-grade resilience | breakers, semaphores, per-call timeouts, restart budgets, quarantine, reconnect cooldown, per-identity limits/budgets, lockdown, idempotency keys; **production canary** | shared-fate + restart-policy + canary rows green; `invariants_proven_at` live in status | 4 |
| **P5 · Evidence** | fleet debuggable from one place | NDJSON audit sink + rotation; `/metrics` (Prometheus); `gateway_tail_events` meta-tool (identity-scoped, read-only); per-identity cost rollups in status | "what did orchestrator write today" answerable in one call; canary failures visible in metrics | 2 |
| **P6 · Intelligence & Economy** (SC-5, SC-7) | capability fabric | contract pinning + `--pin/--live` audit + ajv arg validation; `resolve_capability` (lexical→hybrid embeddings) + outcome priors; `dry_run`; READ cache + coalescing; artifact store v2 + fidelity rules | pinning/fidelity rows green; resolve beats search on a 20-case eval set the operator writes; cache hit-rate visible in metrics | 6 |

**Total ≈ 21.5 focused days** to cross from "well-built proxy" to "self-proving control plane." P5 and P6a (pinning) can overlap P4; embeddings (P6b) are deliberately last — intelligence rides on rails of proof, never the reverse.

**Divergences from the review's own ranking, and why:** (1) The review's fix #2 patches the second call path; I replace both paths with a spine — patching N doors leaves N+1 doors tomorrow, and the spine is the insertion point every later phase needs anyway. (2) The review lists no-auth as H6, mid-pack; I promote identity to its own early phase — for an *autonomous* fleet it is the precondition for policy, budgets, audit, and meaningful confirmation, and the verified `req.auth → authInfo` slot makes it ~2 days. (3) The review says "no observability before integration tests" — agreed and kept, but the evidence *event* is seeded in P1 because the audit stream's schema should be born with the spine (one log line, not a dashboard). (4) The review files compression fidelity as Medium; I raise "lossless original always retrievable, prune opt-in" to an invariant — a control plane that can silently turn `{"assignee": null}` into `{}` corrupts the fleet's view of reality, and trust dies retail.

---

## 7 · Quickest Compounding Wins (start this week)

1. **Merge the stdio fix + delete the stdio schema in the same PR** (P0+half of SC-2, ~2h). One PR closes the documented outage class twice — config and type system — and the parse error becomes the teaching moment for any future config author.
2. **`git rm -r --cached node_modules dist`** (~30m). Every later diff in this roadmap becomes reviewable; today's 4,855 tracked dep files bury the signal.
3. **Flip the four defaults** (`blocking` / `mux` / `127.0.0.1` / `auth.required` once P3 lands the field) (~1h + a config touch for current clients). Compounds: every environment this gateway ever runs in inherits the safe posture.
4. **Write the stub backend now** (~half day). It immediately powers the invariant suite, then the resilience harness, then the production canary — one 150-line file serving three trust mechanisms.
5. **Seed the evidence event in `callBackendTool`** (~1h, moves into the spine in P1). Start accumulating outcome data today; P6's ranking priors and P5's cost rollups inherit months of history instead of starting cold.
6. **`audit:contracts --pin` flag** (~2h). Pins can be captured against today's live backends immediately, so P6's quarantine logic lands with review-grade baselines already in hand.

---

## 8 · Where I'd Bet Differently Than the Current Design

1. **Manifests should be the served contract, not an annotation.** (SC-5.) The current design trusts backend self-description at the exact boundary where MCP's known attack class lives.
2. **`confirmed: true` is the wrong primitive for autonomy.** Self-confirmation gates nothing when no human reads the transcript. Provenance-graded confirmation (SC-4) is the honest version.
3. **Defaults should encode the operator's rules, not the demo's convenience.** Four open defaults contradict the operator's own written doctrine; the schema should be the doctrine.
4. **Keep stateless-per-request — for now, on evidence.** I will not pre-optimize the per-request `McpServer` cost (the multi-session crash fix earned its keep); P5's metrics will price it, and a pooled per-identity-session model is the ready successor if the data demands it.
5. **The artifact store pretends to be durable; make it honest instead of bigger.** TTL + disk spill + provenance (SC-7b) — not Redis, not a database.
6. **No policy engine, no service mesh, no rewrite.** Express + SDK + YAML tables are right-sized for a single-host fleet; complexity must be paid for by a real policy the table can't express.

**Deliberately not built (YAGNI):** HA/clustering (single-host fleet), ~~OAuth/OIDC (until the gateway leaves the box)~~ *[DELETED 2026-06-10 — replaced by "JWT validation regardless of network position": the gateway leaves the box by mandate; Entra ID JWT validation (`auth: mode: entra`) is now available and applies whether the gateway is loopback or network-exposed]*, a web dashboard (until the evidence stream exists and asks for one), resource/prompt aggregation expansion (tools are the capability surface that matters), ~~per-tenant multi-gateway federation (one operator, one waist)~~ *[ANNOTATED 2026-06-10: a second host now exists by mandate; gateway-to-gateway federation remains banned; multiple policy-scoped **instances** of the single artifact (one per host) are in scope — instances do not federate, they share a policy configuration]* .

---

## 9 · Groundings & Remaining Unknowns

**Verified during this design:** stdio schema/connector/ingestion paths (`config.ts:6-67`, `backend.ts:101-160`, `fleet-backend-ingestion.ts:115-213`); gate topology (`gateway.ts:258-259, 802-858`); defaults (`config.ts:71,75,110`); SDK blanket 60s timeout (`protocol.js:8,704`) and that `callTool` passes no options (`backend.ts:265`); SDK `authInfo` propagation slot (`streamableHttp.js:61,131`); health-monitor policy violations (`gateway.ts:1994-2018`, `backend.ts:322`); verbatim description serving (`tool-registry.ts:54`); truncation-stores-pruned-text trap (`gateway.ts:1516-1529`).

**One remaining verification before P3:** confirm `extra.authInfo` reaches `setRequestHandler` callbacks through the high-level `McpServer` in SDK 1.26 (the transport carries it; the handler-context hop should be eyeballed in `server/index.js` + `shared/protocol.js` — 15 minutes, and the middleware design is unchanged either way since identity can also ride the session map).

---

*The review told you where the gateway is weak. This document's claim is sharper: the gateway is one spine, one schema deletion, one harness, and one token check away from being the most trustworthy component the fleet has — and after that, the only component positioned to make every agent smarter than it was. Build the proof first. Everything else is permitted to be ambitious because the proof exists.*
