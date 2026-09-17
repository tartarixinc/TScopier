/**
 * In-process channel keyword parser (ported from supabase/functions/parse-signal).
 * No LLM, no broker calls — used on the live listener hot path to avoid edge HTTP latency.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  classifyPricesByDirection,
  detectReEnterIntent,
  entryReferenceFromParsed,
  extractBarePriceRangeZone,
  extractUnlabeledPrices,
  normalizeEntryZonePair,
  type TradeDirection,
} from './signalPriceInference'
import {
  bareTradePricesExcludingPips,
  looksLikeChannelManagementUpdate,
  looksLikeConditionalCloseSuggestion,
  looksLikeDeletePendingsCommand,
  looksLikeExplicitFullCloseCommand,
  looksLikeStructuredEntrySignal,
  partialCloseFractionFromMessage,
} from './signalManagementIntent'
import { SIGNAL_PRICE_NUM, parseSignalPriceListBlock, parseSignalPriceToken } from './signalPriceFormat'
import {
  extractTradableSymbolFromMessage,
  filterPlausibleInstrumentPrices,
  isTradableInstrumentSymbol,
  reconcileSymbolWithQuoteLevels,
  sanitizeParsedSymbol,
  signalBodyBeforePromoFooter,
} from './tradableSymbol'
import { looksLikeCasualNonTradeMessage } from './signalCommentaryGuard'
import { messageHasImperativeEntryPhrase } from './signalImperativeEntry'
import { normalizeTelegramMessageText, normalizeSignalMessageForParse } from './normalizeTelegramMessageText'
import {
  COMMON_BREAKEVEN_PHRASES,
  COMMON_PARTIAL_CLOSE_PHRASES,
} from './multilingualManagementTerms'
import { resolveManagementGroups } from './trainingManagementKeywords'
import {
  COMMON_BUY_TERMS,
  COMMON_ENTRY_TERMS,
  COMMON_MARKET_NOW_TERMS,
  COMMON_SELL_TERMS,
  COMMON_SL_TERMS,
  COMMON_TP_TERMS,
  foldAccents,
  messageContainsKeyword,
} from './multilingualSignalTerms'
import { entryMissingSlTpRequiresNow } from './signalEntryNowRequirement'
import {
  collapseForexBroBilingualMessage,
  extractProviderSignalNumber,
  parseForexBroManagementMessage,
} from './forexBroSignalPatterns'
import {
  entryRefFromParsed,
  resolveSlUnit,
  resolveTpUnit,
  tpClauseHasExplicitPips,
  type PriceUnit,
} from './signalStopUnits'
import type { EntryOrderType } from './manualPlanning/types'

/** Loose hint that a message references a Deriv synthetic index (any alias form). */
const DERIV_SYNTHETIC_HINT_RE =
  /\b(?:v(?:ix)?\s*\d{2,3}|vol(?:atility)?\s*\d{2,3}|r_?\d{2,3}|1hz\d{1,3}v|boom\s*\d{3,4}|crash\s*\d{3,4}|step(?:\s*index)?|stprng\d?|jump\s*\d{2,3}|jd\d{2,3}|range\s*break|rdbull|rdbear|bull\s*market|bear\s*market)\b/i

/** Structured instruction from Telegram text + per-channel keywords. */
export interface ChannelParsedSignal {
  action: string
  symbol: string | null
  entry_price: number | null
  entry_zone_low: number | null
  entry_zone_high: number | null
  /** Explicit provider instruction; null when the signal did not name an order type. */
  entry_order_type?: EntryOrderType | null
  sl: number | null
  tp: number[]
  /** Whether `tp` values are absolute prices or pip offsets from entry. */
  tp_unit?: PriceUnit
  /** Whether `sl` is an absolute price or a pip offset from entry. */
  sl_unit?: PriceUnit
  lot_size: number | null
  confidence: number
  raw_instruction: string
  open_tp?: boolean
  partial_close_fraction?: number | null
  /** Explicit channel intent to open a new trade (not modify existing). */
  re_enter?: boolean
  /** Provider-side trade id (e.g. ForexBro Signal #899). */
  provider_signal_number?: number | null
}

export type ChannelLexiconRow = {
  user_id: string
  channel_id: string
  action_aliases?: Record<string, string[]> | null
  tp_aliases?: string[] | null
  target_aliases?: string[] | null
  unknown_tokens?: string[] | null
}

export type ChannelKeywords = {
  signal: {
    entry_point: string
    buy: string
    sell: string
    sl: string
    tp: string
    market_order: string
  }
  update: {
    close_tp1: string
    close_tp2: string
    close_tp3: string
    close_tp4: string
    close_full: string
    close_half: string
    close_partial: string
    close_worse_entries: string
    break_even: string
    set_tp1: string
    set_tp2: string
    set_tp3: string
    set_tp4: string
    set_tp5: string
    set_tp: string
    adjust_tp: string
    set_sl: string
    adjust_sl: string
    delete: string
  }
  additional: {
    layer: string
    close_all: string
    delete_all: string
    ignore_keyword: string
    skip_keyword: string
    remove_sl: string
    delay_msec: number
    prefer_entry: "first_price" | "last_price"
    sl_in_pips: boolean
    tp_in_pips: boolean
    delimiters: string
    all_order: boolean
    read_forwarded: boolean
    read_image: boolean
  }
}

export const DEFAULT_CHANNEL_KEYWORDS: ChannelKeywords = {
  signal: {
    entry_point: "ENTRY",
    buy: "BUY",
    sell: "SELL",
    sl: "SL",
    tp: "TP",
    market_order: "MARKET",
  },
  update: {
    close_tp1: "CLOSE TP1",
    close_tp2: "CLOSE TP2",
    close_tp3: "CLOSE TP3",
    close_tp4: "CLOSE TP4",
    close_full: "CLOSE FULL",
    close_half: "CLOSE HALF",
    close_partial: "CLOSE PARTIAL",
    close_worse_entries: "CLOSE WORSE ENTRIES|CLOSE WORSE|CWE",
    break_even: "BREAK EVEN",
    set_tp1: "SET TP1",
    set_tp2: "SET TP2",
    set_tp3: "SET TP3",
    set_tp4: "SET TP4",
    set_tp5: "SET TP5",
    set_tp: "SET TP",
    adjust_tp: "ADJUST TP",
    set_sl: "SET SL|SET STOP LOSS|SET STOPLOSS|SET RISK",
    adjust_sl:
      "ADJUST SL|ADJUST STOP LOSS|ADJUST STOPLOSS|ADJUST RISK"
      + "|MOVE SL|MOVE STOP LOSS|MOVE STOPLOSS|MOVE RISK"
      + "|CHANGE SL|CHANGE STOP LOSS|CHANGE STOPLOSS|CHANGE RISK"
      + "|UPDATE SL|UPDATE STOP LOSS|UPDATE STOPLOSS|UPDATE RISK",
    delete: "DELETE",
  },
  additional: {
    layer: "LAYER",
    close_all: "CLOSE ALL",
    delete_all: "DELETE ALL",
    ignore_keyword: "IGNORE",
    skip_keyword: "SKIP",
    remove_sl: "REMOVE SL",
    delay_msec: 0,
    prefer_entry: "first_price",
    sl_in_pips: false,
    tp_in_pips: false,
    delimiters: "",
    all_order: false,
    read_forwarded: true,
    read_image: false,
  },
}

export function normalizeChannelKeywords(raw: unknown): ChannelKeywords {
  const j = raw && typeof raw === "object" ? raw as Record<string, unknown> : {}
  const signal = j.signal && typeof j.signal === "object" ? j.signal as Record<string, unknown> : {}
  const update = j.update && typeof j.update === "object" ? j.update as Record<string, unknown> : {}
  const additional = j.additional && typeof j.additional === "object" ? j.additional as Record<string, unknown> : {}
  return {
    signal: {
      entry_point: String(signal.entry_point ?? DEFAULT_CHANNEL_KEYWORDS.signal.entry_point),
      buy: String(signal.buy ?? DEFAULT_CHANNEL_KEYWORDS.signal.buy),
      sell: String(signal.sell ?? DEFAULT_CHANNEL_KEYWORDS.signal.sell),
      sl: String(signal.sl ?? DEFAULT_CHANNEL_KEYWORDS.signal.sl),
      tp: String(signal.tp ?? DEFAULT_CHANNEL_KEYWORDS.signal.tp),
      market_order: String(signal.market_order ?? DEFAULT_CHANNEL_KEYWORDS.signal.market_order),
    },
    update: {
      close_tp1: String(update.close_tp1 ?? DEFAULT_CHANNEL_KEYWORDS.update.close_tp1),
      close_tp2: String(update.close_tp2 ?? DEFAULT_CHANNEL_KEYWORDS.update.close_tp2),
      close_tp3: String(update.close_tp3 ?? DEFAULT_CHANNEL_KEYWORDS.update.close_tp3),
      close_tp4: String(update.close_tp4 ?? DEFAULT_CHANNEL_KEYWORDS.update.close_tp4),
      close_full: String(update.close_full ?? DEFAULT_CHANNEL_KEYWORDS.update.close_full),
      close_half: String(update.close_half ?? DEFAULT_CHANNEL_KEYWORDS.update.close_half),
      close_partial: String(update.close_partial ?? DEFAULT_CHANNEL_KEYWORDS.update.close_partial),
      close_worse_entries: String(update.close_worse_entries ?? DEFAULT_CHANNEL_KEYWORDS.update.close_worse_entries),
      break_even: String(update.break_even ?? DEFAULT_CHANNEL_KEYWORDS.update.break_even),
      set_tp1: String(update.set_tp1 ?? DEFAULT_CHANNEL_KEYWORDS.update.set_tp1),
      set_tp2: String(update.set_tp2 ?? DEFAULT_CHANNEL_KEYWORDS.update.set_tp2),
      set_tp3: String(update.set_tp3 ?? DEFAULT_CHANNEL_KEYWORDS.update.set_tp3),
      set_tp4: String(update.set_tp4 ?? DEFAULT_CHANNEL_KEYWORDS.update.set_tp4),
      set_tp5: String(update.set_tp5 ?? DEFAULT_CHANNEL_KEYWORDS.update.set_tp5),
      set_tp: String(update.set_tp ?? DEFAULT_CHANNEL_KEYWORDS.update.set_tp),
      adjust_tp: String(update.adjust_tp ?? DEFAULT_CHANNEL_KEYWORDS.update.adjust_tp),
      set_sl: String(update.set_sl ?? DEFAULT_CHANNEL_KEYWORDS.update.set_sl),
      adjust_sl: String(update.adjust_sl ?? DEFAULT_CHANNEL_KEYWORDS.update.adjust_sl),
      delete: String(update.delete ?? DEFAULT_CHANNEL_KEYWORDS.update.delete),
    },
    additional: {
      layer: String(additional.layer ?? DEFAULT_CHANNEL_KEYWORDS.additional.layer),
      close_all: String(additional.close_all ?? DEFAULT_CHANNEL_KEYWORDS.additional.close_all),
      delete_all: String(additional.delete_all ?? DEFAULT_CHANNEL_KEYWORDS.additional.delete_all),
      ignore_keyword: String(additional.ignore_keyword ?? DEFAULT_CHANNEL_KEYWORDS.additional.ignore_keyword),
      skip_keyword: String(additional.skip_keyword ?? DEFAULT_CHANNEL_KEYWORDS.additional.skip_keyword),
      remove_sl: String(additional.remove_sl ?? DEFAULT_CHANNEL_KEYWORDS.additional.remove_sl),
      delay_msec: Number(additional.delay_msec ?? DEFAULT_CHANNEL_KEYWORDS.additional.delay_msec) || 0,
      prefer_entry: String(additional.prefer_entry ?? DEFAULT_CHANNEL_KEYWORDS.additional.prefer_entry) === "last_price"
        ? "last_price"
        : "first_price",
      sl_in_pips: Boolean(additional.sl_in_pips ?? DEFAULT_CHANNEL_KEYWORDS.additional.sl_in_pips),
      tp_in_pips: Boolean(additional.tp_in_pips ?? DEFAULT_CHANNEL_KEYWORDS.additional.tp_in_pips),
      delimiters: String(additional.delimiters ?? DEFAULT_CHANNEL_KEYWORDS.additional.delimiters),
      all_order: Boolean(additional.all_order ?? DEFAULT_CHANNEL_KEYWORDS.additional.all_order),
      read_forwarded: Boolean(additional.read_forwarded ?? DEFAULT_CHANNEL_KEYWORDS.additional.read_forwarded),
      read_image: Boolean(additional.read_image ?? DEFAULT_CHANNEL_KEYWORDS.additional.read_image),
    },
  }
}

