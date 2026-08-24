# MCP Gateway

MCP Gateway is a local-first gateway for large Model Context Protocol fleets. It lets Claude Code, Copilot CLI, and other MCP clients connect to one stable Streamable HTTP endpoint while the gateway manages many backend MCP servers behind a compact mux surface.

The main goal is context control: clients can list only a few gateway tools, search backend tools on demand, and call the selected backend tool without loading hundreds of backend tool schemas into every session.

## What it provides

- **One client endpoint**: `http://127.0.0.1:3100/mcp` for Streamable HTTP clients, plus legacy `/sse` support.
- **Facade mux mode**: expose only gateway tools instead of every backend tool schema, resource list, or prompt list.
- **Dynamic backend ingestion**: read the MCPU-generated ToolHive config and connect reachable HTTP MCP backends automatically.
- **Read-only fleet inventory**: inspect ToolHive runconfigs, status files, generated MCPU exposure, optional Docker state, and endpoint health.
- **Stable reload behavior**: reload config or fleet entries without dropping the whole gateway.
- **Backend reconnects**: health monitor reconnects failed backends and re-registers tools.
- **Resilience harness**: simulates 500 fleet entries to keep context surface and degradation behavior honest.

## Gateway mux tools

When `gateway.tool_exposure` is set to `mux`, clients see only:

| Tool | Purpose |
|---|---|
| `gateway_search_tools` | Search connected backend tools without exposing every backend schema in `tools/list`; empty inventory dumps are refused. |
| `gateway_describe_tool` | Lazily describe one selected backend tool schema. |
| `gateway_call_tool` | Call a namespaced backend tool returned by search. |
| `gateway_fetch_artifact` | Fetch a capped page from an oversized result artifact. |
| `gateway_backend_status` | Show backend connection state, tool counts, and quarantined stdio fleet entries. |
| `gateway_fleet_inventory` | Inspect the read-only ToolHive fleet catalog. |
| `gateway_mcpu_config` | Generate a read-only MCPU-compatible fleet config report. |
| `gateway_reconnect_backend` | Trigger a reconnect attempt on a named backend. |

## Quick start

```bash
npm install
npm run build
npm run start:fleet
```

The included `config.fleet.yaml` starts a local mux gateway on `127.0.0.1:3100` and auto-ingests HTTP MCP backends from `~/.config/mcpu/config.generated.json`.

## Configuration

```yaml
gateway:
  port: 3100
  host: "127.0.0.1"
  name: "mcp-gateway"
  tool_exposure: "mux"
  streamable_http_stateless: true
  streamable_http_json_response: true

fleet:
  enabled: true
  toolhive:
    mcpu_generated_config: "~/.config/mcpu/config.generated.json"
    docker_ps: true
    endpoint_probe: false
    auto_ingest: true
    ingest_namespace_prefix: ""
    ingest_skip:
      - mcpu
      - inspector

backends: {}
```

`gateway.tool_exposure` modes:

| Mode | Behavior |
|---|---|
| `mux` | Expose only the compact gateway tools. Recommended for large fleets. |
| `namespaced` | Expose all backend tools directly with namespace prefixes. |
| `both` | Expose gateway tools and all backend tools. |

In `mux` mode, backend resources and prompts are also hidden from client list calls. Large responses are capped by default, stored as in-memory artifacts, and can be paged explicitly with `gateway_fetch_artifact`. Streamable HTTP is stateless by default so stale client session IDs after a gateway restart do not keep producing `Session not found`.

Static backends can still be configured under `backends` using `http` (Streamable HTTP) or `sse` transports. `stdio` is not a representable backend transport: any `transport: stdio` entry is stripped at config load with a console error naming the backend (reason `stdio-unsupported`, remedy: re-front it behind streamable-http) and the gateway boots on without it, while `command:`-style entries found during fleet ingestion are quarantined into a `quarantined[]` list surfaced by `gateway_backend_status` instead of being connected.

## Safety gating

Every dispatch path is gated: the safety gate fires for both `gateway_call_tool` and direct namespaced tool calls. `safety.enforce` defaults to `"blocking"` in the code and in both shipped config files (`config.yaml` and `config.fleet.yaml`); set it to `"advisory"` per-config for staged rollouts. Tool classification is graduated:

- **Manifested tools** use the class declared in their manifest (`manifests/*.json`). A manifest that labels a write-verb-named tool as READ is rejected at load — the backend falls back to fail-closed UNCLASSIFIED gating and an error is logged.
- **Unmanifested tools** whose names contain a write-class verb (the built-in list plus extensions such as `execute`, `run`, `deploy`, `merge`, `revoke`, `kill`, and other mutating verbs) are classified WRITE and gated.
- **Unmanifested verb-less tools** are UNCLASSIFIED and gated. The call is denied in blocking mode; boot logs a per-backend report of unclassified tools — use it to draft the missing manifests. During manifest burn-down, individual backends can be temporarily exempted via `safety.unmanifested_read_allowlist: [backendName, ...]`.

A `write_guard: true` field in a manifest is enforced: the tool is gated regardless of its safety class.

A blocking deny returns `{ confirmationRequired: true, tool, safetyClass, source, reason, redactedArguments }`. Deny responses do not include remediation hints — this is intentional. Direct-path denials include `remedy: "invoke via gateway_call_tool with confirmed:true"` solely to identify the confirmable mux path, not as a bypass recipe.

## Security configuration

