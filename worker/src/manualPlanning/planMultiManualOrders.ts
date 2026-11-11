import type { OrderSendArgs } from '../fxsocketClient'
import type { PipQuote } from '../pipCalculator'
import type {
  ManualSettings,
  ParsedSignal,
  PlannerContext,
  PlannerResult,
  PlannerStrictEntry,
  VirtualPendingLeg,
} from './types'
import { clampPendingExpiryHours } from './manualSettings'
import { appendOrderCommentSuffix } from '../tradeComment'
import type { PlanSingleManualOrdersArgs } from './planSingleManualOrders'
import { planRangeSplit } from './rangeSplit'
import { buildRangeLayerTriggerMap, rangeLayerTriggerForStep } from './rangeLayerTriggers'
import { assertLayeringModeExecutionSupported, resolveLayeringMode } from './layeringModes'
import { buildDistributedPerLegTakeProfits, buildEntryQualityTakeProfitMap } from './tpBucketDistribution'
import { resolveMultiTradeTargetUnits, multiTradeUnitsToLot } from './multiTradeLegUnits'
import { resolveRangeDistancePips } from './signalEntryRange'
import { resolvedParsedEntryZone } from './parsedEntry'
import { normalizeAutoBeConfig, resolveAutoBeTpHitTriggerPrice } from '../autoManagement'

export interface PlanMultiManualOrdersArgs {
  parsed: ParsedSignal
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
    parsed,
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
  const legPct = Math.max(0.1, Math.min(100, Number(manual.multi_trade_leg_percent ?? 5)))
  const ABS_MAX_LEGS = 500

  const { manualUnits, targetUnits, minUnits } = resolveMultiTradeTargetUnits({
    manualLot,
    legPercent: legPct,
    minLot,
    lotStep,
  })
  const targetLeg = multiTradeUnitsToLot(targetUnits, lotStep)

  if (manualUnits < minUnits) {
    return { orders: [], skip_reason: 'lot_below_symbol_min', delay_ms }
  }
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

  const totalLegs = Math.max(1, Math.min(ABS_MAX_LEGS, Math.floor(manualUnits / targetUnits)))

  // Use the *effective* immediate op (market vs broker pending), not `opSplit`.
  // Signals with an entry used to map to BuyLimit for SL/TP geometry, but we
  // execute immediates as Buy/Sell at price 0 — virtual range legs are not
  // broker pendings on that path, so range layering must stay enabled.
  const baseIsPendingSignal =
    orderBase.operation.includes('Limit') || orderBase.operation.includes('Stop')
  const pendingOrderMode = manual.range_layering_type === 'pending_order'
  if (manual.range_trading === true) {
    const support = assertLayeringModeExecutionSupported(manual)
    if (!support.ok) {
      console.warn(`[manualPlanner] unsupported layering mode blocked mode=${resolveLayeringMode(manual)}`)
      return { orders: [], skip_reason: support.reason, delay_ms }
    }
  }
  const rangeDistance = resolveRangeDistancePips({ manual, parsed, pip, isBuy })
  const split = planRangeSplit({
    totalLegs,
    baseIsPendingSignal,
    rangeOn: manual.range_trading === true,
    rangePct: Math.max(0, Math.min(100, Number(manual.range_percent ?? 0))),
    stepPips: Math.max(0, Number(manual.range_step_pips ?? 0)),
    distPips: rangeDistance.distPips,
    pip,
    minStepPriceUnits: minStopDist,
    hasSignalAnchor: entryAnchor != null,
    // Auto layers fire as market orders at logical triggers; broker min-stop
    // spacing applies to SL/TP placement, not virtual rung spacing.
    skipMinStepExpansion: true,
  })
  const reservedRangeLegs = split.pendingLegs
  const effectiveRangeLegs = split.activePendingLegs
  const stepPriceOffset = split.stepPriceOffset
  const rangeFallbackReason = split.fallbackReason
  // Absolute Total Open Trades ceiling from lot math + range split. Layering may
  // reduce opens; it must never raise them past this. multi_trade_max_orders is only
  // a basket ceiling when it can fit all immediate legs — lower values are legacy
  // burst-consolidation caps and must not wipe layering.
  const splitCeiling = split.immediateLegs + effectiveRangeLegs
  let hardCap = Math.min(totalLegs, Math.max(0, splitCeiling))
  const basketCapRaw = Number(manual.multi_trade_max_orders)
  const basketCap = Number.isFinite(basketCapRaw) && basketCapRaw > 0
    ? Math.max(1, Math.min(ABS_MAX_LEGS, Math.floor(basketCapRaw)))
    : null
  if (basketCap != null && basketCap >= split.immediateLegs) {
    hardCap = Math.min(hardCap, basketCap)
  }
  hardCap = Math.max(0, Math.min(ABS_MAX_LEGS, hardCap))

