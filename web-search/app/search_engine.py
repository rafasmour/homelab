from abc import ABC, abstractmethod
from dataclasses import dataclass
import json
import os
from typing import Optional
from urllib.error import URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


@dataclass(frozen=True)
class SearchHit:
    title: str
    url: str
    snippet: str = ""


class SearchEngine(ABC):
    @abstractmethod
    def query(self, search: str, n: int) -> list[SearchHit]:
        raise NotImplementedError


class SearxngSearchEngine(SearchEngine):
    def __init__(self, base_url: Optional[str] = None) -> None:
        self._base_url = (base_url or os.environ.get("SEARXNG_URL") or "http://searxng:8080").rstrip("/")
        # SearXNG waits for its slowest selected engine up to this many seconds
        # (capped by its outgoing.max_request_timeout), then answers with what it has.
        self._timeout_limit = float(os.environ.get("SEARXNG_TIMEOUT_LIMIT") or "3")
        self._engines = (os.environ.get("SEARXNG_ENGINES") or "").strip()
        self._categories = (os.environ.get("SEARXNG_CATEGORIES") or "").strip()
        # SearXNG merges URL parameters into the request's preferences, so
        # disabled_engines turns engines off for these queries only. Its keys
        # are "<engine>__<category>"; unknown names are ignored.
        categories = [c.strip() for c in self._categories.split(",") if c.strip()] or ["general"]
        self._disabled = ",".join(
            f"{name}__{category}"
            for name in (n.strip() for n in (os.environ.get("SEARXNG_DISABLED_ENGINES") or "").split(","))
            if name
            for category in dict.fromkeys(categories + ["web"])
        )

    def query(self, search: str, n: int) -> list[SearchHit]:
        if n < 1:
            return []
        params: dict[str, str] = {"q": search, "format": "json"}
        if self._timeout_limit > 0:
            params["timeout_limit"] = f"{self._timeout_limit:g}"
        if self._engines:
            params["engines"] = self._engines
        if self._categories:
            params["categories"] = self._categories
        if self._disabled:
            params["disabled_engines"] = self._disabled
        request = Request(
            f"{self._base_url}/search?{urlencode(params)}",
            headers={
                "Accept": "application/json",
                "User-Agent": "web-search-mcp",
            },
        )
        timeout = self._timeout_limit + 5 if self._timeout_limit > 0 else 20
        try:
            with urlopen(request, timeout=timeout) as response:
                payload = json.load(response)
        except (URLError, TimeoutError, json.JSONDecodeError, OSError) as exc:
            raise RuntimeError(f"SearXNG query failed: {exc}") from exc

        hits: list[SearchHit] = []
        for item in payload.get("results") or []:
            if not isinstance(item, dict):
                continue
            url = item.get("url")
            if not isinstance(url, str) or not url.startswith(("http://", "https://")):
                continue
            title = item.get("title") if isinstance(item.get("title"), str) else url
            snippet = item.get("content") if isinstance(item.get("content"), str) else ""
            hits.append(SearchHit(title=title.strip() or url, url=url, snippet=snippet.strip()))
            if len(hits) >= n:
                break
        return hits
