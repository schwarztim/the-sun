"""Browser-realistic async HTTP client for thesun-generated MCP servers.

Copied verbatim into every generated Python/FastMCP server (see the generation
playbook). Provides one HTTP client whose egress is indistinguishable from a real
Chrome browser at the TLS/HTTP-2 AND application-header level, so requests to the
operator's authorized targets are handled the same way a browser's are.

Browser identity is derived from the ACTUAL host OS at runtime: a process running
on macOS presents macOS, on Windows presents Windows, on Linux (incl. a Linux
container) presents Linux. This keeps the User-Agent, Sec-CH-UA-Platform client
hint, and the real kernel TCP stamp (JA4T) all in agreement wherever the server
runs. Override with THESUN_BROWSER_PLATFORM=macos|windows|linux if needed.

Wire-verified in Stage 0 (2026-07-02, curl_cffi 0.15.0 / fastmcp 3.4.2):
    JA4  t13d1516h2_8daaf6152771_02713d6af862   (real Chrome, HTTP/2)
    Akamai H2  52d84b11737d980aef856699f885ca86
JA3 varies per connection (Chrome-style extension permutation is on) — correct;
a *static* JA3 is itself a detection signal. The stable anchors the Conformance
Lab asserts on are the JA4 prefix + cipher-suite hash, never a fixed JA3.

Design notes (Stage-0 findings):
  * curl_cffi's `impersonate` sets the browser TLS/H2 profile, header set, and
    header ORDER authentically — we do not hand-type those.
  * curl_cffi's default identity is macOS; on non-macOS hosts we override the
    User-Agent AND Sec-CH-UA-Platform so UA, client hints, and kernel agree.
  * For API/XHR calls we set fetch metadata (Sec-Fetch-* = cors/empty) instead
    of curl_cffi's top-level-navigation defaults.
  * A hand-rolled httpx transport is used (not the beta `httpx-curl-cffi` shim);
    the only extra dependency is curl_cffi itself.
"""
from __future__ import annotations

import os
import platform
from typing import Mapping

import httpx
from curl_cffi.requests import AsyncSession

# curl_cffi impersonation target. Its Chrome *version* pins the UA version so the
# UA and the TLS profile can never disagree; the TLS bytes are OS-independent.
_IMPERSONATE = "chrome131"
_CHROME_MAJOR = "131"
# Wire-verified stable fingerprint anchors (OS-independent). The Lab asserts the
# JA4 startswith the prefix and contains the cipher hash; it must NOT pin a JA3.
JA4_PREFIX = "t13d15"
JA4_CIPHER_HASH = "8daaf6152771"

_PLATFORMS = {
    "macos": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        f"(KHTML, like Gecko) Chrome/{_CHROME_MAJOR}.0.0.0 Safari/537.36",
        '"macOS"',
    ),
    "windows": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        f"(KHTML, like Gecko) Chrome/{_CHROME_MAJOR}.0.0.0 Safari/537.36",
        '"Windows"',
    ),
    "linux": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        f"(KHTML, like Gecko) Chrome/{_CHROME_MAJOR}.0.0.0 Safari/537.36",
        '"Linux"',
    ),
}


def _detect_platform() -> str:
    override = os.environ.get("THESUN_BROWSER_PLATFORM", "").strip().lower()
    if override in _PLATFORMS:
        return override
    sysname = platform.system()
    return {"Darwin": "macos", "Windows": "windows"}.get(sysname, "linux")


def _build_identity() -> dict[str, str]:
    plat = _detect_platform()
    ua, sec_ch_platform = _PLATFORMS[plat]
    return {
        "family": "chrome",
        "major": _CHROME_MAJOR,
        "platform": plat,
        "impersonate": _IMPERSONATE,
        "user_agent": ua,
        "sec_ch_ua": f'"Google Chrome";v="{_CHROME_MAJOR}", '
        f'"Chromium";v="{_CHROME_MAJOR}", "Not_A Brand";v="24"',
        "sec_ch_ua_platform": sec_ch_platform,
        "ja4_prefix": JA4_PREFIX,
        "ja4_cipher_hash": JA4_CIPHER_HASH,
    }


