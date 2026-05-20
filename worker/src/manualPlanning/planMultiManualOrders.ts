import type { OrderSendArgs } from '../metatraderapi'
import type { PipQuote } from '../pipCalculator'
import type {
  ManualSettings,
  PlannerCloseWorseEntries,
  PlannerContext,
  PlannerResult,
  PlannerStrictEntry,
  VirtualPendingLeg,
} from './types'
import { clampPendingExpiryHours } from './manualSettings'
import type { PlanSingleManualOrdersArgs } from './planSingleManualOrders'
import { planRangeSplit } from './rangeSplit'
import { buildDistributedPerLegTakeProfits } from './tpBucketDistribution'

export interface PlanMultiManualOrdersArgs {
  orderBase: Omit<OrderSendArgs, 'volume' | 'stoploss' | 'takeprofit' | 'expiration' | 'expirationType'>
  expirationFields: { expiration?: string; expirationType?: OrderSendArgs['expirationType'] }
  strictEntry: PlannerStrictEntry | undefined
  manual: ManualSettings
  manualLot: number
  ctx: PlannerContext
  commentPrefix: string
  expertId?: number
  slippage?: number
  finalSl: number | null
  finalTps: number[]
  entryAnchor: number | null
  isBuy: boolean
  pip: number
  pipQuote: PipQuote
  delay_ms: number
  roundPrice: (v: number | null | undefined) => number
  minStopDist: number
  buildSingleOrder: (args: PlanSingleManualOrdersArgs) => PlannerResult
}

