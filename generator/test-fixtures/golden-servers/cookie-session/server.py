"""Golden fixture 2/3: cookie/session auth, hand-written tools.

Structurally represents the UNDOCUMENTED-target generation path: no OpenAPI
spec exists, so tools are hand-written (as bob would emit them from an
observed/HAR-captured app) rather than derived from `from_openapi`. Auth is
session-cookie (SCHEME=session in auth.py), which is exactly the "mirrors the
operator's own SSO/session access" shape called out in the plan's Locked
Direction #3.

Uses the full generated-server stack: curl_cffi browser-fingerprinted
transport (http_client.py), multi-window rate limiting (ratelimit.py), and
Hermes dual-mode auth (auth.py) -- copied in verbatim.

Credential resolution (`get_auth_headers()`) happens INSIDE each tool call,
not at startup -- the server must answer `initialize`/`listTools` with zero
credentials configured (Conformance Lab Gate 6); only a live tool call may
surface a well-formed auth error.

Enrichment layer (Conformance Lab Gate 2 -- instrumentation): every
hand-written `@mcp.tool` below carries FastMCP `annotations=` (all four
hints, accurate to the operation) and a 3-part description (what it does /
key params / "Next: <tool> to ..." guidance). A `cookie_session_help` tool
is registered the same way.

Wire-fingerprint (Gate 4): `maybe_fingerprint_selftest()` fires once at
process startup, before the event loop starts -- see the `__main__` guard.

Run:
    PORT=8802 MOCK_API_BASE_URL=http://127.0.0.1:8790 python server.py
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

# Must run BEFORE importing auth.py -- it reads THESUN_SERVICE/THESUN_AUTH_SCHEME
# at module import time (SERVICE = os.environ.get(...) at auth.py:29-30).
os.environ.setdefault("THESUN_SERVICE", "cookie_session")
os.environ.setdefault("THESUN_AUTH_SCHEME", "session")

from fastmcp import FastMCP
from mcp.types import ToolAnnotations

from auth import get_auth_headers
from http_client import build_http_client, maybe_fingerprint_selftest
from ratelimit import AdaptiveRateLimiter, request_with_backoff

HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8802"))
BASE_URL = os.environ.get("MOCK_API_BASE_URL", "http://127.0.0.1:8790")

mcp = FastMCP(name="cookie-session-golden")

# Client + limiter are created once and reused across tool calls -- only the
# per-request auth headers are resolved lazily (see each tool body below).
_client = build_http_client(BASE_URL)
_limiter = AdaptiveRateLimiter(per_second=5, per_minute=120, max_concurrency=4)

_HELP_TOPICS: dict[str, str] = {
    "overview": (
        "cookie-session-golden: hand-written tools, cookie/session auth. "
        "Tools: get_profile, add_profile_note."
    ),
    "auth": (
        "Session cookie via Hermes (HERMES_URL/HERMES_CLIENT_TOKEN) or standalone "
        "COOKIE_SESSION_SESSION. Sent as the 'Cookie' header verbatim."
    ),
    "errors": (
        "A missing/invalid session surfaces as a well-formed {'error': 'unauthorized'} "
        "result, never a transport crash."
    ),
}


@mcp.tool(
    annotations=ToolAnnotations(
        readOnlyHint=True,
        destructiveHint=False,
        idempotentHint=True,
        openWorldHint=True,
    )
)
async def get_profile() -> dict:
    """Fetch the authenticated session's profile, including saved notes.

    No params. Next: add_profile_note to append a note.
    """
    headers = await get_auth_headers()
    resp = await request_with_backoff(_client, "GET", "/profile", _limiter, headers=headers)
    if resp.status_code == 401:
        return {"error": "unauthorized", "detail": resp.json()}
    resp.raise_for_status()
    return resp.json()


@mcp.tool(
    annotations=ToolAnnotations(
        readOnlyHint=False,
        destructiveHint=False,
        idempotentHint=False,
        openWorldHint=True,
    )
)
async def add_profile_note(text: str) -> dict:
    """Add a note to the authenticated session's profile.

    Params: text (note body to append, required).
    Next: get_profile to see the updated profile with the new note.

    Args:
        text: Note body to append.
    """
    headers = await get_auth_headers()
    resp = await request_with_backoff(
        _client, "POST", "/profile/notes", _limiter, headers=headers, json={"text": text}
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
        openWorldHint=False,
    )
)
def cookie_session_help(topic: str = "overview") -> str:
    """Get help about the cookie-session-golden MCP server's tools and usage.

    Args:
        topic: Help topic -- one of "overview", "auth", "errors".
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
