"""Benchmark MCP server for the Hermes `models` profile.

Streamable HTTP MCP endpoint at http://0.0.0.0:8793/mcp, protected by
`Authorization: Bearer $BENCHMARK_MCP_TOKEN`. It talks only to the runner's job
API (BENCH_API_URL, bearer BENCH_API_TOKEN) and holds no Docker socket, files
or shell. The calling model is assumed to be prompt-injectable: every argument
is validated here (and again by the runner) against fixed enums, a pattern or
the live preset list; errors are short fixed messages.
"""

import hmac
import json
import os
import re
import sys

import httpx

BENCH_API_URL = os.environ.get("BENCH_API_URL", "http://benchmark:8780").rstrip("/")
BENCH_API_TOKEN = os.environ.get("BENCH_API_TOKEN", "")
LISTEN_PORT = 8793
ALLOWED_HOSTS = ["benchmark-mcp:8793", "benchmark-mcp", "localhost:8793", "127.0.0.1:8793"]
SUITES = ("all", "cron", "chat")
PROFILES = ("ai-news", "calories", "default", "finance", "hf-models",
            "llamacpp-rocm", "llamacpp-vulkan", "nextcloud", "selfhosted")
MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
RUN_RE = re.compile(r"^(latest|\d{4}-\d{2}-\d{2}_\d{2}-\d{2}(-\d{1,3})?)$")
TIMEOUT = 20.0
OUTPUT_LIMIT = 30_000


class ToolError(Exception):
    """Short, fixed, user-facing message (never contains secrets or URLs)."""


async def api(method, path, body=None):
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=False) as client:
            r = await client.request(method, BENCH_API_URL + path, json=body,
                                     headers={"Authorization": "Bearer " + BENCH_API_TOKEN})
    except httpx.HTTPError:
        raise ToolError("benchmark runner is unreachable")
    try:
        data = r.json()
    except ValueError:
        raise ToolError("benchmark runner returned an invalid response")
    if r.status_code >= 400:
        msg = data.get("error") if isinstance(data, dict) else None
        raise ToolError("runner refused: " + str(msg)[:200] if msg else "runner error %d" % r.status_code)
    return data


def render(data):
    text = json.dumps(data, indent=1, sort_keys=True)
    if len(text) > OUTPUT_LIMIT:
        text = text[:OUTPUT_LIMIT] + "\n[truncated]"
    return text


async def models_list():
    names = (await api("GET", "/models"))["models"]
    return render({"models": names})


def check_model(model):
    if not isinstance(model, str) or not MODEL_RE.fullmatch(model):
        raise ToolError("model must be a preset name from list_models")
    return model


async def t_start(model, suite="all", profile=None):
    check_model(model)
    if suite not in SUITES:
        raise ToolError("suite must be one of: " + ", ".join(SUITES))
    if profile is not None and profile not in PROFILES:
        raise ToolError("profile must be one of: " + ", ".join(PROFILES))
    # Presets are re-read on every call, so a freshly added preset works at once.
    if model not in (await api("GET", "/models"))["models"]:
        raise ToolError("model is not a benchmarkable preset; call list_models")
    status = await api("GET", "/status")
    if status.get("active"):
        raise ToolError("a benchmark run is already active; call benchmark_status and wait for it")
    body = {"model": model, "suite": suite}
    if profile is not None:
        body["profile"] = profile
    return render(await api("POST", "/runs", body))


async def t_status():
    return render(await api("GET", "/status"))


async def t_results(run_id="latest"):
    if not isinstance(run_id, str) or not RUN_RE.fullmatch(run_id):
        raise ToolError("run_id must be 'latest' or a run id like 2026-10-27_17-09")
    return render(await api("GET", "/runs/" + run_id))


async def t_cancel():
    return render(await api("POST", "/runs/cancel", {}))


def safe_tool(func):
    import functools

    @functools.wraps(func)
    async def wrapper(*args, **kwargs):
        try:
            return await func(*args, **kwargs)
        except ToolError as e:
            return "Error: " + str(e)
        except Exception:
            return "Error: internal error"
    return wrapper


