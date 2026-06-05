/**
 * Persist and apply channel-level SL/TP from management / parameter refresh.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { symbolsCompatibleForBasket } from './basketModFollowUp'
import { takeProfitForPoolLegIndex } from './manualPlanning/tpBucketDistribution'
import type { ManualTpLot, ParsedSignal, VirtualPendingLeg } from './manualPlanning/types'

export type ChannelActiveTradeParams = {
  symbol: string
  stoploss: number | null
  tpLevels: number[]
}

export type VirtualLegStops = {
  stoploss: number | null | undefined
  takeprofit: number | null | undefined
}

function positiveLevel(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v ?? 0)
  return Number.isFinite(n) && n > 0 ? n : null
}

function normalizeTpLevels(tp: unknown): number[] {
  if (!Array.isArray(tp)) return []
  return tp.filter((t): t is number => positiveLevel(t) != null) as number[]
}

export function symbolsForChannelParamsPersist(args: {
  symbolFromText: string | null | undefined
  tradeSymbols: string[]
  pendingSymbols: string[]
}): string[] {
  const out = new Set<string>()
  const hint = args.symbolFromText?.trim()
  if (hint) out.add(hint)
  for (const s of [...args.tradeSymbols, ...args.pendingSymbols]) {
    const t = s?.trim()
    if (t) out.add(t)
  }
  return [...out]
}

export async function loadChannelActiveTradeParamsForSymbol(
  supabase: SupabaseClient,
  userId: string,
  channelId: string,
  symbolHint: string,
): Promise<ChannelActiveTradeParams | null> {
  const { data, error } = await supabase
    .from('channel_active_trade_params')
    .select('symbol,stoploss,tp_levels')
    .eq('user_id', userId)
    .eq('channel_id', channelId)
    .limit(200)
  if (error) {
    console.warn(`[channelActiveTradeParams] load failed: ${error.message}`)
    return null
  }
  const rows = (data ?? []) as { symbol: string; stoploss: number | null; tp_levels: number[] }[]
  const match = rows.find(r => symbolsCompatibleForBasket(symbolHint, r.symbol))
  if (!match) return null
  return {
    symbol: match.symbol,
    stoploss: positiveLevel(match.stoploss),
    tpLevels: normalizeTpLevels(match.tp_levels),
  }
}

export async function upsertChannelActiveTradeParams(
  supabase: SupabaseClient,
  args: {
    userId: string
    channelId: string
    symbols: string[]
    stoploss?: number | null
    tpLevels?: number[]
  },
): Promise<void> {
  const { userId, channelId, symbols, stoploss, tpLevels } = args
  const sl = stoploss != null ? positiveLevel(stoploss) : null
  const tps = tpLevels != null ? normalizeTpLevels(tpLevels) : null
  if (sl == null && (tps == null || tps.length === 0)) return
  if (!symbols.length) return

  const now = new Date().toISOString()
  for (const sym of symbols) {
    const key = sym.trim()
    if (!key) continue

    const existing = await loadChannelActiveTradeParamsForSymbol(supabase, userId, channelId, key)
    const row = {
      user_id: userId,
      channel_id: channelId,
      symbol: existing?.symbol ?? key.toUpperCase(),
      stoploss: sl ?? existing?.stoploss ?? null,
      tp_levels: tps != null && tps.length > 0 ? tps : (existing?.tpLevels ?? []),
      updated_at: now,
    }
    const { error } = await supabase
      .from('channel_active_trade_params')
      .upsert(row, { onConflict: 'user_id,channel_id,symbol' })
    if (error) {
      console.warn(`[channelActiveTradeParams] upsert ${key} failed: ${error.message}`)
    }
  }
}

/** True when the Telegram message itself included SL and/or TP (not channel memory). */
export function parsedSignalHasExplicitStops(parsed: ParsedSignal): boolean {
  const hasSl = positiveLevel(parsed.sl) != null
  const hasTp = (parsed.tp ?? []).some(t => positiveLevel(t) != null)
  return hasSl || hasTp
}

/**
 * Channel memory from Adjust SL applies to management + pending ladder refresh,
 * not naked "buy/sell" posts — otherwise stale levels cause "Invalid stops".
 */
