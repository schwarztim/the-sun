# Provider Azure Key Vault — Operator Action Guide

## Summary

`@hermes/provider-azure-keyvault` authenticates headlessly against Azure AD using the OAuth2 client_credentials grant (service principal / client secret). It exposes two schemes — `management` (ARM scope) and `vault` (Key Vault data-plane scope) — so downstream MCP servers can request the correct bearer token for either Azure surface. Three operator actions remain before `azure-key-vault-mcp` can successfully authenticate via Hermes: seed the client secret in the macOS keychain, register the service with the broker, and patch the MCP client to pass a scheme instead of the legacy `session` path segment.

---

## Prerequisites

- **Azure AD application (service principal)** with:
  - Tenant ID (GUID)
  - Client (Application) ID (GUID)
  - Client secret (a string value — not a certificate)
  - API permissions, both granted with **admin consent**:
    - `https://management.azure.com/.default` (or `user_impersonation`) — for ARM tokens
    - `https://vault.azure.net/.default` (or `user_impersonation`) — for Key Vault data-plane tokens
  - For Key Vault data-plane access: the SP must also have an RBAC role assignment on each target vault (e.g., **Key Vault Secrets User** for read, **Key Vault Secrets Officer** for write) **or** a legacy access policy entry. RBAC is preferred for new vaults.
- **Subscription ID** (optional GUID; surfaced in the token bundle `extra` field for downstream MCP use).
- **Hermes broker** built from the branch containing `@hermes/provider-azure-keyvault` and the `cli.ts` wiring (`pnpm build` already run, `dist/` is current).

---

## Action 1 — Seed Client Secret in macOS Keychain (REQUIRED, INTERACTIVE)

**Why**: Hermes never reads secrets from process environment at acquire time and never logs them. The provider reads the client secret from the macOS keychain via `readKeychainPassword('hermes-azure-keyvault', 'client-secret')`. The value is consumed in-process and never written to disk or logged.

**Run this in a separate terminal — NOT inside Claude Code** (the `-w` value would appear in the session transcript):

```bash
# -w with no value causes security(1) to prompt interactively.
# Type or paste the secret at the prompt; it will not echo.
security add-generic-password \
  -s 'hermes-azure-keyvault' \
  -a 'client-secret' \
  -w
```

If an entry already exists and you need to replace it, add `-U` to update in place:

```bash
security add-generic-password -U \
  -s 'hermes-azure-keyvault' \
  -a 'client-secret' \
  -w
```

**Verification** (safe to run anywhere — reads metadata only, not the secret value):

```bash
security find-generic-password \
  -s 'hermes-azure-keyvault' \
  -a 'client-secret' >/dev/null \
  && echo 'present' \
  || echo 'MISSING'
```

> **Alternative — skip keychain**: If the secret is already managed elsewhere and you prefer not to use the keychain, you may set `"clientSecret": "<value>"` directly in the `--config` JSON in Action 2. The value will be persisted to `~/.hermes/services.json` (mode 0600). Keychain is strongly recommended because it keeps the plaintext value out of all files Hermes owns.

---

## Action 2 — Register Service with Hermes (NON-INTERACTIVE, ONE-SHOT)

**Why**: The Hermes `ServiceRegistry` persists the binding between the logical service name `azure-key-vault` and the provider `azure-keyvault`. The `scheme` list tells the broker which scopes to advertise on `/token/azure-key-vault/<scheme>`.

**Command** (replace the three GUID placeholders):

```bash
cd ~/Projects/hermes

node packages/broker/dist/cli.js register azure-key-vault \
  --provider azure-keyvault \
  --scheme management vault \
  --config '{
    "tenantId":                       "<TENANT-ID-GUID>",
    "clientId":                       "<CLIENT-ID-GUID>",
    "clientSecretKeychainService":    "hermes-azure-keyvault",
    "clientSecretKeychainAccount":    "client-secret",
    "subscriptionId":                 "<SUBSCRIPTION-ID-GUID-OR-OMIT>"
  }'
```

`subscriptionId` is optional. Omit the key entirely if not needed.

The broker writes this to `~/.hermes/services.json` (mode 0600).

**Restart the broker** so it loads the new registration:

```bash
launchctl kickstart -k gui/$(id -u)/com.hermes.broker
```

If the kickstart leaves an orphaned listener on port 9876, follow the recovery procedure in [CLAUDE.md — "Recovery Procedure — MCP Transport Stuck"](./CLAUDE.md).

---

## Action 3 — Patch azure-key-vault-mcp Client to Use Scheme as Path Segment (REQUIRED)

**Why**: The Hermes HTTP route is `/token/:service/:scheme`. The provider advertises schemes `management` and `vault`; it does not advertise a scheme called `session`. The current akv-mcp auth client at `/tmp/akv-mcp-prep/source/src/auth/client.ts` constructs the URL as:

