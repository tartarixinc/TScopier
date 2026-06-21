/** True when the message has explicit executable trade structure (not inferred). */
export function hasExecutableTradeStructure(message: string): boolean {
  const text = String(message ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return false
  if (/\b(buy|sell)\s+now\b/i.test(text)) return true
  if (/\b(?:sl|tp|stop\s+loss|take\s+profit)\s*[:=\-]/i.test(text)) return true
  if (/\b(?:entry\s+level|stop\s+loss|target\s+level)\s*[:=]/i.test(text)) return true
  if (/\b(?:buy|sell)\s+(?:at\s+)?@\s*\d/i.test(text)) return true
  if (/\b(?:buy|sell)\s+at\s+\d/i.test(text)) return true
  return false
}

/** Market news / macro commentary that mentions instruments but is not a trade signal. */
export function looksLikeMarketNewsOrCommentary(message: string): boolean {
  const text = String(message ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return false
  if (hasExecutableTradeStructure(text)) return false

  if (/\bmarket\s+news\b/i.test(text)) return true
  if (/\bnews\s+update\b/i.test(text)) return true
  if (/\bmarket\s+update\b/i.test(text)) return true
  if (/\bmarket\s+(?:analysis|recap|commentary|outlook|report)\b/i.test(text)) return true
  if (/\b(?:weekly|daily)\s+(?:recap|outlook|roundup)\b/i.test(text)) return true
  if (/📰/.test(text)) return true

  const macroIndicators = [
    /\bheadline\s+cpi\b/i.test(text),
    /\bbureau\s+of\s+labor\b/i.test(text),
    /\bfedwatch\b/i.test(text),
    /\byoy\b/i.test(text),
    /\bgeopolitical\b/i.test(text),
    /\binflation\b/i.test(text) && /\b(?:cpi|core|prices?|percent|%)\b/i.test(text),
    /\b(?:cpi|core\s+cpi)\b/i.test(text) && /\b(?:yoy|mo?m|month|year|may|april)\b/i.test(text),
  ]
  const macroHits = macroIndicators.filter(Boolean).length

  if (macroHits >= 2) return true

  const bulletLines = (text.match(/^[\-*•]\s+/gm) ?? []).length
  if (bulletLines >= 3 && macroHits >= 1) return true

  return false
}

/** Detect lifestyle/commentary messages that mention gold or "buy" but are not trade signals. */
export function looksLikeCasualNonTradeMessage(message: string): boolean {
  const text = String(message ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return false

  if (looksLikeMarketNewsOrCommentary(text)) return true

  if (/\bgold\s+(watches|watch|jewelry|jewellery|chain|ring|bar|coin|necklace|bracelet)\b/i.test(text)) {
    return true
  }
  if (/\b(watch|watches|rolex|patek)\b/i.test(text) && /\bgold\b/i.test(text)) {
    return true
  }

  if (
    /\b(they|we|you)\s+buy\.?\b/i.test(text)
    && !/\b(buy|sell|long|short)\s+(now|gold|xauusd|xau|btc|bitcoin|\d)/i.test(text)
    && !/\b(sl|tp|stop\s+loss|take\s+profit|entry)\s*[:=]/i.test(text)
  ) {
    return true
  }

  if (looksLikeProfitResultCommentary(text)) return true
  if (looksLikeTradeRecapCommentary(text)) return true

  return false
}

/** Past-tense trade story / lesson posts that mention "took the buy" but carry no executable levels. */
export function looksLikeTradeRecapCommentary(message: string): boolean {
  const text = String(message ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return false
  if (hasExecutableTradeStructure(text)) return false

  if (
    /\b(?:after the|following the)\s+(?:fomc|fed|nfp|cpi|news)\b/i.test(text)
    && /\b(?:waited|took|entered|position)\b/i.test(text)
  ) {
    return true
  }

  if (
    /\b(?:i\s+)?took the\s+(?:buy|sell)\b/i.test(text)
    && /\b(?:pips?|move|higher|lower|caught|around)\b/i.test(text)
  ) {
    return true
  }

  if (
    /\b(?:key lesson|lesson here|patience matters|wait for confirmation)\b/i.test(text)
    && /\b(?:took|entered|position|caught)\b/i.test(text)
  ) {
    return true
  }

  return false
}

/** Profit/testimonial posts that mention a past signal side but are not new entries. */
export function looksLikeProfitResultCommentary(message: string): boolean {
  const text = String(message ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return false

  if (/\binsane\s+result\b/i.test(text)) return true

  if (
    /\b(?:£|\$|€)\s*\d[\d,]*(?:\.\d+)?\b/i.test(text)
    && /\bprofit\b/i.test(text)
    && !/\b(?:sl|tp|stop\s+loss|take\s+profit)\s*[:=\-]/i.test(text)
  ) {
    return true
  }

  if (
    /\b\d[\d,]*(?:\.\d+)?\s*(?:usd|gbp|eur|pounds?|dollars?)\b/i.test(text)
    && /\bprofit\b/i.test(text)
    && !/\b(?:sl|tp|stop\s+loss|take\s+profit)\s*[:=\-]/i.test(text)
  ) {
    return true
  }

  if (
    /\btook my\b/i.test(text)
    && /\b(gold|xauusd|xau|buy|sell)\b/i.test(text)
    && /\b(from today|profit|made|result)\b/i.test(text)
    && !/\b(buy|sell)\s+now\b/i.test(text)
  ) {
    return true
  }

  if (
    /\b(made|earned|banked|secured)\b/i.test(text)
    && /\b(profit|pips?\s+profit|gains?)\b/i.test(text)
    && /\b(gold|xauusd|xau|buy|sell)\b/i.test(text)
    && !/\b(buy|sell)\s+now\b/i.test(text)
    && !/\b(?:sl|tp|stop\s+loss|take\s+profit)\s*[:=\-]/i.test(text)
  ) {
    return true
  }

  return false
}

export function isPercentagePriceAt(message: string, index: number, tokenLength: number): boolean {
  const after = String(message ?? '').slice(index + tokenLength).trimStart()
  return after.startsWith('%')
}
