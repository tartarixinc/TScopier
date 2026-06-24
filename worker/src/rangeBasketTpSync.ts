import type { SupabaseClient } from '@supabase/supabase-js'
import type { FxsocketBrokerClient } from './fxsocketClient'
import {
  fetchOpenBrokerTickets,
  runBasketLegModifies,
  type BasketOpenLeg,
  type BasketSymbolParams,
} from './basketSlTpReconcile'
import {
  channelParamsPredateBasket,
  loadChannelActiveTradeParamsForSymbol,
} from './channelActiveTradeParams'
import { hasTpTouchedLock } from './rangePendingFireGuard'
import {
  logEffectiveBasketStops,
  mergeWithProtectiveLegSl,
  mostProtectiveOpenLegSl,
  resolveEffectiveBasketStops,
} from './basketEffectiveStops'
import type { ManualTpLot } from './manualPlanning/types'
import {
  buildEntryQualityTakeProfitMap,
  buildRangeBasketPerLegStopTargets,
  resolveRangeBasketTpPhase,
  type EntryQualityLeg,
  type PerLegStopTargetLike,
  type RangeBasketTpPhase,
} from './manualPlanning/tpBucketDistribution'
import type { PlannerResult } from './manualPlanner'
import { mergePlanImmediateOrders } from './multiTradeMerge'

export type RangeBasketParsedSlice = {
  sl?: number | null
  tp?: number[] | null
}

export function toRangeBasketParsedSlice(
  raw: { sl?: unknown; tp?: unknown } | null | undefined,
): RangeBasketParsedSlice {
  if (!raw) return {}
  const sl =
    typeof raw.sl === 'number' && Number.isFinite(raw.sl)
      ? raw.sl
      : raw.sl === null
        ? null
        : undefined
  const tpLevels = coercePositiveTpLevels(raw.tp)
  const out: RangeBasketParsedSlice = {}
  if (sl !== undefined) out.sl = sl
  if (tpLevels.length > 0) out.tp = tpLevels
  else if (Array.isArray(raw.tp)) out.tp = []
  return out
}

export type RangeBasketTpSyncArgs = {
  supabase: SupabaseClient
  api: FxsocketBrokerClient
  uuid: string
  symbol: string
  direction: 'buy' | 'sell'
  baseLot: number
  params: BasketSymbolParams | null
  signalId: string
  userId: string
  brokerAccountId: string
  manual: { range_trading?: boolean; tp_lots?: ManualTpLot[] | null; order_comments_enabled?: boolean }
  parsed: RangeBasketParsedSlice
  plan?: PlannerResult | null
  /** When set, force phase B (range layer just fired). */
  forceLayeringRebalance?: boolean
  channelId?: string | null
  basketCreatedAt?: string | null
}

/** Coerce signal / JSON TP ladder values (numbers or numeric strings). */
export function coercePositiveTpLevels(tp: unknown): number[] {
  if (!Array.isArray(tp)) return []
  const out: number[] = []
  for (const raw of tp) {
    const n = typeof raw === 'number' ? raw : Number(raw)
    if (Number.isFinite(n) && n > 0) out.push(n)
  }
  return out
}

function uniqueOrderedLevels(levels: number[]): number[] {
  const seen = new Set<number>()
  const out: number[] = []
  for (const level of levels) {
    if (seen.has(level)) continue
    seen.add(level)
    out.push(level)
  }
  return out
}

function ladderFromOpenTrades(familyTrades: BasketOpenLeg[], isBuy: boolean): number[] {
  const levels = new Set<number>()
  for (const tr of familyTrades) {
    const tp = Number(tr.tp)
    if (Number.isFinite(tp) && tp > 0) levels.add(tp)
  }
  const arr = [...levels]
  arr.sort((a, b) => (isBuy ? a - b : b - a))
  return arr
}

