import type { SupabaseClient } from '@supabase/supabase-js'
import type { CalculatedLayerPlanSuccess, LayerPlanReason, LayerPricePlanSuccess } from '../manualPlanning/layeringModeCalculators'
import {
  calculateDynamicLayerPrices,
  calculateStaticLayerPlan,
} from '../manualPlanning/layeringModeCalculators'
import { allocateLayerLots } from '../manualPlanning/layerLotAllocation'
import { solveLayerSizingConstraints } from '../manualPlanning/layerSizingConstraints'
import {
  activateLayeringPlanWithLegs,
  buildLayeringPlanSnapshot,
  generateLayerPlanId,
  materializeExecutableLayerPlanLegRows,
  persistLayeringPlan,
} from '../manualPlanning/layeringPlanPersistence'
import { resolveLayeringMode } from '../manualPlanning/layeringModes'
import { resolveLayeringModeRolloutDecision, type LayeringModeRolloutDecision } from '../manualPlanning/layeringModeRollout'
import type { LayeringMode, LayeringPlanSnapshot } from '../manualPlanning/types'
import type { SendOrderOutcome } from './types'
import type { PreparedEntry } from './entryPrepare'
import { finishEntrySend } from './entryExecution'
import { activateLayeringBrokerPendingOrders } from './layeringModeBrokerPending'
import { writeExecutionLog } from '../observability/executionLog'
export interface LayeringModeFillContext {
  readonly entryPrice: number | null
  readonly lot: number | null
  readonly tradeRowId: string | null
  readonly ticket: number | null
}

export interface LayeringModeRuntime {
  readonly mode: Exclude<LayeringMode, 'legacy'>
  readonly rollout: LayeringModeRolloutDecision
  readonly onImmediateFill?: (fill: LayeringModeFillContext) => Promise<void>
}

function sanitizedLog(event: string, payload: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, component: 'layeringModes', ...payload }))
}

function rangeFromParsed(prep: PreparedEntry): { low: number; high: number } | null {
  const low = Number(prep.parsed.entry_zone_low)
  const high = Number(prep.parsed.entry_zone_high)
  if (!Number.isFinite(low) || !Number.isFinite(high)) return null
  const lo = Math.min(low, high)
  const hi = Math.max(low, high)
  return lo <= hi ? { low: lo, high: hi } : null
}

function sideForPrep(prep: PreparedEntry): 'buy' | 'sell' {
  return prep.plan.isBuy === false || prep.op.toLowerCase().includes('sell') ? 'sell' : 'buy'
}

function basketKeyForPrep(prep: PreparedEntry): string {
  return `${prep.signal.id}:${prep.broker.id}:${prep.symbol.toUpperCase()}`
}

function snapshotIdentity(prep: PreparedEntry, mode: Exclude<LayeringMode, 'legacy'>) {
  return {
    signalId: prep.signal.id,
    brokerAccountId: prep.broker.id,
    basketKey: basketKeyForPrep(prep),
    symbol: prep.symbol,
    side: sideForPrep(prep),
    mode,
  }
}

function clonePrepForSingleLayer(prep: PreparedEntry, lot: number, runtime?: LayeringModeRuntime): PreparedEntry {
  const first = prep.legs[0]
  const legs = first
    ? [{ ...first, args: { ...first.args, volume: lot } }]
    : []
  return {
    ...prep,
    legs,
    virtualPendings: [],
    deferVirtualAnchor: false,
    deferBrokerRangePendingMaterialize: false,
    plan: { ...prep.plan, virtualPendings: undefined },
    layeringRuntime: runtime,
  }
}

async function logLayeringExecutionBlocked(
  supabase: SupabaseClient,
  prep: PreparedEntry,
  reason: string,
  mode: Exclude<LayeringMode, 'legacy'>,
): Promise<void> {
  sanitizedLog('layering_execution_blocked', { mode, reason, plan_id: null })
  await writeExecutionLog(supabase, {
    user_id: prep.signal.user_id,
    signal_id: prep.signal.id,
    broker_account_id: prep.broker.id,
    action: 'layering_execution_blocked',
    status: 'info',
    request_payload: { mode, reason } as unknown as Record<string, unknown>,
  })
}