  let immediateLegs = split.immediateLegs
  let rangeLegCount = effectiveRangeLegs
  if (immediateLegs > hardCap) {
    immediateLegs = hardCap
    rangeLegCount = 0
  } else {
    rangeLegCount = Math.min(rangeLegCount, Math.max(0, hardCap - immediateLegs))
  }
  const basketLegCap = immediateLegs + rangeLegCount

  const immediateTpPrices = buildDistributedPerLegTakeProfits({
    openLegCount: immediateLegs,
    finalTps,
    tpLots: manual.tp_lots,
  })
  const rangeTpPrices = buildDistributedPerLegTakeProfits({
    openLegCount: rangeLegCount,
    finalTps,
    tpLots: manual.tp_lots,
  })
  const tpForImmediateIndex = (idx: number): number | null => {
    if (finalTps.length === 0) return null
    const price = immediateTpPrices[idx]
    if (typeof price === 'number' && Number.isFinite(price) && price > 0) return price
    return finalTps[finalTps.length - 1] ?? null
  }
  const rangeLayeringMeta = manual.range_trading === true && reservedRangeLegs > 0
    ? {
        rangeStepPips: Math.max(0, Number(manual.range_step_pips ?? 0)),
        rangeDistancePips: Math.max(0, Number(manual.range_distance_pips ?? 0)),
        effectiveStepPips: split.effectiveStepPips,
        stepPriceOffset: split.stepPriceOffset,
        maxStepIdx: Math.max(split.maxStepIdx, rangeLegCount),
        reservedPendingLegs: reservedRangeLegs,
        activePendingLegs: rangeLegCount,
        basketLegCap,
        plannedImmediateLegs: immediateLegs,
        rangeLayeringType: (pendingOrderMode ? 'pending_order' : 'auto') as 'auto' | 'pending_order',
        // Always persist the distance used in the split (manual or signal zone).
        effectiveDistancePips: rangeDistance.distPips,
        ...(manual.use_signal_entry_range === true
          ? {
              useSignalEntryRange: true,
              signalRangeBoundary: rangeDistance.boundary,
              signalZoneLo: resolvedParsedEntryZone(parsed)?.lo ?? null,
              signalZoneHi: resolvedParsedEntryZone(parsed)?.hi ?? null,
            }
          : {}),
      }
    : null

  const rangeDigits = Math.max(0, Math.min(8, Math.floor(ctx.digits ?? 5)))
  const rangeTriggerMap =
    rangeLegCount > 0 && entryAnchor != null && entryAnchor > 0
      ? buildRangeLayerTriggerMap({
          virtualPendings: Array.from({ length: rangeLegCount }, (_, i) => ({
            stepIdx: i + 1,
            stepPriceOffset,
            isBuy,
          })),
          anchor: entryAnchor,
          digits: rangeDigits,
          rangeLayering: rangeLayeringMeta,
          pip,
        })
      : new Map<number, number>()

  // Override SL/TP freezes absolute prices from the first entry (entryAnchor).
  // Later range layers inherit those same prices — never recompute from trigger.
  const stoplossForRangeStep = (_stepIdx: number): number | null => finalSl

  const tpForRangeIndex = (idx: number): number | null => {
    if (finalTps.length === 0) return null
    if (
      manual.range_trading === true
      && rangeLegCount > 0
      && entryAnchor != null
      && entryAnchor > 0
      && stepPriceOffset > 0
    ) {
      const projectedLegs: Array<{ id: string; entryPrice: number; openedAt: string }> = []
      for (let i = 0; i < immediateLegs; i++) {
        projectedLegs.push({
          id: `imm${i}`,
          entryPrice: entryAnchor,
          openedAt: `imm${String(i).padStart(4, '0')}`,
        })
      }
      for (let i = 0; i < rangeLegCount; i++) {
        const stepIdx = i + 1
        const entryPrice = rangeTriggerMap.get(stepIdx)
          ?? rangeLayerTriggerForStep({
            stepIdx,
            leg: { stepPriceOffset, isBuy },
            anchor: entryAnchor,
            digits: rangeDigits,
            legCount: rangeLegCount,
            rangeLayering: rangeLayeringMeta,
            pip,
            triggerMap: rangeTriggerMap,
          })
        projectedLegs.push({
          id: `rg${String(i).padStart(4, '0')}`,
          entryPrice,
          openedAt: `rg${String(i).padStart(4, '0')}`,
        })
      }
      const projectedTp = buildEntryQualityTakeProfitMap({
        legs: projectedLegs,
        isBuy,
        slotLegCount: basketLegCap,
        finalTps,
        tpLots: manual.tp_lots,
      }).get(`rg${String(idx).padStart(4, '0')}`)
      if (typeof projectedTp === 'number' && projectedTp > 0) return projectedTp
    }
    const price = rangeTpPrices[idx]
    if (typeof price === 'number' && Number.isFinite(price) && price > 0) return price
    return finalTps[finalTps.length - 1] ?? null
  }

