/**
 * Post-fill management: channel SL/TP overrides, pip-based stops, opposite close,
 * merge-into-existing — all after broker OrderSend (live fast path).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { MetatraderApiClient, MtOperation } from './metatraderapi'
import type { PlannerContext } from './manualPlanning/types'
import {
  loadChannelActiveTradeParamsForSymbol,
  mergeParsedWithChannelParams,
  shouldMergeChannelParamsForEntry,
  shouldPreferSignalStopsOverChannelMemory,
  stripInvalidStopsForSide,
} from './channelActiveTradeParams'
import { findActiveNewsBlackout } from './newsTrading/blackout'
import { getCalendarEventsCached } from './newsTrading/calendarProvider'
import { isNewsTradingEnabled } from './newsTrading/settings'
import { deriveManualStopsWithClamp } from './manualPlanning/manualStops'
import { usesPredefinedStops } from './manualPlanning/manualStops'
import { lastPositiveParsedTpPrice } from './manualPlanning/parsedEntry'
import type { ChannelKeywords, ManualSettings, ParsedSignal } from './manualPlanning/types'
import type { SignalRow } from './tradeExecutor'
import { isBenignOrderModifyError } from './orderModifyBenign'

/** Minimal broker fields for post-fill (avoids circular import from tradeExecutor). */
export type PostFillBrokerRow = {
  id: string
  manual_settings?: unknown
  default_lot_size?: number | null
  last_balance?: number | null
}

export type PostFillTradeLeg = {
  tradeRowId: string | null
  ticket: number
  symbol: string
  direction: 'buy' | 'sell'
  entryPrice: number | null
  openSl: number | null
  openTp: number | null
}

export type PostFillExecutorHooks = {
  closeOppositeDirectionTrades(
    signal: SignalRow,
    parsed: ParsedSignal,
    broker: PostFillBrokerRow,
    symbol: string,
  ): Promise<void>
  tryParameterFollowUpMergeModifyOnly(args: {
    signal: SignalRow
    parsed: ParsedSignal
    broker: PostFillBrokerRow
    channelKeywords: ChannelKeywords | null
    baseLot: number
    params: PlannerContext | null
    symbol: string
    uuid: string
    strictEntryPrefetch: { bid: number; ask: number } | null
  }): Promise<{ handled: boolean; success?: boolean }>
  tryMergeSignalIntoExistingOpenTrade(args: {
    signal: SignalRow
    parsed: ParsedSignal
    op: MtOperation
    broker: PostFillBrokerRow
    channelKeywords: ChannelKeywords | null
    baseLot: number
    params: PlannerContext | null
    symbol: string
    uuid: string
    strictEntryPrefetch: { bid: number; ask: number } | null
  }): Promise<{ handled: boolean; success?: boolean }>
}

export type ApplyPostFillFollowUpArgs = {
  supabase: SupabaseClient
  api: MetatraderApiClient
  uuid: string
  signal: SignalRow
  parsed: ParsedSignal
  op: MtOperation
  broker: PostFillBrokerRow
  channelKeywords: ChannelKeywords | null
  symbol: string
  baseLot: number
  params: PlannerContext | null
  filledLegs: PostFillTradeLeg[]
  hooks: PostFillExecutorHooks
  /** Broker TP from single-mode planner (deepest target when partial schedule exists). */
  plannedBrokerTp?: number | null
  /** When true, do not overwrite broker TP with a shallower parsed/channel target. */
  hasPartialTpSchedule?: boolean
}

function newsBlackoutPreFillEnabled(): boolean {
  const v = String(process.env.EXECUTOR_NEWS_BLACKOUT_PRE_FILL ?? 'false').toLowerCase()
  return v === '1' || v === 'true' || v === 'yes'
}

