"""Modular Hermes-brokered authentication for thesun-generated MCP servers.

Copied into every generated Python server. Auth is a swappable module: the rest of
the server depends only on the stable ``get_auth_headers()`` contract and never
cares how the token was obtained. This mirrors the operator's own access path —
Hermes is the broker; the generated server presents whatever credential the
operator's Hermes has for the target (bearer, API key, or a captured session).

Dual mode (matches the fleet convention):
  * Hermes CONFIGURED (HERMES_URL + HERMES_CLIENT_TOKEN set): the broker is
    authoritative. On broker failure we log and RAISE (fail loud) — a silent
    fallback would hide a real auth outage.
  * Hermes NOT configured: standalone/legacy env-var credential is legitimate.
  * Explicit opt-out: <SERVICE>_LEGACY_AUTH=true forces the standalone path even
    when Hermes is configured (for local dev against a target Hermes lacks).

The generator fills SERVICE and SCHEME for the target.
"""
from __future__ import annotations

import logging
import os

import httpx

log = logging.getLogger(__name__)

# --- Generator fills these for the target -------------------------------------
SERVICE = os.environ.get("THESUN_SERVICE", "example")
SCHEME = os.environ.get("THESUN_AUTH_SCHEME", "bearer")  # bearer | api_key | session

_HERMES_URL = os.environ.get("HERMES_URL", "").rstrip("/")
_HERMES_CLIENT_TOKEN = os.environ.get("HERMES_CLIENT_TOKEN", "")


def _hermes_configured() -> bool:
    if os.environ.get(f"{SERVICE.upper()}_LEGACY_AUTH", "").lower() == "true":
        return False
    return bool(_HERMES_URL and _HERMES_CLIENT_TOKEN)


async def _fetch_from_hermes() -> str:
    """GET ${HERMES_URL}/token/<service>/<scheme> with the client token.

    Uses a plain httpx client (broker calls are localhost/trusted and must NOT be
    fingerprint-shaped). Fails loud on any error when Hermes is configured.
    """
    url = f"{_HERMES_URL}/token/{SERVICE}/{SCHEME}"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                url, headers={"Authorization": f"Bearer {_HERMES_CLIENT_TOKEN}"}
            )
            resp.raise_for_status()
            data = resp.json()
    except (httpx.HTTPError, ValueError) as exc:
        log.error("hermes broker fetch failed for %s/%s: %s", SERVICE, SCHEME, exc)
        raise RuntimeError(
            f"Hermes is configured but the broker fetch for {SERVICE}/{SCHEME} failed"
        ) from exc
    token = data.get("token") or data.get("access_token") or data.get("value")
    if not token:
        raise RuntimeError(f"Hermes returned no token for {SERVICE}/{SCHEME}")
    return str(token)


def _standalone_credential() -> str:
    """Read the credential from the environment (Hermes-free path)."""
    for var in (f"{SERVICE.upper()}_TOKEN", f"{SERVICE.upper()}_API_KEY", f"{SERVICE.upper()}_SESSION"):
        val = os.environ.get(var)
        if val:
            return val
    raise RuntimeError(
        f"No credential for {SERVICE}: set HERMES_URL/HERMES_CLIENT_TOKEN or "
        f"{SERVICE.upper()}_TOKEN/_API_KEY/_SESSION"
    )


async def get_token() -> str:
    """Return the raw credential value (Hermes broker or standalone)."""
    if _hermes_configured():
        return await _fetch_from_hermes()
    return _standalone_credential()


async def get_auth_headers() -> dict[str, str]:
    """Stable contract every generated tool depends on, regardless of auth mode."""
    token = await get_token()
    if SCHEME == "session":
        return {"Cookie": token}
    if SCHEME == "api_key":
        header = os.environ.get(f"{SERVICE.upper()}_API_KEY_HEADER", "X-API-Key")
        return {header: token}
    return {"Authorization": f"Bearer {token}"}


__all__ = ["SERVICE", "SCHEME", "get_token", "get_auth_headers"]
