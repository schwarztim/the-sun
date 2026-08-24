# Copilot instructions for Hermes

Hermes is a credential broker and headless SSO control plane for REST API MCPs.
Optimize changes for reliability under corporate Conditional Access, not for
one-off token fixes.

## Hard constraints

- Never add foreground browser auth. All provider auth paths must remain
  headless. If auth cannot complete headlessly, return structured remediation.
- Do not delete or rotate credentials as a first response. Use `hermes status`,
  `hermes doctor`, lifecycle state, token health, and the README recovery
  runbook before suggesting `hermes acquire <service>`.
- Do not bypass launchd by manually running `node dist/cli.js start` except for
  explicit debugging.
- Never commit secrets, cookies, bearer tokens, API keys, client tokens, or raw
  evidence from provider responses.

## Architecture to preserve

Hermes has four standard lanes:

1. Credential lane: MCPs request credentials by `service` and `scheme`.
2. Failure feedback lane: MCPs report real downstream 401/403/auth failures via
   HTTP or `hermes_report_auth_failure`.
3. Recovery lane: Hermes marks credentials suspect, coalesces refresh/reacquire,
   avoids auth storms, and returns exact remediation for human-action cases.
4. Proof lane: Hermes records storage, freshness, provider validation,
   propagation, and authenticated downstream MCP proof without secrets.

## Provider semantics

- OAuth providers can usually refresh with refresh tokens.
- Cookie-session providers, including ServiceNow, reacquire headlessly rather
  than silently refreshing.
- ServiceNow auth failures include 401/403, invalid session, CSRF failures,
  missing/invalid `g_ck`, and login-route changes.
- Network, VPN, and 5xx provider validation failures are retryable or
  inconclusive and must not cause credential deletion or uncontrolled reacquire
  storms.

## Validation expectations

For code changes, run the relevant package tests plus build/typecheck when the
change crosses package boundaries. Reliability work should also run:

```bash
pnpm test
pnpm run build
pnpm -r typecheck
pnpm eval:reliability
pnpm smoke:live
```

`pnpm smoke:live` may report degraded auth if local credentials need acquisition;
that is an operational state, not a code failure, when the broker, health check,
MCP tools, and structured remediation are working.