function buildSnapshot(args: {
  prep: PreparedEntry
  calculatedPlan: CalculatedLayerPlanSuccess
  mode: Exclude<LayeringMode, 'legacy'>
  anchorSource: 'signal' | 'fill'
}): { ok: true; snapshot: LayeringPlanSnapshot } | { ok: false; reason: string } {
  const identity = snapshotIdentity(args.prep, args.mode)
  const planId = generateLayerPlanId(identity)
  if (!planId) return { ok: false, reason: 'invalid_plan_id' }
  const built = buildLayeringPlanSnapshot({
    ...identity,
    planId,
    calculatedPlan: args.calculatedPlan,
    anchorSource: args.anchorSource,
    configuredStaticLayerCount: args.mode === 'static' ? args.prep.manual.static_layer_count ?? args.calculatedPlan.requestedLayerCount : null,
    configuredDynamicStepPips: args.mode === 'dynamic' ? args.prep.manual.dynamic_step_pips ?? null : null,
    configuredDynamicMaxLayers: args.mode === 'dynamic' ? args.prep.manual.dynamic_max_layers ?? args.calculatedPlan.requestedLayerCount : null,
    createdAt: new Date().toISOString(),
  })
  return built.ok ? { ok: true, snapshot: built.snapshot } : { ok: false, reason: built.reason }
}

async function persistPreparedPlan(prep: PreparedEntry, snapshot: LayeringPlanSnapshot): Promise<'prepared_created' | 'prepared_existing_matching' | 'plan_conflict' | 'persistence_failed' | 'terminal_plan'> {
  const persisted = await persistLayeringPlan(prep.ctx.supabase, snapshot)
  if (persisted.ok) {
    sanitizedLog(persisted.outcome === 'created' ? 'layering_plan_prepared' : 'layering_plan_existing', {
      mode: snapshot.mode,
      plan_id: snapshot.planId,
    })
    return persisted.outcome === 'created' ? 'prepared_created' : 'prepared_existing_matching'
  }
  if (persisted.reason === 'conflict') return 'plan_conflict'
  if (persisted.reason === 'terminal_plan') return 'terminal_plan'
  return 'persistence_failed'
}