/** Resolve the TP ladder for range-basket sync (parsed → plan → channel → open legs). */
export function resolveRangeBasketFinalTps(args: {
  parsed: { tp?: unknown }
  plan?: PlannerResult | null
  familyTrades?: BasketOpenLeg[]
  channelTpLevels?: number[] | null
  direction: 'buy' | 'sell'
}): number[] {
  const fromParsed = coercePositiveTpLevels(args.parsed.tp)
  if (fromParsed.length) return fromParsed

  const fromPlan = uniqueOrderedLevels(
    (args.plan ? mergePlanImmediateOrders(args.plan) : [])
      .map(o => Number(o.takeprofit))
      .filter(tp => Number.isFinite(tp) && tp > 0),
  )
  if (fromPlan.length) return fromPlan

  const fromChannel = uniqueOrderedLevels(
    (args.channelTpLevels ?? []).filter(tp => Number.isFinite(tp) && tp > 0),
  )
  if (fromChannel.length) return fromChannel

  if (args.familyTrades?.length) {
    const fromOpen = ladderFromOpenTrades(args.familyTrades, args.direction === 'buy')
    if (fromOpen.length > 1) return fromOpen
    // One TP across many legs is usually a failed balance — do not treat as the ladder.
    if (fromOpen.length === 1 && args.familyTrades.length >= 2) {
      return []
    }
    if (fromOpen.length) return fromOpen
  }
  return []
}

function toEntryQualityLeg(tr: BasketOpenLeg): EntryQualityLeg {
  return {
    id: tr.id,
    entryPrice: Number(tr.entry_price ?? 0),
    openedAt: String(tr.opened_at ?? ''),
  }
}

/** Infer instant leg count when the entry plan is unavailable (post-layer rebalance). */
export function estimatePlanImmediateLegCount(args: {
  openLegCount: number
  activePendingCount: number
  maxPendingStepIdx: number
  planImmediateLegCount?: number
}): number {
  if (args.planImmediateLegCount != null && args.planImmediateLegCount > 0) {
    return args.planImmediateLegCount
  }
  const firedPendingApprox = Math.max(0, args.maxPendingStepIdx - args.activePendingCount)
  if (args.maxPendingStepIdx > 0) {
    return Math.max(0, args.openLegCount - firedPendingApprox)
  }
  return args.openLegCount
}

export function resolveRangeBasketLegCounts(args: {
  openLegCount: number
  planImmediateLegCount: number
  activePendingCount: number
  maxPendingStepIdx: number
}): {
  immediateLegCount: number
  firedRangeLegCount: number
  phase: ReturnType<typeof resolveRangeBasketTpPhase>
} {
  const firedPendingApprox = Math.max(0, args.maxPendingStepIdx - args.activePendingCount)
  const immediateLegCount = Math.max(
    args.planImmediateLegCount,
    Math.max(0, args.openLegCount - firedPendingApprox),
  )
  const firedRangeLegCount = Math.max(0, args.openLegCount - immediateLegCount)
  const phase = resolveRangeBasketTpPhase({
    openLegCount: args.openLegCount,
    immediateLegCount,
    firedRangeLegCount,
  })
  return { immediateLegCount, firedRangeLegCount, phase }
}

export function buildRangeBasketTpTargets(args: {
  familyTrades: BasketOpenLeg[]
  plan: PlannerResult | null | undefined
  parsed: { sl?: unknown; tp?: unknown }
  tpLots?: ManualTpLot[] | null
  direction: 'buy' | 'sell'
  activePendingCount: number
  maxPendingStepIdx: number
  forceLayeringRebalance?: boolean
  channelTpLevels?: number[] | null
  finalTpsOverride?: number[] | null
  /** Wins over parsed.sl when set (e.g. post-adjust effective SL). */
  stoplossOverride?: number | null
}): PerLegStopTargetLike[] {
  const {
    familyTrades, plan, parsed, tpLots, direction, activePendingCount, maxPendingStepIdx,
    forceLayeringRebalance, channelTpLevels, finalTpsOverride, stoplossOverride,
  } = args
  if (!familyTrades.length) return []

  const fromPlan = (plan ? mergePlanImmediateOrders(plan) : []).map(o => ({
    stoploss: Number(o.stoploss) || 0,
    takeprofit: Number(o.takeprofit) || 0,
  }))
  const slRaw = parsed.sl
  const slNum = typeof slRaw === 'number' ? slRaw : Number(slRaw ?? 0)
  const hasSl = Number.isFinite(slNum) && slNum > 0
  const overrideSl = stoplossOverride != null && Number(stoplossOverride) > 0
    ? Number(stoplossOverride)
    : null
  const sl = overrideSl ?? (hasSl ? slNum : (fromPlan[0]?.stoploss ?? 0))
  const finalTps = args.finalTpsOverride?.length
    ? args.finalTpsOverride
    : resolveRangeBasketFinalTps({
        parsed,
        plan,
        familyTrades,
        channelTpLevels,
        direction,
      })

  const planImmediateLegCount = estimatePlanImmediateLegCount({
    openLegCount: familyTrades.length,
    activePendingCount,
    maxPendingStepIdx,
    planImmediateLegCount: plan ? mergePlanImmediateOrders(plan).length : undefined,
  })
  const { immediateLegCount, phase: detectedPhase } = resolveRangeBasketLegCounts({
    openLegCount: familyTrades.length,
    planImmediateLegCount,
    activePendingCount,
    maxPendingStepIdx,
  })
  const phase = forceLayeringRebalance ? 'layering_rebalance' : detectedPhase
  const isBuy = direction === 'buy'

  const openLegs = familyTrades.map(tr => ({
    ...toEntryQualityLeg(tr),
    stoploss: sl,
  }))

  const targets = buildRangeBasketPerLegStopTargets({
    phase,
    openLegs,
    immediateLegCount,
    isBuy,
    stoploss: sl,
    finalTps,
    tpLots,
  })
  return applyOpenLegStopLossToTargets(familyTrades, targets, isBuy)
}