export function planMultiManualOrders(args: PlanMultiManualOrdersArgs): PlannerResult {
  const {
    orderBase,
    expirationFields,
    strictEntry,
    manual,
    manualLot,
    ctx,
    commentPrefix,
    expertId,
    slippage,
    finalSl,
    finalTps,
    entryAnchor,
    isBuy,
    pip,
    pipQuote,
    delay_ms,
    roundPrice,
    minStopDist,
    buildSingleOrder,
  } = args

  const minLot = Number.isFinite(ctx.minLot) && ctx.minLot > 0 ? ctx.minLot : 0.01
  const lotStep = Number.isFinite(ctx.lotStep) && ctx.lotStep > 0 ? ctx.lotStep : 0.01
  const FP_EPS = 1e-9
  const toUnits = (v: number): number => {
    if (!Number.isFinite(v) || v <= 0) return 0
    return Math.max(0, Math.floor(v / lotStep + FP_EPS))
  }
  const unitsToLot = (u: number): number => Number((u * lotStep).toFixed(8))

  const legPct = Math.max(0.1, Math.min(100, Number(manual.multi_trade_leg_percent ?? 5)))
  const ABS_MAX_LEGS = 500

  const manualUnits = toUnits(manualLot)
  const targetUnits = toUnits(manualLot * (legPct / 100))
  const minUnits = Math.max(1, Math.round(minLot / lotStep))

  if (targetUnits < minUnits) {
    return buildSingleOrder({
      orderBase,
      expirationFields,
      strictEntry,
      manualLot,
      finalSl,
      finalTps,
      manual,
      ctx,
      delay_ms,
      entryAnchor,
      isBuy,
      pip,
      pipQuote,
      roundPrice,
      fallbackReason: 'multi_trade_fallback_min_lot',
    })
  }
  if (manualUnits < minUnits) {
    return { orders: [], skip_reason: 'lot_below_symbol_min', delay_ms }
  }

  const totalLegs = Math.max(1, Math.min(ABS_MAX_LEGS, Math.floor(manualUnits / targetUnits)))
  const targetLeg = unitsToLot(targetUnits)

  // Use the *effective* immediate op (market vs broker pending), not `opSplit`.
  // Signals with an entry used to map to BuyLimit for SL/TP geometry, but we
  // execute immediates as Buy/Sell at price 0 — virtual range legs are not
  // broker pendings on that path, so range layering must stay enabled.
  const baseIsPendingSignal =
    orderBase.operation.includes('Limit') || orderBase.operation.includes('Stop')
  const split = planRangeSplit({
    totalLegs,
    baseIsPendingSignal,
    rangeOn: manual.range_trading === true,
    rangePct: Math.max(0, Math.min(100, Number(manual.range_percent ?? 0))),
    stepPips: Math.max(0, Number(manual.range_step_pips ?? 0)),
    distPips: Math.max(0, Number(manual.range_distance_pips ?? 0)),
    pip,
    minStepPriceUnits: minStopDist,
    hasSignalAnchor: entryAnchor != null,
  })
  const immediateLegs = split.immediateLegs
  const effectiveRangeLegs = split.pendingLegs
  const stepPriceOffset = split.stepPriceOffset
  const rangeFallbackReason = split.fallbackReason

  const totalLegsForTp = immediateLegs + effectiveRangeLegs
  const immediateTpPrices = buildDistributedPerLegTakeProfits({
    openLegCount: immediateLegs,
    finalTps,
    tpLots: manual.tp_lots,
  })
  const rangeTpPrices = buildDistributedPerLegTakeProfits({
    openLegCount: effectiveRangeLegs,
    finalTps,
    tpLots: manual.tp_lots,
  })
  const tpForImmediateIndex = (idx: number): number | null => {
    if (finalTps.length === 0) return null
    const price = immediateTpPrices[idx]
    if (typeof price === 'number' && Number.isFinite(price) && price > 0) return price
    return finalTps[finalTps.length - 1] ?? null
  }
  const tpForRangeIndex = (idx: number): number | null => {
    if (finalTps.length === 0) return null
    const price = rangeTpPrices[idx]
    if (typeof price === 'number' && Number.isFinite(price) && price > 0) return price
    return finalTps[finalTps.length - 1] ?? null
  }

  const orders: OrderSendArgs[] = []
  for (let i = 0; i < immediateLegs; i++) {
    const tpPrice = tpForImmediateIndex(i)
    orders.push({
      ...orderBase,
      volume: targetLeg,
      stoploss: roundPrice(finalSl),
      takeprofit: roundPrice(tpPrice),
      ...expirationFields,
      comment: `${commentPrefix}:tp${i + 1}`,
    })
  }

  const virtualPendings: VirtualPendingLeg[] = []
  if (effectiveRangeLegs > 0) {
    const pendHours = clampPendingExpiryHours(manual.pending_expiry_hours)
    const expiryHours = pendHours > 0 ? pendHours : undefined

    let stepIdx = 1
    for (let i = 0; i < effectiveRangeLegs; i++) {
      const tpPrice = tpForRangeIndex(i)
      virtualPendings.push({
        stepIdx,
        stepPriceOffset,
        isBuy,
        volume: targetLeg,
        stoploss: finalSl,
        takeprofit: tpPrice,
        slippage: slippage ?? 20,
        comment: `${commentPrefix}:rg${stepIdx}.tp`,
        expertID: expertId,
        expiryHours,
      })
      stepIdx += 1
    }
  }

  if (effectiveRangeLegs === 0) {
    const remainderUnits = manualUnits - totalLegs * targetUnits
    if (remainderUnits >= minUnits && orders.length < ABS_MAX_LEGS) {
      const tpPrice = tpForImmediateIndex(Math.max(0, immediateLegs - 1))
        ?? tpForImmediateIndex(0)
      orders.push({
        ...orderBase,
        volume: unitsToLot(remainderUnits),
        stoploss: roundPrice(finalSl),
        takeprofit: roundPrice(tpPrice),
        ...expirationFields,
        comment: `${commentPrefix}:tp.rem`,
      })
    }
  }

  let closeWorseEntries: PlannerCloseWorseEntries | undefined
  if (manual.close_worse_entries === true && immediateLegs > 0) {
    const cwPips = Math.max(0, Number(manual.close_worse_entries_pips ?? 0))
    if (cwPips > 0) {
      closeWorseEntries = {
        immediates: immediateLegs,
        pipsFromAnchor: cwPips,
      }
    }
  }

  if (orders.length === 0 && virtualPendings.length === 0) {
    return buildSingleOrder({
      orderBase,
      expirationFields,
      strictEntry,
      manualLot,
      finalSl,
      finalTps,
      manual,
      ctx,
      delay_ms,
      entryAnchor,
      isBuy,
      pip,
      pipQuote,
      roundPrice,
      fallbackReason: 'multi_trade_fallback_zero_legs',
    })
  }

  return {
    orders,
    ...(virtualPendings.length ? { virtualPendings } : {}),
    anchor: { source: entryAnchor != null ? 'signal' : 'unknown', value: entryAnchor },
    pip,
    pipQuote,
    isBuy,
    ...(strictEntry ? { strictEntry } : {}),
    ...(closeWorseEntries ? { closeWorseEntries } : {}),
    delay_ms,
    ...(rangeFallbackReason ? { fallback_reason: rangeFallbackReason } : {}),
  }
}
