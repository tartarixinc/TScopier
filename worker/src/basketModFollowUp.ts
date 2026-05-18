import type { SupabaseClient } from '@supabase/supabase-js'
import type { MetatraderApiClient } from './metatraderapi'
import type { ManualTpLot } from './manualPlanning/types'
import { takeProfitForLegIndex } from './manualPlanning/tpBucketDistribution'

type ParsedMgmt = {
  action?: string
  symbol?: string | null
  sl?: number | null
  tp?: number[] | null
}

function isParameterRefreshParsed(parsed: ParsedMgmt | null | undefined): boolean {
  if (!parsed) return false
  const hasSl = typeof parsed.sl === 'number' && Number.isFinite(parsed.sl) && parsed.sl > 0
  const hasTp = Array.isArray(parsed.tp)
    && parsed.tp.some(t => typeof t === 'number' && Number.isFinite(t) && (t as number) > 0)
  if (!hasSl && !hasTp) return false
  const act = String(parsed.action ?? '').toLowerCase()
  return act === 'buy' || act === 'sell' || act === 'modify'
}

function sanitizeLevel(v: number | null | undefined): number {
  const n = typeof v === 'number' ? v : Number(v ?? 0)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function positiveTps(parsed: ParsedMgmt | null | undefined): number[] {
  return (parsed?.tp ?? []).filter(
    (t): t is number => typeof t === 'number' && Number.isFinite(t) && t > 0,
  )
}

export function symbolsCompatibleForBasket(signalSym: string | null | undefined, brokerSym: string): boolean {
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '')
  const a = norm(String(signalSym ?? ''))
  const b = norm(String(brokerSym ?? ''))
  if (!a.length || !b.length) return false
  return a === b || b.includes(a) || a.includes(b)
}

/**
 * When a virtual range leg fills after an SL/TP (or breakeven) message was already
 * processed for the basket, apply the newest matching management instruction to this
 * position immediately (do not wait for the trade-executor sweep).
 */
export async function tryApplyBasketFollowUpToNewFill(
  supabase: SupabaseClient,
  api: MetatraderApiClient,
  args: {
    userId: string
    basketSignalId: string
    brokerAccountId: string
    metaUuid: string
    symbol: string
    ticket: number
    tradeRowId: string
    entryPrice: number | null
    existingSl: number | null
    existingTp: number | null
    tpLots?: ManualTpLot[] | null
  },
): Promise<void> {
  const { data: basket } = await supabase
    .from('signals')
    .select('channel_id, created_at, parsed_data')
    .eq('id', args.basketSignalId)
    .maybeSingle()

  const channelId = basket?.channel_id as string | null | undefined
  const createdAt = basket?.created_at as string | null | undefined
  const anchorParsed = basket?.parsed_data as ParsedMgmt | null | undefined
  if (!channelId || !createdAt) return

  let tpLots = args.tpLots
  if (tpLots === undefined) {
    const { data: br } = await supabase
      .from('broker_accounts')
      .select('manual_settings')
      .eq('id', args.brokerAccountId)
      .maybeSingle()
    tpLots = ((br?.manual_settings ?? {}) as { tp_lots?: ManualTpLot[] | null }).tp_lots
  }

  const { data: openLegs } = await supabase
    .from('trades')
    .select('id')
    .eq('broker_account_id', args.brokerAccountId)
    .eq('signal_id', args.basketSignalId)
    .eq('status', 'open')
    .order('opened_at', { ascending: true })
    .limit(500)
  const legIndex = (openLegs ?? []).findIndex(r => r.id === args.tradeRowId)

  const { data: candidates } = await supabase
    .from('signals')
    .select('id, parsed_data, created_at, is_modification')
    .eq('user_id', args.userId)
    .eq('channel_id', channelId)
    .in('status', ['parsed', 'executed'])
    .gte('created_at', createdAt)
    .order('created_at', { ascending: false })
    .limit(60)

  for (const row of candidates ?? []) {
    const parsed = row.parsed_data as ParsedMgmt | null
    if (!parsed?.action) continue
    const act = String(parsed.action).toLowerCase()
    const paramRefresh = isParameterRefreshParsed(parsed)
    if (act !== 'modify' && act !== 'breakeven' && !paramRefresh) continue
    if (!symbolsCompatibleForBasket(parsed.symbol, args.symbol)) continue

    let stoploss = 0
    let takeprofit = 0
    let dbPatch: Record<string, number | null> = {}

    if (act === 'modify' || paramRefresh) {
      const hasNewSl = typeof parsed.sl === 'number' && Number.isFinite(parsed.sl) && parsed.sl > 0
      const signalTps = positiveTps(parsed)
      const anchorTps = positiveTps(anchorParsed)
      const finalTps = signalTps.length ? signalTps : anchorTps
      const hasNewTp = finalTps.length > 0
      if (!hasNewSl && !hasNewTp) continue
      stoploss = hasNewSl ? (parsed.sl as number) : sanitizeLevel(args.existingSl)
      if (hasNewTp) {
        const openLegCount = Math.max((openLegs ?? []).length, legIndex + 1)
        const idx = legIndex >= 0 ? legIndex : openLegCount - 1
        takeprofit = takeProfitForLegIndex({
          legIndex: idx,
          openLegCount,
          finalTps,
          tpLots,
        })
        if (takeprofit <= 0) {
          takeprofit = finalTps[finalTps.length - 1]!
        }
      } else {
        takeprofit = sanitizeLevel(args.existingTp)
      }
      if (hasNewSl) dbPatch.sl = parsed.sl as number
      if (hasNewTp && takeprofit > 0) dbPatch.tp = takeprofit
    } else {
      const entry = sanitizeLevel(args.entryPrice)
      if (entry <= 0) continue
      stoploss = entry
      takeprofit = sanitizeLevel(args.existingTp)
      dbPatch.sl = entry
    }

    try {
      await api.orderModify(args.metaUuid, {
        ticket: args.ticket,
        stoploss,
        takeprofit,
      })
      if (Object.keys(dbPatch).length > 0) {
        await supabase.from('trades').update(dbPatch).eq('id', args.tradeRowId)
      }
      await supabase.from('trade_execution_logs').insert({
        user_id: args.userId,
        signal_id: row.id,
        broker_account_id: args.brokerAccountId,
        action: 'mgmt_range_leg_followup',
        status: 'success',
        request_payload: {
          ticket: args.ticket,
          trade_id: args.tradeRowId,
          leg_index: legIndex >= 0 ? legIndex + 1 : null,
          stoploss,
          takeprofit,
          basket_signal_id: args.basketSignalId,
        } as unknown as Record<string, unknown>,
      })
      return
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await supabase.from('trade_execution_logs').insert({
        user_id: args.userId,
        signal_id: row.id,
        broker_account_id: args.brokerAccountId,
        action: 'mgmt_range_leg_followup',
        status: 'failed',
        error_message: msg,
        request_payload: {
          ticket: args.ticket,
          trade_id: args.tradeRowId,
          basket_signal_id: args.basketSignalId,
        } as unknown as Record<string, unknown>,
      })
    }
  }
}