def build_server():
    from typing import Annotated, Any

    from mcp.server.mcpserver import MCPServer
    from mcp.types import ToolAnnotations
    from pydantic import WithJsonSchema

    model_arg = Annotated[Any, WithJsonSchema(
        {"type": "string", "pattern": MODEL_RE.pattern, "description": "preset name from list_models"})]
    suite_arg = Annotated[Any, WithJsonSchema({"type": "string", "enum": list(SUITES), "default": "all"})]
    profile_arg = Annotated[Any, WithJsonSchema({"type": ["string", "null"], "enum": list(PROFILES) + [None], "default": None})]
    run_arg = Annotated[Any, WithJsonSchema(
        {"type": "string", "pattern": RUN_RE.pattern, "default": "latest"})]

    server = MCPServer(
        name="benchmark",
        version="1",
        instructions=(
            "Hermes model benchmark. A run holds the llama.cpp router and the GPU for a long time "
            "(minutes to over an hour per model). Check benchmark_status first and never start a run "
            "while one is active."),
        log_level="WARNING",
    )
    read = ToolAnnotations(read_only_hint=True, destructive_hint=False, idempotent_hint=True, open_world_hint=False)
    write = ToolAnnotations(read_only_hint=False, destructive_hint=False, idempotent_hint=False, open_world_hint=False)

    def tool(annotations):
        return lambda func: server.tool(annotations=annotations, structured_output=False)(safe_tool(func))

    @tool(read)
    async def list_models() -> str:
        """Preset names of router-config.ini that the benchmark can run."""
        return await models_list()

    @tool(write)
    async def start_benchmark(model: model_arg, suite: suite_arg = "all", profile: profile_arg = None) -> str:
        """Start one benchmark run for a preset model (it unloads the current model, then reloads the production model).

        Refused when a run is already active. suite: all, cron or chat cases; profile: optionally only one Hermes profile's cases.
        """
        return await t_start(model, suite, profile)

    @tool(read)
    async def benchmark_status() -> str:
        """Active run with progress (cases done of total, log tail), or the last finished run."""
        return await t_status()

    @tool(read)
    async def get_results(run_id: run_arg = "latest") -> str:
        """Scores per model (cron_score, chat_score, pass_rate, load_s, ...) and per-case status of a run."""
        return await t_results(run_id)

    @tool(write)
    async def cancel_benchmark() -> str:
        """Abort the active run cleanly (cleanup runs and the production model is reloaded)."""
        return await t_cancel()

    return server


class BearerAuth:
    """ASGI middleware: constant-time bearer check; /healthz is open."""

    def __init__(self, app, token):
        self.app = app
        self.expected = ("Bearer " + token).encode()

    async def __call__(self, scope, receive, send):
        if scope["type"] == "lifespan":
            await self.app(scope, receive, send)
            return
        if scope["type"] != "http":
            await send({"type": "websocket.close", "code": 1008})
            return
        if scope.get("path") == "/healthz" and scope.get("method") == "GET":
            await _respond(send, 200, b'{"ok":true}')
            return
        values = [v for k, v in scope.get("headers") or [] if k.lower() == b"authorization"]
        supplied = values[0] if len(values) == 1 else b""
        if not hmac.compare_digest(supplied, self.expected):
            await _respond(send, 401, b'{"error":"unauthorized"}', [(b"www-authenticate", b"Bearer")])
            return
        await self.app(scope, receive, send)


async def _respond(send, status, body, extra=()):
    headers = [(b"content-type", b"application/json"),
               (b"content-length", str(len(body)).encode())] + list(extra)
    await send({"type": "http.response.start", "status": status, "headers": headers})
    await send({"type": "http.response.body", "body": body})


def build_app(token):
    from mcp.server.transport_security import TransportSecuritySettings

    app = build_server().streamable_http_app(
        streamable_http_path="/mcp",
        json_response=True,
        stateless_http=True,
        max_request_body_size=64 * 1024,
        transport_security=TransportSecuritySettings(
            enable_dns_rebinding_protection=True,
            allowed_hosts=ALLOWED_HOSTS,
            allowed_origins=[],
        ),
        host="0.0.0.0",
    )
    return BearerAuth(app, token)


def main():
    import uvicorn

    problems = []
    if len(os.environ.get("BENCHMARK_MCP_TOKEN", "")) < 16:
        problems.append("BENCHMARK_MCP_TOKEN is missing or shorter than 16 characters")
    if len(BENCH_API_TOKEN) < 16:
        problems.append("BENCH_API_TOKEN is missing or shorter than 16 characters")
    if problems:
        sys.stderr.write("\n".join(problems) + "\n")
        sys.exit(1)
    uvicorn.run(build_app(os.environ["BENCHMARK_MCP_TOKEN"]), host="0.0.0.0", port=LISTEN_PORT,
                log_level="warning", access_log=False, server_header=False, proxy_headers=False,
                timeout_keep_alive=30, limit_concurrency=16)


if __name__ == "__main__":
    main()
