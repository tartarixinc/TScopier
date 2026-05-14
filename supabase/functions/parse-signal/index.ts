import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "npm:@supabase/supabase-js@2"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
}

/** Structured instruction from Telegram text + per-channel keywords (no LLM, no broker calls). */
interface ParsedSignal {
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
}

type ChannelLexiconRow = {
  user_id: string
  channel_id: string
  action_aliases?: Record<string, string[]> | null
  tp_aliases?: string[] | null
  target_aliases?: string[] | null
  unknown_tokens?: string[] | null
}

type ChannelKeywords = {
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

const DEFAULT_CHANNEL_KEYWORDS: ChannelKeywords = {
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
    break_even: "BREAK EVEN",
    set_tp1: "SET TP1",
    set_tp2: "SET TP2",
    set_tp3: "SET TP3",
    set_tp4: "SET TP4",
    set_tp5: "SET TP5",
    set_tp: "SET TP",
    adjust_tp: "ADJUST TP",
    set_sl: "SET SL",
    adjust_sl: "ADJUST SL",
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

function normalizeChannelKeywords(raw: unknown): ChannelKeywords {
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

function parseSideFromKeywords(text: string, words: string[]): boolean {
  return hasAnyKeyword(text, words)
}

function buildTpRegex(extraLabels: string[] = []): RegExp {
  const base = ["tp", "take\\s*profit", "target"]
  const custom = extraLabels.map((x) => escapeRegExp(x.trim())).filter(Boolean)
  return new RegExp(`\\b(?:${[...base, ...custom].join("|")})\\s*\\d*\\s*[:=\\-]?\\s*(\\d+(?:\\.\\d+)?)`, "gi")
}

function extractTpLevels(message: string, extraLabels: string[] = []): number[] {
  const text = String(message ?? "")
  const rx = buildTpRegex(extraLabels)
  const matches = [...text.matchAll(rx)]
  const values = matches.map((m) => Number(m[1])).filter((n) => Number.isFinite(n))
  if (values.length) return values
  const compact = [...text.matchAll(/\b(?:tp|target)\s*\d+\s+(\d+(?:\.\d+)?)/gi)]
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n))
  return compact
}

function detectOpenTp(message: string): boolean {
  const t = String(message ?? "")
  return /\b(open\s*tp|without\s*tp|no\s*tp|runner|let\s+it\s+run|leave\s+runner)\b/i.test(t)
}

function extractPriceByLabels(message: string, labels: string[]): number | null {
  for (const label of labels) {
    const k = String(label ?? "").trim()
    if (!k) continue
    const rx = new RegExp(`${escapeRegExp(k).replace(/\s+/g, "\\s*")}\\s*[:=\\-]?\\s*(\\d+(?:\\.\\d+)?)`, "i")
    const m = message.match(rx)
    if (m?.[1]) {
      const n = Number(m[1])
      if (Number.isFinite(n)) return n
    }
  }
  return null
}

function isManagementAction(action: string): boolean {
  return new Set(["close", "breakeven", "partial_profit", "partial_breakeven", "modify"]).has(String(action ?? "").toLowerCase())
}

function normalizeParsedFromModel(raw: unknown, fallbackText: string): ParsedSignal {
  const j = raw && typeof raw === "object" ? raw as Record<string, unknown> : {}
  let action = String(j.action ?? "ignore").trim().toLowerCase()
  if (action === "long") action = "buy"
  if (action === "short") action = "sell"
  const allowed = new Set([
    "buy", "sell", "close", "breakeven", "partial_profit", "partial_breakeven", "modify", "ignore",
  ])
  if (!allowed.has(action)) action = "ignore"

  const numOrNull = (v: unknown): number | null => {
    if (v == null || v === "") return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }

  let symbol: string | null = null
  if (typeof j.symbol === "string" && j.symbol.trim()) {
    symbol = j.symbol.trim().toUpperCase().replace(/\s+/g, "")
  }

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
  }
}

