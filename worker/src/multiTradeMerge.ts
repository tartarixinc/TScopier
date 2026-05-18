/**
 * Deterministic multi-trade basket merge: parameter follow-ups refresh SL/TP on the
 * latest open basket (same channel + symbol + direction) without opening new trades.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { OrderSendArgs } from './metatraderapi'
import type { PlannerResult } from './manualPlanner'
import { parsedHasExplicitEntryAnchor } from './manualPlanner'
import { buildDistributedPerLegTakeProfits } from './manualPlanning/tpBucketDistribution'
import type { ManualTpLot } from './manualPlanning/types'
import { symbolsCompatibleForBasket } from './basketModFollowUp'

export type ParsedSignalLike = {
  action?: string
  symbol?: string | null
  sl?: number | null
  tp?: number[] | null
  entry_price?: number | null
  entry_zone_low?: number | null
  entry_zone_high?: number | null
}

export type LatestBasketAnchor = {
  anchorSignalId: string
  channelId: string | null
  newestOpenedAt: string
}

export type PerLegStopTarget = {
  stoploss: number
  takeprofit: number
}

export type MergeModifySummary = {
  openLegs: number
  attempted: number
  modified: number
  failed: number
  skippedNoTicket: number
}

/** True when the parsed message includes SL and/or TP price levels. */
export function parsedHasSlOrTp(parsed: ParsedSignalLike): boolean {
  const hasSl = typeof parsed.sl === 'number' && Number.isFinite(parsed.sl) && parsed.sl > 0
  const hasTp = Array.isArray(parsed.tp)
    && parsed.tp.some(t => typeof t === 'number' && Number.isFinite(t) && (t as number) > 0)
  return hasSl || hasTp
}

/** @alias {@link parsedHasSlOrTp} */
export function isParameterFollowUpSignal(parsed: ParsedSignalLike): boolean {
  return parsedHasSlOrTp(parsed)
}

/**
 * True when this signal should refresh SL/TP on an existing basket (modify-only),
 * not open a new trade. False for one-shot entry alerts (priced entry or bare NOW).
 */
export function shouldRouteAsBasketParameterRefresh(parsed: ParsedSignalLike): boolean {
  if (!parsedHasSlOrTp(parsed)) return false
  const act = String(parsed.action ?? '').toLowerCase()
  if (act === 'modify') return true
  if (act === 'buy' || act === 'sell') {
    if (parsedHasExplicitEntryAnchor(parsed as Parameters<typeof parsedHasExplicitEntryAnchor>[0])) {
      return false
    }
    if (isBareEntryFollowUp(parsed)) return false
    return true
  }
  return false
}

/** Planner immediates used only for per-leg SL/TP during merge (never sent as new orders). */
export function mergePlanImmediateOrders(plan: PlannerResult): OrderSendArgs[] {
  return plan.orders.filter(o => {
    const op = String(o.operation)
    return op === 'Buy' || op === 'Sell' || op.includes('Limit') || op.includes('Stop')
  })
}

/**
 * Build one SL/TP target per open leg. Prefer planner immediates (bucket TPs); fall back
 * to parsed levels when the plan emitted zero immediates (range-only layout).
 */
export function buildPerLegStopTargets(args: {
  plan: PlannerResult
  parsed: ParsedSignalLike
  openLegCount: number
  /** Configure Trading → Targets % rows; used when legs outnumber planner immediates. */
  tpLots?: ManualTpLot[] | null
}): PerLegStopTarget[] {
  const { plan, parsed, openLegCount, tpLots } = args
  const n = Math.max(0, openLegCount)
  if (n === 0) return []

  const fromPlan = mergePlanImmediateOrders(plan).map(o => ({
    stoploss: Number(o.stoploss) || 0,
    takeprofit: Number(o.takeprofit) || 0,
  }))

  if (fromPlan.length >= n) {
    return fromPlan.slice(0, n)
  }

  const hasSl = typeof parsed.sl === 'number' && Number.isFinite(parsed.sl) && parsed.sl > 0
  const parsedTps = (parsed.tp ?? []).filter(
    (t): t is number => typeof t === 'number' && Number.isFinite(t) && t > 0,
  )
  const sl = hasSl
    ? (parsed.sl as number)
    : (fromPlan[0]?.stoploss ?? 0)

  let finalTps = parsedTps
  if (!finalTps.length && fromPlan.length > 0) {
    finalTps = fromPlan
      .map(o => o.takeprofit)
      .filter(tp => typeof tp === 'number' && Number.isFinite(tp) && tp > 0)
  }

  const tpPrices = buildDistributedPerLegTakeProfits({
    openLegCount: n,
    finalTps,
    tpLots,
  })
  return tpPrices.map(tp => ({
    stoploss: sl,
    takeprofit: tp,
  }))
}

