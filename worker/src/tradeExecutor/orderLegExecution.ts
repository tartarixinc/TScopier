import {
  isBrokerDisconnectedMessage,
  FxsocketBrokerClient,
  MtOperation,
} from '../fxsocketClient'
import { isMtBridgeGlitchMessage } from '../brokerConnectError'
import type { ChannelKeywords, ManualSettings, PlannerResult, VirtualPendingLeg } from '../manualPlanner'
import { autoManagementTradeSnapshot } from '../autoManagement'
import { stripInvalidStopsForSide } from '../channelActiveTradeParams'
import { trailingTradeRowSnapshot } from '../trailingStop'
import { applyPostFillFollowUp, type PostFillTradeLeg } from '../postFillFollowUp'
import type { TradeExecutorContext } from './context'
import { clampOrderStops, isBuySideOp, type Leg } from './helpers'
import type { BrokerRow, ParsedSignal, SendOrderOutcome, SignalRow, SymbolCacheEntry, SymbolMappingResult } from './types'

export type SendImmediateLegsInput = {
  ctx: TradeExecutorContext
  signal: SignalRow
  parsed: ParsedSignal
  broker: BrokerRow
  manual: ManualSettings
  api: FxsocketBrokerClient
  uuid: string
  symbol: string
  requestedSymbol: string
  mapping: SymbolMappingResult
  params: SymbolCacheEntry | null
  legs: Leg[]
  liveEntryFast: boolean
  pipelineT0?: number
  strictEntryPrefetch: { bid: number; ask: number } | null
  channelDelayMs: number
  channelDelaySkipped: boolean
  deferVirtualAnchor: boolean
  virtualPendings: VirtualPendingLeg[]
  plan: PlannerResult
  materializedVirtuals: boolean
  strictBrokerPlaced: boolean
  strictDeferred: boolean
  op: MtOperation
  channelKeywords: ChannelKeywords | null
  baseLot: number
  /** When true, run multi-basket TP sync after immediates. */
  syncMultiLegTps: boolean
}

