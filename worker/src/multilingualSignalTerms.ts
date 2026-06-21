/**
 * Common non-English trading terms merged into parser + ingest heuristics.
 * Per-channel AI training can override/extend via channel_keywords.
 *
 * Locales align with src/i18n/types.ts (en, es, fr, pl, ru, sv, nl, ja)
 * plus common channel languages (de, ar, pt, it).
 */

/** Strip accents so IMMÉDIAT matches immediat aliases. */
export function foldAccents(text: string): string {
  return String(text ?? '').normalize('NFD').replace(/\p{M}/gu, '')
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** "Now / immediate / at market" cues grouped by locale. */
export const SUPPORTED_MARKET_NOW_BY_LOCALE = {
  en: ['now', 'instant', 'immediately', 'immediate', 'right now', 'at market', 'market order', 'mkt'],
  fr: ['maintenant', 'immédiat', 'immediat', 'immédiate', 'immédiatement', 'tout de suite', 'au marché'],
  es: ['ahora', 'inmediato', 'inmediata', 'al mercado', 'a mercado'],
  pl: ['teraz', 'natychmiast', 'od razu', 'na rynku'],
  ru: ['сейчас', 'немедленно', 'по рынку'],
  sv: ['nu', 'omedelbart', 'direkt', 'på marknaden'],
  nl: ['nu', 'onmiddellijk', 'direct', 'aan de markt'],
  ja: ['今すぐ', '即時', '成行', 'ナウ'],
  de: ['jetzt', 'sofort', 'am markt'],
  ar: ['الآن', 'فوراً', 'فورا'],
  /** Often mixed with ES in signal channels */
  pt: ['agora', 'imediato', 'imediata', 'ao mercado'],
  it: ['ora', 'immediato', 'immediata', 'al mercato'],
} as const

export type SupportedMarketNowLocale = keyof typeof SUPPORTED_MARKET_NOW_BY_LOCALE

export const COMMON_MARKET_NOW_TERMS: readonly string[] = Object.freeze(
  Array.from(new Set(Object.values(SUPPORTED_MARKET_NOW_BY_LOCALE).flat())),
)

export const COMMON_BUY_TERMS = [
  'achat', 'acheter',           // fr
  'compra', 'comprar',          // es / pt
  'kupno', 'kupic', 'kupić',    // pl
  'kaufen',                     // de
  'köp',                        // sv
  'kopen',                      // nl
  'купить', 'покупка',          // ru
  '買い',                       // ja
  'شراء',                       // ar
]

export const COMMON_SELL_TERMS = [
  'vente', 'vendre',            // fr
  'venta', 'vender',            // es
  'sprzedaz', 'sprzedać',       // pl
  'verkaufen',                  // de
  'sälj',                       // sv
  'verkopen',                   // nl
  'продать', 'продажа',         // ru
  '売り',                       // ja
  'بيع',                        // ar
]

/** Direction words for ingest heuristic when channel is not yet trained. */
export const MULTILINGUAL_DIRECTION_RE = new RegExp(
  '\\b('
  + [
    'buy', 'sell', 'long', 'short',
    ...COMMON_BUY_TERMS,
    ...COMMON_SELL_TERMS,
  ].map(t => escapeRegExp(t)).join('|')
  + ')\\b',
  'iu',
)

const JA_MARKET_NOW_RE = /今すぐ|即時|成行|ナウ/u

const BUY_NOW_COMPOUND_RE = new RegExp(
  '\\b('
  + [
    'buy', 'long',
    ...COMMON_BUY_TERMS,
    'comprar', 'compra', 'acheter', 'achat',
  ].map(t => escapeRegExp(t)).join('|')
  + ')\\s+('
  + [
    'now', 'instant',
    ...COMMON_MARKET_NOW_TERMS.filter(t => t.length <= 12 && !t.includes(' ')),
  ].map(t => escapeRegExp(foldAccents(t))).join('|')
  + ')\\b',
  'iu',
)

const SELL_NOW_COMPOUND_RE = new RegExp(
  '\\b('
  + [
    'sell', 'short',
    ...COMMON_SELL_TERMS,
  ].map(t => escapeRegExp(t)).join('|')
  + ')\\s+('
  + [
    'now', 'instant',
    ...COMMON_MARKET_NOW_TERMS.filter(t => t.length <= 12 && !t.includes(' ')),
  ].map(t => escapeRegExp(foldAccents(t))).join('|')
  + ')\\b',
  'iu',
)

/** Accent- and case-insensitive keyword boundary match (Unicode-aware). */
export function messageContainsKeyword(text: string, phrase: string): boolean {
  const raw = String(text ?? '')
  const folded = foldAccents(raw)
  const foldedPhrase = foldAccents(String(phrase ?? '').trim())
  if (!foldedPhrase) return false
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}])${escapeRegExp(foldedPhrase).replace(/\\s+/g, '\\s+')}(?![\\p{L}\\p{N}])`,
    'iu',
  )
  return pattern.test(folded)
}

/** True when message contains any configured market-now / immediate-entry cue. */
export function textHasCommonMarketNowIntent(message: string): boolean {
  const raw = String(message ?? '')
  const folded = foldAccents(raw)

  for (const term of COMMON_MARKET_NOW_TERMS) {
    if (messageContainsKeyword(raw, term)) return true
  }

  if (JA_MARKET_NOW_RE.test(raw)) return true
  if (BUY_NOW_COMPOUND_RE.test(folded)) return true
  if (SELL_NOW_COMPOUND_RE.test(folded)) return true

  return false
}
