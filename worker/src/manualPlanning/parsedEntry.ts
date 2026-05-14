import type { ParsedSignal } from './types'

function readPositiveNum(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n) || n <= 0) return null
  return n
}

/**
 * Best-effort entry price from `parsed_data` (handles string decimals and
 * occasional camelCase keys from non–parse-signal writers).
 */
export function resolvedParsedEntryPrice(parsed: ParsedSignal): number | null {
  const ext = parsed as unknown as Record<string, unknown>
  return (
    readPositiveNum(parsed.entry_price)
    ?? readPositiveNum(ext.entryPrice)
    ?? readPositiveNum(ext.entry_point)
  )
}

/** Entry zone low/high with the same coercion as {@link resolvedParsedEntryPrice}. */
export function resolvedParsedEntryZone(parsed: ParsedSignal): { lo: number; hi: number } | null {
  const ext = parsed as unknown as Record<string, unknown>
  const lo = readPositiveNum(parsed.entry_zone_low) ?? readPositiveNum(ext.entryZoneLow)
  const hi = readPositiveNum(parsed.entry_zone_high) ?? readPositiveNum(ext.entryZoneHigh)
  if (lo == null || hi == null) return null
  return { lo: Math.min(lo, hi), hi: Math.max(lo, hi) }
}

/**
 * True when the parsed signal includes an explicit entry **price** or **zone**
 * (not a bare market “buy now”). Used with strict signal entry so planning
 * only runs when the message specifies an entry anchor.
 */
export function parsedHasExplicitEntryAnchor(parsed: ParsedSignal): boolean {
  if (resolvedParsedEntryPrice(parsed) != null) return true
  const z = resolvedParsedEntryZone(parsed)
  return z != null && z.lo > 0 && z.hi > 0
}

/**
 * Rightmost positive TP from parsed signal data (TP3 when three levels are present).
 */
export function lastPositiveParsedTpPrice(parsed: { tp?: unknown } | null | undefined): number | null {
  const arr = parsed?.tp
  if (!Array.isArray(arr) || arr.length === 0) return null
  for (let i = arr.length - 1; i >= 0; i--) {
    const raw = arr[i]
    const n = typeof raw === 'number' ? raw : Number(raw)
    if (Number.isFinite(n) && n > 0) return n
  }
  return null
}

/** Planner / executor skip when strict signal entry is on but the parse has no entry anchor. */
export const SKIP_REASON_SIGNAL_ENTRY_REQUIRED = 'signal_entry_price_requires_explicit_entry' as const