function extractTradableSymbolFromMessage(raw: string): string | null {
  if (!raw || typeof raw !== "string") return null
  const u = raw.toUpperCase().replace(/\s+/g, " ")

  const slash = raw.match(/\b([A-Z]{3,})\s*\/\s*([A-Z]{3,})\b/i)
  if (slash) return (slash[1] + slash[2]).toUpperCase()

  const explicit = u.match(
    /\b(BTCUSD|BTCUSDT|BTCEUR|ETHUSD|ETHUSDT|EURUSD|GBPUSD|USDJPY|AUDUSD|NZDUSD|USDCAD|USDCHF|XAUUSD|XAGUSD|US30|US500|NAS100|GER40|UK100|SPX500|USTEC)\b/,
  )
  if (explicit) return explicit[1]

  if (/\bBITCOIN\b|\bBTC\b/.test(u) && /\bEUR\b/.test(u) && !/\bUSD\b|\bUSDT\b|\bPERP\b/.test(u)) return "BTCEUR"
  if (/\bBITCOIN\b|\bBTC\b/.test(u)) return /\bUSDT\b/.test(u) ? "BTCUSDT" : "BTCUSD"
  if (/\bETHER(EUM)?\b|\bETH\b/.test(u)) return /\bUSDT\b/.test(u) ? "ETHUSDT" : "ETHUSD"
  if (/\b(XAUUSD|XAU\b|GOLD)\b/.test(u)) return "XAUUSD"
  if (/\bSILVER\b|\bXAG\b|\bXAGUSD\b/.test(u)) return "XAGUSD"

  const bogusSix = new Set([
    "CLOSED", "CLOSES", "SIGNAL", "MARKET", "SILVER", "GOLDEN", "MASTER", "PUBLIC", "TRADER", "BROKER",
    "MARGIN", "POSITION", "TRADES", "ORDERS", "ADJUST", "UPDATE", "MODIFY", "CHANGE", "TARGET", "STOPLO",
  ])
  const six = u.match(/\b([A-Z]{6})\b/)
  if (six && !bogusSix.has(six[1])) {
    return six[1]
  }
  return null
}

const ENTRY_KW = /\b(buy|sell|long|short)\b/i
const MGMT_CLOSE =
  /\b(close\s*(all)?|flatten|kill\s*zones?|exit\s*(trade|position|long|short))\b|\b(close|closed)\s+((my|the|this)\s+)?((running|active|open)\s+)?(trade|position|btc|gold)/i

function parseDeterministicManagement(
  message: string,
  lexicon: ChannelLexiconRow | null,
  channelKeywords: ChannelKeywords,
): ParsedSignal | null {
  const t = message.replace(/\s+/g, " ").trim()
  if (!t) return null
  const tl = t.toLowerCase()

  const sym = extractTradableSymbolFromMessage(t)
  let action: ParsedSignal["action"] | null = null
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
    /\b(50|half)\s*%?\s*(of\s+)?(the\s+)?(position|trade|lot|profit)\b/i.test(t) ||
    /\b(25|quarter)\s*%?\s*(of\s+)?(the\s+)?(position|trade|lot|profit)\b/i.test(tl) ||
    hasAnyKeyword(t, kwPartial)
  const wantsBreakeven =
    /\bbreakeven|break\s*even\b/i.test(t) ||
    /\bmoved?\s+(sl\s+)?to\s+(be|entry|entr(y)?\s?price)|\b(be|bk)\s*now\b/i.test(t) ||
    /\bstop\s*loss\s+to\s+(be|entry|breakeven|break\s*even)\b/i.test(t) ||
    /\bsl\s+to\s+(be|entry)\b/i.test(t) ||
    /\bmove\s+.*\b(stop\s*loss|sl)\b.*\b(breakeven|break\s*even|entry|be)\b/i.test(t) ||
    hasAnyKeyword(t, kwBreakeven)

  if (wantsPartialHalf && wantsBreakeven) action = "partial_breakeven"
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
    }
  } else if (wantsBreakeven) action = "breakeven"
  else if (MGMT_CLOSE.test(t) || hasAnyKeyword(t, kwClose)) action = "close"
  else if (
    /\b(set|move|adjust|bring)\s+(sl|tp|target|stop\s*loss|take\s*profit)\b|\b(stop\s*loss|take\s*profit|target)\s*(to|=)\s*[\d.]+/i
      .test(t) || hasAnyKeyword(t, kwModify)
  ) action = "modify"

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
  const slMatchStandard = t.match(/\b(?:sl|stop\s*loss)\s*[:=]?\s*(\d+(?:\.\d+)?)/i)
  const slMatchTo = t.match(/\b(?:sl|stop\s*loss)\s+to\s+(\d+(?:\.\d+)?)/i)
  let sl: number | null = null
  if (slMatchStandard?.[1]) {
    const n = Number(slMatchStandard[1])
    if (Number.isFinite(n)) sl = n
  }
  if (sl == null && slMatchTo?.[1]) {
    const n = Number(slMatchTo[1])
    if (Number.isFinite(n)) sl = n
  }
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
 * Shared so "BUY … NOW / MARKET" simple signals still retain an anchor when the same line lists one.
 */
