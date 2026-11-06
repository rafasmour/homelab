from concurrent.futures import ThreadPoolExecutor, wait
from dataclasses import dataclass
import logging
import os
import re
import threading
import time

from app.extract_main import ExtractMainContent
from app.feed_to_markdown import NotAFeed, feed_to_markdown
from app.fetch_website import FetchWebsite
from app.html_to_markdown import HTMLToMarkdown
from app.search_engine import SearchEngine, SearchHit

_HTML_TYPES = {"text/html", "application/xhtml+xml"}
_FEED_TYPES = {"application/rss+xml", "application/atom+xml", "application/xml", "text/xml"}
_TEXT_TYPES = {"text/plain", "text/markdown", "text/x-markdown", "application/json"}
_LOG = logging.getLogger("web_search")
_MAX_BATCH = 20
_PARSE_LOCK = threading.Lock()
# Extra time after the fetch deadline for pages that arrived in time to finish parsing.
_PARSE_GRACE = 0.5
_MD_IMAGE = re.compile(r"!\[[^\]]*\]\([^)]*\)")
_MD_LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")
_EXCERPT_MARK = "[excerpt — call fetch_url for the full page]"
_COMPLETE_MARK = "[complete page text, links omitted — no need to call fetch_url]"
# trafilatura's cost grows faster than linearly with page size (a 7.4 MB page
# took 13 s), and parsing is serialized by _PARSE_LOCK, so one huge page used
# to stall every other read. Scripts and styles (except JSON-LD metadata) are
# dropped first, then the HTML is capped. Excerpts only need the page start.
_SCRIPT_STYLE = re.compile(r"<(script|style)\b(?![^>]*ld\+json)[^>]*>.*?</\1\s*>", re.S | re.I)
_FULL_PARSE_CHARS = 2_000_000
_FULL_MARKDOWN_CHARS = 500_000
_EXCERPT_PARSE_CHARS = 500_000
_EXCERPT_MARKDOWN_CHARS = 50_000


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
        self._workers = max(1, int(os.environ.get("WEB_SEARCH_FETCH_WORKERS") or "8"))

    def read(self, url: str, time_budget: float | None = None, excerpt: bool = False) -> Page:
        """Fetch and convert url. excerpt=True parses only the start of large
        pages and skips title extraction (search results already have one)."""
        result = self._fetcher.fetch(url, time_budget)
        media = result.media_type
        text = result.text()
        if media in _HTML_TYPES or (not media and text.lstrip()[:1] == "<"):
            parse_cap = _EXCERPT_PARSE_CHARS if excerpt else _FULL_PARSE_CHARS
            markdown_cap = _EXCERPT_MARKDOWN_CHARS if excerpt else _FULL_MARKDOWN_CHARS
            text = _SCRIPT_STYLE.sub("", text)[:parse_cap]
            with _PARSE_LOCK:
                title = "" if excerpt else self._extractor.title(text)
                body = self._markdown.format(self._extractor.extract(text)[:markdown_cap])
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

    def read_many(
        self, urls: list[str], deadline: float | None = None, excerpt: bool = False
    ) -> list[Page | Exception]:
        """Read urls in parallel. With a deadline (seconds), each fetch gets that
        budget without retries, and pages still unfinished shortly after it are
        returned as TimeoutError instead of being waited for."""
        if not urls:
            return []
        pool = ThreadPoolExecutor(max_workers=min(self._workers, len(urls)))
        try:
            futures = [pool.submit(self._read_safe, url, deadline, excerpt) for url in urls]
            done, _ = wait(futures, timeout=None if deadline is None else deadline + _PARSE_GRACE)
        finally:
            # Do not block on stragglers; their curl calls end at the same budget.
            pool.shutdown(wait=False, cancel_futures=True)
        return [
            future.result() if future in done else TimeoutError(f"not read within {deadline:g}s")
            for future in futures
        ]

    def _read_safe(self, url: str, time_budget: float | None, excerpt: bool) -> Page | Exception:
        started = time.monotonic()
        try:
            result: Page | Exception = self.read(url, time_budget, excerpt)
        except Exception as exc:
            result = exc
        _LOG.debug(
            "read %.2fs %s %s",
            time.monotonic() - started,
            "ok" if isinstance(result, Page) else type(result).__name__,
            url,
        )
        return result


