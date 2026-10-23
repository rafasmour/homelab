from abc import ABC, abstractmethod

import trafilatura
from lxml import etree, html as lxml_html

_NOISE_TAGS = (
    "script",
    "style",
    "nav",
    "header",
    "footer",
    "aside",
    "form",
    "iframe",
    "noscript",
)


class ExtractMainContent(ABC):
    @abstractmethod
    def extract(self, html: str) -> str:
        raise NotImplementedError

    @abstractmethod
    def title(self, html: str) -> str:
        raise NotImplementedError


class TrafilaturaMainContent(ExtractMainContent):
    def extract(self, html: str) -> str:
        extracted = trafilatura.extract(
            html,
            include_links=True,
            include_tables=True,
            output_format="html",
            favor_precision=False,
        )
        if extracted and extracted.strip():
            return extracted
        return _fallback_main(html)

    def title(self, html: str) -> str:
        metadata = trafilatura.extract_metadata(html)
        if metadata is not None and metadata.title and metadata.title.strip():
            return metadata.title.strip()
        return _fallback_title(html)


def _fallback_title(document: str) -> str:
    try:
        tree = lxml_html.fromstring(document)
    except (ValueError, etree.ParserError):
        return ""
    titles = tree.xpath("//title")
    if not titles:
        return ""
    return " ".join((titles[0].text_content() or "").split())


def _fallback_main(document: str) -> str:
    tree = lxml_html.fromstring(document)
    for tag in _NOISE_TAGS:
        for element in tree.findall(f".//{tag}"):
            element.drop_tree()

    mains = tree.xpath("//main")
    main = mains[0] if mains else None
    if _has_text(main):
        return _serialize(main)

    role_main = tree.xpath('//*[@role="main"]')
    if role_main and _has_text(role_main[0]):
        return _serialize(role_main[0])

    articles = tree.xpath("//article")
    if articles:
        richest = max(articles, key=lambda node: len((node.text_content() or "").strip()))
        if _has_text(richest):
            return _serialize(richest)

    body = tree.find(".//body")
    if body is None:
        body = tree
    candidates = [child for child in body.iterchildren() if isinstance(child.tag, str)]
    if not candidates:
        text = (body.text_content() or "").strip()
        if not text:
            raise ValueError("no main content found")
        return _serialize(body)
    scored = max(candidates, key=_text_density)
    if not _has_text(scored):
        raise ValueError("no main content found")
    return _serialize(scored)


def _has_text(node) -> bool:
    return node is not None and bool((node.text_content() or "").strip())


def _text_density(node) -> float:
    text_len = len((node.text_content() or "").strip())
    tags = sum(1 for _ in node.iter() if isinstance(_.tag, str))
    return text_len / (tags + 1)


def _serialize(node) -> str:
    return lxml_html.tostring(node, encoding="unicode", method="html")
