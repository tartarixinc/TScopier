import type { ManualSettings, ParsedSignal, PlannerRangeEntryWait } from './types'
import { resolvedParsedEntryPrice, resolvedParsedEntryZone } from './parsedEntry'
import { strictSignalEntryQuoteAllowsImmediate } from './executionShape'
import { signalEntryRangeStrictEnabled } from './manualSettings'

/** Far edge of the entry zone in the layering direction (buy → low, sell → high). */
export function signalRangeBoundary(parsed: ParsedSignal, isBuy: boolean): number | null {
  const z = resolvedParsedEntryZone(parsed)
  if (!z) return null
  return isBuy ? z.lo : z.hi
}

/** Entry zone span in pips (hi − lo). */
export function signalZoneWidthPips(parsed: ParsedSignal, pip: number): number | null {
  const z = resolvedParsedEntryZone(parsed)
  if (!z || !Number.isFinite(pip) || pip <= 0) return null
  const width = Math.abs(z.hi - z.lo)
  if (!Number.isFinite(width) || width <= 0) return null
  return width / pip
}

export type RangeDistanceSource = 'signal_zone' | 'manual'

export function resolveRangeDistancePips(args: {
  manual: ManualSettings
  parsed: ParsedSignal
  pip: number
  isBuy: boolean
}): { distPips: number; boundary: number | null; source: RangeDistanceSource } {
  const manualDist = Math.max(0, Number(args.manual.range_distance_pips ?? 0))
  if (args.manual.use_signal_entry_range !== true) {
    return { distPips: manualDist, boundary: null, source: 'manual' }
  }
  const widthPips = signalZoneWidthPips(args.parsed, args.pip)
  const boundary = signalRangeBoundary(args.parsed, args.isBuy)
  if (widthPips != null && widthPips > 0 && boundary != null) {
    return { distPips: widthPips, boundary, source: 'signal_zone' }
  }
  return { distPips: manualDist, boundary: null, source: 'manual' }
}

export function buildRangeEntryWait(args: {
  manual: ManualSettings
  parsed: ParsedSignal
  isBuy: boolean
}): PlannerRangeEntryWait | undefined {
  if (!signalEntryRangeStrictEnabled(args.manual)) return undefined
  const zone = resolvedParsedEntryZone(args.parsed)
  const entryPrice = resolvedParsedEntryPrice(args.parsed)
  return {
    isBuy: args.isBuy,
    entryPrice,
    zoneLo: zone?.lo ?? null,
    zoneHi: zone?.hi ?? null,
    tolerancePips: Math.max(0, Number(args.manual.signal_entry_pip_tolerance ?? 10)),
  }
}

/**
 * True when live quote is inside the signal entry band.
 * Zone: buy uses ask, sell uses bid, allowed when [zone_lo − tol, zone_hi + tol].
 * Point-only entry (no zone): buy ask ≤ entry + tol; sell bid ≥ entry − tol.
 */
export function signalRangeEntryQuoteAllowsImmediate(args: {
  wait: PlannerRangeEntryWait
  bid: number
  ask: number
  pipSize?: number
}): boolean {
  const { wait, bid, ask } = args
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return false
  const pip = Number(args.pipSize ?? 0)
  const tolPips = Math.max(0, Number(wait.tolerancePips ?? 0))
  const tolPx = tolPips > 0 && pip > 0 ? tolPips * pip : 0
  const zone = wait.zoneLo != null && wait.zoneHi != null
    ? { lo: Math.min(wait.zoneLo, wait.zoneHi), hi: Math.max(wait.zoneLo, wait.zoneHi) }
    : null
  if (zone) {
    const price = wait.isBuy ? ask : bid
    return price >= zone.lo - tolPx && price <= zone.hi + tolPx
  }
  const entryPrice = wait.entryPrice
  if (entryPrice == null || !Number.isFinite(entryPrice) || entryPrice <= 0) return false
  return strictSignalEntryQuoteAllowsImmediate({
    isBuy: wait.isBuy,
    entryPrice,
    bid,
    ask,
    tolerancePips: wait.tolerancePips,
    pipSize: pip,
  })
}

/** True when a virtual leg trigger price is still inside the signal entry zone. */
export function virtualLegTriggerAllowed(args: {
  trigger: number
  boundary: number | null
  isBuy: boolean
}): boolean {
  const { trigger, boundary, isBuy } = args
  if (boundary == null || !Number.isFinite(boundary)) return true
  if (!Number.isFinite(trigger)) return false
  return isBuy ? trigger >= boundary : trigger <= boundary
}
