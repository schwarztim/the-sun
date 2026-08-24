# Hermes -- MCP Auth Broker

Hermes is a host-local, headless authentication control plane for REST API based
MCP servers that sit behind corporate SSO and Conditional Access. It runs on
your host, where device certificates, keychains, trusted CA bundles, and
persistent browser profiles live, and exposes a localhost HTTP/MCP API that
containerized MCPs use to fetch fresh, validated credentials.

## Why

Every MCP that authenticates against a corporate SSO, OAuth, cookie-session, or
API-token service hits the same wall: containers cannot satisfy Conditional
Access, refresh tokens reliably, or survive parallel downstream 401s. Hermes
solves that once, on the host, for every MCP.

## Repository

- **GitHub:** `https://github.com/schwarztim/hermes.git`

The canonical working branch is `main`.

## Status

Hermes now implements the Conditional Access/REST MCP reliability loop:

- provider capability metadata and remediation hints;
- non-secret lifecycle, proof, propagation, and downstream auth-failure state;
- HTTP and MCP consumer auth failure feedback;
- coalesced refresh/reacquire recovery with auth-storm protection;
- Conditional Access challenge taxonomy;
- ServiceNow and generic cookie-session hardening;
- client helpers for generated and hand-written REST MCPs;
- optional organization runbook enrichment from `~/.hermes/org-runbooks.json`;
- opt-in `autoReacquire` per service: broker self-recovers expired tokens headlessly instead of returning 409 INTERACTIVE_AUTH_REQUIRED (see `CLAUDE.md` → Opt-in autoReacquire);
- offline resilience: a connectivity gate (DNS probe of the IdP, 2-failure debounce) suppresses ALL browser auth while offline, serves cached unexpired tokens (`X-Hermes-Offline-Grace` inside the safety margin), returns `503 OFFLINE` + `Retry-After` otherwise, and runs a single staggered recovery pass on reconnect;
- AD load budget: browser-auth attempts capped per `service:scheme` (default 4 acquires/h, 12 validations/h) across all trigger sources, persisted across broker restarts; consumer `/token` rate limit (default 20 req/10s → `429 RATE_LIMITED`). Config keys `connectivity.*`, `adBudget.*`, `consumerRateLimit.*` in `~/.hermes/config.json` — see `docs/AGENTS.md` → "Offline resilience + AD load budget".

The standard lanes are:

1. **Credential lane:** MCPs request provider-neutral credentials by `service`
   and `scheme`.
2. **Failure feedback lane:** MCPs report real downstream API auth failures via
   `/token/:service/:scheme/report-failure` or `hermes_report_auth_failure`.
3. **Recovery lane:** Hermes marks credentials suspect, coalesces recovery,
   refreshes or headlessly reacquires as the provider allows, and returns exact
   remediation when Conditional Access needs human action.
4. **Proof lane:** Hermes records storage, freshness, provider validation,
   propagation, and authenticated downstream MCP proof without secrets.

## Install

```bash
git clone <repo> ~/Projects/hermes
cd ~/Projects/hermes
pnpm install
pnpm -r build
```

See `docs/first-time-setup.md` for the initialization walkthrough.

## Runtime diagnostics

Use `hermes status` for the primary operator view. It prints auth health across
stored tokens, lifecycle metadata, proof tier (`stored`, `fresh`,
`provider_validated`, `propagated`, `mcp_validated`), propagation state, lifecycle
errors, exact next safe action, redacted evidence, and optional organization
runbook metadata when present. Use `hermes timeline` for the latest redacted
proof/propagation/lifecycle events from the lifecycle state. Both commands
support `--json`.

Optional advisory organization metadata can be stored in
`~/.hermes/org-runbooks.json`:

```json
{
  "version": 1,
  "entries": [
    {
      "service": "servicenow",
      "scheme": "session",
      "team": "IT Service Management",
      "confluenceRunbookUrl": "https://example.atlassian.net/wiki/spaces/ITSM/pages/456/ServiceNow+Hermes+Runbook",
      "serviceNowGroup": "ServiceNow Platform",
      "safeProbe": {
        "description": "Read-only current user/session probe",
        "toolName": "servicenow_get_current_user",
        "endpointClass": "identity-read"
      },
      "conditionalAccessNotes": [
        "browser-acquired session; status checks never trigger live acquire"
      ],
      "vpn": "Requires corporate network or VPN for instance access",
      "lastVerifiedAt": "2026-04-10T13:00:00.000Z"
    }
  ]
}
```

For Atlassian use, the `atlassian-api-key` Confluence integration can help
operators discover current runbooks and owner pages. Hermes stores only
non-secret links, page IDs, owner/team/group names, safe-probe descriptions,
Conditional Access notes, VPN/network requirements, integration notes, and a
`lastVerifiedAt` timestamp. This data is advisory, redacted in operator output,
and must not contain API keys, passwords, tokens, cookies, or credentials.

Use `hermes doctor` to classify the localhost listener, launchd job, HTTP
health, stateless MCP `tools/list`, token health, startup logs, and
`NODE_EXTRA_CA_CERTS` LaunchAgent configuration. It only reports orphan recovery
steps by default; `hermes doctor --recover-orphan` is required before it sends
SIGTERM to a specific classified orphan PID.

`hermes doctor --install-launchd` installs or updates the macOS LaunchAgent
plist and writes `NODE_EXTRA_CA_CERTS` when it is available in the environment
or passed via `--node-extra-ca-certs <path>`.

## REST MCP adoption kit

Generated and existing REST API MCPs should use `@hermes/client` instead of
hand-rolled SSO retry logic:

```ts
import { HermesClient } from '@hermes/client';

const hermes = new HermesClient({
  brokerUrl: process.env.HERMES_BROKER_URL ?? 'http://127.0.0.1:9876',
  clientToken: process.env.HERMES_CLIENT_TOKEN!,
});

const response = await hermes.withHermesAuthRetry(
  'servicenow',
  'session',
  (credential) => fetch(`${instanceUrl}/api/now/table/incident`, {
    headers: { Accept: 'application/json', ...credential.headers },
  }),
  { backend: 'servicenow-mcp', tool: 'incident.list', endpointClass: 'table-api' },
);
```

`getCredential()` returns provider-neutral headers for Bearer, Cookie, and API
token credentials. `classifyAuthResponse()` treats HTTP 401/403 plus
`invalid_session` and `csrf_failed` codes as auth failures.
`withHermesAuthRetry()` reports those failures to
`/token/:service/:scheme/report-failure`, retries at most once with a fresh
credential when Hermes says it is safe, and surfaces exact `hermes acquire ...`
remediation when human action is required. It never opens a browser.

Recommended service/scheme mappings:

| Target MCP | Hermes shape |
| --- | --- |
| ServiceNow Table/API MCPs | `servicenow` / `session` (`Cookie`) |
| Atlassian Jira or Confluence MCPs | site service / `session` or `oauth` (`Cookie` or `Bearer`) |
| MS365 Graph MCPs | `ms365` / `graph` (`Bearer`) |
| Azure DevOps REST MCPs | ado service / `oauth` or `api-token` (`Bearer` or API token header override) |
| Generic cookie-session apps | app service / `session` (`Cookie`) |

## Architecture

See `docs/superpowers/specs/2026-04-09-hermes-design.md`.
