# Hermes -- Claude project context

Hermes is a credential broker and headless SSO control plane for REST API MCPs.
It exists so agents and containerized MCP servers do not each need custom
Conditional Access, OAuth refresh, ServiceNow cookie, or browser-profile
workarounds.

## Product Goal

Authentication should become a solved background service for SSO-heavy MCPs:
agents request credentials, use APIs, report auth failures, and Hermes heals or
returns precise operator remediation. Raw 401 loops, silent expired sessions,
foreground browser popups, and ad-hoc credential deletion are failures of the
contract.

## Current Reliability Contract

Hermes has four standard lanes:

1. **Credential lane:** MCPs request credentials by `service` and `scheme`.
2. **Failure feedback lane:** MCPs report real downstream 401/403/auth failures
   through HTTP or `hermes_report_auth_failure`.
3. **Recovery lane:** Hermes marks credentials suspect, coalesces
   refresh/reacquire, avoids auth storms, and returns exact remediation for
   human-action cases.
4. **Proof lane:** Hermes records storage, freshness, provider validation,
   propagation, and authenticated downstream MCP proof without secrets.

## Structural Constraints

### Browser Engine — patchright, not vanilla playwright

SSO providers that drive a real browser (provider-az-teams, provider-cookie-session, provider-servicenow, provider-dynatrace, provider-akamai-wsa, provider-crowdstrike, and the shared `auth-core` browser helpers) import `patchright` instead of `playwright`. Patchright is a stealth-patched, API-compatible drop-in for Playwright (`chromium`/`firefox`/`webkit`, same `Browser`/`BrowserContext`/`Page` types) — it evades bot-detection fingerprinting on Chromium-based flows with no code changes beyond the import path. Firefox/webkit are exposed by patchright but are not stealth-patched (Chromium-only per upstream). Do not reintroduce a `playwright` dependency in these packages; add new browser-driven providers against `patchright` from the start.

### Headless-Only Authentication
Hermes NEVER opens a foreground browser. All authentication flows are headless. If a credential cannot be acquired headlessly (e.g., expired SPA refresh token requiring interactive re-auth), Hermes returns a structured error with remediation steps — it does not pop a UI.

This is enforced at multiple layers:
- **browser-auth.ts**: Hard assertion rejects `headless: false` at the browser launch boundary
- **broker.ts**: The `ctx()` method forces `headless: true` regardless of the `interactive` parameter
- **Provider schemas**: All providers use `z.literal(true)` for the headless field — schema validation rejects false
- **Registry**: Service registration rejects configs with `headless: false`
- **HTTP server**: The `/token` endpoint rejects `interactive` and `headless` query params with 400
- **Acquire CLI**: Never passes `interactive: true` to the broker

## Recovery Procedure — MCP Transport Stuck

The Hermes broker binds `127.0.0.1:9876` and exposes the MCP endpoint at `/mcp`. The most common failure mode is an orphaned `node ...broker/dist/cli.js start` process (re-parented to PID 1 after a parent shell exits) that outlives a `pnpm build` and continues serving an old `dist/`. The orphan owns the listening socket, so launchd's `KeepAlive` cannot bring up the new build until the orphan releases port 9876.

### When to use

- HTTP 500 from `POST /mcp` whose body contains: `Already connected to a transport. Call close() before connecting to a new transport, or use a separate Protocol instance per connection.`
- Initialize returns 200 but a follow-up `tools/list` with the issued `mcp-session-id` returns 400 `missing or invalid session`. Post-patch this should not occur; if it does, treat it as a regression signal and follow this runbook before suspecting a new bug.
- Hermes uptime exceeds typical operating window (for example, >24h) with intermittent MCP failures and no recent code change to explain them.

### Steps

1. Identify the listener on port 9876:
   ```
   lsof -nP -iTCP:9876 -sTCP:LISTEN | awk 'NR>1 {print $2}'
   ```
