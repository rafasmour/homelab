import os

from app.extract_main import ExtractMainContent, TrafilaturaMainContent
from app.fetch_headers import CurlRecommendedHeaders, FetchHeaders
from app.fetch_website import CurlFetchWebsite, FetchWebsite
from app.html_to_markdown import HTMLToMarkdown, MarkdownifyHtmlToMarkdown
from app.search_engine import SearchEngine, SearxngSearchEngine
from app.web_search_tool import WebSearchTool

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


def build_from_env() -> WebSearchTool:
    headers = _select("FETCH_HEADERS", "curl_recommended", _HEADERS)()
    fetcher = _select("FETCH_WEBSITE", "curl", _FETCHERS)(headers)
    engine = _select("SEARCH_ENGINE", "searxng", _ENGINES)()
    extractor = _select("EXTRACT_MAIN_CONTENT", "trafilatura", _EXTRACTORS)()
    markdown = _select("HTML_TO_MARKDOWN", "markdownify", _MARKDOWNERS)()
    return WebSearchTool(engine, fetcher, extractor, markdown)
