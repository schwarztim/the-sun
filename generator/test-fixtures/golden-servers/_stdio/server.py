"""FAIL fixture: protocol-valid MCP server, WRONG transport (stdio).

Everything else about this server is correct -- full stack (curl_cffi
transport, rate limiter, Hermes auth), well-formed tools, starts cleanly,
and speaks valid MCP framing. The single defect is `transport="stdio"`
instead of `"streamable-http"`, which the plan's Locked Direction #1
prohibits (servers must run streamable-http, containerized). This isolates
Conformance Lab Gate 3 ("Transport -- reject stdio") from every other gate:
a Lab that only checked "does the process start and answer initialize" would
wrongly PASS this fixture, because IT DOES answer initialize -- just not
over HTTP.

Expected Lab behavior: attempt to connect via streamable-http to the
configured host:port -> connection refused/no listener (nothing is ever
bound, because stdio never opens a TCP socket) -> FAIL with an explicit
"transport=stdio, expected streamable-http" finding, not a generic
readiness-timeout finding (the two are diagnostically different and the
report should say which one happened).

Verified (2026-07-02): confirmed as a legitimate stdio MCP server via the
Python MCP SDK's `stdio_client` -- initialize + listTools both succeed over
stdio. It is only invalid as a *streamable-http* server, which is what the
Lab and the operator's containerized deployment require.

Run (stdio; no HTTP port is ever opened):
    python server.py
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

# Must run BEFORE importing auth.py -- it reads THESUN_SERVICE/THESUN_AUTH_SCHEME
# at module import time (SERVICE = os.environ.get(...) at auth.py:29-30).
os.environ.setdefault("THESUN_SERVICE", "stdio_fixture")
os.environ.setdefault("THESUN_AUTH_SCHEME", "bearer")

from fastmcp import FastMCP

from auth import get_auth_headers
from http_client import build_http_client
from ratelimit import AdaptiveRateLimiter, request_with_backoff

BASE_URL = os.environ.get("MOCK_API_BASE_URL", "http://127.0.0.1:8790")

mcp = FastMCP(name="stdio-golden")

_client = build_http_client(BASE_URL)
_limiter = AdaptiveRateLimiter(per_second=5, per_minute=120, max_concurrency=4)


@mcp.tool
async def list_items(limit: int = 10) -> dict:
    """List items (bearer-authenticated), same shape as rest-bearer's tools.

    Args:
        limit: Max items to return.
    """
    headers = await get_auth_headers()
    resp = await request_with_backoff(
        _client, "GET", "/items", _limiter, headers=headers, params={"limit": limit}
    )
    if resp.status_code == 401:
        return {"error": "unauthorized", "detail": resp.json()}
    resp.raise_for_status()
    return resp.json()


async def main() -> None:
    try:
        # DEFECT (deliberate): transport="stdio" instead of "streamable-http".
        # No host/port args -- stdio never binds a socket.
        await mcp.run_async(transport="stdio")
    finally:
        await _client.aclose()


if __name__ == "__main__":
    asyncio.run(main())