2. Inspect the process. `PPID 1` alone is NOT the orphan signature on macOS — launchd IS PID 1, so the healthy launchd-managed broker also shows `PPID 1`. The disambiguator is `launchctl list`: if the listening PID appears next to the `com.hermes.broker` label, it is the legitimate managed process; if the PID is missing from launchd (or a second listener exists), that is the orphan:
   ```
   ps -o pid,ppid,etime,command -p <PID>
   launchctl list | grep com.hermes.broker   # PID match = managed, not orphan
   ```
3. Tail recent logs to capture pre-restart context:
   ```
   tail -n 200 ~/.hermes/logs/hermes-stderr.log
   tail -n 200 ~/.hermes/broker.log
   ```
4. SIGTERM the orphan and confirm exit. Escalate to `kill -KILL` only if SIGTERM is ignored for >10s:
   ```
   kill -TERM <PID>
   for i in 1 2 3 4 5; do kill -0 <PID> 2>/dev/null && sleep 2 || break; done
   lsof -nP -iTCP:9876 -sTCP:LISTEN  # expect empty
   ```
5. Reload via launchd:
   - First time after a reboot or unload: `launchctl load ~/Library/LaunchAgents/com.hermes.broker.plist`
   - Already loaded (normal case): `launchctl kickstart -k gui/$(id -u)/com.hermes.broker`
6. Confirm the new PID is listening:
   ```
   sleep 3 && lsof -nP -iTCP:9876 -sTCP:LISTEN
   ```
7. Confirm log readiness — `~/.hermes/logs/hermes-stderr.log` should show `http listening` and `mcp endpoint ready at /mcp`:
   ```
   tail -n 20 ~/.hermes/logs/hermes-stderr.log
   ```
8. Real MCP probe (initialize, then re-issue with the returned session id):
   ```
   curl -sS -i -X POST http://127.0.0.1:9876/mcp \
     -H 'Content-Type: application/json' \
     -H 'Accept: application/json, text/event-stream' \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"hermes-recovery-probe","version":"0.0.1"}}}'
   ```
   Expect HTTP 200 and an `mcp-session-id` response header. Reissue with `-H 'mcp-session-id: <SID>'` and method `tools/list` — expect HTTP 200 and a populated tools array.

### Do NOT

- Do NOT rotate SSO credentials during recovery. Transport-stuck failures are not credential failures.
- Do NOT delete or re-pair Hermes state under `~/.hermes/`.
- Do NOT relax the headless-only constraint. See Structural Constraints — Headless-Only Authentication.
- Do NOT bypass the launchd plist by re-running `node dist/cli.js start` manually unless explicitly debugging. That path drops `NODE_EXTRA_CA_CERTS` and recreates the orphan-with-old-`dist/` failure mode that produced the original incident.

### Advisory — plist environment gap

The launchd plist at `~/Library/LaunchAgents/com.hermes.broker.plist` (Label `com.hermes.broker`, `KeepAlive=true`, `RunAtLoad=true`) does not currently set `NODE_EXTRA_CA_CERTS`. The previously running orphan inherited it from a manual launch environment. If outbound TLS via the corporate Netskope CA bundle is required, add an `EnvironmentVariables` block to the plist:

```
<key>EnvironmentVariables</key>
<dict>
  <key>NODE_EXTRA_CA_CERTS</key>
  <string>/Users/&lt;user&gt;/.claude/combined-ca-certs.pem</string>
</dict>
```

Track this as a follow-up. Do not block recovery on it — Netskope TLS errors after a clean launchd restart are the diagnostic signal that this gap was hit.

## Restart Without Rotation

- Start operator triage with `hermes status` (or MCP `hermes_auth_summary`). It
  is the one-command auth surface: healthy/degraded services, proof tier,
  propagation state, lifecycle errors, exact next action, and redacted evidence.
  Use `hermes timeline` (or MCP `hermes_auth_timeline`) for recent lifecycle
  proof/propagation events. These commands are read-only and must not rotate or
  delete credentials.
