import hmac
import json
import os

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.concurrency import run_in_threadpool
from starlette.responses import JSONResponse, PlainTextResponse, Response
from starlette.routing import Route
import uvicorn
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings

from app.factory import build_from_env
from app.web_search_tool import WebTools


class BearerAuthMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, token: str) -> None:
        super().__init__(app)
        self._token = token

    async def dispatch(self, request: Request, call_next) -> Response:
        if request.url.path in {"/healthz", "/health"}:
            return await call_next(request)
        auth = request.headers.get("authorization", "")
        if not hmac.compare_digest(auth.encode(), f"Bearer {self._token}".encode()):
            return PlainTextResponse("unauthorized", status_code=401)
        return await call_next(request)


def _create_mcp(tools: WebTools) -> FastMCP:
    # Streamable HTTP validates Host against localhost by default and returns
    # 421 for Docker DNS names such as web-search-mcp:8000.
    mcp = FastMCP(
        "web-search",
        stateless_http=True,
        json_response=True,
        session_idle_timeout=3600,
        transport_security=TransportSecuritySettings(
            enable_dns_rebinding_protection=True,
            allowed_hosts=[
                "web-search-mcp",
                "web-search-mcp:8000",
                "localhost",
                "127.0.0.1",
                "localhost:8000",
                "127.0.0.1:8000",
            ],
        ),
    )
    mcp.settings.streamable_http_path = "/mcp"

    @mcp.tool()
    async def web_search(query: str, n: int = 0) -> str:
        """Discover web pages for a search query.

        Use this when you do not yet know which page has the answer. It runs a
        web search, reads the top results, and returns each result's title, URL,
        snippet and main-text markdown. To read one page whose URL you already
        know, use fetch_url instead.

        Args:
            query: Search terms, as you would type them into a search engine.
            n: Number of results to read; 0 uses the server default.
        """
        return await run_in_threadpool(tools.search.run, query, None if n < 1 else n)

    @mcp.tool()
    async def fetch_url(url: str, max_chars: int = 0) -> str:
        """Read one known web page and return its main content as markdown.

        Use this when you already have a URL, for example from the user or
        from a web_search result, and need the full page text. It does not
        search. The result starts with "# <title>" and "URL: <final URL>".
        HTML, plain text, markdown and JSON are supported; PDFs, images and
        other binary files are not.

        Args:
            url: Absolute http:// or https:// URL to read.
            max_chars: Maximum characters to return; 0 uses the server limit.
        """
        return await run_in_threadpool(tools.fetch.run, url, max_chars)

    return mcp


async def _health(_request: Request) -> Response:
    return PlainTextResponse("ok")


async def _json_body(request: Request) -> dict:
    try:
        body = await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError):
        return {}
    return body if isinstance(body, dict) else {}


def _search_endpoint(tools: WebTools):
    async def search(request: Request) -> Response:
        body = await _json_body(request)
        query = body.get("query")
        count = body.get("count", 5)
        if not isinstance(query, str) or not query.strip():
            return JSONResponse({"error": "query must be a non-empty string"}, status_code=400)
        if not isinstance(count, int) or isinstance(count, bool):
            return JSONResponse({"error": "count must be an integer"}, status_code=400)
        try:
            hits = await run_in_threadpool(tools.search.search, query.strip(), count)
        except RuntimeError as exc:
            return JSONResponse({"error": str(exc)}, status_code=502)
        return JSONResponse([{"link": hit.url, "title": hit.title, "snippet": hit.snippet} for hit in hits])

    return search


def _fetch_endpoint(tools: WebTools):
    async def fetch(request: Request) -> Response:
        body = await _json_body(request)
        urls = body.get("urls")
        if not isinstance(urls, list) or not all(isinstance(url, str) for url in urls):
            return JSONResponse({"error": "urls must be a list of strings"}, status_code=400)
        return JSONResponse(await run_in_threadpool(tools.fetch.documents, urls))

    return fetch


def create_app():
    token = os.environ.get("WEB_SEARCH_MCP_TOKEN") or ""
    if not token:
        raise SystemExit("Set WEB_SEARCH_MCP_TOKEN")
    tools = build_from_env()
    mcp = _create_mcp(tools)
    app = mcp.streamable_http_app()
    app.router.routes[0:0] = [
        Route("/healthz", _health),
        Route("/search", _search_endpoint(tools), methods=["POST"]),
        Route("/fetch", _fetch_endpoint(tools), methods=["POST"]),
    ]
    app.add_middleware(BearerAuthMiddleware, token=token)
    return app


def main() -> None:
    uvicorn.run(
        create_app(),
        host="0.0.0.0",
        port=int(os.environ.get("PORT") or "8000"),
    )


if __name__ == "__main__":
    main()
