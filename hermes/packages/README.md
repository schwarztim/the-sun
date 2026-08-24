# Hermes workspace map

This pnpm workspace contains the broker, the shared auth-core library, the typed client consumer SDK, and one package per SSO-target provider. Use this map to navigate.

## Core packages

| Package                          | What it does                                                                                                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@hermes/broker`                 | The HTTP + MCP server on `127.0.0.1:9876`. Token caching, refresh lifecycle, failure-feedback routing, capability shield, MCP tool surface (`hermes_status`, `hermes_token_health`, `hermes_acquire`, `hermes_prepare_capabilities`, `hermes_classify_tool_failure`, etc.) |
| `@hermes/auth-core`              | Shared library for browser-auth, conditional-access classification, dual-mode auth, debug-capture (screenshots + DOM redaction + stall detection), the canonical `runSsoLoop` helper, URL sanitization, TOTP, and silent OAuth refresh.                                                            |
| `@hermes/client`                 | The TypeScript SDK every REST-MCP consumer should use. `withHermesAuthRetry()`, `classifyAuthResponse()`, header-aware credential application.                              |

## Provider packages

Each provider is a single SSO target. The provider exports an `acquire(scheme)` and `validate(bundle)` surface that the broker dispatches to. They share patterns: env-var-first project-dir resolution, vault-backed token persistence, `silentRefresh` for OAuth schemes, browser-auth shell-out for interactive flows.

| Package                                | Service shape                       | Notes                                                                                          |
| -------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| `@hermes/provider-servicenow`          | `servicenow` / `session`            | Cookie-session + g_ck CSRF + `runSsoLoop`-based browser flow                                   |
| `@hermes/provider-az-teams`            | `az-teams` / `graph`, `teams-bearer`, `skype`, `files`, `substrate` | Shells out to `auth.py` in the unified-m365-mcp-server project (override via `AZ_TEAMS_PROJECT_DIR`) |
| `@hermes/provider-akamai-wsa`          | `akamai-wsa` / `session`            | Two-phase auth (Akamai page + Azure AD); strict `AKASSO`/`AKATOKEN` cookie check; POST-with-AbortController validate |
| `@hermes/provider-cookie-session`      | site-specific / `session`           | Generic cookie-session loop; used by `venafi`, `tufin`                                         |
| `@hermes/provider-dynatrace`           | `dynatrace` / `session`             | Refactored onto `runSsoLoop`; multi-step post-SSO navigation to live.dynatrace.com             |
| `@hermes/provider-ms365`               | `ms365` / `graph`, `outlook`, `teams` | Token-based OAuth, no browser flow in the provider itself (delegates to `BrowserAuth` in auth-core) |
| `@hermes/provider-oauth2`              | (generic)                           | Generic OAuth2 dance via `BrowserAuth`                                                         |
| `@hermes/provider-az-teams` Python helper | (separate companion repo)   | Companion Python project shelled out for browser-flow auth; resolved via `AZ_TEAMS_PROJECT_DIR` |
| `@hermes/provider-azure-keyvault`      | azure-keyvault / various            | Azure Key Vault integration                                                                    |
| `@hermes/provider-crowdstrike`         | crowdstrike / `session`             | Proxy-mode (browser stays open). Different architecture from the others — no capture wiring yet. |

## How to add a new provider

See `docs/AGENTS.md` → [Adding a new SSO scheme](../docs/AGENTS.md#adding-a-new-sso-scheme).

Short version: extend the existing `provider-<service>` if you're adding a scheme to an existing SSO target. Create a new `provider-<service>` only when the target is a wholly new SSO system. Reference implementations: commit `8e59818` (new scheme on existing provider) and the structure of `provider-servicenow` (new provider end-to-end).

## Tests

Each package has a `tests/` directory under it; run with `pnpm --filter @hermes/<package> test` or `pnpm -r test` for the whole workspace. Capture-wiring tests (`tests/capture-wiring.test.ts`) verify the observability stack per provider. The broker has the largest suite at 211 tests covering scheduler, lifecycle, transport-failure classification, proof-probes, capability-shield, etc.

## Conventions in this workspace

- TypeScript strict mode with `noUncheckedIndexedAccess`
- Vitest, no global imports (`import { describe, it, expect } from 'vitest'`)
- pnpm workspace; `@hermes/<pkg>` package names
- Atomic commits prefixed with the relevant issue-tracker key (`PROJ-1107:` for current observability/reliability work)
- Headless-only browser config (`z.literal(true)` on the `headless` field of provider schemas; never relax this)
