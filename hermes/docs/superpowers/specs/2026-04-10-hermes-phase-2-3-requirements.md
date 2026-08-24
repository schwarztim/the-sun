# Hermes Phase 2-3 Requirements

Captured 2026-04-10 from user session. These requirements expand Hermes from a standalone broker into a first-class dependency of the MCP ecosystem.

## R1: thesun integration

When thesun generates an MCP that requires SSO/auth, it must:
- Generate the MCP with Hermes as a declared dependency (peer dep or optional dep)
- Include both paths in the generated auth code:
  - **Docker/ToolHive mode:** Use Hermes HTTP API for tokens (container can't do SSO)
  - **Standalone mode:** MCP handles its own auth directly (Playwright browser, no Hermes needed)
- Runtime detection: if `HERMES_URL` env var is set, use Hermes; otherwise, fall back to built-in auth

## R2: Existing MCP repo updates

All existing MCPs that use SSO/browser auth must be updated:
- Declare Hermes as an optional dependency
- Add dual-mode auth (Hermes when available, standalone when not)
- Update GitHub repos with the changes
- Known MCPs requiring update: ms365, servicenow, crowdstrike, copilot-studio, azure-devops

## R3: Smart Hermes dependency management

When installing an MCP that declares Hermes as a dependency:
- Check if Hermes is already installed and running
- If installed, check version compatibility
- If outdated, update automatically
- If not installed, install it (with user consent)
- Never install a duplicate Hermes instance
- This logic lives in thesun's install/setup flow

## R4: Cross-platform (Windows, Linux, Mac)

Hermes must work on all three platforms:
- **macOS:** keytar -> Keychain, Playwright Firefox, launchd (current)
- **Linux:** keytar -> libsecret/gnome-keyring, Playwright Firefox, systemd user unit
- **Windows:** keytar -> Credential Manager, Playwright Firefox, Task Scheduler
- TOTP/password reading: keychain on macOS, thv secrets or env vars on Linux/Windows
- No macOS-specific code in the hot path (keychain CLI calls must be abstracted)

## R5: Non-Docker standalone mode

MCPs must work without Docker/ToolHive:
- When running as a native Node process (not in a container), the MCP handles its own auth
- Browser automation runs in-process (no Hermes needed)
- TOTP, password from platform-appropriate credential store
- This is the fallback for users who don't use ToolHive

## R6: Audit

After all changes:
- Verify all running MCPs in ToolHive are working
- Verify Hermes token refresh cycle end-to-end
- Verify standalone mode works for at least one MCP
- Verify cross-platform build (at minimum: typecheck + tests on Linux)

## Architecture implications

The key architectural change: every generated MCP needs a **dual-mode auth module**:

```
if (process.env.HERMES_URL) {
  // Container mode: fetch tokens from Hermes
  const hermes = new HermesClient({ brokerUrl: process.env.HERMES_URL, ... });
  token = await hermes.getToken('service', 'scheme');
} else {
  // Standalone mode: do browser auth directly
  token = await localAuth.acquire();
}
```

This means the standalone auth code (browser automation, token refresh, TOTP) must be extracted into a shared library that both Hermes providers AND standalone MCPs can use. The `@hermes/provider-ms365` package already has this code -- it just needs to be usable outside of Hermes too.

Proposed package structure:
- `@hermes/broker` -- the broker (unchanged)
- `@hermes/client` -- client for container MCPs (unchanged)
- `@hermes/auth-core` -- shared auth primitives (browser auth, token refresh, TOTP, keychain) -- **NEW, extracted from provider-ms365**
- `@hermes/provider-ms365` -- broker provider, depends on auth-core
- Each MCP depends on `@hermes/client` (optional) + `@hermes/auth-core` (for standalone mode)
