# thesun docs index

| Doc | What's in it |
|---|---|
| [`INSTALL.md`](INSTALL.md) | Install thesun (dev-checkout build, `thesun install`, per-client wiring, default MCP servers + credentials, reboot guarantee, troubleshooting). Start here. |
| [`ONBOARDING.md`](ONBOARDING.md) | Connecting your own tenant/account to each shipped connector (Microsoft 365, Atlassian, ServiceNow, GitHub): prerequisites, exact config values, the onboarding command, and how to verify it worked. |
| [`PACKAGING.md`](PACKAGING.md) | The release pipeline: how `thesun` builds into one per-OS archive (goreleaser + Node SEA bundling), artifact layout, and `thesun upgrade`. |
| [`SECURITY-MODEL.md`](SECURITY-MODEL.md) | The current two-tier gateway threat model: Tier-A model self-confirm (a speed bump, not a boundary) vs Tier-B out-of-band human approval (un-bypassable), what each defends against, and where the guarantees stop. Start here for security. |
| [`SECURITY-ROADMAP.md`](SECURITY-ROADMAP.md) | The universal-enforcement roadmap (escalation overlay, client hook layer, trust/TTL grants, elicitation). Now SHIPPED; see the banner at its top. |
| [`GATEWAY-CONFIG.md`](GATEWAY-CONFIG.md) | Config reference for the gateway policy knobs an operator edits: escalation tiers (name a production backend, exempt a mis-flagged tool), content-guard, semantic tool search, and per-backend tool visibility/overrides. |
| [`MCP-STORE.md`](MCP-STORE.md) | The MCP Store: the three-repo layout, the two trust tiers, the fail-closed verification chain in `add`, and the consumer + author command reference (`store`, `search`, `add`, `remove`, `update`, `keygen`, `publish`). |
| [`GO-MCP-ONBOARDING.md`](GO-MCP-ONBOARDING.md) | How a generated Go MCP server is onboarded into the fleet and wired for credentials. |
| [`hook-verification-checklist.md`](hook-verification-checklist.md) | Empirical checklist for confirming each AI client's pre-tool-execution hook actually fires in that client's full-auto mode. |
| [`elicitation-verification.md`](elicitation-verification.md) | Manual verification evidence gating default-on elicitation: confirm no client auto-accepts the Tier-B approval dialog in a full-auto mode. |
| [`managed-hooks-hardening.md`](managed-hooks-hardening.md) | Hardening the client hook layer with each client's managed-hooks mode so an autonomous agent cannot remove the policy hook. |

For the current CLI surface, treat `fleet/fleetd/cmd/thesun/main.go`'s `usage()` (or
`thesun --help` against a freshly built binary) as authoritative. `INSTALL.md` covers the
commands an operator needs to install, wire, credential, and remove the stack, but it is a
guide rather than a mirror of `usage()`: subsystem verbs such as `generate`, `verify`,
`approve`, `trust`, `grants`, `gateway`, and `hermes` are documented in their own docs, or
only in `usage()` itself.