class WebSearchTool:
    def __init__(self, engine: SearchEngine, reader: PageReader) -> None:
        self._engine = engine
        self._reader = reader
        self._default_n = int(os.environ.get("WEB_SEARCH_RESULT_COUNT") or "5")
        self._max_n = int(os.environ.get("WEB_SEARCH_MAX_RESULTS") or "8")
        self._excerpt_chars = int(os.environ.get("WEB_SEARCH_EXCERPT_CHARS") or "1200")
        self._deadline = float(os.environ.get("WEB_SEARCH_FETCH_DEADLINE") or "2")
        # Overall budget (seconds) for search + page reads: pages get whatever
        # is left of it, at most the per-page deadline and at least 0.5 s.
        self._budget = float(os.environ.get("WEB_SEARCH_TOTAL_BUDGET") or "3")
        # Repeat queries inside this many seconds are answered from memory.
        self._cache_ttl = float(os.environ.get("WEB_SEARCH_CACHE_TTL") or "300")
        self._cache: dict[tuple[str, int], tuple[float, str]] = {}

    def search(self, query: str, count: int) -> list[SearchHit]:
        return self._engine.query(query, max(1, min(count, _MAX_BATCH)))

    def run(self, query: str, n: int | None = None) -> str:
        count = self._default_n if n is None or n < 1 else min(n, self._max_n)
        key = (query.strip().lower(), count)
        cached = self._cache.get(key)
        if cached and time.monotonic() - cached[0] < self._cache_ttl:
            return cached[1]
        text = self._run(query, count)
        if self._cache_ttl > 0 and not text.startswith("No search results"):
            if len(self._cache) > 200:
                self._cache.clear()
            self._cache[key] = (time.monotonic(), text)
        return text

    def _run(self, query: str, count: int) -> str:
        started = time.monotonic()
        hits = self._engine.query(query, count)
        searched = time.monotonic()
        if not hits:
            return f"No search results for {query!r}."

        if self._excerpt_chars > 0:
            page_deadline = max(0.5, min(self._deadline, self._budget - (searched - started)))
            pages = self._reader.read_many([hit.url for hit in hits], page_deadline, excerpt=True)
        else:
            pages = [None] * len(hits)
        _LOG.info(
            "search %.2fs, pages %.2fs, %d/%d pages read",
            searched - started,
            time.monotonic() - searched,
            sum(isinstance(page, Page) for page in pages),
            len(hits),
        )
        sections = [
            f"Search results for {query!r}. Each result shows a short excerpt of the page; "
            "call fetch_url only for a page whose excerpt is not enough."
        ]
        for index, (hit, page) in enumerate(zip(hits, pages), start=1):
            block = f"## {index}. {hit.title}\nURL: {hit.url}"
            if hit.snippet:
                block += f"\nSnippet: {hit.snippet}"
            if isinstance(page, Page):
                text, complete = _excerpt(page.markdown, self._excerpt_chars)
                block += f"\n\n{text}\n{_COMPLETE_MARK if complete else _EXCERPT_MARK}"
            elif isinstance(page, Exception):
                block += f"\n\n[page not read: {_cap(str(page), 200)} — call fetch_url if you need this page]"
            sections.append(block)
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


def _excerpt(markdown: str, limit: int) -> tuple[str, bool]:
    """Return (text, complete): the page start without link targets or images, cut at a word boundary."""
    text = _MD_IMAGE.sub("", markdown)
    text = _MD_LINK.sub(r"\1", text)
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    if len(text) <= limit:
        return text, True
    cut = text[:limit]
    boundary = max(cut.rfind(" "), cut.rfind("\n"))
    if boundary > limit * 0.8:
        cut = cut[:boundary]
    return cut.rstrip() + " …", False


def _cap(text: str, limit: int) -> str:
    if limit < 1 or len(text) <= limit:
        return text
    return text[: max(0, limit - 3)].rstrip() + "..."
