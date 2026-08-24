---
name: optimize-mcp-creation
description: Fully autonomous MCP creation pipeline. Single invocation — researches API ecosystem, designs task-oriented tools, generates via thesun, scores quality, auto-fixes until passing. THE default for all MCP creation.
---

# Optimize MCP Creation

**THE single entry point for all MCP creation.** One invocation, fully autonomous. No manual phase transitions.

When a user says "create an MCP for X", "use thesun for X", or any variant — this skill runs automatically. It selects the best approach, executes it, and delivers a scored, validated MCP.

## Invocation

When this skill activates, execute the **entire pipeline below autonomously**. Do not stop between phases. Do not ask for confirmation between phases. Run to completion.

```
INPUT: {target} — the API/service name
CONTEXT: {path to file/dir} — optional enriching data (OpenAPI spec, API docs, requirements, tool designs, existing code)
OUTPUT: A registered, scored, quality-gated MCP at ~/Scripts/mcp-servers/{target}-mcp
```

---

## THE PIPELINE

### Phase 0: Read Context (if provided)

If a context file or directory was provided, read it BEFORE any research:

1. **Classify each file** by type:
   - `.yaml`, `.json` with `openapi` or `swagger` key → OpenAPI spec
   - `.md`, `.txt` with `## Tools Required` → User-specified tool design (authoritative)
   - `.md`, `.txt` with `## Auth` → Requirements document (hard constraints)
   - `.md`, `.txt`, `.pdf`, `.html` otherwise → Supplemental API docs
   - Directory with `src/`, `package.json` → Existing code to use as reference
   - URL starting with `http` → Fetch and classify as above

2. **Stage the context** for the optimizer:
   - OpenAPI spec → Copy to `~/.thesun/blueprints/{target}-openapi.yaml`
   - Tool design → Will be included verbatim in blueprint as "## Tool Design (User-Specified)"
   - Requirements → Passed as hard constraints to the optimizer
   - API docs → Passed as supplemental context to research subagents
   - Existing code → Passed as reference template to the optimizer

3. **Determine what research to skip**:
   - OpenAPI spec provided → Skip spec discovery subagent
   - Tool design provided → Skip tool design intelligence step (Step 2.5)
   - Auth details provided → Skip auth research subagent (validate only)
   - Full requirements provided → Research becomes validation, not discovery

### Phase 1: Intelligence Gathering (mcp-optimizer PRE mode)

Spawn the mcp-optimizer agent to research and produce a blueprint. This runs autonomously with 5 parallel research subagents (some may be skipped if context was provided).

```
<Task subagent_type="mcp-optimizer" model="opus">
MODE: PRE-GENERATION
TARGET: {target}
CONTEXT_FILES: {list of staged context files, or "none"}
USER_TOOL_DESIGN: {contents of tool design file if provided, or "none"}
USER_REQUIREMENTS: {contents of requirements file if provided, or "none"}
OPENAPI_SPEC: {path to staged spec if provided, or "none"}

Execute full pre-generation intelligence:
1. Read ~/.thesun/knowledge/ for prior builds, gotchas, failures
2. Read any provided context files
3. Run parallel research subagents (skip those covered by context):
   a. OpenAPI spec discovery (SKIP if spec provided)
   b. Authentication methods (VALIDATE ONLY if auth details provided)
   c. Existing MCP implementations
   d. API complexity assessment
   e. Tool ecosystem & surface area (CLIs, SDKs, GraphQL, Terraform)
4. Design task-oriented tool inventory — OR use user-specified design if provided
5. Match against known patterns
6. Select reference template
7. Auto-select mode: CREATE / FIX / BATCH
8. Write blueprint to ~/.thesun/blueprints/{target}-blueprint.md
   - Include user-specified tool design verbatim under "## Tool Design (User-Specified)" if provided
   - Include user requirements verbatim under "## Requirements (User-Specified)" if provided
9. Determine credential strategy

Return:
- Blueprint path
- Selected mode (CREATE/FIX/BATCH)
- Key findings (1 paragraph)
- Confidence level
- Any blockers
- What context was used vs what was researched
</Task>
```

**Do not wait for user review.** Proceed immediately to Phase 2 with the blueprint.

### Phase 2: Execute Generation

Based on the mode selected in Phase 1:

**If CREATE or BATCH:**

```
thesun({ target: "{target}" })
```

