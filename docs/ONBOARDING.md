# Connecting your own tenant

> Every key name on this page is confirmed against the connector's own source in this
> repository. Instance URLs and tenant IDs are configuration and belong in `thesun.toml`.
> Credentials are not: they go into the Hermes vault through `thesun secrets add`, and the
> manifest holds only a `hermescred://` reference to them. Never put a secret in a config
> file, a committed `.env`, or a shell profile.

thesun ships a small set of default MCP servers so a fresh install has something useful to
call immediately, but none of them come pre-pointed at any organization's systems. Every
connector below needs your own account, app registration, or instance URL before it does
anything. This page covers, for each shipped connector: what to have ready before you start,
exactly which values you supply, how to run the onboarding command, and how to confirm it
worked.

General shape, the same for every connector:

1. Obtain the credential (API token, device-code login, or app registration) from the
   service itself.
2. Point the server at your instance, if it's multi-tenant (an instance URL or tenant ID;
   never a secret, and set directly in config rather than the vault).
3. Store the actual secret value via `thesun secrets add <service> <account>`, which prompts
   on stdin so the value never touches a config file, your shell history, or a command-line
   argument.
4. Restart the server so it picks up the new credential, then verify with `thesun doctor` or
   a direct tool call.

## Microsoft 365 (Teams, Mail, Calendar, OneDrive)

**Before you start:** a Microsoft account (personal or work/school) with access to the
Microsoft 365 services you want the agent to use. No admin consent or app registration is
required for the default path, since the vendored server ships its own multi-tenant Azure AD
application.

**Configuration values:**

| Value | What it is | Required? |
|---|---|---|
| Microsoft account | the identity you sign into via device code | yes |
| `MS365_MCP_CLIENT_ID` | only if you register your own Azure AD app instead of using the built-in one | no, advanced use only |
| `MS365_MCP_TENANT_ID` | restrict sign-in to a specific tenant | no, advanced use only |

**Onboarding command:**

```bash
cd servers/vendor/ms365
npm install
node node_modules/@softeria/ms-365-mcp-server/dist/index.js --login --org-mode
```

This prints a device code and a `microsoft.com/devicelogin`-style URL. Open it in any
browser, enter the code, and sign in (MFA included) as you normally would. The resulting
token is cached by MSAL in your OS credential store (Keychain on macOS) and refreshes
automatically; nothing is typed into thesun itself.

**Verify it worked:**

```bash
thesun doctor                 # ms365-mcp should report a healthy auth state
curl -X POST http://localhost:42030/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
```

A successful response includes `"serverInfo":{"name":"Microsoft365MCP",...}`. Full detail,
including the Teams-chat-vs-channels caveat some tenants enforce, lives in
[`../servers/vendor/ms365/README.md`](../servers/vendor/ms365/README.md).

## Atlassian (Jira + Confluence)

**Before you start:** an Atlassian Cloud account and an API token (Atlassian Cloud only;
this path does not cover a self-hosted Data Center instance or SSO-fronted Atlassian).
Generate a token from your Atlassian account's API token settings page.

**Configuration values:**

| Value | What it is | Required? |
|---|---|---|
| Atlassian account email | the email tied to your Atlassian account | yes |
| API token | generated from your Atlassian account settings | yes |
| `ATLASSIAN_BASE_URL` | your `https://<your-site>.atlassian.net` address. There is no default and none is possible, since every Atlassian Cloud site has its own subdomain | yes. The server refuses to start without it, naming this variable |

**Onboarding command:**

```bash
thesun secrets add atlassian basic
```

This prompts for `email:api_token` on stdin (hidden input); the value is stored in the
vault and never appears in a config file, the shell history, or the process list.

**Verify it worked:**

```bash
thesun doctor                  # atlassian-mcp should report a healthy auth state
thesun secrets show atlassian basic   # metadata only: last-updated time, which server(s)
                                       # reference it; the secret value itself is never printed
```

## ServiceNow

**Before you start:** access to a ServiceNow instance and a basic-auth-capable account
(username and password, or an equivalent basic-auth credential your instance accepts).

**Configuration values:**

| Value | What it is | Required? |
|---|---|---|
| `SERVICENOW_INSTANCE_URL` | your instance's base URL, e.g. `https://<your-instance>.service-now.com` | yes; not a secret, set directly in config |
| ServiceNow username | the account thesun authenticates as | yes |
| ServiceNow password / basic-auth credential | the secret half of that account | yes |

**Onboarding command:**

