import { pipCalculator, type PipQuote } from '../pipCalculator'
import {
  convertPipOffsetToPrice,
  convertPipOffsetsToPrices,
  resolvePipSize,
} from '../signalStopUnits'
import type { ChannelKeywords, ManualSettings, ParsedSignal, PlannerContext } from './types'

/** True when manual settings request pip-based SL and/or TP overrides. */
export function usesPredefinedStops(manual: ManualSettings): boolean {
  return manual.use_predefined_sl_pips === true || manual.use_predefined_tp_pips === true
}

/** Positive override SL pip distance, or null when Override signal SL is off. */
export function resolvePredefinedSlPips(
  manual: Pick<ManualSettings, 'use_predefined_sl_pips' | 'predefined_sl_pips'>,
): number | null {
  if (manual.use_predefined_sl_pips !== true) return null
  const slPips = Number(manual.predefined_sl_pips)
  if (!Number.isFinite(slPips) || slPips <= 0) return null
  return slPips
}

/** Positive override TP pip distances, or null when Override signal TPs is off. */
export function resolvePredefinedTpPips(
  manual: Pick<ManualSettings, 'use_predefined_tp_pips' | 'predefined_tp_pips'>,
): number[] | null {
  if (manual.use_predefined_tp_pips !== true) return null
  const tps = (manual.predefined_tp_pips ?? []).map(Number).filter(n => Number.isFinite(n) && n > 0)
  return tps.length > 0 ? tps : null
}

/** Absolute SL price: buy below entry, sell above entry, by `slPips * pip`. */
export function predefinedSlPriceFromEntry(args: {
  entry: number
  isBuy: boolean
  pip: number
  slPips: number
  digits?: number
}): number | null {
  const { entry, isBuy, pip, slPips } = args
  if (!Number.isFinite(entry) || entry <= 0) return null
  if (!Number.isFinite(pip) || pip <= 0) return null
  if (!Number.isFinite(slPips) || slPips <= 0) return null
  const raw = isBuy ? entry - slPips * pip : entry + slPips * pip
  if (!Number.isFinite(raw) || raw <= 0) return null
  if (args.digits != null && Number.isFinite(args.digits)) {
    const d = Math.max(0, Math.min(8, Math.floor(args.digits)))
    return Number(raw.toFixed(d))
  }
  return raw
}

/** Absolute TP price: buy above entry, sell below entry, by `tpPips * pip`. */
export function predefinedTpPriceFromEntry(args: {
  entry: number
  isBuy: boolean
  pip: number
  tpPips: number
  digits?: number
}): number | null {
  const { entry, isBuy, pip, tpPips } = args
  if (!Number.isFinite(entry) || entry <= 0) return null
  if (!Number.isFinite(pip) || pip <= 0) return null
  if (!Number.isFinite(tpPips) || tpPips <= 0) return null
  const raw = isBuy ? entry + tpPips * pip : entry - tpPips * pip
  if (!Number.isFinite(raw) || raw <= 0) return null
  if (args.digits != null && Number.isFinite(args.digits)) {
    const d = Math.max(0, Math.min(8, Math.floor(args.digits)))
    return Number(raw.toFixed(d))
  }
  return raw
}

export function predefinedTpPricesFromEntry(args: {
  entry: number
  isBuy: boolean
  pip: number
  tpPips: number[]
  digits?: number
}): number[] {
  return args.tpPips
    .map(tpPips => predefinedTpPriceFromEntry({ ...args, tpPips }))
    .filter((n): n is number => n != null)
}

/** Ladder index whose override TP at `entry` is closest to `existingTp`. */
export function matchPredefinedTpPipsIndex(args: {
  existingTp: number | null | undefined
  entry: number
  isBuy: boolean
  pip: number
  tpPips: number[]
}): number {
  const { tpPips } = args
  if (tpPips.length <= 1) return 0
  const existing = Number(args.existingTp)
  if (!Number.isFinite(existing) || existing <= 0) return 0
  let best = 0
  let bestDist = Infinity
  for (let i = 0; i < tpPips.length; i++) {
    const price = predefinedTpPriceFromEntry({
      entry: args.entry,
      isBuy: args.isBuy,
      pip: args.pip,
      tpPips: tpPips[i]!,
    })
    if (price == null) continue
    const d = Math.abs(price - existing)
    if (d < bestDist) {
      bestDist = d
      best = i
    }
  }
  return best
}

function pipSizeForPredefinedStops(args: {
  symbol: string
  point?: number
  digits?: number
  contractSize?: number | null
}): number {
  const pipQuote = pipCalculator(
    args.symbol,
    args.point ?? 0.00001,
    args.digits ?? 5,
    args.contractSize ?? null,
  )
  return resolvePipSize({ symbol: args.symbol, brokerPipPrice: pipQuote.pipPrice })
}

/**
 * Override signal SL from an entry/trigger price. Layered multi/range baskets
 * freeze absolute SL from the first entry; later fills must not recompute this.
 */