**If FIX** (existing MCP found that needs repair):

```
thesun({ target: "{target}", fix: "~/Scripts/mcp-servers/{target}-mcp" })
```

The mcp-builder agent will automatically detect and consume the blueprint at `~/.thesun/blueprints/{target}-blueprint.md`. It uses it to:

- Skip redundant discovery (auth, pagination, base URL already known)
- Follow reference patterns for client initialization and error handling
- Apply known workarounds proactively from gotchas.json
- Implement the tool inventory from the blueprint (task-oriented, not endpoint-oriented)
- Use the best surface per operation (SDK over REST when superior, CLI for complex workflows)
- Target the endpoint coverage specified in the blueprint

### Phase 3: Quality Gate (mcp-optimizer POST mode)

Immediately after generation completes, run the hard structural gate FIRST, then score the output.

```
<Task subagent_type="mcp-optimizer" model="opus">
MODE: POST-GENERATION
TARGET: {target}
OUTPUT_DIR: ~/Scripts/mcp-servers/{target}-mcp

Execute full post-generation assessment:
0. Run `thesun verify {output_dir}` (Conformance Lab — MANDATORY, structural, not a subagent grep).
   Extract from lab-report.json: wire-fingerprint pass/fail, rate-limiter-presence pass/fail,
   precision (tools live-invoked successfully / total), coverage (mapped/authoritative ratio).
   If ANY Lab gate fails, the verdict is forced to MANUAL-REVIEW — this overrides step 2's
   point-based score entirely. Do not let a subagent's prose assessment override a Lab failure.
1. Run 6 parallel quality checks (structure, build, architecture, performance, security+docs, tool design)
2. Score against 100-point base rubric + 20-point tool design bonus
3. Compare against blueprint expectations
4. Compare against reference MCP patterns
5. Update ~/.thesun/knowledge/ with results (include labVerdict + labGates, see mcp-optimizer.md schema)
6. Return verdict and score

Return:
- Conformance Lab verdict (PASS/FAIL) and gate-by-gate results — report this first
- Total score (0-100) and grade (A-F)
- Tool design score (0-20)
- Verdict: APPROVE / AUTO-FIX / MANUAL-REVIEW (forced MANUAL-REVIEW on any Lab failure)
- Specific issues list (if any) — lead with Lab findings, then rubric deductions
</Task>
```

### Phase 4: Auto-Fix Loop (conditional, up to 2 iterations)

**If verdict is AUTO-FIX (score 60-74, Lab PASSED):**

```
thesun({ target: "{target}", fix: "~/Scripts/mcp-servers/{target}-mcp" })
```

Then re-run Phase 3. Maximum 2 fix iterations.

**If verdict is APPROVE (score ≥ 75 AND Lab PASSED):** Skip to Phase 5.

**If verdict is MANUAL-REVIEW or REBUILD (score < 60, OR the Lab verdict is FAIL regardless of score):** Stop, report findings, and ask user how to proceed. This is the ONLY case where the pipeline pauses.

### Phase 5: Report

Output a final summary:

```
## MCP Created: {target}-mcp

**Score**: {score}/100 (Grade {grade}) | Tool Design: {tool_score}/20
**Path**: ~/Scripts/mcp-servers/{target}-mcp
**Tools**: {count} tools ({list of tool names})
**Auth**: {auth_type} via {storage_method}
**Fix iterations**: {0-2}

### What it can do
{2-3 sentences describing the MCP's capabilities in terms of what tasks
an AI agent can accomplish with it}

### Key decisions made
- {decision 1 with rationale}
- {decision 2 with rationale}
```

---

## Decision Logic (Automatic — No User Input Required)

The skill auto-selects the best approach without asking:

| Situation                                       | Decision                           | Rationale                                 |
| ----------------------------------------------- | ---------------------------------- | ----------------------------------------- |
| No existing MCP at output path                  | CREATE                             | Fresh build                               |
| Existing MCP at output path, score < 40         | CREATE (overwrite)                 | Too broken to fix                         |
| Existing MCP at output path, score ≥ 40         | FIX                                | Cheaper than rebuilding                   |
| Multiple targets in comma-separated input       | BATCH                              | Parallel via bob instances                |
| Prior build in quality-scores.json scored ≥ 85  | CREATE (refresh)                   | Good foundation, update to latest         |
| Known gotchas for this API with severity "high" | Auto-apply workarounds             | Blueprint includes them                   |
| Official SDK exists on npm                      | Use SDK as primary surface         | More reliable than raw REST               |
| CLI tool exists                                 | Evaluate CLI vs REST per operation | CLI wins for complex multi-step workflows |

