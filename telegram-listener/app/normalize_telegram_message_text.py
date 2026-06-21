"""Strip Telegram / Markdown / HTML formatting before signal parsing."""

from __future__ import annotations

import re

_HTML_TAG_RE = re.compile(
    r"</?(?:b|strong|i|em|u|ins|s|strike|del|code|pre|tg-spoiler|span)[^>]*>",
    re.I,
)
_LINK_RE = re.compile(r'<a\b[^>]*href=["\'][^"\']*["\'][^>]*>([\s\S]*?)</a>', re.I)


def normalize_telegram_message_text(raw: str) -> str:
    text = str(raw or "")

    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.I)
    text = re.sub(r"</p>", "\n", text, flags=re.I)
    text = _HTML_TAG_RE.sub("", text)
    text = _LINK_RE.sub(r"\1", text)

    text = re.sub(r"\|\|([^|]+)\|\|", r"\1", text)
    text = re.sub(r"\*\*([^*]+)\*\*", r"\1", text)
    text = re.sub(r"__([^_]+)__", r"\1", text)
    text = re.sub(r"(?<![*_])\*([^*\n]+)\*(?![*_])", r"\1", text)
    text = re.sub(r"(?<![*_])_([^_\n]+)_(?![*_])", r"\1", text)
    text = re.sub(r"~~([^~]+)~~", r"\1", text)
    text = re.sub(r"`([^`]+)`", r"\1", text)

    text = (
        text.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
    )

    return text.strip()


def telegram_message_text(message: object) -> str:
    raw = getattr(message, "message", None) or getattr(message, "text", None) or ""
    return normalize_telegram_message_text(str(raw))
