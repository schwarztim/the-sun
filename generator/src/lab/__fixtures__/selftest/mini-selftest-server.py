"""Tiny Python/FastMCP fixture used ONLY by src/lab's own tests to confirm
Gate 4 (wire-fingerprint) is correctly wired to the self-test hook contract
in src/templates/python/http_client.py's `maybe_fingerprint_selftest()`.

This is NOT a golden fixture (those live in test-fixtures/golden-servers/,
owned by a different agent) — it lives under src/lab/__fixtures__, which the
Conformance Lab owns, specifically so gate 4's self-test path has a real
Python/FastMCP server to spawn against without depending on the golden
fixtures being updated to call the hook.

Requires: fastmcp, mcp, curl_cffi, httpx (same deps as the golden fixtures'
pyproject.toml). Tests that spawn this fixture skip gracefully when these
aren't importable — see harness.selftest.test.ts.

Run:
    THESUN_PORT=<port> THESUN_HOST=127.0.0.1 \
    THESUN_FINGERPRINT_ECHO=<capture-host:port> python3 mini-selftest-server.py
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

# src/lab/__fixtures__/selftest/mini-selftest-server.py -> src/templates/python
_TEMPLATES_DIR = Path(__file__).resolve().parents[3] / "templates" / "python"
sys.path.insert(0, str(_TEMPLATES_DIR))

from http_client import maybe_fingerprint_selftest  # noqa: E402

# Contract (http_client.py): call once at startup, BEFORE the event loop /
# mcp.run() — no-op when THESUN_FINGERPRINT_ECHO isn't set.
maybe_fingerprint_selftest()

from fastmcp import FastMCP  # noqa: E402


mcp = FastMCP(name="lab-fixture-selftest")


@mcp.tool
async def ping() -> str:
    """Replies pong. Requires nothing."""
    return "pong"


@mcp.tool
async def lab_fixture_selftest_help(topic: str = "") -> str:
    """Help topics for this fixture server.

    Args:
        topic: Topic to look up (unused; this fixture has no real topics).
    """
    return "no topics"


async def main() -> None:
    host = os.environ.get("THESUN_HOST", "127.0.0.1")
    port = int(os.environ.get("THESUN_PORT", "0"))
    await mcp.run_async(transport="streamable-http", host=host, port=port)


if __name__ == "__main__":
    asyncio.run(main())
