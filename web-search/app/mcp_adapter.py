import os

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import PlainTextResponse, Response
from starlette.routing import Route
import uvicorn
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings

from app.factory import build_from_env
from app.web_search_tool import WebSearchTool


class BearerAuthMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, token: str) -> None:
        super().__init__(app)
        self._token = token

    async def dispatch(self, request: Request, call_next) -> Response:
        if request.url.path in {"/healthz", "/health"}:
            return await call_next(request)
        auth = request.headers.get("authorization", "")
        if auth != f"Bearer {self._token}":
            return PlainTextResponse("unauthorized", status_code=401)
        return await call_next(request)


def _create_mcp(tool: WebSearchTool) -> FastMCP:
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
    def web_search(query: str, n: int = 0) -> str:
        """Search the web, fetch the top results, and return main-body markdown."""
        return tool.run(query, None if n < 1 else n)

    return mcp


async def _health(_request: Request) -> Response:
    return PlainTextResponse("ok")


def create_app():
    token = os.environ.get("WEB_SEARCH_MCP_TOKEN") or ""
    if not token:
        raise SystemExit("Set WEB_SEARCH_MCP_TOKEN")
    mcp = _create_mcp(build_from_env())
    app = mcp.streamable_http_app()
    app.router.routes.insert(0, Route("/healthz", _health))
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
