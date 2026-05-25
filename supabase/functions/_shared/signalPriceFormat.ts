/**
 * Parse signal price tokens including US thousands commas (4,572.25).
 */

/** Regex capture group for prices like 4572.25 or 4,572.25 */
export const SIGNAL_PRICE_NUM = '(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?'

export function parseSignalPriceToken(raw: string | undefined | null): number | null {
  if (raw == null || String(raw).trim() === '') return null
  const n = Number(String(raw).replace(/,/g, ''))
  if (!Number.isFinite(n) || n <= 0) return null
  return n
}

export function parseSignalPriceListBlock(block: string): number[] {
  const out: number[] = []
  const seen = new Set<number>()
  for (const part of block.split(/\s*(?:\/|,|\band\b|\|)\s*/i)) {
    const v = parseSignalPriceToken(part.trim())
    if (v == null || seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out
}

export function signalPriceTokenRegex(flags = 'g'): RegExp {
  return new RegExp(SIGNAL_PRICE_NUM, flags)
}
