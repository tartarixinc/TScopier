import type { OrderSendArgs } from '../fxsocketClient'
import type { PlannerResult } from './types'
import type { PlanMultiManualOrdersArgs } from './planMultiManualOrders'
import { appendOrderCommentSuffix } from '../tradeComment'
import { normalizeAutoBeConfig, resolveAutoBeTpHitTriggerPrice } from '../autoManagement'
import { resolveTpBucketRows } from './tpBucketDistribution'

interface BundleBucket {
  tpIndex: number
  tp: number
  label: string
  rawLots: number
}

/**
 * Bundled multi plan: one immediate broker order per take-profit level, sized
 * by the Targets % rows (50/30/20 by default). Each leg carries its own
 * broker-side TP; no partial_tp_legs are emitted. Gated by TP_BUNDLE_ENABLED —
 * see docs/bundled-single-tp-trade-style.md (D2).
 */
export function planBundleManualOrders(args: PlanMultiManualOrdersArgs): PlannerResult {
  const {
    orderBase,
    expirationFields,
    strictEntry,
    manual,
    manualLot,
    ctx,
    delay_ms,
    entryAnchor,
    isBuy,
    pip,
    pipQuote,
    finalSl,
    finalTps,
    roundPrice,
    commentPrefix,
  } = args

  const minLot = Number.isFinite(ctx.minLot) && ctx.minLot > 0 ? ctx.minLot : 0.01
  const lotStep = Number.isFinite(ctx.lotStep) && ctx.lotStep > 0 ? ctx.lotStep : 0.01

  if (!(manualLot > 0) || manualLot < minLot) {
    return { orders: [], skip_reason: 'lot_below_symbol_min', delay_ms }
  }

  const ladder = finalTps.filter(t => typeof t === 'number' && Number.isFinite(t) && t > 0)

  const autoBeCfg = normalizeAutoBeConfig(manual)
  const autoBeTpHitTriggerPrice = ladder.length > 0 && autoBeCfg?.mode === 'tp_hit'
    ? resolveAutoBeTpHitTriggerPrice({
      tpIndex: autoBeCfg.tpIndex,
      finalTps: ladder,
      brokerTp: null,
    })
    : null

  const tail = {
    delay_ms,
    anchor: {
      source: entryAnchor != null ? ('signal' as const) : ('unknown' as const),
      value: entryAnchor,
    },
    pip,
    pipQuote,
    isBuy,
    ...(strictEntry ? { strictEntry } : {}),
    ...(autoBeTpHitTriggerPrice != null ? { autoBeTpHitTriggerPrice } : {}),
  }

  /**
   * Degenerate shape: a single full-lot order (no split, no partial schedule).
   * Used for open-TP signals and when fewer than two buckets survive, so the
   * bundled plan never leaks into the single-style partial schedule.
   */
  const directOrder = (takeprofit: number, fallbackReason: string, label?: string): PlannerResult => ({
    orders: [{
      ...orderBase,
      volume: manualLot,
      stoploss: roundPrice(finalSl),
      takeprofit: roundPrice(takeprofit),
      ...expirationFields,
      ...(label ? { comment: appendOrderCommentSuffix(commentPrefix, `:${label.toLowerCase()}`) } : {}),
    }],
    ...tail,
    fallback_reason: fallbackReason,
  })

  if (ladder.length === 0) {
    // Teaser / open-TP signal: one full-lot order, no broker TP.
    return directOrder(0, 'bundle_open_tp')
  }

  const { bucketRows } = resolveTpBucketRows(ladder, manual.tp_lots ?? null)
  const buckets: BundleBucket[] = []
  for (let i = 0; i < bucketRows.length; i++) {
    const row = bucketRows[i]!
    const tp = ladder[i]
    if (row.percent <= 0 || tp == null || !Number.isFinite(tp) || tp <= 0) continue
    buckets.push({ tpIndex: i, tp, label: row.label, rawLots: (manualLot * row.percent) / 100 })
  }

  // No enabled bucket (e.g. rows all disabled): degenerate single order at the
  // nearest level — nothing to split.
  if (buckets.length === 0) return directOrder(ladder[0]!, 'bundle_no_enabled_buckets')
  if (buckets.length === 1) {
    return directOrder(buckets[0]!.tp, `bundle_single_bucket_${buckets[0]!.label}`, buckets[0]!.label)
  }

  // Lot math in integer lot-step units. Distribution rule — floor, then
  // top-up, then deepest: floor every share to a legal step; lift any level
  // that fell below the broker minimum back up to the minimum using the
  // leftovers (nearest level first, so the deep levels are sacrificed first
  // when the pot cannot save everyone); give whatever is still unassigned to
  // the deepest surviving level. Prices are never touched — only lot
  // distribution — and the opened volume always equals the signal lot.
  const toUnits = (lots: number): number => Math.floor((lots / lotStep) + 1e-9)
  const totalUnits = toUnits(manualLot)
  // Ceil (not floor) so a minLot that is not a lotStep multiple still yields a
  // legal, ≥-minLot promotion target.
  const minUnits = Math.max(1, Math.ceil(minLot / lotStep - 1e-9))

  const planned = buckets.map(b => ({ ...b, units: Math.max(0, toUnits(b.rawLots)) }))
  // Over-100 guard over ALL floors (surviving and short alike): if the
  // configured Targets % oversubscribe the lot even after flooring, fall back
  // to a single full-lot order rather than splitting a broken config.
  let floorSumAll = 0
  for (const b of planned) floorSumAll += b.units
  if (totalUnits - floorSumAll < 0) return directOrder(ladder[0]!, 'bundle_targets_over_100')

  const short: typeof planned = []
  let openUnits = 0
  for (const b of planned) {
    if (b.units >= minUnits) openUnits += b.units
    else short.push(b)
  }
  // The rescue pot = unassigned percent (disabled rows, fewer TPs than rows)
  // + flooring leftovers + the floored shares of levels that cannot open yet.
  // The over-100 guard above guarantees pot ≥ 0 here.
  let pot = totalUnits - openUnits

  // Top-up pass: short levels are lifted to the minimum from the pot
  // (nearest first, so the deep levels are sacrificed first when the pot
  // cannot save everyone).
  for (const b of short) {
    if (pot >= minUnits) {
      b.units = minUnits
      pot -= minUnits
    }
  }

  // Surviving levels in ladder order (nearest → farthest): promoted levels
  // keep their ladder position, so the farthest level below is really the
  // deepest trade and the order list reads TP1, TP2, …
  const alive = planned.filter(b => b.units >= minUnits)

  if (alive.length === 0) {
    // The pot could not lift any level to the minimum: one full-lot order.
    return directOrder(ladder[0]!, 'bundle_all_buckets_below_min_lot')
  }
  if (alive.length === 1) {
    // A single surviving bucket takes the whole lot; no partial schedule.
    const only = alive[0]!
    return directOrder(only.tp, `bundle_single_bucket_${only.label}`, only.label)
  }

  // Whatever volume is still unassigned (floor leftovers of surviving levels,
  // shares of levels that stayed dead, unassigned percent) goes to the deepest
  // surviving level — the ladder lists levels nearest → farthest — so the
  // opened total always equals the signal lot.
  const farthest = alive[alive.length - 1]!
  farthest.units += pot

  const orders: OrderSendArgs[] = []
  for (const b of alive) {
    const units = b.units
    if (units < minUnits) continue
    const volume = Math.round(units * lotStep * 1e8) / 1e8
    if (!(volume > 0)) continue
    orders.push({
      ...orderBase,
      volume,
      stoploss: roundPrice(finalSl),
      takeprofit: roundPrice(b.tp),
      ...expirationFields,
      comment: appendOrderCommentSuffix(commentPrefix, `:${b.label.toLowerCase()}`),
    })
  }

  if (orders.length === 0) return directOrder(ladder[0]!, 'bundle_zero_orders')
  if (orders.length === 1) return directOrder(ladder[0]!, 'bundle_single_surviving_leg')

  return { orders, ...tail }
}
