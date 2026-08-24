"""Golden fixture 1/3: spec-backed REST, bearer auth, cursor pagination.

Structurally represents thesun's DETERMINISTIC generation path (Stage 3):
every tool comes straight from `FastMCP.from_openapi(openapi_spec=...)` --
there is no hand-written tool code in this fixture. Uses the full generated-
server stack: curl_cffi browser-fingerprinted transport (http_client.py),
multi-window rate limiting (ratelimit.py), and Hermes dual-mode auth
(auth.py) -- all copied in verbatim, exactly as the real generator copies
them into every server it produces.

Auth is wired lazily (see `_LazyBearerAuth` below): resolving a credential
happens on the FIRST OUTBOUND REQUEST, not at import/startup time. This
matters for the Conformance Lab's Gate 6 (credential-free callability) --
the server must start and answer `initialize`/`listTools` even when no
credential is configured; only an actual tool *call* should surface a
well-formed auth error.

Enrichment layer (Conformance Lab Gate 2 -- instrumentation): a real
generated server is a base (here, `FastMCP.from_openapi`) PLUS bob's
enrichment pass -- annotations, prerequisite-aware descriptions, and a
`<target>_help` tool. Since `from_openapi` builds tools straight off the
spec, the enrichment is applied as a post-generation transform via
`mcp_component_fn` (see `_customize_tool` below): FastMCP calls it once per
generated component, BEFORE the tool is registered, with the live
`OpenAPITool` instance -- mutating `tool.annotations`/`tool.description` in
place is the supported hook for this (FastMCP 3.4.2; verified 2026-07-02).
The `rest_bearer_help` tool is then added the normal way via `@mcp.tool`
since `FastMCP.from_openapi` still creates a `LocalProvider` for
decorator-registered tools alongside the `OpenAPIProvider`.

Wire-fingerprint (Gate 4): `maybe_fingerprint_selftest()` fires once at
process startup, before the event loop starts -- see the `__main__` guard.

Run:
    PORT=8801 MOCK_API_BASE_URL=http://127.0.0.1:8790 python server.py
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent))

# Must run BEFORE importing auth.py -- it reads THESUN_SERVICE/THESUN_AUTH_SCHEME
# at module import time (SERVICE = os.environ.get(...) at auth.py:29-30).
os.environ.setdefault("THESUN_SERVICE", "rest_bearer")
os.environ.setdefault("THESUN_AUTH_SCHEME", "bearer")

import httpx
from fastmcp import FastMCP
from fastmcp.server.providers.openapi import MCPType, RouteMap
from mcp.types import ToolAnnotations

from auth import get_auth_headers
from http_client import build_http_client, maybe_fingerprint_selftest

HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8801"))
BASE_URL = os.environ.get("MOCK_API_BASE_URL", "http://127.0.0.1:8790")

# --- Gate 2 enrichment data, keyed by OpenAPI operationId ---------------------
# Hint values are accurate to each operation: GET ops are read-only/idempotent,
# the POST op is neither (creating twice makes two items); none are destructive
# (no delete/overwrite operation exists in this spec); all reach an external,
# non-enumerable target (openWorldHint=True).
_TOOL_ANNOTATIONS: dict[str, dict[str, bool]] = {
    "listItems": dict(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=True),
    "createItem": dict(readOnlyHint=False, destructiveHint=False, idempotentHint=False, openWorldHint=True),
    "getItem": dict(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=True),
}
# Each description: what it does / key params / "Next: <tool> to ..." guidance.
# getItem additionally carries "Call listItems first" prerequisite guidance
# since it takes an itemId path parameter that must come from somewhere.
_TOOL_DESCRIPTIONS: dict[str, str] = {
    "listItems": (
        "List items from the API with cursor-based pagination. "
        "Params: cursor (opaque token from a previous response's next_cursor, optional), "
        "limit (page size 1-100, default 10). "
        "Next: getItem to fetch a single item by id, or createItem to add a new item."
    ),
    "createItem": (
        "Create a new item. Params: name (required item name). "
        "Next: getItem to fetch the created item by its returned id, or listItems to see it in the paginated list."
    ),
    "getItem": (
        "Fetch a single item by its id. Call listItems first to obtain a valid itemId. "
        "Params: itemId (path parameter, required). "
        "Next: createItem to add another item."
    ),
}

_HELP_TOPICS: dict[str, str] = {
    "overview": (
        "rest-bearer-golden: spec-backed REST API, bearer auth, cursor pagination. "
        "Tools: listItems, createItem, getItem. Start with listItems."
    ),
    "auth": (
        "Bearer token via Hermes (HERMES_URL/HERMES_CLIENT_TOKEN) or standalone "
        "REST_BEARER_TOKEN. Sent as 'Authorization: Bearer <token>'."
    ),
    "pagination": (
        "listItems returns next_cursor; pass it back as the cursor param to fetch "
        "the following page. next_cursor is null when the list is exhausted."
    ),
    "errors": (
        "A missing/invalid credential surfaces as a well-formed tool error "
        "(isError=true), never a transport crash."
    ),
}


def _customize_tool(route: Any, tool: Any) -> None:
    """`mcp_component_fn` hook for `FastMCP.from_openapi` -- enriches each
    OpenAPI-derived tool with FastMCP annotations and a prerequisite-aware
    description, mirroring the enrichment applied by hand in the
    cookie-session/outlier fixtures (whose tools are hand-written, so their
    `@mcp.tool` decorators carry `annotations=`/`description=` directly).
    """
    op_id = route.operation_id
    annotations = _TOOL_ANNOTATIONS.get(op_id)
    if annotations is not None:
        tool.annotations = ToolAnnotations(**annotations)
    description = _TOOL_DESCRIPTIONS.get(op_id)
    if description is not None:
        tool.description = description


class _LazyBearerAuth(httpx.Auth):
    """Defer `get_auth_headers()` to first request instead of server startup.

    `build_http_client()` only accepts static `default_headers`, which would
    force eager credential resolution (and a startup crash when no credential
    is configured yet). Attaching this as `client.auth` keeps startup
    credential-free while still authenticating every real call.
    """

    requires_request_body = False

    async def async_auth_flow(self, request: httpx.Request):
        headers = await get_auth_headers()
        for key, value in headers.items():
            request.headers[key] = value
        yield request


def _load_spec() -> dict:
    return json.loads((Path(__file__).parent / "openapi.json").read_text())


def build_server() -> FastMCP:
    client = build_http_client(BASE_URL)
    client.auth = _LazyBearerAuth()
    mcp = FastMCP.from_openapi(
        openapi_spec=_load_spec(),
        client=client,
        name="rest-bearer-golden",
        # Force every operation to a Tool (not Resource/ResourceTemplate) so
        # the Conformance Lab's listTools() sees the full generated surface.
        route_maps=[RouteMap(methods="*", pattern=r".*", mcp_type=MCPType.TOOL)],
        # Gate 2 enrichment: set annotations/description on each OpenAPI-derived
        # tool as it's created (see `_customize_tool` docstring above).
        mcp_component_fn=_customize_tool,
    )

    @mcp.tool(
        annotations=ToolAnnotations(
            readOnlyHint=True,
            destructiveHint=False,
            idempotentHint=True,
            openWorldHint=False,
        )
    )
    def rest_bearer_help(topic: str = "overview") -> str:
        """Get help about the rest-bearer-golden MCP server's tools and usage.

        Args:
            topic: Help topic -- one of "overview", "auth", "pagination", "errors".
        """
        return _HELP_TOPICS.get(topic, _HELP_TOPICS["overview"])

    return mcp


async def main() -> None:
    mcp = build_server()
    await mcp.run_async(transport="streamable-http", host=HOST, port=PORT)


if __name__ == "__main__":
    # Must run BEFORE the event loop starts (see http_client.py's
    # maybe_fingerprint_selftest docstring) -- this is Gate 4's primary
    # mechanism, firing one throwaway request through the real curl_cffi
    # transport so the Conformance Lab can capture the ClientHello.
    maybe_fingerprint_selftest()
    asyncio.run(main())
