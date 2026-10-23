from abc import ABC, abstractmethod
from dataclasses import dataclass
import json
import subprocess
from urllib.parse import urlsplit
import uuid

from app.fetch_headers import FetchConfig, FetchHeaders
from app.url_guard import Target, UrlGuard, UrlRefused


class FetchError(Exception):
    pass


@dataclass(frozen=True)
class FetchResult:
    url: str
    content_type: str
    body: bytes

    @property
    def media_type(self) -> str:
        return self.content_type.split(";", 1)[0].strip().lower()

    def text(self) -> str:
        charset = "utf-8"
        for param in self.content_type.split(";")[1:]:
            key, _, value = param.partition("=")
            if key.strip().lower() == "charset" and value.strip():
                charset = value.strip().strip("\"'")
        try:
            return self.body.decode(charset, errors="replace")
        except LookupError:
            return self.body.decode("utf-8", errors="replace")


class FetchWebsite(ABC):
    @abstractmethod
    def fetch(self, url: str) -> FetchResult:
        raise NotImplementedError


class CurlFetchWebsite(FetchWebsite):
    """Follows redirects itself so every hop passes the URL guard and is pinned to the checked address."""

    def __init__(self, headers: FetchHeaders, guard: UrlGuard) -> None:
        self._headers = headers
        self._guard = guard

    def fetch(self, url: str) -> FetchResult:
        config = self._headers.headers()
        current = url
        for _ in range(config.max_redirs + 1):
            try:
                target = self._guard.check(current)
            except UrlRefused as exc:
                raise FetchError(str(exc)) from exc
            info, body = self._curl(current, target, config)
            status = int(info.get("http_code") or 0)
            location = info.get("redirect_url") or ""
            if 300 <= status < 400 and location:
                current = location
                continue
            return FetchResult(url=current, content_type=info.get("content_type") or "", body=body)
        raise FetchError(f"too many redirects for {url}")

    def _curl(self, url: str, target: Target, config: FetchConfig) -> tuple[dict, bytes]:
        marker = f"\n--web-search-{uuid.uuid4().hex}--\n"
        command = [
            "curl",
            "-fsS",
            "--compressed",
            "--max-time",
            str(config.max_time),
            "--retry",
            str(config.retry),
            "--proto",
            "=http,https",
            "--max-filesize",
            str(config.max_filesize),
            "-A",
            config.user_agent_for(urlsplit(url).hostname or ""),
            "-H",
            f"Accept: {config.accept}",
            "-H",
            f"Accept-Language: {config.accept_language}",
            "-w",
            marker + "%{json}",
        ]
        pin = target.curl_resolve()
        if pin:
            command += ["--resolve", pin]
        command += ["--url", url]
        try:
            completed = subprocess.run(
                command,
                check=False,
                capture_output=True,
                timeout=config.max_time + 10,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise FetchError(f"curl failed for {url}: {exc}") from exc
        if completed.returncode != 0:
            err = completed.stderr.decode("utf-8", errors="replace").strip() or f"exit {completed.returncode}"
            raise FetchError(f"curl failed for {url}: {err}")
        body, found, meta = completed.stdout.rpartition(marker.encode())
        if not found:
            raise FetchError(f"curl returned no metadata for {url}")
        try:
            info = json.loads(meta.decode("utf-8", errors="replace"))
        except json.JSONDecodeError as exc:
            raise FetchError(f"curl returned invalid metadata for {url}") from exc
        return info, body
