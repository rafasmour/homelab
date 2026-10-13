from abc import ABC, abstractmethod
import subprocess

from app.fetch_headers import FetchHeaders


class FetchError(Exception):
    pass


class FetchWebsite(ABC):
    @abstractmethod
    def fetch(self, url: str) -> str:
        raise NotImplementedError


class CurlFetchWebsite(FetchWebsite):
    def __init__(self, headers: FetchHeaders) -> None:
        self._headers = headers

    def fetch(self, url: str) -> str:
        if not url.startswith(("http://", "https://")):
            raise FetchError(f"refusing non-http URL: {url}")
        config = self._headers.headers()
        command = [
            "curl",
            "-fsSL",
            "--compressed",
            "--max-time",
            str(config.max_time),
            "--max-redirs",
            str(config.max_redirs),
            "--retry",
            str(config.retry),
            "--proto",
            "=http,https",
            "--max-filesize",
            str(config.max_filesize),
            "-A",
            config.user_agent,
            "-H",
            f"Accept: {config.accept}",
            "-H",
            f"Accept-Language: {config.accept_language}",
            "--url",
            url,
        ]
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
        return completed.stdout.decode("utf-8", errors="replace")