async function activatePreparedPlan(args: {
  prep: PreparedEntry
  snapshot: LayeringPlanSnapshot
  skipFirstLayer: boolean
  firstFill: LayeringModeFillContext
}): Promise<boolean> {
  const mode = args.snapshot.mode
  const decision = resolveLayeringModeRolloutDecision({ mode, brokerAccountId: args.prep.broker.id })
  if (!decision.activationAllowed || !decision.executionAllowed) {
    sanitizedLog('layering_plan_activation_lost', { mode, plan_id: args.snapshot.planId, reason: decision.reason })
    return false
  }
  if (args.prep.manual.range_layering_type === 'pending_order') {
    const activated = await activateLayeringBrokerPendingOrders(args)
    sanitizedLog(activated.ok ? 'layering_plan_broker_pending_activated' : 'layering_plan_activation_failed', {
      mode,
      plan_id: args.snapshot.planId,
      reason: activated.ok ? activated.outcome : activated.reason,
      placed: activated.ok ? activated.placed : 0,
      adopted: activated.ok ? activated.adopted : 0,
    })
    return activated.ok
  }
  const pendHours = Number(args.prep.manual.pending_expiry_hours)
  const expiresAt = Number.isFinite(pendHours) && pendHours > 0
    ? new Date(Date.now() + pendHours * 60 * 60 * 1000).toISOString()
    : null
  const rows = materializeExecutableLayerPlanLegRows({
    snapshot: args.snapshot,
    userId: args.prep.signal.user_id,
    metaapiAccountId: args.prep.uuid,
    stoploss: Number(args.prep.legs[0]?.args.stoploss) > 0 ? Number(args.prep.legs[0]?.args.stoploss) : null,
    takeprofit: Number(args.prep.legs[0]?.args.takeprofit) > 0 ? Number(args.prep.legs[0]?.args.takeprofit) : null,
    slippage: Number(args.prep.legs[0]?.args.slippage) || 20,
    comment: args.prep.commentPrefix,
    expertId: Number(args.prep.legs[0]?.args.expertID) || 909090,
    expiresAt,
    status: 'pending',
    skipFirstLayer: args.skipFirstLayer,
  })
  if (!rows.ok) {
    sanitizedLog('layering_plan_activation_failed', { mode, plan_id: args.snapshot.planId, reason: rows.reason })
    return false
  }
  const firstRow = rows.rows[0]
  const activated = await activateLayeringPlanWithLegs(args.prep.ctx.supabase, args.snapshot, {
    executionMechanism: 'auto',
    excludeFirstLayer: args.skipFirstLayer,
    legContext: {
      user_id: args.prep.signal.user_id,
      signal_id: args.snapshot.signalId,
      broker_account_id: args.snapshot.brokerAccountId,
      metaapi_account_id: args.prep.uuid,
      stoploss: firstRow?.stoploss ?? null,
      takeprofit: firstRow?.takeprofit ?? null,
      slippage: firstRow?.slippage ?? 20,
      comment: firstRow?.comment ?? args.prep.commentPrefix,
      expert_id: firstRow?.expert_id ?? null,
      expires_at: firstRow?.expires_at ?? null,
      cwe_close_price: firstRow?.cwe_close_price ?? null,
      first_execution_trade_id: args.firstFill.tradeRowId,
      first_execution_order_id: args.firstFill.ticket != null ? String(args.firstFill.ticket) : null,
      first_execution_status: 'confirmed',
      first_execution_fill_price: args.firstFill.entryPrice,
      first_execution_filled_lot: args.firstFill.lot,
      first_execution_confirmed_at: new Date().toISOString(),
    },
  })
  sanitizedLog(activated.ok ? 'layering_plan_activated' : 'layering_plan_activation_failed', {
    mode,
    plan_id: args.snapshot.planId,
    reason: activated.ok ? activated.outcome : activated.reason,
    legs: rows.rows.length,
  })
  return activated.ok
}

function calculatedDynamicFromFill(args: {
  pricePlan: LayerPricePlanSuccess
  intendedTotalLot: number
  actualFirstLot: number
  minLot: number
  lotStep: number
}): CalculatedLayerPlanSuccess | null {
  if (args.actualFirstLot <= 0 || args.actualFirstLot > args.intendedTotalLot) return null
  const remainingPrices = args.pricePlan.normalizedCandidatePrices.slice(1)
  let remainingLots: readonly number[] = []
  let allocatedRemaining = 0
  let allocationReasons: readonly LayerPlanReason[] = []
  const remainingTotal = Number(Math.max(0, args.intendedTotalLot - args.actualFirstLot).toFixed(8))
  if (remainingPrices.length > 0 && remainingTotal > 0) {
    const alloc = allocateLayerLots({
      intendedTotalLot: remainingTotal,
      layerCount: remainingPrices.length,
      minLot: args.minLot,
      lotStep: args.lotStep,
    })
    if (alloc.ok) {
      remainingLots = alloc.lots
      allocatedRemaining = alloc.allocatedTotalLot
      allocationReasons = alloc.reasons
    }
  }
  const fundedPrices = [args.pricePlan.normalizedCandidatePrices[0]!, ...remainingPrices.slice(0, remainingLots.length)]
  const lots = [args.actualFirstLot, ...remainingLots]
  const allocatedTotalLot = Number((args.actualFirstLot + allocatedRemaining).toFixed(8))
  if (allocatedTotalLot > args.intendedTotalLot) return null
  return Object.freeze({
    ...args.pricePlan,
    actualLayerCount: fundedPrices.length,
    fundedPrices: Object.freeze(fundedPrices),
    unfundedPrices: Object.freeze(remainingPrices.slice(remainingLots.length)),
    unfundedIndexes: Object.freeze(remainingPrices.slice(remainingLots.length).map((_, idx) => remainingLots.length + idx + 1)),
    lots: Object.freeze(lots),
    intendedTotalLot: args.intendedTotalLot,
    allocatedTotalLot,
    unallocatedLot: Number(Math.max(0, args.intendedTotalLot - allocatedTotalLot).toFixed(8)),
    theoreticalLayerCount: null,
    effectiveStepPips: null,
    requestedLayerPercent: null,
    effectiveLayerPercent: null,
    allocationPercentTotal: null,
    optimizationStrategy: null,
    reasons: Object.freeze([...new Set([...args.pricePlan.reasons, ...allocationReasons])]),
  })
}

