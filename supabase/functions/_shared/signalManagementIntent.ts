/**
 * Shared detection for channel management updates (breakeven, partial close, etc.).
 */
import {
  textLooksLikeMultilingualFullClose,
  textLooksLikeMultilingualManagement,
} from "./multilingualManagementTerms.ts"

const EXPLICIT_CLOSE_SYMBOL =
  "gold|xauusd|xau|silver|xagusd|btc|bitcoin|btcusd|ethusd|eurusd|gbpusd|us30|nas100"

export type ManagementKeywordFields = {
  update?: Record<string, string | undefined>
  additional?: { close_all?: string; delimiters?: string }
}

export function looksLikeExplicitFullCloseCommand(message: string): boolean {
  const t = String(message ?? "").replace(/\s+/g, " ").trim()
  if (!t) return false
  if (/\bclose\s+to\b/i.test(t)) return false

  if (textLooksLikeMultilingualFullClose(t)) return true

  return (
    /\bclose\s+(?:now|all|full|trade|trades|position|positions|everything|every\s+thing)\b/i.test(t)
    || /\bclose\s+(?:my|the|this|running|active|open)\s+(?:trade|trades|position|positions)\b/i.test(t)
    || new RegExp(`\\bclose\\s+(?:${EXPLICIT_CLOSE_SYMBOL}|[a-z]{6})\\b`, "i").test(t)
    || /\b(?:flatten|kill\s+zones?)\b/i.test(t)
    || /\bexit\s+(?:trade|trades|position|positions|long|short|now)\b/i.test(t)
  )
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
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

function keywordRegex(phrase: string): RegExp {
  const p = escapeRegExp(phrase.trim()).replace(/\s+/g, "\\s+")
  return new RegExp(`(?<![\\p{L}\\p{N}])${p}(?![\\p{L}\\p{N}])`, "iu")
}

function hasAnyKeyword(text: string, words: string[]): boolean {
  return words.some((w) => w && keywordRegex(w).test(text))
}

function managementAliasesFromKeywords(keywords: ManagementKeywordFields | null | undefined): string[] {
  if (!keywords) return []
  const update = keywords.update ?? {}
  const delim = keywords.additional?.delimiters ?? ""
  return Array.from(new Set([
    ...splitKeywordAliases(update.break_even ?? "", delim),
    ...splitKeywordAliases(update.close_full ?? "", delim),
    ...splitKeywordAliases(update.close_half ?? "", delim),
    ...splitKeywordAliases(update.close_partial ?? "", delim),
    ...splitKeywordAliases(update.close_tp1 ?? "", delim),
    ...splitKeywordAliases(update.close_tp2 ?? "", delim),
    ...splitKeywordAliases(update.close_tp3 ?? "", delim),
    ...splitKeywordAliases(update.close_tp4 ?? "", delim),
    ...splitKeywordAliases(update.set_sl ?? "", delim),
    ...splitKeywordAliases(update.adjust_sl ?? "", delim),
    ...splitKeywordAliases(update.set_tp ?? "", delim),
    ...splitKeywordAliases(update.adjust_tp ?? "", delim),
    ...splitKeywordAliases(keywords.additional?.close_all ?? "", delim),
  ].map((a) => a.trim()).filter(Boolean)))
}

export function looksLikeChannelManagementUpdate(
  text: string,
  channelKeywords?: ManagementKeywordFields | null,
): boolean {
  const t = String(text ?? "").replace(/\s+/g, " ").trim()
  if (!t) return false

  const configured = managementAliasesFromKeywords(channelKeywords)
  if (configured.length > 0 && hasAnyKeyword(t, configured)) return true

  if (textLooksLikeMultilingualManagement(t)) return true

  return (
    /\b(move\s+stop|move\s+sl|move\s+risk|stop\s+to\s+breakeven|breakeven|break\s*even)\b/i.test(t)
    || /\b(?:sl|stop\s*loss|stoploss|risk|stop)\s+to\s+(?:be|entry|breakeven|break\s*even)\b/i.test(t)
    || /\b(?:adjust|move|set|change|update)\s+(?:sl|stop\s*loss|stoploss|risk)\b/i.test(t)
    || /\b(?:sl|stop\s*loss|stoploss|risk)\s+to\s+\d/i.test(t)
    || /\b(close\s+partial|closing\s+partial|take\s+partial|partial\s+(?:lot|lots|lotsize|position|trade))\b/i.test(t)
    || /\bsecure\s+\d+\s*%\s*profit/i.test(t)
    || /\btake\s+profit\s+(?:target\s+)?(?:is\s+)?hit\b/i.test(t)
    || /\bclose\s+(?:half|50%|25%|partials?)\b/i.test(t)
    || /\b\d{1,3}\s*%\s*(?:of\s+)?(?:the\s+)?(?:position|trade|lot|profit(?:s)?)\b/i.test(t)
  )
}

export function partialCloseFractionFromMessage(text: string): number | null {
  const m = String(text ?? "").match(
    /\b(?:secure|close|take)\s+(\d{1,2}|100)\s*%\s*(?:of\s+)?(?:the\s+)?(?:position|trade|lot|profit(?:s)?)?/i,
  )
  if (m?.[1]) {
    const n = Number(m[1])
    if (Number.isFinite(n) && n > 0 && n <= 100) return n / 100
  }
  const pctOnly = String(text ?? "").match(
    /\b(\d{1,2}|100)\s*%\s*(?:of\s+)?(?:the\s+)?(?:position|trade|lot|profit(?:s)?)\b/i,
  )
  if (pctOnly?.[1]) {
    const n = Number(pctOnly[1])
    if (Number.isFinite(n) && n > 0 && n <= 100) return n / 100
  }
  return null
}

export function isPipCountInMessage(message: string, price: number): boolean {
  const s = String(price)
  return new RegExp(`(?:\\+|\\b)${s}\\s*pips?\\b`, "i").test(String(message ?? ""))
}

export function bareTradePricesExcludingPips(message: string, prices: number[]): number[] {
  return prices.filter((p) => !isPipCountInMessage(message, p))
}