export async function loadRangePendingMeta(
  supabase: SupabaseClient,
  brokerAccountId: string,
  signalId: string,
): Promise<{ activePendingCount: number; maxPendingStepIdx: number }> {
  const { data: pendingRows } = await supabase
    .from('range_pending_legs')
    .select('step_idx, status')
    .eq('broker_account_id', brokerAccountId)
    .eq('signal_id', signalId)
    .limit(500)
  const rows = pendingRows ?? []
  const activePendingCount = rows.filter(
    r => r.status === 'pending' || r.status === 'claimed',
  ).length
  const maxPendingStepIdx = Math.max(0, ...rows.map(r => Number(r.step_idx) || 0))
  return { activePendingCount, maxPendingStepIdx }
}

async function logRangeBasketTpRebalance(
  supabase: SupabaseClient,
  args: {
    userId: string
    signalId: string
    brokerAccountId: string
    openLegs: number
    phase: string
    forceLayeringRebalance?: boolean
    modified: number
    attempted: number
    failed: number
    tpCounts: Record<string, number>
    effectiveSl?: number
    effectiveSlSource?: string
    skippedReason?: string
  },
): Promise<void> {
  try {
    await supabase.from('trade_execution_logs').insert({
      user_id: args.userId,
      signal_id: args.signalId,
      broker_account_id: args.brokerAccountId,
      action: 'range_basket_tp_rebalance',
      status: args.modified > 0 || args.attempted === 0 ? 'success' : 'failed',
      request_payload: {
        open_legs: args.openLegs,
        phase: args.phase,
        force_layering_rebalance: args.forceLayeringRebalance === true,
        modified: args.modified,
        attempted: args.attempted,
        failed: args.failed,
        target_tp_counts: args.tpCounts,
        effective_sl: args.effectiveSl,
        effective_sl_source: args.effectiveSlSource,
        skipped_reason: args.skippedReason,
      } as unknown as Record<string, unknown>,
    })
  } catch { /* best-effort */ }
}

export async function patchPendingRangeLegTakeProfits(args: {
  supabase: SupabaseClient
  brokerAccountId: string
  signalId: string
  isBuy: boolean
  finalTps: number[]
  tpLots?: ManualTpLot[] | null
  openLegs: EntryQualityLeg[]
}): Promise<number> {
  const { supabase, brokerAccountId, signalId, isBuy, finalTps, tpLots, openLegs } = args
  const { data: pendingRows } = await supabase
    .from('range_pending_legs')
    .select('id, trigger_price, step_idx')
    .eq('broker_account_id', brokerAccountId)
    .eq('signal_id', signalId)
    .in('status', ['pending', 'claimed'])
    .limit(500)
  if (!pendingRows?.length) return 0

  const projected: EntryQualityLeg[] = [
    ...openLegs,
    ...pendingRows.map(row => ({
      id: `pending:${row.id}`,
      entryPrice: Number(row.trigger_price ?? 0),
      openedAt: `pending:${String(row.step_idx ?? 0).padStart(6, '0')}`,
    })),
  ]
  const slotLegCount = openLegs.length + pendingRows.length
  const tpMap = buildEntryQualityTakeProfitMap({
    legs: projected,
    isBuy,
    slotLegCount,
    finalTps,
    tpLots,
  })

  let updated = 0
  for (const row of pendingRows) {
    const tp = tpMap.get(`pending:${row.id}`)
    if (typeof tp !== 'number' || !(tp > 0)) continue
    const { error } = await supabase
      .from('range_pending_legs')
      .update({ takeprofit: tp })
      .eq('id', row.id)
    if (!error) updated += 1
  }
  return updated
}