---

## Tool Design Principles (Enforced Automatically)

These are applied during blueprint generation (Phase 1) and verified during scoring (Phase 3). They are non-negotiable.

1. **Task-oriented, not endpoint-oriented** — Tools are named for what an AI agent wants to DO.
   - GOOD: `investigate_host`, `deploy_certificate`, `approve_change_request`
   - BAD: `get_api_v1_hosts`, `post_certificates`, `patch_change_12345`

2. **Marry all surfaces** — REST, SDK, CLI, GraphQL are all inputs. The tool uses whichever surface is best per operation. An MCP for AWS should use the AWS SDK, not raw REST. An MCP for Akamai should use the `akamai-edgegrid` package, not manual HMAC signing.

3. **No thin wrappers** — Every tool does meaningful work:
   - Handles pagination internally (returns all results)
   - Filters/formats responses for AI consumption
   - Composes multiple API calls when the task requires it
   - Provides actionable error messages

4. **Auth-aware grouping** — Tools that need different permission scopes are clearly documented. A read-only tool never silently fails because it tried a write endpoint.

5. **AI-relevant descriptions** — Tool descriptions say what you can ACCOMPLISH, not how the API works. "Find all hosts that match a threat indicator and return their risk summary" not "Query the /hosts endpoint with filter parameters".

---

## Quality Rubric (100 Base + 20 Bonus, Gated by the Conformance Lab)

### Conformance Lab (Phase 3, Step 0 — structural gate, not a scoring category)

| Gate                 | Verified By                                          |
| --------------------- | ----------------------------------------------------- |
| Wire-fingerprint      | `thesun verify` — JA4/header order == Chrome-on-Linux |
| Rate-limiter presence | `thesun verify` — fails if a known-limited target ships without a seeded `AdaptiveRateLimiter` |
| Coverage manifest     | `thesun verify` — `coverage.json` mapped/authoritative ratio (spec, or autonomous-exploration denominator) |
| Precision             | `thesun verify` — every tool live-invoked; 404/malformed responses fail the build |

**This is a hard gate, not a point contributor.** Any Lab gate failure forces the overall verdict to MANUAL-REVIEW regardless of the Base Score below — see Phase 3/4. The Base Score only matters when the Lab has already passed.

### Base Score (100 pts)

| Category        | Points | Key Checks                                                                 |
| --------------- | ------ | --------------------------------------------------------------------------- |
| Structure       | 20     | pyproject.toml, entry point (src/server.py), README, .env.example           |
| Build Quality   | 20     | `uv sync`/`pytest` pass, coverage ≥ 70%, Conformance Lab PASSED              |
| Architecture    | 25     | Copied http_client/ratelimit/auth templates wired in unmodified, graceful startup |
| Performance     | 15     | No shell spawning, batch ops via asyncio.gather, seeded rate limiter         |
| Security + Docs | 20     | No secrets, `pip-audit` clean, CLAUDE.md, coverage report                    |

### Tool Design Bonus (20 pts)

| Check                              | Points |
| ---------------------------------- | ------ |
| Task-oriented naming               | 5      |
| Internal pagination                | 3      |
| Composite workflows (2+ API calls) | 4      |
| No thin wrappers                   | 3      |
| SDK/CLI usage where superior       | 3      |
| AI-relevant descriptions           | 2      |

### Score Thresholds

| Score  | Grade | Pipeline Action                      |
| ------ | ----- | ------------------------------------ |
| 90-100 | A     | APPROVE — done                       |
| 75-89  | B     | APPROVE with notes                   |
| 60-74  | C     | AUTO-FIX — fix and re-score (max 2x) |
| 40-59  | D     | MANUAL-REVIEW — stop and report      |
| 0-39   | F     | REBUILD — report failure, ask user   |

**Score thresholds only apply when the Conformance Lab PASSED.** If the Lab FAILED, the verdict is MANUAL-REVIEW no matter what number falls out of the table above.

**Tool design override:** If base score ≥ 75 but tool design bonus < 10, force MANUAL-REVIEW. Good architecture with bad tools is useless for AI agents.