function extractOptionalEntryAnchor(
  message: string,
  channelKeywords: ChannelKeywords,
): { entry_price: number | null; entry_zone_low: number | null; entry_zone_high: number | null } {
  const text = message.replace(/\s+/g, " ").trim()
  const delim = channelKeywords.additional.delimiters
  const zone = text.match(
    /\b(?:between|from)\s+(\d+(?:\.\d+)?)\s+(?:and|to|-|–)\s+(\d+(?:\.\d+)?)\b/i,
  )
  let entry_zone_low: number | null = null
  let entry_zone_high: number | null = null
  let entry_price: number | null = null
  if (zone?.[1] && zone?.[2]) {
    const a = Number(zone[1])
    const b = Number(zone[2])
    if (Number.isFinite(a) && Number.isFinite(b)) {
      entry_zone_low = Math.min(a, b)
      entry_zone_high = Math.max(a, b)
    }
  } else {
    const entryLabel = text.match(/\bentry\s*(?:price)?\s*[:=]\s*(\d+(?:\.\d+)?)\b/i)
    if (entryLabel?.[1]) {
      const n = Number(entryLabel[1])
      if (Number.isFinite(n) && n > 0) entry_price = n
    }
    if (entry_price == null) {
      const atPx = text.match(/@\s*(\d+(?:\.\d+)?)\b/)
      if (atPx?.[1]) {
        const n = Number(atPx[1])
        if (Number.isFinite(n) && n > 0) entry_price = n
      }
    }
    if (entry_price == null) {
      const buySellAt = text.match(/\b(?:buy|sell)\s+at\s+(\d+(?:\.\d+)?)\b/i)
      if (buySellAt?.[1]) {
        const n = Number(buySellAt[1])
        if (Number.isFinite(n) && n > 0) entry_price = n
      }
    }
    if (entry_price == null) {
      const entryWord = text.match(/\bentry\s+(\d+(?:\.\d+)?)\b/i)
      if (entryWord?.[1]) {
        const n = Number(entryWord[1])
        if (Number.isFinite(n) && n > 0) entry_price = n
      }
    }
    if (entry_price == null) {
      const entryLabels = splitKeywordAliases(channelKeywords.signal.entry_point, delim)
      const fromKw = extractPriceByLabels(text, entryLabels)
      if (fromKw != null && Number.isFinite(fromKw) && fromKw > 0) {
        entry_price = fromKw
      }
    }
    // Common signal shapes that omit "entry" / "@" labels but still carry a single anchor:
    //   "BUY XAUUSD NOW 2650", "BUY GOLD 2645.5 MARKET", "SELL BTCUSD 98000 NOW"
    if (entry_price == null && entry_zone_low == null) {
      const symPriceThenMarket = text.match(
        /\b(?:xauusd|xagusd|gold|silver|btcusd|btcusdt|ethusd|ethusdt|eurusd|gbpusd|usdjpy|us30|nas100)\s+(\d{3,}(?:\.\d+)?)\s+(?:now|instant|market|mkt)\b/i,
      )
      if (symPriceThenMarket?.[1]) {
        const n = Number(symPriceThenMarket[1])
        if (Number.isFinite(n) && n > 0) entry_price = n
      }
    }
    if (entry_price == null && entry_zone_low == null) {
      const marketThenPrice = text.match(/\b(?:now|instant|market|mkt)\s+(\d{3,}(?:\.\d+)?)\b/i)
      if (marketThenPrice?.[1]) {
        const n = Number(marketThenPrice[1])
        if (Number.isFinite(n) && n > 0) entry_price = n
      }
    }
  }
  return { entry_price, entry_zone_low, entry_zone_high }
}

