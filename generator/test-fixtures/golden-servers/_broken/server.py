"""FAIL fixture: malformed tool -- the server must not even start.

Realistic generation bug: a tool signature references a type that was never
defined or imported (e.g. bob emitted `-> ItemSummary` but forgot the import,
or hallucinated a type name). FastMCP resolves tool type hints via Pydantic
at DECORATION time (not call time), so this raises `NameError` the moment the
module is imported -- before any port is ever bound.

Verified failure mode (empirical, 2026-07-02, fastmcp 3.4.2 / pydantic
2.13.4): decorating `broken_tool(x: "NonExistentType") -> str` raises
    NameError: name 'NonExistentType' is not defined
from pydantic._internal._typing_extra.get_function_type_hints, propagated
straight out of `@mcp.tool`.

The Conformance Lab's spawn/readiness poll (bounded retries against
`initialize`) must observe: process exits non-zero, no port ever opens,
poll ceiling reached -> FAIL with "server did not become ready" (or the
harness can capture stderr directly, which will show the NameError).

Run (expected to crash immediately, before printing anything):
    PORT=8804 python server.py
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

# Must run BEFORE importing auth.py -- it reads THESUN_SERVICE at module
# import time (SERVICE = os.environ.get(...) at auth.py:29). Moot here since
# this fixture crashes at tool-decoration time regardless, but kept
# consistent with the other fixtures for structural parity.
os.environ.setdefault("THESUN_SERVICE", "broken_fixture")

from fastmcp import FastMCP

from auth import get_auth_headers  # noqa: F401 - present for structural parity with real generated servers
from http_client import build_http_client  # noqa: F401

HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8804"))
BASE_URL = os.environ.get("MOCK_API_BASE_URL", "http://127.0.0.1:8790")

mcp = FastMCP(name="broken-golden")


@mcp.tool
async def broken_tool(item_id: "ItemSummary") -> str:  # noqa: F821 - deliberately undefined type
    """Deliberately malformed: `ItemSummary` is never defined or imported.

    FastMCP/pydantic raises NameError resolving this annotation at
    decoration time, which happens at module import -- the process never
    reaches `mcp.run_async()`.
    """
    return str(item_id)


async def main() -> None:
    # Unreachable: the module-level `@mcp.tool` decoration above already
    # raised NameError during import, so this function body never runs.
    await mcp.run_async(transport="streamable-http", host=HOST, port=PORT)


if __name__ == "__main__":
    asyncio.run(main())
