"""Trading-signal heuristic — aligned with worker/src/signalTradingHeuristic.ts."""

from __future__ import annotations

import re
from typing import Iterable

from .normalize_telegram_message_text import normalize_telegram_message_text

_EXPLICIT_SYMBOLS = re.compile(
    r"\b("
    r"BTCUSDT|BTCEUR|BTCUSD|ETHUSDT|ETHUSD|EURUSD|GBPUSD|USDJPY|AUDUSD|NZDUSD|"
    r"USDCAD|USDCHF|XAUUSD|XAGUSD|NAS100|SPX500|USTEC|US100|US500|US30|"
    r"GER40|UK100|DJ30|DJI|DAX40|JP225|JPN225|AUS200|HK50|EU50|FRA40|DE40|"
    r"CHN50|CN50|GOLD|SILVER|XAU|XAG|BTC|ETH|BITCOIN"
    r")\b",
    re.I,
)
_SLASH_PAIR = re.compile(r"\b([A-Z]{3,})\s*/\s*([A-Z]{3,})\b", re.I)
_TOKEN = re.compile(r"\b[A-Z][A-Z0-9]{2,11}\b")

_ENGLISH_DIRECTION = re.compile(
    r"\b(buy|sell|long|short|tp|take profit|sl|stop loss|breakeven|be)\b",
    re.I,
)
_ENGLISH_PRICE_CTX = re.compile(r"\b(entry|zone|between|above|below|now)\b", re.I)
_MULTILINGUAL_MARKET_NOW = re.compile(
    r"\b("
    r"now|instant|immediately|immediate|maintenant|imm[eé]diat|immediat|"
    r"ahora|inmediato|teraz|natychmiast|jetzt|sofort|"
    r"nu|omedelbart|onmiddellijk|"
    r"сейчас|немедленно|"
    r"agora|imediato|ora|"
    r"今すぐ|即時|成行|ナウ|"
    r"الآن|فوراً|فورا"
    r")\b",
    re.I,
)
_ENGLISH_TRADE_STRUCTURE = re.compile(r"\b(tp\s*\d*|sl|entry|signal|setup)\b", re.I)
_ENGLISH_REPLY_MGMT = re.compile(
    r"\b(move|set|update|adjust|tp|sl|breakeven|be|close)\b",
    re.I,
)
_NUMERIC_PRICE = re.compile(r"\b\d{1,5}(?:\.\d{1,5})\b")


def _has_tradable_instrument_in_text(text: str) -> bool:
    raw = text or ""
    if _EXPLICIT_SYMBOLS.search(raw):
        return True
    if _SLASH_PAIR.search(raw):
        return True
    u = raw.upper()
    if re.search(r"\b(XAUUSD|XAU\b|GOLD)\b", u):
        return True
    if re.search(r"\bSILVER\b|\bXAG\b|\bXAGUSD\b", u):
        return True
    if re.search(r"\bBITCOIN\b|\bBTC\b", u):
        return True
    if re.search(r"\bETHER(EUM)?\b|\bETH\b", u):
        return True
    for tok in _TOKEN.findall(u):
        if len(tok) == 6 and tok.isalpha():
            return True
    return False


def _looks_like_explicit_full_close_command(text: str) -> bool:
    t = re.sub(r"\s+", " ", (text or "").strip())
    if not t:
        return False
    if re.search(r"\bclose\s+to\b", t, re.I):
        return False
    return bool(
        re.search(
            r"\bclose\s+(?:now|all|full|trade|trades|position|positions|everything|every\s+thing)\b",
            t,
            re.I,
        )
        or re.search(
            r"\bclose\s+(?:my|the|this|running|active|open)\s+(?:trade|trades|position|positions)\b",
            t,
            re.I,
        )
        or re.search(
            r"\bclose\s+(?:gold|xauusd|xau|silver|xagusd|btc|bitcoin|btcusd|ethusd|gbpusd|us30|nas100|[a-z]{6})\b",
            t,
            re.I,
        )
        or re.search(r"\b(?:flatten|kill\s+zones?)\b", t, re.I)
        or re.search(
            r"\bexit\s+(?:trade|trades|position|positions|long|short|now)\b",
            t,
            re.I,
        )
    )