This section documents all security-relevant configuration knobs. Keep it as the single reference for the safety, auth, and decision-log subsystems.

### Enforcement mode

```yaml
safety:
  enforce: "blocking"   # code default and both shipped configs; use "advisory" for staged rollouts
```

`blocking` — write-class and unclassified calls without `confirmed: true` are denied. `advisory` — the call proceeds with a warning log. Both shipped configs (`config.yaml`, `config.fleet.yaml`) set `enforce: "blocking"` explicitly.

### Decision log

```yaml
safety:
  decision_log:
    enabled: true       # true by default; writes are fail-closed (dispatch denied on write error)
    path: "~/.mcp-gateway/decisions.jsonl"
```

When enabled (the default), each dispatch decision writes one JSONL line: `{ ts, path, tool, backend, safetyClass, source, decision, enforce, user }`. The `user` field carries the authenticated caller identity. **Writes are fail-closed**: if the audit record for a gated dispatch cannot be written, the dispatch is denied.

### Classification and manifest validation

- Unmanifested tools that do not match the write-verb heuristic are `UNCLASSIFIED` and **gated** (not silently promoted to READ). Use `safety.unmanifested_read_allowlist` to exempt specific backends by name during manifest burn-down.
- A manifest entry that labels a write-verb-named tool as READ is rejected at load; the backend falls back to fail-closed UNCLASSIFIED gating.
- `write_guard: true` in a manifest entry is enforced: the tool is gated regardless of its declared safety class.

### JWT authentication (Entra ID)

```yaml
auth:
  mode: none            # "none" = loopback/single-operator mode (default)
  # mode: entra         # enables Entra ID JWT validation
  # tenant_id: "<your-tenant-id>"
  # audience:  "<your-app-client-id>"
  # issuer:    "https://login.microsoftonline.com/<tenant_id>/v2.0"   # optional override
```

When `mode: entra`, every request to `/mcp`, `/sse`, and `/messages` must carry a valid `Authorization: Bearer <jwt>`. The gateway validates the token signature (via Entra JWKS), issuer, audience, and expiry; requests without a valid token receive `401`. The authenticated identity (`oid`/`upn`) is recorded in every decision-log entry. Sessions are bound to the identity that created them; a `/messages` request presenting a session ID created by a different identity receives `403`.

`mode: none` (the default) disables all JWT validation — appropriate for loopback, single-operator deployments.

### Admin token

The admin API (`/admin/*`) requires loopback access by default. If the gateway is exposed beyond loopback, set `MCP_GATEWAY_ADMIN_TOKEN`. The comparison is timing-safe (SHA-256 digest via `crypto.timingSafeEqual`).

## Client setup

Point Claude Code, Copilot CLI, or any Streamable HTTP MCP client at:

```text
http://127.0.0.1:3100/mcp
```

Keep existing MCPU/ToolHive registrations in place until the gateway has proven stable in your environment. The gateway is designed to run alongside them first, then replace direct fleet access when you are ready.

## Admin API

Admin routes are restricted to loopback clients by default. If the gateway is exposed beyond loopback, set `MCP_GATEWAY_ADMIN_TOKEN` and pass `Authorization: Bearer <token>`.

| Endpoint | Method | Description |
|---|---|---|
| `/admin/status` | GET | Gateway status and tool counts. |
| `/admin/backends` | GET | List all backends with status. |
| `/admin/reload/:name` | POST | Restart a specific backend. |
| `/admin/enable/:name` | POST | Enable a disabled backend. |
| `/admin/disable/:name` | POST | Disable a backend. |
| `/admin/reload-config` | POST | Reload the gateway config file. |
| `/admin/fleet/summary` | GET | ToolHive fleet counts, health summary, and source paths. |
| `/admin/fleet/inventory` | GET | Full read-only ToolHive fleet catalog; add `?probe=true` for TCP endpoint checks. |
| `/admin/fleet/mcpu-config` | GET | Read-only MCPU-compatible config report; add `?configOnly=true` for only the config object. |
| `/admin/fleet/backends` | GET | List auto-ingested fleet backends. |
| `/admin/fleet/reload` | POST | Re-read generated MCPU config and refresh fleet backends. |

## Validation

```bash
npm run build         # tsc — must be clean
npm run test:unit     # vitest --project unit — fast unit suite
npm run test:e2e      # vitest --project e2e — wire-level invariant suite (real gateway + real backends)
npm test              # both projects
npm run harness       # resilience harness (simulated fleet)
npm run audit:contracts  # offline manifest contract audit
```

`npm run test:e2e` boots a real gateway against real in-process MCP backends. Without `GW_E2E_FULL`, it runs the three always-on tests: boot-and-serve, mux round-trip, and direct round-trip. The five Phase-0 safety invariants — WRITE-gate denial on both paths, stdio quarantine via config, stdio quarantine via fleet ingestion, and UNCLASSIFIED gating — require `GW_E2E_FULL=1` and run in CI. All tests in the suite are fully self-contained (in-process, loopback only; no Docker or external services required).

The harness verifies:

- 500 simulated fleet entries remain represented.
- Degraded entries stay discoverable with reasons.
- The client-facing mux surface remains fewer than 10 facade tools.
- Changed backend ports are resolved from the latest fleet state.

## Repository READMEs

- `README.github.md` contains the public/open-source publication notes.
- `README.stash.md` contains internal Stash deployment notes and live fleet wiring guidance.

## License

MIT