from abc import ABC, abstractmethod
from dataclasses import dataclass
import os


@dataclass(frozen=True)
class FetchConfig:
    user_agent: str
    accept: str
    accept_language: str
    max_time: int
    max_redirs: int
    retry: int
    max_filesize: int


class FetchHeaders(ABC):
    @abstractmethod
    def headers(self) -> FetchConfig:
        raise NotImplementedError


class CurlRecommendedHeaders(FetchHeaders):
    def headers(self) -> FetchConfig:
        return FetchConfig(
            user_agent=os.environ.get("FETCH_USER_AGENT")
            or (
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
            ),
            accept=os.environ.get("FETCH_ACCEPT")
            or "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            accept_language=os.environ.get("FETCH_ACCEPT_LANGUAGE") or "en-US,en;q=0.9",
            max_time=int(os.environ.get("FETCH_MAX_TIME") or "20"),
            max_redirs=int(os.environ.get("FETCH_MAX_REDIRS") or "5"),
            retry=int(os.environ.get("FETCH_RETRY") or "2"),
            max_filesize=int(os.environ.get("FETCH_MAX_FILESIZE") or "2000000"),
        )