export function shouldMergeChannelParamsForEntry(parsed: ParsedSignal): boolean {
  return parsedSignalHasExplicitStops(parsed)
}

/** Open trades or active range pendings on this channel+broker for the symbol family. */
export async function channelHasOpenActivityForSymbol(
  supabase: SupabaseClient,
  args: {
    userId: string
    channelId: string
    brokerAccountId: string
    symbolHint: string
  },
): Promise<boolean> {
  const { data: sigs, error: sigErr } = await supabase
    .from('signals')
    .select('id')
    .eq('user_id', args.userId)
    .eq('channel_id', args.channelId)
    .limit(2000)
  if (sigErr || !sigs?.length) return false

  const signalIds = sigs.map((r: { id: string }) => r.id)

  const { data: trades } = await supabase
    .from('trades')
    .select('symbol')
    .eq('user_id', args.userId)
    .eq('broker_account_id', args.brokerAccountId)
    .eq('status', 'open')
    .in('signal_id', signalIds)
    .limit(200)
  if (
    (trades ?? []).some((t: { symbol: string }) =>
      symbolsCompatibleForBasket(args.symbolHint, t.symbol),
    )
  ) {
    return true
  }

  const { data: pending } = await supabase
    .from('range_pending_legs')
    .select('symbol')
    .eq('user_id', args.userId)
    .eq('broker_account_id', args.brokerAccountId)
    .in('signal_id', signalIds)
    .in('status', ['pending', 'claimed'])
    .limit(200)
  return (pending ?? []).some((l: { symbol: string }) =>
    symbolsCompatibleForBasket(args.symbolHint, l.symbol),
  )
}

/**
 * When a basket is already live, stale SL/TP copied from the provider template must not
 * overwrite Adjust SL memory or seed new range legs.
 */
export function shouldSeedChannelParamsFromEntrySignal(hasActiveBasket: boolean): boolean {
  return !hasActiveBasket
}

export type EntryChannelStopsResult = {
  plannerParsed: ParsedSignal
  mergedChannelParams: boolean
  channelParams: ChannelActiveTradeParams | null
}

/** Resolve planner SL/TP for a new entry: prefer channel memory when basket is active. */
export async function resolveEntryChannelStops(
  supabase: SupabaseClient,
  args: {
    userId: string
    channelId: string
    brokerAccountId: string
    symbol: string
    plannerParsed: ParsedSignal
  },
): Promise<EntryChannelStopsResult> {
  const channelParams = await loadChannelActiveTradeParamsForSymbol(
    supabase,
    args.userId,
    args.channelId,
    args.symbol,
  )
  const hasActiveBasket = await channelHasOpenActivityForSymbol(supabase, {
    userId: args.userId,
    channelId: args.channelId,
    brokerAccountId: args.brokerAccountId,
    symbolHint: args.symbol,
  })

  let plannerParsed = args.plannerParsed
  let mergedChannelParams = false

  if (hasActiveBasket && channelParams) {
    plannerParsed = mergeParsedWithChannelParams(plannerParsed, channelParams, { overlay: true })
    mergedChannelParams = true
  } else if (parsedSignalHasExplicitStops(plannerParsed)) {
    const refreshTpLevels = (plannerParsed.tp ?? []).filter(
      (t): t is number => typeof t === 'number' && Number.isFinite(t) && t > 0,
    )
    await upsertChannelActiveTradeParams(supabase, {
      userId: args.userId,
      channelId: args.channelId,
      symbols: [args.symbol],
      stoploss: plannerParsed.sl,
      tpLevels: refreshTpLevels,
    })
  } else if (channelParams) {
    plannerParsed = mergeParsedWithChannelParams(plannerParsed, channelParams)
    mergedChannelParams = true
  }

  const refreshedParams = mergedChannelParams
    ? channelParams
    : await loadChannelActiveTradeParamsForSymbol(
        supabase,
        args.userId,
        args.channelId,
        args.symbol,
      )

  return {
    plannerParsed,
    mergedChannelParams,
    channelParams: refreshedParams,
  }
}

