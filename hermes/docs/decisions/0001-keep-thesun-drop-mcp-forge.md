# ADR 0001: Keep thesun, drop mcp-forge

**Date:** 2026-04-09
**Status:** Accepted

## Context

Two near-duplicate MCP generator codebases existed:
- `~/Scripts/mcp-servers/thesun/` — registered in MCPU, user's active generator
- `~/Scripts/mcp-servers/mcp-forge/` — alternate implementation, diverged

Hermes will absorb the battle-tested Azure AD SSO code from whichever one
survives. Maintaining both blocks extraction.

## Decision

Keep `thesun`. Archive and delete `mcp-forge`.

## Rationale

- `thesun` is the one wired into MCPU and user skills (`/sun:*`)
- `thesun` is more recent (last touched 2026-03-16 vs 2026-02-13)
- The user's mental model treats `thesun` as canonical

## Consequences

- Any fixes made to mcp-forge that did not land in thesun are lost
  (archive at `~/Archive/mcp-forge-2026-04-09.tar.gz` for recovery)
- thesun remains authoritative until its auth code is extracted into
  Hermes providers (Phase 3)
