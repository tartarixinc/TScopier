import type { OrderSendArgs } from '../metatraderapi'
import type { PipQuote } from '../pipCalculator'
import type { ManualSettings, PlannerContext, PlannerResult, PlannerStrictEntry } from './types'
import { planSinglePartialTps } from './partialTpSchedule'
import { resolveTpBucketRows } from './tpBucketDistribution'

export interface PlanSingleManualOrdersArgs {
  orderBase: Omit<OrderSendArgs, 'volume' | 'stoploss' | 'takeprofit' | 'expiration' | 'expirationType'>
  expirationFields: { expiration?: string; expirationType?: OrderSendArgs['expirationType'] }
  strictEntry: PlannerStrictEntry | undefined
  manualLot: number
  finalSl: number | null
  finalTps: number[]
  manual: ManualSettings
  ctx: PlannerContext
  delay_ms: number
  entryAnchor: number | null
  isBuy: boolean
  pip: number
  pipQuote: PipQuote
  roundPrice: (v: number | null | undefined) => number
  fallbackReason?: string
}

export function planSingleManualOrders(args: PlanSingleManualOrdersArgs): PlannerResult {
  const {
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
    fallbackReason,
  } = args

  const { bucketRows } = resolveTpBucketRows(finalTps, manual.tp_lots)
  const partialPlan = planSinglePartialTps({
    manualLot,
    minLot: Number.isFinite(ctx.minLot) && ctx.minLot > 0 ? ctx.minLot : 0.01,
    lotStep: Number.isFinite(ctx.lotStep) && ctx.lotStep > 0 ? ctx.lotStep : 0.01,
    finalTps,
    bucketRows,
  })
  const brokerTp =
    partialPlan.brokerTp
    ?? (finalTps.length >= 2 ? (finalTps[finalTps.length - 1] ?? null) : (finalTps[0] ?? null))
  const combinedFallback = fallbackReason ?? partialPlan.fallbackReason
  return {
    orders: [{
      ...orderBase,
      volume: manualLot,
      stoploss: roundPrice(finalSl),
      takeprofit: roundPrice(brokerTp),
      ...expirationFields,
    }],
    delay_ms,
    anchor: { source: entryAnchor != null ? 'signal' : 'unknown', value: entryAnchor },
    pip,
    pipQuote,
    isBuy,
    ...(strictEntry ? { strictEntry } : {}),
    ...(combinedFallback ? { fallback_reason: combinedFallback } : {}),
    ...(partialPlan.partials.length > 0 ? { partialTps: partialPlan.partials } : {}),
  }
}
