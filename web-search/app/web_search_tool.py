from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
import os
import threading

from app.extract_main import ExtractMainContent
from app.feed_to_markdown import NotAFeed, feed_to_markdown
from app.fetch_website import FetchWebsite
from app.html_to_markdown import HTMLToMarkdown
from app.search_engine import SearchEngine, SearchHit

_HTML_TYPES = {"text/html", "application/xhtml+xml"}
_FEED_TYPES = {"application/rss+xml", "application/atom+xml", "application/xml", "text/xml"}
_TEXT_TYPES = {"text/plain", "text/markdown", "text/x-markdown", "application/json"}
_MAX_BATCH = 20
_PARSE_LOCK = threading.Lock()


class UnsupportedContent(ValueError):
    pass


@dataclass(frozen=True)
class Page:
    url: str
    title: str
    markdown: str

    def render(self) -> str:
        return f"# {self.title}\nURL: {self.url}\n\n{self.markdown}"


class PageReader:
    def __init__(
        self,
        fetcher: FetchWebsite,
        extractor: ExtractMainContent,
        markdown: HTMLToMarkdown,
    ) -> None:
        self._fetcher = fetcher
        self._extractor = extractor
        self._markdown = markdown
        self._workers = max(1, int(os.environ.get("WEB_SEARCH_FETCH_WORKERS") or "4"))

    def read(self, url: str) -> Page:
        result = self._fetcher.fetch(url)
        media = result.media_type
        text = result.text()
        if media in _HTML_TYPES or (not media and text.lstrip()[:1] == "<"):
            with _PARSE_LOCK:
                title = self._extractor.title(text)
                body = self._markdown.format(self._extractor.extract(text))
        elif media in _FEED_TYPES or media.endswith("+xml"):
            try:
                with _PARSE_LOCK:
                    title, body = feed_to_markdown(result.body)
            except NotAFeed:
                title, body = "", text.strip()
        elif not media or media in _TEXT_TYPES or media.endswith("+json"):
            title = ""
            body = text.strip()
        else:
            raise UnsupportedContent(
                f"unsupported content type {media!r}; only HTML, plain text, markdown, JSON and RSS/Atom feeds can be read"
            )
        if not body:
            raise ValueError("empty page")
        return Page(url=result.url, title=title or result.url, markdown=body)

    def read_many(self, urls: list[str]) -> list[Page | Exception]:
        if not urls:
            return []
        with ThreadPoolExecutor(max_workers=min(self._workers, len(urls))) as pool:
            return list(pool.map(self._read_safe, urls))

    def _read_safe(self, url: str) -> Page | Exception:
        try:
            return self.read(url)
        except Exception as exc:
            return exc


class WebSearchTool:
    def __init__(self, engine: SearchEngine, reader: PageReader) -> None:
        self._engine = engine
        self._reader = reader
        self._default_n = int(os.environ.get("WEB_SEARCH_RESULT_COUNT") or "5")
        self._max_n = int(os.environ.get("WEB_SEARCH_MAX_RESULTS") or "8")
        self._page_chars = int(os.environ.get("WEB_SEARCH_PAGE_CHARS") or "8000")
        self._total_chars = int(os.environ.get("WEB_SEARCH_TOTAL_CHARS") or "40000")

    def search(self, query: str, count: int) -> list[SearchHit]:
        return self._engine.query(query, max(1, min(count, _MAX_BATCH)))

    def run(self, query: str, n: int | None = None) -> str:
        count = self._default_n if n is None or n < 1 else min(n, self._max_n)
        hits = self._engine.query(query, count)
        if not hits:
            return f"No search results for {query!r}."

        pages = self._reader.read_many([hit.url for hit in hits])
        sections: list[str] = []
        used = 0
        for index, (hit, page) in enumerate(zip(hits, pages), start=1):
            header = f"## {index}. {hit.title}\nURL: {hit.url}"
            if hit.snippet:
                header += f"\nSnippet: {hit.snippet}"
            if isinstance(page, Exception):
                body = f"Could not extract page: {page}"
            else:
                body = _cap(page.markdown, self._page_chars)
            block = f"{header}\n\n{body}"
            if used + len(block) > self._total_chars and sections:
                break
            sections.append(_cap(block, self._total_chars - used))
            used += len(sections[-1])
        return "\n\n".join(sections)


class FetchUrlTool:
    def __init__(self, reader: PageReader) -> None:
        self._reader = reader
        self._max_chars = int(os.environ.get("WEB_FETCH_MAX_CHARS") or "20000")

    def _limit(self, max_chars: int) -> int:
        return self._max_chars if max_chars < 1 else min(max_chars, self._max_chars)

    def run(self, url: str, max_chars: int = 0) -> str:
        url = url.strip()
        try:
            page = self._reader.read(url)
        except Exception as exc:
            return f"Could not fetch {url}: {exc}"
        return _cap(page.render(), self._limit(max_chars))

    def documents(self, urls: list[str]) -> list[dict]:
        urls = [url.strip() for url in urls[:_MAX_BATCH]]
        documents: list[dict] = []
        for url, page in zip(urls, self._reader.read_many(urls)):
            if isinstance(page, Exception):
                continue
            documents.append(
                {
                    "page_content": _cap(page.markdown, self._max_chars),
                    "metadata": {"source": url, "title": page.title},
                }
            )
        return documents


@dataclass(frozen=True)
class WebTools:
    search: WebSearchTool
    fetch: FetchUrlTool


def _cap(text: str, limit: int) -> str:
    if limit < 1 or len(text) <= limit:
        return text
    return text[: max(0, limit - 3)].rstrip() + "..."
