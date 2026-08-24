"""Golden fixture 3/3: protocol outlier -- GraphQL over a single POST endpoint.

Structurally different from both other golden fixtures: one endpoint
(`POST /graphql`), request shape is `{query, variables}` instead of REST
verbs+paths, and success/failure is signalled in the JSON body (`errors[]`)
rather than purely via HTTP status. auth is API-key (SCHEME=api_key). This
is the plan's Stage-1 "one auth/protocol outlier" fixture.

Uses the full generated-server stack: curl_cffi browser-fingerprinted
transport (http_client.py), multi-window rate limiting (ratelimit.py), and
Hermes dual-mode auth (auth.py) -- copied in verbatim.

Credential resolution happens inside each tool call so the server starts and
answers `initialize`/`listTools` with zero credentials configured
(Conformance Lab Gate 6).

Enrichment layer (Conformance Lab Gate 2 -- instrumentation): every
hand-written `@mcp.tool` below carries FastMCP `annotations=` (all four
hints, accurate to the operation) and a 3-part description (what it does /
key params / "Next: <tool> to ..." guidance). An `outlier_help` tool is
registered the same way.

Wire-fingerprint (Gate 4): `maybe_fingerprint_selftest()` fires once at
process startup, before the event loop starts -- see the `__main__` guard.

Run:
    PORT=8803 MOCK_API_BASE_URL=http://127.0.0.1:8790 python server.py
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

# Must run BEFORE importing auth.py -- it reads THESUN_SERVICE/THESUN_AUTH_SCHEME
# at module import time (SERVICE = os.environ.get(...) at auth.py:29-30).
os.environ.setdefault("THESUN_SERVICE", "outlier_graphql")
os.environ.setdefault("THESUN_AUTH_SCHEME", "api_key")
os.environ.setdefault("OUTLIER_GRAPHQL_API_KEY_HEADER", "X-API-Key")

from fastmcp import FastMCP
from mcp.types import ToolAnnotations

from auth import get_auth_headers
from http_client import build_http_client, maybe_fingerprint_selftest
from ratelimit import AdaptiveRateLimiter, request_with_backoff

HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8803"))
BASE_URL = os.environ.get("MOCK_API_BASE_URL", "http://127.0.0.1:8790")

mcp = FastMCP(name="outlier-graphql-golden")

_client = build_http_client(BASE_URL)
_limiter = AdaptiveRateLimiter(per_second=5, per_minute=120, max_concurrency=4)

_HELP_TOPICS: dict[str, str] = {
    "overview": (
        "outlier-graphql-golden: protocol outlier, single GraphQL endpoint "
        "(POST /graphql), API-key auth. Tools: graphql_viewer, graphql_create_widget."
    ),
    "auth": (
        "API key via Hermes (HERMES_URL/HERMES_CLIENT_TOKEN) or standalone "
        "OUTLIER_GRAPHQL_API_KEY. Sent as the 'X-API-Key' header."
    ),
    "protocol": (
        "Every operation is a POST to /graphql with a {query, variables} body. "
        "Success/failure is signalled in the JSON body (errors[]), not just HTTP status."
    ),
    "errors": (
        "A missing/invalid API key surfaces as a well-formed {'error': 'unauthorized'} "
        "result, never a transport crash."
    ),
}


async def _graphql(query: str, variables: dict) -> dict:
    headers = await get_auth_headers()
    resp = await request_with_backoff(
        _client,
        "POST",
        "/graphql",
        _limiter,
        headers=headers,
        json={"query": query, "variables": variables},
    )
    if resp.status_code == 401:
        return {"error": "unauthorized", "detail": resp.json()}
    resp.raise_for_status()
    return resp.json()


@mcp.tool(
    annotations=ToolAnnotations(
        readOnlyHint=True,
        destructiveHint=False,
        idempotentHint=True,
        openWorldHint=True,
    )
)
async def graphql_viewer() -> dict:
    """Query the current authenticated viewer via GraphQL (id, name, email).

    No params. Next: graphql_create_widget to create a widget.
    """
    return await _graphql("query Viewer { viewer { id name email } }", {})


@mcp.tool(
    annotations=ToolAnnotations(
        readOnlyHint=False,
        destructiveHint=False,
        idempotentHint=False,
        openWorldHint=True,
    )
)
async def graphql_create_widget(name: str) -> dict:
    """Create a widget via a GraphQL mutation.

    Params: name (required name for the new widget).
    Next: graphql_viewer to confirm the authenticated viewer that owns it.

    Args:
        name: Name for the new widget.
    """
    mutation = "mutation CreateWidget($name: String!) { createWidget(name: $name) { widget { id name } } }"
    return await _graphql(mutation, {"name": name})


@mcp.tool(
    annotations=ToolAnnotations(
        readOnlyHint=True,
        destructiveHint=False,
        idempotentHint=True,
        openWorldHint=False,
    )
)
def outlier_help(topic: str = "overview") -> str:
    """Get help about the outlier-graphql-golden MCP server's tools and usage.

    Args:
        topic: Help topic -- one of "overview", "auth", "protocol", "errors".
    """
    return _HELP_TOPICS.get(topic, _HELP_TOPICS["overview"])


async def main() -> None:
    try:
        await mcp.run_async(transport="streamable-http", host=HOST, port=PORT)
    finally:
        await _client.aclose()


if __name__ == "__main__":
    # Must run BEFORE the event loop starts (see http_client.py's
    # maybe_fingerprint_selftest docstring) -- this is Gate 4's primary
    # mechanism, firing one throwaway request through the real curl_cffi
    # transport so the Conformance Lab can capture the ClientHello.
    maybe_fingerprint_selftest()
    asyncio.run(main())
