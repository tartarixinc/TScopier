/**
 * Shared market-now / multilingual signal terms (keep in sync with worker/src/multilingualSignalTerms.ts).
 */

export function foldAccents(text: string): string {
  return String(text ?? '').normalize('NFD').replace(/\p{M}/gu, '')
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

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
  pt: ['agora', 'imediato', 'imediata', 'ao mercado'],
  it: ['ora', 'immediato', 'immediata', 'al mercato'],
} as const

export const COMMON_MARKET_NOW_TERMS: readonly string[] = Object.freeze(
  Array.from(new Set(Object.values(SUPPORTED_MARKET_NOW_BY_LOCALE).flat())),
)

export const COMMON_BUY_TERMS = [
  'achat', 'acheter',
  'compra', 'comprar',
  'kupno', 'kupic', 'kupić',
  'kaufen',
  'köp',
  'kopen',
  'купить', 'покупка',
  '買い',
  'شراء',
]

export const COMMON_SELL_TERMS = [
  'vente', 'vendre',
  'venta', 'vender',
  'sprzedaz', 'sprzedać',
  'verkaufen',
  'sälj',
  'verkopen',
  'продать', 'продажа',
  '売り',
  'بيع',
]

const JA_MARKET_NOW_RE = /今すぐ|即時|成行|ナウ/u

const BUY_NOW_COMPOUND_RE = new RegExp(
  '\\b('
  + ['buy', 'long', ...COMMON_BUY_TERMS, 'comprar', 'compra', 'acheter', 'achat']
    .map(t => escapeRegExp(t)).join('|')
  + ')\\s+('
  + ['now', 'instant', ...COMMON_MARKET_NOW_TERMS.filter(t => t.length <= 12 && !t.includes(' '))]
    .map(t => escapeRegExp(foldAccents(t))).join('|')
  + ')\\b',
  'iu',
)

const SELL_NOW_COMPOUND_RE = new RegExp(
  '\\b('
  + ['sell', 'short', ...COMMON_SELL_TERMS].map(t => escapeRegExp(t)).join('|')
  + ')\\s+('
  + ['now', 'instant', ...COMMON_MARKET_NOW_TERMS.filter(t => t.length <= 12 && !t.includes(' '))]
    .map(t => escapeRegExp(foldAccents(t))).join('|')
  + ')\\b',
  'iu',
)

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