export async function sendImmediateLegs(input: SendImmediateLegsInput): Promise<SendOrderOutcome> {
  const {
    ctx, signal, parsed, broker, manual, api, uuid, symbol, requestedSymbol, mapping, params,
    legs, liveEntryFast, pipelineT0, strictEntryPrefetch, channelDelayMs, channelDelaySkipped,
    deferVirtualAnchor, virtualPendings, plan, materializedVirtuals, strictBrokerPlaced,
    strictDeferred, op, channelKeywords, baseLot, syncMultiLegTps,
  } = input

  if (legs.length === 0) {
    // No immediates — virtual range ladder and/or broker strict-entry pending.
    return (materializedVirtuals || strictBrokerPlaced)
      ? { openedOrMerged: true, channelDelayMs, channelDelaySkipped }
      : { channelDelayMs, channelDelaySkipped }
  }

  if (manual.trade_style !== 'multi' && legs.length > 1) {
    console.error(
      `[tradeExecutor] single trade_style aborting ${legs.length} legs signal=${signal.id} broker=${broker.id}`,
    )
  }
  const sendLegs = manual.trade_style !== 'multi' && legs.length > 1 ? legs.slice(0, 1) : legs

  const totalCount = sendLegs.length
  const orderLogContext: Record<string, unknown> = {
    signal_symbol: parsed.symbol ?? null,
    trade_symbol: requestedSymbol,
  }
  if (mapping.whitelist.length > 0) {
    orderLogContext.allowed_symbols = mapping.whitelist
  }

  const filledLegs: PostFillTradeLeg[] = []

  const sendLeg = async (leg: Leg): Promise<boolean> => {
    let args = leg.args
    const isBuyLeg = isBuySideOp(String(args.operation))
    const isMarket = args.operation === 'Buy' || args.operation === 'Sell'
    if (!liveEntryFast && isMarket && (!args.price || args.price <= 0) && api) {
      try {
        const q = strictEntryPrefetch ?? await api.quote(uuid, symbol)
        args = { ...args, price: isBuyLeg ? q.ask : q.bid }
      } catch {
        /* clamp may no-op without ref */
      }
    }
    const refPx = Number(args.price) || 0
    if (refPx > 0) {
      const stripped = stripInvalidStopsForSide({
        stoploss: Number(args.stoploss) || 0,
        takeprofit: Number(args.takeprofit) || 0,
        referencePrice: refPx,
        isBuy: isBuyLeg,
      })
      if (stripped.stripped.length > 0) {
        console.warn(
          `[tradeExecutor] stripped invalid stops signal=${signal.id} broker=${broker.id}`
          + ` ref=${refPx} isBuy=${isBuyLeg}: ${stripped.stripped.join(', ')}`,
        )
        args = { ...args, stoploss: stripped.stoploss, takeprofit: stripped.takeprofit }
      }
    }
    // Final SL/TP clamp using the actual market/entry price as the reference.
    const clamped = clampOrderStops(args, params)
    if (clamped.adjustments.length > 0) {
      console.warn(
        `[tradeExecutor] stops clamped signal=${signal.id} broker=${broker.id} symbol=${args.symbol} op=${args.operation}: ${clamped.adjustments.join(', ')}`,
      )
    }
    args = clamped.args
    const t0 = Date.now()
    if (liveEntryFast && signal.pipeline_ts && signal.pipeline_ts.t_first_broker_send == null) {
      signal.pipeline_ts.t_first_broker_send = t0
    }
    try {
      const result = await api.orderSend(uuid, args)
      const latencyMs = Date.now() - t0
      if (liveEntryFast && signal.pipeline_ts) {
        signal.pipeline_ts.t_last_broker_send = Date.now()
      }
      console.log(
        `[tradeExecutor] OrderSend ok signal=${signal.id} broker=${broker.id} ticket=${result.ticket} leg=${leg.idx + 1}/${totalCount} price=${args.price ?? 0} ${latencyMs}ms`,
      )

      const isBuy = !args.operation.toLowerCase().includes('sell')
      const entryPx = result.openPrice ?? args.price ?? null
      const openSl = result.stopLoss ?? args.stoploss ?? null
      const trailCols = trailingTradeRowSnapshot(
        manual,
        entryPx,
        openSl,
      )
      const autoBeCols = autoManagementTradeSnapshot(manual, entryPx, openSl)
      const tradeRowPayload = {
        user_id: signal.user_id,
        signal_id: signal.id,
        telegram_channel_id: signal.channel_id,
        broker_account_id: broker.id,
        metaapi_order_id: result.ticket != null ? String(result.ticket) : null,
        symbol: args.symbol,
        direction: isBuy ? 'buy' : 'sell',
        entry_price: entryPx,
        sl: openSl,
        tp: result.takeProfit ?? args.takeprofit ?? null,
        lot_size: result.lots ?? args.volume,
        status: args.operation.includes('Limit') || args.operation.includes('Stop') ? 'pending' : 'open',
        opened_at: new Date().toISOString(),
        cwe_close_price: leg.cweClosePrice ?? null,
        ...trailCols,
        ...autoBeCols,
      }
      const filledLeg: PostFillTradeLeg = {
        tradeRowId: null,
        ticket: result.ticket,
        symbol: args.symbol,
        direction: isBuy ? 'buy' : 'sell',
        entryPrice: entryPx,
        openSl: openSl != null ? Number(openSl) : null,
        openTp: (result.takeProfit ?? args.takeprofit) != null
          ? Number(result.takeProfit ?? args.takeprofit)
          : null,
      }

      const persistPostFillDb = async (tradeRowId: string | null) => {
        if (tradeRowId && leg.partialTps && leg.partialTps.length > 0) {
          const partialRows = leg.partialTps.map(p => ({
            trade_id: tradeRowId,
            signal_id: signal.id,
            user_id: signal.user_id,
            broker_account_id: broker.id,
            metaapi_account_id: uuid,
            symbol: args.symbol,
            is_buy: isBuy,
            tp_idx: p.tpIdx,
            trigger_price: p.triggerPrice,
            close_lots: p.closeLots,
            status: 'pending',
          }))
          const { error: partialErr } = await ctx.supabase
            .from('partial_tp_legs')
            .insert(partialRows)
          if (partialErr) {
            console.error(
              `[tradeExecutor] partial_tp_legs INSERT failed signal=${signal.id} broker=${broker.id} trade=${tradeRowId}: ${partialErr.message}`,
            )
          }
        }
        await ctx.supabase.from('trade_execution_logs').insert({
          user_id: signal.user_id,
          signal_id: signal.id,
          broker_account_id: broker.id,
          action: 'order_send',
          status: 'success',
          request_payload: { ...args, ...orderLogContext } as unknown as Record<string, unknown>,
          response_payload: {
            ticket: result.ticket,
            latency_ms: latencyMs,
            pipeline_ms: pipelineT0 != null ? Date.now() - pipelineT0 : undefined,
            leg: leg.idx + 1,
            total: totalCount,
          },
        })
      }

      if (liveEntryFast) {
        filledLegs.push(filledLeg)
        const tradeInsert = await ctx.supabase
          .from('trades')
          .insert(tradeRowPayload)
          .select('id')
          .maybeSingle()
        if (tradeInsert.error) {
          console.error(
            `[tradeExecutor] trades INSERT failed signal=${signal.id} broker=${broker.id} ticket=${result.ticket}: ${tradeInsert.error.message}`,
          )
        }
        const tradeRowId = (tradeInsert.data as { id?: string } | null)?.id ?? null
        filledLeg.tradeRowId = tradeRowId
        await persistPostFillDb(tradeRowId)
      } else {
        const tradeInsert = await ctx.supabase
          .from('trades')
          .insert(tradeRowPayload)
          .select('id')
          .maybeSingle()
        if (tradeInsert.error) {
          console.error(
            `[tradeExecutor] trades INSERT failed signal=${signal.id} broker=${broker.id} ticket=${result.ticket}: ${tradeInsert.error.message}`,
          )
        }
        filledLeg.tradeRowId = (tradeInsert.data as { id?: string } | null)?.id ?? null
        filledLegs.push(filledLeg)
        await persistPostFillDb(filledLeg.tradeRowId)
      }
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (isBrokerDisconnectedMessage(msg) && !isMtBridgeGlitchMessage(msg)) {
        await ctx.markBrokerSessionDown(broker, uuid, msg)
      }
      console.error(
        `[tradeExecutor] OrderSend failed signal=${signal.id} broker=${broker.id} leg=${leg.idx + 1}/${totalCount} op=${args.operation} price=${args.price ?? 0}:`,
        msg,
      )
      if (liveEntryFast) {
        void ctx.supabase.from('trade_execution_logs').insert({
          user_id: signal.user_id,
          signal_id: signal.id,
          broker_account_id: broker.id,
          action: 'order_send',
          status: 'failed',
          request_payload: { ...args, ...orderLogContext } as unknown as Record<string, unknown>,
          error_message: msg,
        })
      } else {
        await ctx.supabase.from('trade_execution_logs').insert({
          user_id: signal.user_id,
          signal_id: signal.id,
          broker_account_id: broker.id,
          action: 'order_send',
          status: 'failed',
          request_payload: { ...args, ...orderLogContext } as unknown as Record<string, unknown>,
          error_message: msg,
        })
      }
      return false
    }
  }

  // All immediates fan out in parallel. Virtual pendings are already
  // persisted; the worker monitor + edge sweep will fire them on trigger.
  const sendResults = await Promise.allSettled(sendLegs.map(sendLeg))
  if (deferVirtualAnchor && virtualPendings.length > 0 && api) {
    void ctx.deferredVirtualPendingMaterialize({
      signal,
      broker,
      uuid,
      api,
      symbol,
      virtualPendings,
      parsed,
      plan,
      params,
      strictEntryPrefetch,
    }).catch(err => {
      console.error(
        `[tradeExecutor] deferred virtual pending failed signal=${signal.id} broker=${broker.id}:`,
        err,
      )
    })
  }
  if (liveEntryFast && filledLegs.length > 0) {
    const plannerCtx = params
      ? {
        point: params.point,
        digits: params.digits,
        minLot: params.minLot,
        lotStep: params.lotStep,
        contractSize: params.contractSize,
        stopsLevel: params.stopsLevel,
        freezeLevel: params.freezeLevel,
        defaultLot: Number(broker.default_lot_size ?? 0.01),
        lastBalance: broker.last_balance ?? null,
      }
      : null
    void applyPostFillFollowUp({
      supabase: ctx.supabase,
      api,
      uuid,
      signal,
      parsed,
      op,
      broker,
      channelKeywords,
      symbol,
      baseLot,
      params: plannerCtx,
      filledLegs,
      plannedBrokerTp: plan.orders[0]?.takeprofit ?? null,
      hasPartialTpSchedule: (plan.partialTps?.length ?? 0) > 0,
      hooks: {
        closeOppositeDirectionTrades: (s, p, _b, sym) =>
          ctx.closeOppositeDirectionTrades(s, p, broker, sym),
        tryParameterFollowUpMergeModifyOnly: async () => ({ handled: false }),
        tryMergeSignalIntoExistingOpenTrade: async () => ({ handled: false }),
      },
    }).catch(err => {
      console.error(`[tradeExecutor] postFillFollowUp failed signal=${signal.id}:`, err)
    })
  }
  const anyImmediateOpened = sendResults.some(
    r => r.status === 'fulfilled' && r.value === true,
  )
  const parsedTpCount = (parsed.tp ?? []).filter(
    (t): t is number => typeof t === 'number' && Number.isFinite(t) && t > 0,
  ).length
  const tpLotBuckets = (manual.tp_lots ?? []).filter(
    r => r?.enabled !== false && Number(r.percent) > 0,
  ).length
  const needsPerLegTpSync = parsedTpCount >= 2 || tpLotBuckets >= 2
  if (syncMultiLegTps
    && anyImmediateOpened
    && sendLegs.length > 1
    && needsPerLegTpSync
  ) {
    const syncArgs = {
      signal,
      parsed,
      broker,
      plan,
      symbol,
      uuid,
      params,
      manual,
      direction: op.toLowerCase().includes('sell') ? 'sell' as const : 'buy' as const,
    }
    if (liveEntryFast) {
      void ctx.syncMultiBasketLegTakeProfits(syncArgs).catch(err => {
        console.error(`[tradeExecutor] syncMultiBasketLegTakeProfits failed signal=${signal.id}:`, err)
      })
    } else {
      await ctx.syncMultiBasketLegTakeProfits(syncArgs)
    }
  }
  if (virtualPendings.length > 0 && !anyImmediateOpened && !strictDeferred) {
    const { error: stripErr } = await ctx.supabase
      .from('range_pending_legs')
      .delete()
      .eq('signal_id', signal.id)
      .eq('broker_account_id', broker.id)
    if (stripErr) {
      console.warn(
        `[tradeExecutor] strip orphan virtual pendings failed signal=${signal.id} broker=${broker.id}: ${stripErr.message}`,
      )
    } else {
      console.warn(
        `[tradeExecutor] stripped virtual pendings (zero successful immediates) signal=${signal.id} broker=${broker.id}`,
      )
    }
  }
  return {
    openedOrMerged: anyImmediateOpened || materializedVirtuals || strictBrokerPlaced,
    channelDelayMs,
    channelDelaySkipped,
  }
}
