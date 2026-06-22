/**
 * Apply user signal SL/TP overrides to open broker legs for a signal basket.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { stripInvalidStopsForSide } from './channelActiveTradeParams'
import { channelMatchesBrokerSignal } from './brokerChannelFilter'
import {
  clampBasketOrderStops,
  type BasketSymbolParams,
} from './basketSlTpReconcile'
import {
  getFxsocketClient,
  hasFxsocketConfigured,
  mtPlatformFrom,
  normalizeSymbolParams,
} from './fxsocketClient'
import {
  buildEntryQualityTakeProfitMap,
  type EntryQualityLeg,
} from './manualPlanning/tpBucketDistribution'
import type { ManualTpLot } from './manualPlanning/types'
import { isBenignOrderModifyError, stopsAlreadyMatchDb } from './orderModifyBenign'
import { effectiveParsedFromSignalRow } from './signalOverride'
import { brokerHasLinkedSession, brokerSessionUuid } from './tradeExecutor/helpers'
import {
  expandMgmtRowsToFullBaskets,
  loadOpenTradesForManagement,
} from './managementScope'

export type ApplySignalOverrideResult = {
  applied_legs: number
  skipped_legs: number
  failed_legs: number
  errors?: string[]
}

type TradeRow = {
  id: string
  signal_id: string
  broker_account_id: string
  metaapi_order_id: string | null
  symbol: string
  direction: string
  sl: number | null
  tp: number | null
  opened_at: string
  entry_price: number | null
}

type BrokerRow = {
  id: string
  label?: string | null
  platform?: string | null
  fxsocket_account_id?: string | null
  metaapi_account_id?: string | null
  manual_settings?: { tp_lots?: ManualTpLot[] | null } | null
}

function num(v: unknown): number | null {
  if (v == null) return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

export async function applySignalOverride(
  supabase: SupabaseClient,
  args: { userId: string; signalId: string; dryRun?: boolean },
): Promise<ApplySignalOverrideResult> {
  const dryRun = args.dryRun === true
  const errors: string[] = []
  let appliedLegs = 0
  let skippedLegs = 0
  let failedLegs = 0

  const { data: signal, error: sigErr } = await supabase
    .from('signals')
    .select('id,user_id,channel_id,parsed_data,user_override')
    .eq('id', args.signalId)
    .eq('user_id', args.userId)
    .maybeSingle()
  if (sigErr || !signal) {
    throw sigErr ?? new Error(`signal not found: ${args.signalId}`)
  }

  const effective = effectiveParsedFromSignalRow(signal as {
    parsed_data: Parameters<typeof effectiveParsedFromSignalRow>[0]['parsed_data']
    user_override: unknown
  })
  const targetSl = num(effective.sl)
  const targetTps = (effective.tp ?? []).filter((t): t is number => num(t) != null)

  if (targetSl == null && targetTps.length === 0) {
    return { applied_legs: 0, skipped_legs: 0, failed_legs: 0, errors: ['no_sl_or_tp_in_override'] }
  }

  const channelId = (signal as { channel_id?: string | null }).channel_id ?? null
  const symbol = String(effective.symbol ?? '').trim() || null
  let rows: TradeRow[] = []

  if (channelId && symbol) {
    const { data: brokerRows } = await supabase
      .from('broker_accounts')
      .select('id,signal_channel_ids,is_active,fxsocket_account_id,metaapi_account_id')
      .eq('user_id', args.userId)
      .eq('is_active', true)
    const brokerAccountIds = (brokerRows ?? [])
      .filter(b => channelMatchesBrokerSignal(b as { signal_channel_ids?: string[] | null }, channelId))
      .map(b => (b as { id: string }).id)
    if (brokerAccountIds.length) {
      const scoped = await loadOpenTradesForManagement(supabase, {
        userId: args.userId,
        channelId,
        brokerAccountIds,
        symbolFilter: symbol,
      })
      const expanded = await expandMgmtRowsToFullBaskets(supabase, {
        userId: args.userId,
        rows: scoped.filter(r => r.status === 'open'),
      })
      rows = expanded
        .filter(r => r.status === 'open' && r.metaapi_order_id)
        .map(r => ({
          id: r.id,
          signal_id: r.signal_id,
          broker_account_id: r.broker_account_id,
          metaapi_order_id: r.metaapi_order_id,
          symbol: r.symbol,
          direction: r.direction,
          sl: r.sl,
          tp: r.tp,
          opened_at: r.opened_at ?? '',
          entry_price: r.entry_price,
        }))
    }
  }

  if (!rows.length) {
    const { data: trades, error: trErr } = await supabase
      .from('trades')
      .select('id,signal_id,broker_account_id,metaapi_order_id,symbol,direction,sl,tp,opened_at,entry_price')
      .eq('user_id', args.userId)
      .eq('signal_id', args.signalId)
      .eq('status', 'open')
      .not('metaapi_order_id', 'is', null)
      .order('opened_at', { ascending: true })
    if (trErr) throw trErr
    rows = (trades ?? []) as TradeRow[]
  }
  if (!rows.length) {
    return { applied_legs: 0, skipped_legs: 0, failed_legs: 0 }
  }

  if (!dryRun && !hasFxsocketConfigured()) {
    throw new Error('FXSOCKET_API_KEY not set — cannot call broker')
  }

  const brokerIds = [...new Set(rows.map(r => r.broker_account_id))]
  const { data: brokers } = await supabase
    .from('broker_accounts')
    .select('id,label,platform,fxsocket_account_id,metaapi_account_id,manual_settings')
    .in('id', brokerIds)
  const brokerById = new Map((brokers ?? []).map(b => [b.id, b as BrokerRow]))

  const api = getFxsocketClient()

  for (const brokerId of brokerIds) {
    const broker = brokerById.get(brokerId)
    const uuid = broker ? brokerSessionUuid(broker) : null
    if (!broker || !uuid || !brokerHasLinkedSession(broker)) {
      skippedLegs += rows.filter(r => r.broker_account_id === brokerId).length
      continue
    }

    const client = api
    if (!client && !dryRun) {
      errors.push(`broker ${brokerId}: fxsocket client unavailable`)
      skippedLegs += rows.filter(r => r.broker_account_id === brokerId).length
      continue
    }

    client?.seedPlatformCache(uuid, mtPlatformFrom(broker.platform))

    const legs = rows
      .filter(r => r.broker_account_id === brokerId)
      .sort((a, b) => new Date(a.opened_at).getTime() - new Date(b.opened_at).getTime())

    const isBuy = String(legs[0]?.direction ?? '').toLowerCase() === 'buy'
    const tpLots = broker.manual_settings?.tp_lots ?? null
    const tpMap = targetTps.length > 0
      ? buildEntryQualityTakeProfitMap({
          legs: legs.map(tr => ({
            id: tr.id,
            entryPrice: Number(tr.entry_price ?? 0),
            openedAt: tr.opened_at,
          })) satisfies EntryQualityLeg[],
          isBuy,
          slotLegCount: legs.length,
          finalTps: targetTps,
          tpLots: tpLots ?? null,
        })
      : new Map<string, number>()

    let quoteRef: number | null = null
    let symbolParams: BasketSymbolParams | null = null
    const quoteSymbol = legs[0]?.symbol?.trim()
    if (client && quoteSymbol && !dryRun) {
      try {
        const q = await client.quote(uuid, quoteSymbol)
        const marketRef = isBuy ? q.bid : q.ask
        if (Number.isFinite(marketRef) && marketRef > 0) quoteRef = marketRef
      } catch {
        /* optional — fall back to entry for side checks */
      }
      try {
        const sp = await client.symbolParams(uuid, quoteSymbol)
        const n = normalizeSymbolParams(sp)
        symbolParams = {
          digits: n.digits ?? 5,
          point: n.point ?? 0.00001,
          minLot: n.minLot ?? 0.01,
          lotStep: n.lotStep ?? 0.01,
          contractSize: n.contractSize ?? null,
          stopsLevel: n.stopsLevel ?? 0,
          freezeLevel: n.freezeLevel ?? 0,
        }
      } catch {
        /* optional — modify without broker min-distance clamp */
      }
    }

    for (let i = 0; i < legs.length; i++) {
      const tr = legs[i]!
      const ticket = Number(tr.metaapi_order_id)
      if (!Number.isFinite(ticket) || ticket <= 0) {
        skippedLegs++
        continue
      }

      const keepTp = num(tr.tp)
      const keepSl = num(tr.sl)
      let targetTp = targetTps.length > 0 ? (tpMap.get(tr.id) ?? keepTp) : keepTp
      let targetSlForLeg = targetSl ?? keepSl

      const ref = (quoteRef != null && quoteRef > 0) ? quoteRef : num(tr.entry_price)
      if (ref != null && ref > 0 && (targetSlForLeg != null || targetTp != null)) {
        const stripped = stripInvalidStopsForSide({
          stoploss: targetSlForLeg ?? 0,
          takeprofit: targetTp ?? 0,
          referencePrice: ref,
          isBuy,
        })
        if (targetSlForLeg != null) {
          targetSlForLeg = stripped.stoploss > 0 ? stripped.stoploss : null
        }
        if (targetTp != null) {
          targetTp = stripped.takeprofit > 0 ? stripped.takeprofit : null
        }
      }

      if (ref != null && ref > 0 && symbolParams && (targetSlForLeg != null || targetTp != null)) {
        const clamped = clampBasketOrderStops({
          symbol: quoteSymbol ?? tr.symbol,
          operation: isBuy ? 'Buy' : 'Sell',
          volume: 0.01,
          price: ref,
          stoploss: targetSlForLeg ?? 0,
          takeprofit: targetTp ?? 0,
        }, symbolParams)
        if (targetSlForLeg != null && clamped.args.stoploss && clamped.args.stoploss > 0) {
          targetSlForLeg = clamped.args.stoploss
        }
        if (targetTp != null && clamped.args.takeprofit && clamped.args.takeprofit > 0) {
          targetTp = clamped.args.takeprofit
        }
      }

      if (targetSlForLeg == null && targetTp == null) {
        skippedLegs++
        continue
      }

      if (
        targetSlForLeg != null
        && targetTp != null
        && stopsAlreadyMatchDb(
          { sl: tr.sl, tp: tr.tp },
          { stoploss: targetSlForLeg, takeprofit: targetTp },
          0,
          0,
        )
      ) {
        skippedLegs++
        continue
      }

      if (dryRun) {
        appliedLegs++
        continue
      }

      try {
        const modifyArgs: { ticket: number; stoploss?: number; takeprofit?: number } = { ticket }
        if (targetSlForLeg != null && targetSlForLeg > 0) modifyArgs.stoploss = targetSlForLeg
        if (targetTp != null && targetTp > 0) modifyArgs.takeprofit = targetTp
        if (modifyArgs.stoploss == null && modifyArgs.takeprofit == null) {
          skippedLegs++
          continue
        }

        await client!.orderModify(uuid, modifyArgs)
        const dbPatch: { sl?: number | null; tp?: number | null } = {}
        if (targetSlForLeg != null) dbPatch.sl = targetSlForLeg
        if (targetTp != null) dbPatch.tp = targetTp
        if (Object.keys(dbPatch).length > 0) {
          await supabase.from('trades').update(dbPatch).eq('id', tr.id)
        }
        await supabase.from('trade_execution_logs').insert({
          user_id: args.userId,
          signal_id: args.signalId,
          broker_account_id: brokerId,
          action: 'user_signal_override',
          status: 'success',
          request_payload: {
            ticket,
            target_sl: modifyArgs.stoploss ?? null,
            target_tp: modifyArgs.takeprofit ?? null,
            trade_id: tr.id,
            leg_index: i + 1,
          } as unknown as Record<string, unknown>,
        })
        appliedLegs++
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (isBenignOrderModifyError(msg)) {
          skippedLegs++
          continue
        }
        failedLegs++
        errors.push(`leg ${tr.id}: ${msg}`)
        try {
          await supabase.from('trade_execution_logs').insert({
            user_id: args.userId,
            signal_id: args.signalId,
            broker_account_id: brokerId,
            action: 'user_signal_override',
            status: 'failed',
            error_message: msg,
            request_payload: {
              ticket,
              trade_id: tr.id,
              leg_index: i + 1,
            } as unknown as Record<string, unknown>,
          })
        } catch {
          // best-effort log
        }
      }
    }
  }

  return {
    applied_legs: appliedLegs,
    skipped_legs: skippedLegs,
    failed_legs: failedLegs,
    errors: errors.length ? errors : undefined,
  }
}
