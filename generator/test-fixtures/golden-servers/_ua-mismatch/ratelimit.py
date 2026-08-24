"""Client-side rate limiting for thesun-generated MCP servers.

Copied verbatim into every generated Python server. Makes the server a courteous
API consumer: it throttles to the target's known/observed limits, reads rate-limit
response headers to slow *before* being told off (proactive), honors Retry-After on
429/503 (reactive), and narrows itself when live headers disagree (adaptive).

Correctness notes (Stage-0 / adversarial review):
  * Multi-window buckets are nested WIDEST-window-outermost, narrowest-innermost
    (day -> hour -> minute -> second). Nesting narrow-first would spend the
    fast-refilling per-second slot before blocking on the scarce daily gate,
    piling up callers holding spent slots (throughput collapse).
  * Adaptive rate changes swap the limiter OBJECT atomically under an asyncio.Lock
    rather than mutating limiter fields in place (avoids a concurrent read race).
  * The per-process limiter assumes a single server process/replica. If the server
    is ever scaled horizontally, move to a shared/external bucket — N replicas
    otherwise multiply the real rate N-fold.
"""
from __future__ import annotations

import asyncio
import email.utils
import time
from dataclasses import dataclass, field

from aiolimiter import AsyncLimiter
from tenacity import AsyncRetrying, retry_if_exception_type, stop_after_attempt

# Windows in seconds, ordered widest -> narrowest for correct nesting.
_WINDOW_SECONDS = {"day": 86400.0, "hour": 3600.0, "minute": 60.0, "second": 1.0}
_WINDOW_ORDER = ("day", "hour", "minute", "second")


class RateLimitedError(Exception):
    """Raised on a 429/503 so tenacity can retry; carries an optional wait."""

    def __init__(self, retry_after: float | None = None) -> None:
        super().__init__("rate limited by target")
        self.retry_after = retry_after


@dataclass
class RateLimitInfo:
    limit: int | None = None
    remaining: int | None = None
    reset_seconds: float | None = None
    retry_after_seconds: float | None = None


def parse_rate_limit_headers(headers: dict[str, str]) -> RateLimitInfo:
    """Normalize GitHub-style X-RateLimit-*, Retry-After (delta or HTTP-date),
    and the IETF combined `RateLimit:` structured field."""
    h = {k.lower(): v for k, v in headers.items()}
    info = RateLimitInfo()
    if "retry-after" in h:
        raw = h["retry-after"].strip()
        if raw.isdigit():
            info.retry_after_seconds = float(raw)
        else:
            try:
                dt = email.utils.parsedate_to_datetime(raw)
                info.retry_after_seconds = max(0.0, dt.timestamp() - time.time())
            except (TypeError, ValueError):
                info.retry_after_seconds = None
    if "x-ratelimit-limit" in h:
        info.limit = _safe_int(h["x-ratelimit-limit"])
    if "x-ratelimit-remaining" in h:
        info.remaining = _safe_int(h["x-ratelimit-remaining"])
    if "x-ratelimit-reset" in h:
        reset = _safe_float(h["x-ratelimit-reset"])
        if reset is not None:
            # Heuristic: large value => epoch seconds; small => delta seconds.
            info.reset_seconds = max(0.0, reset - time.time()) if reset > 1e6 else reset
    if "ratelimit" in h:  # IETF draft combined field: "limit=100, remaining=50, reset=60"
        for part in h["ratelimit"].split(","):
            key, _, val = part.strip().partition("=")
            if key == "limit":
                info.limit = _safe_int(val)
            elif key == "remaining":
                info.remaining = _safe_int(val)
            elif key == "reset":
                info.reset_seconds = _safe_float(val)
    return info


def _safe_int(v: str) -> int | None:
    try:
        return int(v.strip())
    except (ValueError, AttributeError):
        return None


def _safe_float(v: str) -> float | None:
    try:
        return float(v.strip())
    except (ValueError, AttributeError):
        return None


