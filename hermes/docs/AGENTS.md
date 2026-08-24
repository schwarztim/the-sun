# Hermes for AI agents

If you're an AI agent (Claude, Copilot, or another LLM-driven tool) about to do work that touches authentication, **read this first**. It exists because agents have repeatedly tried to "fix" Hermes by bypassing it, and every one of those workarounds has been a regression. This doc tells you what Hermes is, what to do when you need a token, what to do when auth fails, and the specific things you must not attempt.

If you have 30 seconds: jump to [Anti-patterns](#anti-patterns) — they're the most common failures.

## 30-second orientation

Hermes is a **host-local credential broker** that runs at `http://127.0.0.1:9876`. Every MCP server that needs to call a corporate REST API (ServiceNow, Akamai, Dynatrace, Teams, Outlook, etc.) goes through Hermes to get a fresh token. Hermes owns:

- Headless SSO browser flows for refresh + re-acquire
- Per-service credential storage (`~/.hermes/credentials/`)
- Cooldown / refresh-storm protection
- Failure-feedback routing (consumers report 401/403, Hermes marks suspect)
- Proof-of-propagation through ToolHive secrets to consumer containers

What Hermes is **not**: a general auth library you call from your code, an interactive browser opener, or a place to stash arbitrary secrets. It is the canonical answer for "give me a current token for `<service>:<scheme>` and tell me what to do if it expired."

The only invocation pattern that's allowed is **request → use → report failure**. Everything else is an anti-pattern.

## Consuming a token (the only correct path)

### From a TypeScript MCP server

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

`withHermesAuthRetry`:
- Calls `/token/<service>/<scheme>` to get a credential
- Runs your fetch
- If the response is 401/403/`invalid_session`/`csrf_failed`, reports the failure back to Hermes via `/token/<service>/<scheme>/report-failure`
- Retries at most once with a fresh credential when Hermes says it's safe
- Surfaces exact `hermes acquire <service>` remediation when human action is required

### From a Python MCP server

```python
from auth import hermes_get_token   # public name, from az-teams/unified-m365 auth.py

token = hermes_get_token("az-teams", "teams-bearer")
headers = {"Authorization": f"Bearer {token}"}
```

The public name is `hermes_get_token`. `_hermes_get_token` (underscore-prefixed) is the internal variant kept for legacy callers; external modules import the public name.

### Service / scheme mapping

| Target MCP                      | Hermes shape                            |
| ------------------------------- | --------------------------------------- |
| ServiceNow Table/API            | `servicenow` / `session` (`Cookie`)     |
| Atlassian Jira / Confluence     | site / `session` or `oauth`             |
| MS365 Graph                     | `ms365` / `graph` (`Bearer`)            |
| Teams chatsvc                   | `az-teams` / `skype` (`Skype`)          |
| Teams Bearer                    | `az-teams` / `teams-bearer` (`Bearer`)  |
| Outlook Search (substrate)      | `az-teams` / `substrate` (`Bearer`)     |
| Files via Graph                 | `az-teams` / `files` (`Bearer`)         |
| Azure DevOps REST               | ado / `oauth` or `api-token`            |
| Generic cookie-session app      | app / `session` (`Cookie`)              |

If your target isn't in this table, see [Adding a new SSO scheme](#adding-a-new-sso-scheme) below.

## When auth fails — refresh, don't rotate

Hermes returns structured error codes. **Match the code to the action**:

| Code / response                       | What it means                                                                 | What you do                                                                  |
| ------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 200 with credential                   | Use it.                                                                       | Make the downstream API call.                                                |
| 401/403 from downstream               | The token Hermes gave you was rejected by the target.                         | Report via `/token/<svc>/<scheme>/report-failure`; retry once on Hermes go.  |
| 409 `ACQUIRE_REQUIRED`                | No cached token; provider must acquire fresh (headless browser flow runs).    | Either wait for the in-flight acquire or call `hermes acquire <service>`.    |
| 409 `INTERACTIVE_AUTH_REQUIRED`       | Refresh token genuinely expired or Conditional Access needs human action.     | Stop. Ask operator to run `hermes acquire <service>`. Do NOT loop.           |
| `reauth cooldown active`              | Recent acquire failed; broker is backing off so we don't storm the IdP.       | Respect the cooldown window. Exponential backoff or wait for window expiry.  |
| 503 `REFRESH_IN_PROGRESS`             | Broker is busy re-acquiring this credential in the background (or the AD acquire budget is exhausted). | Retry after `retryAfterMs` (header `Retry-After`). No operator action.       |
| 503 `OFFLINE`                         | Broker is up but has NO network path to the IdP (VPN down, Wi-Fi off). Distinct from `REFRESH_IN_PROGRESS` by body `code`. | Back off for `retryAfterMs` (≥30s). The broker rechecks connectivity and recovers automatically. Do NOT loop, do NOT rotate. |
| 200 + header `X-Hermes-Offline-Grace: true` | Cached token served while offline, inside the refresh safety margin — it may expire mid-call. | Use it, but expect a possible downstream 401; report it normally.            |
| 429 `RATE_LIMITED`                    | You exceeded the per-`service:scheme` /token rate limit (default 20 req/10s). | Honor `Retry-After`; cache tokens client-side instead of re-fetching per request. |
| `Session not found` (gateway error)   | The MCP gateway's session ID for that backend went stale (container respawned). | Force the gateway to re-init that backend; do NOT restart Hermes broker.     |

**Critical:** in every case the answer involves Hermes. The answer is never "delete the credential file" or "rotate the secret" unless the operator explicitly says so.

### Offline resilience + AD load budget (broker config)

Defaults in `~/.hermes/config.json` (all optional — shown values apply when absent):

| Key | Default | Meaning |
| --- | --- | --- |
| `validationPolicy` | `lazy` | `lazy` = expiry math only; `eager` = provider.validate at cacheAge ≥ 60s; `paranoid` = validate every request |
| `refreshSafetyMarginSec` | `300` | Tokens within this margin of expiry are refreshed proactively |
| `connectivity.probeHost` | `login.microsoftonline.com` | DNS probe target (the IdP itself) |
| `connectivity.probeUrl` | _(unset)_ | Optional HTTP HEAD probe after DNS success (captive-portal mitigation) |
| `connectivity.probeTtlMs` | `30000` | Probe result cache while online |
| `connectivity.offlineRecheckMs` | `30000` | Recheck cadence while offline (+0-5s jitter) |
| `connectivity.failuresToOffline` | `2` | Consecutive probe failures before going offline |
| `connectivity.serveCachedWhileOffline` | `true` | Serve cached unexpired tokens while offline |
| `adBudget.maxAcquiresPerHour` | `4` | Browser-auth attempts per hour per `service:scheme`, ALL trigger sources |
| `adBudget.maxValidationsPerHour` | `12` | provider.validate calls per hour per `service:scheme` |
| `consumerRateLimit.maxTokenRequestsPer10s` | `20` | /token requests per `service:scheme` per 10s before 429 |

While offline the broker makes **zero** IdP/browser interactions across every
trigger path (consumer /token, refresh scheduler, 30-min health monitor,
autoReacquire). On reconnect a single coalesced recovery pass re-schedules
overdue refreshes, staggered + jittered, still subject to the AD budget. The
rate limiter is keyed per `service:scheme` (single shared client token today),
so one hot consumer can starve a polite one for a 10s window — known tradeoff.

### Browser lifecycle (env vars)

Every headless browser auth runs through `withManagedBrowser` (`@hermes/auth-core`):
bounded wall-clock lifetime, host-wide concurrency cap, registry + periodic reaper,
SIGKILL escalation when `browser.close()` hangs, kill-all on broker shutdown, and
startup reaping of orphans recorded by dead prior broker incarnations
(`~/.hermes/run/browsers.json`).

| Env var | Default | Meaning |
| --- | --- | --- |
| `HERMES_MAX_CONCURRENT_BROWSERS` | `2` | Host-wide concurrent browser-auth cap; excess acquires queue (120s bound) |
| `HERMES_BROWSER_MAX_LIFETIME_MS` | `180000` | Hard wall-clock limit per browser auth; on expiry the browser is force-closed then SIGKILLed |
| `HERMES_RUN_DIR` | `~/.hermes/run` | Location of the browser run-file used for orphan reaping |
| `HERMES_ORPHAN_REAP` | _(unset)_ | Set `0` to skip startup orphan reaping |

### autoReacquire — when INTERACTIVE_AUTH_REQUIRED heals itself

Services configured with `autoReacquire: true` in `~/.hermes/services.json` can self-recover from token expiry without operator involvement. When the broker would normally return `409 INTERACTIVE_AUTH_REQUIRED` (e.g., expired refresh token), it instead runs `provider.acquire()` headlessly and returns the fresh token in the original response. From a caller's perspective, it looks like a slow cache-miss — no 409, no manual `hermes acquire`.

**What you should expect when consuming an autoReacquire-enabled service:**
- No more `INTERACTIVE_AUTH_REQUIRED` for routine token expiry on opted-in services
- Occasional slow first-call (~5–15s) while acquire runs headlessly
- `INTERACTIVE_AUTH_REQUIRED` is still returned when a CA challenge fires (device cert, MFA wall) or when 2 consecutive auto-reacquires fail within 10 minutes (bounded-retry safety)
- Per-`(service, scheme)` independence: a `skype` scheme failure does not suppress `teams-bearer` auto-reacquire

**Opting in** is done in `~/.hermes/services.json` — see `CLAUDE.md` → Opt-in autoReacquire for the config snippet. Default is `false`; no existing service changes unless the flag is explicitly set.

## The Isaac vault — where SSO creds actually live

This trips up almost every agent.

SSO credentials (`sso-email`, `sso-password` / `sso-pass`, `sso-totp`) are stored in **the Isaac vault** at `~/.claude/secrets.vault`. Hermes' browser-auth flows pick them up automatically via the vault library's master-key resolution chain: env (`SECRETS_KEY`) → file (`~/.claude/master.key`) → macOS keychain.

**You do not need to and should not:**
- Suggest `security add-generic-password -s sso-email ...` — the creds are already there
- Manually wire keychain entries — the vault handles all of this
- Bypass the vault to read from `~/.hermes/credentials/` directly

**To resolve a vault entry yourself** (e.g. from a diagnostic script):

```bash
# Python:
python3 ~/Projects/node-vault-mcp/services/secrets.py get sso-email

# Node:
node -e "const { VaultStore } = require('node-vault-mcp'); const v = new VaultStore(); v.get('sso-email').then(console.log)"
```

The `sso-totp` entry is a SEED, not a current code. Generate a 6-digit code at use time with `pyotp` or `@hermes/auth-core`'s `generateTotp(secret)`.

## Provider env var contract

Several Hermes providers shell out to companion projects (Python `auth.py`, helper scripts). The contract is **env var first, hardcoded fallback second**:

| Env var                      | Default fallback                                  | Used for                                              |
| ---------------------------- | ------------------------------------------------- | ----------------------------------------------------- |
| `AZ_TEAMS_PROJECT_DIR`       | `~/Projects/unified-m365-mcp-server`              | Where `auth.py` and the venv live                     |
| `AZ_TEAMS_PYTHON`            | `<AZ_TEAMS_PROJECT_DIR>/.venv/bin/python` or `python3` | Python interpreter for the shell-out                  |
| `AZ_TEAMS_AUTH_PY`           | `<AZ_TEAMS_PROJECT_DIR>/auth.py`                  | Path to the auth.py module                            |
| `HERMES_BROKER_URL`          | `http://127.0.0.1:9876`                           | Where consumers find the broker                       |
| `HERMES_CLIENT_TOKEN`        | (no default — required)                           | Bearer token for `/token` endpoint                    |
| `NODE_EXTRA_CA_CERTS`        | (unset)                                           | Corporate CA bundle for Netskope-inspected TLS         |
| `SECRETS_KEY`                | (unset; falls through to file → keychain)         | Isaac vault master key (base64 32-byte)               |

**If you change a provider's shell-out target, set the env var. Don't edit the hardcoded fallback in code unless you're consolidating the canonical location across the workspace** (which is what commit `8c01b4d` did).

## Anti-patterns

These are real workarounds AI agents have attempted in this codebase that all caused regressions. **Do not attempt any of them.**

### ❌ Adding `headless: false` to provider configs

Hermes enforces headless-only at six structural layers (see `CLAUDE.md` → Structural Constraints). Any "temporary bypass for one-time visible acquire" is a contract violation. If you genuinely need to see the browser, set up a separate dev environment outside Hermes — do not patch the production broker.

The structural enforcement is:
1. `browser-auth.ts` `_runOAuth2AuthCode` and `_runAuth` throw `HEADLESS_REQUIRED` on `params.headless=false`
2. `broker.ts` `ctx()` forces `headless: true` regardless of `interactive`
3. Provider schemas use `z.literal(true).default(true)` for the `headless` field
4. `registry.ts` `registerService` rejects configs with `headless: false`
5. `registry.ts` load-time auto-corrects `headless: false` to true with a warning
6. The `/token` HTTP endpoint rejects `interactive` and `headless` query params with 400

If you find any of these guards removed in a working tree, **restore them** — they're load-bearing.

### ❌ Reaching around Hermes to do SSO yourself

Don't write your own MSAL flow, Playwright login, or curl-based SSO. The point of Hermes is that this is solved once. If your scheme isn't supported, see [Adding a new SSO scheme](#adding-a-new-sso-scheme) — extend Hermes, don't duplicate it.

### ❌ `security add-generic-password ...` for SSO creds

They're already in the Isaac vault. See [vault section](#the-isaac-vault--where-sso-creds-actually-live). Suggesting keychain additions is redundant and creates drift.

### ❌ Deleting `~/.hermes/credentials/` for a "fresh start"

Don't. The right command is `hermes acquire <service>`, which re-mints the credential without touching pairing files or breaking concurrent consumers. Deleting files breaks proof-lane lineage and forces every consumer to re-pair.

### ❌ Importing `_underscore_prefixed_helpers` from another module

Internal API. If you need it externally, promote it to a public name (see how `hermes_get_token = _hermes_get_token` was added in `az-teams-helper@4c25d18`) rather than importing the underscored version.

### ❌ Implementing before verifying

If you're about to add a new provider scheme, capture a HAR / decode a real JWT first to confirm the scope, audience, and appid. Don't ship a refactor based on "likely" claims — implementations built on unverified hypotheses get reworked.

### ❌ Rotating credentials when transport is stuck

`POST /mcp` 500 errors and "Session not found" gateway errors are **transport** problems, not credential problems. The fix is in `CLAUDE.md` → Recovery Procedure (broker restart) or — for the gateway side — forcing the gateway to re-init the affected backend. Never rotate or delete an SSO credential to fix a transport issue.

## Recovery paths

| Symptom                                                            | Real cause                                          | Action                                                                       |
| ------------------------------------------------------------------ | --------------------------------------------------- | ---------------------------------------------------------------------------- |
| `/mcp` returns 500 "Already connected to a transport"              | Orphaned broker process holding port 9876           | `CLAUDE.md` → Recovery Procedure (kill orphan, launchctl kickstart)          |
| `/mcp` `tools/list` returns 400 "missing or invalid session"       | Same as above                                       | Same recovery procedure                                                      |
| Gateway returns "Session not found" for a specific backend         | Gateway's cached session ID for that backend went stale (container respawned) | Force the gateway to re-init that backend; not a broker bug                  |
| `hermes acquire <svc>` fails with `browserType.launch: Executable doesn't exist` | Playwright Firefox binary missing for current playwright version | `npx playwright install firefox` from the repo root, then retry              |
| `hermes acquire <svc>` succeeds but consumer still gets 401        | ToolHive container hasn't picked up the new secret  | Wait a moment (broker auto-restarts dependents), or check `thv list`         |
| `reauth cooldown active` storms                                    | Pre-`6cc57e5` bug — should not recur                | If it does, check whether commit `6cc57e5` is on the running build           |
| `INTERACTIVE_AUTH_REQUIRED` on a service                           | Refresh token genuinely expired                     | Operator runs `hermes acquire <service>` to drive a fresh browser SSO flow   |

## Adding a new SSO scheme

If a downstream API requires a token Hermes doesn't yet produce, add a scheme rather than working around it.

**Reference implementation**: commit `8e59818` added the `substrate` scheme to `provider-az-teams`. Use it as the template. The pattern:

1. **`config.ts`** — add the new scheme name to `CANONICAL_SCHEMES` and the appropriate `SCOPES` entry.
2. **`provider.ts`** —
   - Add the scheme's vault key mapping to `VAULT_MAP` (`{ at: 'xxx_access_token', rt: 'xxx_refresh_token' }`).
   - Add the scheme-specific acquire branch in `_acquireResolved`. If it can be derived from an existing scheme's RT (cross-scope OAuth refresh), use `silentRefresh` like `substrate` does. Otherwise wire the browser-acquire command in `browserAuthCommandForScheme`.
3. **Verify empirically** — before committing, capture a HAR of the real downstream service rejecting the token, decode the JWT to confirm the `aud`/`appid`/`scp` claims, and only then write the scope.
4. **Build + test** — `pnpm --filter @hermes/provider-<name> build && test`.
5. **Commit** with a `PROJ-1107:` prefix (or the relevant issue-tracker ticket) describing the scheme + scopes + which downstream API it serves.

If the scheme requires a browser-acquired token specifically (not refreshable via silent OAuth — e.g., Microsoft's `xms_rp_ipaddr` claim is browser-flow-only), use the two-step pattern from commit `6689579`: read from vault first, then run `auth.py browser_<flow>` + force the exchange, then re-read from vault.

## Push policy

If you're committing in Hermes:

- Atomic commits per concern; descriptive messages
- Prefix with the issue-tracker ticket key (`PROJ-1107:` is the umbrella for current observability + reliability work)
- Do not push without explicit operator authorization (per `~/.claude/CLAUDE.md` git policy)
- `origin/main` is on `github.com/schwarztim/hermes`

## Cross-references

- `CLAUDE.md` — recovery procedures, headless-only enforcement, AZ_TEAMS pointers
- `README.md` — install + runtime diagnostics + REST MCP adoption kit
- `docs/superpowers/specs/2026-04-09-hermes-design.md` — original architecture spec
- `packages/README.md` — workspace map
- The project-scoped `~/.claude/projects/<encoded-repo-path>/memory/` directory — saved memories for future agents (vault pattern, MCP transport rule, etc.)