```bash
# 1. Point the server at your instance (edit thesun.toml / the server's [server.env]
#    block, replacing the placeholder instance URL with your own):
#    SERVICENOW_INSTANCE_URL = "https://<your-instance>.service-now.com"

# 2. Store the credential:
thesun secrets add servicenow basic
```

**Verify it worked:**

```bash
thesun doctor                  # servicenow-mcp should report a healthy auth state
```

## GitHub (opt-in)

GitHub is not a shipped default (it needs a personal access token, which doesn't meet the
zero-pre-shared-secret bar thesun applies to its defaults), but it's a one-command add.

**Before you start:** a GitHub personal access token with the scopes you want the agent to
have (read-only repo access at minimum; broader scopes only if you need write/admin tools).

**Configuration values:**

| Value | What it is | Required? |
|---|---|---|
| GitHub personal access token | a fine-grained or classic PAT | yes |

**Onboarding command:**

```bash
brew install github-mcp-server   # official tap: homebrew-core
```

Then merge the `[[server]]` block from
[`../servers/vendor/github/github.default.toml`](../servers/vendor/github/github.default.toml)
into your `thesun.toml`, and store the token:

```bash
thesun secrets add github token
```

That file documents the exact `[server.env]` line the gateway needs to resolve the token at
request time (GitHub's official server takes the token per-request as a bearer header, not
as a spawn-time environment variable, which is why its wiring differs slightly from the
other three connectors above). See
[`../servers/vendor/github/README.md`](../servers/vendor/github/README.md) for the full
rationale.

**Verify it worked:**

```bash
thesun doctor
thesun status                  # github-mcp should show healthy
```

## Power Automate (Microsoft Flow)

**Before you start:** a Microsoft account with Power Automate access. Power Automate has no
Microsoft Graph surface, so this is its own server (`powerautomate-go`, port 42024) with its
own broker service rather than a surface on the Microsoft 365 server above. Coupling them
would mean a tenant that withholds Graph consent also loses Power Automate, even though the
Flow endpoints answer fine.

**Configuration values:**

| Value | What it is | Required? |
|---|---|---|
| `loginHint` | the address you sign in with | yes |
| `passwordKeychainService` / `passwordKeychainAccount` | OS credential-store entry holding your sign-in password | yes |
| `totpKeychainService` / `totpKeychainAccount` | OS credential-store entry holding your MFA seed | only if your tenant enforces TOTP |
| `clientId` | defaults below to the Microsoft-published Azure CLI public client | no, unless your tenant requires your own Entra app |
| `tenant` | `common`, or your tenant ID to restrict sign-in | no |

**Onboarding command:**

```bash
hermes register powerautomate --provider oauth2 --scheme token --config '{
  "loginHint": "you@example.com",
  "tenant": "common",
  "clientId": "04b07795-8ddb-461a-bbee-02f9e1bf7b46",
  "scopes": ["https://service.flow.microsoft.com/.default", "offline_access"],
  "headless": true,
  "passwordKeychainService": "<your-sso-entry>",
  "passwordKeychainAccount": "password",
  "totpKeychainService": "<your-totp-entry>",
  "totpKeychainAccount": "you@example.com",
  "validateUrl": "https://api.flow.microsoft.com/providers/Microsoft.ProcessSimple/environments?api-version=2016-11-01"
}'
```

Restart the broker so it picks the service up; it acquires the token on startup, so no
separate sign-in step is normally needed. If it does not, run `hermes acquire powerautomate`.
The server itself holds no credential: it fetches the bearer from the broker per request and
caches it until shortly before expiry.

**Verify it worked:**

```bash
thesun status                  # powerautomate-go should show healthy
curl -X POST http://127.0.0.1:42024/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"flow_list_environments","arguments":{}}}'
```

A successful response lists your Power Automate environments; each entry's `name` is the
environment ID the other tools take as `env_id`.

**Note on the write tools.** Five of the 17 are Tier-B and need out-of-band human approval
via `thesun approve`: `flow_trigger_flow` and `flow_resubmit_run` run a flow's own actions
for real, `flow_add_owner` and `flow_remove_owner` change who can reach a flow, and
`flow_delete_flow` cannot be undone.

## Adding a connector this page doesn't cover

Every other server thesun can generate or install (`thesun generate`, `thesun add`) follows
the same three-step shape: point it at your instance/tenant via non-secret config, store the
credential with `thesun secrets add <service> <account>`, and confirm with `thesun doctor`.
See [`GO-MCP-ONBOARDING.md`](GO-MCP-ONBOARDING.md) for how a generated server resolves
credentials, and [`GATEWAY-CONFIG.md`](GATEWAY-CONFIG.md) for naming a backend as a
production system so its non-read tools require human approval.
