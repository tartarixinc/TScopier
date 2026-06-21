"""Tests for Telegram message text normalization."""

from app.normalize_telegram_message_text import normalize_telegram_message_text
from app.signal_heuristic import looks_like_trading_signal


PLAIN = """XAUUSD BUY

SL: 4320

TP1 4340

TP2 4345

TP3 4350

TP4 4355

TP5 4360

Risk only 1-2% of your balance."""


def test_strips_markdown_italic():
    italic = "\n".join(f"_{line}_" if line.strip() else "" for line in PLAIN.split("\n"))
    assert normalize_telegram_message_text(italic) == PLAIN


def test_italic_signal_passes_heuristic():
    italic = "\n".join(f"_{line}_" if line.strip() else "" for line in PLAIN.split("\n"))
    assert looks_like_trading_signal(italic)