@dataclass
class AdaptiveRateLimiter:
    """Multi-window leaky-bucket limiter, seeded from spec/known limits and
    narrowed adaptively from live response headers.

    Construct with the per-window maxima you know (any subset), plus a concurrency
    cap. Wrap each outbound request with ``acquire()`` and feed every response to
    ``observe()``.
    """

    per_second: float | None = None
    per_minute: float | None = None
    per_hour: float | None = None
    per_day: float | None = None
    max_concurrency: int = 10
    _sem: asyncio.Semaphore = field(init=False)
    _limiters: dict[str, AsyncLimiter] = field(init=False, default_factory=dict)
    _lock: asyncio.Lock = field(init=False)

    def __post_init__(self) -> None:
        self._sem = asyncio.Semaphore(self.max_concurrency)
        self._lock = asyncio.Lock()
        rates = {
            "day": self.per_day,
            "hour": self.per_hour,
            "minute": self.per_minute,
            "second": self.per_second,
        }
        for window, rate in rates.items():
            if rate and rate > 0:
                self._limiters[window] = AsyncLimiter(rate, _WINDOW_SECONDS[window])

    def _ordered(self) -> list[AsyncLimiter]:
        return [self._limiters[w] for w in _WINDOW_ORDER if w in self._limiters]

    async def acquire(self) -> None:
        """Acquire capacity across all windows (widest-outermost) + a concurrency slot.

        If any per-window acquire raises (including asyncio.CancelledError from a
        client timeout/disconnect while waiting on a window), the concurrency
        permit already taken above MUST be released before re-raising -- otherwise
        the permit leaks and available concurrency shrinks monotonically until the
        generated server deadlocks under repeated cancellations.
        """
        await self._sem.acquire()
        try:
            for limiter in self._ordered():  # day -> hour -> minute -> second
                await limiter.acquire()
        except BaseException:
            self._sem.release()
            raise

    def release(self) -> None:
        self._sem.release()

    async def observe(self, headers: dict[str, str]) -> None:
        """Narrow the per-second limiter if live headers reveal a tighter limit.
        Never widens automatically. Swaps the limiter object atomically."""
        info = parse_rate_limit_headers(headers)
        if info.limit is None or info.reset_seconds is None or info.reset_seconds <= 0:
            return
        observed_rate = info.limit / info.reset_seconds
        current = self._limiters.get("second")
        if current is None or observed_rate < current.max_rate:
            async with self._lock:
                self._limiters["second"] = AsyncLimiter(max(observed_rate, 0.1), 1)


async def request_with_backoff(client, method: str, url: str, limiter: AdaptiveRateLimiter, **kwargs):
    """Make one rate-limited request with Retry-After-aware exponential backoff.

    `client` is any object with an async ``request(method, url, **kwargs)`` that
    returns a response exposing ``.status_code`` and ``.headers``.
    """

    async def _do():
        await limiter.acquire()
        try:
            resp = await client.request(method, url, **kwargs)
        finally:
            limiter.release()
        await limiter.observe(dict(resp.headers))
        if resp.status_code in (429, 503):
            info = parse_rate_limit_headers(dict(resp.headers))
            raise RateLimitedError(retry_after=info.retry_after_seconds)
        return resp

    attempt_num = 0
    async for attempt in AsyncRetrying(
        retry=retry_if_exception_type(RateLimitedError),
        stop=stop_after_attempt(5),
        reraise=True,
    ):
        with attempt:
            attempt_num += 1
            try:
                return await _do()
            except RateLimitedError as exc:
                # Honor Retry-After exactly if given, else exponential + jitter.
                delay = exc.retry_after if exc.retry_after is not None else min(60.0, 2 ** attempt_num)
                await asyncio.sleep(delay)
                raise


__all__ = [
    "AdaptiveRateLimiter",
    "RateLimitedError",
    "RateLimitInfo",
    "parse_rate_limit_headers",
    "request_with_backoff",
]
