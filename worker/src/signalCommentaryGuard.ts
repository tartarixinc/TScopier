/** True when the message has explicit executable trade structure (not inferred). */
export function hasExecutableTradeStructure(message: string): boolean {
  const text = String(message ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return false
  if (/\b(buy|sell)\s+now\b/i.test(text)) return true
  if (/\b(?:sl|tp|stop\s+loss|take\s+profit)\s*[:=-]/i.test(text)) return true
  if (/\b(?:sl|stop\s+loss)\b\s*\.\s*\d/i.test(text)) return true
  if (/(?:^|\s)(?:sl|stop\s*loss|stoploss)[_\s]*\/\s*@\s*\d/i.test(text)) return true
  if (/\b(?:sl|stop\s+loss)\b(?:\s*\([^)]*\))?\s*[^\d]{0,8}\d/i.test(text)) return true
  if (/\btp\s*#?\s*\d+\b\s*[^\d]{0,8}\d/i.test(text)) return true
  if (/\btp\s*#?\s*\d+\s+\d/i.test(text)) return true
  if (/\btp\s*\d+\s*\.\s*\d/i.test(text)) return true
  if (/\btp[\u00B9-\u2079]+\d/i.test(text)) return true
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

  const bulletLines = (text.match(/^[-*•]\s+/gm) ?? []).length
  if (bulletLines >= 3 && macroHits >= 1) return true

  return false
}

/**
 * Retrospective Q&A / soft trade discussion that mentions buy/sell/gold/entry
 * but is not an imperative order (e.g. "Did you manage this buy… not a bad entry…").
 */
export function looksLikeRetrospectiveTradeDiscussion(message: string): boolean {
  const text = String(message ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return false
  if (hasExecutableTradeStructure(text)) return false

  // Imperative market entries must never be treated as discussion.
  if (/\b(?:gold|xau(?:usd)?)\s+(?:buy|sell)\s+now\b/i.test(text)) return false
  if (/\b(?:buy|sell)\s+(?:gold|xau(?:usd)?)\s+now\b/i.test(text)) return false
  if (/\b(?:buy|sell)\s+now\b/i.test(text)) return false

  const mentionsTradeSide = /\b(?:buy|sell|long|short)\b/i.test(text)
  const mentionsInstrument = /\b(?:gold|xau(?:usd)?|silver|xag(?:usd)?)\b/i.test(text)
  if (!mentionsTradeSide && !mentionsInstrument) return false

  const isQuestion =
    /\?/.test(text)
    || /\b(?:did you|have you|anyone|guys|manage this|caught this|get in)\b/i.test(text)

  const softEntryTalk =
    /\b(?:not a bad|good|nice|solid|decent|bad)\s+entry\b/i.test(text)
    || /\b(?:our|the|this|that)\s+entry\b/i.test(text)
    || /\bclose to (?:our\s+)?entry\b/i.test(text)
    || /\bmanage this\s+(?:buy|sell)\b/i.test(text)
    || /\b(?:strong|key)\s+(?:support|resistance)\s+zone\b/i.test(text)
    || /\bfund[ae]mentals?\b/i.test(text)
    || /\b(?:too\s+)?(?:bearish|bullish)\s+for\b/i.test(text)

  if (!(isQuestion || softEntryTalk)) return false

  // Need at least one discussion cue plus trade vocabulary without executable levels.
  if (isQuestion && softEntryTalk) return true
  if (isQuestion && mentionsTradeSide && mentionsInstrument) return true
  if (softEntryTalk && (mentionsTradeSide || mentionsInstrument)) return true

  return false
}

/** Detect lifestyle/commentary messages that mention gold or "buy" but are not trade signals. */
export function looksLikeCasualNonTradeMessage(message: string): boolean {
  const text = String(message ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return false

  // Results/promotional posts can contain trade-shaped labels such as
  // "TP1+20PIPS" or "SL suggested". These markers describe an outcome or
  // proposal, not an instruction to open a new position, so they must win
  // before the generic executable-structure checks below.
  if (looksLikeResultsOrSuggestedCommentary(text)) return true

  if (looksLikeMarketNewsOrCommentary(text)) return true

  if (/\bgold\s+(watches|watch|jewelry|jewellery|chain|ring|bar|coin|necklace|bracelet)\b/i.test(text)) {
    return true
  }
  if (/\b(watch|watches|rolex|patek)\b/i.test(text) && /\bgold\b/i.test(text)) {
    return true
  }

  // Colloquial buy in prose ("They buy. We buy.") without executable signal structure.
  if (
    /\b(they|we|you)\s+buy\.?\b/i.test(text)
    && !/\b(buy|sell|long|short)\s+(now|gold|xauusd|xau|btc|bitcoin|\d)/i.test(text)
    && !/\b(sl|tp|stop\s+loss|take\s+profit|entry)\s*[:=]/i.test(text)
  ) {
    return true
  }

  if (looksLikeProfitResultCommentary(text)) return true
  if (looksLikePastTradeCelebrationCommentary(text)) return true
  if (looksLikeTradeRecapCommentary(text)) return true
  if (looksLikeRetrospectiveTradeDiscussion(text)) return true
  if (looksLikePositionStatusCommentary(text)) return true

  return false
}

/** Result, promotion, or advisory language that must not open a trade. */
export function looksLikeResultsOrSuggestedCommentary(message: string): boolean {
  const text = String(message ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return false

  const resultMarkers =
    /\b(?:results?|recap|performance|total\s+pips?|pips?\s+total|join\s+(?:our\s+)?vip|vip\s+(?:results?|performance)|hits?\s+tp\s*\d+|tp\s*\d+\s*(?:hit|reached)|tp\s*\d+\s*(?:&|and)\s*(?:tp\s*)?\d+\s*(?:done|hit|completed|secured|achieved)|tp\s*\d+\s*[+=]\s*\d+(?:\.\d+)?\s*pips?)\b/i
  const arabicResultMarkers =
    /(?:نتائج|حصيلة|أداء|اجمالي\s*(?:النقاط|البيب|البيبات)|إجمالي\s*(?:النقاط|البيب|البيبات)|انضم(?:ام)?|ضرب(?:ت)?\s*(?:الهدف|tp)|الهدف\s*(?:تحقق|ضرب))/iu
  if (resultMarkers.test(text) || arabicResultMarkers.test(text)) return true

  const advisoryStop =
    /(?:\b(?:suggested|suggestion|suggest|recommended|potential|possible|could|may)\b.{0,40}\b(?:sl|stop\s*loss|tp|take\s*profit|target)\b|\b(?:sl|stop\s*loss|tp|take\s*profit|target)\b(?!\s*[:=]\s*\d).{0,40}\b(?:suggested|suggestion|suggest|recommended)\b)/i
  const arabicAdvisoryStop =
    /(?:مقترح(?:ة)?|اقتراح|محتمل|قد)\s*.{0,40}(?:وقف\s*الخسارة|وقف|الهدف|tp)/iu
  return advisoryStop.test(text) || arabicAdvisoryStop.test(text)
}

/**
 * Position updates / conditional tense about trades already in flight
 * (e.g. "trade we right now in, selling gold" — not a new entry order).
 */
export function looksLikePositionStatusCommentary(message: string): boolean {
  const text = String(message ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return false
  if (hasExecutableTradeStructure(text)) return false

  if (/\b(?:gold|xau(?:usd)?)\s+(?:buy|sell)\s+now\b/i.test(text)) return false
  if (/\b(?:buy|sell)\s+(?:gold|xau(?:usd)?)\s+now\b/i.test(text)) return false
  if (/\b(?:buy|sell)\s+now\b/i.test(text)) return false

  if (/\btrade\s+we\b.{0,60}\bin\b/i.test(text) && /\b(?:selling|buying)\b/i.test(text)) {
    return true
  }
  if (/\b(?:we|trade)\s+right\s+now\s+in\b/i.test(text)) return true
  if (/\bright\s+now\s+in,?\s+(?:selling|buying)\b/i.test(text)) return true

  if (/\bwould(?:'ve|'ve|\s+have)\s+(?:sold|bought|buy|sell)\b/i.test(text)) return true
  if (/\bwas\s+gonna\s+go\s+for\b/i.test(text)) return true

  if (/\bretracement\b/i.test(text) && /\b(?:would|gonna|sold|bought|selling|buying)\b/i.test(text)) {
    return true
  }
  if (/\blet'?s\s+see\s+if\s+the\s+bears\b/i.test(text)) return true
  if (/\bnot\s+making\s+it\s+easy\s+for\s+retail\b/i.test(text)) return true

  if (
    /\b(?:selling|buying)\s+(?:gold|xau(?:usd)?|silver|xag(?:usd)?|btc(?:usd|usdt)?|bitcoin)\b/i.test(text)
    && !/\b(?:gold|xau(?:usd)?)\s+(?:buy|sell)\b/i.test(text)
    && !/\b(?:buy|sell)\s+(?:gold|xau(?:usd)?)\b/i.test(text)
  ) {
    return true
  }

  return false
}

/** Hype or celebration about a trade already taken — not a new executable signal. */
export function looksLikePastTradeCelebrationCommentary(message: string): boolean {
  const text = String(message ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return false
  if (hasExecutableTradeStructure(text)) return false

  const mentionsSide = /\b(?:buy|sell|long|short)\b/i.test(text)
  const mentionsInstrument = /\b(?:gold|xau(?:usd)?|silver|xag(?:usd)?)\b/i.test(text)
  const pastTense =
    /\b(?:took|taken|we took|got in|entered)\b/i.test(text)
    || /\b(?:earlier|already|before|yesterday|this morning|last night)\b/i.test(text)

  if (mentionsSide && pastTense) {
    if (/\b(?:buy|sell|long|short)\s+we\s+took\b/i.test(text)) return true
    if (/\bwe\s+took\s+(?:the\s+)?(?:a\s+)?(?:buy|sell|long|short)\b/i.test(text)) return true
    if (/\b(?:gold|xau(?:usd)?)\s+(?:buy|sell)\s+we\s+took\b/i.test(text)) return true
    if (/\b(?:buy|sell)\b/i.test(text) && /\btook\s+earlier\b/i.test(text)) return true
    if (/\btook\b/i.test(text) && (mentionsSide || mentionsInstrument)) return true
  }

  if (
    /\b(?:excited|pumped|thrilled|what a|such a|so happy|loving this)\b/i.test(text)
    && (mentionsSide || mentionsInstrument)
  ) {
    return true
  }

  if (
    /\b(?:banger|monster|crushed it|killing it|what a trade|absolute\s+banger)\b/i.test(text)
  ) {
    return true
  }

  return false
}

/** Past-tense trade story / lesson posts that mention "took the buy" but carry no executable levels. */
export function looksLikeTradeRecapCommentary(message: string): boolean {
  const text = String(message ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return false
  if (hasExecutableTradeStructure(text)) return false
  if (looksLikePastTradeCelebrationCommentary(text)) return true

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
    && !/\b(?:sl|tp|stop\s+loss|take\s+profit)\s*[:=-]/i.test(text)
  ) {
    return true
  }

  if (
    /\b\d[\d,]*(?:\.\d+)?\s*(?:usd|gbp|eur|pounds?|dollars?)\b/i.test(text)
    && /\bprofit\b/i.test(text)
    && !/\b(?:sl|tp|stop\s+loss|take\s+profit)\s*[:=-]/i.test(text)
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
    && !/\b(?:sl|tp|stop\s+loss|take\s+profit)\s*[:=-]/i.test(text)
  ) {
    return true
  }

  return false
}

export function isPercentagePriceAt(message: string, index: number, tokenLength: number): boolean {
  const after = String(message ?? '').slice(index + tokenLength).trimStart()
  return after.startsWith('%')
}
