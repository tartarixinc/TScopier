/**
 * Trading-signal ingest heuristic — shared by listener, diagnostics, and training backfill.
 * Channel-aware when keywords/lexicon are provided (multilingual channels).
 */
import type { ChannelKeywords, ChannelLexiconRow } from './parseSignal'
import { looksLikeCasualNonTradeMessage } from './signalCommentaryGuard'
import {
  looksLikeChannelManagementUpdate,
  looksLikeExplicitFullCloseCommand,
} from './signalManagementIntent'
import { MULTILINGUAL_DIRECTION_RE, textHasCommonMarketNowIntent } from './multilingualSignalTerms'
import { hasTradableInstrumentInText } from './tradableSymbol'
import { normalizeTelegramMessageText } from './normalizeTelegramMessageText'

export type SignalHeuristicContext = {
  keywords?: ChannelKeywords | null
  lexicon?: ChannelLexiconRow | null
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

/** Collect configured channel aliases used by the ingest gate. */
export function collectChannelSignalAliases(ctx?: SignalHeuristicContext | null): string[] {
  const keywords = ctx?.keywords
  const lexicon = ctx?.lexicon
  if (!keywords) return []

  const delim = keywords.additional.delimiters
  const actionAliases = lexicon?.action_aliases && typeof lexicon.action_aliases === 'object'
    ? lexicon.action_aliases as Record<string, string[]>
    : {}

  return Array.from(new Set([
    ...splitKeywordAliases(keywords.signal.buy, delim),
    ...splitKeywordAliases(keywords.signal.sell, delim),
    ...splitKeywordAliases(keywords.signal.sl, delim),
    ...splitKeywordAliases(keywords.signal.tp, delim),
    ...splitKeywordAliases(keywords.signal.entry_point, delim),
    ...splitKeywordAliases(keywords.signal.market_order, delim),
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
    ...(actionAliases.buy ?? []),
    ...(actionAliases.sell ?? []),
    ...(actionAliases.modify ?? []),
    ...(lexicon?.tp_aliases ?? []),
    ...(lexicon?.target_aliases ?? []),
  ].map(a => String(a).trim()).filter(Boolean)))
}

const ENGLISH_DIRECTION =
  /\b(buy|sell|long|short|tp|take profit|sl|stop loss|breakeven|be)\b/
const ENGLISH_PRICE_CTX =
  /\b(entry|zone|between|above|below|now)\b/
const ENGLISH_TRADE_STRUCTURE =
  /\b(tp\s*\d*|sl|entry|signal|setup)\b/
const ENGLISH_REPLY_MGMT =
  /\b(move|set|update|adjust|tp|sl|breakeven|be|close)\b/

function hasNumericPriceContext(normalized: string): boolean {
  return /\b\d{1,5}(?:\.\d{1,5})?\b/.test(normalized)
}

/** Relaxed gate for training backfill: instrument + price, no English keyword requirement. */
export function looksLikeTrainingCandidate(text: string): boolean {
  const raw = normalizeTelegramMessageText(text).trim()
  const normalized = raw.toLowerCase().replace(/\s+/g, ' ')
  if (!normalized || looksLikeCasualNonTradeMessage(normalized)) return false
  return hasTradableInstrumentInText(raw) && hasNumericPriceContext(normalized)
}

/**
 * Score-based gate for live ingest. When channel keywords/lexicon are present,
 * any configured alias counts as direction/action evidence.
 */
export function looksLikeTradingSignal(
  text: string,
  isReply: boolean,
  ctx?: SignalHeuristicContext | null,
): boolean {
  const normalized = normalizeTelegramMessageText(text)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()

  if (!normalized) return false
  if (looksLikeCasualNonTradeMessage(normalized)) return false

  const channelAliases = collectChannelSignalAliases(ctx)
  const hasChannelKeyword = channelAliases.length > 0 && hasAnyKeyword(text, channelAliases)

  const hasInstrument = hasTradableInstrumentInText(normalized)

  const hasDirectionOrAction =
    ENGLISH_DIRECTION.test(normalized)
    || MULTILINGUAL_DIRECTION_RE.test(text)
    || looksLikeExplicitFullCloseCommand(normalized, { channelKeywords: ctx?.keywords ?? null, lexicon: ctx?.lexicon ?? null })
    || hasChannelKeyword

  const hasPriceContext =
    hasNumericPriceContext(normalized)
    || ENGLISH_PRICE_CTX.test(normalized)
    || textHasCommonMarketNowIntent(text)

  const hasTradeStructure =
    ENGLISH_TRADE_STRUCTURE.test(normalized)
    || (channelAliases.length > 0 && hasChannelKeyword)

  if (isReply && (ENGLISH_REPLY_MGMT.test(normalized) || hasChannelKeyword)) {
    return true
  }

  if (looksLikeChannelManagementUpdate(normalized, ctx?.keywords ?? null, ctx?.lexicon ?? null)) return true

  // Language-neutral: tradable symbol + at least one price is enough for trained/untrained channels.
  if (hasInstrument && hasNumericPriceContext(normalized) && (hasChannelKeyword || hasDirectionOrAction)) {
    return true
  }

  const score =
    Number(hasDirectionOrAction)
    + Number(hasInstrument)
    + Number(hasPriceContext)
    + Number(hasTradeStructure)
  return score >= 2
}
