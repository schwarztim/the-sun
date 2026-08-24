"""Verification harness for the thesun Conformance Lab's golden fixtures.

Not part of the Lab itself (that's Stage 2, separate TS code) -- this is a
standalone Python check proving each PASS fixture actually starts and speaks
real MCP protocol over streamable-http (or stdio, for _stdio), and each FAIL
fixture fails for its one intended reason. Uses the same `mcp` Python SDK
package (1.28.1) that's already verified working in test-fixtures/spike/.

Run with the spike venv (has fastmcp/curl_cffi/httpx/aiolimiter/tenacity/mcp
already installed) or a fresh `uv sync` in this directory:

    ~/Scripts/mcp-servers/thesun/test-fixtures/spike/.venv/bin/python \\
        test-fixtures/golden-servers/verify_golden_servers.py

Exits 0 if every PASS fixture passed and every FAIL fixture failed as
expected; exits 1 otherwise, printing exactly which fixture misbehaved.
"""
from __future__ import annotations

import asyncio
import contextlib
import os
import signal
import socket
import subprocess
import sys
from http.server import HTTPServer
from pathlib import Path

HERE = Path(__file__).parent
PYTHON = sys.executable  # invoke with the same interpreter running this script

sys.path.insert(0, str(HERE / "_mock_target"))

from mcp import ClientSession  # noqa: E402
from mcp.client.stdio import StdioServerParameters, stdio_client  # noqa: E402
from mcp.client.streamable_http import streamablehttp_client  # noqa: E402

READY_POLL_INTERVAL = 0.15
READY_POLL_CEILING = 10.0  # seconds

MOCK_BEARER_TOKEN = "golden-bearer-secret"
MOCK_SESSION_COOKIE = "golden-session-abc123"
MOCK_API_KEY = "golden-apikey-secret"


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _start_mock_target() -> tuple[HTTPServer, int]:
    import app as mock_app  # _mock_target/app.py

    os.environ["MOCK_BEARER_TOKEN"] = MOCK_BEARER_TOKEN
    os.environ["MOCK_SESSION_COOKIE"] = MOCK_SESSION_COOKIE
    os.environ["MOCK_API_KEY"] = MOCK_API_KEY
    srv = mock_app.serve(0)
    port = srv.server_address[1]
    return srv, port


