/**
 * Persist and apply channel-level SL/TP from management / parameter refresh.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { symbolsCompatibleForBasket } from './basketModFollowUp'
import { takeProfitForPoolLegIndex } from './manualPlanning/tpBucketDistribution'
import { parsedHasExplicitEntryAnchor } from './manualPlanning/parsedEntry'
import type { ManualTpLot, ParsedSignal, VirtualPendingLeg } from './manualPlanning/types'

export type ChannelActiveTradeParams = {
  symbol: string
  stoploss: number | null
  tpLevels: number[]
  /** Last write time — used to detect memory left over from an older trade cycle. */
  updatedAt?: string | null
}

/**
 * Channel memory written before the basket's anchor signal belongs to an older
 * trade cycle (e.g. SL/TP from last week's signal). Applying it to a fresh
 * basket produces wrong-side stops the broker rejects as "Invalid stops".
 */
export function channelParamsPredateBasket(
  params: ChannelActiveTradeParams | null | undefined,
  basketCreatedAt: string | null | undefined,
): boolean {
  if (!params?.updatedAt || !basketCreatedAt) return false
  const updated = Date.parse(params.updatedAt)
  const anchor = Date.parse(basketCreatedAt)
  if (!Number.isFinite(updated) || !Number.isFinite(anchor)) return false
  return updated < anchor
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
    .select('symbol,stoploss,tp_levels,updated_at')
    .eq('user_id', userId)
    .eq('channel_id', channelId)
    .limit(200)
  if (error) {
    console.warn(`[channelActiveTradeParams] load failed: ${error.message}`)
    return null
  }
  const rows = (data ?? []) as {
    symbol: string
    stoploss: number | null
    tp_levels: number[]
    updated_at: string | null
  }[]
  const match = rows.find(r => symbolsCompatibleForBasket(symbolHint, r.symbol))
  if (!match) return null
  return {
    symbol: match.symbol,
    stoploss: positiveLevel(match.stoploss),
    tpLevels: normalizeTpLevels(match.tp_levels),
    updatedAt: match.updated_at ?? null,
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
    /** When true, write supplied SL/TP directly — do not fall back to existing row values. */
    replace?: boolean
  },
): Promise<void> {
  const { userId, channelId, symbols, stoploss, tpLevels, replace = false } = args
  const sl = stoploss != null ? positiveLevel(stoploss) : null
  const tps = tpLevels != null ? normalizeTpLevels(tpLevels) : null
  if (sl == null && (tps == null || tps.length === 0)) return
  if (!symbols.length) return

  const now = new Date().toISOString()
  for (const sym of symbols) {
    const key = sym.trim()
    if (!key) continue

    const existing = await loadChannelActiveTradeParamsForSymbol(supabase, userId, channelId, key)
    const hasExplicitSl = sl != null
    const hasExplicitTps = tps != null && tps.length > 0
    const row = {
      user_id: userId,
      channel_id: channelId,
      symbol: existing?.symbol ?? key.toUpperCase(),
      stoploss: replace && hasExplicitSl
        ? sl
        : (sl ?? existing?.stoploss ?? null),
      tp_levels: replace && hasExplicitTps
        ? tps!
        : (tps != null && tps.length > 0 ? tps : (existing?.tpLevels ?? [])),
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
 * True for a buy/sell that carries its own entry anchor and SL/TP — a full new entry,
 * not an SL/TP-only parameter follow-up. Stale channel memory must not overlay these.
 */
export function isFullEntrySignalWithStops(parsed: ParsedSignal): boolean {
  const act = String(parsed.action ?? '').toLowerCase()
  if (act !== 'buy' && act !== 'sell') return false
  if (!parsedHasExplicitEntryAnchor(parsed)) return false
  return parsedSignalHasExplicitStops(parsed)
}

/**
 * Full entries with explicit SL/TP must win over stale `channel_active_trade_params`.
 * Use before overlaying channel memory during basket merge / refresh (not raw entry dispatch).
 */
export function shouldPreferSignalStopsOverChannelMemory(parsed: ParsedSignal): boolean {
  return isFullEntrySignalWithStops(parsed)
}

/**
 * Entry dispatch: any buy/sell that includes SL/TP in the parsed message must win over
 * channel memory. Unlike {@link shouldPreferSignalStopsOverChannelMemory}, does not
 * require an entry price/zone — "buy now" + SL must not inherit a prior Adjust SL.
 */
export function shouldPreferParsedStopsOnEntry(parsed: ParsedSignal): boolean {
  const act = String(parsed.action ?? '').toLowerCase()
  if (act !== 'buy' && act !== 'sell') return false
  return parsedSignalHasExplicitStops(parsed)
}

/**
 * True when basket merge / refresh may overlay channel memory onto parsed stops.
 */
export function shouldOverlayChannelParamsOnBasketRefresh(
  parsed: ParsedSignal,
  logAction: 'merge_routed_modify_only' | 'signal_merge_into_open_trade',
): boolean {
  if (logAction !== 'signal_merge_into_open_trade') return false
  // "Gold buy now" + SL/TP must not inherit stale Adjust SL from channel memory.
  if (shouldPreferParsedStopsOnEntry(parsed)) return false
  return !shouldPreferSignalStopsOverChannelMemory(parsed)
}

/** Upsert channel memory from signal stops (no overlay). For live-entry fast path. */
export async function refreshChannelParamsFromSignal(
  supabase: SupabaseClient,
  args: {
    userId: string
    channelId: string
    symbol: string
    plannerParsed: ParsedSignal
    replace?: boolean
  },
): Promise<ChannelActiveTradeParams | null> {
  if (!parsedSignalHasExplicitStops(args.plannerParsed)) return null
  const refreshTpLevels = (args.plannerParsed.tp ?? []).filter(
    (t): t is number => typeof t === 'number' && Number.isFinite(t) && t > 0,
  )
  await upsertChannelActiveTradeParams(supabase, {
    userId: args.userId,
    channelId: args.channelId,
    symbols: [args.symbol],
    stoploss: args.plannerParsed.sl,
    tpLevels: refreshTpLevels,
    replace: args.replace ?? shouldPreferParsedStopsOnEntry(args.plannerParsed),
  })
  return loadChannelActiveTradeParamsForSymbol(
    supabase,
    args.userId,
    args.channelId,
    args.symbol,
  )
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

export type ClearChannelActiveParamsResult = {
  cleared: boolean
  deletedSymbols: string[]
}

/** Open trades or pendings on this channel+symbol across all broker accounts. */
export async function channelHasOpenActivityForChannelSymbol(
  supabase: SupabaseClient,
  args: {
    userId: string
    channelId: string
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
    .in('status', ['open', 'pending'])
    .in('signal_id', signalIds)
    .limit(500)
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
    .in('signal_id', signalIds)
    .in('status', ['pending', 'claimed'])
    .limit(500)
  if (
    (pending ?? []).some((l: { symbol: string }) =>
      symbolsCompatibleForBasket(args.symbolHint, l.symbol),
    )
  ) {
    return true
  }

  const { data: entryPending } = await supabase
    .from('signal_entry_pending_orders')
    .select('symbol')
    .in('signal_id', signalIds)
    .eq('status', 'broker_pending')
    .limit(500)
  return (entryPending ?? []).some((r: { symbol: string }) =>
    symbolsCompatibleForBasket(args.symbolHint, r.symbol),
  )
}

/** Delete channel SL/TP memory when no open activity remains for the symbol family. */
export async function clearChannelActiveTradeParamsWhenFlat(
  supabase: SupabaseClient,
  args: {
    userId: string
    channelId: string
    symbolHint: string
  },
): Promise<ClearChannelActiveParamsResult> {
  const hasActivity = await channelHasOpenActivityForChannelSymbol(supabase, args)
  if (hasActivity) {
    return { cleared: false, deletedSymbols: [] }
  }

  const { data: rows, error } = await supabase
    .from('channel_active_trade_params')
    .select('symbol')
    .eq('user_id', args.userId)
    .eq('channel_id', args.channelId)
  if (error) {
    console.warn(`[channelActiveTradeParams] clear load failed: ${error.message}`)
    return { cleared: false, deletedSymbols: [] }
  }

  const toDelete = (rows ?? []).filter((r: { symbol: string }) =>
    symbolsCompatibleForBasket(args.symbolHint, r.symbol),
  )
  if (!toDelete.length) {
    return { cleared: false, deletedSymbols: [] }
  }

  const deletedSymbols: string[] = []
  for (const row of toDelete) {
    const sym = row.symbol
    const { error: delErr } = await supabase
      .from('channel_active_trade_params')
      .delete()
      .eq('user_id', args.userId)
      .eq('channel_id', args.channelId)
      .eq('symbol', sym)
    if (!delErr) {
      deletedSymbols.push(sym)
    } else {
      console.warn(`[channelActiveTradeParams] delete ${sym} failed: ${delErr.message}`)
    }
  }

  if (deletedSymbols.length) {
    console.log(
      `[channelActiveTradeParams] cleared channel=${args.channelId}`
      + ` symbol_hint=${args.symbolHint} deleted=${deletedSymbols.join(',')}`,
    )
  }

  return { cleared: deletedSymbols.length > 0, deletedSymbols }
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
    signalId?: string | null
  },
): Promise<EntryChannelStopsResult> {
  const hasActiveBasket = await channelHasOpenActivityForSymbol(supabase, {
    userId: args.userId,
    channelId: args.channelId,
    brokerAccountId: args.brokerAccountId,
    symbolHint: args.symbol,
  })

  if (!hasActiveBasket) {
    await clearChannelActiveTradeParamsWhenFlat(supabase, {
      userId: args.userId,
      channelId: args.channelId,
      symbolHint: args.symbol,
    })
  }

  const channelParams = await loadChannelActiveTradeParamsForSymbol(
    supabase,
    args.userId,
    args.channelId,
    args.symbol,
  )

  let plannerParsed = args.plannerParsed
  let mergedChannelParams = false
  const preferSignalStops = shouldPreferParsedStopsOnEntry(plannerParsed)
  const applyOverlay = hasActiveBasket && channelParams != null && !preferSignalStops

  if (applyOverlay) {
    console.log(
      `[channelActiveTradeParams] overlay applied signal=${args.signalId ?? 'n/a'}`
      + ` broker=${args.brokerAccountId} channel=${args.channelId}`
      + ` signal_sl=${plannerParsed.sl ?? 'n/a'} channel_sl=${channelParams!.stoploss ?? 'n/a'}`,
    )
    plannerParsed = mergeParsedWithChannelParams(plannerParsed, channelParams, { overlay: true })
    mergedChannelParams = true
  } else if (hasActiveBasket && channelParams && preferSignalStops) {
    console.log(
      `[channelActiveTradeParams] overlay skipped full entry signal=${args.signalId ?? 'n/a'}`
      + ` broker=${args.brokerAccountId} channel=${args.channelId}`
      + ` signal_sl=${plannerParsed.sl ?? 'n/a'} channel_sl=${channelParams.stoploss ?? 'n/a'}`,
    )
  }

  if (parsedSignalHasExplicitStops(plannerParsed)) {
    const refreshTpLevels = (plannerParsed.tp ?? []).filter(
      (t): t is number => typeof t === 'number' && Number.isFinite(t) && t > 0,
    )
    await upsertChannelActiveTradeParams(supabase, {
      userId: args.userId,
      channelId: args.channelId,
      symbols: [args.symbol],
      stoploss: plannerParsed.sl,
      tpLevels: refreshTpLevels,
      replace: preferSignalStops,
    })
  } else if (channelParams && hasActiveBasket && !applyOverlay) {
    plannerParsed = mergeParsedWithChannelParams(plannerParsed, channelParams)
    mergedChannelParams = true
  }

  const refreshedParams = await loadChannelActiveTradeParamsForSymbol(
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
  /** When set, use these stops instead of loading channel memory from DB. */
  paramsOverride?: ChannelActiveTradeParams | null
}): Promise<number> {
  const params = args.paramsOverride ?? await loadChannelActiveTradeParamsForSymbol(
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
