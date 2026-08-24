"""Shared mock backend for the thesun golden-server fixtures.

Stdlib-only HTTP server (plain HTTP, no TLS) simulating three structurally
different API shapes so each golden fixture has something real to call:
  * Bearer-authenticated REST with cursor pagination   (rest-bearer/)
  * Cookie/session-authenticated REST                  (cookie-session/)
  * API-key-authenticated GraphQL                      (outlier/)

This is test INFRASTRUCTURE, not a fixture the Conformance Lab spawns or
verifies -- it does not use the http_client/ratelimit/auth templates and it
is not itself an MCP server. It exists so the golden servers' tool logic,
auth wiring, and pagination/GraphQL shapes can be exercised end-to-end.

Loopback plain-HTTP is intentional here: TLS/JA3/JA4 wire-fingerprint
verification against a real HTTPS target is the Conformance Lab's own job
(the Stage-0 capture harness), not reimplemented in this fixture.

Usage:
    python app.py [port]        # binds 127.0.0.1:<port>, default 8790, 0 = OS-assigned
Env overrides:
    MOCK_BEARER_TOKEN   (default "golden-bearer-secret")
    MOCK_SESSION_COOKIE (default "golden-session-abc123")
    MOCK_API_KEY        (default "golden-apikey-secret")
"""
from __future__ import annotations

import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

BEARER_TOKEN = os.environ.get("MOCK_BEARER_TOKEN", "golden-bearer-secret")
SESSION_COOKIE = os.environ.get("MOCK_SESSION_COOKIE", "golden-session-abc123")
API_KEY = os.environ.get("MOCK_API_KEY", "golden-apikey-secret")

# --- fixture data ---------------------------------------------------------
_ITEMS = [{"id": str(i), "name": f"widget-{i}", "value": i * 3} for i in range(1, 26)]
_PROFILE = {"id": "u-1", "name": "Golden Fixture User", "email": "fixture@example.test"}
_NOTES: list[dict] = []
_NEXT_ITEM_ID = [len(_ITEMS) + 1]


def _unauthorized(reason: str) -> tuple[int, dict]:
    return 401, {"error": "unauthorized", "reason": reason}


def _bearer_ok(headers) -> bool:
    return headers.get("Authorization", "") == f"Bearer {BEARER_TOKEN}"


def _cookie_ok(headers) -> bool:
    cookie = headers.get("Cookie", "")
    parts = [p.strip() for p in cookie.split(";")]
    return f"session={SESSION_COOKIE}" in parts


def _api_key_ok(headers) -> bool:
    return headers.get("X-Api-Key", headers.get("X-API-Key", "")) == API_KEY


class Handler(BaseHTTPRequestHandler):
    server_version = "thesun-golden-mock/1.0"

    def log_message(self, format, *args):  # noqa: A002 - matches base signature; silences access log
        pass

    # -- helpers ------------------------------------------------------
    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self) -> dict:
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return {}

    # -- routing --------------------------------------------------------
    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)

        if path == "/items":
            if not _bearer_ok(self.headers):
                status, body = _unauthorized("missing or invalid bearer token")
                return self._send_json(status, body)
            cursor = int(qs.get("cursor", ["0"])[0])
            limit = int(qs.get("limit", ["10"])[0])
            page = _ITEMS[cursor : cursor + limit]
            next_cursor = str(cursor + limit) if cursor + limit < len(_ITEMS) else None
            return self._send_json(200, {"items": page, "next_cursor": next_cursor})

        if path.startswith("/items/"):
            if not _bearer_ok(self.headers):
                status, body = _unauthorized("missing or invalid bearer token")
                return self._send_json(status, body)
            item_id = path.rsplit("/", 1)[-1]
            item = next((i for i in _ITEMS if i["id"] == item_id), None)
            if item is None:
                return self._send_json(404, {"error": "not_found"})
            return self._send_json(200, item)

        if path == "/profile":
            if not _cookie_ok(self.headers):
                status, body = _unauthorized("missing or invalid session cookie")
                return self._send_json(status, body)
            return self._send_json(200, {**_PROFILE, "notes": _NOTES})

        return self._send_json(404, {"error": "not_found"})

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/items":
            if not _bearer_ok(self.headers):
                status, body = _unauthorized("missing or invalid bearer token")
                return self._send_json(status, body)
            payload = self._read_json_body()
            new_id = str(_NEXT_ITEM_ID[0])
            _NEXT_ITEM_ID[0] += 1
            item = {"id": new_id, "name": payload.get("name", "unnamed"), "value": 0}
            _ITEMS.append(item)
            return self._send_json(201, item)

        if path == "/profile/notes":
            if not _cookie_ok(self.headers):
                status, body = _unauthorized("missing or invalid session cookie")
                return self._send_json(status, body)
            payload = self._read_json_body()
            note = {"id": str(len(_NOTES) + 1), "text": payload.get("text", "")}
            _NOTES.append(note)
            return self._send_json(201, note)

        if path == "/graphql":
            if not _api_key_ok(self.headers):
                status, body = _unauthorized("missing or invalid API key")
                # GraphQL convention: auth failures still returned as 401 JSON here
                # for simplicity; a real target may 200+errors[] instead.
                return self._send_json(status, body)
            payload = self._read_json_body()
            query = payload.get("query", "")
            variables = payload.get("variables", {}) or {}
            if "createWidget" in query:
                widget = {"id": str(_NEXT_ITEM_ID[0]), "name": variables.get("name", "unnamed")}
                _NEXT_ITEM_ID[0] += 1
                return self._send_json(200, {"data": {"createWidget": {"widget": widget}}})
            if "viewer" in query:
                return self._send_json(200, {"data": {"viewer": _PROFILE}})
            return self._send_json(
                200, {"errors": [{"message": f"Cannot resolve operation for query: {query[:60]!r}"}]}
            )

        return self._send_json(404, {"error": "not_found"})


def serve(port: int = 8790) -> HTTPServer:
    srv = HTTPServer(("127.0.0.1", port), Handler)
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    return srv


if __name__ == "__main__":
    p = int(sys.argv[1]) if len(sys.argv) > 1 else 8790
    server = HTTPServer(("127.0.0.1", p), Handler)
    bound_port = server.server_address[1]
    print(f"mock target listening on http://127.0.0.1:{bound_port}", flush=True)
    server.serve_forever()
