import { textHasCommonMarketNowIntent, messageContainsKeyword, isMarketNowDenylistedContext } from './multilingualSignalTerms'
export type MarketNowKeywordFields = {
  signal?: { market_order?: string }
  additional?: { delimiters?: string }
}

export const ENTRY_REQUIRES_NOW_REASON = 'entry_requires_now_without_sl_tp'
/** Buy/sell has take-profit levels but no stop loss — never execute. */
export const ENTRY_TP_WITHOUT_SL_REASON = 'entry_tp_without_sl'

function positivePrice(v: unknown): number | null {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

export function parsedHasSlOrTp(parsed: { sl?: unknown; tp?: unknown }): boolean {
  const sl = positivePrice(parsed.sl)
  const tp = Array.isArray(parsed.tp)
    ? parsed.tp.map(positivePrice).filter((n): n is number => n != null)
    : []
  return sl != null || tp.length > 0
}

export function parsedHasPositiveSl(parsed: { sl?: unknown }): boolean {
  return positivePrice(parsed.sl) != null
}

export function parsedHasPositiveTp(parsed: { tp?: unknown }): boolean {
  if (!Array.isArray(parsed.tp)) return false
  return parsed.tp.some(t => positivePrice(t) != null)
}

/**
 * True when the entry lists take-profit(s) but no stop loss.
 * Signal eligibility does not skip on this — some accounts supply SL via
 * Override signal SL / RR. Entry prep still blocks accounts with no fallback.
 */
export function entryHasTpWithoutSl(parsed: { sl?: unknown; tp?: unknown }): boolean {
  return parsedHasPositiveTp(parsed) && !parsedHasPositiveSl(parsed)
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function keywordRegex(phrase: string): RegExp {
  const p = escapeRegExp(phrase.trim()).replace(/\s+/g, '\\s+')
  return new RegExp(`(?:^|\\b)${p}(?:\\b|$)`, 'i')
}

function splitKeywordAliases(raw: string, delim: string): string[] {
  return String(raw ?? '').split(delim).map(s => s.trim()).filter(Boolean)
}

/** "Market" in news/analysis prose — not immediate market-order intent. */
function isNonTradingMarketPhrase(message: string): boolean {
  return /\b(?:market\s+(?:news|update|analysis|recap|commentary|outlook|report)|stock\s+market|bullion\s+market|labor\s+market|equity\s+market|job\s+market|housing\s+market|energy\s+market|cyclical\s+highs)\b/i.test(
    message,
  )
}

/** True when the message declares an immediate / market entry (NOW, MARKET, etc.). */
export function messageHasMarketNowIntent(
  message: string,
  channelKeywords?: MarketNowKeywordFields | null,
): boolean {
  const raw = String(message ?? '')
  if (isMarketNowDenylistedContext(raw)) return false
  if (/\b(at\s+market|@\s*market)\b/i.test(raw)) return true
  if (/\b(?:market\s+order|buy\s+market|sell\s+market|market\s+buy|market\s+sell)\b/i.test(raw)) {
    return true
  }

  const nowLike = ['instant', 'mkt']
  const delim = channelKeywords?.additional?.delimiters ?? '|'
  const custom = channelKeywords?.signal?.market_order
    ? splitKeywordAliases(channelKeywords.signal.market_order, delim)
    : []
  for (const token of [...nowLike, ...custom.filter(t => t.toLowerCase() !== 'market')]) {
    if (token && messageContainsKeyword(raw, token)) return true
  }

  if (keywordRegex('market').test(raw) && !isNonTradingMarketPhrase(raw)) {
    return true
  }

  if (textHasCommonMarketNowIntent(raw)) return true

  return false
}

/** Optional emoji / punctuation between a label and its price (e.g. SL ⛔️4038, TP1 🎯4058). */
const LABEL_TO_PRICE_GAP = String.raw`(?:\s*(?:\([^)]*\)\s*)?[^\d\n]{0,12}?)`

/** True when SL/TP appear as labeled parameters in the message (not inferred from prose). */
export function messageHasExplicitSlTpLabels(message: string): boolean {
  const text = String(message ?? '')
  if (new RegExp(String.raw`\b(?:sl|stop\s*loss)\b${LABEL_TO_PRICE_GAP}[:=@]?\s*\d`, 'iu').test(text)) return true
  if (/\b(?:sl|stop\s*loss)\b\s*\.\s*\d/i.test(text)) return true
  if (/(?:^|\s)(?:sl|stop\s*loss|stoploss)[_\s]*\/\s*@\s*\d/i.test(text)) return true
  if (/\b(?:sl|stop\s*loss)\s+to\s+\d/i.test(text)) return true
  if (/(?:وقف\s*الخسارة|وقف)\s*[:：=@]?\s*\d/u.test(text)) return true
  if (/(?:وقف\s*الخسارة|وقف)\s+(?:to|إلى)\s*\d/iu.test(text)) return true
  if (/\b(?:tp|take\s*profit|target(?:\s+level)?)\s*#?\s*\d+\s*[:=\-]\s*\d/i.test(text)) return true
  if (/\btp\s*\d+\s*\.\s*\d/i.test(text)) return true
  if (/\btp[\u00B9-\u2079]+\d/i.test(text)) return true
  // TP1 4340 (numbered tier, space-separated — no colon)
  if (new RegExp(String.raw`\b(?:tp|take\s*profit|target(?:\s+level)?)\s*#?\s*\d+\b${LABEL_TO_PRICE_GAP}\d`, 'iu').test(text)) return true
  if (new RegExp(String.raw`\b(?:tp|take\s*profit|target(?:\s+level)?)\b${LABEL_TO_PRICE_GAP}[:=\-]?\s*\d`, 'iu').test(text)) return true
  if (new RegExp(String.raw`\btp\s*\d+\b${LABEL_TO_PRICE_GAP}[:=\-]?\s*\d`, 'iu').test(text)) return true
  if (/(?:الهدف(?:\s*(?:الأول|الثاني|الثالث|\d+))?|جني\s*الأرباح)\s*[:：=\-]?\s*\d/iu.test(text)) return true
  if (/stop\s+loss\s*\(\s*sl\s*\)\s*:\s*\d/i.test(text)) return true
  if (/take\s+profit\s*\d+\s*\(\s*tp\d+\s*\)\s*:\s*\d/i.test(text)) return true
  return false
}

/**
 * True when the message explicitly labels an entry price/zone/level, as opposed to a bare
 * market entry such as "Gold buy now". Used to detect a parser gap: if the message labels an
 * entry but the parse carries no anchor, the deterministic result must not be trusted alone.
 */
export function messageLabelsEntryAnchor(message: string): boolean {
  const text = String(message ?? '')
  if (!text) return false
  // "ENTRY", "ENTRY ZONE", "ENTRY AREA", … must be followed by a price, so the bare word
  // "entry" in prose ("wait for a good entry") is not a label. "ENTRY at 4358" / "ENTRY @ 4358"
  // are accepted connectors.
  if (/\bentry\s*(?:price|zone|area|level|point)?\s*(?:at\s+|@\s*)?[:=]?\s*\d/i.test(text)) return true
  // "buy at 4358" / "sell at 4358" — a price must follow, so "sell at market" is NOT an anchor.
  if (/\b(?:buy|sell)\s+at\s+\d/i.test(text)) return true
  if (/\b(?:buy|sell)\s+limit(?:\s*order)?\b/i.test(text)) return true
  if (/\b(?:entry|limit)\s*price\s*[:=]?\s*\d/i.test(text)) return true
  // Bare "PRICE: 4256" is a provider entry label, but only when it starts a line —
  // "TP price:" / "Target price:" must not count.
  if (/(?:^|\n)\s*price\s*[:=]\s*\d/i.test(text)) return true
  // "ZONE: 4358" (single-price zone) is a provider entry label.
  if (/(?:^|\n)\s*zone\s*[:=]\s*\d/i.test(text)) return true
  // "AREA: 4358" (entry area): line-initial or with a separator, so "support area 4350" is not one.
  if (/(?:^|\n)\s*area\s*[:=]?\s*\d/i.test(text)) return true
  if (/\barea\s*[:=]\s*\d/i.test(text)) return true
  // "FROM 4358" (entry-from): line-initial, right after a direction word, or after a symbol.
  // Bare "…from <n>" in prose ("SL moved from 4348", "200 pips from 2640") is not an entry.
  if (/(?:^|\n)\s*from\s+\d/i.test(text)) return true
  if (/\b(?:buy|sell|long|short|entry)\s+from\s+\d/i.test(text)) return true
  if (/\b(?:buy|sell|long|short)\s+(?:xauusd|xagusd|gold|silver|btcusd|btcusdt|ethusd|ethusdt|eurusd|gbpusd|usdjpy|us30|nas100)\s+from\s+\d/i.test(text)) return true
  // Bare "@4358" is an entry unless the "@" is the SL/TP separator ("TP @ 4256"), which the
  // parser itself excludes (parseAtPriceExcludingSlTp).
  for (const m of text.matchAll(/@\s*\d/g)) {
    const before = text.slice(Math.max(0, (m.index ?? 0) - 32), m.index ?? 0)
    if (/\b(?:sl|stop\s*loss|stoploss|tp|take\s*profit)[\s._#()/:-]*\d{0,2}\b[_\s./():-]*$/i.test(before)) continue
    return true
  }
  if (/(?:منطقة\s*الدخول|سعر\s*الدخول|نقطة\s*الدخول)/u.test(text)) return true
  return false
}

/**
 * True when the parse carries no entry anchor but the message text labels an entry the parser
 * may have missed. Callers use this to route to the AI instead of trusting an incomplete parse.
 */
export function parsedMissesLabeledEntry(
  parsed: { entry_price?: unknown; entry_zone_low?: unknown; entry_zone_high?: unknown } | null | undefined,
  rawMessage: string | null | undefined,
): boolean {
  if (!parsed) return false
  const hasAnchor = positivePrice(parsed.entry_price) != null
    || positivePrice(parsed.entry_zone_low) != null
    || positivePrice(parsed.entry_zone_high) != null
  if (hasAnchor) return false
  return messageLabelsEntryAnchor(String(rawMessage ?? ''))
}

/** Multiple numeric prices usually means a real signal (entry/SL/TP), not profit commentary. */
function messageHasStructuredPriceEvidence(message: string): boolean {
  const prices = String(message ?? '').match(/\b\d{1,5}(?:\.\d{1,5})?\b/g) ?? []
  return prices.length >= 2
}

/**
 * Buy/sell entries need NOW (or MARKET) unless the message includes explicit SL/TP labels
 * or the parser extracted SL/TP from a multi-price signal (e.g. AI / foreign-language parse).
 */
export function entryMissingSlTpRequiresNow(
  parsed: { action?: unknown; sl?: unknown; tp?: unknown },
  rawMessage: string,
  channelKeywords?: MarketNowKeywordFields | null,
): boolean {
  const action = String(parsed.action ?? '').toLowerCase()
  if (action !== 'buy' && action !== 'sell') return false
  if (messageHasMarketNowIntent(rawMessage, channelKeywords)) return false
  if (messageHasExplicitSlTpLabels(rawMessage)) return false
  if (parsedHasSlOrTp(parsed) && messageHasStructuredPriceEvidence(rawMessage)) return false
  return true
}
