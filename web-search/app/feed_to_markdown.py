from lxml import etree, html

_ATOM = "{http://www.w3.org/2005/Atom}"
_SUMMARY_CHARS = 400


class NotAFeed(ValueError):
    pass


def feed_to_markdown(data: bytes) -> tuple[str, str]:
    """Return (title, markdown) for an RSS 2.0 or Atom document."""
    parser = etree.XMLParser(resolve_entities=False, no_network=True, recover=True)
    try:
        root = etree.fromstring(data, parser)
    except etree.XMLSyntaxError as exc:
        raise NotAFeed(str(exc)) from exc
    if root is None:
        raise NotAFeed("empty document")
    if root.tag == "rss":
        channel = root.find("channel")
        if channel is None:
            raise NotAFeed("rss without channel")
        title = _text(channel.find("title"))
        entries = [
            (
                _text(item.find("title")),
                _text(item.find("link")),
                _text(item.find("pubDate")),
                _text(item.find("description")),
            )
            for item in channel.findall("item")
        ]
    elif root.tag == f"{_ATOM}feed":
        title = _text(root.find(f"{_ATOM}title"))
        entries = [
            (
                _text(entry.find(f"{_ATOM}title")),
                _atom_link(entry),
                _text(entry.find(f"{_ATOM}published")) or _text(entry.find(f"{_ATOM}updated")),
                _text(entry.find(f"{_ATOM}summary")) or _text(entry.find(f"{_ATOM}content")),
            )
            for entry in root.findall(f"{_ATOM}entry")
        ]
    else:
        raise NotAFeed(f"root element {root.tag!r} is not rss or atom")
    lines = []
    for entry_title, link, date, summary in entries:
        line = f"- [{entry_title or link}]({link})" if link else f"- {entry_title}"
        if date:
            line += f" ({date})"
        summary = _plain(summary)
        if summary:
            line += f"\n  {summary}"
        lines.append(line)
    return title, "\n".join(lines)


def _text(node) -> str:
    return (node.text or "").strip() if node is not None else ""


def _atom_link(entry) -> str:
    links = entry.findall(f"{_ATOM}link")
    for link in links:
        if link.get("rel", "alternate") == "alternate" and link.get("href"):
            return link.get("href")
    return links[0].get("href", "") if links else ""


def _plain(fragment: str) -> str:
    if not fragment:
        return ""
    try:
        text = html.fromstring(fragment).text_content()
    except (etree.ParserError, ValueError):
        text = fragment
    text = " ".join(text.split())
    if len(text) > _SUMMARY_CHARS:
        text = text[: _SUMMARY_CHARS - 3].rstrip() + "..."
    return text
