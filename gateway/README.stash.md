# MCP Gateway - Stash Notes

This README is for an internal Stash/Bitbucket Server mirror. It intentionally avoids environment-specific hostnames, service names, and credentials so the same repository content remains safe to mirror elsewhere.

## Internal purpose

Use this repo as a local MCP fleet gateway that routes ToolHive/MCPU HTTP MCP backends through one stable endpoint for both Claude Code and Copilot CLI.

Recommended internal pattern:

```text
Claude/Copilot
  -> local mcp-gateway /mcp endpoint
  -> compact gateway mux tools
  -> auto-ingested ToolHive/MCPU HTTP MCP backends
```

## Internal live config

Use `config.fleet.yaml` as the starting point:

```yaml
gateway:
  host: "127.0.0.1"
  port: 3100
  tool_exposure: "mux"
  streamable_http_stateless: true
  streamable_http_json_response: true

fleet:
  enabled: true
  toolhive:
    auto_ingest: true
    docker_ps: true
    endpoint_probe: false
```

The gateway reads the generated MCPU config path from `fleet.toolhive.mcpu_generated_config`, defaulting to the current user's MCPU generated config. It connects supported `streamable-http`, `http`, and `sse` entries as backend MCP clients.

## Internal operating notes

- Keep the existing MCPU registration alongside the gateway until the gateway has been stable through Docker/ToolHive restarts.
- Do not enable destructive repair behavior without a separate review. Current fleet ingestion is read-only.
- If binding outside loopback, set `MCP_GATEWAY_ADMIN_TOKEN` and require bearer auth for admin routes.
- Use `/admin/fleet/reload` after ToolHive or MCPU regenerates backend ports.
- Use `/admin/status` to confirm connected backend count and tool totals before testing Claude/Copilot.
- Keep client-facing calls facade-safe: `gateway_search_tools` requires a query/filter, `gateway_backend_status` is summary-first, and large backend responses are capped with `gateway_fetch_artifact` refs.

## Validation before pushing or deploying

```bash
npm run build -- --pretty false
npm run harness
curl http://127.0.0.1:3100/admin/status
```

## Client smoke checks

Claude Code and Copilot CLI should both be able to:

1. call `gateway_backend_status`
2. call `gateway_search_tools`
3. call `gateway_describe_tool` for one returned tool
4. call `gateway_call_tool` for a known safe read-only backend tool

If the backend tool reports an application-level auth/session error, gateway routing is still proven when the payload clearly comes from the target backend.
