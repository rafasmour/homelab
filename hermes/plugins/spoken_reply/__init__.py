"""spoken_reply: deterministic clean-up of the ai-assistant's final reply.

Enabled only on the ai-assistant profile (start.sh). The transform_llm_output
hook runs once per turn after the tool loop and the first non-empty string wins.
It turns Markdown into plain sentences and drops letters of scripts other than
Latin/Greek (stray Cyrillic/Arabic/Hebrew/CJK inside Greek words) and emoji.
The logic is a copy of _speakable() in speech/gateway/server.py (no cross-stack
imports). Never returns an empty text: the original stays when nothing is left.
Streamed deltas that were already sent are not rewritten.
"""

from __future__ import annotations

import logging
import os
import re
import unicodedata
from functools import lru_cache

log = logging.getLogger(__name__)

_MD_FENCE = re.compile(r"^[ \t]*(?:```|~~~)[^\n]*$", re.M)
_MD_TABLE_SEP = re.compile(r"^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(?:\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$", re.M)
_MD_IMAGE = re.compile(r"!\[([^\]]*)\]\([^)\s]*[^)]*\)")
_MD_LINK = re.compile(r"\[([^\]]+)\]\([^)]*\)")
_MD_URL = re.compile(r"(?:https?://|www\.)[^\s<>)\]]+", re.I)
_MD_HEADING = re.compile(r"^[ \t]*#{1,6}[ \t]+", re.M)
_MD_QUOTE = re.compile(r"^[ \t]*(?:>[ \t]?)+", re.M)
_MD_LIST = re.compile(r"^[ \t]*(?:[-*+•●◦–][ \t]+|\d{1,3}[.)][ \t]+)", re.M)
_MD_BOLD = re.compile(r"(\*\*|__)(?=\S)(.+?)(?<=\S)\1", re.S)
_MD_EMPH = re.compile(r"(?<![\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![\w*])")
_MD_UEMPH = re.compile(r"(?<![\w_])_(?=\S)([^_\n]+?)(?<=\S)_(?![\w_])")
_MD_STRIKE = re.compile(r"~~(?=\S)(.+?)(?<=\S)~~", re.S)
_MD_LEFT = re.compile(r"\*\*|__|`+")
_END_PUNCT = ".!?;:…;»\"')"
_SPACES = re.compile(r"[ \t ]+")
_EXTRA_DROP = frozenset("‍︎️⃣")


@lru_cache(maxsize=4096)
def _keep_char(ch: str) -> bool:
    """False for letters/digits/marks of scripts other than Latin and Greek, and for emoji."""
    o = ord(ch)
    if o < 0x250:
        return True
    if ch in _EXTRA_DROP or o >= 0x1F000 or 0x2600 <= o <= 0x27BF:
        return False
    cat = unicodedata.category(ch)
    if cat[0] in "LMN" and cat not in ("No",):
        try:
            name = unicodedata.name(ch)
        except ValueError:
            return False
        return name.startswith(("LATIN", "GREEK", "COMBINING")) or cat == "Mn" and "COMBINING" in name
    return cat not in ("Cs", "Co", "Cn")


def _strip_scripts(text: str) -> str:
    out = []
    prev_kept = False
    for ch in text:
        if _keep_char(ch):
            if unicodedata.category(ch)[0] == "M" and not prev_kept:
                continue
            out.append(ch)
            prev_kept = True
        else:
            prev_kept = False
    return "".join(out)


def speakable(text: str) -> str:
    original = text
    if not text or not text.strip():
        return original
    t = text.replace("\r\n", "\n").replace("\r", "\n")
    t = _MD_FENCE.sub("", t)
    t = _MD_TABLE_SEP.sub("", t)
    t = _MD_IMAGE.sub(r"\1", t)
    t = _MD_LINK.sub(r"\1", t)
    t = _MD_URL.sub("", t)
    t = _MD_HEADING.sub("\x00", t)
    t = _MD_QUOTE.sub("", t)
    t = _MD_LIST.sub("\x00", t)
    t = _MD_BOLD.sub(r"\2", t)
    t = _MD_STRIKE.sub(r"\1", t)
    t = _MD_EMPH.sub(r"\1", t)
    t = _MD_UEMPH.sub(r"\1", t)
    t = _MD_LEFT.sub("", t)
    t = _strip_scripts(t)
    lines = []
    for line in t.split("\n"):
        mark = line.startswith("\x00")
        line = line.replace("\x00", "")
        if "|" in line:
            mark = True
            line = " ".join(c.strip() for c in line.strip().strip("|").split("|") if c.strip())
        line = _SPACES.sub(" ", line).strip()
        if not line:
            continue
        if mark and line[-1] not in _END_PUNCT:
            line += "."
        lines.append(line)
    cleaned = " ".join(lines)
    cleaned = re.sub(r" +([,.;!?])", r"\1", cleaned)
    if not cleaned.strip(" .,;:") or not re.search(r"\w", cleaned):
        return original
    return cleaned


def _is_ai_assistant() -> bool:
    """True only for the ai-assistant profile (environment, else the active Hermes home)."""
    try:
        env = (os.environ.get("HERMES_PROFILE") or "").strip().lower()
        if env:
            return env == "ai-assistant"
        from hermes_constants import get_hermes_home

        return get_hermes_home().name == "ai-assistant"
    except Exception:
        return False


def _transform_llm_output(response_text="", **kw):
    try:
        if not isinstance(response_text, str) or not response_text.strip() or not _is_ai_assistant():
            return None
        cleaned = speakable(response_text)
        if cleaned == response_text:
            return None
        log.info("spoken_reply: cleaned reply %d -> %d chars", len(response_text), len(cleaned))
        return cleaned
    except Exception as exc:
        log.debug("spoken_reply: %s", exc)
        return None


def register(ctx) -> None:
    ctx.register_hook("transform_llm_output", _transform_llm_output)