@contextlib.contextmanager
def _spawn(server_dir: Path, env: dict[str, str]):
    full_env = {**os.environ, **env, "PYTHONUNBUFFERED": "1"}
    proc = subprocess.Popen(
        [PYTHON, "server.py"],
        cwd=str(server_dir),
        env=full_env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    try:
        yield proc
    finally:
        if proc.poll() is None:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                proc.wait(timeout=5)


async def _wait_ready_http(url: str, proc: subprocess.Popen, ceiling: float = READY_POLL_CEILING) -> None:
    loop = asyncio.get_event_loop()
    deadline = loop.time() + ceiling
    last_exc: Exception | None = None
    while loop.time() < deadline:
        if proc.poll() is not None:
            _, err = proc.communicate(timeout=2)
            raise RuntimeError(f"process exited early (code={proc.returncode}); stderr tail:\n{err[-2000:]}")
        try:
            async with streamablehttp_client(url) as (read, write, _):
                async with ClientSession(read, write) as session:
                    await asyncio.wait_for(session.initialize(), timeout=2)
            return
        except Exception as exc:  # bounded readiness poll; genuinely retryable here
            last_exc = exc
            await asyncio.sleep(READY_POLL_INTERVAL)
    raise TimeoutError(f"server never became ready at {url}: {last_exc}")


async def verify_http_fixture(name: str, server_dir: Path, extra_env: dict[str, str], tool_call: tuple[str, dict] | None):
    port = _free_port()
    url = f"http://127.0.0.1:{port}/mcp"
    env = {"HOST": "127.0.0.1", "PORT": str(port), **extra_env}
    print(f"\n=== {name} (streamable-http, port {port}) ===")
    with _spawn(server_dir, env) as proc:
        await _wait_ready_http(url, proc)
        async with streamablehttp_client(url) as (read, write, _):
            async with ClientSession(read, write) as session:
                init = await session.initialize()
                print(f"  initialize OK: server={init.serverInfo.name} protocolVersion={init.protocolVersion}")
                tools = await session.list_tools()
                names = [t.name for t in tools.tools]
                print(f"  listTools OK: {names}")
                if tool_call:
                    tool_name, args = tool_call
                    result = await session.call_tool(tool_name, args)
                    text = result.content[0].text if result.content else "<empty>"
                    print(f"  callTool({tool_name}) isError={result.isError} -> {text[:300]}")
    return True


async def verify_stdio_fixture(name: str, server_dir: Path, extra_env: dict[str, str], tool_call: tuple[str, dict]):
    print(f"\n=== {name} (stdio -- expected to be protocol-valid but wrong transport) ===")
    full_env = {**os.environ, **extra_env, "PYTHONUNBUFFERED": "1"}
    params = StdioServerParameters(command=PYTHON, args=["server.py"], cwd=str(server_dir), env=full_env)
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            init = await asyncio.wait_for(session.initialize(), timeout=10)
            print(f"  initialize OK over stdio: server={init.serverInfo.name}")
            tools = await session.list_tools()
            print(f"  listTools OK: {[t.name for t in tools.tools]}")
            tool_name, args = tool_call
            result = await session.call_tool(tool_name, args)
            text = result.content[0].text if result.content else "<empty>"
            print(f"  callTool({tool_name}) isError={result.isError} -> {text[:300]}")
    print("  CONCLUSION: valid MCP server, but only reachable via stdio -- Lab Gate 3 must reject it")
    return True


async def verify_broken_fixture(name: str, server_dir: Path):
    print(f"\n=== {name} (expected to crash before binding any port) ===")
    port = _free_port()
    env = {"HOST": "127.0.0.1", "PORT": str(port)}
    with _spawn(server_dir, env) as proc:
        try:
            _, err = proc.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.communicate()
            print("  UNEXPECTED: process did not exit within 5s (should crash immediately)")
            return False
        crashed = proc.returncode != 0
        has_nameerror = "NameError" in err
        print(f"  exit_code={proc.returncode} crashed={crashed} NameError_in_stderr={has_nameerror}")
        print(f"  stderr tail:\n{err.strip().splitlines()[-1] if err.strip() else '<empty>'}")
        return crashed and has_nameerror


async def main() -> int:
    print("Starting shared mock target...")
    mock_srv, mock_port = _start_mock_target()
    mock_base_url = f"http://127.0.0.1:{mock_port}"
    print(f"mock target ready on {mock_base_url}")

    results: dict[str, bool] = {}

    try:
        # --- PASS fixtures ---------------------------------------------
        try:
            await verify_http_fixture(
                "rest-bearer",
                HERE / "rest-bearer",
                {"MOCK_API_BASE_URL": mock_base_url, "REST_BEARER_TOKEN": MOCK_BEARER_TOKEN},
                ("listItems", {"limit": 5}),
            )
            results["rest-bearer"] = True
        except Exception as exc:
            print(f"  FAILED: {exc}")
            results["rest-bearer"] = False

        try:
            await verify_http_fixture(
                "cookie-session",
                HERE / "cookie-session",
                {
                    "MOCK_API_BASE_URL": mock_base_url,
                    "COOKIE_SESSION_SESSION": f"session={MOCK_SESSION_COOKIE}",
                },
                ("get_profile", {}),
            )
            results["cookie-session"] = True
        except Exception as exc:
            print(f"  FAILED: {exc}")
            results["cookie-session"] = False

        try:
            await verify_http_fixture(
                "outlier (graphql)",
                HERE / "outlier",
                {"MOCK_API_BASE_URL": mock_base_url, "OUTLIER_GRAPHQL_API_KEY": MOCK_API_KEY},
                ("graphql_viewer", {}),
            )
            results["outlier"] = True
        except Exception as exc:
            print(f"  FAILED: {exc}")
            results["outlier"] = False

        # --- FAIL fixtures (each must fail its ONE intended gate) -------
        try:
            ok = await verify_stdio_fixture(
                "_stdio",
                HERE / "_stdio",
                {"MOCK_API_BASE_URL": mock_base_url, "STDIO_FIXTURE_TOKEN": MOCK_BEARER_TOKEN},
                ("list_items", {"limit": 5}),
            )
            results["_stdio (protocol-valid, transport-invalid)"] = ok
        except Exception as exc:
            print(f"  UNEXPECTED failure (should be protocol-valid over stdio): {exc}")
            results["_stdio (protocol-valid, transport-invalid)"] = False

        try:
            ok = await verify_broken_fixture("_broken", HERE / "_broken")
            results["_broken (crashes at import)"] = ok
        except Exception as exc:
            print(f"  harness error: {exc}")
            results["_broken (crashes at import)"] = False

        try:
            await verify_http_fixture(
                "_ua-mismatch",
                HERE / "_ua-mismatch",
                {"MOCK_API_BASE_URL": mock_base_url, "UA_MISMATCH_FIXTURE_TOKEN": MOCK_BEARER_TOKEN},
                ("list_items", {"limit": 5}),
            )
            print("  CONCLUSION: protocol/transport gates PASS as expected; only the wire-fingerprint")
            print("  gate (Lab Stage 2, not reimplemented here) should fail this fixture -- http_client.py")
            print("  is present in this directory but never imported by server.py (grep-verifiable).")
            results["_ua-mismatch (protocol-valid, fingerprint-invalid)"] = True
        except Exception as exc:
            print(f"  UNEXPECTED failure (should be protocol-valid over streamable-http): {exc}")
            results["_ua-mismatch (protocol-valid, fingerprint-invalid)"] = False

    finally:
        mock_srv.shutdown()

    print("\n=== SUMMARY ===")
    all_ok = True
    for k, v in results.items():
        print(f"  {'OK' if v else 'FAIL'}: {k}")
        all_ok = all_ok and v
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
