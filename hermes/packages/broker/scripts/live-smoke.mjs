#!/usr/bin/env node

const baseUrl = (process.env.HERMES_BROKER_URL ?? 'http://127.0.0.1:9876').replace(/\/+$/, '');
const timeoutMs = Number.parseInt(process.env.HERMES_SMOKE_TIMEOUT_MS ?? '5000', 10);

async function fetchJson(url, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text.slice(0, 500) };
    }
    return { response, body };
  } finally {
    clearTimeout(timeout);
  }
}

async function mcp(method, params, id) {
  const { response, body } = await fetchJson(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  if (!response.ok) {
    throw new Error(`${method} returned HTTP ${response.status}: ${JSON.stringify(body).slice(0, 500)}`);
  }
  return body;
}

function parseToolContent(body) {
  const text = body?.result?.content?.[0]?.text;
  if (typeof text !== 'string') throw new Error(`missing MCP tool content: ${JSON.stringify(body).slice(0, 500)}`);
  return JSON.parse(text);
}

function summarizeHealth(health) {
  return {
    status: health.status ?? health.operator?.status ?? 'unknown',
    tokenCount: Array.isArray(health.tokens) ? health.tokens.length : 0,
    degradedCount: Array.isArray(health.tokens)
      ? health.tokens.filter((token) => token.status && token.status !== 'healthy').length
      : 0,
    operator: health.operator ? {
      status: health.operator.status,
      summary: health.operator.summary,
      nextAction: health.operator.nextAction,
    } : undefined,
  };
}

try {
  const health = await fetchJson(`${baseUrl}/health`);
  if (!health.response.ok || health.body.status !== 'ok') {
    throw new Error(`/health failed: HTTP ${health.response.status} ${JSON.stringify(health.body).slice(0, 500)}`);
  }

  const list = await mcp('tools/list', {}, 1);
  const tools = list?.result?.tools ?? [];
  if (!Array.isArray(tools) || !tools.some((tool) => tool.name === 'hermes_status')) {
    throw new Error(`stateless tools/list did not include hermes_status: ${JSON.stringify(list).slice(0, 500)}`);
  }

  const summary = parseToolContent(await mcp('tools/call', { name: 'hermes_auth_summary', arguments: {} }, 2));
  if (!summary || typeof summary.status !== 'string') {
    throw new Error(`hermes_auth_summary shape invalid: ${JSON.stringify(summary).slice(0, 500)}`);
  }

  const tokenHealth = parseToolContent(await mcp('tools/call', { name: 'hermes_token_health', arguments: {} }, 3));
  if (!tokenHealth || !Array.isArray(tokenHealth.tokens)) {
    throw new Error(`hermes_token_health shape invalid: ${JSON.stringify(tokenHealth).slice(0, 500)}`);
  }

  console.log(JSON.stringify({
    status: 'ok',
    broker: baseUrl,
    health: health.body.status,
    tools: tools.map((tool) => tool.name).filter((name) => typeof name === 'string').sort(),
    authSummary: {
      status: summary.status,
      summary: summary.summary,
      nextAction: summary.nextAction,
      degradedCount: Array.isArray(summary.degradedServices) ? summary.degradedServices.length : 0,
    },
    tokenHealth: summarizeHealth(tokenHealth),
  }, null, 2));
} catch (err) {
  console.error(JSON.stringify({
    status: 'failed',
    broker: baseUrl,
    error: err instanceof Error ? err.message : String(err),
  }, null, 2));
  process.exitCode = 1;
}
