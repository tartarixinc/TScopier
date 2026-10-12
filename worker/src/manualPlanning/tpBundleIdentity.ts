/**
 * Identity-preserving TP assignment for bundled multi baskets.
 *
 * A bundled basket opens one leg per take-profit level. Downstream paths that
 * re-derive TPs from Targets % counts (buildDistributedPerLegTakeProfits and
 * friends) would repaint such a basket wrongly — e.g. 3 legs over 50/30/20
 * re-derives as [TP1, TP1, TP2], dropping TP3. When TP bundling is enabled,
 * these helpers keep each leg on its own level instead.
 *
 * Rules (docs/bundled-single-tp-trade-style.md, D3):
 * - Steady state: a leg that already carries a TP keeps it; a naked leg is
 *   backfilled positionally from the ladder (leg i ↔ ladder level i).
 * - Explicit reladder: re-map levels 1:1 by current TP order (buy ascending,
 *   sell descending); surplus legs beyond the ladder keep their own TP.
 */

import { isTpBundleEnabled } from './tpBundleRollout'

/** One leg's current take-profit (0 / null / undefined when naked). */
export type BundleLegTp = number | null | undefined

/** Minimal manual-settings view the bundle gate needs. */
export type BundleManualLike = {
  trade_style?: string | null
  range_trading?: boolean | null
} | null | undefined

/**
 * True when this basket is a bundled (or bundle-eligible) multi basket:
 * TP_BUNDLE_ENABLED, the account is multi style, and range/layering is off
 * (the flag is ignored for range trading — see the design doc non-goals).
 */
export function isBundleBasket(manual: unknown): boolean {
  if (!isTpBundleEnabled()) return false
  const m = (manual ?? {}) as { trade_style?: string | null; range_trading?: boolean | null }
  if (m.trade_style !== 'multi') return false
  if (m.range_trading === true) return false
  return true
}

/**
 * Reladder map for bundled baskets: leg id → new TP, assigned 1:1 by current
 * TP order (buy ascending, sell descending). Drop-in replacement for the
 * count-weighted buildEntryQualityTakeProfitMap when the bundle flag is on.
 */
export function bundleTpOrderMap(args: {
  legs: ReadonlyArray<{ id: string; tp: BundleLegTp }>
  ladder: readonly number[]
  isBuy: boolean
}): Map<string, number> {
  const tps = remapBundleLegTpsByTpOrder({
    legs: args.legs.map(l => l.tp),
    ladder: args.ladder,
    isBuy: args.isBuy,
  })
  const out = new Map<string, number>()
  args.legs.forEach((leg, i) => {
    const tp = tps[i]
    if (typeof tp === 'number' && tp > 0) out.set(leg.id, tp)
  })
  return out
}

/**
 * Steady-state TPs, one per leg: own TP when it has one, otherwise the
 * positional ladder level (leg i ↔ ladder[i]), falling back to the deepest
 * level when the ladder is shorter than the leg list.
 */
export function bundleSteadyLegTps(args: {
  currentTps: readonly BundleLegTp[]
  ladder: readonly number[]
}): number[] {
  const ladder = args.ladder.filter(t => typeof t === 'number' && Number.isFinite(t) && t > 0)
  const deepest = ladder[ladder.length - 1] ?? 0
  return args.currentTps.map((tp, i) => {
    const own = Number(tp)
    if (Number.isFinite(own) && own > 0) return own
    return ladder[i] ?? deepest
  })
}

/**
 * Explicit reladder: sort legs by current TP in trade direction (buy: nearest
 * = lowest price first; sell: nearest = highest price first) and assign the
 * new ladder's levels 1:1 in that order. Naked legs sort as deepest (farthest
 * from entry). Legs beyond the ladder keep their own TP.
 * Returns one TP per leg in the original input order.
 */
export function remapBundleLegTpsByTpOrder(args: {
  legs: readonly BundleLegTp[]
  ladder: readonly number[]
  isBuy: boolean
}): number[] {
  const ladder = args.ladder.filter(t => typeof t === 'number' && Number.isFinite(t) && t > 0)
  const n = args.legs.length
  if (n === 0) return []

  const own = args.legs.map(tp => Number(tp))
  const valid = own.map(v => Number.isFinite(v) && v > 0)
  if (!ladder.length) return own.map(v => (Number.isFinite(v) && v > 0 ? v : 0))

  const order = [...Array(n).keys()].sort((a, b) => {
    const at = valid[a] ? own[a]! : (args.isBuy ? Infinity : -Infinity)
    const bt = valid[b] ? own[b]! : (args.isBuy ? Infinity : -Infinity)
    return args.isBuy ? at - bt : bt - at
  })

  const out = new Array<number>(n).fill(0)
  for (let k = 0; k < order.length; k++) {
    const legIdx = order[k]!
    if (k < ladder.length) {
      out[legIdx] = ladder[k]!
    } else {
      out[legIdx] = valid[legIdx] ? own[legIdx]! : (ladder[ladder.length - 1]!)
    }
  }
  return out
}

/**
 * Steady-state target rows (SL preserved from the computed targets) with
 * bundled TPs: own TP when present, positional ladder backfill when naked.
 */
export function bundleSteadyTargetRows<T extends { stoploss: number }>(args: {
  rows: readonly T[]
  currentTps: readonly BundleLegTp[]
  ladder: readonly number[]
}): Array<T & { takeprofit: number }> {
  const tps = bundleSteadyLegTps({ currentTps: args.currentTps, ladder: args.ladder })
  return args.rows.map((row, i) => ({ ...row, takeprofit: tps[i] ?? 0 }))
}
