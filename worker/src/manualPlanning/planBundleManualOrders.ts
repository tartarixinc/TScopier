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

  // Lot math in integer lot-step units: floor each bucket, hand every dropped
  // sub-min-lot bucket's share and the overall remainder to the farthest
  // (deepest) surviving bucket so no volume falls outside a broker TP.
  const toUnits = (lots: number): number => Math.floor((lots / lotStep) + 1e-9)
  const totalUnits = toUnits(manualLot)
  const minUnits = Math.max(1, toUnits(minLot))

  const planned = buckets.map(b => ({ ...b, units: Math.max(0, toUnits(b.rawLots)) }))
  const kept: typeof planned = []
  let rescuedUnits = 0
  for (const b of planned) {
    if (b.units > 0 && b.units >= minUnits) kept.push(b)
    else rescuedUnits += b.units
  }
  if (kept.length === 0) {
    // Everything floored below the broker minimum: one full-lot order.
    return directOrder(ladder[0]!, 'bundle_all_buckets_below_min_lot')
  }
  if (kept.length === 1) {
    // A single surviving bucket takes the whole lot; no partial schedule.
    return directOrder(kept[0]!.tp, `bundle_single_bucket_${kept[0]!.label}`, kept[0]!.label)
  }

  // Farthest bucket = last in signal ladder order (TP3 for a standard
  // TP1<TP2<TP3 ladder in either direction, since the ladder lists levels
  // nearest → farthest as parsed).
  const farthest = kept[kept.length - 1]!
  let floorSum = 0
  for (const b of kept) floorSum += b.units
  // `floorSum` excludes dropped buckets; `rescuedUnits` is their floored share,
  // already part of `totalUnits - floorSum`. Subtract it so the rescued share is
  // not counted twice, then hand any true flooring remainder to the farthest
  // bucket. A negative remainder means the configured Targets % sum to more than
  // 100 — fall back to a single full-lot order rather than oversizing a leg.
  const remainderUnits = totalUnits - floorSum - rescuedUnits
  if (remainderUnits < 0) return directOrder(ladder[0]!, 'bundle_targets_over_100')
  const farthestUnits = farthest.units + rescuedUnits + remainderUnits
  if (farthestUnits < minUnits) {
    return directOrder(farthest.tp, 'bundle_total_below_min_lot', farthest.label)
  }

  const orders: OrderSendArgs[] = []
  for (const b of kept) {
    const units = b === farthest ? farthestUnits : b.units
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