- Restart is the first lever; credential rotation is the last. A "broker is broken" symptom should always route through the Recovery Procedure above before any token or pairing change is considered.
- Tokens stored under `~/.hermes/credentials/` are owned by the auth-core refresh loop. If a token is genuinely expired (for example `AADSTS70000` invalid_grant from MS365), the broker surfaces `INTERACTIVE_AUTH_REQUIRED` (HTTP 409 from `/token`); the fix is `hermes acquire <service>`, not deleting the credential file.
- Pairing files (anything under `~/.hermes/` other than `logs/` and `credentials/`) are not touched by recovery. Restart preserves all client pairings and provider registrations.
- The `hermes_token_health` MCP tool surfaces token age and status (`healthy | expiring | expired | no-refresh-token`); call it before suspecting a transport bug. A `healthy` reading combined with `POST /mcp` 500s strongly indicates the orphan-listener pattern, not a credential issue.
- `503 OFFLINE` (body `code: "OFFLINE"`) means the broker has no network path to the IdP (VPN down, Wi-Fi off) — it is NOT a credential issue and NOT the same as `503 REFRESH_IN_PROGRESS` (broker busy / AD budget). While offline the broker suppresses all browser auth, serves cached unexpired tokens (header `X-Hermes-Offline-Grace: true` when inside the safety margin), and recovers automatically on reconnect. Honor `Retry-After`; do not rotate, do not loop. `429 RATE_LIMITED` means the consumer is hammering `/token` — cache tokens client-side. See `docs/AGENTS.md` → error decoder + "Offline resilience + AD load budget" for config keys (`connectivity.*`, `adBudget.*`, `consumerRateLimit.*`).

## AI Guidance — az-teams / Teams Authentication

- Use Hermes for Teams auth. AI sessions and MCP containers should request `az-teams` tokens through Hermes (`scheme=teams` is accepted and normalized to `teams-bearer`).
- Do **not** install Playwright or browser dependencies inside az-teams MCP containers. The container intentionally delegates auth to host Hermes.
- Do **not** run `auth.py` from arbitrary working directories. Hermes invokes `auth.py browser_teams` or `browser_files` from `$AZ_TEAMS_PROJECT_DIR` (fallback `~/Projects/unified-m365-mcp-server/`) as the safe last resort.
- If Hermes reports that host auth.py or Conditional Access needs human help, perform exactly the operator action in that error, then retry the Hermes force-refresh/token request. Do not chain ad-hoc browser installs or token rewrites.

## Opt-in autoReacquire

Services can opt in to automatic re-acquisition of expired tokens by setting `autoReacquire: true` in `~/.hermes/services.json`. When enabled, the broker runs `provider.acquire()` instead of returning `409 INTERACTIVE_AUTH_REQUIRED` on token expiry — transparently, without operator action.

**services.json example:**
```json
{
  "version": 1,
  "services": [
    {
      "name": "az-teams",
      "providerName": "az-teams",
      "schemes": ["teams-bearer", "skype"],
      "autoReacquire": true,
      ...
    }
  ]
}
```

**Fail-loud semantics** — two conditions still surface `INTERACTIVE_AUTH_REQUIRED` to the caller:

1. **Conditional Access wall** — if the refresh itself raises a CA challenge (device cert, MFA prompt, policy blocks headless), `autoReacquire` is skipped and the operator-action remediation is returned unchanged. CA challenges genuinely need operator presence.
2. **Bounded-retry** — if 2 consecutive auto-reacquires fail within a 10-minute window, further attempts are suppressed for the rest of that window. This prevents IdP storming when vault credentials are stale. The suppression is per `(service, scheme)`, so `az-teams:skype` and `az-teams:teams-bearer` are tracked independently.

`autoReacquire` defaults to `false`. No existing service behavior changes unless the flag is explicitly set. Reference: commit chain `PROJ-1107` (13c956d → bbc271e → 25819d9).