function parseSimpleSignal(
  message: string,
  lexicon: ChannelLexiconRow | null,
  channelKeywords: ChannelKeywords,
): ParsedSignal | null {
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

  if (/\b(close|flatten|exit\s+trade|breakeven|break\s+even|partial|move\s+(sl|tp))\b/i.test(text) || hasAnyKeyword(message, mgmtAliases)) {
    return null
  }

  const isBuy = parseSideFromKeywords(message, buyAliases)
  const isSell = parseSideFromKeywords(message, sellAliases)
  const isNow = parseSideFromKeywords(message, marketAliases)
  const atMarketLike = /\b(at\s+market|@\s*market)\b/i.test(message)

  if (!isNow && !atMarketLike) return null
  if (isBuy === isSell) return null

  const instrument = extractTradableSymbolFromMessage(message)
  if (!instrument) return null

  const hasInstrumentContext =
    /\b(gold|xau|xauusd|btc|bitcoin|btcusd|btcusdt|eth|ethereum|silver|eur|gbp)\b/i.test(text) ||
    /\bEUR\/USD|EURUSD|GBPUSD|USDJPY|XAUUSD|BTCUSD|BTCUSDT\b/i.test(message) ||
    /\b(us30|nas100|ger40|uk100|ustec|spx500)\b/i.test(text) ||
    /^[A-Z]{4,}$/i.test(instrument.trim())

  if (!hasInstrumentContext) return null

  const slMatch = text.match(/\b(?:sl|stop\s*loss)\s*[:=]?\s*(\d+(?:\.\d+)?)/i)
  const sl = slMatch ? Number(slMatch[1]) : extractPriceByLabels(message, splitKeywordAliases(channelKeywords.signal.sl, delim))
  const extraTp = [
    ...(lexicon?.tp_aliases ?? []),
    ...(lexicon?.target_aliases ?? []),
    ...splitKeywordAliases(channelKeywords.signal.tp, delim),
    ...splitKeywordAliases(channelKeywords.update.set_tp, delim),
    ...splitKeywordAliases(channelKeywords.update.adjust_tp, delim),
  ]
  const tp = extractTpLevels(message, extraTp)

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
): ParsedSignal | null {
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

  const isBuy = parseSideFromKeywords(message, buyAliases)
  const isSell = parseSideFromKeywords(message, sellAliases)
  if (isBuy === isSell) return null

  const instrument = extractTradableSymbolFromMessage(message)
  if (!instrument) return null

  const slPriceLabels = [
    ...splitKeywordAliases(channelKeywords.signal.sl, delim),
    ...splitKeywordAliases(channelKeywords.update.set_sl, delim),
  ]
  const slMatchStandard = text.match(/\b(?:sl|stop\s*loss)\s*[:=]?\s*(\d+(?:\.\d+)?)/i)
  let sl: number | null = slMatchStandard?.[1] ? Number(slMatchStandard[1]) : null
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
    /\d{3,}(?:\.\d+)?/.test(text)

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

function applyRawSymbolRepair(parsed: ParsedSignal, rawMsg: string): ParsedSignal {
  const extracted = extractTradableSymbolFromMessage(rawMsg)

  const cur = parsed.symbol?.toUpperCase().replace(/\s/g, "") ?? ""
  const curMentioned = cur ? new RegExp(`\\b${cur}\\b`, "i").test(rawMsg.replace(/\s+/g, "")) : false
  const goldHints = /\b(gold|xau|xauusd)\b/i.test(rawMsg)
  const btcHints = /\b(btc|bitcoin|btcusd|btcusdt)\b/i.test(rawMsg)
  const hasAnySymbolHint = /([A-Z]{3,}\/[A-Z]{3,})|\b([A-Z]{6}|XAUUSD|XAGUSD|BTCUSD|BTCUSDT|ETHUSD|ETHUSDT)\b|(\bgold\b|\bxau\b|\bbtc\b|\bbitcoin\b|\beth\b|\bether)\b/i
    .test(rawMsg)
  const mgmt = new Set(["close", "breakeven", "partial_profit", "partial_breakeven", "modify"]).has(parsed.action)

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
  if ((!cur || cur !== extracted) && (btcHints || goldHints || /^[A-Z]{6}$/.test(extracted))) {
    return { ...parsed, symbol: extracted }
  }
  return parsed
}

function ignorePayload(raw: string): ParsedSignal {
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

async function loadChannelLexicon(
  supabase: ReturnType<typeof createClient>,
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

async function loadChannelKeywords(
  supabase: ReturnType<typeof createClient>,
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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders })
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    )

    const body = await req.json()
    const { signal_id } = body

    if (!signal_id) {
      return Response.json({ error: "signal_id required" }, { status: 400, headers: corsHeaders })
    }

    const { data: signal, error: signalErr } = await supabase
      .from("signals")
      .select("*")
      .eq("id", signal_id)
      .single()

    if (signalErr || !signal) {
      return Response.json({ error: "Signal not found" }, { status: 404, headers: corsHeaders })
    }

    const lexicon = await loadChannelLexicon(supabase, signal.channel_id)
    const channelKeywords = await loadChannelKeywords(supabase, signal.channel_id)

    const ignoreAliases = [
      ...splitKeywordAliases(channelKeywords.additional.ignore_keyword, channelKeywords.additional.delimiters),
      ...splitKeywordAliases(channelKeywords.additional.skip_keyword, channelKeywords.additional.delimiters),
    ]

    const explicitIgnore = hasAnyKeyword(signal.raw_message, ignoreAliases)
    const keywordMatch =
      parseDeterministicManagement(signal.raw_message, lexicon, channelKeywords) ??
      parseSimpleSignal(signal.raw_message, lexicon, channelKeywords) ??
      parseEntryFromKeywords(signal.raw_message, lexicon, channelKeywords)

    const rawParsed = explicitIgnore
      ? ignorePayload(signal.raw_message)
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
        raw_instruction: signal.raw_message,
        open_tp: false,
      }

    const parsed = applyRawSymbolRepair(
      normalizeParsedFromModel(rawParsed, signal.raw_message),
      signal.raw_message,
    )

    const newStatus = parsed.action === "ignore" ? "skipped" : "parsed"
    const skipReason = parsed.action === "ignore"
      ? (explicitIgnore ? "Non-trade message" : "No matching channel keywords or price pattern")
      : null

    const { error: updateErr } = await supabase
      .from("signals")
      .update({
        parsed_data: parsed,
        status: newStatus,
        skip_reason: skipReason,
      })
      .eq("id", signal_id)

    if (updateErr) {
      return Response.json({ error: updateErr.message }, { status: 500, headers: corsHeaders })
    }

    if (parsed.action !== "ignore") {
      EdgeRuntime.waitUntil(
        (async () => {
          try {
            await supabase.from("trade_execution_logs").insert({
              user_id: signal.user_id as string,
              signal_id,
              broker_account_id: null,
              action: "keyword_parse",
              status: "success",
              request_payload: { parser: "channel_keywords" },
              response_payload: parsed as unknown as Record<string, unknown>,
              error_message: null,
            })
          } catch {
            // logging must not fail the request
          }
        })(),
      )
    }

    return Response.json({ parsed, status: newStatus }, { headers: corsHeaders })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal server error"
    console.error("parse-signal error:", message)
    return Response.json({ error: message }, { status: 500, headers: corsHeaders })
  }
})
