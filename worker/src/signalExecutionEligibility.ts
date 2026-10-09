import { tradeableFromParsed } from './backtestSignal'
import { looksLikeCasualNonTradeMessage } from './signalCommentaryGuard'
import { messageHasImperativeEntryPhrase } from './signalImperativeEntry'
import {
  ENTRY_REQUIRES_NOW_REASON,
  entryMissingSlTpRequiresNow,
  messageHasExplicitSlTpLabels,
  messageHasExplicitStopLabel,
  parsedHasSlOrTp,
  type MarketNowKeywordFields,
} from './signalEntryNowRequirement'
import { looksLikeChannelManagementUpdate } from './signalManagementIntent'
import { minPlausibleQuotePrice, reconcileSymbolWithQuoteLevels, sanitizeParsedSymbol, filterPlausibleInstrumentPrices } from './tradableSymbol'

export { ENTRY_REQUIRES_NOW_REASON } from './signalEntryNowRequirement'
export { ENTRY_TP_WITHOUT_SL_REASON } from './signalEntryNowRequirement'
export const COMMENTARY_NOT_SIGNAL_REASON = 'commentary_not_trade_signal'
export const ENTRY_MISSING_STRUCTURE_REASON = 'entry_missing_sl_tp_structure'
export const ENTRY_REQUIRES_IMPERATIVE_OR_LABELED_STOPS_REASON =
  'entry_requires_imperative_or_labeled_stops'

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

  // TP-without-SL is an *account* decision (predefined/RR SL can supply the stop).
  // Do not skip the signal here — entry prep still blocks accounts with no fallback.

  const imperative = messageHasImperativeEntryPhrase(raw, channelKeywords)
  const labeledStops = messageHasExplicitSlTpLabels(raw) && parsedHasSlOrTp(parsed)
  const structuredEntry = parsedStructuredEntryEligible(parsed)
  if (!imperative && !labeledStops && !structuredEntry) {
    return { eligible: false, skipReason: ENTRY_REQUIRES_IMPERATIVE_OR_LABELED_STOPS_REASON }
  }

  const symbol = reconcileSymbolWithQuoteLevels(
    typeof parsed.symbol === 'string' ? parsed.symbol : null,
    raw,
    { sl: parsed.sl, tp: parsed.tp, entry: parsed.entry_price },
  ) ?? sanitizeParsedSymbol(typeof parsed.symbol === 'string' ? parsed.symbol : null)
  const minQuote = minPlausibleQuotePrice(symbol)
  if (minQuote != null && symbol) {
    const sl = positive(parsed.sl)
    const tps = Array.isArray(parsed.tp) ? parsed.tp.map(positive).filter((n): n is number => n != null) : []
    const plausibleTps = filterPlausibleInstrumentPrices(symbol, tps)
    if (sl != null && sl < minQuote) {
      return { eligible: false, skipReason: COMMENTARY_NOT_SIGNAL_REASON }
    }
    if (tps.length > 0 && plausibleTps.length === 0) {
      return { eligible: false, skipReason: COMMENTARY_NOT_SIGNAL_REASON }
    }
  }

  if (labeledStops || structuredEntry) {
    if (tradeableFromParsed(parsed)) {
      if (entryMissingSlTpRequiresNow(parsed, raw, channelKeywords)) {
        return { eligible: false, skipReason: ENTRY_REQUIRES_NOW_REASON }
      }
      return { eligible: true }
    }
    if (symbol && parsedHasSlOrTp(parsed)) {
      return { eligible: false, skipReason: ENTRY_MISSING_STRUCTURE_REASON }
    }
  }

  if (imperative) {
    if (symbol || tradeableFromParsed(parsed)) {
      if (tradeableFromParsed(parsed) && entryMissingSlTpRequiresNow(parsed, raw, channelKeywords)) {
        return { eligible: false, skipReason: ENTRY_REQUIRES_NOW_REASON }
      }
      return { eligible: true }
    }
    return { eligible: false, skipReason: ENTRY_MISSING_STRUCTURE_REASON }
  }

  if (symbol && (parsed.action === 'buy' || parsed.action === 'sell')) {
    return { eligible: false, skipReason: ENTRY_REQUIRES_NOW_REASON }
  }

  return { eligible: false, skipReason: ENTRY_MISSING_STRUCTURE_REASON }
}

/** True when deterministic parser produced buy/sell but values would be skipped at execution. */
export function deterministicEntryNeedsAiRepair(
  parsed: Parameters<typeof evaluateParsedSignalExecutionEligibility>[0],
  rawMessage?: string | null,
  channelKeywords?: MarketNowKeywordFields | null,
): boolean {
  const action = String(parsed?.action ?? '').toLowerCase()
  if (action !== 'buy' && action !== 'sell') return false
  // The message states a stop but the parse carries none: one more parse attempt is
  // worthwhile before the account's own stop rules are applied. A signal whose text has
  // no stop label at all is not a parser gap and is left to entry prep.
  const raw = String(rawMessage ?? parsed?.raw_instruction ?? '').trim()
  if (raw && messageHasExplicitStopLabel(raw) && positive(parsed?.sl) == null) return true
  return !evaluateParsedSignalExecutionEligibility(parsed, rawMessage, channelKeywords).eligible
}

function positive(v: unknown): number | null {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** Parser extracted buy/sell + entry anchor + SL or TP — trust without "buy now" or label regex. */
function parsedHasEntryAnchor(parsed: {
  entry_price?: unknown
  entry_zone_low?: unknown
  entry_zone_high?: unknown
}): boolean {
  return positive(parsed.entry_price) != null
    || positive(parsed.entry_zone_low) != null
    || positive(parsed.entry_zone_high) != null
}

function parsedStructuredEntryEligible(
  parsed: Parameters<typeof evaluateParsedSignalExecutionEligibility>[0],
): boolean {
  if (!parsed || !parsedHasSlOrTp(parsed) || !parsedHasEntryAnchor(parsed)) return false
  return tradeableFromParsed(parsed as Record<string, unknown>) != null
}
