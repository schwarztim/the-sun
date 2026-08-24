# HAR-Based Authentication for Generated MCPs

## Overview

thesun now generates MCPs with **multi-method authentication support** by default. Every generated MCP can authenticate using:

1. **API Keys** (fastest, when available)
2. **OAuth 2.0** (when supported by the service)
3. **HAR Files** (for webapps without APIs)
4. **Interactive Playwright Login** (automatic browser auth with Firefox)

This ensures MCPs work even when official APIs aren't available or require complex web-based authentication.

## Playwright + Firefox Token Capture

thesun uses **Playwright MCP with `--browser firefox`** for browser-based token extraction. This provides:

| Capability               | Method                     | What You Get                                   |
| ------------------------ | -------------------------- | ---------------------------------------------- |
| **localStorage**         | `page.evaluate()`          | Access tokens, refresh tokens, user data       |
| **sessionStorage**       | `page.evaluate()`          | Session tokens, temporary auth data            |
| **Cookies**              | `page.context().cookies()` | All cookies including HttpOnly session cookies |
| **Network Traffic**      | `browser_network_requests` | Authorization headers, API keys in flight      |
| **Request Interception** | `page.route()`             | Capture tokens as they're sent                 |

**Why Firefox?** No Google dependency. Full privacy. Same capabilities.

## Why HAR-Based Auth?

Many services either:

- Don't have public APIs
- Require complex OAuth flows
- Need human verification (CAPTCHA, 2FA)
- Are web-only applications (Trello, Notion, etc.)

HAR-based authentication solves this by:

1. Capturing your authenticated browser session
2. Extracting auth tokens/cookies from the network traffic
3. Reusing those credentials for API calls

## How It Works

### Architecture

```
┌──────────────────────────────────────────────────┐
│            MCP Authentication Flow                │
└──────────────────────────────────────────────────┘
                      │
        ┌─────────────┼─────────────┐
        │             │             │
    API Key      HAR File    Interactive
    (fastest)   (extracted)    (Playwright)
        │             │             │
        └─────────────┼─────────────┘
                      │
              ┌───────▼────────┐
              │  Auth Headers  │
              │  Ready to Use  │
              └────────────────┘
```

### Generated Code

Every MCP now includes:

```typescript
// Auto-generated authentication with fallback
export async function getAuthHeaders(): Promise<Record<string, string>> {
  // Try 1: API key (if TOOL_API_KEY set)
  // Try 2: HAR file (if TOOL_HAR_FILE_PATH set)
  // Try 3: Interactive login (if TOOL_LOGIN_URL set)
  // Fail: Throw error with setup guide
}
```

## Usage Examples

### Example 1: Trello (No Public API)

```bash
# .env
TRELLO_HAR_FILE_PATH=./auth/trello.har
```

**Steps:**

1. Open Firefox DevTools (F12) → Network tab
2. Log into Trello
3. Right-click → "Save all as HAR with content"
4. Save to `./auth/trello.har`
5. MCP extracts your auth automatically

### Example 2: Notion (OAuth + HAR Fallback)

```bash
# .env
# Primary: OAuth
NOTION_CLIENT_ID=your-client-id
NOTION_CLIENT_SECRET=your-secret

# Fallback: HAR (if OAuth fails)
NOTION_HAR_FILE_PATH=./auth/notion.har
```

### Example 3: Interactive Login

```bash
# .env
SERVICENOW_LOGIN_URL=https://yourcompany.service-now.com/login
SERVICENOW_ALLOW_INTERACTIVE_LOGIN=true
```

When the MCP starts:

1. Playwright opens browser
2. You complete login (including 2FA)
3. MCP captures and caches credentials
4. Future requests use cached auth

## Integration with thesun-har MCP

thesun leverages the existing `thesun-har` MCP for HAR processing:

```typescript
// Internal: MCP uses thesun-har for extraction
const auth = await harAuthManager.getAuth();
// Returns: { type: 'bearer', token: '...' }
// or:      { type: 'cookie', cookies: [...] }
```

This means:

- No manual HAR parsing needed
- Automatic token/cookie extraction
- Validation and testing built-in

## Environment Variables

Generated MCPs include comprehensive .env.example files:

```bash
# === AUTHENTICATION OPTIONS ===

# Option 1: API Key (Recommended)
TOOL_API_KEY=

# Option 2: OAuth 2.0
TOOL_CLIENT_ID=
TOOL_CLIENT_SECRET=

# Option 3: HAR File
TOOL_HAR_FILE_PATH=./auth/tool.har
TOOL_LOGIN_URL=https://login.tool.com
TOOL_ALLOW_INTERACTIVE_LOGIN=true

# Auto-populated after extraction
TOOL_EXTRACTED_TOKEN=
TOOL_EXTRACTED_COOKIES=
```

## Security Considerations

### Safe Practices

✅ **DO:**

