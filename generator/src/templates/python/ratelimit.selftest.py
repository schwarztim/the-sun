"""Standalone proof that AdaptiveRateLimiter.acquire() (ratelimit.py) releases
its concurrency-semaphore permit when a per-window acquire raises/is cancelled,
instead of leaking it.

Invoked as a subprocess by ratelimit.test.ts (mirrors the
gates/wire-fingerprint.selftest.test.ts convention of shelling out to a real
Python interpreter for behavior that only exists at the asyncio runtime level).
Only needs ratelimit.py's own dependencies (aiolimiter, tenacity) -- no
fastmcp/curl_cffi/mcp required, so it runs on a much lighter interpreter than
the golden-fixture tests.

Prints "PASS" and exits 0 on success; prints "FAIL: <reason>" and exits 1
otherwise.
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from ratelimit import AdaptiveRateLimiter  # noqa: E402


class _RaisingLimiter:
    """Stands in for a real per-window AsyncLimiter whose acquire() raises --
    simulating a client timeout/disconnect (asyncio.CancelledError) while a
    request is waiting on a window's capacity."""

    async def acquire(self) -> None:
        raise asyncio.CancelledError()


async def main() -> int:
    max_concurrency = 2
    limiter = AdaptiveRateLimiter(per_second=100, max_concurrency=max_concurrency)
    # Force every acquire() call to fail deep inside the per-window loop,
    # AFTER the concurrency semaphore has already been taken.
    limiter._limiters["second"] = _RaisingLimiter()

    for attempt in range(max_concurrency):
        try:
            await limiter.acquire()
            print(f"FAIL: acquire() did not raise on attempt {attempt}")
            return 1
        except asyncio.CancelledError:
            pass  # expected -- this is what a cancelled/timed-out caller sees

    # If the fix works, both permits taken above were released back to the
    # semaphore despite the exception. Prove it black-box: acquire the full
    # concurrency budget directly, with a short bound. A leaked permit would
    # make this hang/timeout (the deadlock this fix prevents).
    try:
        for _ in range(max_concurrency):
            await asyncio.wait_for(limiter._sem.acquire(), timeout=1.0)
    except asyncio.TimeoutError:
        print("FAIL: semaphore permit(s) leaked -- acquire() blocked (deadlock reproduced)")
        return 1

    print("PASS")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
