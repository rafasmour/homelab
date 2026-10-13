from abc import ABC, abstractmethod

from markdownify import markdownify


class HTMLToMarkdown(ABC):
    @abstractmethod
    def format(self, html: str) -> str:
        raise NotImplementedError


class MarkdownifyHtmlToMarkdown(HTMLToMarkdown):
    def format(self, html: str) -> str:
        return markdownify(html, heading_style="ATX").strip()