export async function runLayeringModeRangeEntry(
  prep: PreparedEntry,
): Promise<SendOrderOutcome> {
  const mode = resolveLayeringMode(prep.manual)
  if (mode !== 'static' && mode !== 'dynamic') {
    return finishEntrySend(prep, false, false, true, false)
  }
  const rollout = resolveLayeringModeRolloutDecision({ mode, brokerAccountId: prep.broker.id })
  if (!rollout.prepareAllowed) {
    await logLayeringExecutionBlocked(prep.ctx.supabase, prep, rollout.reason, mode)
    return { openedOrMerged: false, finalizeSkipReason: `layering_mode_${mode}_${rollout.reason}` }
  }
  const range = rangeFromParsed(prep)
  if (!range) {
    await logLayeringExecutionBlocked(prep.ctx.supabase, prep, 'invalid_range', mode)
    return { openedOrMerged: false, finalizeSkipReason: `layering_mode_${mode}_invalid_range` }
  }

  const minLot = Number(prep.params?.minLot) > 0 ? Number(prep.params?.minLot) : 0.01
  const lotStep = Number(prep.params?.lotStep) > 0 ? Number(prep.params?.lotStep) : 0.01
  const digits = Math.max(0, Math.min(8, Number(prep.params?.digits) || 5))
  const side = sideForPrep(prep)
  const intendedTotalLot = prep.baseLot
  const layerPercent = Number(prep.manual.multi_trade_leg_percent ?? 0) > 0 ? Number(prep.manual.multi_trade_leg_percent) : undefined

  if (mode === 'static') {
    const calculated = calculateStaticLayerPlan({
      side,
      rangeLow: range.low,
      rangeHigh: range.high,
      totalLayerCount: Number(prep.manual.static_layer_count ?? 5),
      symbolDigits: digits,
      intendedTotalLot,
      minLot,
      lotStep,
      layerPercent,
      optimizationStrategy: prep.manual.layering_optimization_strategy,
    })
    if (!calculated.ok) return { openedOrMerged: false, finalizeSkipReason: `layering_mode_static_${calculated.reason}` }
    const built = buildSnapshot({ prep, calculatedPlan: calculated, mode, anchorSource: 'signal' })
    if (!built.ok) return { openedOrMerged: false, finalizeSkipReason: `layering_mode_static_${built.reason}` }
    const persisted = await persistPreparedPlan(prep, built.snapshot)
    if (persisted === 'plan_conflict' || persisted === 'persistence_failed' || persisted === 'terminal_plan') {
      return { openedOrMerged: false, finalizeSkipReason: `layering_mode_static_${persisted}` }
    }
    if (rollout.reason === 'prepare_only') return { openedOrMerged: true, finalizeSkipReason: 'layering_mode_static_prepare_only' }
    const runtime: LayeringModeRuntime = {
      mode,
      rollout,
      onImmediateFill: async fill => {
        const ok = await activatePreparedPlan({ prep, snapshot: built.snapshot, skipFirstLayer: true, firstFill: fill })
        if (!ok) throw new Error('layering_first_fill_activation_failed')
      },
    }
    const nextPrep = clonePrepForSingleLayer(prep, calculated.lots[0]!, runtime)
    return finishEntrySend(nextPrep, false, false, true, false)
  }

  if (rollout.reason === 'prepare_only') {
    await logLayeringExecutionBlocked(prep.ctx.supabase, prep, 'dynamic_prepare_only_requires_actual_fill', mode)
    return { openedOrMerged: false, finalizeSkipReason: 'layering_mode_dynamic_prepare_only' }
  }

  const maxLayers = Number(prep.manual.dynamic_max_layers ?? 5)
  const fullRangeDistancePips = (range.high - range.low) / (prep.plan.pip ?? prep.params?.point ?? 0.00001)
  const firstSizing = layerPercent == null
    ? null
    : solveLayerSizingConstraints({
      rangeDistancePips: fullRangeDistancePips,
      stepPips: Number(prep.manual.dynamic_step_pips ?? 3),
      totalLot: intendedTotalLot,
      minLot,
      lotStep,
      layerPercent,
      optimizationStrategy: prep.manual.layering_optimization_strategy,
      maxLayerCount: maxLayers,
    })
  if (firstSizing && !firstSizing.ok) return { openedOrMerged: false, finalizeSkipReason: `layering_mode_dynamic_${firstSizing.reason}` }
  const firstAlloc = firstSizing ?? allocateLayerLots({ intendedTotalLot, layerCount: maxLayers, minLot, lotStep })
  if (!firstAlloc.ok) return { openedOrMerged: false, finalizeSkipReason: `layering_mode_dynamic_${firstAlloc.reason}` }
  const firstLot = firstAlloc.lots[0]!
  const runtime: LayeringModeRuntime = {
    mode,
    rollout,
    onImmediateFill: async fill => {
      if (fill.entryPrice == null || fill.lot == null) {
        sanitizedLog('layering_plan_activation_failed', { mode, plan_id: null, reason: 'missing_actual_fill' })
        throw new Error('layering_first_fill_missing_actual_fill')
      }
      const prices = calculateDynamicLayerPrices({
        side,
        rangeLow: range.low,
        rangeHigh: range.high,
        firstFillPrice: fill.entryPrice,
        stepPips: Number(prep.manual.dynamic_step_pips ?? 3),
        maxTotalLayers: maxLayers,
        pipSize: prep.plan.pip ?? prep.params?.point ?? 0.00001,
        symbolDigits: digits,
      })
      if (!prices.ok) {
        sanitizedLog('layering_plan_activation_failed', { mode, plan_id: null, reason: prices.reason })
        throw new Error(`layering_dynamic_prices_${prices.reason}`)
      }
      const calculated = calculatedDynamicFromFill({
        pricePlan: prices,
        intendedTotalLot,
        actualFirstLot: fill.lot,
        minLot,
        lotStep,
      })
      if (!calculated) {
        sanitizedLog('layering_plan_activation_failed', { mode, plan_id: null, reason: 'invalid_actual_fill_lot' })
        throw new Error('layering_dynamic_invalid_actual_fill_lot')
      }
      const built = buildSnapshot({ prep, calculatedPlan: calculated, mode, anchorSource: 'fill' })
      if (!built.ok) {
        sanitizedLog('layering_plan_activation_failed', { mode, plan_id: null, reason: built.reason })
        throw new Error(`layering_dynamic_snapshot_${built.reason}`)
      }
      const persisted = await persistPreparedPlan(prep, built.snapshot)
      if (persisted === 'plan_conflict' || persisted === 'persistence_failed' || persisted === 'terminal_plan') {
        sanitizedLog('layering_plan_activation_failed', { mode, plan_id: built.snapshot.planId, reason: persisted })
        throw new Error(`layering_dynamic_${persisted}`)
      }
      if (rollout.reason === 'prepare_only') return
      const ok = await activatePreparedPlan({ prep, snapshot: built.snapshot, skipFirstLayer: true, firstFill: fill })
      if (!ok) throw new Error('layering_first_fill_activation_failed')
    },
  }
  const nextPrep = clonePrepForSingleLayer(prep, firstLot, runtime)
  return finishEntrySend(nextPrep, false, false, true, false)
}
