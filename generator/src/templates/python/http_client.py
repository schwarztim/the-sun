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

Camouflage override (operator's own browser):
  * At startup this module also looks for `<THESUN_HOME>/camouflage.json` —
    written by fleetd's `internal/camouflage` package during onboarding from a
    detection of the OPERATOR'S OWN machine and browser (not just its OS).
    When present, its `impersonate` and `user_agent` fields replace the
    hardcoded Chrome-131 default below, so this server's egress matches the
    operator's real browser instead of a fixed fallback. THESUN_HOME resolves
    the same way it does for the rest of the fleetd stack (env override, else
    the per-OS user-config directory). Absent/unreadable/invalid config is
    not an error — it just means "keep the Chrome-131 default."
"""
from __future__ import annotations

import asyncio
import json
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


def _thesun_home() -> str:
    """Resolve THESUN_HOME the same way fleetd's internal/paths.Home() does:
    an explicit env override, else a per-OS user-config default."""
    override = os.environ.get("THESUN_HOME", "").strip()
    if override:
        return override
    home = os.path.expanduser("~")
    sysname = platform.system()
    if sysname == "Darwin":
        return os.path.join(home, "Library", "Application Support", "thesun")
    if sysname == "Windows":
        appdata = os.environ.get("APPDATA", "").strip()
        return os.path.join(appdata or os.path.join(home, "AppData", "Roaming"), "thesun")
    xdg = os.environ.get("XDG_CONFIG_HOME", "").strip()
    return os.path.join(xdg or os.path.join(home, ".config"), "thesun")


def _load_camouflage_config() -> dict | None:
    """Read the operator's detected browser fingerprint profile written by
    fleetd's `internal/camouflage` package. Returns None (never raises) when
    the file is absent, unreadable, malformed, or missing the fields this
    client needs — callers fall back to the hardcoded Chrome-131 default."""
    path = os.path.join(_thesun_home(), "camouflage.json")
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    if not data.get("impersonate") or not data.get("user_agent"):
        return None
    return data


def _major_from_version(version: str) -> str:
    head = version.split(".", 1)[0] if version else ""
    return head if head.isdigit() else _CHROME_MAJOR


def _build_identity() -> dict[str, str]:
    cam = _load_camouflage_config()
    if cam is not None and cam.get("os") in _PLATFORMS:
        plat = cam["os"]
        major = _major_from_version(cam.get("browser_version", ""))
        _, sec_ch_platform = _PLATFORMS[plat]
        return {
            "family": cam.get("browser", "chrome"),
            "major": major,
            "platform": plat,
            "impersonate": cam["impersonate"],
            "user_agent": cam["user_agent"],
            "sec_ch_ua": f'"Google Chrome";v="{major}", '
            f'"Chromium";v="{major}", "Not_A Brand";v="24"',
            "sec_ch_ua_platform": sec_ch_platform,
            "ja4_prefix": JA4_PREFIX,
            "ja4_cipher_hash": JA4_CIPHER_HASH,
        }
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
    "Accept": "*/*",  # XHR/fetch default (a caller may override); consistent with Sec-Fetch-Mode: cors
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
}
# Headers curl_cffi's impersonate manages, or that we enforce — never forwarded from
# the caller. EVERYTHING else the caller sets (Authorization, Cookie, X-API-Key,
# Content-Type, and any custom header) IS forwarded, so auth of every scheme reaches
# the wire. (Forwarding only a fixed allowlist silently dropped session/api_key auth.)
_DROP_HEADERS = {
    "user-agent", "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform",
    "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest",
    "host", "connection", "content-length", "accept-encoding",
}


class CurlCffiTransport(httpx.AsyncBaseTransport):
    """httpx transport backed by curl_cffi with a browser TLS/H2 fingerprint.

    `impersonate` supplies the authentic browser TLS profile and header order;
    this transport overrides only the identity headers curl_cffi gets wrong for a
    non-macOS host (UA, Sec-CH-UA-Platform) and forwards caller auth/content
    headers (e.g. Hermes-injected Authorization).
    """

    def __init__(self, impersonate: str = BROWSER_IDENTITY["impersonate"], timeout: float = 30.0) -> None:
        self._session = AsyncSession()
        self._impersonate = impersonate
        self._timeout = timeout

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        headers: dict[str, str] = dict(_IDENTITY_HEADERS)
        headers.update(_FETCH_HEADERS)
        # Forward caller headers (auth / cookie / api-key / content-type / custom);
        # identity and connection-noise headers are dropped so the fingerprint stays intact.
        for name, value in request.headers.items():
            if name.lower() not in _DROP_HEADERS:
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


async def fingerprint_selftest(echo: str | None = None) -> bool:
    """Fire one throwaway request through the real transport so a wire observer
    (the Conformance Lab) can capture the ClientHello WITHOUT any target credential.

    This resolves the tension between credential-free verification and the need for
    real egress bytes: the fingerprint is proven independently of the target's auth.
    ``echo`` defaults to the ``THESUN_FINGERPRINT_ECHO`` env var (host:port or URL).
    Returns True if a request was attempted. The observer resets the socket after the
    ClientHello, so the request is expected to fail — that failure is not an error.
    """
    target = (echo or os.environ.get("THESUN_FINGERPRINT_ECHO", "")).strip()
    if not target:
        return False
    if not target.startswith("http"):
        target = f"https://{target}"
    client = build_http_client(target)
    try:
        await client.get("/")
    except Exception:  # noqa: BLE001 — handshake is intentionally reset by the observer
        pass
    finally:
        await client.aclose()
    return True


def maybe_fingerprint_selftest() -> bool:
    """Call once at server startup (before the event loop / mcp.run()). If
    THESUN_FINGERPRINT_ECHO is set, run the fingerprint self-test synchronously so
    the Lab can verify the wire fingerprint. No-op when the env var is absent."""
    if not os.environ.get("THESUN_FINGERPRINT_ECHO", "").strip():
        return False
    try:
        asyncio.run(fingerprint_selftest())
        return True
    except RuntimeError:
        # An event loop is already running; skip rather than crash startup.
        return False


__all__ = [
    "BROWSER_IDENTITY",
    "JA4_PREFIX",
    "JA4_CIPHER_HASH",
    "CurlCffiTransport",
    "build_http_client",
    "fingerprint_selftest",
    "maybe_fingerprint_selftest",
]