async function loadScopedChannelTpLevels(
  supabase: SupabaseClient,
  args: {
    userId: string
    channelId?: string | null
    basketCreatedAt?: string | null
    symbol: string
  },
): Promise<number[] | null> {
  if (!args.channelId) return null
  try {
    const channelParams = await loadChannelActiveTradeParamsForSymbol(
      supabase,
      args.userId,
      args.channelId,
      args.symbol,
    )
    if (!channelParams?.tpLevels?.length) return null
    if (channelParamsPredateBasket(channelParams, args.basketCreatedAt)) return null
    return channelParams.tpLevels
  } catch {
    return null
  }
}

/**
 * TP-distribution lifecycle mode for a range basket:
 *  - `redistribute`: actively re-spread TP across all open legs by % (during
 *    layering, before any TP is hit).
 *  - `backfill_only`: a TP has been hit (frozen) OR layering is complete — never
 *    repaint existing legs; only assign the deepest TP to legs that have none.
 */
export type TpRebalanceMode = 'redistribute' | 'backfill_only'

export type RangeTpRebalanceGateResult = {
  mode: TpRebalanceMode
  /** Back-compat: true only when full redistribution is allowed. */
  allowOpenLegTpModify: boolean
  reason: string
}

/**
 * Decide how a range basket's open-leg TPs may change.
 *
 * Once any TP has been hit (`tpHit`: a closed leg OR a sticky live-quote TP
 * touch) the basket is frozen — even under `forceLayeringRebalance` — so a price
 * retrace can never repaint TP1/TP2 onto the remaining legs. New layering legs
 * (Layer-till-close ON) are still given the deepest TP via the backfill pass.
 */
export function resolveRangeTpRebalanceGate(args: {
  activePendingCount: number
  maxPendingStepIdx: number
  phase: RangeBasketTpPhase
  forceLayeringRebalance?: boolean
  hasClosedBasketLegs: boolean
  /** Sticky live-quote TP touch (range_pending_tp_locks). */
  tpTouched?: boolean
}): RangeTpRebalanceGateResult {
  const tpHit = args.hasClosedBasketLegs || args.tpTouched === true
  if (tpHit) {
    return {
      mode: 'backfill_only',
      allowOpenLegTpModify: false,
      reason: args.hasClosedBasketLegs ? 'basket_leg_closed' : 'tp_touched',
    }
  }
  if (args.forceLayeringRebalance === true) {
    return { mode: 'redistribute', allowOpenLegTpModify: true, reason: 'force_layering_rebalance' }
  }
  if (args.phase === 'instant_only') {
    return { mode: 'redistribute', allowOpenLegTpModify: true, reason: 'instant_only' }
  }
  if (args.activePendingCount === 0 && args.maxPendingStepIdx > 0) {
    return { mode: 'backfill_only', allowOpenLegTpModify: false, reason: 'layering_complete' }
  }
  return { mode: 'backfill_only', allowOpenLegTpModify: false, reason: 'layering_rebalance_frozen' }
}

export async function hasClosedBasketLegs(
  supabase: SupabaseClient,
  brokerAccountId: string,
  signalId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('trades')
    .select('id')
    .eq('broker_account_id', brokerAccountId)
    .eq('signal_id', signalId)
    .eq('status', 'closed')
    .limit(1)
  if (error) {
    console.warn(`[rangeBasketTpSync] closed-leg check failed signal=${signalId}: ${error.message}`)
    return false
  }
  return (data?.length ?? 0) > 0
}

/**
 * Propagate the tightest SL already on open legs (e.g. breakeven) to every rebalance target.
 * New range layers otherwise inherit anchor SL and overwrite breakeven on sibling legs.
 */