function splitKeywordAliases(raw: string, delimiters = ""): string[] {
  const extra = String(delimiters ?? "").replace(/\s+/g, "")
  const chars = [",", ";", "\n", "|", ...extra.split("")].filter(Boolean).map((c) => escapeRegExp(c))
  const splitter = new RegExp(`[${chars.join("")}]+`)
  return String(raw ?? "")
    .split(splitter)
    .map((x) => x.trim())
    .filter(Boolean)
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function keywordRegex(phrase: string): RegExp {
  const p = escapeRegExp(phrase.trim()).replace(/\s+/g, '\\s+')
  return new RegExp(`(?<![\\p{L}\\p{N}])${p}(?![\\p{L}\\p{N}])`, 'iu')
}

function hasAnyKeyword(text: string, words: string[]): boolean {
  const folded = foldAccents(text)
  return words.some((w) => {
    if (!w) return false
    return keywordRegex(w).test(text) || keywordRegex(foldAccents(w)).test(folded)
  })
}

/** Soft prose around "entry" that is discussion, not a priced entry level. */
function isSoftEntryProse(message: string): boolean {
  return (
    /\b(?:not a bad|good|nice|solid|decent|bad)\s+entry\b/i.test(message)
    || /\b(?:our|the|this|that)\s+entry\b/i.test(message)
    || /\bclose to (?:our\s+)?entry\b/i.test(message)
  )
}

/**
 * True when an entry_point keyword is backed by a numeric price/zone nearby,
 * or the alias itself is an imperative phrase (e.g. "gold buy now") rather than bare "ENTRY".
 * Bare prose "not a bad entry" must not count as price evidence.
 */
function hasEntryPointPriceEvidence(
  message: string,
  entryPointAliases: string[],
): boolean {
  if (!entryPointAliases.length) return false
  if (isSoftEntryProse(message) && !/\bentry\s*(?:price|level)?\s*[:=\-]?\s*\d/i.test(message)) {
    return false
  }

  const text = message.replace(/\s+/g, ' ').trim()
  for (const alias of entryPointAliases) {
    const a = String(alias ?? '').trim()
    if (!a) continue
    if (!hasAnyKeyword(message, [a])) continue

    // Phrase aliases that already encode an imperative entry (not the word "entry" alone).
    if (!/^\s*entr(?:y|ée|ee)\s*$/i.test(a) && !/\bentry\b/i.test(a)) {
      return true
    }
    if (/\b(?:buy|sell)\s+now\b/i.test(a) || /\b(?:now|market)\b/i.test(a)) {
      return true
    }

    // Require a numeric price adjacent to this entry label.
    const labeled = new RegExp(
      `${escapeRegExp(a).replace(/\s+/g, '\\s+')}\\s*(?:price|level)?\\s*[:=\\-]?\\s*(${SIGNAL_PRICE_NUM})`,
      'i',
    )
    if (labeled.test(text)) return true

    const zone = new RegExp(
      `${escapeRegExp(a).replace(/\s+/g, '\\s+')}\\s*(?:price|level)?\\s*[:=\\-]?\\s*(${SIGNAL_PRICE_NUM})\\s*(?:\\/|\\band\\b|-|–|to)\\s*(${SIGNAL_PRICE_NUM})`,
      'i',
    )
    if (zone.test(text)) return true
  }

  // Generic "entry 2650" / "entry: 2650-2655" even when alias is just ENTRY.
  if (/\bentry\s*(?:price|level)?\s*[:=]?\s*\d/i.test(text)) return true
  if (/\bentry\s+zone\b/i.test(text) && new RegExp(SIGNAL_PRICE_NUM).test(text)) return true

  return false
}

function lexiconActionAliases(lexicon: ChannelLexiconRow | null, key: string): string[] {
  const raw = lexicon?.action_aliases?.[key]
  if (!Array.isArray(raw)) return []
  return raw.map((a) => String(a).trim()).filter(Boolean)
}

function buyAliasesForChannel(
  channelKeywords: ChannelKeywords,
  lexicon: ChannelLexiconRow | null = null,
): string[] {
  const delim = channelKeywords.additional.delimiters
  return Array.from(new Set([
    'buy', 'long',
    ...COMMON_BUY_TERMS,
    ...splitKeywordAliases(channelKeywords.signal.buy, delim),
    ...lexiconActionAliases(lexicon, 'buy'),
  ]))
}

/** Sell aliases like "tp: open" must not count as sell direction on buy + TP posts. */
function sellAliasesForChannel(
  channelKeywords: ChannelKeywords,
  lexicon: ChannelLexiconRow | null = null,
): string[] {
  const delim = channelKeywords.additional.delimiters
  return Array.from(new Set([
    'sell', 'short',
    ...COMMON_SELL_TERMS,
    ...splitKeywordAliases(channelKeywords.signal.sell, delim),
    ...lexiconActionAliases(lexicon, 'sell'),
  ])).filter(alias => {
    const t = alias.trim().toLowerCase()
    if (!t) return false
    if (/^tp\s*:/i.test(t) && !/\b(sell|short)\b/i.test(t)) return false
    if (/^all\s+tp/i.test(t) && !/\b(sell|short)\b/i.test(t)) return false
    return true
  })
}

function slLabelsForChannel(
  channelKeywords: ChannelKeywords,
  includeMgmt = true,
): string[] {
  const delim = channelKeywords.additional.delimiters
  return Array.from(new Set([
    ...COMMON_SL_TERMS,
    ...splitKeywordAliases(channelKeywords.signal.sl, delim),
    ...(includeMgmt ? [
      ...splitKeywordAliases(channelKeywords.update.set_sl, delim),
      ...splitKeywordAliases(channelKeywords.update.adjust_sl, delim),
    ] : []),
  ]))
}

function tpLabelsForChannel(
  channelKeywords: ChannelKeywords,
  lexicon: ChannelLexiconRow | null = null,
  includeMgmt = true,
): string[] {
  const delim = channelKeywords.additional.delimiters
  return Array.from(new Set([
    ...COMMON_TP_TERMS,
    ...(lexicon?.tp_aliases ?? []),
    ...(lexicon?.target_aliases ?? []),
    ...splitKeywordAliases(channelKeywords.signal.tp, delim),
    ...(includeMgmt ? [
      ...splitKeywordAliases(channelKeywords.update.set_tp, delim),
      ...splitKeywordAliases(channelKeywords.update.adjust_tp, delim),
    ] : []),
  ]))
}

function entryLabelsForChannel(channelKeywords: ChannelKeywords): string[] {
  const delim = channelKeywords.additional.delimiters
  return Array.from(new Set([
    ...COMMON_ENTRY_TERMS,
    ...splitKeywordAliases(channelKeywords.signal.entry_point, delim),
  ]))
}

function isProseLongMatch(text: string): boolean {
  return /(?:^|\b)(?:too|so|as|how)\s+long(?:\b|$)/i.test(text)
}

function isProseShortMatch(text: string): boolean {
  return (
    /\bshort\s+of\b/i.test(text)
    || /\bin\s+short\b/i.test(text)
    || /\bshort\s+term\b/i.test(text)
  )
}

function isGerundOrPastSideProse(message: string): boolean {
  return (
    /\b(?:selling|buying)\s+(?:gold|xau(?:usd)?|silver|xag(?:usd)?|btc(?:usd|usdt)?|bitcoin|eth(?:usd)?)\b/i.test(message)
    || /\b(?:sold|bought)\s+(?:gold|xau(?:usd)?|silver|xag(?:usd)?)\b/i.test(message)
    || /\b(?:gold|xau(?:usd)?)\s+(?:sold|bought)\b/i.test(message)
  )
}

function isGerundSideKeyword(text: string, side: 'buy' | 'sell'): boolean {
  if (side === 'buy') {
    return /\bbuying\b/i.test(text) && !/\bbuy\s+now\b/i.test(text)
  }
  return /\bselling\b/i.test(text) && !/\bsell\s+now\b/i.test(text)
}

function parseBuySideFromKeywords(text: string, words: string[]): boolean {
  for (const w of words) {
    if (!w) continue
    const lower = w.toLowerCase().trim()
    if (lower === 'buy' && isGerundSideKeyword(text, 'buy')) continue
    if (lower === 'long') {
      if (isProseLongMatch(text)) continue
      if (keywordRegex('long').test(text)) return true
      continue
    }
    if (keywordRegex(w).test(text)) return true
  }
  return false
}

function parseSellSideFromKeywords(text: string, words: string[]): boolean {
  for (const w of words) {
    if (!w) continue
    const lower = w.toLowerCase().trim()
    if (lower === 'sell' && isGerundSideKeyword(text, 'sell')) continue
    if (lower === 'short') {
      if (isProseShortMatch(text)) continue
      if (keywordRegex('short').test(text)) return true
      continue
    }
    if (keywordRegex(w).test(text)) return true
  }
  return false
}

function parseSideFromKeywords(text: string, words: string[]): boolean {
  return hasAnyKeyword(text, words)
}

/** Sell aliases like "tp: open" must not count as sell direction on buy + TP posts. */
function sellAliasesForSideDetection(
  channelKeywords: ChannelKeywords,
  lexicon: ChannelLexiconRow | null = null,
): string[] {
  return sellAliasesForChannel(channelKeywords, lexicon)
}

function resolveTradeSideFromMessage(
  message: string,
  channelKeywords: ChannelKeywords,
  lexicon: ChannelLexiconRow | null = null,
): 'buy' | 'sell' | null {
  const text = message.replace(/\s+/g, ' ').trim()
  if (isGerundOrPastSideProse(text) && !messageHasImperativeEntryPhrase(text, channelKeywords)) {
    return null
  }
  const goldBuy = /\bgold\s+buy\b|\bbuy\s+gold\b/i.test(text)
  const goldSell = /\bgold\s+sell\b|\bsell\s+gold\b/i.test(text)
  if (goldBuy && !goldSell) return 'buy'
  if (goldSell && !goldBuy) return 'sell'

  // Prefer explicit instrument+side lines over legal "buy or sell" boilerplate.
  const instrumentSide = text.match(
    /\b(?:sell|short)\s+(?:xauusd|xagusd|gold|btcusd|eurusd|[a-z]{6})\b|\b(?:xauusd|xagusd|gold|btcusd|eurusd|[a-z]{6})\s+(?:sell|short)\b/i,
  )
  const instrumentBuy = text.match(
    /\b(?:buy|long)\s+(?:xauusd|xagusd|gold|btcusd|eurusd|[a-z]{6})\b|\b(?:xauusd|xagusd|gold|btcusd|eurusd|[a-z]{6})\s+(?:buy|long)\b/i,
  )
  if (instrumentSide && !instrumentBuy) return 'sell'
  if (instrumentBuy && !instrumentSide) return 'buy'

  const sideText = text
    .replace(/\b(?:to\s+)?buy\s+or\s+sell\b/gi, ' ')
    .replace(/\b(?:to\s+)?buy\s+and\s+sell\b/gi, ' ')
    .replace(/\bbuying\s+or\s+selling\b/gi, ' ')
    .replace(/\bsolicitation\s+to\s+buy\b/gi, ' ')

  const buyAliases = buyAliasesForChannel(channelKeywords, lexicon)
  const sellAliases = sellAliasesForSideDetection(channelKeywords, lexicon)
  const isBuy = parseBuySideFromKeywords(sideText, buyAliases)
  const isSell = parseSellSideFromKeywords(sideText, sellAliases)
  if (isBuy && !isSell) return 'buy'
  if (isSell && !isBuy) return 'sell'
  return null
}

function buildTpRegex(extraLabels: string[] = []): RegExp {
  const base = ["tp", "take\\s*profit", "target(?:\\s+level)?"]
  const custom = extraLabels.map((x) => escapeRegExp(x.trim())).filter(Boolean)
  // Guard against tier ordinals being mistaken for TP prices in shapes like:
  // "Take Profit 1: 4514.00" (capture 4514, not the ordinal 1).
  return new RegExp(
    `\\b(?:${[...base, ...custom].join("|")})(?:\\s*[:=\\-]\\s*|\\s+|\\.\\s*)(${SIGNAL_PRICE_NUM})(?!\\s*[:=\\-]\\s*${SIGNAL_PRICE_NUM})`,
    "gi",
  )
}

function extractTpLevels(message: string, extraLabels: string[] = []): {
  values: number[]
  explicitPips: boolean
} {
  const text = String(message ?? "")
  type TpHit = { index: number; value: number }
  const hits: TpHit[] = []
  let explicitPips = tpClauseHasExplicitPips(text)

  const collect = (rx: RegExp) => {
    for (const m of text.matchAll(rx)) {
      const value = parseSignalPriceToken(m[1])
      if (value == null) continue
      hits.push({ index: m.index ?? 0, value })
      const after = text.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 12)
      if (/^\s*pips?\b/i.test(after) || /^pips?\b/i.test(after)) explicitPips = true
    }
  }

  // Numbered tiers first — "TP 1 4086" must not capture ordinal 1 via the generic TP regex.
  collect(new RegExp(`\\b(?:tp|take\\s*profit|target(?:\\s+level)?)\\s*#\\s*\\d+\\s*[:=\\-]\\s*(${SIGNAL_PRICE_NUM})`, 'gi'))
  collect(new RegExp(`\\b(?:tp|take\\s*profit|target(?:\\s+level)?)\\s+\\d+\\s*[:=\\-]\\s*(${SIGNAL_PRICE_NUM})`, 'gi'))
  collect(new RegExp(`\\b(?:tp|target(?:\\s+level)?)\\s*\\d+\\s*[:=\\-]\\s*(${SIGNAL_PRICE_NUM})`, 'gi'))
  collect(new RegExp(`\\b(?:tp|target(?:\\s+level)?)\\s*\\d+\\s+(${SIGNAL_PRICE_NUM})`, 'gi'))
  collect(new RegExp(`\\btp\\s*\\.\\s*(${SIGNAL_PRICE_NUM})`, 'gi'))
  collect(new RegExp(`\\b(?:tp|take\\s*profit)\\b[.\\s]+(${SIGNAL_PRICE_NUM})`, 'gi'))
  // Tier index only (1–2 digits): "TP1. 4066". Must not match "TP 4053.22" (full decimal price).
  collect(new RegExp(`\\btp\\s*\\d{1,2}\\s*\\.\\s*(${SIGNAL_PRICE_NUM})`, 'gi'))
  collect(new RegExp(`\\btp\\s*\\d{1,2}[.\\s]+(${SIGNAL_PRICE_NUM})`, 'gi'))
  collect(new RegExp(`\\btp[\\u00B9\\u00B2\\u00B3\\u2070-\\u2079]+(${SIGNAL_PRICE_NUM})`, 'giu'))
  collect(new RegExp(`(?:الهدف\\s*(?:الأول|الثاني|الثالث|\\d+)|جني\\s*الأرباح|جني\\s*الارباح)\\s*[:：]?\\s*(${SIGNAL_PRICE_NUM})`, 'giu'))

  collect(buildTpRegex(extraLabels))
  // TP: 4557 / 4527 (slash-separated tiers on one label — not thousands commas)
  for (const m of text.matchAll(
    /\b(?:tp|take\s*profit|target(?:\s+level)?)\s*[:=]?\s*((?:\d+(?:\.\d+)?(?:\s*(?:\/|\band\b|\|)\s*)+)+\d+(?:\.\d+)?)(?:\s*pips?\b)?/gi,
  )) {
    const block = m[1] ?? ''
    const base = m.index ?? 0
    const offset = m[0].indexOf(block)
    const normalized = block.replace(/,/g, '')
    if (/\bpips?\b/i.test(m[0])) explicitPips = true
    for (const part of normalized.split(/\s*(?:\/|\band\b|\|)\s*/i)) {
      const value = parseSignalPriceToken(part.trim())
      if (value == null) continue
      const partStart = base + offset + normalized.indexOf(part)
      hits.push({ index: partStart, value })
    }
  }

  if (!hits.length) return { values: [], explicitPips: false }

  hits.sort((a, b) => a.index - b.index)
  const seenIndex = new Set<number>()
  const seenValues = new Set<number>()
  const values: number[] = []
  for (const hit of hits) {
    if (seenIndex.has(hit.index)) continue
    seenIndex.add(hit.index)
    if (seenValues.has(hit.value)) continue
    seenValues.add(hit.value)
    values.push(hit.value)
  }
  return { values, explicitPips }
}

