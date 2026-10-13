import os

from app.extract_main import ExtractMainContent
from app.fetch_website import FetchError, FetchWebsite
from app.html_to_markdown import HTMLToMarkdown
from app.search_engine import SearchEngine


class WebSearchTool:
    def __init__(
        self,
        engine: SearchEngine,
        fetcher: FetchWebsite,
        extractor: ExtractMainContent,
        markdown: HTMLToMarkdown,
    ) -> None:
        self._engine = engine
        self._fetcher = fetcher
        self._extractor = extractor
        self._markdown = markdown
        self._default_n = int(os.environ.get("WEB_SEARCH_RESULT_COUNT") or "5")
        self._max_n = int(os.environ.get("WEB_SEARCH_MAX_RESULTS") or "8")
        self._page_chars = int(os.environ.get("WEB_SEARCH_PAGE_CHARS") or "8000")
        self._total_chars = int(os.environ.get("WEB_SEARCH_TOTAL_CHARS") or "40000")

    def run(self, query: str, n: int | None = None) -> str:
        count = self._default_n if n is None or n < 1 else min(n, self._max_n)
        hits = self._engine.query(query, count)
        if not hits:
            return f"No search results for {query!r}."

        sections: list[str] = []
        used = 0
        for index, hit in enumerate(hits, start=1):
            header = f"## {index}. {hit.title}\nURL: {hit.url}"
            if hit.snippet:
                header += f"\nSnippet: {hit.snippet}"
            try:
                html = self._fetcher.fetch(hit.url)
                fragment = self._extractor.extract(html)
                body = self._markdown.format(fragment)
                if not body:
                    raise ValueError("empty markdown")
                body = _cap(body, self._page_chars)
            except (FetchError, ValueError, OSError) as exc:
                body = f"Could not extract page: {exc}"
            block = f"{header}\n\n{body}"
            if used + len(block) > self._total_chars and sections:
                break
            sections.append(_cap(block, self._total_chars - used))
            used += len(sections[-1])
        return "\n\n".join(sections)


def _cap(text: str, limit: int) -> str:
    if limit < 1 or len(text) <= limit:
        return text
    return text[: max(0, limit - 3)].rstrip() + "..."