  const takeprofitForRangeStep = (idx: number): number | null => tpForRangeIndex(idx)

  // No-TP signals ("Gold buy now" teasers): still honor multi / Range Trading
  // lot split (UI "0.25 × 20"). Never emit N *full-lot* clones — only targetLeg
  // sized immediates (+ remainder). With range layering on, also attach virtuals.
  if (finalTps.length === 0) {
    const virtualPendings: VirtualPendingLeg[] = []
    if (rangeLegCount > 0) {
      const pendHours = clampPendingExpiryHours(manual.pending_expiry_hours)
      const expiryHours = pendHours > 0 ? pendHours : undefined
      for (let i = 0; i < rangeLegCount; i++) {
        virtualPendings.push({
          stepIdx: i + 1,
          stepPriceOffset,
          isBuy,
          volume: targetLeg,
          stoploss: stoplossForRangeStep(i + 1),
          takeprofit: null,
          slippage: slippage ?? 20,
          comment: appendOrderCommentSuffix(commentPrefix, `:rg${i + 1}.tp${i + 1}`),
          expertID: expertId,
          expiryHours,
        })
      }
    }
    const rangeLayeringFields =
      manual.range_trading === true && reservedRangeLegs > 0
        ? { rangeLayering: rangeLayeringMeta! }
        : {}
    const emptyTpFallback = {
      fallback_reason: 'multi_trade_fallback_empty_tps' as const,
    }

    if (immediateLegs > 0 && targetUnits < minUnits) {
      return {
        orders: [],
        delay_ms,
        ...emptyTpFallback,
        ...(virtualPendings.length ? { virtualPendings } : {}),
        ...rangeLayeringFields,
      }
    }

    const orders: OrderSendArgs[] = []
    const immCount = Math.max(0, immediateLegs)
    for (let i = 0; i < immCount; i++) {
      orders.push({
        ...orderBase,
        volume: targetLeg,
        stoploss: roundPrice(finalSl),
        takeprofit: roundPrice(null),
        ...expirationFields,
        comment: appendOrderCommentSuffix(commentPrefix, `:tp${i + 1}`),
      })
    }
    // Match TP path: remainder only when no range reservation ate the leftover.
    if (rangeLegCount === 0) {
      const remainderUnits = manualUnits - totalLegs * targetUnits
      if (remainderUnits >= minUnits && orders.length < ABS_MAX_LEGS) {
        orders.push({
          ...orderBase,
          volume: multiTradeUnitsToLot(remainderUnits, lotStep),
          stoploss: roundPrice(finalSl),
          takeprofit: roundPrice(null),
          ...expirationFields,
          comment: appendOrderCommentSuffix(commentPrefix, ':tp.rem'),
        })
      }
    }
    // Degenerate: no room for even one targetLeg (should be rare after min-lot guard).
    if (orders.length === 0 && virtualPendings.length === 0) {
      const single = buildSingleOrder({
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
        fallbackReason: 'multi_trade_fallback_empty_tps',
      })
      return { ...single }
    }
    return {
      orders,
      delay_ms,
      anchor: { source: entryAnchor != null ? 'signal' : 'unknown', value: entryAnchor },
      pip,
      pipQuote,
      isBuy,
      ...(strictEntry ? { strictEntry } : {}),
      ...(virtualPendings.length ? { virtualPendings } : {}),
      ...rangeLayeringFields,
      ...(rangeFallbackReason
        ? { fallback_reason: rangeFallbackReason }
        : emptyTpFallback),
    }
  }

  // Burst consolidation packs IMMEDIATE legs into fewer OrderSends for speed.
  // multi_trade_max_orders also seeds the Total Open Trades basket ceiling — only
  // use it for consolidation when it is below the immediate leg count (legacy low caps).
  // Never emit more immediate OrderSends than immediateLegs / basket room.
  const burstCapRaw = Number(manual.multi_trade_max_orders)
  let burstCap = immediateLegs
  if (Number.isFinite(burstCapRaw) && burstCapRaw > 0) {
    const n = Math.max(1, Math.min(ABS_MAX_LEGS, Math.floor(burstCapRaw)))
    if (n < immediateLegs) burstCap = n
  }
  if (burstCap < immediateLegs) {
    console.log(
      `[planMulti] burst cap ${burstCap} consolidates ${immediateLegs} immediate legs`
      + ` (leg%=${legPct} manualLot=${manualLot})`,
    )
  }

