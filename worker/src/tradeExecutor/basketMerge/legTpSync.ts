import {
  type BasketSymbolParams
} from '../../basketSlTpReconcile'
import { type ManualSettings, type PlannerResult } from '../../manualPlanner'
import { syncRangeBasketTakeProfits, toRangeBasketParsedSlice } from '../../rangeBasketTpSync'
import { buildPerLegStopTargets, mergePlanImmediateOrders } from '../../multiTradeMerge'
import { type TradeExecutorContext } from '../context'
import {
  type BrokerRow,
  type ParsedSignal,
  type SignalRow,
  type SymbolCacheEntry
} from '../types'
import {
  fetchOpenBrokerTickets,
  runBasketLegModifies,
  type BasketOpenLeg,
} from '../../basketSlTpReconcile'

export async function syncMultiBasketLegTakeProfits(ctx: TradeExecutorContext, args: {
    signal: SignalRow
    parsed: ParsedSignal
    broker: BrokerRow
    plan: PlannerResult
    symbol: string
    uuid: string
    params: SymbolCacheEntry | null
    manual: ManualSettings
    direction: 'buy' | 'sell'
  }): Promise<void> {
    const { signal, parsed, broker, plan, symbol, uuid, params, manual, direction } = args
    const api = ctx.apiFor(broker)
    if (!api) return

    await new Promise(r => setTimeout(r, 250))

    if (manual.range_trading === true) {
      const basketParams: BasketSymbolParams | null = params
        ? {
            digits: params.digits,
            point: params.point,
            minLot: params.minLot,
            lotStep: params.lotStep,
            contractSize: params.contractSize,
            stopsLevel: params.stopsLevel,
            freezeLevel: params.freezeLevel,
          }
        : null
      await syncRangeBasketTakeProfits({
        supabase: ctx.supabase,
        api,
        uuid,
        symbol,
        direction,
        baseLot: Number(broker.default_lot_size ?? 0.01),
        params: basketParams,
        signalId: signal.id,
        userId: signal.user_id,
        brokerAccountId: broker.id,
        manual,
        parsed: toRangeBasketParsedSlice(parsed),
        plan,
      })
      return
    }

    const { data: familyRows, error } = await ctx.supabase
      .from('trades')
      .select('id,signal_id,metaapi_order_id,opened_at,lot_size,sl,tp,entry_price,direction,symbol')
      .eq('broker_account_id', broker.id)
      .eq('signal_id', signal.id)
      .eq('status', 'open')
      .order('opened_at', { ascending: true })
      .limit(500)
    if (error || !(familyRows ?? []).length) return

    const familyTrades = (familyRows ?? []) as BasketOpenLeg[]
    const immediateLegCount = mergePlanImmediateOrders(plan).length
    const totalPlannedLegCount =
      immediateLegCount + (plan.virtualPendings?.length ?? 0)
    const perLegTargets = buildPerLegStopTargets({
      plan,
      parsed,
      openLegCount: familyTrades.length,
      totalPlannedLegCount,
      immediateLegCount,
      tpLots: manual.tp_lots,
    })
    if (!perLegTargets.length) return

    let openedTickets: Set<number> | null = null
    try {
      openedTickets = await fetchOpenBrokerTickets(api, uuid)
    } catch { /* optional */ }

    const basketParams: BasketSymbolParams | null = params
      ? {
          digits: params.digits,
          point: params.point,
          minLot: params.minLot,
          lotStep: params.lotStep,
          contractSize: params.contractSize,
          stopsLevel: params.stopsLevel,
          freezeLevel: params.freezeLevel,
        }
      : null

    try {
      await runBasketLegModifies({
        supabase: ctx.supabase,
        api,
        uuid,
        symbol,
        direction,
        baseLot: Number(broker.default_lot_size ?? 0.01),
        params: basketParams,
        signalId: signal.id,
        userId: signal.user_id,
        brokerAccountId: broker.id,
        familyTrades,
        perLegTargets,
        signalTps: (parsed.tp ?? []).filter(
          (t): t is number => typeof t === 'number' && Number.isFinite(t) && t > 0,
        ),
        tpLots: manual.tp_lots,
        nImmCwe: 0,
        overrideTp: null,
        strictEntryPrefetch: null,
        openedTickets,
        skipAlreadySynced: true,
      })
    } catch (err) {
      console.warn(
        `[tradeExecutor] multi TP sync failed signal=${signal.id} broker=${broker.id}:`,
        err instanceof Error ? err.message : String(err),
      )
    }
  }