- Store HAR files in `./auth/` directory
- Add `./auth/*.har` to `.gitignore`
- Use environment-specific credentials (dev/staging/prod)
- Rotate extracted credentials regularly
- Set file permissions: `chmod 600 auth/*.har`

❌ **DON'T:**

- Commit HAR files to git (they contain sensitive tokens)
- Share HAR files (they're equivalent to passwords)
- Use production credentials in development
- Store HAR files in publicly accessible locations

### Auto-Cleanup

Generated MCPs include security features:

- HAR files are read-only operations
- Extracted credentials cached in memory only
- No HAR content logged (privacy)
- Automatic token expiration detection

## Generated MCP Features

Every thesun-generated MCP now includes:

### 1. Multi-Method Auth Support

```typescript
// Automatically tries all configured methods
const headers = await getAuthHeaders();
```

### 2. Initialization Check

```typescript
// Validates auth on startup, fails fast
await initializeAuth();
```

### 3. Helpful Error Messages

```
Authentication failed. Please provide one of:
  - TRELLO_API_KEY (if you have an API token)
  - TRELLO_HAR_FILE_PATH (captured from browser)
  - TRELLO_LOGIN_URL (for interactive login)

See .env.example for setup guide.
```

### 4. Comprehensive Documentation

- README with auth setup guide
- .env.example with all options
- Inline code comments

## Updating Existing MCPs

To add HAR auth support to existing thesun-generated MCPs:

1. Regenerate the MCP:

   ```bash
   /sun <tool-name>
   ```

2. The new version will include HAR support

3. Update your `.env`:
   ```bash
   cp .env .env.backup
   cp .env.example .env
   # Restore your existing credentials
   ```

## Playwright Integration

For interactive login, thesun uses Playwright:

```bash
# Enable interactive login
TOOL_LOGIN_URL=https://login.example.com
TOOL_ALLOW_INTERACTIVE_LOGIN=true
```

On first run:

1. Browser window opens
2. Navigate to login page
3. Complete authentication (including 2FA, CAPTCHA)
4. MCP captures session
5. Credentials cached for future use

## Best Practices

### 1. Prefer API Keys When Available

```bash
# Fastest and most reliable
TOOL_API_KEY=your-api-key
```

### 2. Use HAR for Web-Only Services

```bash
# When no API exists
TOOL_HAR_FILE_PATH=./auth/tool.har
```

### 3. Enable Interactive Login for Complex Auth

```bash
# When service has 2FA, CAPTCHA, or SSO
TOOL_LOGIN_URL=https://login.tool.com
TOOL_ALLOW_INTERACTIVE_LOGIN=true
```

### 4. Combine Methods for Reliability

```bash
# Primary: API key
TOOL_API_KEY=your-key

# Fallback: HAR (if API key revoked)
TOOL_HAR_FILE_PATH=./auth/tool.har
```

## Troubleshooting

### "HAR file not found"

```bash
# Check file path is correct
ls -la ./auth/
# Ensure file has correct name
mv ~/Downloads/login.tool.com.har ./auth/tool.har
```

### "No authentication data found in HAR"

- Ensure you were logged in when capturing
- Try capturing after a fresh login
- Check the Network tab showed authenticated requests

### "Extracted token expired"

```bash
# Re-capture HAR file
# or use interactive login to refresh
TOOL_ALLOW_INTERACTIVE_LOGIN=true
```

### "Interactive login failed"

- Check TOOL_LOGIN_URL is correct
- Ensure Playwright is installed: `npm install -D @playwright/test`
- Check browser can access the login page

## Future Enhancements

Planned features:

- [ ] Automatic token refresh from HAR
- [ ] Multi-user credential management
- [ ] HAR encryption at rest
- [ ] Browser profile reuse (cookies)
- [ ] SSO/SAML support via Playwright

## Examples in the Wild

Generated MCPs with HAR auth support:

- **Trello** - Board/card management (no public API)
- **Notion** - Database queries (OAuth + HAR fallback)
- **ServiceNow** - Incident management (SSO via interactive)
- **Jira Cloud** - Issue tracking (API key + HAR fallback)
- **Linear** - Project management (OAuth + HAR fallback)

## Summary

Every MCP generated by thesun now supports multiple authentication methods out of the box:

| Method      | Speed  | Reliability | Setup Complexity | Use Case               |
| ----------- | ------ | ----------- | ---------------- | ---------------------- |
| API Key     | ⚡⚡⚡ | ⭐⭐⭐      | Easy             | Official APIs          |
| OAuth 2.0   | ⚡⚡   | ⭐⭐⭐      | Medium           | Enterprise services    |
| HAR File    | ⚡⚡   | ⭐⭐        | Easy             | Web-only apps          |
| Interactive | ⚡     | ⭐⭐        | Medium           | Complex auth (2FA/SSO) |

This ensures your MCPs work regardless of how the service handles authentication.
