"""Trading-signal heuristic — aligned with worker/src/userListener.ts looksLikeTradingSignal."""

from __future__ import annotations

import re

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


def looks_like_channel_management_update(text: str) -> bool:
    t = re.sub(r"\s+", " ", (text or "").strip())
    if not t:
        return False
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


def looks_like_trading_signal(text: str, is_reply: bool = False) -> bool:
    """Score-based gate matching TS listener (score >= 2)."""
    normalized = re.sub(r"\s+", " ", (text or "").strip().lower())
    if not normalized:
        return False

    has_instrument = _has_tradable_instrument_in_text(text)
    has_direction_or_action = bool(
        re.search(
            r"\b(buy|sell|long|short|tp|take profit|sl|stop loss|breakeven|be)\b",
            normalized,
        )
        or _looks_like_explicit_full_close_command(text)
    )
    has_price_context = bool(
        re.search(r"\b\d{1,5}(?:\.\d{1,5})\b", normalized)
        or re.search(r"\b(entry|zone|between|above|below|now)\b", normalized)
    )
    has_trade_structure = bool(
        re.search(r"\b(tp\s*\d*|sl|entry|signal|setup)\b", normalized)
    )

    if (is_reply and re.search(
        r"\b(move|set|update|adjust|tp|sl|breakeven|be|close)\b", normalized
    )):
        return True

    if looks_like_channel_management_update(text):
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
