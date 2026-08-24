#!/usr/bin/env node
// run.js — convenience launcher for the vendored @softeria/ms-365-mcp-server.
//
// This is what `npm start` runs, and is functionally equivalent to the
// [[server]] block for "ms365-mcp" in ../../../fleet/default-manifest.toml —
// kept here so the server can also be started standalone (outside fleetd) for
// manual testing, e.g. `npm start` then `curl localhost:42030/mcp`.
//
// Env overrides (all optional):
//   MS365_MCP_PORT        - port to listen on (default 42030)
//   MS365_MCP_CLIENT_ID   - custom Azure AD app (default: package's built-in
//                           multi-tenant app - zero setup required)
//   MS365_MCP_TENANT_ID   - custom tenant (default 'common')
//
// One-time login (device code, opens no browser automatically - just prints a
// URL + code to visit yourself):
//   node node_modules/@softeria/ms-365-mcp-server/dist/index.js --login --org-mode

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(
  __dirname,
  'node_modules',
  '@softeria',
  'ms-365-mcp-server',
  'dist',
  'index.js'
);

const port = process.env.MS365_MCP_PORT || '42030';

const args = [entry, '--http', `:${port}`, '--org-mode', '--enable-auth-tools'];

const env = {
  ...process.env,
  // See fleet/default-manifest.toml for why this is safe: single-operator,
  // loopback-only deployment falls back to the locally-cached device-code
  // login instead of requiring a per-request OAuth bearer token.
  MS365_MCP_TRUST_PROXY_AUTH: 'true',
};

const child = spawn(process.execPath, args, { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));
