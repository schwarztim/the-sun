---
name: sun-auth
description: Capture authentication from any webapp. Opens browser, you log in, tokens saved. That's it.
---

# /sun-auth - One-Shot Authentication Capture

Capture authentication tokens from any webapp in under 60 seconds.

## Usage

```
/sun-auth <service> <login-url>
```

**Examples:**

- `/sun-auth servicenow https://mycompany.service-now.com`
- `/sun-auth notion https://notion.so/login`
- `/sun-auth jira https://mycompany.atlassian.net`

## What Happens

1. **Browser opens** (Playwright Firefox)
2. **You log in** (handle CAPTCHA, 2FA, SSO - whatever)
3. **Say "done"** when logged in
4. **Tokens captured** from localStorage, sessionStorage, cookies, network
5. **Browser closes**
6. **Credentials saved** to `~/.thesun/credentials/<service>.env`

## Execution Instructions

When user runs `/sun-auth <service> <url>`:

### Step 1: Open Browser

```
Call: mcp__plugin_playwright_playwright__browser_navigate
Args: { "url": "<login-url>" }
```

### Step 2: Tell User to Log In

```
🔐 Browser opened for <service> authentication.

Log in now. Handle any CAPTCHA, 2FA, or SSO as needed.

Type "done" when you've completed login.
```

**WAIT for user to say "done" before proceeding.**

### Step 3: Capture Everything

After user confirms login, capture ALL auth data:

**localStorage:**

```
Call: mcp__plugin_playwright_playwright__browser_evaluate
Args: {
  "expression": "JSON.stringify(localStorage)"
}
```

**sessionStorage:**

```
Call: mcp__plugin_playwright_playwright__browser_evaluate
Args: {
  "expression": "JSON.stringify(sessionStorage)"
}
```

**Cookies:**

```
Call: mcp__plugin_playwright_playwright__browser_evaluate
Args: {
  "expression": "document.cookie"
}
```

**Network requests (for Authorization headers):**

```
Call: mcp__plugin_playwright_playwright__browser_network_requests
```

### Step 4: Extract Tokens

From the captured data, look for:

- `access_token`, `accessToken`, `token`
- `refresh_token`, `refreshToken`
- `id_token`, `idToken`
- `session`, `sessionId`, `sid`
- `Authorization` headers in network requests
- Any cookies with `session`, `auth`, `token` in the name

### Step 5: Save Credentials

Create directory:

```bash
mkdir -p ~/.thesun/credentials
```

Write to `~/.thesun/credentials/<service>.env`:

```bash
# Auto-captured by /sun-auth on <timestamp>
<SERVICE>_BASE_URL=<base-url-from-login>
<SERVICE>_ACCESS_TOKEN=<extracted-token>
<SERVICE>_REFRESH_TOKEN=<if-found>
<SERVICE>_SESSION_COOKIE=<session-cookies>
<SERVICE>_AUTH_TYPE=<Bearer|Cookie|ApiKey>
<SERVICE>_CAPTURED_AT=<timestamp>
```

Also save full capture for debugging:

```bash
~/.thesun/credentials/<service>.capture.json
```

### Step 6: Close Browser

```
Call: mcp__plugin_playwright_playwright__browser_close
```

### Step 7: Report Success

```
✅ Authentication captured for <service>

Saved to: ~/.thesun/credentials/<service>.env

Tokens found:
- Access Token: ✓ (expires: <if-known>)
- Refresh Token: <✓ or ✗>
- Session Cookie: <✓ or ✗>

To use in MCPs, add to your MCP's env config:
  "env": {
    "<SERVICE>_ACCESS_TOKEN": "<token>"
  }

Or source the env file:
  source ~/.thesun/credentials/<service>.env
```

## For Existing MCPs

After capturing auth, update the MCP config in `~/.claude/user-mcps.json`:

```json
{
  "mcpServers": {
    "<service>": {
      "command": "node",
      "args": ["path/to/mcp"],
      "env": {
        "<SERVICE>_ACCESS_TOKEN": "<captured-token>"
      }
    }
  }
}
```

## Refresh When Expired

When tokens expire, just run again:

```
/sun-auth <service> <login-url>
```

Takes 30 seconds. No fuss.