  type BurstGroup = { tpPrice: number | null; legCount: number }
  const burstGroups: BurstGroup[] = []
  for (let i = 0; i < immediateLegs; i++) {
    const tpPrice = tpForImmediateIndex(i)
    const last = burstGroups[burstGroups.length - 1]
    if (last && last.tpPrice === tpPrice) last.legCount += 1
    else burstGroups.push({ tpPrice, legCount: 1 })
  }

  const orders: OrderSendArgs[] = []
  if (burstGroups.length > 0) {
    // Every distinct TP keeps at least one order; spare slots go to the
    // groups carrying the most volume so order sizes stay balanced.
    const cap = Math.max(burstGroups.length, Math.min(burstCap, immediateLegs))
    const alloc = burstGroups.map(g => ({ g, orders: 1 }))
    let used = burstGroups.length
    while (used < cap) {
      let best = -1
      for (let i = 0; i < alloc.length; i++) {
        if (alloc[i].orders >= alloc[i].g.legCount) continue
        if (best < 0
          || alloc[i].g.legCount / alloc[i].orders > alloc[best].g.legCount / alloc[best].orders) {
          best = i
        }
      }
      if (best < 0) break
      alloc[best].orders += 1
      used += 1
    }

    let orderNo = 0
    for (const { g, orders: orderCount } of alloc) {
      const groupUnits = g.legCount * targetUnits
      const baseUnits = Math.floor(groupUnits / orderCount)
      let remainder = groupUnits - baseUnits * orderCount
      for (let k = 0; k < orderCount; k++) {
        const units = baseUnits + (remainder > 0 ? 1 : 0)
        if (remainder > 0) remainder -= 1
        if (units <= 0) continue
        orderNo += 1
        orders.push({
          ...orderBase,
          volume: multiTradeUnitsToLot(units, lotStep),
          stoploss: roundPrice(finalSl),
          takeprofit: roundPrice(g.tpPrice),
          ...expirationFields,
          comment: appendOrderCommentSuffix(commentPrefix, `:tp${orderNo}`),
        })
      }
    }
  }

  const virtualPendings: VirtualPendingLeg[] = []
  if (rangeLegCount > 0) {
    const pendHours = clampPendingExpiryHours(manual.pending_expiry_hours)
    const expiryHours = pendHours > 0 ? pendHours : undefined

    // Unique stepIdx 1..N — never cycle/modulo (that caused duplicate broker limits).
    for (let i = 0; i < rangeLegCount; i++) {
      const stepIdx = i + 1
      const tpPrice = takeprofitForRangeStep(i)
      virtualPendings.push({
        stepIdx,
        stepPriceOffset,
        isBuy,
        volume: targetLeg,
        stoploss: stoplossForRangeStep(stepIdx),
        takeprofit: tpPrice,
        slippage: slippage ?? 20,
        comment: appendOrderCommentSuffix(commentPrefix, `:rg${stepIdx}.tp${i + 1}`),
        expertID: expertId,
        expiryHours,
      })
    }
  }

  if (rangeLegCount === 0 && !pendingOrderMode) {
    const remainderUnits = manualUnits - totalLegs * targetUnits
    if (remainderUnits >= minUnits && orders.length < ABS_MAX_LEGS) {
      const tpPrice = tpForImmediateIndex(Math.max(0, immediateLegs - 1))
        ?? tpForImmediateIndex(0)
      orders.push({
        ...orderBase,
        volume: multiTradeUnitsToLot(remainderUnits, lotStep),
        stoploss: roundPrice(finalSl),
        takeprofit: roundPrice(tpPrice),
        ...expirationFields,
        comment: appendOrderCommentSuffix(commentPrefix, ':tp.rem'),
      })
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

  const autoBeCfg = normalizeAutoBeConfig(manual)
  const autoBeTpHitTriggerPrice = autoBeCfg?.mode === 'tp_hit'
    ? resolveAutoBeTpHitTriggerPrice({
      tpIndex: autoBeCfg.tpIndex,
      finalTps,
      brokerTp: null,
    })
    : null

  return {
    orders,
    ...(virtualPendings.length ? { virtualPendings } : {}),
    anchor: { source: entryAnchor != null ? 'signal' : 'unknown', value: entryAnchor },
    pip,
    pipQuote,
    isBuy,
    ...(strictEntry ? { strictEntry } : {}),
    ...(manual.range_trading === true && reservedRangeLegs > 0
      ? {
            rangeLayering: rangeLayeringMeta!,
          }
        : {}),
    delay_ms,
    ...(rangeFallbackReason ? { fallback_reason: rangeFallbackReason } : {}),
    ...(autoBeTpHitTriggerPrice != null ? { autoBeTpHitTriggerPrice } : {}),
  }
}
