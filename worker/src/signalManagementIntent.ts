/**
 * Shared detection for channel management updates (breakeven, partial close, etc.).
 */
import type { ChannelKeywords, ChannelLexiconRow } from './parseSignal'
import {
  COMMON_BREAKEVEN_PHRASES,
  textLooksLikeConditionalClose,
  textLooksLikeMultilingualFullClose,
  textLooksLikeMultilingualManagement,
} from './multilingualManagementTerms'
import { messageContainsKeyword } from './multilingualSignalTerms'
import {
  flattenManagementGroups,
  resolveManagementGroups,
} from './trainingManagementKeywords'

const EXPLICIT_CLOSE_SYMBOL =
  'gold|xauusd|xau|silver|xagusd|btc|bitcoin|btcusd|ethusd|eurusd|gbpusd|us30|nas100'

/**
 * Full new-trade templates (e.g. ForexBro "New Signal #898 / Market: AUDUSD · BUY / Entry Zone …")
 * must not be classified as SL/TP management when channel keywords include footer disclaimers.
 */
export function looksLikeStructuredEntrySignal(message: string): boolean {
  const t = String(message ?? '').replace(/\s+/g, ' ').trim()
  if (!t) return false

  const hasTradeSide = /\b(?:buy|sell|long|short|شراء|بيع)\b/i.test(t)
  if (!hasTradeSide) return false

  const hasEntryZone =
    /\bentry\s*zone\b/i.test(t)
    || /\bمنطقة\s+الدخول\b/.test(t)

  const hasNewSignalBanner =
    /\bnew\s+signal\b/i.test(t)
    || /\bصفقة\s+حديثة\b/.test(t)

  const hasMarketPairLine =
    /\bmarket\s*:\s*[A-Z]{3,12}\s*[·•|]\s*(?:buy|sell|شراء|بيع)\b/i.test(t)
    || /\bالسوق\s*:\s*[A-Z]{3,12}/i.test(t)

  const hasSlPrice =
    /\b(?:sl|stop\s*loss|stoploss|وقف\s+الخسارة)\s*[:=]?\s*\d/i.test(t)

  const hasTpPrice =
    /\b(?:tp\s*\d|take\s+profit\s*\d|الهدف\s+(?:الأول|الثاني|الثالث))\s*[:=]?\s*\d/i.test(t)
    || /\btp\s*1\s*[:=]/i.test(t)

  if (hasNewSignalBanner && hasTradeSide && hasEntryZone && hasSlPrice && hasTpPrice) {
    return true
  }
  if (hasMarketPairLine && hasEntryZone && hasSlPrice && hasTpPrice) {
    return true
  }
  return false
}

/** All trained management aliases from channel keywords + lexicon buckets. */
export function trainedManagementAliases(
  channelKeywords?: ChannelKeywords | null,
  lexicon?: ChannelLexiconRow | null,
): string[] {
  const fromKeywords = managementAliasesFromKeywords(channelKeywords)
  const legacyGroups = resolveManagementGroups({
    management_cues: lexicon?.action_aliases?.modify ?? [],
  })
  return Array.from(new Set([
    ...fromKeywords,
    ...flattenManagementGroups(legacyGroups),
    ...(lexicon?.action_aliases?.modify ?? []),
  ].map(a => String(a).trim()).filter(Boolean)))
}

export function channelHasTrainedManagement(
  channelKeywords?: ChannelKeywords | null,
  lexicon?: ChannelLexiconRow | null,
): boolean {
  const modify = lexicon?.action_aliases?.modify ?? []
  if (modify.length > 0) return true
  const additional = channelKeywords?.additional as { ai_management_keyword_groups?: unknown } | undefined
  return Boolean(additional?.ai_management_keyword_groups)
}

/**
 * True for intentional full-close commands (two-word minimum), not prose like "close to our entry".
 */
