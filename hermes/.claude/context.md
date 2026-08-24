# Claude context for Hermes

Hermes is the host-local authentication broker for SSO-heavy MCPs. It exists so
agents and containerized MCP servers do not each need custom Conditional Access,
OAuth refresh, ServiceNow cookie, or browser-profile workarounds.

## Product goal

Authentication should become a solved background service for REST API MCPs:
agents request credentials, use APIs, report auth failures, and Hermes heals or
returns a precise operator remediation. Raw 401 loops, silent expired sessions,
foreground browser popups, and ad-hoc credential deletion are failures of the
contract.

## Current implementation themes

- Headless-only provider acquisition and reacquisition.
- Provider capability metadata for credential source, refresh strategy,
  validation strategy, Conditional Access modes, and remediation.
- Durable non-secret lifecycle state with proof, propagation, and downstream
  auth-failure events.
- Consumer auth failure feedback through HTTP and MCP.
- Authenticated downstream MCP proof probes when service registration includes
  safe probe metadata.
- ServiceNow/cookie-session hardening around session cookies, `g_ck`, CSRF,
  401/403, network/VPN, profile-lock, and reacquire coalescing.
- `@hermes/client` helpers for REST MCP adoption.
- Optional organization runbook enrichment from non-secret
  `~/.hermes/org-runbooks.json`.

## Operating rules

- Preserve headless-only authentication. If Conditional Access cannot be
  satisfied headlessly, surface remediation; do not open UI.
- Restart and diagnose before rotating credentials.
- Treat transport-stuck broker symptoms as launchd/orphan-listener problems
  until proven otherwise.
- Distinguish auth failures from transient network/service failures.
- Redact all credential material in logs, lifecycle state, tests, docs, and MCP
  responses.
- Use `main` as the canonical branch and keep GitHub and Stash mirrors aligned
  when Stash permissions allow pushes.
