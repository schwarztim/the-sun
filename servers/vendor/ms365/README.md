# ms365-mcp (vendored default)

thesun's shipped-default Microsoft 365 server: Teams, Mail, Calendar, and OneDrive
Files via Microsoft Graph. Vendors the open-source
[`@softeria/ms-365-mcp-server`](https://github.com/Softeria/ms-365-mcp-server)
(MIT license), pinned to an exact version in `package.json` for reproducibility.

## Why this one

It ships with its own built-in multi-tenant Azure AD app registration, so there
is **no pre-shared secret to configure** — you sign in with your own Microsoft
account via a normal device-code prompt, the same way `az login --use-device-code`
or `gh auth login` work. No admin consent, no client ID/secret to obtain, no
Playwright, no corporate SSO broker involved.

Transport is `streamable-http` only (thesun's absolute rule — never stdio,
never SSE). This package's HTTP mode natively serves `/mcp` via the official
MCP SDK's `StreamableHTTPServerTransport`.

## Setup (one-time)

```bash
cd servers/vendor/ms365
npm install                      # pulls the pinned @softeria/ms-365-mcp-server

# One-time login - prints a device code + a microsoft.com/devicelogin URL.
# Open that URL in any browser, enter the code, sign in with MFA as usual.
node node_modules/@softeria/ms-365-mcp-server/dist/index.js --login --org-mode
```

That's it. The token is cached by MSAL in your OS credential store (Keychain
on macOS) and auto-refreshes. There is nothing to type into thesun, no
password or TOTP ever touches this server or the fleet.

## Running it

Started automatically by fleetd via the `ms365-mcp` block in
`../../../fleet/default-manifest.toml`. To run it standalone for testing:

```bash
npm start                        # listens on :42030 by default
curl -X POST http://localhost:42030/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
```

A successful response includes `"serverInfo":{"name":"Microsoft365MCP",...}`.

### Why no bearer token is required here

The package's HTTP mode defaults to a stateless, multi-user OAuth 2.1 proxy
(every request must carry its own Graph bearer token, negotiated by the MCP
client). That model is built for a shared, multi-tenant deployment. thesun's
use case is one operator's own machine, so `default-manifest.toml` sets
`MS365_MCP_TRUST_PROXY_AUTH=true`, which skips that per-request bearer check
and falls back to the token from the one-time device-code login above. This
is safe specifically because the server binds to loopback and is reached only
by the local fleet/gateway — never exposed off-box.

## Caveat: Teams chat vs. Teams channels

- **Teams channels, Mail, Calendar, and OneDrive Files work everywhere** — no
  tenant-specific restrictions.
- **Teams *chat* (1:1 and group DMs)** may be blocked on tenants that restrict
  delegated `Chat.*` consent (this is a common enterprise tenant policy). If
  your organization blocks it, Teams channel messaging still works through
  this server; 1:1/group chat requires a separate workaround (an
  organization-specific `unified-m365-mcp-server` / az-teams style path can
  solve that case, but is not part of this vendored default, it trades
  zero-setup for a password+TOTP requirement).

## Updating the pinned version

Edit the exact version string in `package.json`, then `rm -rf node_modules
package-lock.json && npm install` and re-verify with the `curl` check above
before shipping.
