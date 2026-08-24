"""FAIL fixture: streamable-http server whose egress fingerprint doesn't
match its claimed identity -- must fail the wire-fingerprint gate only.

Realistic generation bug: the generator emits Chrome-looking application
headers (User-Agent, Sec-CH-UA, Sec-CH-UA-Platform) by hand but wires the
outbound calls through a PLAIN `httpx.AsyncClient()` instead of importing
`build_http_client()` from http_client.py. `http_client.py` sits right next
to this file (copied in, same as every other fixture) -- the bug is that
this server never imports or uses it. The application-layer headers claim
Chrome/Windows; the actual TLS ClientHello is whatever Python's stock ssl
module negotiates (no curl_cffi impersonation), which is trivially
distinguishable from a real Chrome handshake (cipher order, extension
order/count, ALPN, ECH grease, etc. all differ). This is exactly the
UA-says-Chrome / TLS-says-Python mismatch the plan's Stage 0 wire-capture
gate exists to catch.

Everything else about this server is correct: valid streamable-http
transport, well-formed tools, starts cleanly, answers `initialize` fine
(Gates 1-3 all PASS). It should fail ONLY Gate 4 (wire-fingerprint), proving
the Lab's gates are independently discriminating rather than one gate
rubber-stamping all the others.

Run:
    PORT=8806 MOCK_API_BASE_URL=http://127.0.0.1:8790 python server.py
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

# Must run BEFORE importing auth.py -- it reads THESUN_SERVICE/THESUN_AUTH_SCHEME
# at module import time (SERVICE = os.environ.get(...) at auth.py:29-30).
os.environ.setdefault("THESUN_SERVICE", "ua_mismatch_fixture")
os.environ.setdefault("THESUN_AUTH_SCHEME", "bearer")

import httpx
from fastmcp import FastMCP

from auth import get_auth_headers
from ratelimit import AdaptiveRateLimiter, request_with_backoff

# NOTE: http_client.py IS present in this directory (copied in like every
# other fixture) but deliberately NOT imported below -- that omission is the
# defect under test.

HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8806"))
BASE_URL = os.environ.get("MOCK_API_BASE_URL", "http://127.0.0.1:8790")

# Hand-copied "browser-looking" headers -- claims Chrome 131 / Windows, but
# nothing about the transport below actually produces a Chrome TLS/H2
# fingerprint to back that claim up.
_CLAIMED_CHROME_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    ),
    "Sec-CH-UA": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": '"Windows"',
}

mcp = FastMCP(name="ua-mismatch-golden")

# DEFECT (deliberate): plain httpx transport, not CurlCffiTransport. TLS
# ClientHello will be Python/OpenSSL's default, not a Chrome impersonation.
_client = httpx.AsyncClient(base_url=BASE_URL, headers=_CLAIMED_CHROME_HEADERS, timeout=30.0)
_limiter = AdaptiveRateLimiter(per_second=5, per_minute=120, max_concurrency=4)


@mcp.tool
async def list_items(limit: int = 10) -> dict:
    """List items (bearer-authenticated) -- same shape as rest-bearer's tools.

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
        await mcp.run_async(transport="streamable-http", host=HOST, port=PORT)
    finally:
        await _client.aclose()


if __name__ == "__main__":
    asyncio.run(main())
