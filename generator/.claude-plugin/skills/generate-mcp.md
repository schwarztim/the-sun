---
name: generate-mcp
description: Generate a production-ready MCP server for any tool/API
---

# Generate MCP Skill

> **STOP: Use `optimize-mcp-creation` instead.**
>
> This skill runs thesun directly without intelligence gathering, tool design,
> or quality scoring. `optimize-mcp-creation` is the fully autonomous pipeline
> that researches the API ecosystem, designs task-oriented tools, generates via
> thesun, scores quality, and auto-fixes until passing — all in one invocation.
>
> **Only use this skill directly** if you specifically need to bypass the optimizer
> (e.g., rapid iteration on a known-working MCP, or debugging the builder itself).

This skill generates complete, production-ready MCP servers autonomously.

## IMPORTANT: Ask User First

When you detect the user wants to interact with a tool/API that has no existing MCP:

**DO NOT** immediately generate. Instead say:

> "There's no MCP server for {tool}. Would you like me to create one using thesun?
> This will autonomously research the API, generate a Python/FastMCP server (streamable-http,
> containerized), verify it with the Conformance Lab, and register it globally so you can
> use it in any future conversation."

Wait for user confirmation before proceeding.

## When to SUGGEST This Skill

Proactively suggest this skill when:

- User mentions a tool/service that has no MCP (check available tools first)
- User asks "can Claude connect to X?" where X has no MCP
- User wants to automate something with an external API
- User asks about integrating with a service

## When to Use (After Confirmation)

Execute this skill when:

- User explicitly asks to "create an MCP server for X"
- User confirms they want to generate after your suggestion
- User wants to "integrate with X API"
- User needs to "automate X tool"
- A workflow requires an MCP that doesn't exist

## Can Also IMPROVE Existing MCPs

This skill can also validate and improve existing MCPs:

- Run `thesun({ target: "name", fix: "/path/to/mcp" })` to fix issues
- Validates: package.json, tests, README, .env.example, architecture docs, git repo
- Provides score 0-100 and improvement recommendations
- Loops back to fix failures automatically (up to 3 attempts)

## How It Works

1. **Spawn the mcp-builder agent** with the tool specification
2. Agent runs autonomously through all phases
3. Returns completed MCP server code

## Invocation

```
To generate an MCP server for {tool}, I'll spawn the mcp-builder agent.

<Task subagent_type="mcp-builder">
Generate a complete MCP server for {tool}.

Tool: {tool}
Output: {output_path or default}
Spec URL: {spec_url if provided}

Run through all phases:
1. Discovery - research all APIs
2. Generation - create a Python/FastMCP server (streamable-http, templates copied from `src/templates/python/`)
3. Testing - `uv run pytest`, then the `thesun verify` Conformance Lab hard gate — iterate until passing
4. Security - scan and remediate
5. Optimization - performance tuning
6. Documentation - README and usage guide

Report back with:
- Endpoint count
- `thesun verify` result (pass/fail + findings)
- Any issues encountered
</Task>
```

## What Gets Generated

```
{tool}-mcp-server/
├── src/
│   ├── server.py              # FastMCP server entry point (streamable-http)
│   ├── http_client.py         # Copied — browser-fingerprint HTTP client
│   ├── ratelimit.py            # Copied — adaptive rate limiter
│   └── auth.py                 # Copied — Hermes dual-mode auth
├── tests/
├── pyproject.toml              # uv-managed deps (fastmcp, httpx, curl_cffi, aiolimiter, tenacity)
├── Dockerfile                  # Containerized run (Chrome-on-Linux impersonation)
├── .env.example                # Config template (no real secrets)
├── README.md                   # Usage documentation
└── CLAUDE.md                   # Claude Code guidance
```

## Configuration Abstraction

**CRITICAL**: Generated MCPs must be generic and publishable.

All configuration via environment variables:

- `{TOOL}_API_KEY` - API credentials
- `{TOOL}_BASE_URL` - API endpoint (with default)
- `LOG_LEVEL` - Logging verbosity
- etc.

NO hardcoded:

- Company URLs
- API keys/tokens
- Email addresses
- IP addresses

## Quality Gates

The generated MCP must pass:

- ✅ `uv run pytest` — all tests passing
- ✅ `thesun verify` — the Conformance Lab hard gate (protocol, instrumentation, transport, wire-fingerprint, credential scan, callability, precision, coverage, rate-limiter presence)
- ✅ 70%+ code coverage
- ✅ No critical security issues (`uv run pip-audit`)
- ✅ No hardcoded secrets
- ✅ Startup time <1s
- ✅ Complete documentation

## Error Handling

If generation fails:

1. Check the error in the build log
2. Most issues are auto-remediated via iteration
3. Persistent failures are documented in the output
4. Unresolved issues require manual intervention

## Validation & Feedback Loop

After generation completes, a final validation phase runs to ensure ALL requirements are met:

### Validation Checks (ALL run in PARALLEL)

- ✅ pyproject.toml exists
- ✅ Entry point (src/server.py) exists
- ✅ README.md exists
- ✅ .env.example exists
- ✅ Test files exist
- ✅ Architecture documentation exists
- ✅ Build passes (`uv sync && uv run pytest`)
- ✅ `thesun verify` passes (Conformance Lab hard gate)
- ✅ Git repository initialized
- ✅ Git remote configured (GitHub)

### Remediation Loop

If any validation fails:

1. System identifies failed requirements
2. Loops back to GENERATING phase
3. Fixes the specific issues
4. Re-runs validation
5. Repeats up to 3 times before failing

### Using FIX Mode for Existing MCPs

To improve an existing MCP:

```
thesun({ target: "toolname", fix: "/path/to/existing-mcp" })
```

This will:

1. Validate the existing MCP (score 0-100)
2. Identify missing items and issues
3. Autonomously fix problems
4. Iterate until all requirements met or max attempts reached
