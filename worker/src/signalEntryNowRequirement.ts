/** Channel keyword shape needed to detect trained market-order aliases. */
export type MarketNowKeywordFields = {
  signal?: { market_order?: string }
  additional?: { delimiters?: string }
}

export const ENTRY_REQUIRES_NOW_REASON = 'entry_requires_now_without_sl_tp'

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
  if (/\b(at\s+market|@\s*market)\b/i.test(raw)) return true
  if (/\b(?:market\s+order|buy\s+market|sell\s+market|market\s+buy|market\s+sell)\b/i.test(raw)) {
    return true
  }

  const nowLike = ['now', 'instant', 'mkt']
  const delim = channelKeywords?.additional?.delimiters ?? '|'
  const custom = channelKeywords?.signal?.market_order
    ? splitKeywordAliases(channelKeywords.signal.market_order, delim)
    : []
  for (const token of [...nowLike, ...custom.filter(t => t.toLowerCase() !== 'market')]) {
    if (token && keywordRegex(token).test(raw)) return true
  }

  if (keywordRegex('market').test(raw) && !isNonTradingMarketPhrase(raw)) {
    return true
  }

  return false
}

/** True when SL/TP appear as labeled parameters in the message (not inferred from prose). */
export function messageHasExplicitSlTpLabels(message: string): boolean {
  const text = String(message ?? '')
  if (/\b(?:sl|stop\s*loss)\s*[:=\-]?\s*\d/i.test(text)) return true
  if (/\b(?:sl|stop\s*loss)\s+to\s+\d/i.test(text)) return true
  if (/\b(?:tp|take\s*profit|target(?:\s+level)?)\s*#?\s*\d+\s*[:=\-]\s*\d/i.test(text)) return true
  if (/\b(?:tp|take\s*profit|target(?:\s+level)?)\s*[:=\-]\s*\d/i.test(text)) return true
  if (/\btp\s*\d+\s*[:=\-]\s*\d/i.test(text)) return true
  return false
}

/**
 * Buy/sell entries need NOW (or MARKET) unless the message includes explicit SL/TP labels.
 * Inferred SL/TP from bare numbers (e.g. £1110 profit) do not count as parameters.
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
  return true
}
