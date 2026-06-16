import { tradeableFromParsed } from './backtestSignal'
import { looksLikeCasualNonTradeMessage } from './signalCommentaryGuard'
import {
  ENTRY_REQUIRES_NOW_REASON,
  entryMissingSlTpRequiresNow,
  messageHasMarketNowIntent,
  messageHasExplicitSlTpLabels,
  parsedHasSlOrTp,
  type MarketNowKeywordFields,
} from './signalEntryNowRequirement'
import { looksLikeChannelManagementUpdate } from './signalManagementIntent'
import { minPlausibleQuotePrice, sanitizeParsedSymbol } from './tradableSymbol'

export { ENTRY_REQUIRES_NOW_REASON } from './signalEntryNowRequirement'
export const COMMENTARY_NOT_SIGNAL_REASON = 'commentary_not_trade_signal'
export const ENTRY_MISSING_STRUCTURE_REASON = 'entry_missing_sl_tp_structure'

export function evaluateParsedSignalExecutionEligibility(
  parsed: {
    action?: unknown
    raw_instruction?: unknown
    symbol?: unknown
    entry_price?: unknown
    entry_zone_low?: unknown
    entry_zone_high?: unknown
    sl?: unknown
    tp?: unknown
    lot_size?: unknown
  } | null | undefined,
  rawMessage?: string | null,
  channelKeywords?: MarketNowKeywordFields | null,
): { eligible: boolean; skipReason?: string } {
  if (!parsed) return { eligible: false, skipReason: 'parsed_data_missing' }
  const action = String(parsed.action ?? '').toLowerCase()
  if (action !== 'buy' && action !== 'sell') return { eligible: true }

  const raw = String(rawMessage ?? parsed.raw_instruction ?? '').trim()
  if (raw) {
    if (looksLikeCasualNonTradeMessage(raw)) {
      return { eligible: false, skipReason: COMMENTARY_NOT_SIGNAL_REASON }
    }
    if (/\b\d+(?:\.\d+)?\s*pips?\s+short\s+of\s+tp\d*\b/i.test(raw)) {
      return { eligible: false, skipReason: COMMENTARY_NOT_SIGNAL_REASON }
    }
    if (looksLikeChannelManagementUpdate(raw) && action !== 'buy' && action !== 'sell'
      && !/\b(buy|sell|long|short)\b/i.test(raw)) {
      return { eligible: false, skipReason: COMMENTARY_NOT_SIGNAL_REASON }
    }
  }

  if (tradeableFromParsed(parsed)) {
    if (entryMissingSlTpRequiresNow(parsed, raw, channelKeywords)) {
      return { eligible: false, skipReason: ENTRY_REQUIRES_NOW_REASON }
    }
    return { eligible: true }
  }

  const symbol = sanitizeParsedSymbol(
    typeof parsed.symbol === 'string' ? parsed.symbol : null,
  )
  const minQuote = minPlausibleQuotePrice(symbol)
  if (minQuote != null && symbol) {
    const sl = positive(parsed.sl)
    const tps = Array.isArray(parsed.tp) ? parsed.tp.map(positive).filter((n): n is number => n != null) : []
    if ((sl != null && sl < minQuote) || tps.some(t => t < minQuote)) {
      return { eligible: false, skipReason: COMMENTARY_NOT_SIGNAL_REASON }
    }
  }

  if (symbol && parsedHasSlOrTp(parsed)) {
    return { eligible: false, skipReason: ENTRY_MISSING_STRUCTURE_REASON }
  }

  if (symbol && messageHasMarketNowIntent(raw, channelKeywords)) {
    return { eligible: true }
  }

  if (symbol && messageHasExplicitSlTpLabels(raw) && parsedHasSlOrTp(parsed)) {
    return { eligible: true }
  }

  if (symbol && (parsed.action === 'buy' || parsed.action === 'sell')) {
    return { eligible: false, skipReason: ENTRY_REQUIRES_NOW_REASON }
  }

  return { eligible: false, skipReason: ENTRY_MISSING_STRUCTURE_REASON }
}

function positive(v: unknown): number | null {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}