export function looksLikeExplicitFullCloseCommand(
  message: string,
  ctx?: { channelKeywords?: ChannelKeywords | null; lexicon?: ChannelLexiconRow | null },
): boolean {
  const t = String(message ?? '').replace(/\s+/g, ' ').trim()
  if (!t) return false
  if (/\bclose\s+to\b/i.test(t)) return false

  const legacyGroups = resolveManagementGroups({
    management_cues: ctx?.lexicon?.action_aliases?.modify ?? [],
  })
  const closeAliases = Array.from(new Set([
    ...legacyGroups.close_all,
    ...splitKeywordAliases(ctx?.channelKeywords?.additional?.close_all ?? '', ctx?.channelKeywords?.additional?.delimiters ?? '|'),
    ...splitKeywordAliases(ctx?.channelKeywords?.update?.close_full ?? '', ctx?.channelKeywords?.additional?.delimiters ?? '|'),
  ].filter(Boolean)))
  if (closeAliases.length > 0 && hasAnyKeyword(t, closeAliases)) return true

  if (!channelHasTrainedManagement(ctx?.channelKeywords, ctx?.lexicon)) {
    if (textLooksLikeMultilingualFullClose(t)) return true
  }

  return (
    /\bclose\s+(?:now|all|full|trade|trades|position|positions|everything|every\s+thing)\b/i.test(t)
    || /\bclose\s+(?:my|the|this|running|active|open)\s+(?:trade|trades|position|positions)\b/i.test(t)
    || new RegExp(`\\bclose\\s+(?:${EXPLICIT_CLOSE_SYMBOL}|[a-z]{6})\\b`, 'i').test(t)
    || /\b(?:flatten|kill\s+zones?)\b/i.test(t)
    || /\bexit\s+(?:trade|trades|position|positions|long|short|now)\b/i.test(t)
  )
}

/**
 * Cancel/delete pending limit cues (reply-scoped at execute time).
 * Includes channel `update.delete` / `delete_all` keywords.
 */
export function looksLikeDeletePendingsCommand(
  message: string,
  ctx?: { channelKeywords?: ChannelKeywords | null },
): boolean {
  const t = String(message ?? '').replace(/\s+/g, ' ').trim()
  if (!t) return false

  if (
    /\b(?:delete|cancel|remove)\s+(?:(?:buy|sell)\s+)?(?:limit|pending|order)s?\b/i.test(t)
    || /\b(?:cancel|delete)\s+(?:limit|pending)\b/i.test(t)
    || /\b(?:trade|setup)\s+invalid\b/i.test(t)
    || /\binvalid\s+(?:trade|setup)\b/i.test(t)
  ) {
    return true
  }

  const delim = ctx?.channelKeywords?.additional?.delimiters ?? ''
  const deleteAliases = Array.from(new Set([
    ...splitKeywordAliases(ctx?.channelKeywords?.update?.delete ?? '', delim),
    ...splitKeywordAliases(ctx?.channelKeywords?.additional?.delete_all ?? '', delim),
  ].filter(Boolean)))
  return deleteAliases.length > 0 && hasAnyKeyword(t, deleteAliases)
}

