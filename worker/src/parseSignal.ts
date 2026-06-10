/**
 * In-process channel keyword parser (ported from supabase/functions/parse-signal).
 * No LLM, no broker calls — used on the live listener hot path to avoid edge HTTP latency.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  classifyPricesByDirection,
  detectReEnterIntent,
  entryReferenceFromParsed,
  extractUnlabeledPrices,
  type TradeDirection,
} from './signalPriceInference'
import {
  bareTradePricesExcludingPips,
  looksLikeChannelManagementUpdate,
  looksLikeExplicitFullCloseCommand,
  partialCloseFractionFromMessage,
} from './signalManagementIntent'
import { SIGNAL_PRICE_NUM, parseSignalPriceListBlock, parseSignalPriceToken } from './signalPriceFormat'
import {
  extractTradableSymbolFromMessage,
  filterPlausibleInstrumentPrices,
  isTradableInstrumentSymbol,
  sanitizeParsedSymbol,
} from './tradableSymbol'
import { looksLikeCasualNonTradeMessage } from './signalCommentaryGuard'
import { entryMissingSlTpRequiresNow } from './signalEntryNowRequirement'

/** Structured instruction from Telegram text + per-channel keywords. */
export interface ChannelParsedSignal {
  action: string
  symbol: string | null
  entry_price: number | null
  entry_zone_low: number | null
  entry_zone_high: number | null
  sl: number | null
  tp: number[]
  lot_size: number | null
  confidence: number
  raw_instruction: string
  open_tp?: boolean
  partial_close_fraction?: number | null
  /** Explicit channel intent to open a new trade (not modify existing). */
  re_enter?: boolean
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
  const p = escapeRegExp(phrase.trim()).replace(/\s+/g, "\\s+")
  return new RegExp(`(?:^|\\b)${p}(?:\\b|$)`, "i")
}

