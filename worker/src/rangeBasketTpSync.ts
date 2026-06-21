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

export type RangeTpRebalanceGateResult = {
  allowOpenLegTpModify: boolean
  reason: string
}

/** When open-leg TP redistribution is allowed for range baskets. */
export function resolveRangeTpRebalanceGate(args: {
  activePendingCount: number
  maxPendingStepIdx: number
  phase: RangeBasketTpPhase
  forceLayeringRebalance?: boolean
  hasClosedBasketLegs: boolean
}): RangeTpRebalanceGateResult {
  if (args.forceLayeringRebalance === true) {
    return { allowOpenLegTpModify: true, reason: 'force_layering_rebalance' }
  }
  if (args.phase === 'instant_only') {
    return { allowOpenLegTpModify: true, reason: 'instant_only' }
  }
  if (args.hasClosedBasketLegs) {
    return { allowOpenLegTpModify: false, reason: 'basket_leg_closed' }
  }
  if (args.activePendingCount === 0 && args.maxPendingStepIdx > 0) {
    return { allowOpenLegTpModify: false, reason: 'layering_complete' }
  }
  return { allowOpenLegTpModify: false, reason: 'layering_rebalance_frozen' }
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
  const tpGate = resolveRangeTpRebalanceGate({
    activePendingCount,
    maxPendingStepIdx,
    phase: effectivePhase,
    forceLayeringRebalance: args.forceLayeringRebalance,
    hasClosedBasketLegs: hasClosedLegs,
  })

  let openedTickets: Set<number> | null = null
  try {
    openedTickets = await fetchOpenBrokerTickets(args.api, args.uuid)
  } catch { /* optional */ }

  const isBuy = args.direction === 'buy'

  if (effectivePhase === 'layering_rebalance' && activePendingCount > 0) {
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

  const tpCounts: Record<string, number> = {}
  for (const target of perLegTargets) {
    const key = String(target.takeprofit)
    tpCounts[key] = (tpCounts[key] ?? 0) + 1
  }

  let modifyResult: Awaited<ReturnType<typeof runBasketLegModifies>> | null = null
  const internalRebalance = effectivePhase === 'layering_rebalance'
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
    strictEntryPrefetch: null,
    openedTickets,
    skipAlreadySynced: true,
    internalRebalance,
    effectiveStoploss: effective.stoploss > 0 ? effective.stoploss : undefined,
    orderCommentsEnabled: args.manual.order_comments_enabled !== false,
  })

  if (!tpGate.allowOpenLegTpModify) {
    console.log(
      `[rangeBasketTpSync] skip open-leg TP modify signal=${args.signalId}`
      + ` broker=${args.brokerAccountId} reason=${tpGate.reason}`,
    )
  } else {
  try {
    modifyResult = await runModifyPass(familyTrades, perLegTargets)

    if (args.forceLayeringRebalance && modifyResult.summary.failed > 0 && modifyResult.legErrors.length > 0) {
      await new Promise(r => setTimeout(r, 750))
      const failedIds = new Set(modifyResult.legErrors.map(e => e.trade_id))
      const retryTrades = familyTrades.filter(t => failedIds.has(t.id))
      const retryTargets = retryTrades.map(t => {
        const idx = familyTrades.findIndex(f => f.id === t.id)
        return perLegTargets[idx]!
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
    skippedReason: tpGate.allowOpenLegTpModify ? undefined : tpGate.reason,
  })

  if (modifyResult && modifyResult.summary.modified > 0) {
    console.log(
      `[rangeBasketTpSync] rebalanced signal=${args.signalId} broker=${args.brokerAccountId}`
      + ` open=${familyTrades.length} phase=${effectivePhase}`
      + ` modified=${modifyResult.summary.modified}/${modifyResult.summary.attempted}`,
    )
  }
}