## Isaac vault — where SSO creds actually live

SSO credentials are stored in the **Isaac vault** at `~/.claude/secrets.vault`, not in Hermes itself. Entry keys: `sso-email`, `sso-password` (also `sso-pass`), `sso-totp` (TOTP seed, generate codes at use time). Hermes' browser-auth flows pick these up automatically via the vault library's master-key chain: `SECRETS_KEY` env → `~/.claude/master.key` file → macOS keychain (service `claude-secrets-vault`).

- **Do not** suggest `security add-generic-password -s sso-*` to populate creds — they're already in the vault
- **Do not** add per-MCP credential storage — go through Hermes
- **Manual lookup** (diagnostic only): `python3 ~/Projects/node-vault-mcp/services/secrets.py get sso-email`

## Configuration env var contract

Hermes providers that shell out to companion projects (Python `auth.py`, helper scripts) follow **env var first, hardcoded fallback second**:

| Env var                    | Default fallback                                            | Used for                                              |
| -------------------------- | ----------------------------------------------------------- | ----------------------------------------------------- |
| `AZ_TEAMS_PROJECT_DIR`     | `~/Projects/unified-m365-mcp-server/` (consolidated as of 2026-05-22) | Where `auth.py` and its venv live                     |
| `AZ_TEAMS_PYTHON`          | `<project_dir>/.venv/bin/python` or `python3`               | Python interpreter for the shell-out                  |
| `AZ_TEAMS_AUTH_PY`         | `<project_dir>/auth.py`                                     | Path to the auth.py module                            |
| `HERMES_BROKER_URL`        | `http://127.0.0.1:9876`                                     | Where consumers find the broker                       |
| `HERMES_CLIENT_TOKEN`      | (required — no default)                                     | Bearer token for `/token` endpoint                    |
| `NODE_EXTRA_CA_CERTS`      | (unset — set via plist or shell)                            | Corporate CA bundle for Netskope-inspected TLS         |

If you need to change a provider's shell-out target, **set the env var**. Do not edit the hardcoded fallback unless you're consolidating the canonical location for the whole workspace (see commit `8c01b4d` for the precedent).

## Anti-patterns AI agents commonly attempt

These are real workarounds AI agents have tried in this codebase. Every one of them has been a regression. **Do not attempt them.**

- **Adding `headless: false` "temporarily" to bypass a guard.** Six structural enforcement layers exist (see Structural Constraints — Headless-Only Authentication). They're load-bearing. If you find them removed, restore them.
- **Reaching around Hermes to do SSO yourself** (writing your own MSAL/Playwright/curl SSO flow). The point of Hermes is that this is solved once. Extend Hermes via a new scheme; do not duplicate it. See `docs/AGENTS.md` → Adding a new SSO scheme.
- **Suggesting `security add-generic-password ...` for SSO creds.** They're already in the Isaac vault (see above).
- **Deleting `~/.hermes/credentials/` for a "fresh start".** The right command is `hermes acquire <service>`. Deleting files breaks proof-lane lineage and forces every consumer to re-pair.
- **Importing `_underscore_prefixed_helpers` from another module.** Internal API. Promote to a public name first (see `az-teams-helper@4c25d18`).
- **Implementing before verifying** (writing a refactor based on "likely" claims about a downstream API). Capture a HAR or decode a real JWT first. Build on confirmed data, not hypotheses.
- **Rotating credentials when transport is stuck.** `POST /mcp` 500s and "Session not found" gateway errors are transport issues, not credential issues. Use the Recovery Procedure above; never rotate SSO creds to fix transport.

## See also

- `docs/AGENTS.md` — comprehensive agent-onboarding guide (consumer pattern, error decoder, recovery paths, how to add a new SSO scheme)
- `packages/README.md` — workspace map (which package does what)
- `README.md` — install + REST MCP adoption kit + service/scheme mapping table