export function resolvePredefinedSlForEntry(args: {
  manual: Pick<ManualSettings, 'use_predefined_sl_pips' | 'predefined_sl_pips'>
  entry: number
  isBuy: boolean
  symbol: string
  point?: number
  digits?: number
  contractSize?: number | null
}): number | null {
  const slPips = resolvePredefinedSlPips(args.manual)
  if (slPips == null) return null
  const pip = pipSizeForPredefinedStops(args)
  return predefinedSlPriceFromEntry({
    entry: args.entry,
    isBuy: args.isBuy,
    pip,
    slPips,
    digits: args.digits,
  })
}

/**
 * Override signal TP from this fill/trigger. `matchEntry` + `existingTp` pick the
 * Targets % bucket (TP1/TP2/…) from the planned ladder, then apply that same
 * pip distance onto `entry`. Layered multi/range baskets freeze absolute stops
 * from the first entry instead — callers must not restamp later fills.
 */
export function resolvePredefinedTpForEntry(args: {
  manual: Pick<ManualSettings, 'use_predefined_tp_pips' | 'predefined_tp_pips'>
  entry: number
  isBuy: boolean
  symbol: string
  point?: number
  digits?: number
  contractSize?: number | null
  existingTp?: number | null
  matchEntry?: number | null
}): number | null {
  const tpPips = resolvePredefinedTpPips(args.manual)
  if (tpPips == null) return null
  const pip = pipSizeForPredefinedStops(args)
  const matchAt = args.matchEntry != null && args.matchEntry > 0 ? args.matchEntry : args.entry
  const idx = matchPredefinedTpPipsIndex({
    existingTp: args.existingTp,
    entry: matchAt,
    isBuy: args.isBuy,
    pip,
    tpPips,
  })
  return predefinedTpPriceFromEntry({
    entry: args.entry,
    isBuy: args.isBuy,
    pip,
    tpPips: tpPips[idx] ?? tpPips[0]!,
    digits: args.digits,
  })
}

/**
 * Reverse Signal flips buy/sell whenever the setting is on. Predefined SL/TP
 * (when enabled) are rebuilt on the reversed side from entry or live quote.
 * Absolute signal SL/TP prices are mirrored around that anchor so they stay
 * on the correct side after the flip.
 */
export function reverseSignalGateSatisfied(
  manual: ManualSettings,
  _entryAnchor?: number | null,
): boolean {
  return resolvePredefinedSlPips(manual) != null && resolvePredefinedTpPips(manual) != null
}

/** Reflect an absolute price through `entry` (buy SL below → sell SL above). */
export function mirrorPriceAroundEntry(price: number, entry: number): number {
  return 2 * entry - price
}

/** Mirror absolute (price-unit) SL/TP around entry after a reverse flip. Pip offsets stay as-is. */
export function mirrorParsedAbsoluteStopsForReverse(
  parsed: ParsedSignal,
  entry: number | null,
  channelKeywords: ChannelKeywords | null,
): ParsedSignal {
  if (entry == null || !Number.isFinite(entry) || entry <= 0) return parsed
  const slInPips =
    parsed.sl_unit === 'pips' || channelKeywords?.additional?.sl_in_pips === true
  const tpInPips =
    parsed.tp_unit === 'pips' || channelKeywords?.additional?.tp_in_pips === true
  const sl =
    !slInPips && parsed.sl != null && Number.isFinite(parsed.sl) && parsed.sl > 0
      ? mirrorPriceAroundEntry(parsed.sl, entry)
      : parsed.sl
  const tp = !tpInPips && Array.isArray(parsed.tp)
    ? parsed.tp.map(t => (
      typeof t === 'number' && Number.isFinite(t) && t > 0
        ? mirrorPriceAroundEntry(t, entry)
        : t
    ))
    : parsed.tp
  return { ...parsed, sl, tp }
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
  const pip = resolvePipSize({ symbol: resolvedSymbol, brokerPipPrice: pipQuote.pipPrice })
  const slInPips =
    parsed.sl_unit === 'pips' || channelKeywords?.additional?.sl_in_pips === true
  const tpInPips =
    parsed.tp_unit === 'pips' || channelKeywords?.additional?.tp_in_pips === true

  const usePreSl = manual.use_predefined_sl_pips === true
  const usePreTp = manual.use_predefined_tp_pips === true

  let parsedSl: number | null = usePreSl ? null : (parsed.sl ?? null)
  let parsedTps: number[] = usePreTp
    ? []
    : (parsed.tp ?? []).filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
  if (!usePreSl && slInPips && parsedSl != null && entryAnchor != null) {
    parsedSl = convertPipOffsetToPrice({
      offset: parsedSl,
      entryAnchor,
      isBuy,
      pipSize: pip,
    })
  }
  if (!usePreTp && tpInPips && parsedTps.length && entryAnchor != null) {
    parsedTps = convertPipOffsetsToPrices({
      offsets: parsedTps,
      entryAnchor,
      isBuy,
      pipSize: pip,
    })
  }

  let finalSl = parsedSl
  let finalTps = parsedTps
  const slPips = resolvePredefinedSlPips(manual)
  if (slPips != null && entryAnchor != null) {
    finalSl = predefinedSlPriceFromEntry({ entry: entryAnchor, isBuy, pip, slPips })
  }
  const tpPips = resolvePredefinedTpPips(manual)
  if (tpPips != null && entryAnchor != null) {
    const prices = predefinedTpPricesFromEntry({ entry: entryAnchor, isBuy, pip, tpPips })
    if (prices.length) finalTps = prices
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
