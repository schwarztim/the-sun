# ADR-0002: Agent Self-Service Token Refresh

**Date:** 2026-05-28
**Status:** Proposed
**Context:** Field failure during az-teams `teams_message` call

## Problem

When an agent tries to send a Teams message and the MS365 Graph token is stale (HTTP 401, `TokenCreatedWithOutdatedPolicies`), the current error path is:

```
Graph said: Hermes broker ms365/graph requires operator reauth (retry after Ns).
Remediation: run: hermes acquire ms365
```

The agent cannot execute `hermes acquire ms365` -- it's a CLI command that may require interactive browser SSO. The agent punts to the operator, the operator has to context-switch, run the command, then tell the agent to retry. This defeats the purpose of Hermes as an auth broker.

## Observed Failure Chain (2026-05-21)

1. User asks agent to message "Shell Shrader" on Teams
2. Agent calls `teams_message(to="Shell.Shrader@example.com")`
3. chatsvc lookup fails (email not in recent 200 chats)
4. Fallback: Graph `/users/<email>` lookup for MRI resolution
5. Graph returns 401 -- token stale
6. Hermes reports "requires operator reauth"
7. Agent is stuck -- no tool to refresh, no way to proceed
8. Operator must manually run `hermes acquire ms365`

## What Hermes Should Do

### Option A: Automatic headless refresh (preferred)

When an MCP reports a 401 via the failure feedback lane, Hermes should:
1. Attempt headless token refresh automatically (refresh_token grant)
2. If refresh_token is expired, attempt headless re-acquisition (cached credentials + headless browser)
3. Only if both fail (e.g., MFA challenge, Conditional Access change), return structured remediation to the agent

This aligns with the existing Recovery Lane contract: "Hermes marks credentials suspect, coalesces refresh/reacquire, avoids auth storms, and returns exact remediation for human-action cases."

### Option B: Expose `hermes_acquire` as an MCP tool

Add an MCP tool the agent can call:
```
hermes_acquire(service="ms365", scheme="graph")
```

This triggers the same logic as `hermes acquire ms365` but through the MCP interface. If headless acquisition succeeds, the agent retries immediately. If it fails (needs interactive SSO), the tool returns structured remediation the agent can surface.

### Option C: Both A and B

Auto-refresh on 401 (Option A) as the happy path. Expose `hermes_acquire` (Option B) as an explicit fallback when the agent wants to proactively refresh before hitting a 401.

## Secondary Finding: Email Resolution

`Shell.Shrader@example.com` was not found via chatsvc user lookup. This may be:
- Wrong email format (could be `@corp.example.com`, `SShrader@example.com`, etc.)
- OR the chatsvc lookup genuinely cannot resolve this email without Graph

With a working Graph token, the `teams_construct_chat_id` fallback would resolve the email to an MRI and construct the chatId deterministically. So fixing the token refresh issue likely fixes this too.

## Recommendation

Option C. The reliability contract already promises recovery-lane healing -- this is just implementing it for the Graph token case. The MCP tool is cheap insurance for cases where the agent wants to pre-warm credentials.
