# MCP Gateway - GitHub Notes

This is the public/open-source publication README for `schwarztim/mcp-gateway`.

## Purpose

MCP Gateway is for people who run many MCP servers and do not want every Claude Code or Copilot CLI session to load every backend tool schema. It exposes a small gateway tool surface, then discovers and calls backend tools on demand.

## Recommended public setup

```bash
git clone https://github.com/schwarztim/mcp-gateway.git
cd mcp-gateway
npm install
npm run build
npm run start:fleet
```

Use `config.fleet.yaml` for local ToolHive/MCPU fleet mode, or create your own `config.yaml` for static backends.

## Public-safe defaults

- Bind to `127.0.0.1` unless you have an explicit reason to expose the gateway.
- Use `gateway.tool_exposure: "mux"` for large fleets.
- Keep Streamable HTTP stateless for facade-only use so restarted gateways do not strand clients on stale in-memory session IDs.
- Treat `gateway_fetch_artifact` as an explicit paging tool for oversized results; do not use fleet inventory or search calls as raw schema dumps.
- Set `MCP_GATEWAY_ADMIN_TOKEN` before exposing admin routes outside localhost.
- Keep MCPU or your existing MCP routing registered until this gateway is proven stable in your environment.

## Useful commands

```bash
npm run build -- --pretty false
npm run harness
curl http://127.0.0.1:3100/admin/status
```

## Current scope

The gateway is focused on local-first fleet routing, context preservation, and resilience around ToolHive/MCPU-generated HTTP backends. In mux mode it behaves as a facade: clients see a small gateway tool surface, backend resources/prompts are not listed, empty search does not dump inventory, and large responses are capped with artifact references. Repair actions are intentionally conservative: fleet inspection and ingestion are read-only and do not mutate Docker or ToolHive state.