function detectOpenTp(message: string): boolean {
  const t = String(message ?? "")
  return /\b(open\s*tp|without\s*tp|no\s*tp|runner|let\s+it\s+run|leave\s+runner)\b/i.test(t)
    || /\b(?:tp|take\s*profit)\s*[:=]?\s*open\b/i.test(t)
}

function extractPriceByLabels(message: string, labels: string[]): number | null {
  for (const label of labels) {
    const k = String(label ?? "").trim()
    if (!k) continue
    const rx = new RegExp(`${escapeRegExp(k).replace(/\s+/g, "\\s*")}\\s*[:=\\-]?\\s*(${SIGNAL_PRICE_NUM})`, "i")
    const m = message.match(rx)
    if (m?.[1]) {
      const n = parseSignalPriceToken(m[1])
      if (n != null) return n
    }
  }
  return null
}

function isManagementAction(action: string): boolean {
  return new Set([
    "close",
    "close_worse_entries",
    "breakeven",
    "partial_profit",
    "partial_breakeven",
    "modify",
    "delete_pendings",
  ]).has(String(action ?? "").toLowerCase())
}

function normalizeParsedFromModel(raw: unknown, fallbackText: string): ChannelParsedSignal {
  const j = raw && typeof raw === "object" ? raw as Record<string, unknown> : {}
  let action = String(j.action ?? "ignore").trim().toLowerCase()
  if (action === "long") action = "buy"
  if (action === "short") action = "sell"
  if (action === "cancel_pending" || action === "cancel_pendings") action = "delete_pendings"
  const allowed = new Set([
    "buy", "sell", "close", "close_worse_entries", "breakeven", "partial_profit", "partial_breakeven",
    "modify", "delete_pendings", "ignore",
  ])
  if (!allowed.has(action)) action = "ignore"

  const numOrNull = (v: unknown): number | null => {
    if (v == null || v === "") return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }

  let symbol = sanitizeParsedSymbol(
    typeof j.symbol === "string" ? j.symbol : null,
  )

  let tp: number[] = []
  if (Array.isArray(j.tp)) {
    tp = j.tp.map((x) => Number(x)).filter((n) => Number.isFinite(n))
  }

  let confidence = Number(j.confidence)
  if (!Number.isFinite(confidence)) {
    confidence = action !== "ignore" ? 0.95 : 0
  }
  confidence = Math.min(1, Math.max(0, confidence))

  const raw_instruction =
    typeof j.raw_instruction === "string" && j.raw_instruction.trim().length > 0
      ? j.raw_instruction
      : fallbackText

  const pcfRaw = j.partial_close_fraction
  let partial_close_fraction: number | undefined
  if (pcfRaw != null && pcfRaw !== "") {
    const n = Number(pcfRaw)
    if (Number.isFinite(n) && n > 0 && n <= 1) partial_close_fraction = n
  }

  const re_enter = j.re_enter === true || detectReEnterIntent(raw_instruction)
  const provider_signal_number = numOrNull(j.provider_signal_number)

  const tpUnitRaw = typeof j.tp_unit === 'string' ? j.tp_unit.trim().toLowerCase() : ''
  const slUnitRaw = typeof j.sl_unit === 'string' ? j.sl_unit.trim().toLowerCase() : ''
  const tp_unit: PriceUnit | undefined =
    tpUnitRaw === 'pips' || tpUnitRaw === 'price' ? (tpUnitRaw as PriceUnit) : undefined
  const sl_unit: PriceUnit | undefined =
    slUnitRaw === 'pips' || slUnitRaw === 'price' ? (slUnitRaw as PriceUnit) : undefined

  return {
    action,
    symbol,
    entry_price: numOrNull(j.entry_price),
    entry_zone_low: numOrNull(j.entry_zone_low),
    entry_zone_high: numOrNull(j.entry_zone_high),
    sl: numOrNull(j.sl),
    tp,
    ...(tp_unit ? { tp_unit } : {}),
    ...(sl_unit ? { sl_unit } : {}),
    lot_size: numOrNull(j.lot_size),
    confidence,
    raw_instruction,
    open_tp: Boolean(j.open_tp ?? detectOpenTp(fallbackText)),
    ...(partial_close_fraction != null ? { partial_close_fraction } : {}),
    ...(re_enter ? { re_enter: true } : {}),
    ...(provider_signal_number != null ? { provider_signal_number } : {}),
  }
}