# Single source of truth for browser identity, resolved once at import (read by
# the Conformance Lab too). Host-OS-derived; consistent across all layers.
BROWSER_IDENTITY: dict[str, str] = _build_identity()

_IDENTITY_HEADERS: dict[str, str] = {
    "User-Agent": BROWSER_IDENTITY["user_agent"],
    "Sec-CH-UA": BROWSER_IDENTITY["sec_ch_ua"],
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": BROWSER_IDENTITY["sec_ch_ua_platform"],
}
_FETCH_HEADERS: dict[str, str] = {
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
}
# GOLDEN-FIXTURE PATCH (2026-07-02, applied locally to this copy only -- see
# ../README.md "Known upstream gap" for the canonical
# src/templates/python/http_client.py fix this template still needs): the
# original hardcoded allowlist below forwarded only
# `authorization`/`content-type`/`accept`/`accept-language`, silently
# DROPPING any other caller header -- e.g. `Cookie` (SCHEME=session) and
# `X-API-Key` (SCHEME=api_key) from auth.py's own get_auth_headers()
# contract. Verified failure mode: cookie-session/outlier golden servers
# returned well-formed 401s from the mock target even with a correct
# credential configured, because the Cookie/X-API-Key header never left the
# process. Fixed here by forwarding every caller header that isn't an
# identity/fetch header, instead of a fixed 4-name allowlist.
_FORWARD_HEADERS = ("authorization", "content-type", "accept", "accept-language")  # superseded below; kept for reference
_PROTECTED_HEADER_NAMES = {h.lower() for h in _IDENTITY_HEADERS} | {h.lower() for h in _FETCH_HEADERS}


class CurlCffiTransport(httpx.AsyncBaseTransport):
    """httpx transport backed by curl_cffi with a browser TLS/H2 fingerprint.

    `impersonate` supplies the authentic browser TLS profile and header order;
    this transport overrides only the identity headers curl_cffi gets wrong for a
    non-macOS host (UA, Sec-CH-UA-Platform) and forwards every caller-set header
    that isn't an identity/fetch header (auth headers of any shape -- Bearer,
    Cookie, X-API-Key, ... -- plus Content-Type/Accept/etc).
    """

    def __init__(self, impersonate: str = _IMPERSONATE, timeout: float = 30.0) -> None:
        self._session = AsyncSession()
        self._impersonate = impersonate
        self._timeout = timeout

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        headers: dict[str, str] = dict(_IDENTITY_HEADERS)
        headers.update(_FETCH_HEADERS)
        for name, value in request.headers.items():
            if name.lower() not in _PROTECTED_HEADER_NAMES:
                headers[name] = value
        resp = await self._session.request(
            method=request.method,
            url=str(request.url),
            headers=headers,
            data=request.content or None,
            impersonate=self._impersonate,
            extra_fp={"tls_permute_extensions": True},
            timeout=self._timeout,
            allow_redirects=False,
        )
        return httpx.Response(
            status_code=resp.status_code,
            headers=dict(resp.headers),
            content=resp.content,
            request=request,
        )

    async def aclose(self) -> None:
        await self._session.close()


def build_http_client(
    base_url: str,
    *,
    default_headers: Mapping[str, str] | None = None,
    timeout: float = 30.0,
) -> httpx.AsyncClient:
    """Return an httpx.AsyncClient with a host-matched Chrome wire fingerprint.

    Pass straight to ``FastMCP.from_openapi(client=...)`` or use directly for a
    HAR/undocumented-target server. ``default_headers`` may carry non-identity
    request headers (identity keys are ignored — they are enforced).
    """
    ident = {h.lower() for h in _IDENTITY_HEADERS}
    extra = {k: v for k, v in (default_headers or {}).items() if k.lower() not in ident}
    return httpx.AsyncClient(
        base_url=base_url,
        transport=CurlCffiTransport(timeout=timeout),
        headers=extra,
        timeout=timeout,
    )


__all__ = ["BROWSER_IDENTITY", "JA4_PREFIX", "JA4_CIPHER_HASH", "CurlCffiTransport", "build_http_client"]