def looks_like_channel_management_update(
    text: str,
    channel_aliases: Iterable[str] | None = None,
) -> bool:
    t = re.sub(r"\s+", " ", (text or "").strip())
    if not t:
        return False

    if channel_aliases:
        for alias in channel_aliases:
            phrase = str(alias or "").strip()
            if not phrase:
                continue
            pattern = r"(?:^|\b)" + re.escape(phrase).replace(r"\ ", r"\s+") + r"(?:\b|$)"
            if re.search(pattern, t, re.I):
                return True

    return bool(
        re.search(
            r"\b(move\s+stop|move\s+sl|stop\s+to\s+breakeven|breakeven|break\s*even)\b",
            t,
            re.I,
        )
        or re.search(
            r"\b(close\s+partial|closing\s+partial|take\s+partial|partial\s+(?:lot|lots|lotsize|position|trade))\b",
            t,
            re.I,
        )
        or re.search(r"\bsecure\s+\d+\s*%\s*profit", t, re.I)
        or re.search(r"\btake\s+profit\s+(?:target\s+)?(?:is\s+)?hit\b", t, re.I)
        or re.search(r"\bclose\s+(?:half|50%|25%|partials?)\b", t, re.I)
        or re.search(
            r"\b\d{1,3}\s*%\s*(?:of\s+)?(?:the\s+)?(?:position|trade|lot|profit(?:s)?)\b",
            t,
            re.I,
        )
    )


def _has_any_keyword(text: str, words: Iterable[str]) -> bool:
    for w in words:
        phrase = str(w or "").strip()
        if not phrase:
            continue
        pattern = r"(?:^|\b)" + re.escape(phrase).replace(r"\ ", r"\s+") + r"(?:\b|$)"
        if re.search(pattern, text, re.I):
            return True
    return False


def looks_like_training_candidate(text: str) -> bool:
    """Relaxed gate for training backfill: instrument + numeric price."""
    normalized = re.sub(r"\s+", " ", normalize_telegram_message_text(text).strip().lower())
    if not normalized:
        return False
    return _has_tradable_instrument_in_text(normalized) and bool(_NUMERIC_PRICE.search(normalized))


def looks_like_trading_signal(
    text: str,
    is_reply: bool = False,
    channel_aliases: Iterable[str] | None = None,
) -> bool:
    """Score-based gate matching TS listener (score >= 2), channel-alias aware."""
    normalized = re.sub(r"\s+", " ", normalize_telegram_message_text(text).strip().lower())
    if not normalized:
        return False

    aliases = [str(a).strip() for a in (channel_aliases or []) if str(a or "").strip()]
    has_channel_keyword = bool(aliases) and _has_any_keyword(text, aliases)

    has_instrument = _has_tradable_instrument_in_text(normalized)
    has_direction_or_action = bool(
        _ENGLISH_DIRECTION.search(normalized)
        or _looks_like_explicit_full_close_command(normalized)
        or has_channel_keyword
    )
    has_price_context = bool(
        _NUMERIC_PRICE.search(normalized)
        or _ENGLISH_PRICE_CTX.search(normalized)
        or _MULTILINGUAL_MARKET_NOW.search(text)
    )
    has_trade_structure = bool(
        _ENGLISH_TRADE_STRUCTURE.search(normalized)
        or (bool(aliases) and has_channel_keyword)
    )

    if is_reply and (_ENGLISH_REPLY_MGMT.search(normalized) or has_channel_keyword):
        return True

    if looks_like_channel_management_update(normalized, aliases or None):
        return True

    if (
        has_instrument
        and _NUMERIC_PRICE.search(normalized)
        and (has_channel_keyword or has_direction_or_action)
    ):
        return True

    score = sum(
        [
            int(has_direction_or_action),
            int(has_instrument),
            int(has_price_context),
            int(has_trade_structure),
        ]
    )
    return score >= 2