/** Overlay channel SL/TP onto parsed signal before planning orders / virtual pendings. */
export function mergeParsedWithChannelParams(
  parsed: ParsedSignal,
  params: ChannelActiveTradeParams | null,
  opts?: { overlay?: boolean },
): ParsedSignal {
  if (!params) return parsed
  const next: ParsedSignal = {
    ...parsed,
    tp: parsed.tp ? [...parsed.tp] : parsed.tp,
  }
  const hasSl = positiveLevel(parsed.sl) != null
  const hasTp = (parsed.tp ?? []).some(t => positiveLevel(t) != null)
  if (opts?.overlay) {
    if (params.stoploss != null) next.sl = params.stoploss
    if (params.tpLevels.length > 0) next.tp = [...params.tpLevels]
    return next
  }
  if (!hasSl && params.stoploss != null) next.sl = params.stoploss
  if (!hasTp && params.tpLevels.length > 0) next.tp = [...params.tpLevels]
  return next
}

/** Drop SL/TP on the wrong side of the fill reference (broker rejects as invalid stops). */
export function stripInvalidStopsForSide(args: {
  stoploss: number
  takeprofit: number
  referencePrice: number
  isBuy: boolean
}): { stoploss: number; takeprofit: number; stripped: string[] } {
  const { referencePrice, isBuy } = args
  const ref = referencePrice
  if (!Number.isFinite(ref) || ref <= 0) {
    return { stoploss: args.stoploss, takeprofit: args.takeprofit, stripped: [] }
  }
  let stoploss = args.stoploss
  let takeprofit = args.takeprofit
  const stripped: string[] = []
  if (stoploss > 0) {
    const bad = isBuy ? stoploss >= ref : stoploss <= ref
    if (bad) {
      stripped.push(`sl ${stoploss}`)
      stoploss = 0
    }
  }
  if (takeprofit > 0) {
    const bad = isBuy ? takeprofit <= ref : takeprofit >= ref
    if (bad) {
      stripped.push(`tp ${takeprofit}`)
      takeprofit = 0
    }
  }
  return { stoploss, takeprofit, stripped }
}

export function estimateBasketTotalPlannedLegs(args: {
  openLegCount: number
  activePendingCount: number
  maxPendingStepIdx: number
}): number {
  const { openLegCount, activePendingCount, maxPendingStepIdx } = args
  if (maxPendingStepIdx <= 0) return Math.max(0, openLegCount)
  const firedPendingApprox = Math.max(0, maxPendingStepIdx - activePendingCount)
  const immediateLegCount = Math.max(0, openLegCount - firedPendingApprox)
  return immediateLegCount + maxPendingStepIdx
}

export function globalLegIndexForRangePending(args: {
  immediateLegCount: number
  stepIdx: number
}): number {
  return Math.max(0, args.immediateLegCount + args.stepIdx - 1)
}

export function resolvePendingLegTp(args: {
  stepIdx: number
  rangeLegCount: number
  channelTpLevels: number[]
  tpLots?: ManualTpLot[] | null
  fallbackTp: number | null | undefined
}): number | null {
  const { stepIdx, rangeLegCount, channelTpLevels, tpLots, fallbackTp } = args
  if (!channelTpLevels.length) return positiveLevel(fallbackTp)
  const rangeLegIndex = Math.max(0, stepIdx - 1)
  const distributed = takeProfitForPoolLegIndex({
    poolLegIndex: rangeLegIndex,
    poolLegCount: Math.max(rangeLegCount, rangeLegIndex + 1),
    finalTps: channelTpLevels,
    tpLots,
  })
  if (distributed > 0) return distributed
  return channelTpLevels[channelTpLevels.length - 1] ?? positiveLevel(fallbackTp)
}

export function applyChannelParamsToVirtualPendingList(
  legs: VirtualPendingLeg[],
  params: ChannelActiveTradeParams | null,
  _immediateLegCount: number,
  tpLots?: ManualTpLot[] | null,
  _totalPlannedLegCount?: number,
): VirtualPendingLeg[] {
  if (!params) return legs
  const rangeLegCount = legs.length
  return legs.map(v => {
    const stops = applyChannelParamsToVirtualLeg(v, params, {
      rangeLegIndex: Math.max(0, v.stepIdx - 1),
      rangeLegCount,
      tpLots,
    })
    return {
      ...v,
      stoploss: stops.stoploss ?? v.stoploss,
      takeprofit: stops.takeprofit ?? v.takeprofit,
    }
  })
}