/** Optional/advisory close language; should not auto-execute a full close. */
export function looksLikeConditionalCloseSuggestion(message: string): boolean {
  const t = String(message ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
  if (!t) return false
  if (!/\b(close|cerrar|fermer|fermez|zamknij|закрой|закрыть|stang|stäng|sluit|exit)\b/.test(t)) {
    return false
  }
  if (/\b(close|cerrar|fermer|fermez)\s+(all|everything|todo|tout|все|всё)\b/.test(t)) {
    return false
  }
  if (textLooksLikeConditionalClose(t)) return true
  if (/\b(if|si|если)\b/.test(t)) return true
  return /\b(if you want|up to you|your choice|if preferred|if needed)\b/.test(t)
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function splitKeywordAliases(raw: string, delimiters = ''): string[] {
  const extra = String(delimiters ?? '').replace(/\s+/g, '')
  const chars = [',', ';', '\n', '|', ...extra.split('')].filter(Boolean).map(c => escapeRegExp(c))
  const splitter = new RegExp(`[${chars.join('')}]+`)
  return String(raw ?? '')
    .split(splitter)
    .map(x => x.trim())
    .filter(Boolean)
}

function keywordRegex(phrase: string): RegExp {
  const p = escapeRegExp(phrase.trim()).replace(/\s+/g, '\\s+')
  return new RegExp(`(?<![\\p{L}\\p{N}])${p}(?![\\p{L}\\p{N}])`, 'iu')
}

function hasAnyKeyword(text: string, words: string[]): boolean {
  return words.some(w => w && keywordRegex(w).test(text))
}

function managementAliasesFromKeywords(keywords: ChannelKeywords | null | undefined): string[] {
  if (!keywords) return []
  const delim = keywords.additional.delimiters
  return Array.from(new Set([
    ...splitKeywordAliases(keywords.update.break_even, delim),
    ...splitKeywordAliases(keywords.update.close_full, delim),
    ...splitKeywordAliases(keywords.update.close_half, delim),
    ...splitKeywordAliases(keywords.update.close_partial, delim),
    ...splitKeywordAliases(keywords.update.close_tp1, delim),
    ...splitKeywordAliases(keywords.update.close_tp2, delim),
    ...splitKeywordAliases(keywords.update.close_tp3, delim),
    ...splitKeywordAliases(keywords.update.close_tp4, delim),
    ...splitKeywordAliases(keywords.update.set_sl, delim),
    ...splitKeywordAliases(keywords.update.adjust_sl, delim),
    ...splitKeywordAliases(keywords.update.set_tp, delim),
    ...splitKeywordAliases(keywords.update.adjust_tp, delim),
    ...splitKeywordAliases(keywords.additional.close_all, delim),
    ...splitKeywordAliases(keywords.update.delete, delim),
    ...splitKeywordAliases(keywords.additional.delete_all, delim),
  ].map(a => a.trim()).filter(Boolean)))
}

/** True when text looks like a trade-management instruction (not a fresh entry). */
export function looksLikeChannelManagementUpdate(
  text: string,
  channelKeywords?: ChannelKeywords | null,
  lexicon?: ChannelLexiconRow | null,
): boolean {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!t) return false
  if (looksLikeStructuredEntrySignal(t)) return false

  const trained = trainedManagementAliases(channelKeywords, lexicon)
  if (trained.length > 0 && hasAnyKeyword(t, trained)) return true

  // Breakeven cues ("sl to entry", "sl to be", "be now", …) are universal and
  // safe — recognize them even when the channel has trained management config,
  // otherwise "SL to Entry" is misrouted to the AI entry parser.
  if (COMMON_BREAKEVEN_PHRASES.some(p => messageContainsKeyword(t, p))) return true

  if (looksLikeDeletePendingsCommand(t, { channelKeywords })) return true

  if (!channelHasTrainedManagement(channelKeywords, lexicon)) {
    if (textLooksLikeMultilingualManagement(t)) return true
  }

  return (
    /\b(move\s+stop|move\s+sl|move\s+risk|stop\s+to\s+breakeven|breakeven|break\s*even)\b/i.test(t)
    || /\b(?:sl|stop\s*loss|stoploss|risk|stop)\s+to\s+(?:be|entry|breakeven|break\s*even)\b/i.test(t)
    || /\b(?:adjust|move|set|change|update|make|bring)\s+(?:sl|stop\s*loss|stoploss|risk)\b/i.test(t)
    || /\b(?:sl|stop\s*loss|stoploss|risk)\s+to\s+\d/i.test(t)
    // TP modifications: "take profit of 30 pips", "add a take profit", "30 pips take profit to gold sell",
    // "set tp to 2660". Structured entries are excluded by the early looksLikeStructuredEntrySignal check,
    // and bare "TP 4256" (entry-level TP) requires a preposition so it stays an entry.
    || /\b(?:adjust|move|set|change|update|make|bring|add)\s+(?:a\s+)?(?:take\s+profit|tp|target)\b/i.test(t)
    || /\b(?:take\s+profit|tp|target)\s+(?:of|to|at)\s*\d/i.test(t)
    || /\b\d{1,3}(?:\.\d+)?\s*(?:pips?|points?)\s+(?:take\s+profit|tp|profit|target)\b/i.test(t)
    || /\b(?:close\s+partial|closing\s+partial|take\s+partial|partial\s+(?:lot|lots|lotsize|position|trade))\b/i.test(t)
    || /\bsecure\s+\d+\s*%\s*profit/i.test(t)
    || /\btake\s+profit\s+(?:target\s+)?(?:is\s+)?hit\b/i.test(t)
    || /\bclose\s+(?:half|50%|25%|partials?)\b/i.test(t)
    || /\b\d{1,3}\s*%\s*(?:of\s+)?(?:the\s+)?(?:positions?|trades?|lots?|profits?)\b/i.test(t)
  )
}

/** Percent partial close when message says e.g. "secure 30% profits". */
export function partialCloseFractionFromMessage(text: string): number | null {
  const m = String(text ?? '').match(
    /\b(?:secure|close|take)\s+(\d{1,2}|100)\s*%\s*(?:of\s+)?(?:the\s+)?(?:positions?|trades?|lots?|profits?)?/i,
  )
  if (m?.[1]) {
    const n = Number(m[1])
    if (Number.isFinite(n) && n > 0 && n <= 100) return n / 100
  }
  const pctOnly = String(text ?? '').match(
    /\b(\d{1,2}|100)\s*%\s*(?:of\s+)?(?:the\s+)?(?:positions?|trades?|lots?|profits?)\b/i,
  )
  if (pctOnly?.[1]) {
    const n = Number(pctOnly[1])
    if (Number.isFinite(n) && n > 0 && n <= 100) return n / 100
  }
  return null
}

/** Bare prices used only as pip counts (+30 pips) are not entry/SL/TP parameters. */
export function isPipCountInMessage(message: string, price: number): boolean {
  const s = String(price)
  return new RegExp(`(?:\\+|\\b)${s}\\s*pips?\\b`, 'i').test(String(message ?? ''))
}

export function bareTradePricesExcludingPips(message: string, prices: number[]): number[] {
  return prices.filter(p => !isPipCountInMessage(message, p))
}
