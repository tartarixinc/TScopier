import type { SupabaseClient } from '@supabase/supabase-js'
import type { MetatraderApiClient } from './metatraderapi'

type ParsedMgmt = {
  action?: string
  symbol?: string | null
  sl?: number | null
  tp?: number[] | null
}

function sanitizeLevel(v: number | null | undefined): number {
  const n = typeof v === 'number' ? v : Number(v ?? 0)
  return Number.isFinite(n) && n > 0 ? n : 0
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
  },
): Promise<void> {
  const { data: basket } = await supabase
    .from('signals')
    .select('channel_id, created_at')
    .eq('id', args.basketSignalId)
    .maybeSingle()

  const channelId = basket?.channel_id as string | null | undefined
  const createdAt = basket?.created_at as string | null | undefined
  if (!channelId || !createdAt) return

  const { data: candidates } = await supabase
    .from('signals')
    .select('id, parsed_data, created_at')
    .eq('user_id', args.userId)
    .eq('channel_id', channelId)
    .eq('is_modification', true)
    .in('status', ['parsed', 'executed'])
    .gte('created_at', createdAt)
    .order('created_at', { ascending: false })
    .limit(40)

  for (const row of candidates ?? []) {
    const parsed = row.parsed_data as ParsedMgmt | null
    if (!parsed?.action) continue
    const act = String(parsed.action).toLowerCase()
    if (act !== 'modify' && act !== 'breakeven') continue
    if (!symbolsCompatibleForBasket(parsed.symbol, args.symbol)) continue

    let stoploss = 0
    let takeprofit = 0
    let dbPatch: Record<string, number | null> = {}

    if (act === 'modify') {
      const hasNewSl = typeof parsed.sl === 'number' && Number.isFinite(parsed.sl) && parsed.sl > 0
      const hasNewTp = Array.isArray(parsed.tp)
        && parsed.tp.length > 0
        && typeof parsed.tp[0] === 'number'
        && Number.isFinite(parsed.tp[0] as number)
        && (parsed.tp[0] as number) > 0
      if (!hasNewSl && !hasNewTp) continue
      stoploss = hasNewSl ? (parsed.sl as number) : sanitizeLevel(args.existingSl)
      takeprofit = hasNewTp ? (parsed.tp![0] as number) : sanitizeLevel(args.existingTp)
      if (hasNewSl) dbPatch.sl = parsed.sl as number
      if (hasNewTp) dbPatch.tp = parsed.tp![0] as number
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
          basket_signal_id: args.basketSignalId,
          source_mgmt_signal: row.id,
          release_action: act,
        } as Record<string, unknown>,
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      await supabase.from('trade_execution_logs').insert({
        user_id: args.userId,
        signal_id: row.id,
        broker_account_id: args.brokerAccountId,
        action: 'mgmt_range_leg_followup',
        status: 'failed',
        request_payload: {
          ticket: args.ticket,
          trade_id: args.tradeRowId,
          basket_signal_id: args.basketSignalId,
          source_mgmt_signal: row.id,
          release_action: act,
        } as Record<string, unknown>,
        error_message: msg,
      })
    }
    return
  }
}