function hasAnyKeyword(text: string, words: string[]): boolean {
  return words.some((w) => w && keywordRegex(w).test(text))
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

function parseBuySideFromKeywords(text: string, words: string[]): boolean {
  for (const w of words) {
    if (!w) continue
    const lower = w.toLowerCase().trim()
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

function buildTpRegex(extraLabels: string[] = []): RegExp {
  const base = ["tp", "take\\s*profit", "target(?:\\s+level)?"]
  const custom = extraLabels.map((x) => escapeRegExp(x.trim())).filter(Boolean)
  // Guard against tier ordinals being mistaken for TP prices in shapes like:
  // "Take Profit 1: 4514.00" (capture 4514, not the ordinal 1).
  return new RegExp(
    `\\b(?:${[...base, ...custom].join("|")})(?:\\s*[:=\\-]\\s*|\\s+)(${SIGNAL_PRICE_NUM})(?!\\s*[:=\\-]\\s*${SIGNAL_PRICE_NUM})`,
    "gi",
  )
}

function extractTpLevels(message: string, extraLabels: string[] = []): number[] {
  const text = String(message ?? "")
  type TpHit = { index: number; value: number }
  const hits: TpHit[] = []

  const collect = (rx: RegExp) => {
    for (const m of text.matchAll(rx)) {
      const value = parseSignalPriceToken(m[1])
      if (value == null) continue
      hits.push({ index: m.index ?? 0, value })
    }
  }

  collect(buildTpRegex(extraLabels))
  // TP #1: 4564 / TP#2: 4,527 (hash-numbered tiers — common in signal channels)
  collect(new RegExp(`\\b(?:tp|take\\s*profit|target(?:\\s+level)?)\\s*#\\s*\\d+\\s*[:=\\-]\\s*(${SIGNAL_PRICE_NUM})`, 'gi'))
  // TP 1: 4564 (numbered without hash)
  collect(new RegExp(`\\b(?:tp|take\\s*profit|target(?:\\s+level)?)\\s+\\d+\\s*[:=\\-]\\s*(${SIGNAL_PRICE_NUM})`, 'gi'))
  // TP1: 4564 (numbered without space)
  collect(new RegExp(`\\b(?:tp|target(?:\\s+level)?)\\s*\\d+\\s*[:=\\-]\\s*(${SIGNAL_PRICE_NUM})`, 'gi'))
  // TP1 4564 (space-separated tier number)
  collect(new RegExp(`\\b(?:tp|target(?:\\s+level)?)\\s*\\d+\\s+(${SIGNAL_PRICE_NUM})`, 'gi'))
  // TP: 4557 / 4527 (slash-separated tiers on one label — not thousands commas)
  for (const m of text.matchAll(
    /\b(?:tp|take\s*profit|target(?:\s+level)?)\s*[:=]?\s*((?:\d+(?:\.\d+)?(?:\s*(?:\/|\band\b|\|)\s*)+)+\d+(?:\.\d+)?)/gi,
  )) {
    const block = m[1] ?? ''
    const base = m.index ?? 0
    const offset = m[0].indexOf(block)
    const normalized = block.replace(/,/g, '')
    for (const part of normalized.split(/\s*(?:\/|\band\b|\|)\s*/i)) {
      const value = parseSignalPriceToken(part.trim())
      if (value == null) continue
      const partStart = base + offset + normalized.indexOf(part)
      hits.push({ index: partStart, value })
    }
  }

  if (!hits.length) return []

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
  return values
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
  ]).has(String(action ?? "").toLowerCase())
}

function normalizeParsedFromModel(raw: unknown, fallbackText: string): ChannelParsedSignal {
  const j = raw && typeof raw === "object" ? raw as Record<string, unknown> : {}
  let action = String(j.action ?? "ignore").trim().toLowerCase()
  if (action === "long") action = "buy"
  if (action === "short") action = "sell"
  const allowed = new Set([
    "buy", "sell", "close", "close_worse_entries", "breakeven", "partial_profit", "partial_breakeven", "modify", "ignore",
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

  return {
    action,
    symbol,
    entry_price: numOrNull(j.entry_price),
    entry_zone_low: numOrNull(j.entry_zone_low),
    entry_zone_high: numOrNull(j.entry_zone_high),
    sl: numOrNull(j.sl),
    tp,
    lot_size: numOrNull(j.lot_size),
    confidence,
    raw_instruction,
    open_tp: Boolean(j.open_tp ?? detectOpenTp(fallbackText)),
    ...(partial_close_fraction != null ? { partial_close_fraction } : {}),
    ...(re_enter ? { re_enter: true } : {}),
  }
}

const ENTRY_KW = /\b(buy|sell|long|short)\b/i

function wantsExplicitFullClose(message: string, kwClose: string[]): boolean {
  if (looksLikeExplicitFullCloseCommand(message)) return true
  return hasAnyKeyword(message, kwClose)
}

/** Stop-loss labels used in management updates (providers often say "risk" or "stoploss"). */
const SL_TEXT_LABELS = 'sl|stop\\s*loss|stoploss|risk'
const TP_TEXT_LABELS = 'tp|take\\s*profit|target'
const SL_MGMT_VERBS = 'set|move|adjust|bring|change|update'

function slPriceFromClause(clause: string): number | null {
  const slClauseTo = clause.match(new RegExp(`\\bto\\s*(${SIGNAL_PRICE_NUM})\\b`, 'i'))
  if (slClauseTo?.[1]) return parseSignalPriceToken(slClauseTo[1])
  const candidates = bareTradePricesExcludingPips(clause, extractUnlabeledPrices(clause))
  const tail = candidates.length > 0 ? candidates[candidates.length - 1] : null
  if (tail != null && Number.isFinite(tail) && tail > 0) return tail
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
  const slMatchStandard = text.match(
    new RegExp(`\\b(?:${SL_TEXT_LABELS})\\s*[:=]?\\s*(${SIGNAL_PRICE_NUM})`, 'i'),
  )
  if (slMatchStandard?.[1]) return parseSignalPriceToken(slMatchStandard[1])
  const slMatchTo = text.match(
    new RegExp(`\\b(?:${SL_TEXT_LABELS})\\s+to\\s+(${SIGNAL_PRICE_NUM})`, 'i'),
  )
  if (slMatchTo?.[1]) return parseSignalPriceToken(slMatchTo[1])
  // "Adjust Risk/SL/Stoploss … (+ pips) … to 4505"
  const mgmtAdjust = text.match(
    new RegExp(`\\b(?:${SL_MGMT_VERBS})\\s+(?:${SL_TEXT_LABELS})\\b([^\\n\\r]{0,120})`, 'i'),
  )
  if (mgmtAdjust?.[1]) {
    const fromMgmt = slPriceFromClause(mgmtAdjust[1])
    if (fromMgmt != null) return fromMgmt
  }
  // Handles verbose updates like "Adjust SL + 20 pips for now to 4505".
  const slClause = text.match(new RegExp(`\\b(?:${SL_TEXT_LABELS})\\b([^\\n\\r]{0,96})`, 'i'))?.[1] ?? ''
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
  const tl = t.toLowerCase()

  const sym = extractTradableSymbolFromMessage(t)
  let action: ChannelParsedSignal["action"] | null = null
  let partial_close_fraction: number | undefined
  let confidence = 0.92
  const delim = channelKeywords.additional.delimiters
  const kwClose = [
    ...splitKeywordAliases(channelKeywords.update.close_full, delim),
    ...splitKeywordAliases(channelKeywords.additional.close_all, delim),
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
  const kwBreakeven = splitKeywordAliases(channelKeywords.update.break_even, delim)
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
    ...splitKeywordAliases(channelKeywords.update.delete, delim),
    ...splitKeywordAliases(channelKeywords.additional.delete_all, delim),
  ]

  const hitCloseHalfKw = hasAnyKeyword(t, kwCloseHalf)
  const hitClosePartialKw = hasAnyKeyword(t, kwClosePartialOnly)
  const hitCloseTpTierKw = hasAnyKeyword(t, kwCloseTpTiers)

  const wantsPartialHalf =
    hitCloseHalfKw ||
    hitClosePartialKw ||
    hitCloseTpTierKw ||
    /\b(close\s+partials?|close\s+half|close\s+50%|take\s+partials?|take\s+half|take\s+50%|c\s+half|half\s+of\s+(the\s+)?(position|trade))\b/i.test(t) ||
    /\b(closing\s+partial|close\s+partial\s+(?:lot|lots|lotsize|position|trade))\b/i.test(t) ||
    /\bsecure\s+\d+\s*%\s*profit/i.test(t) ||
    /\btake\s+profit\s+(?:target\s+)?(?:is\s+)?hit\b/i.test(t) ||
    /\b(50|half)\s*%?\s*(of\s+)?(the\s+)?(position|trade|lot|profit)\b/i.test(t) ||
    /\b(25|quarter|30|40|75)\s*%?\s*(of\s+)?(the\s+)?(position|trade|lot|profit)\b/i.test(tl) ||
    hasAnyKeyword(t, kwPartial)
  const wantsBreakeven =
    /\bbreakeven|break\s*even\b/i.test(t) ||
    /\bmove\s+stop\s+to\s+breakeven\b/i.test(t) ||
    /\bmoved?\s+(sl\s+)?to\s+(be|entry|entr(y)?\s?price)|\b(be|bk)\s*now\b/i.test(t) ||
    /\bstop\s*loss\s+to\s+(be|entry|breakeven|break\s*even)\b/i.test(t) ||
    /\bsl\s+to\s+(be|entry)\b/i.test(t) ||
    /\bmove\s+.*\b(stop\s*loss|sl)\b.*\b(breakeven|break\s*even|entry|be)\b/i.test(t) ||
    hasAnyKeyword(t, kwBreakeven)

  const wantsCloseWorseEntries =
    /\bclose\s+worse\s+entr(?:y|ies)\b/i.test(t) ||
    /\bclose\s+worse\b/i.test(t) ||
    hasAnyKeyword(t, kwCloseWorse)

  if (wantsCloseWorseEntries) action = "close_worse_entries"
  else if (wantsPartialHalf && wantsBreakeven) action = "partial_breakeven"
  else if (wantsPartialHalf) {
    action = "partial_profit"
    if (
      hitCloseHalfKw ||
      /\b(close\s+half|take\s+half|close\s+50%|take\s+50%|c\s+half|half\s+of\s+(the\s+)?(position|trade))\b/i.test(t) ||
      /\b(50|half)\s*%?\s*(of\s+)?(the\s+)?(position|trade|lot|profit)\b/i.test(t)
    ) {
      partial_close_fraction = 0.5
    } else if (
      hitClosePartialKw ||
      /\b(close\s+partials?|take\s+partials?|close\s+25%|take\s+25%)\b/i.test(t) ||
      /\b(25|quarter)\s*%?\s*(of\s+)?(the\s+)?(position|trade|lot|profit)\b/i.test(tl)
    ) {
      partial_close_fraction = 0.25
    } else {
      const pct = partialCloseFractionFromMessage(t)
      if (pct != null) partial_close_fraction = pct
    }
  } else if (wantsBreakeven) action = "breakeven"
  else if (wantsExplicitFullClose(t, kwClose)) action = "close"
  else if (looksLikeStopOrTpAdjustCommand(t) || hasAnyKeyword(t, kwModify)) action = "modify"

  if (!action) return null
  const looksEntry = ENTRY_KW.test(t) &&
    /\b(buy|sell)\s+(now|btc|bitcoin|gold|xau)|market\s+(buy|sell)/i.test(t)
  if (action === "close" && /\b(stop\s*sell|sell\s*stops?)\s+now\b/i.test(tl)) return null

  if (action === "close" && looksEntry && /\b(and|&)+\s*(gold|btc)\b/i.test(tl)) {
    confidence = 0.88
  }

  const slPriceLabels = [
    ...splitKeywordAliases(channelKeywords.signal.sl, delim),
    ...splitKeywordAliases(channelKeywords.update.set_sl, delim),
    ...splitKeywordAliases(channelKeywords.update.adjust_sl, delim),
  ]
  let sl: number | null = parseSlFromText(t)
  if (sl == null) sl = extractPriceByLabels(t, slPriceLabels)
  const extraTp = [
    ...(lexicon?.tp_aliases ?? []),
    ...(lexicon?.target_aliases ?? []),
    ...splitKeywordAliases(channelKeywords.signal.tp, delim),
    ...splitKeywordAliases(channelKeywords.update.set_tp, delim),
    ...splitKeywordAliases(channelKeywords.update.adjust_tp, delim),
  ]
  const tp = extractTpLevels(t, extraTp)

  return {
    action,
    symbol: sym,
    entry_price: null,
    entry_zone_low: null,
    entry_zone_high: null,
    sl,
    tp,
    lot_size: null,
    confidence,
    raw_instruction: message,
    open_tp: detectOpenTp(message),
    ...(action === "partial_profit" && partial_close_fraction != null ? { partial_close_fraction } : {}),
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
    new RegExp(`\\b(?:between|from)\\s+(${SIGNAL_PRICE_NUM})\\s+(?:and|to|-|–)\\s+(${SIGNAL_PRICE_NUM})\\b`, 'i'),
  )
  let entry_zone_low: number | null = null
  let entry_zone_high: number | null = null
  let entry_price: number | null = null
  if (zone?.[1] && zone?.[2]) {
    const a = parseSignalPriceToken(zone[1])
    const b = parseSignalPriceToken(zone[2])
    if (a != null && b != null) {
      entry_zone_low = Math.min(a, b)
      entry_zone_high = Math.max(a, b)
    }
  } else {
    const nowZone = text.match(
      new RegExp(`\\b(?:now|instant|market|mkt)\\s+(${SIGNAL_PRICE_NUM})\\s*(?:-|–|to)\\s*(${SIGNAL_PRICE_NUM})\\b`, 'i'),
    )
    if (nowZone?.[1] && nowZone?.[2]) {
      const a = parseSignalPriceToken(nowZone[1])
      const b = parseSignalPriceToken(nowZone[2])
      if (a != null && b != null) {
        entry_zone_low = Math.min(a, b)
        entry_zone_high = Math.max(a, b)
      }
    } else {
    const entryLevel = text.match(new RegExp(`\\bentry\\s+level\\s*[:=]?\\s*(${SIGNAL_PRICE_NUM})\\b`, 'i'))
    if (entryLevel?.[1]) entry_price = parseSignalPriceToken(entryLevel[1])
    const entryLabel = text.match(new RegExp(`\\bentry\\s*(?:price|level)?\\s*[:=]\\s*(${SIGNAL_PRICE_NUM})\\b`, 'i'))
    if (entry_price == null && entryLabel?.[1]) entry_price = parseSignalPriceToken(entryLabel[1])
    if (entry_price == null) {
      const atPx = text.match(new RegExp(`@\\s*(${SIGNAL_PRICE_NUM})\\b`))
      if (atPx?.[1]) entry_price = parseSignalPriceToken(atPx[1])
    }
    if (entry_price == null) {
      const buySellAt = text.match(new RegExp(`\\b(?:buy|sell)\\s+at\\s+(${SIGNAL_PRICE_NUM})\\b`, 'i'))
      if (buySellAt?.[1]) entry_price = parseSignalPriceToken(buySellAt[1])
    }
    if (entry_price == null) {
      const entryWord = text.match(new RegExp(`\\bentry\\s+(${SIGNAL_PRICE_NUM})\\b`, 'i'))
      if (entryWord?.[1]) entry_price = parseSignalPriceToken(entryWord[1])
    }
    if (entry_price == null) {
      const entryLabels = splitKeywordAliases(channelKeywords.signal.entry_point, delim)
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
  if (extractTpLevels(message, buildExtraTpLabels(null, channelKeywords)).length > 0) return true
  if (/\bentry\s*(?:price)?\s*[:=]\s*\d/i.test(text)) return true
  if (new RegExp(`@\\s*${SIGNAL_PRICE_NUM}`).test(text)) return true
  if (hasAnyKeyword(message, splitKeywordAliases(channelKeywords.signal.entry_point, delim))) return true
  const bare = bareTradePricesExcludingPips(message, extractUnlabeledPrices(message))
  return bare.length > 0
}

function messageHasSideKeywords(message: string, channelKeywords: ChannelKeywords): boolean {
  const delim = channelKeywords.additional.delimiters
  const buyAliases = Array.from(new Set(['buy', 'long', ...splitKeywordAliases(channelKeywords.signal.buy, delim)]))
  const sellAliases = Array.from(new Set(['sell', 'short', ...splitKeywordAliases(channelKeywords.signal.sell, delim)]))
  return parseBuySideFromKeywords(message, buyAliases) !== parseSellSideFromKeywords(message, sellAliases)
}

/** Symbol-less SL/TP/entry parameter posts (typical channel follow-up without repeating instrument). */
function parseChannelParameterFollowUp(
  message: string,
  lexicon: ChannelLexiconRow | null,
  channelKeywords: ChannelKeywords,
): ChannelParsedSignal | null {
  if (!hasParameterEvidence(message, channelKeywords)) return null
  if (extractTradableSymbolFromMessage(message)) return null
  if (messageHasSideKeywords(message, channelKeywords) && !detectReEnterIntent(message)) return null

  const extraTp = buildExtraTpLabels(lexicon, channelKeywords)
  const sl = extractSlFromMessage(message, channelKeywords)
  const tp = extractTpLevels(message, extraTp)
  const { entry_price, entry_zone_low, entry_zone_high } = extractOptionalEntryAnchor(message, channelKeywords)
  const reEnter = detectReEnterIntent(message)

  if (reEnter) {
    const delim = channelKeywords.additional.delimiters
    const buyAliases = Array.from(new Set(['buy', 'long', ...splitKeywordAliases(channelKeywords.signal.buy, delim)]))
    const sellAliases = Array.from(new Set(['sell', 'short', ...splitKeywordAliases(channelKeywords.signal.sell, delim)]))
    const isBuy = parseBuySideFromKeywords(message, buyAliases)
    const isSell = parseSellSideFromKeywords(message, sellAliases)
    if (isBuy === isSell) return null
    return {
      action: isBuy ? 'buy' : 'sell',
      symbol: null,
      entry_price,
      entry_zone_low,
      entry_zone_high,
      sl,
      tp,
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
  const buyAliases = Array.from(new Set(["buy", "long", ...splitKeywordAliases(channelKeywords.signal.buy, delim)]))
  const sellAliases = Array.from(new Set(["sell", "short", ...splitKeywordAliases(channelKeywords.signal.sell, delim)]))
  const marketAliases = Array.from(
    new Set(["now", "instant", "market", "mkt", ...splitKeywordAliases(channelKeywords.signal.market_order, delim)]),
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
    /\b(flatten|exit\s+trade|breakeven|break\s+even|partial|move\s+(?:sl|tp|risk|stop\s*loss|stoploss))\b/i.test(text)
    || looksLikeStopOrTpAdjustCommand(message)
    || looksLikeExplicitFullCloseCommand(message)
    || hasAnyKeyword(message, mgmtAliases)
  ) {
    return null
  }

  const isBuy = parseBuySideFromKeywords(message, buyAliases)
  const isSell = parseSellSideFromKeywords(message, sellAliases)
  const isNow = parseSideFromKeywords(message, marketAliases)
  const atMarketLike = /\b(at\s+market|@\s*market)\b/i.test(message)

  if (isBuy === isSell) return null

  const entryAnchor = extractOptionalEntryAnchor(message, channelKeywords)
  const hasExplicitEntry =
    entryAnchor.entry_price != null ||
    (entryAnchor.entry_zone_low != null && entryAnchor.entry_zone_high != null)

  if (!isNow && !atMarketLike && !hasExplicitEntry) return null

  const instrument = extractTradableSymbolFromMessage(message)
  if (!instrument) return null

  const hasInstrumentContext =
    isTradableInstrumentSymbol(instrument) ||
    /\b(gold|xau|xauusd|btc|bitcoin|btcusd|btcusdt|eth|ethereum|silver|eur|gbp)\b/i.test(text) ||
    /\bEUR\/USD|EURUSD|GBPUSD|USDJPY|XAUUSD|BTCUSD|BTCUSDT\b/i.test(message) ||
    /\b(us30|nas100|ger40|uk100|ustec|spx500)\b/i.test(text)

  if (!hasInstrumentContext) return null

  const sl = parseSlFromText(text) ?? extractPriceByLabels(message, splitKeywordAliases(channelKeywords.signal.sl, delim))
  const extraTp = [
    ...(lexicon?.tp_aliases ?? []),
    ...(lexicon?.target_aliases ?? []),
    ...splitKeywordAliases(channelKeywords.signal.tp, delim),
    ...splitKeywordAliases(channelKeywords.update.set_tp, delim),
    ...splitKeywordAliases(channelKeywords.update.adjust_tp, delim),
  ]
  const tp = extractTpLevels(message, extraTp)

  const { entry_price, entry_zone_low, entry_zone_high } = entryAnchor

  return {
    action: isBuy ? "buy" : "sell",
    symbol: instrument,
    entry_price,
    entry_zone_low,
    entry_zone_high,
    sl,
    tp,
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
  const buyAliases = Array.from(new Set(["buy", "long", ...splitKeywordAliases(channelKeywords.signal.buy, delim)]))
  const sellAliases = Array.from(new Set(["sell", "short", ...splitKeywordAliases(channelKeywords.signal.sell, delim)]))
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
  if (hasAnyKeyword(message, mgmtAliases)) return null

  const isBuy = parseBuySideFromKeywords(message, buyAliases)
  const isSell = parseSellSideFromKeywords(message, sellAliases)
  if (!isBuy && isSell && /\bshort\s+of\b/i.test(text)) return null
  if (isBuy === isSell) return null

  const instrument = extractTradableSymbolFromMessage(message)
  if (!instrument) return null

  const slPriceLabels = [
    ...splitKeywordAliases(channelKeywords.signal.sl, delim),
    ...splitKeywordAliases(channelKeywords.update.set_sl, delim),
  ]
  let sl: number | null = parseSlFromText(text)
  if (sl == null || !Number.isFinite(sl)) sl = extractPriceByLabels(text, slPriceLabels)

  const extraTp = [
    ...(lexicon?.tp_aliases ?? []),
    ...(lexicon?.target_aliases ?? []),
    ...splitKeywordAliases(channelKeywords.signal.tp, delim),
    ...splitKeywordAliases(channelKeywords.update.set_tp, delim),
    ...splitKeywordAliases(channelKeywords.update.adjust_tp, delim),
  ]
  const tp = extractTpLevels(message, extraTp)

  const entryPointHit = hasAnyKeyword(message, splitKeywordAliases(channelKeywords.signal.entry_point, delim))
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

function applyRawSymbolRepair(parsed: ChannelParsedSignal, rawMsg: string): ChannelParsedSignal {
  const extracted = extractTradableSymbolFromMessage(rawMsg)

  const cur = parsed.symbol?.toUpperCase().replace(/\s/g, "") ?? ""
  const curMentioned = cur ? new RegExp(`\\b${cur}\\b`, "i").test(rawMsg.replace(/\s+/g, "")) : false
  const goldHints = /\b(gold|xau|xauusd)\b/i.test(rawMsg)
  const btcHints = /\b(btc|bitcoin|btcusd|btcusdt)\b/i.test(rawMsg)
  const hasAnySymbolHint = /([A-Z]{3,}\/[A-Z]{3,})|\b([A-Z]{6}|XAUUSD|XAGUSD|BTCUSD|BTCUSDT|ETHUSD|ETHUSDT)\b|(\bgold\b|\bxau\b|\bbtc\b|\bbitcoin\b|\beth\b|\bether)\b/i
    .test(rawMsg)
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

export { looksLikeChannelManagementUpdate, looksLikeExplicitFullCloseCommand } from './signalManagementIntent'

/** Synchronous parse when keywords/lexicon are already loaded (hot path). */
export function parseChannelMessageSync(
  rawMessage: string,
  channelKeywords: ChannelKeywords,
  lexicon: ChannelLexiconRow | null,
): ParseChannelMessageResult {
  const ignoreAliases = [
    ...splitKeywordAliases(channelKeywords.additional.ignore_keyword, channelKeywords.additional.delimiters),
    ...splitKeywordAliases(channelKeywords.additional.skip_keyword, channelKeywords.additional.delimiters),
  ]

  const explicitIgnore = hasAnyKeyword(rawMessage, ignoreAliases)
  const keywordMatch =
    parseDeterministicManagement(rawMessage, lexicon, channelKeywords) ??
    parseChannelParameterFollowUp(rawMessage, lexicon, channelKeywords) ??
    parseSimpleSignal(rawMessage, lexicon, channelKeywords) ??
    parseEntryFromKeywords(rawMessage, lexicon, channelKeywords)

  const rawParsed = explicitIgnore
    ? ignorePayload(rawMessage)
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
      raw_instruction: rawMessage,
      open_tp: false,
    }

  const enriched = applyReEnterFlag(
    applyDirectionalPriceInference(
      normalizeParsedFromModel(rawParsed, rawMessage),
      rawMessage,
    ),
    rawMessage,
  )

  const repaired = applyRawSymbolRepair(enriched, rawMessage)
  const dropped = dropInvalidTradeSymbol(repaired)
  if (entryMissingSlTpRequiresNow(dropped, rawMessage, channelKeywords)) {
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
    ? (explicitIgnore ? "Non-trade message" : "No matching channel keywords or price pattern")
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
