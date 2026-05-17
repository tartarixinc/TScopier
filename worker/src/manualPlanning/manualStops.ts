import { pipCalculator, type PipQuote } from '../pipCalculator'
import type { ChannelKeywords, ManualSettings, ParsedSignal, PlannerContext } from './types'

/** True when manual settings request pip-based SL and/or TP overrides. */
export function usesPredefinedStops(manual: ManualSettings): boolean {
  return manual.use_predefined_sl_pips === true || manual.use_predefined_tp_pips === true
}

/**
 * Reverse Signal only applies when predefined SL **and** TP are enabled with
 * valid values and an entry anchor exists — so mirrored risk comes from your
 * settings, not channel stops (which would be on the wrong side after flip).
 */
export function reverseSignalGateSatisfied(manual: ManualSettings, entryAnchor: number | null): boolean {
  if (entryAnchor == null) return false
  if (manual.use_predefined_sl_pips !== true || manual.use_predefined_tp_pips !== true) return false
  const slPips = Number(manual.predefined_sl_pips)
  if (!Number.isFinite(slPips) || slPips <= 0) return false
  const tps = (manual.predefined_tp_pips ?? []).map(Number).filter(n => Number.isFinite(n) && n > 0)
  return tps.length > 0
}

export interface DerivedManualStops {
  pipQuote: PipQuote
  pip: number
  finalSl: number | null
  finalTps: number[]
  minStopDist: number
  roundPrice: (v: number | null | undefined) => number
}

export function deriveManualStopsWithClamp(args: {
  parsed: ParsedSignal
  manual: ManualSettings
  channelKeywords: ChannelKeywords | null
  resolvedSymbol: string
  ctx: PlannerContext
  entryAnchor: number | null
  isBuy: boolean
}): DerivedManualStops {
  const { parsed, manual, channelKeywords, resolvedSymbol, ctx, entryAnchor, isBuy } = args

  const pipQuote = pipCalculator(resolvedSymbol, ctx.point, ctx.digits, ctx.contractSize ?? null)
  const pip = pipQuote.pipPrice
  const slInPips = channelKeywords?.additional?.sl_in_pips === true
  const tpInPips = channelKeywords?.additional?.tp_in_pips === true

  const usePreSl = manual.use_predefined_sl_pips === true
  const usePreTp = manual.use_predefined_tp_pips === true

  let parsedSl: number | null = usePreSl ? null : (parsed.sl ?? null)
  let parsedTps: number[] = usePreTp
    ? []
    : (parsed.tp ?? []).filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
  if (!usePreSl && slInPips && parsedSl != null && entryAnchor != null) {
    parsedSl = isBuy ? entryAnchor - parsedSl * pip : entryAnchor + parsedSl * pip
  }
  if (!usePreTp && tpInPips && parsedTps.length && entryAnchor != null) {
    parsedTps = parsedTps.map(t => (isBuy ? entryAnchor + t * pip : entryAnchor - t * pip))
  }

  let finalSl = parsedSl
  let finalTps = parsedTps
  if (usePreSl && Number.isFinite(manual.predefined_sl_pips ?? NaN) && entryAnchor != null) {
    const sl_pips = Number(manual.predefined_sl_pips)
    finalSl = isBuy ? entryAnchor - sl_pips * pip : entryAnchor + sl_pips * pip
  }
  if (usePreTp && Array.isArray(manual.predefined_tp_pips) && entryAnchor != null) {
    const tps = manual.predefined_tp_pips
      .map(Number)
      .filter(n => Number.isFinite(n) && n > 0)
    if (tps.length) {
      finalTps = tps.map(t => (isBuy ? entryAnchor + t * pip : entryAnchor - t * pip))
    }
  }

  if (manual.rr_for_sl_enabled && Number.isFinite(manual.rr_for_sl ?? NaN) && entryAnchor != null && finalTps.length && finalSl == null) {
    const rr = Number(manual.rr_for_sl)
    if (rr > 0) {
      const tpDist = Math.abs(finalTps[0] - entryAnchor)
      const slDist = tpDist / rr
      finalSl = isBuy ? entryAnchor - slDist : entryAnchor + slDist
    }
  }
  if (manual.rr_for_tps_enabled && Array.isArray(manual.rr_for_tps) && entryAnchor != null && finalSl != null && finalTps.length === 0) {
    const slDist = Math.abs(entryAnchor - finalSl)
    finalTps = manual.rr_for_tps
      .map(Number)
      .filter(n => Number.isFinite(n) && n > 0)
      .map(rr => (isBuy ? entryAnchor + rr * slDist : entryAnchor - rr * slDist))
  }

  const roundPrice = (v: number | null | undefined): number => {
    if (v == null || !Number.isFinite(v)) return 0
    const d = Math.max(0, Math.min(8, Number.isFinite(ctx.digits) ? ctx.digits : 5))
    return Number(v.toFixed(d))
  }

  const stopsLevel = Number(ctx.stopsLevel ?? 0) || 0
  const freezeLevel = Number(ctx.freezeLevel ?? 0) || 0
  const safeLevel = Math.max(stopsLevel, freezeLevel)
  const minStopDist = safeLevel > 0 ? (safeLevel + 2) * ctx.point : 0
  const clampToStops = (price: number | null, isTp: boolean, ref: number | null): number | null => {
    if (price == null || !Number.isFinite(price) || ref == null || ref <= 0 || minStopDist <= 0) {
      return price
    }
    const wantAbove = isTp ? isBuy : !isBuy
    if (wantAbove) {
      const floorPrice = ref + minStopDist
      return price < floorPrice ? Number(floorPrice.toFixed(ctx.digits)) : price
    }
    const ceilPrice = ref - minStopDist
    return price > ceilPrice ? Number(ceilPrice.toFixed(ctx.digits)) : price
  }
  if (entryAnchor != null && minStopDist > 0) {
    finalSl = clampToStops(finalSl, false, entryAnchor)
    finalTps = finalTps.map(tp => clampToStops(tp, true, entryAnchor) ?? tp)
  }

  return { pipQuote, pip, finalSl, finalTps, minStopDist, roundPrice }
}