const ENTRY_KW = /\b(buy|sell|long|short)\b/i

function wantsExplicitFullClose(
  message: string,
  kwClose: string[],
  channelKeywords: ChannelKeywords,
  lexicon: ChannelLexiconRow | null,
): boolean {
  if (looksLikeExplicitFullCloseCommand(message, { channelKeywords, lexicon })) return true
  return hasAnyKeyword(message, kwClose)
}

/** Stop-loss labels used in management updates (providers often say "risk" or "stoploss"). */
const SL_TEXT_LABELS = 'sl|stop\\s*loss|stoploss|risk|وقف\\s*الخسارة|وقف'
const TP_TEXT_LABELS = 'tp|take\\s*profit|target|الهدف(?:\\s*(?:الأول|الثاني|الثالث|\\d+))?|جني\\s*الأرباح'
const SL_MGMT_VERBS = 'set|move|adjust|bring|change|update|make|modify'

function parseAtPriceExcludingSlTp(text: string): number | null {
  for (const m of text.matchAll(new RegExp(`@\\s*(${SIGNAL_PRICE_NUM})\\b`, 'gi'))) {
    const start = m.index ?? 0
    const before = text.slice(Math.max(0, start - 32), start)
    if (/\b(?:sl|stop\s*loss|stoploss|tp|take\s*profit)\b[_\s./]*$/i.test(before)) continue
    if (/\bsl\b[_\s]*\/\s*@?\s*$/i.test(before)) continue
    const value = parseSignalPriceToken(m[1] ?? '')
    if (value != null) return value
  }
  return null
}

function entryZoneFromRawTokens(rawA: string, rawB: string): { entry_zone_low: number; entry_zone_high: number } | null {
  const zone = normalizeEntryZonePair(rawA, rawB)
  if (!zone) return null
  return { entry_zone_low: zone.low, entry_zone_high: zone.high }
}

/** Drop RRR / risk-reward ratio chatter so "1:3+" is not parsed as SL. */
function stripRiskRewardRatioNoise(text: string): string {
  return String(text ?? '')
    .replace(/\bRRR\b(?:\s*\([^)]*\))?/gi, ' ')
    .replace(/\brisk\s*[-/]?\s*to\s*[-/]?\s*reward(?:\s*ratio)?\b/gi, ' ')
    .replace(/\b\d+(?:\.\d+)?\s*:\s*\d+(?:\.\d+)?\+?(?:\s*(?:rrr|rr|r\/r))?\b/gi, ' ')
}

