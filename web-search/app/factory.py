import os

from app.extract_main import ExtractMainContent, TrafilaturaMainContent
from app.fetch_headers import CurlRecommendedHeaders, FetchHeaders
from app.fetch_website import CurlFetchWebsite, FetchWebsite
from app.html_to_markdown import HTMLToMarkdown, MarkdownifyHtmlToMarkdown
from app.search_engine import SearchEngine, SearxngSearchEngine
from app.url_guard import AllowPrivateGuard, PublicOnlyGuard, UrlGuard
from app.web_search_tool import FetchUrlTool, PageReader, WebSearchTool, WebTools

_HEADERS: dict[str, type[FetchHeaders]] = {
    "curl_recommended": CurlRecommendedHeaders,
}
_FETCHERS: dict[str, type[FetchWebsite]] = {
    "curl": CurlFetchWebsite,
}
_ENGINES: dict[str, type[SearchEngine]] = {
    "searxng": SearxngSearchEngine,
}
_EXTRACTORS: dict[str, type[ExtractMainContent]] = {
    "trafilatura": TrafilaturaMainContent,
}
_MARKDOWNERS: dict[str, type[HTMLToMarkdown]] = {
    "markdownify": MarkdownifyHtmlToMarkdown,
}


def _select(env_name: str, default: str, table: dict) -> type:
    key = os.environ.get(env_name) or default
    try:
        return table[key]
    except KeyError:
        expected = ", ".join(sorted(table))
        raise SystemExit(f"Unknown {env_name}={key!r}; expected {expected}") from None


def _guard_from_env() -> UrlGuard:
    value = (os.environ.get("FETCH_ALLOW_PRIVATE") or "false").strip().lower()
    if value in {"1", "true", "yes"}:
        return AllowPrivateGuard()
    if value in {"0", "false", "no"}:
        return PublicOnlyGuard()
    raise SystemExit(f"Unknown FETCH_ALLOW_PRIVATE={value!r}; expected true or false")


def build_from_env() -> WebTools:
    headers = _select("FETCH_HEADERS", "curl_recommended", _HEADERS)()
    fetcher = _select("FETCH_WEBSITE", "curl", _FETCHERS)(headers, _guard_from_env())
    engine = _select("SEARCH_ENGINE", "searxng", _ENGINES)()
    extractor = _select("EXTRACT_MAIN_CONTENT", "trafilatura", _EXTRACTORS)()
    markdown = _select("HTML_TO_MARKDOWN", "markdownify", _MARKDOWNERS)()
    reader = PageReader(fetcher, extractor, markdown)
    return WebTools(search=WebSearchTool(engine, reader), fetch=FetchUrlTool(reader))
