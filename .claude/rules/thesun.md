---
description: Project rules for thesun — one CLI to generate, run, route, and authenticate MCP servers
globs: "*"
---

<!-- Managed by schwarztim/claude-rules -->

# thesun

## Project Overview

thesun is one CLI that generates, runs, routes, and authenticates MCP servers, with no Docker
and no ToolHive. It bundles four subsystems: `generator/` (a TypeScript REST-to-MCP generator,
Go output by default), `fleet/` (a Go `fleetd` supervisor plus the unified `thesun` CLI that
starts/stops/registers servers), `gateway/` (a Node MCP mux on `127.0.0.1:3100` that is the
security policy enforcement point, or PEP), and `hermes/` (a TypeScript auth broker plus
encrypted vault). Servers run as native binaries supervised by `fleetd`, reached only over
streamable-http.

## Essential Commands

```bash
# Build (whole stack: generator, fleetd + thesun CLI, gateway, hermes)
./install.sh

# Test (per subsystem)
cd generator && npm test                       # vitest
cd gateway && ./node_modules/.bin/vitest run    # or: npm test
cd hermes && pnpm -r test                       # all @hermes/* packages
cd fleet/fleetd && go test ./...

# Run
export PATH="$(pwd)/bin:$PATH"
thesun install   # init, register OS service, bring stack up, wire AI clients
thesun status    # whole-stack + per-server health
thesun doctor    # readiness diagnostics
```

## Architecture

Flow: generate -> run -> route -> authenticate. Every client (Claude Code, Copilot CLI, Codex
CLI, OpenCode) talks streamable-http to the one gateway endpoint; every tool call funnels
through it. The gateway enforces a two-tier safety model: Tier-A is a model self-confirm (a
speed bump for audit, NOT a boundary an autonomous model cannot cross) and Tier-B is
out-of-band human approval via `thesun approve`, which is un-bypassable. A default-conservative
escalation overlay promotes genuinely dangerous Tier-A tools (DELETE, destructive/outbound
verbs, named production backends) up to Tier-B. Transport is streamable-http only; stdio and
SSE are prohibited and stdio backends are quarantined before config parse.

## Project-Specific Rules

- Never wire a backend over stdio or SSE. Streamable-http with a `url:` only.
- The gateway is the authoritative floor; client hooks are an additive, bypassable layer.
- Secrets live in the Hermes vault; nothing else stores secret values.

@~/.claude/fragments/credential-registry.md