async function applyPipAndChannelStops(args: ApplyPostFillFollowUpArgs): Promise<void> {
  const {
    api, uuid, signal, parsed, broker, channelKeywords, symbol, params, filledLegs,
    plannedBrokerTp, hasPartialTpSchedule,
  } = args
  const manual = (broker.manual_settings ?? {}) as ManualSettings
  const isSingleTradeStyle = (manual.trade_style ?? 'single') !== 'multi'
  if (!isSingleTradeStyle) {
    // Multi-trade legs already carry per-bucket TPs from the planner; syncMultiBasketLegTakeProfits
    // reconciles them. Flattening to tp[0] here caused wrong targets on layered baskets.
    return
  }
  const isBuy = !String(parsed.action ?? '').toLowerCase().includes('sell')

  for (const leg of filledLegs) {
    const entry = leg.entryPrice
    if (entry == null || !Number.isFinite(entry) || entry <= 0) continue
    if (!Number.isFinite(leg.ticket) || leg.ticket <= 0) continue

    let plannerParsed: ParsedSignal = { ...parsed }
    if (
      signal.channel_id
      && shouldMergeChannelParamsForEntry(plannerParsed)
      && !shouldPreferSignalStopsOverChannelMemory(plannerParsed)
    ) {
      const channelParams = await loadChannelActiveTradeParamsForSymbol(
        args.supabase,
        signal.user_id,
        signal.channel_id,
        symbol,
      )
      if (channelParams) {
        plannerParsed = mergeParsedWithChannelParams(plannerParsed, channelParams)
      }
    }

    const ctx: PlannerContext = {
      point: Number(params?.point ?? 0.00001),
      digits: Number(params?.digits ?? 5),
      minLot: Number(params?.minLot ?? 0.01),
      lotStep: Number(params?.lotStep ?? 0.01),
      contractSize: params?.contractSize != null ? Number(params.contractSize) : null,
      stopsLevel: Number(params?.stopsLevel ?? 0),
      freezeLevel: Number(params?.freezeLevel ?? 0),
      defaultLot: Number(broker.default_lot_size ?? 0.01),
      lastBalance: broker.last_balance ?? null,
    }

    let targetSl = leg.openSl
    let targetTp = leg.openTp
    if (hasPartialTpSchedule && plannedBrokerTp != null && plannedBrokerTp > 0) {
      targetTp = plannedBrokerTp
    } else if (usesPredefinedStops(manual)) {
      const derived = deriveManualStopsWithClamp({
        parsed: plannerParsed,
        manual,
        channelKeywords,
        resolvedSymbol: symbol,
        ctx,
        entryAnchor: entry,
        isBuy,
      })
      if (derived.finalSl != null) targetSl = derived.roundPrice(derived.finalSl)
      if (derived.finalTps.length) {
        const lastTp = derived.finalTps[derived.finalTps.length - 1] ?? derived.finalTps[0]
        targetTp = derived.roundPrice(lastTp)
      }
    } else if (shouldMergeChannelParamsForEntry(plannerParsed)) {
      if (plannerParsed.sl != null) targetSl = plannerParsed.sl
      const lastTp = lastPositiveParsedTpPrice(plannerParsed)
      if (lastTp != null) targetTp = lastTp
    }

    const stripped = stripInvalidStopsForSide({
      stoploss: Number(targetSl) || 0,
      takeprofit: Number(targetTp) || 0,
      referencePrice: entry,
      isBuy,
    })
    const newSl = stripped.stoploss > 0 ? stripped.stoploss : null
    const newTp = stripped.takeprofit > 0 ? stripped.takeprofit : null
    const slChanged = newSl != null && newSl !== leg.openSl
    const tpChanged = newTp != null && newTp !== leg.openTp
    if (!slChanged && !tpChanged) continue

    try {
      await api.orderModify(uuid, {
        ticket: leg.ticket,
        stoploss: newSl,
        takeprofit: newTp,
      })
      if (leg.tradeRowId) {
        await args.supabase
          .from('trades')
          .update({ sl: newSl, tp: newTp })
          .eq('id', leg.tradeRowId)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (isBenignOrderModifyError(msg)) continue
      console.warn(
        `[postFillFollowUp] OrderModify stops failed signal=${signal.id} ticket=${leg.ticket}: ${msg}`,
      )
    }
  }
}

/** Run deferred management after live market fill. */
export async function applyPostFillFollowUp(args: ApplyPostFillFollowUpArgs): Promise<void> {
  const { hooks, signal, parsed, broker, symbol, baseLot, params, op, uuid } = args
  const manual = (broker.manual_settings ?? {}) as ManualSettings

  await applyPipAndChannelStops(args)

  if (manual.close_on_opposite_signal === true) {
    await hooks.closeOppositeDirectionTrades(signal, parsed, broker, symbol)
  }

  // Basket SL/TP refresh and add-to-existing merge run in sendOrder before OrderSend.

  if (!newsBlackoutPreFillEnabled() && !isNewsTradingEnabled(manual)) {
    try {
      const events = await getCalendarEventsCached()
      const blackout = findActiveNewsBlackout(events, manual, symbol)
      if (blackout) {
        await args.supabase.from('trade_execution_logs').insert({
          user_id: signal.user_id,
          signal_id: signal.id,
          broker_account_id: broker.id,
          action: 'post_fill_news_audit',
          status: 'skipped',
          request_payload: {
            symbol,
            phase: blackout.phase,
            event: blackout.event.event,
            note: 'fill already placed; audit only',
          } as unknown as Record<string, unknown>,
        })
      }
    } catch {
      /* audit only */
    }
  }
}
