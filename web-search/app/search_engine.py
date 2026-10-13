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

    def query(self, search: str, n: int) -> list[SearchHit]:
        if n < 1:
            return []
        params = urlencode({"q": search, "format": "json"})
        request = Request(
            f"{self._base_url}/search?{params}",
            headers={
                "Accept": "application/json",
                "User-Agent": "web-search-mcp",
            },
        )
        try:
            with urlopen(request, timeout=20) as response:
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