```
${HERMES_URL}/token/${HERMES_SERVICE}/session
```

This will receive a 404 (no such scheme). The URL must pass the Azure scope name as the scheme segment instead.

**Patch** (`/tmp/akv-mcp-prep/source/src/auth/client.ts`, around line 233):

```diff
-  const url = `${HERMES_URL}/token/${HERMES_SERVICE}/session`;
+  // 'scope' is the AzureScope literal: 'management' | 'vault'
+  const url = `${HERMES_URL}/token/${HERMES_SERVICE}/${scope}`;
```

Also remove the now-resolved TODO comment block immediately above that line (lines 230–232, approximately):

```diff
-  // TODO: When a scope-aware Hermes provider exists for Azure Key Vault,
-  // switch this to pass the scope name as the scheme segment.
-  // The provider will advertise 'management' and 'vault' schemes.
```

After patching, rebuild the akv-mcp container image. (Rebuilding the image is owned by the akv-mcp onboarding job, not this Hermes job — but the patch must land before the MCP probe in that job will succeed.)

---

## Action 4 — Acquire Initial Tokens (Smoke Test)

After Actions 1–3 are complete and the broker has been restarted:

```bash
cd ~/Projects/hermes
node packages/broker/dist/cli.js acquire azure-key-vault
# Expected stdout: "acquired: management, vault"
```

Manual HTTP probe (run in a separate terminal so the bearer token does not enter the Claude Code session transcript):

```bash
TOKEN=$(cat ~/.hermes/client-token)

curl -sf \
  -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:9876/token/azure-key-vault/management \
  >/dev/null && echo 'mgmt OK'

curl -sf \
  -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:9876/token/azure-key-vault/vault \
  >/dev/null && echo 'vault OK'
```

Both lines should print `OK`. A non-200 response or connection-refused means the broker has not restarted with the new registration (re-run the `launchctl kickstart` from Action 2).

---

## Failure Modes & Remediation

| Failure | Likely cause | Remediation |
|---------|-------------|-------------|
| `AADSTS7000215: Invalid client secret provided` | Keychain holds a stale or wrong secret, or the SP has multiple active secrets and the wrong one was stored | Re-run Action 1 (`security add-generic-password -U ...`) with the correct value from Azure Portal → App Registrations → Certificates & Secrets |
| `AADSTS700016: Application not found in directory` | Wrong `tenantId` or `clientId` in the service config | Re-run Action 2 with corrected GUIDs |
| `AADSTS65001: The user or administrator has not consented` | API permissions exist but admin consent has not been granted | In Azure Portal → App Registrations → API permissions → Grant admin consent for Default Directory |
| `403 Forbidden` from Key Vault data plane | SP lacks an RBAC role (or legacy access policy) on the target vault | Assign **Key Vault Secrets User** (read) or **Key Vault Secrets Officer** (read+write) to the SP on each target vault in Azure Portal → Key Vault → Access control (IAM) |
| `INTERACTIVE_AUTH_REQUIRED` (HTTP 409 from `/token`) | Refresh token is absent or invalid (rare for client_credentials — usually indicates the upstream AAD call returned an error that was swallowed as success) | `node packages/broker/dist/cli.js acquire azure-key-vault` to force-refresh |
| `404` on `/token/azure-key-vault/management` or `/vault` | Action 3 patch not applied, or broker not restarted after Action 2 | Apply the patch and rebuild akv-mcp; confirm broker restarted via `launchctl kickstart` |
| Orphaned listener on port 9876 after `kickstart` | Stale `node …broker/dist/cli.js start` process re-parented to PID 1 | Follow [CLAUDE.md — Recovery Procedure — MCP Transport Stuck](./CLAUDE.md) |

---

## Headless-Only Compliance

This provider exclusively uses the OAuth2 `client_credentials` grant — a server-to-server flow with no browser window, redirect URI, or device code. The `headless: z.literal(true)` Zod constraint in the provider config schema is the structural enforcement layer: schema validation rejects any config with `headless: false` before the broker ever attempts an acquire.

See the full headless-only policy in [CLAUDE.md — Structural Constraints](./CLAUDE.md).

---

## Cross-References

- **Provider source**: `packages/provider-azure-keyvault/src/`
- **Provider TODO spec**: `/tmp/akv-mcp-prep/source/docs/HERMES_PROVIDER_TODO.md`
- **Hermes recovery procedure**: [`CLAUDE.md` — "Recovery Procedure — MCP Transport Stuck"](./CLAUDE.md)
- **Broker HTTP route definition**: `packages/broker/src/http-server.ts` (line ~54)
- **Launchd plist / `NODE_EXTRA_CA_CERTS` gap**: documented in `CLAUDE.md` under "Advisory — plist environment gap"; do not modify the plist as part of provider setup