function pricesExcludingRatioTokens(clause: string, prices: number[]): number[] {
  const ratioNums = new Set<number>()
  for (const m of String(clause).matchAll(/\b(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\+?/g)) {
    const a = Number(m[1])
    const b = Number(m[2])
    if (Number.isFinite(a) && a > 0) ratioNums.add(a)
    if (Number.isFinite(b) && b > 0) ratioNums.add(b)
  }
  if (ratioNums.size === 0) return prices
  return prices.filter((p) => !ratioNums.has(p))
}

function slPriceFromClause(clause: string): number | null {
  const cleaned = stripRiskRewardRatioNoise(clause)
  const slClauseTo = cleaned.match(new RegExp(`(?:\\bto\\b|إلى)\\s*(${SIGNAL_PRICE_NUM})`, 'iu'))
  if (slClauseTo?.[1]) return parseSignalPriceToken(slClauseTo[1])
  const candidates = pricesExcludingRatioTokens(
    clause,
    bareTradePricesExcludingPips(cleaned, extractUnlabeledPrices(cleaned)),
  )
  // Prefer the first price after the SL label (e.g. "SL (STOP LOSS): 4325"), not
  // trailing ratio / hype numbers that may remain in a long clause.
  const head = candidates.length > 0 ? candidates[0] : null
  if (head != null && Number.isFinite(head) && head > 0) return head
  return null
}

function looksLikeStopOrTpAdjustCommand(text: string): boolean {
  const t = text.replace(/\s+/g, ' ').trim()
  if (!t) return false
  return (
    new RegExp(`\\b(?:${SL_MGMT_VERBS})\\s+(?:${SL_TEXT_LABELS}|${TP_TEXT_LABELS})\\b`, 'i').test(t)
    || new RegExp(`\\b(?:${SL_TEXT_LABELS}|${TP_TEXT_LABELS})\\s*(?:to|=)\\s*\\d`, 'i').test(t)
  )
}

function parseSlFromText(text: string): number | null {
  const cleaned = stripRiskRewardRatioNoise(text)
  const slSlashAt = cleaned.match(
    /(?:^|\s)(?:sl|stop\s*loss|stoploss)[_\s]*\/\s*@\s*(\d+(?:\.\d+)?)/i,
  )
  if (slSlashAt?.[1]) return parseSignalPriceToken(slSlashAt[1])
  // "SL (STOP LOSS): 4325" / "Stop Loss (SL): 4325"
  const slParenthetical = cleaned.match(
    new RegExp(
      `\\b(?:sl|stop\\s*loss|stoploss)\\b(?:\\s*\\([^)]*\\))?\\s*[:=@\\-]?\\s*(${SIGNAL_PRICE_NUM})`,
      'i',
    ),
  )
  if (slParenthetical?.[1]) return parseSignalPriceToken(slParenthetical[1])
  const slDotLeader = cleaned.match(
    new RegExp(`\\b(?:${SL_TEXT_LABELS})\\b[.\\s]+(${SIGNAL_PRICE_NUM})`, 'i'),
  )
  if (slDotLeader?.[1]) return parseSignalPriceToken(slDotLeader[1])
  const slDotLabel = cleaned.match(/\b(?:sl|stop\s*loss)\b\s*\.\s*(\d+(?:\.\d+)?)/i)
  if (slDotLabel?.[1]) return parseSignalPriceToken(slDotLabel[1])
  const slMatchStandard = cleaned.match(
    new RegExp(`\\b(?:${SL_TEXT_LABELS})\\s*[:=@]?\\s*(${SIGNAL_PRICE_NUM})`, 'i'),
  )
  if (slMatchStandard?.[1]) return parseSignalPriceToken(slMatchStandard[1])
  const slMatchTo = cleaned.match(
    new RegExp(`\\b(?:${SL_TEXT_LABELS})\\s+(?:to|إلى)\\s+(${SIGNAL_PRICE_NUM})`, 'iu'),
  )
  if (slMatchTo?.[1]) return parseSignalPriceToken(slMatchTo[1])
  // "Adjust Risk/SL/Stoploss … (+ pips) … to 4505"
  const mgmtAdjust = cleaned.match(
    new RegExp(`\\b(?:${SL_MGMT_VERBS})\\s+(?:${SL_TEXT_LABELS})\\b([^\\n\\r]{0,120})`, 'i'),
  )
  if (mgmtAdjust?.[1]) {
    const fromMgmt = slPriceFromClause(mgmtAdjust[1])
    if (fromMgmt != null) return fromMgmt
  }
  // Handles verbose updates like "Adjust SL + 20 pips for now to 4505".
  // Prefer explicit SL/stop-loss labels over bare "risk" (RRR chatter).
  const slClause =
    cleaned.match(new RegExp(`\\b(?:sl|stop\\s*loss|stoploss|وقف\\s*الخسارة|وقف)\\b([^\\n\\r]{0,96})`, 'i'))?.[1]
    ?? cleaned.match(new RegExp(`\\b(?:${SL_TEXT_LABELS})\\b([^\\n\\r]{0,96})`, 'i'))?.[1]
    ?? ''
  if (slClause) {
    const fromClause = slPriceFromClause(slClause)
    if (fromClause != null) return fromClause
  }
  return null
}

function parseDeterministicManagement(
  message: string,
  lexicon: ChannelLexiconRow | null,
  channelKeywords: ChannelKeywords,
): ChannelParsedSignal | null {
  const t = message.replace(/\s+/g, " ").trim()
  if (!t) return null
  if (looksLikeStructuredEntrySignal(t)) return null
  const tl = t.toLowerCase()

  const sym = extractTradableSymbolFromMessage(t)
  let action: ChannelParsedSignal["action"] | null = null
  let partial_close_fraction: number | undefined
  let confidence = 0.92
  const delim = channelKeywords.additional.delimiters
  const legacyMgmt = resolveManagementGroups({
    management_cues: lexicon?.action_aliases?.modify ?? [],
  })
  const kwClose = [
    ...splitKeywordAliases(channelKeywords.update.close_full, delim),
    ...splitKeywordAliases(channelKeywords.additional.close_all, delim),
    ...legacyMgmt.close_all,
  ]
  const kwCloseHalf = splitKeywordAliases(channelKeywords.update.close_half, delim)
  const kwClosePartialOnly = splitKeywordAliases(channelKeywords.update.close_partial, delim)
  const kwCloseTpTiers = [
    ...splitKeywordAliases(channelKeywords.update.close_tp1, delim),
    ...splitKeywordAliases(channelKeywords.update.close_tp2, delim),
    ...splitKeywordAliases(channelKeywords.update.close_tp3, delim),
    ...splitKeywordAliases(channelKeywords.update.close_tp4, delim),
  ]
  const kwPartial = [...kwCloseHalf, ...kwClosePartialOnly, ...kwCloseTpTiers]
  const kwBreakeven = [
    ...splitKeywordAliases(channelKeywords.update.break_even, delim),
    ...legacyMgmt.break_even,
  ]
  const kwCloseWorse = splitKeywordAliases(channelKeywords.update.close_worse_entries, delim)
  const kwModify = [
    ...splitKeywordAliases(channelKeywords.update.set_sl, delim),
    ...splitKeywordAliases(channelKeywords.update.adjust_sl, delim),
    ...splitKeywordAliases(channelKeywords.update.set_tp, delim),
    ...splitKeywordAliases(channelKeywords.update.adjust_tp, delim),
    ...splitKeywordAliases(channelKeywords.update.set_tp1, delim),
    ...splitKeywordAliases(channelKeywords.update.set_tp2, delim),
    ...splitKeywordAliases(channelKeywords.update.set_tp3, delim),
    ...splitKeywordAliases(channelKeywords.update.set_tp4, delim),
    ...splitKeywordAliases(channelKeywords.update.set_tp5, delim),
    ...splitKeywordAliases(channelKeywords.additional.remove_sl, delim),
  ]

  const hitCloseHalfKw = hasAnyKeyword(t, kwCloseHalf)
  const hitClosePartialKw = hasAnyKeyword(t, kwClosePartialOnly)
  const hitCloseTpTierKw = hasAnyKeyword(t, kwCloseTpTiers)

  const wantsPartialHalf =
    hitCloseHalfKw ||
    hitClosePartialKw ||
    hitCloseTpTierKw ||
    COMMON_PARTIAL_CLOSE_PHRASES.some(p => messageContainsKeyword(t, p)) ||
    /\b(close\s+partials?|close\s+half|close\s+50%|take\s+partials?|take\s+half|take\s+50%|c\s+half|half\s+of\s+(the\s+)?(position|trade))\b/i.test(t) ||
    /\b(closing\s+partial|close\s+partial\s+(?:lot|lots|lotsize|position|trade))\b/i.test(t) ||
    /\bsecure\s+\d+\s*%\s*profit/i.test(t) ||
    /\btake\s+profit\s+(?:target\s+)?(?:is\s+)?hit\b/i.test(t) ||
    /\b(50|half)\s*%?\s*(of\s+)?(the\s+)?(position|trade|lot|profit)\b/i.test(t) ||
    /\b(25|quarter|30|40|75)\s*%?\s*(of\s+)?(the\s+)?(position|trade|lot|profit)\b/i.test(tl) ||
    hasAnyKeyword(t, kwPartial)
  const wantsBreakeven =
    COMMON_BREAKEVEN_PHRASES.some(p => messageContainsKeyword(t, p)) ||
    /\bbreakeven|break\s*even\b/i.test(t) ||
    /\bmove\s+stop\s+to\s+(?:breakeven|break\s*even|entry|be)\b/i.test(t) ||
    /\bmoved?\s+(sl\s+)?to\s+(be|entry|entr(y)?\s?price)|\b(be|bk)\s*now\b/i.test(t) ||
    /\bstop\s*loss\s+to\s+(be|entry|breakeven|break\s*even)\b/i.test(t) ||
    /\b(?:sl|stop)\s+to\s+(be|entry|breakeven|break\s*even)\b/i.test(t) ||
    /\bmove\s+.*\b(stop\s*loss|sl|stop)\b.*\b(breakeven|break\s*even|entry|be)\b/i.test(t) ||
    hasAnyKeyword(t, kwBreakeven)

  const wantsCloseWorseEntries =
    /\bclose\s+worse\s+entr(?:y|ies)\b/i.test(t) ||
    /\bclose\s+worse\b/i.test(t) ||
    hasAnyKeyword(t, kwCloseWorse)

  const resolvePartialFraction = (): number | null => {
    if (
      hitCloseHalfKw ||
      /\b(close\s+half|take\s+half|close\s+50%|take\s+50%|c\s+half|half\s+of\s+(the\s+)?(position|trade))\b/i.test(t) ||
      /\b(50|half)\s*%?\s*(of\s+)?(the\s+)?(position|trade|lot|profit)\b/i.test(t)
    ) {
      return 0.5
    }
    if (
      hitClosePartialKw ||
      /\b(close\s+partials?|take\s+partials?|close\s+25%|take\s+25%)\b/i.test(t) ||
      /\b(25|quarter)\s*%?\s*(of\s+)?(the\s+)?(position|trade|lot|profit)\b/i.test(tl)
    ) {
      return 0.25
    }
    return partialCloseFractionFromMessage(t)
  }

  if (looksLikeDeletePendingsCommand(t, { channelKeywords })) {
    action = "delete_pendings"
    confidence = 0.95
  }
  else if (wantsCloseWorseEntries) {
    action = "close_worse_entries"
    confidence = 0.95
  }
  else if (wantsPartialHalf && wantsBreakeven) {
    action = "partial_breakeven"
    partial_close_fraction = resolvePartialFraction() ?? 0.5
  }
  else if (wantsPartialHalf) {
    action = "partial_profit"
    const frac = resolvePartialFraction()
    if (frac != null) partial_close_fraction = frac
  } else if (wantsBreakeven) action = "breakeven"
  else if (wantsExplicitFullClose(t, kwClose, channelKeywords, lexicon)) {
    if (looksLikeConditionalCloseSuggestion(t)) return null
    action = "close"
  }
  else if (looksLikeStopOrTpAdjustCommand(t) || hasAnyKeyword(t, kwModify)) {
    action = "modify"
    confidence = 0.95
  }

  if (!action) return null
  const looksEntry = ENTRY_KW.test(t) &&
    /\b(buy|sell)\s+(now|btc|bitcoin|gold|xau)|market\s+(buy|sell)/i.test(t)
  if (action === "close" && /\b(stop\s*sell|sell\s*stops?)\s+now\b/i.test(tl)) return null

  if (action === "close" && looksEntry && /\b(and|&)+\s*(gold|btc)\b/i.test(tl)) {
    confidence = 0.88
  }

  const slPriceLabels = slLabelsForChannel(channelKeywords)
  let sl: number | null = parseSlFromText(t)
  if (sl == null) sl = extractPriceByLabels(t, slPriceLabels)
  const extraTp = tpLabelsForChannel(channelKeywords, lexicon)
  const tpExtract = extractTpLevels(t, extraTp)
  const tp = tpExtract.values

  return {
    action,
    symbol: sym,
    entry_price: null,
    entry_zone_low: null,
    entry_zone_high: null,
    sl,
    tp,
    ...(tpExtract.explicitPips ? { tp_unit: 'pips' as const } : {}),
    lot_size: null,
    confidence,
    raw_instruction: message,
    open_tp: detectOpenTp(message),
    ...((action === "partial_profit" || action === "partial_breakeven") && partial_close_fraction != null
      ? { partial_close_fraction }
      : {}),
  }
}

/**
 * Pulls entry price / zone from common channel text patterns (ENTRY 2650, @2650, zones, etc.).
 * Shared so "BUY … NOW / MARKET" and "BUY … SYMBOL PRICE" (no market word) still retain an anchor when the line lists one.
 */
function extractOptionalEntryAnchor(
  message: string,
  channelKeywords: ChannelKeywords,
): { entry_price: number | null; entry_zone_low: number | null; entry_zone_high: number | null } {
  const text = message.replace(/\s+/g, " ").trim()
  const delim = channelKeywords.additional.delimiters
  const zone = text.match(
    new RegExp(
      `\\b(?:between|from)\\s+(${SIGNAL_PRICE_NUM})\\s*(?:and|to|-|–|_)\\s*(${SIGNAL_PRICE_NUM})\\b`,
      'i',
    ),
  )
  // "Trade Activated From 4350_4360" / "Activated From 4315-4310"
  const activatedFromZone = text.match(
    new RegExp(
      `\\b(?:trade\\s+)?activated\\s+from\\s+(${SIGNAL_PRICE_NUM})\\s*(?:_|-|–|to|/)\\s*(${SIGNAL_PRICE_NUM})\\b`,
      'i',
    ),
  )
  let entry_zone_low: number | null = null
  let entry_zone_high: number | null = null
  let entry_price: number | null = null
  const primaryZone = activatedFromZone ?? zone
  if (primaryZone?.[1] && primaryZone?.[2]) {
    const normalized = entryZoneFromRawTokens(primaryZone[1], primaryZone[2])
    if (normalized) {
      entry_zone_low = normalized.entry_zone_low
      entry_zone_high = normalized.entry_zone_high
    }
  } else {
    const applyZone = (rawA: string, rawB: string) => {
      const normalized = entryZoneFromRawTokens(rawA, rawB)
      if (normalized) {
        entry_zone_low = normalized.entry_zone_low
        entry_zone_high = normalized.entry_zone_high
      }
    }

    // ZN / ZONE / Z: 4105-4113 (common shorthand on gold channels)
    const znZone = text.match(
      new RegExp(
        `\\b(?:zn|zone|z)\\s*[:=]?\\s*(${SIGNAL_PRICE_NUM})\\s*(?:-|–|to|_)\\s*(${SIGNAL_PRICE_NUM})\\b`,
        'i',
      ),
    )
    const nowZone = text.match(
      new RegExp(`\\b(?:now|instant|market|mkt)\\s+(${SIGNAL_PRICE_NUM})\\s*(?:-|–|to)\\s*(${SIGNAL_PRICE_NUM})\\b`, 'i'),
    )
    const reentryZone = text.match(
      new RegExp(
        `\\b(?:now\\s+)?(?:re[-\\s]?entry|reenter)\\s+(${SIGNAL_PRICE_NUM})\\s*(?:-|–|to)\\s*(${SIGNAL_PRICE_NUM})\\b`,
        'i',
      ),
    )
    const zoneMatch = znZone ?? nowZone ?? reentryZone
    const symSideColonSlash = text.match(
      new RegExp(
        `\\b(?:xauusd|xagusd|gold|silver|btcusd|btcusdt|ethusd|ethusdt|eurusd|gbpusd|usdjpy|us30|nas100|[a-z]{6})\\s+(?:buy|sell|long|short)\\s*:?\\s*(${SIGNAL_PRICE_NUM})\\s*(?:\\/|\\band\\b)\\s*(${SIGNAL_PRICE_NUM})\\b`,
        'i',
      ),
    )
    const symPriceSlash = text.match(
      new RegExp(
        `\\b(?:xauusd|xagusd|gold|silver)\\s+(${SIGNAL_PRICE_NUM})\\s*(?:\\/|\\band\\b)\\s*(${SIGNAL_PRICE_NUM})\\b`,
        'i',
      ),
    )
    const sidePriceSlash = text.match(
      new RegExp(`\\b(?:buy|sell|long|short)\\s+(${SIGNAL_PRICE_NUM})\\s*(?:\\/|\\band\\b)\\s*(${SIGNAL_PRICE_NUM})\\b`, 'i'),
    )
    const slashZone = symSideColonSlash ?? symPriceSlash ?? sidePriceSlash
    const entrySlashZone = text.match(
      new RegExp(
        `\\bentry\\s*(?:price|level)?\\s*[:=]?\\s*(${SIGNAL_PRICE_NUM})\\s*(?:\\/|\\band\\b|-|–)\\s*(${SIGNAL_PRICE_NUM})\\b`,
        'i',
      ),
    )
    const arEntryZone = text.match(
      new RegExp(
        `(?:منطقة\\s*الدخول|نقطة\\s*الدخول|سعر\\s*الدخول)\\s*[:：]?\\s*(${SIGNAL_PRICE_NUM})\\s*(?:-|–|to|إلى)\\s*(${SIGNAL_PRICE_NUM})`,
        'iu',
      ),
    )
    const bareZone = extractBarePriceRangeZone(message)

    if (zoneMatch?.[1] && zoneMatch?.[2]) {
      applyZone(zoneMatch[1], zoneMatch[2])
    } else if (slashZone?.[1] && slashZone?.[2]) {
      applyZone(slashZone[1], slashZone[2])
    } else if (entrySlashZone?.[1] && entrySlashZone?.[2]) {
      applyZone(entrySlashZone[1], entrySlashZone[2])
    } else if (arEntryZone?.[1] && arEntryZone?.[2]) {
      applyZone(arEntryZone[1], arEntryZone[2])
    } else if (bareZone) {
      entry_zone_low = bareZone.low
      entry_zone_high = bareZone.high
    }

    if (entry_zone_low == null) {
      const entryLevel = text.match(new RegExp(`\\bentry\\s+level\\s*[:=]?\\s*(${SIGNAL_PRICE_NUM})\\b`, 'i'))
      if (entryLevel?.[1]) entry_price = parseSignalPriceToken(entryLevel[1])
      const entryLabel = text.match(new RegExp(`\\bentry\\s*(?:price|level)?\\s*[:=]\\s*(${SIGNAL_PRICE_NUM})\\b`, 'i'))
      if (entry_price == null && entryLabel?.[1]) entry_price = parseSignalPriceToken(entryLabel[1])
      // Provider formats: "PRICE: 4256" / "LIMIT PRICE 4256" / "BUY LIMIT 4256"
      // (Use Signal Entry Price requires an explicit entry; many channels label it PRICE not ENTRY.)
      if (entry_price == null) {
        const priceLabel = text.match(
          new RegExp(
            `\\b(?:(?:limit\\s*)?price|(?:buy|sell)\\s+limit(?:\\s*order)?)\\s*[:=]?\\s*(${SIGNAL_PRICE_NUM})\\b`,
            'i',
          ),
        )
        if (priceLabel?.[1]) entry_price = parseSignalPriceToken(priceLabel[1])
      }
      if (entry_price == null) {
        const atPx = parseAtPriceExcludingSlTp(text)
        if (atPx != null) entry_price = atPx
      }
      if (entry_price == null) {
        const buySellAt = text.match(new RegExp(`\\b(?:buy|sell)\\s+at\\s+(${SIGNAL_PRICE_NUM})\\b`, 'i'))
        if (buySellAt?.[1]) entry_price = parseSignalPriceToken(buySellAt[1])
      }
      if (entry_price == null) {
        const symbolSidePrice = text.match(
          new RegExp(`\\b(?:xauusd|xagusd|gold|silver|btcusd|btcusdt|ethusd|ethusdt|eurusd|gbpusd|usdjpy|us30|nas100|[a-z]{6})\\s+(?:buy|sell|long|short)\\s+(${SIGNAL_PRICE_NUM})\\b`, 'i'),
        )
        if (symbolSidePrice?.[1]) entry_price = parseSignalPriceToken(symbolSidePrice[1])
      }
      if (entry_price == null) {
        const sidePrice = text.match(new RegExp(`\\b(?:buy|sell|long|short)\\s+(${SIGNAL_PRICE_NUM})\\b`, 'i'))
        if (sidePrice?.[1]) entry_price = parseSignalPriceToken(sidePrice[1])
        if (entry_price == null) {
          const sideDotLeader = text.match(new RegExp(`\\b(?:buy|sell|long|short)\\b[.\\s]+(${SIGNAL_PRICE_NUM})`, 'i'))
          if (sideDotLeader?.[1]) entry_price = parseSignalPriceToken(sideDotLeader[1])
        }
      }
      if (entry_price == null) {
        const entryWord = text.match(new RegExp(`\\bentry\\s+(${SIGNAL_PRICE_NUM})\\b`, 'i'))
        if (entryWord?.[1]) entry_price = parseSignalPriceToken(entryWord[1])
      }
      if (entry_price == null) {
        const entryLabels = entryLabelsForChannel(channelKeywords)
        const fromKw = extractPriceByLabels(text, entryLabels)
        if (fromKw != null && Number.isFinite(fromKw) && fromKw > 0) {
          entry_price = fromKw
        }
      }
      // Common signal shapes that omit "entry" / "@" labels but still carry a single anchor:
      //   "BUY XAUUSD NOW 2650", "BUY GOLD 2645.5 MARKET", "SELL BTCUSD 98000 NOW",
      //   "BUY XAUUSD 2650" / "SELL GOLD 2645.5" (market word optional — same anchor as with NOW).
      if (entry_price == null && entry_zone_low == null) {
        const symPriceOptionalMarket = text.match(
          new RegExp(`\\b(?:xauusd|xagusd|gold|silver|btcusd|btcusdt|ethusd|ethusdt|eurusd|gbpusd|usdjpy|us30|nas100)\\s+(${SIGNAL_PRICE_NUM})(?:\\s+(?:now|instant|market|mkt))?\\b`, 'i'),
        )
        if (symPriceOptionalMarket?.[1]) entry_price = parseSignalPriceToken(symPriceOptionalMarket[1])
      }
      if (entry_price == null && entry_zone_low == null) {
        const marketThenPrice = text.match(new RegExp(`\\b(?:now|instant|market|mkt)\\s+(${SIGNAL_PRICE_NUM})\\b`, 'i'))
        if (marketThenPrice?.[1]) entry_price = parseSignalPriceToken(marketThenPrice[1])
      }
    }
  }
  return { entry_price, entry_zone_low, entry_zone_high }
}

function extractSlFromMessage(
  message: string,
  channelKeywords: ChannelKeywords,
): number | null {
  const text = message.replace(/\s+/g, ' ').trim()
  const delim = channelKeywords.additional.delimiters
  const slPriceLabels = [
    ...splitKeywordAliases(channelKeywords.signal.sl, delim),
    ...splitKeywordAliases(channelKeywords.update.set_sl, delim),
    ...splitKeywordAliases(channelKeywords.update.adjust_sl, delim),
  ]
  let sl = parseSlFromText(text)
  if (sl == null) {
    const fromLabel = extractPriceByLabels(text, slPriceLabels)
    sl = fromLabel != null && fromLabel > 0 ? fromLabel : null
  }
  return sl
}

function buildExtraTpLabels(
  lexicon: ChannelLexiconRow | null,
  channelKeywords: ChannelKeywords,
): string[] {
  const delim = channelKeywords.additional.delimiters
  return [
    ...(lexicon?.tp_aliases ?? []),
    ...(lexicon?.target_aliases ?? []),
    ...splitKeywordAliases(channelKeywords.signal.tp, delim),
    ...splitKeywordAliases(channelKeywords.update.set_tp, delim),
    ...splitKeywordAliases(channelKeywords.update.adjust_tp, delim),
  ]
}

function hasParameterEvidence(message: string, channelKeywords: ChannelKeywords): boolean {
  if (looksLikeChannelManagementUpdate(message)) return false
  const text = message.replace(/\s+/g, ' ').trim()
  const delim = channelKeywords.additional.delimiters
  if (extractSlFromMessage(message, channelKeywords) != null) return true
  if (extractTpLevels(message, buildExtraTpLabels(null, channelKeywords)).values.length > 0) return true
  if (/\bentry\s*(?:price)?\s*[:=]\s*\d/i.test(text)) return true
  if (new RegExp(`@\\s*${SIGNAL_PRICE_NUM}`).test(text)) return true
  if (hasEntryPointPriceEvidence(message, splitKeywordAliases(channelKeywords.signal.entry_point, delim))) {
    return true
  }
  const bare = bareTradePricesExcludingPips(message, extractUnlabeledPrices(message))
  return bare.length > 0
}

function messageHasSideKeywords(
  message: string,
  channelKeywords: ChannelKeywords,
  lexicon: ChannelLexiconRow | null = null,
): boolean {
  const buyAliases = buyAliasesForChannel(channelKeywords, lexicon)
  const sellAliases = sellAliasesForChannel(channelKeywords, lexicon)
  return parseBuySideFromKeywords(message, buyAliases) !== parseSellSideFromKeywords(message, sellAliases)
}

/** Symbol-less SL/TP/entry parameter posts (typical channel follow-up without repeating instrument). */
function parseChannelParameterFollowUp(
  message: string,
  lexicon: ChannelLexiconRow | null,
  channelKeywords: ChannelKeywords,
): ChannelParsedSignal | null {
  if (!hasParameterEvidence(message, channelKeywords)) return null
  if (extractTradableSymbolFromMessage(message) && !detectReEnterIntent(message)) return null
  if (messageHasSideKeywords(message, channelKeywords, lexicon) && !detectReEnterIntent(message)) return null

  const extraTp = buildExtraTpLabels(lexicon, channelKeywords)
  const sl = extractSlFromMessage(message, channelKeywords)
  const tpExtract = extractTpLevels(message, extraTp)
  const tp = tpExtract.values
  const { entry_price, entry_zone_low, entry_zone_high } = extractOptionalEntryAnchor(message, channelKeywords)
  const reEnter = detectReEnterIntent(message)
  const unitFields = {
    ...(tpExtract.explicitPips ? { tp_unit: 'pips' as const } : {}),
  }

  if (reEnter) {
    const side = resolveTradeSideFromMessage(message, channelKeywords, lexicon)
    if (!side) return null
    return {
      action: side,
      symbol: null,
      entry_price,
      entry_zone_low,
      entry_zone_high,
      sl,
      tp,
      ...unitFields,
      lot_size: null,
      confidence: 0.91,
      raw_instruction: message,
      open_tp: detectOpenTp(message),
      re_enter: true,
    }
  }

  return {
    action: 'modify',
    symbol: null,
    entry_price,
    entry_zone_low,
    entry_zone_high,
    sl,
    tp,
    ...unitFields,
    lot_size: null,
    confidence: 0.9,
    raw_instruction: message,
    open_tp: detectOpenTp(message),
  }
}

function applyDirectionalPriceInference(
  parsed: ChannelParsedSignal,
  rawMessage: string,
): ChannelParsedSignal {
  const action = String(parsed.action ?? '').toLowerCase()
  if (action !== 'buy' && action !== 'sell') return parsed
  // Pip-offset ladders must not be reclassified as absolute SL/TP prices.
  if (parsed.tp_unit === 'pips' || parsed.sl_unit === 'pips') return parsed
  if (tpClauseHasExplicitPips(rawMessage)) return parsed

  const hasSl = typeof parsed.sl === 'number' && Number.isFinite(parsed.sl) && parsed.sl > 0
  const hasTp = (parsed.tp ?? []).some(t => typeof t === 'number' && Number.isFinite(t) && t > 0)
  if (hasSl && hasTp) return parsed

  const bare = bareTradePricesExcludingPips(
    rawMessage,
    filterPlausibleInstrumentPrices(parsed.symbol, extractUnlabeledPrices(rawMessage)),
  )
  if (!bare.length) return parsed

  const classified = classifyPricesByDirection(
    action as TradeDirection,
    entryReferenceFromParsed(parsed),
    bare,
  )

  return {
    ...parsed,
    sl: hasSl ? parsed.sl : (classified.sl ?? parsed.sl),
    tp: hasTp ? parsed.tp : (classified.tp.length ? classified.tp : parsed.tp),
  }
}

function applyReEnterFlag(parsed: ChannelParsedSignal, rawMessage: string): ChannelParsedSignal {
  if (parsed.re_enter === true) return parsed
  if (!detectReEnterIntent(rawMessage)) return parsed
  return { ...parsed, re_enter: true }
}

function parseSimpleSignal(
  message: string,
  lexicon: ChannelLexiconRow | null,
  channelKeywords: ChannelKeywords,
): ChannelParsedSignal | null {
  if (looksLikeCasualNonTradeMessage(message)) return null
  const text = message.toLowerCase().replace(/\s+/g, " ").trim()
  if (!text) return null
  const delim = channelKeywords.additional.delimiters
  const buyAliases = buyAliasesForChannel(channelKeywords, lexicon)
  const sellAliases = sellAliasesForChannel(channelKeywords, lexicon)
  const marketAliases = Array.from(
    new Set([
      'now', 'instant', 'market', 'mkt',
      ...COMMON_MARKET_NOW_TERMS,
      ...splitKeywordAliases(channelKeywords.signal.market_order, delim),
    ]),
  )
  const mgmtAliases = [
    ...splitKeywordAliases(channelKeywords.update.close_full, delim),
    ...splitKeywordAliases(channelKeywords.update.close_half, delim),
    ...splitKeywordAliases(channelKeywords.update.close_partial, delim),
    ...splitKeywordAliases(channelKeywords.update.break_even, delim),
    ...splitKeywordAliases(channelKeywords.update.set_sl, delim),
    ...splitKeywordAliases(channelKeywords.update.adjust_sl, delim),
    ...splitKeywordAliases(channelKeywords.update.set_tp, delim),
    ...splitKeywordAliases(channelKeywords.update.adjust_tp, delim),
    ...splitKeywordAliases(channelKeywords.update.delete, delim),
    ...splitKeywordAliases(channelKeywords.additional.close_all, delim),
    ...splitKeywordAliases(channelKeywords.additional.delete_all, delim),
    ...splitKeywordAliases(channelKeywords.update.close_tp1, delim),
    ...splitKeywordAliases(channelKeywords.update.close_tp2, delim),
    ...splitKeywordAliases(channelKeywords.update.close_tp3, delim),
    ...splitKeywordAliases(channelKeywords.update.close_tp4, delim),
  ]

  if (
    !looksLikeStructuredEntrySignal(message) && (
      /\b(flatten|exit\s+trade|breakeven|break\s+even|partial|move\s+(?:sl|tp|risk|stop\s*loss|stoploss))\b/i.test(text)
      || looksLikeStopOrTpAdjustCommand(message)
      || looksLikeExplicitFullCloseCommand(message)
      || hasAnyKeyword(message, mgmtAliases)
    )
  ) {
    return null
  }

  const side = resolveTradeSideFromMessage(message, channelKeywords, lexicon)
  if (!side) return null
  const isNow = parseSideFromKeywords(message, marketAliases)
  const atMarketLike = /\b(at\s+market|@\s*market)\b/i.test(message)

  const entryAnchor = extractOptionalEntryAnchor(message, channelKeywords)
  const hasExplicitEntry =
    entryAnchor.entry_price != null ||
    (entryAnchor.entry_zone_low != null && entryAnchor.entry_zone_high != null)

  if (!isNow && !atMarketLike && !hasExplicitEntry) return null

  const instrument = extractTradableSymbolFromMessage(message)
  if (!instrument) return null

  const hasInstrumentContext =
    isTradableInstrumentSymbol(instrument) ||
    /\b(gold|xau|xauusd|btc|bitcoin|btcusd|btcusdt|eth|ethereum|silver|eur|gbp|ذهب)\b/i.test(text) ||
    /\bEUR\/USD|EURUSD|GBPUSD|USDJPY|XAUUSD|BTCUSD|BTCUSDT\b/i.test(message) ||
    /\b(us30|nas100|ger40|uk100|ustec|spx500|spy|qqq|iwm|dia|voo|tqqq|gld|slv)\b/i.test(text) ||
    /\bmarket\s*:\s*[A-Za-z]/i.test(message) ||
    DERIV_SYNTHETIC_HINT_RE.test(text)

  if (!hasInstrumentContext) return null

  const sl = parseSlFromText(text) ?? extractPriceByLabels(message, slLabelsForChannel(channelKeywords, false))
  const tpExtract = extractTpLevels(message, tpLabelsForChannel(channelKeywords, lexicon, false))
  const tp = tpExtract.values

  const { entry_price, entry_zone_low, entry_zone_high } = entryAnchor

  return {
    action: side,
    symbol: instrument,
    entry_price,
    entry_zone_low,
    entry_zone_high,
    sl,
    tp,
    ...(tpExtract.explicitPips ? { tp_unit: 'pips' as const } : {}),
    lot_size: null,
    confidence: 0.99,
    raw_instruction: message,
    open_tp: detectOpenTp(message),
  }
}

/** Entry when channel BUY/SELL + instrument + at least one price level appear (no “market” word required). */
function parseEntryFromKeywords(
  message: string,
  lexicon: ChannelLexiconRow | null,
  channelKeywords: ChannelKeywords,
): ChannelParsedSignal | null {
  if (looksLikeCasualNonTradeMessage(message)) return null
  const text = message.replace(/\s+/g, " ").trim()
  if (!text) return null
  const delim = channelKeywords.additional.delimiters
  const buyAliases = buyAliasesForChannel(channelKeywords, lexicon)
  const sellAliases = sellAliasesForChannel(channelKeywords, lexicon)
  const mgmtAliases = [
    ...splitKeywordAliases(channelKeywords.update.close_full, delim),
    ...splitKeywordAliases(channelKeywords.update.close_half, delim),
    ...splitKeywordAliases(channelKeywords.update.close_partial, delim),
    ...splitKeywordAliases(channelKeywords.update.break_even, delim),
    ...splitKeywordAliases(channelKeywords.update.set_sl, delim),
    ...splitKeywordAliases(channelKeywords.update.adjust_sl, delim),
    ...splitKeywordAliases(channelKeywords.update.set_tp, delim),
    ...splitKeywordAliases(channelKeywords.update.adjust_tp, delim),
    ...splitKeywordAliases(channelKeywords.update.delete, delim),
    ...splitKeywordAliases(channelKeywords.additional.close_all, delim),
    ...splitKeywordAliases(channelKeywords.additional.delete_all, delim),
    ...splitKeywordAliases(channelKeywords.update.close_tp1, delim),
    ...splitKeywordAliases(channelKeywords.update.close_tp2, delim),
    ...splitKeywordAliases(channelKeywords.update.close_tp3, delim),
    ...splitKeywordAliases(channelKeywords.update.close_tp4, delim),
  ]
  if (hasAnyKeyword(message, mgmtAliases) && !looksLikeStructuredEntrySignal(message)) return null

  const isBuy = parseBuySideFromKeywords(message, buyAliases)
  const isSell = parseSellSideFromKeywords(message, sellAliases)
  if (!isBuy && isSell && /\bshort\s+of\b/i.test(text)) return null
  if (isBuy === isSell) return null

  const instrument = extractTradableSymbolFromMessage(message)
  if (!instrument) return null

  const slPriceLabels = slLabelsForChannel(channelKeywords, false)
  let sl: number | null = parseSlFromText(text)
  if (sl == null || !Number.isFinite(sl)) sl = extractPriceByLabels(text, slPriceLabels)

  const tpExtract = extractTpLevels(message, tpLabelsForChannel(channelKeywords, lexicon, false))
  const tp = tpExtract.values

  const entryAliases = entryLabelsForChannel(channelKeywords)
  const entryPointHit = hasEntryPointPriceEvidence(message, entryAliases)
  const hasPriceEvidence =
    entryPointHit ||
    (sl != null && Number.isFinite(sl)) ||
    tp.length > 0 ||
    /\b(limit|pending|@)\b/i.test(text) ||
    filterPlausibleInstrumentPrices(
      instrument,
      bareTradePricesExcludingPips(message, extractUnlabeledPrices(message)),
    ).length > 0

  if (!hasPriceEvidence) return null

  const { entry_price, entry_zone_low, entry_zone_high } = extractOptionalEntryAnchor(message, channelKeywords)

  return {
    action: isBuy ? "buy" : "sell",
    symbol: instrument,
    entry_price,
    entry_zone_low,
    entry_zone_high,
    sl,
    tp,
    ...(tpExtract.explicitPips ? { tp_unit: 'pips' as const } : {}),
    lot_size: null,
    confidence: 0.93,
    raw_instruction: message,
    open_tp: detectOpenTp(message),
  }
}

const MGMT_NON_INSTRUMENT_SYMBOLS = new Set([
  "CHANGE", "CHANGED", "UPDATE", "UPDATED", "MODIFY", "MODIFIED", "ADJUST", "MOVE", "MOVED",
  "CLOSE", "CLOSED", "SIGNAL", "SETUP", "ENTRY", "ZONE", "TRADE", "ORDER", "POSITION",
])

function applyQuoteLevelSymbolRepair(parsed: ChannelParsedSignal, rawMsg: string): ChannelParsedSignal {
  const symbol = reconcileSymbolWithQuoteLevels(parsed.symbol, rawMsg, {
    sl: parsed.sl,
    tp: parsed.tp,
    entry: parsed.entry_price,
  })
  if (symbol && symbol !== parsed.symbol) {
    return { ...parsed, symbol }
  }
  return parsed
}

function applyRawSymbolRepair(parsed: ChannelParsedSignal, rawMsg: string): ChannelParsedSignal {
  const extracted = extractTradableSymbolFromMessage(rawMsg)

  const cur = parsed.symbol?.toUpperCase().replace(/\s/g, "") ?? ""
  const curMentioned = cur ? new RegExp(`\\b${cur}\\b`, "i").test(rawMsg.replace(/\s+/g, "")) : false
  const signalBody = signalBodyBeforePromoFooter(rawMsg)
  const goldHints = /\b(gold|xau|xauusd)\b/i.test(signalBody)
  const btcHints = /\b(btc|bitcoin|btcusd|btcusdt)\b/i.test(signalBody)
  const hasAnySymbolHint = /([A-Z]{3,}\/[A-Z]{3,})|\b([A-Z]{6}|XAUUSD|XAGUSD|BTCUSD|BTCUSDT|ETHUSD|ETHUSDT)\b|(\bgold\b|\bxau\b|\bbtc\b|\bbitcoin\b|\beth\b|\bether)\b/i
    .test(rawMsg) || DERIV_SYNTHETIC_HINT_RE.test(rawMsg)
  const mgmt = new Set([
    "close",
    "close_worse_entries",
    "breakeven",
    "partial_profit",
    "partial_breakeven",
    "modify",
  ]).has(parsed.action)

  if (mgmt) {
    if (cur && MGMT_NON_INSTRUMENT_SYMBOLS.has(cur)) {
      return { ...parsed, symbol: extracted ?? null }
    }
    if (extracted) return { ...parsed, symbol: extracted }
    if (!hasAnySymbolHint && !curMentioned) return { ...parsed, symbol: null }
    if (cur === "XAUUSD" && !goldHints) return { ...parsed, symbol: null }
    return parsed
  }
  if (!extracted) return parsed
  if (
    cur === "XAUUSD" && (!goldHints && (btcHints || extracted.includes("BTC") || extracted.includes("ETH")))
  ) {
    return { ...parsed, symbol: extracted }
  }
  if ((!cur || cur !== extracted) && (btcHints || goldHints || isTradableInstrumentSymbol(extracted))) {
    return { ...parsed, symbol: extracted }
  }
  return parsed
}

function dropInvalidTradeSymbol(parsed: ChannelParsedSignal): ChannelParsedSignal {
  const symbol = sanitizeParsedSymbol(parsed.symbol)
  const needsSymbol =
    (parsed.action === "buy" || parsed.action === "sell")
    && parsed.re_enter !== true
  if (needsSymbol && !symbol) {
    return {
      ...parsed,
      symbol: null,
      action: "ignore",
      confidence: 0,
    }
  }
  if (symbol !== parsed.symbol) {
    return { ...parsed, symbol }
  }
  return parsed
}

function ignorePayload(raw: string): ChannelParsedSignal {
  return {
    action: "ignore",
    symbol: null,
    entry_price: null,
    entry_zone_low: null,
    entry_zone_high: null,
    sl: null,
    tp: [],
    lot_size: null,
    confidence: 1,
    raw_instruction: raw,
    open_tp: false,
  }
}

export async function loadChannelLexicon(
  supabase: SupabaseClient,
  channelId: string | null,
): Promise<ChannelLexiconRow | null> {
  if (!channelId) return null
  const { data } = await supabase
    .from("channel_signal_lexicon")
    .select("user_id, channel_id, action_aliases, tp_aliases, target_aliases, unknown_tokens")
    .eq("channel_id", channelId)
    .maybeSingle()
  return (data ?? null) as ChannelLexiconRow | null
}

export async function loadChannelKeywords(
  supabase: SupabaseClient,
  channelId: string | null,
): Promise<ChannelKeywords> {
  if (!channelId) return DEFAULT_CHANNEL_KEYWORDS
  const { data } = await supabase
    .from("telegram_channels")
    .select("channel_keywords")
    .eq("id", channelId)
    .maybeSingle()
  return normalizeChannelKeywords(data?.channel_keywords)
}

export type ParseChannelMessageResult = {
  parsed: ChannelParsedSignal
  status: string
  skip_reason: string | null
}

export { looksLikeChannelManagementUpdate, looksLikeDeletePendingsCommand, looksLikeExplicitFullCloseCommand } from './signalManagementIntent'

/** Preserve explicit BUY/SELL STOP or LIMIT wording for broker-order routing. */
function applyExplicitEntryOrderType(parsed: ChannelParsedSignal, rawMessage: string): ChannelParsedSignal {
  const action = String(parsed.action ?? '').toLowerCase()
  if (action !== 'buy' && action !== 'sell') return parsed
  const match = rawMessage.match(/\b(?:buy|sell)\s+(stop|limit)\b/i)
  const entry_order_type: EntryOrderType | null = match ? match[1]!.toLowerCase() as EntryOrderType : null
  return { ...parsed, entry_order_type }
}

function applyStopUnits(
  parsed: ChannelParsedSignal,
  rawMessage: string,
  channelKeywords?: ChannelKeywords | null,
): ChannelParsedSignal {
  const action = String(parsed.action ?? '').toLowerCase()
  if (action !== 'buy' && action !== 'sell' && action !== 'modify') return parsed

  const tps = (parsed.tp ?? []).filter(n => typeof n === 'number' && Number.isFinite(n) && n > 0)
  const ref = entryRefFromParsed(parsed)
  const tp_unit = resolveTpUnit({
    message: rawMessage,
    tps,
    channelTpInPips: channelKeywords?.additional?.tp_in_pips === true,
    ref,
    explicitFromExtract: parsed.tp_unit === 'pips',
  })
  const sl_unit = resolveSlUnit({
    message: rawMessage,
    sl: parsed.sl,
    channelSlInPips: channelKeywords?.additional?.sl_in_pips === true,
    ref: parsed.entry_price ?? parsed.entry_zone_low ?? parsed.entry_zone_high ?? null,
  })

  return {
    ...parsed,
    ...(tps.length ? { tp_unit } : {}),
    ...(parsed.sl != null && Number.isFinite(parsed.sl) ? { sl_unit } : {}),
  }
}

export function enrichParsedKeywordMatch(
  keywordMatch: ChannelParsedSignal,
  rawMessage: string,
  channelKeywords?: ChannelKeywords | null,
): ChannelParsedSignal {
  const enriched = applyReEnterFlag(
    applyDirectionalPriceInference(
      normalizeParsedFromModel(keywordMatch, rawMessage),
      rawMessage,
    ),
    rawMessage,
  )
  const repaired = applyRawSymbolRepair(enriched, rawMessage)
  const quoteRepaired = applyQuoteLevelSymbolRepair(repaired, rawMessage)
  const dropped = dropInvalidTradeSymbol(quoteRepaired)
  const withUnits = applyStopUnits(dropped, rawMessage, channelKeywords)
  const withOrderType = applyExplicitEntryOrderType(withUnits, rawMessage)
  const providerNum = withOrderType.provider_signal_number ?? extractProviderSignalNumber(rawMessage)
  if (providerNum == null) return withOrderType
  return { ...withOrderType, provider_signal_number: providerNum }
}

/** Deterministic management / SL-TP follow-up parse only (no entry parsers). */
export function parseModificationDeterministic(
  rawMessage: string,
  channelKeywords: ChannelKeywords,
  lexicon: ChannelLexiconRow | null,
): ParseChannelMessageResult {
  const message = normalizeSignalMessageForParse(rawMessage)
  const displayMessage = normalizeTelegramMessageText(rawMessage)
  const ignoreAliases = [
    ...splitKeywordAliases(channelKeywords.additional.ignore_keyword, channelKeywords.additional.delimiters),
    ...splitKeywordAliases(channelKeywords.additional.skip_keyword, channelKeywords.additional.delimiters),
  ]
  const explicitIgnore = hasAnyKeyword(message, ignoreAliases)
  const keywordMatch =
    parseDeterministicManagement(message, lexicon, channelKeywords) ??
    parseChannelParameterFollowUp(message, lexicon, channelKeywords)

  if (explicitIgnore) {
    return {
      parsed: ignorePayload(displayMessage),
      status: 'skipped',
      skip_reason: 'Non-trade message',
    }
  }
  if (!keywordMatch) {
    return {
      parsed: {
        action: 'ignore',
        symbol: null,
        entry_price: null,
        entry_zone_low: null,
        entry_zone_high: null,
        sl: null,
        tp: [],
        lot_size: null,
        confidence: 0,
        raw_instruction: displayMessage,
        open_tp: false,
      },
      status: 'skipped',
      skip_reason: 'No matching management or parameter follow-up pattern',
    }
  }

  const parsed = enrichParsedKeywordMatch(keywordMatch, message, channelKeywords)
  const status = parsed.action === 'ignore' ? 'skipped' : 'parsed'
  const skip_reason = parsed.action === 'ignore'
    ? 'No matching management or parameter follow-up pattern'
    : null
  return { parsed, status, skip_reason }
}

/** Normalize OpenAI JSON output into a channel parsed signal. */
export function normalizeAiParsedOutput(raw: unknown, fallbackText: string): ChannelParsedSignal {
  return enrichParsedKeywordMatch(normalizeParsedFromModel(raw, fallbackText), fallbackText)
}

/** Synchronous parse when keywords/lexicon are already loaded (hot path). */
export function parseChannelMessageSync(
  rawMessage: string,
  channelKeywords: ChannelKeywords,
  lexicon: ChannelLexiconRow | null,
): ParseChannelMessageResult {
  const collapsedMessage = collapseForexBroBilingualMessage(rawMessage)
  const message = normalizeSignalMessageForParse(collapsedMessage)
  const displayMessage = normalizeTelegramMessageText(rawMessage)
  const ignoreAliases = [
    ...splitKeywordAliases(channelKeywords.additional.ignore_keyword, channelKeywords.additional.delimiters),
    ...splitKeywordAliases(channelKeywords.additional.skip_keyword, channelKeywords.additional.delimiters),
  ]

  const explicitIgnore = hasAnyKeyword(message, ignoreAliases)

  const forexBro = parseForexBroManagementMessage(message)
  const keywordMatch = forexBro
    ? {
      action: forexBro.action,
      symbol: forexBro.symbol,
      entry_price: forexBro.entry_price,
      entry_zone_low: forexBro.entry_zone_low,
      entry_zone_high: forexBro.entry_zone_high,
      sl: forexBro.sl,
      tp: forexBro.tp,
      lot_size: forexBro.lot_size,
      confidence: forexBro.confidence,
      raw_instruction: displayMessage,
      open_tp: forexBro.open_tp,
      ...(forexBro.provider_signal_number != null
        ? { provider_signal_number: forexBro.provider_signal_number }
        : {}),
    } satisfies ChannelParsedSignal
    : parseDeterministicManagement(message, lexicon, channelKeywords) ??
    parseChannelParameterFollowUp(message, lexicon, channelKeywords) ??
    parseSimpleSignal(message, lexicon, channelKeywords) ??
    parseEntryFromKeywords(message, lexicon, channelKeywords)

  const rawParsed = explicitIgnore
    ? ignorePayload(displayMessage)
    : keywordMatch ?? {
      action: "ignore",
      symbol: null,
      entry_price: null,
      entry_zone_low: null,
      entry_zone_high: null,
      sl: null,
      tp: [],
      lot_size: null,
      confidence: 0,
      raw_instruction: displayMessage,
      open_tp: false,
    }

  const dropped = enrichParsedKeywordMatch(rawParsed, message, channelKeywords)
  if (entryMissingSlTpRequiresNow(dropped, message, channelKeywords)) {
    return {
      parsed: {
        ...dropped,
        action: 'ignore',
        symbol: null,
        confidence: 0,
      },
      status: 'skipped',
      skip_reason: 'Entry requires NOW (or MARKET) when SL and TP are absent',
    }
  }

  const parsed = dropped

  const status = parsed.action === "ignore" ? "skipped" : "parsed"
  const skip_reason = parsed.action === "ignore"
    ? (explicitIgnore
      ? "Non-trade message"
      : (forexBro?.skip_reason ?? "No matching channel keywords or price pattern"))
    : null

  return { parsed, status, skip_reason }
}

/** Load channel context from DB then parse (fallback / catch-up). */
export async function parseRawChannelMessage(
  supabase: SupabaseClient,
  channelId: string | null,
  rawMessage: string,
): Promise<ParseChannelMessageResult> {
  const lexicon = await loadChannelLexicon(supabase, channelId)
  const channelKeywords = await loadChannelKeywords(supabase, channelId)
  return parseChannelMessageSync(rawMessage, channelKeywords, lexicon)
}