export function applyOpenLegStopLossToTargets(
  familyTrades: BasketOpenLeg[],
  perLegTargets: PerLegStopTargetLike[],
  isBuy: boolean,
): PerLegStopTargetLike[] {
  const basketProtective = mostProtectiveOpenLegSl(familyTrades, isBuy)
  return perLegTargets.map((t, i) => {
    let sl = Number(t.stoploss) || 0
    if (basketProtective != null && basketProtective > 0) {
      sl = mergeWithProtectiveLegSl(sl, basketProtective, isBuy)
    }
    const curSl = Number(familyTrades[i]?.sl)
    if (Number.isFinite(curSl) && curSl > 0) {
      sl = mergeWithProtectiveLegSl(sl, curSl, isBuy)
    }
    return { ...t, stoploss: sl }
  })
}

/** Keep broker/DB take-profits when TP rebalance is frozen. */
export function preserveOpenLegTakeProfits(
  familyTrades: BasketOpenLeg[],
  perLegTargets: PerLegStopTargetLike[],
): PerLegStopTargetLike[] {
  return perLegTargets.map((t, i) => {
    const curTp = Number(familyTrades[i]?.tp)
    if (Number.isFinite(curTp) && curTp > 0) {
      return { ...t, takeprofit: curTp }
    }
    return t
  })
}

/** Farthest/final TP for a direction-sorted ladder (buy: max, sell: min). */
export function deepestFinalTp(finalTps: number[], isBuy: boolean): number {
  const tps = finalTps.filter(t => Number.isFinite(t) && t > 0)
  if (!tps.length) return 0
  return isBuy ? Math.max(...tps) : Math.min(...tps)
}

/**
 * SL/TP a newly-firing range layer should open with, using the basket's
 * resolved effective stops (latest Adjust signal / edit > channel memory >
 * anchor, already merged with the most-protective open-leg SL).
 *
 *  - SL: always the latest effective SL when available (this is the fix — new
 *    layers must not open with the stale anchor SL).
 *  - TP: never repaint a leg that already carries a TP (it was distributed or
 *    deepest-backfilled); a naked leg gets the deepest/final TP. CWE legs ride
 *    with no TP (closed by cweCloseMonitor).
 */
export function resolveFiringLegStops(args: {
  legStoploss: number | null | undefined
  legTakeprofit: number | null | undefined
  cweClosePrice: number | null | undefined
  effective: { stoploss: number; tpLevels: number[] }
  isBuy: boolean
}): { stoploss: number; takeprofit: number } {
  const curSl = Number(args.legStoploss)
  const effSl = Number(args.effective.stoploss)
  const stoploss = Number.isFinite(effSl) && effSl > 0
    ? effSl
    : (Number.isFinite(curSl) && curSl > 0 ? curSl : 0)

  if (args.cweClosePrice != null) {
    return { stoploss, takeprofit: 0 }
  }

  const curTp = Number(args.legTakeprofit)
  if (Number.isFinite(curTp) && curTp > 0) {
    return { stoploss, takeprofit: curTp }
  }
  const deepest = deepestFinalTp(args.effective.tpLevels, args.isBuy)
  return { stoploss, takeprofit: deepest > 0 ? deepest : 0 }
}

/**
 * Freeze mode targets: never repaint a leg that already has a TP; assign the
 * deepest/final TP to any leg that is naked (tp <= 0). This guarantees every
 * open leg ends with SL + TP without redistributing after a TP has been hit.
 */
export function backfillNakedLegTakeProfits(
  familyTrades: BasketOpenLeg[],
  perLegTargets: PerLegStopTargetLike[],
  finalTps: number[],
  isBuy: boolean,
): PerLegStopTargetLike[] {
  const deepest = deepestFinalTp(finalTps, isBuy)
  return perLegTargets.map((t, i) => {
    const curTp = Number(familyTrades[i]?.tp)
    if (Number.isFinite(curTp) && curTp > 0) {
      return { ...t, takeprofit: curTp }
    }
    if (deepest > 0) return { ...t, takeprofit: deepest }
    return t
  })
}

/** Redistribute-mode safety net: never leave a target at 0 when a ladder exists. */
export function fillZeroTargetsWithDeepest(
  perLegTargets: PerLegStopTargetLike[],
  finalTps: number[],
  isBuy: boolean,
): PerLegStopTargetLike[] {
  const deepest = deepestFinalTp(finalTps, isBuy)
  if (deepest <= 0) return perLegTargets
  return perLegTargets.map(t =>
    Number(t.takeprofit) > 0 ? t : { ...t, takeprofit: deepest },
  )
}