---

## Credential Strategy (Applied Automatically)

The optimizer auto-selects credential storage based on auth type. No user input needed unless auth requires browser-based capture.

### Hermes Is the Default Auth Broker (SSO / OAuth / API Key / Session)

**Every SSO, Azure AD, corporate-SSO, OAuth, API key, or session-cookie target MUST authenticate through Hermes by default.** Do NOT emit standalone Playwright automation or a homegrown SSO loop as the primary auth path, and do NOT hand-write an auth module. The generated server is a Python/FastMCP process that **copies `src/templates/python/auth.py` verbatim** — there is no `@hermes/auth-core` npm package in this pipeline; `auth.py` talks to the Hermes broker directly over HTTP.

```python
# Copy pattern (same convention used for http_client.py / ratelimit.py):
# cp src/templates/python/auth.py {output_dir}/src/auth.py
#
# auth.py's dual-mode contract (do not reimplement — copy and configure via env only):
#   HERMES_URL + HERMES_CLIENT_TOKEN set  -> GET {HERMES_URL}/token/{service}/{scheme},
#     broker owns refresh/reauth-on-expiry/headless SSO reseed. Fails loud (raises) on
#     broker error — never silently falls back, since that would hide a real auth outage.
#   unset -> reads {SERVICE}_TOKEN / _API_KEY / _SESSION from the environment.
#   {SERVICE}_LEGACY_AUTH=true forces the standalone path even when Hermes is configured.
#
# Every tool calls the single contract: auth.py's get_auth_headers()
```

**Behavior:** with `HERMES_URL` + `HERMES_CLIENT_TOKEN` set, tokens come from the Hermes broker. With them unset, the standalone env-var path is used — the server still works, the broker is never hard-required.

**Required emissions for any SSO/OAuth/API-key/session target:**
- `pyproject.toml` dependencies MUST include `httpx` (already required for `http_client.py`) — no separate Hermes SDK dependency, since `auth.py` talks to Hermes over plain HTTP.
- `.env.example` + README MUST document the env-var contract: `THESUN_SERVICE`, `THESUN_AUTH_SCHEME`, `HERMES_URL` (e.g. `http://host.docker.internal:9876`), `HERMES_CLIENT_TOKEN` (from `~/.hermes/client.token`), and the standalone fallback var(s).
- Never store credentials as plaintext in emitted code — route through `auth.py`'s `get_auth_headers()`.

| Auth Type                 | Auto-Selected Strategy         | Storage                                            |
| ------------------------- | ------------------------------- | -------------------------------------------------- |
| **SSO / Browser**         | **Hermes dual-mode (`auth.py`)** | Hermes broker (`HERMES_URL`) or standalone env var |
| **Azure AD / Corp SSO**   | **Hermes dual-mode (`auth.py`)** | Hermes broker (`HERMES_URL`) or standalone env var |
| **OAuth2 (any flow)**     | **Hermes dual-mode (`auth.py`)** | Hermes broker (`HERMES_URL`) or `~/.thesun/credentials/{target}.env` |
| API Key                   | Hermes dual-mode (`auth.py`)     | Hermes broker or user-mcps.json / container `"env"` |
| Bearer Token              | Hermes dual-mode (`auth.py`)     | Hermes broker or user-mcps.json / container `"env"` |
| EdgeGrid                  | Standard edgerc                | `~/.edgerc`                                        |
| AWS SigV4                 | AWS credential chain            | `~/.aws/credentials` or env vars                   |
| macOS Keychain            | security command                 | Keychain Access                                    |

---

## Knowledge Base

All accumulated intelligence at `~/.thesun/knowledge/`. Self-initializing, grows with every build.

```
~/.thesun/knowledge/
├── patterns.json         # 18+ API patterns (auth, pagination, errors)
├── failures.json         # Past failures and resolutions
├── gotchas.json          # API-specific quirks (seeded for ServiceNow, Akamai, AWS, MS365, CrowdStrike, Venafi, Tufin)
├── quality-scores.json   # Historical scores — enables "is this API getting better?"
├── reference-map.json    # Which existing MCP to use as template
└── blueprints/           # Persistent blueprint docs (survive interruptions)
```

Every build — success or failure — writes back to the knowledge base. The more MCPs you build, the smarter the optimizer gets.