/** When false, entry follow-ups still use legacy reply/thread merge linking. */
export function legacyMergeLinkingEnabled(): boolean {
  const v = String(process.env.WORKER_LEGACY_MERGE_LINKING ?? 'false').toLowerCase()
  return v === '1' || v === 'true' || v === 'yes'
}

/**
 * Latest open basket for broker + symbol + direction, optionally scoped to channel.
 * When multiple signal_ids have open legs, picks the one with the newest `opened_at`.
 */
export async function resolveLatestOpenBasketAnchor(
  supabase: SupabaseClient,
  args: {
    userId: string
    brokerAccountId: string
    /** Resolved broker instrument (e.g. BTCUSDm). */
    brokerSymbol: string
    /** Parsed telegram symbol (e.g. BTCUSD) for fuzzy match. */
    signalSymbol?: string | null
    direction: 'buy' | 'sell'
    channelId: string | null
  },
): Promise<LatestBasketAnchor | null> {
  const { data: openTrades, error } = await supabase
    .from('trades')
    .select('signal_id, opened_at, symbol')
    .eq('user_id', args.userId)
    .eq('broker_account_id', args.brokerAccountId)
    .eq('status', 'open')
    .eq('direction', args.direction)
    .order('opened_at', { ascending: false })
    .limit(200)

  if (error || !openTrades?.length) return null

  const symHint = args.signalSymbol ?? args.brokerSymbol
  const matching = (openTrades as { signal_id: string; opened_at: string; symbol: string }[])
    .filter(row =>
      symbolsCompatibleForBasket(symHint, row.symbol)
      || symbolsCompatibleForBasket(args.brokerSymbol, row.symbol),
    )
  if (!matching.length) return null

  const newestBySignal = new Map<string, string>()
  for (const row of matching) {
    const sid = row.signal_id
    if (!sid) continue
    const prev = newestBySignal.get(sid)
    if (!prev || new Date(row.opened_at).getTime() > new Date(prev).getTime()) {
      newestBySignal.set(sid, row.opened_at)
    }
  }

  const signalIds = [...newestBySignal.keys()]
  if (!signalIds.length) return null

  const { data: sigRows } = await supabase
    .from('signals')
    .select('id, channel_id')
    .in('id', signalIds)

  let candidates = (sigRows ?? []) as { id: string; channel_id: string | null }[]
  if (args.channelId) {
    candidates = candidates.filter(s => s.channel_id === args.channelId)
  }
  if (!candidates.length) return null

  let best: LatestBasketAnchor | null = null
  for (const s of candidates) {
    const openedAt = newestBySignal.get(s.id)
    if (!openedAt) continue
    if (
      !best
      || new Date(openedAt).getTime() > new Date(best.newestOpenedAt).getTime()
    ) {
      best = {
        anchorSignalId: s.id,
        channelId: s.channel_id,
        newestOpenedAt: openedAt,
      }
    }
  }
  return best
}

/** Entry-shaped follow-up without SL/TP is not a parameter refresh. */
export function isBareEntryFollowUp(parsed: ParsedSignalLike): boolean {
  return (
    !parsedHasSlOrTp(parsed)
    && !parsedHasExplicitEntryAnchor(parsed as Parameters<typeof parsedHasExplicitEntryAnchor>[0])
  )
}