/** Assign the deepest/final TP to all active (pending/claimed) range legs (frozen basket). */
export async function setActivePendingRangeLegsTakeProfit(
  supabase: SupabaseClient,
  brokerAccountId: string,
  signalId: string,
  takeprofit: number,
): Promise<number> {
  if (!(takeprofit > 0)) return 0
  const { data, error } = await supabase
    .from('range_pending_legs')
    .update({ takeprofit })
    .eq('broker_account_id', brokerAccountId)
    .eq('signal_id', signalId)
    .in('status', ['pending', 'claimed'])
    .select('id')
  if (error) {
    console.warn(`[rangeBasketTpSync] freeze pending TP set failed signal=${signalId}: ${error.message}`)
    return 0
  }
  return (data?.length ?? 0)
}

async function reloadSignalParsed(
  supabase: SupabaseClient,
  signalId: string,
): Promise<RangeBasketParsedSlice | null> {
  const { data } = await supabase
    .from('signals')
    .select('parsed_data')
    .eq('id', signalId)
    .maybeSingle()
  const raw = data?.parsed_data
  if (!raw || typeof raw !== 'object') return null
  return toRangeBasketParsedSlice(raw as { sl?: unknown; tp?: unknown })
}

/** Sync SL/TP on all open legs for a range-layering basket (phase-aware). */
export async function syncRangeBasketTakeProfits(args: RangeBasketTpSyncArgs): Promise<void> {
  if (args.manual.range_trading !== true) return

  const { data: familyRows, error } = await args.supabase
    .from('trades')
    .select('id,signal_id,metaapi_order_id,opened_at,lot_size,sl,tp,entry_price,direction,symbol')
    .eq('broker_account_id', args.brokerAccountId)
    .eq('signal_id', args.signalId)
    .eq('status', 'open')
    .order('opened_at', { ascending: true })
    .limit(500)
  if (error || !(familyRows ?? []).length) return

  const familyTrades = (familyRows ?? []) as BasketOpenLeg[]
  const { activePendingCount, maxPendingStepIdx } = await loadRangePendingMeta(
    args.supabase,
    args.brokerAccountId,
    args.signalId,
  )

  const anchorParsed: RangeBasketParsedSlice = { ...args.parsed }
  const effective = await resolveEffectiveBasketStops({
    supabase: args.supabase,
    userId: args.userId,
    channelId: args.channelId ?? null,
    anchorSignalId: args.signalId,
    symbol: args.symbol,
    basketCreatedAt: args.basketCreatedAt ?? familyTrades[0]?.opened_at ?? null,
    anchorParsed,
    familyTrades,
  })
  logEffectiveBasketStops('[rangeBasketTpSync]', args.signalId, effective)

  let parsed: RangeBasketParsedSlice = { ...effective.parsedSlice }
  const channelTpLevels = effective.tpLevels.length ? effective.tpLevels : null

  let finalTps = resolveRangeBasketFinalTps({
    parsed,
    plan: args.plan,
    familyTrades,
    channelTpLevels,
    direction: args.direction,
  })

  if ((!finalTps.length || finalTps.length <= 1) && args.forceLayeringRebalance) {
    await new Promise(r => setTimeout(r, 300))
    let effectiveChannelTpLevels = channelTpLevels
    if (args.channelId) {
      const reloaded = await loadScopedChannelTpLevels(args.supabase, {
        userId: args.userId,
        channelId: args.channelId,
        basketCreatedAt: args.basketCreatedAt,
        symbol: args.symbol,
      })
      if (reloaded?.length) {
        effectiveChannelTpLevels = reloaded
      }
    }
    const reloadedAnchor = await reloadSignalParsed(args.supabase, args.signalId)
    if (reloadedAnchor) {
      const reEffective = await resolveEffectiveBasketStops({
        supabase: args.supabase,
        userId: args.userId,
        channelId: args.channelId ?? null,
        anchorSignalId: args.signalId,
        symbol: args.symbol,
        basketCreatedAt: args.basketCreatedAt ?? familyTrades[0]?.opened_at ?? null,
        anchorParsed: { ...anchorParsed, ...reloadedAnchor },
        familyTrades,
      })
      parsed = { ...reEffective.parsedSlice }
    }
    finalTps = resolveRangeBasketFinalTps({
      parsed,
      plan: args.plan,
      familyTrades,
      channelTpLevels: effectiveChannelTpLevels,
      direction: args.direction,
    })
  }

  if (!finalTps.length) {
    console.warn(
      `[rangeBasketTpSync] skip rebalance — no TP ladder signal=${args.signalId}`
      + ` broker=${args.brokerAccountId} open=${familyTrades.length}`,
    )
    await logRangeBasketTpRebalance(args.supabase, {
      userId: args.userId,
      signalId: args.signalId,
      brokerAccountId: args.brokerAccountId,
      openLegs: familyTrades.length,
      phase: args.forceLayeringRebalance ? 'layering_rebalance' : 'unknown',
      forceLayeringRebalance: args.forceLayeringRebalance,
      modified: 0,
      attempted: 1,
      failed: 1,
      tpCounts: {},
    })
    return
  }

  const perLegTargets = buildRangeBasketTpTargets({
    familyTrades,
    plan: args.plan,
    parsed,
    tpLots: args.manual.tp_lots,
    direction: args.direction,
    activePendingCount,
    maxPendingStepIdx,
    forceLayeringRebalance: args.forceLayeringRebalance,
    channelTpLevels,
    finalTpsOverride: finalTps,
    stoplossOverride: effective.stoploss > 0 ? effective.stoploss : null,
  })
  if (!perLegTargets.length) return

  const planImmediateLegCount = estimatePlanImmediateLegCount({
    openLegCount: familyTrades.length,
    activePendingCount,
    maxPendingStepIdx,
    planImmediateLegCount: args.plan ? mergePlanImmediateOrders(args.plan).length : undefined,
  })
  const { phase } = resolveRangeBasketLegCounts({
    openLegCount: familyTrades.length,
    planImmediateLegCount,
    activePendingCount,
    maxPendingStepIdx,
  })
  const effectivePhase = args.forceLayeringRebalance ? 'layering_rebalance' : phase

  const hasClosedLegs = await hasClosedBasketLegs(
    args.supabase,
    args.brokerAccountId,
    args.signalId,
  )
  const tpTouched = await hasTpTouchedLock(args.supabase, {
    signalId: args.signalId,
    brokerAccountId: args.brokerAccountId,
    symbol: args.symbol,
  })
  const tpGate = resolveRangeTpRebalanceGate({
    activePendingCount,
    maxPendingStepIdx,
    phase: effectivePhase,
    forceLayeringRebalance: args.forceLayeringRebalance,
    hasClosedBasketLegs: hasClosedLegs,
    tpTouched,
  })

  let openedTickets: Set<number> | null = null
  try {
    openedTickets = await fetchOpenBrokerTickets(args.api, args.uuid)
  } catch { /* optional */ }

  const isBuy = args.direction === 'buy'
  const deepestTp = deepestFinalTp(finalTps, isBuy)
  const frozen = tpGate.mode === 'backfill_only'

  // Pending (future) range legs.
  if (frozen) {
    // A TP has been hit: future legs are "new" and must fire with the deepest
    // TP (never repaint existing open legs). Only relevant when Layer-till-close
    // keeps the ladder active.
    if (activePendingCount > 0 && deepestTp > 0) {
      try {
        await setActivePendingRangeLegsTakeProfit(
          args.supabase,
          args.brokerAccountId,
          args.signalId,
          deepestTp,
        )
      } catch (err) {
        console.warn(
          `[rangeBasketTpSync] freeze pending TP set failed signal=${args.signalId}:`,
          err instanceof Error ? err.message : String(err),
        )
      }
    }
  } else if (effectivePhase === 'layering_rebalance' && activePendingCount > 0) {
    try {
      await patchPendingRangeLegTakeProfits({
        supabase: args.supabase,
        brokerAccountId: args.brokerAccountId,
        signalId: args.signalId,
        isBuy,
        finalTps,
        tpLots: args.manual.tp_lots,
        openLegs: familyTrades.map(toEntryQualityLeg),
      })
    } catch (err) {
      console.warn(
        `[rangeBasketTpSync] pending TP patch failed signal=${args.signalId}:`,
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  // Open-leg targets: redistribute by % while layering (no TP hit), otherwise
  // freeze existing TPs and only backfill naked legs with the deepest TP.
  const openLegTargets = frozen
    ? backfillNakedLegTakeProfits(familyTrades, perLegTargets, finalTps, isBuy)
    : fillZeroTargetsWithDeepest(perLegTargets, finalTps, isBuy)

  const tpCounts: Record<string, number> = {}
  for (const target of openLegTargets) {
    const key = String(target.takeprofit)
    tpCounts[key] = (tpCounts[key] ?? 0) + 1
  }

  let modifyResult: Awaited<ReturnType<typeof runBasketLegModifies>> | null = null
  const internalRebalance = effectivePhase === 'layering_rebalance'
  let sharedQuote: { bid: number; ask: number } | null = null
  try {
    sharedQuote = await args.api.quote(args.uuid, args.symbol)
  } catch { /* per-leg fallback inside runBasketLegModifies */ }
  const runModifyPass = (
    trades: BasketOpenLeg[],
    targets: PerLegStopTargetLike[],
  ) => runBasketLegModifies({
    supabase: args.supabase,
    api: args.api,
    uuid: args.uuid,
    symbol: args.symbol,
    direction: args.direction,
    baseLot: args.baseLot,
    params: args.params,
    signalId: args.signalId,
    userId: args.userId,
    brokerAccountId: args.brokerAccountId,
    familyTrades: trades,
    perLegTargets: targets,
    signalTps: finalTps,
    tpLots: args.manual.tp_lots,
    nImmCwe: 0,
    overrideTp: null,
    strictEntryPrefetch: sharedQuote,
    openedTickets,
    skipAlreadySynced: true,
    parallelLegs: true,
    internalRebalance,
    effectiveStoploss: effective.stoploss > 0 ? effective.stoploss : undefined,
    orderCommentsEnabled: args.manual.order_comments_enabled !== false,
  })

  // Always run a modify pass: in frozen mode this only touches naked legs (and
  // SL propagation); synced legs are skipped by stopsAlreadyMatch.
  try {
    modifyResult = await runModifyPass(familyTrades, openLegTargets)

    if (modifyResult.summary.failed > 0 && modifyResult.legErrors.length > 0) {
      await new Promise(r => setTimeout(r, Number(process.env.RANGE_REBALANCE_RETRY_DELAY_MS ?? 300)))
      const failedIds = new Set(modifyResult.legErrors.map(e => e.trade_id))
      const retryTrades = familyTrades.filter(t => failedIds.has(t.id))
      const retryTargets = retryTrades.map(t => {
        const idx = familyTrades.findIndex(f => f.id === t.id)
        return openLegTargets[idx]!
      })
      if (retryTrades.length > 0) {
        const retryResult = await runModifyPass(retryTrades, retryTargets)
        modifyResult = {
          summary: {
            openLegs: familyTrades.length,
            attempted: modifyResult.summary.attempted + retryResult.summary.attempted,
            modified: modifyResult.summary.modified + retryResult.summary.modified,
            failed: retryResult.summary.failed,
            skippedNoTicket: retryResult.summary.skippedNoTicket,
            skippedNotOnBroker: retryResult.summary.skippedNotOnBroker,
            skippedUnfixable: (modifyResult.summary.skippedUnfixable ?? 0)
              + (retryResult.summary.skippedUnfixable ?? 0),
          },
          legErrors: retryResult.legErrors,
          modifiedTradeIds: [
            ...new Set([...modifyResult.modifiedTradeIds, ...retryResult.modifiedTradeIds]),
          ],
        }
      }
    }
  } catch (err) {
    console.warn(
      `[rangeBasketTpSync] leg modify failed signal=${args.signalId} broker=${args.brokerAccountId}:`,
      err instanceof Error ? err.message : String(err),
    )
  }

  await logRangeBasketTpRebalance(args.supabase, {
    userId: args.userId,
    signalId: args.signalId,
    brokerAccountId: args.brokerAccountId,
    openLegs: familyTrades.length,
    phase: effectivePhase,
    forceLayeringRebalance: args.forceLayeringRebalance,
    modified: modifyResult?.summary.modified ?? 0,
    attempted: modifyResult?.summary.attempted ?? 0,
    failed: modifyResult?.summary.failed ?? 0,
    tpCounts,
    effectiveSl: effective.stoploss,
    effectiveSlSource: effective.source,
    skippedReason: frozen ? tpGate.reason : undefined,
  })

  if (modifyResult && modifyResult.summary.modified > 0) {
    console.log(
      `[rangeBasketTpSync] rebalanced signal=${args.signalId} broker=${args.brokerAccountId}`
      + ` open=${familyTrades.length} phase=${effectivePhase}`
      + ` modified=${modifyResult.summary.modified}/${modifyResult.summary.attempted}`,
    )
  }
}