export function applyChannelParamsToVirtualLeg(
  leg: VirtualLegStops,
  params: ChannelActiveTradeParams | null,
  args: { rangeLegIndex: number; rangeLegCount: number; tpLots?: ManualTpLot[] | null },
): VirtualLegStops {
  if (!params) return leg
  let stoploss = leg.stoploss
  let takeprofit = leg.takeprofit
  if (params.stoploss != null) stoploss = params.stoploss
  if (params.tpLevels.length > 0) {
    takeprofit = resolvePendingLegTp({
      stepIdx: args.rangeLegIndex + 1,
      rangeLegCount: args.rangeLegCount,
      channelTpLevels: params.tpLevels,
      tpLots: args.tpLots,
      fallbackTp: leg.takeprofit,
    })
  }
  return { stoploss, takeprofit }
}

export async function reapplyChannelParamsToPendingLegs(args: {
  supabase: SupabaseClient
  userId: string
  channelId: string
  brokerAccountIds: string[]
  symbolHint: string
  signalIds?: string[] | null
  tpLotsByBroker: Map<string, ManualTpLot[] | null | undefined>
  openLegCountByBasket: Map<string, number>
}): Promise<number> {
  const params = await loadChannelActiveTradeParamsForSymbol(
    args.supabase,
    args.userId,
    args.channelId,
    args.symbolHint,
  )
  if (!params || (params.stoploss == null && params.tpLevels.length === 0)) return 0

  let signalIds = args.signalIds ?? null
  if (!signalIds?.length) {
    const { data: sigs } = await args.supabase
      .from('signals')
      .select('id')
      .eq('user_id', args.userId)
      .eq('channel_id', args.channelId)
      .limit(5000)
    signalIds = (sigs ?? []).map((r: { id: string }) => r.id)
    if (!signalIds.length) return 0
  }

  let query = args.supabase
    .from('range_pending_legs')
    .select('id,signal_id,broker_account_id,symbol,step_idx,stoploss,takeprofit,cwe_close_price,status')
    .eq('user_id', args.userId)
    .in('broker_account_id', args.brokerAccountIds)
    .in('signal_id', signalIds)
    .in('status', ['pending', 'claimed'])
    .limit(500)

  const { data, error } = await query
  if (error) {
    console.warn(`[channelActiveTradeParams] pending load failed: ${error.message}`)
    return 0
  }

  let updated = 0
  const pendingByBasket = new Map<string, typeof data>()
  for (const leg of data ?? []) {
    const basketKey = `${leg.signal_id}|${leg.broker_account_id}`
    const list = pendingByBasket.get(basketKey) ?? []
    list.push(leg)
    pendingByBasket.set(basketKey, list)
  }

  for (const leg of data ?? []) {
    if (!symbolsCompatibleForBasket(args.symbolHint, leg.symbol)) continue
    const basketKey = `${leg.signal_id}|${leg.broker_account_id}`
    const basketPending = pendingByBasket.get(basketKey) ?? [leg]
    const maxStepIdx = Math.max(...basketPending.map(row => row.step_idx), 0)
    const tpLots = args.tpLotsByBroker.get(leg.broker_account_id)
    const applied = applyChannelParamsToVirtualLeg(
      { stoploss: leg.stoploss, takeprofit: leg.takeprofit },
      params,
      {
        rangeLegIndex: Math.max(0, leg.step_idx - 1),
        rangeLegCount: maxStepIdx,
        tpLots,
      },
    )
    const patch: Record<string, unknown> = {
      stoploss: applied.stoploss,
      takeprofit: leg.cwe_close_price != null ? null : applied.takeprofit,
    }
    const { error: upErr } = await args.supabase
      .from('range_pending_legs')
      .update(patch)
      .eq('id', leg.id)
      .in('status', ['pending', 'claimed'])
    if (!upErr) updated++
  }
  return updated
}
