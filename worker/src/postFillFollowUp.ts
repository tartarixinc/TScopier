/**
 * Post-fill management: channel SL/TP overrides, pip-based stops, opposite close,
 * merge-into-existing — all after broker OrderSend (live fast path).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { FxsocketBrokerClient, MtOperation } from './fxsocketClient'
import type { PlannerContext } from './manualPlanning/types'
import {
  loadChannelActiveTradeParamsForSymbol,
  mergeParsedWithChannelParams,
  shouldMergeChannelParamsForEntry,
  shouldPreferParsedStopsOnEntry,
  stripInvalidStopsForSide,
} from './channelActiveTradeParams'
import { findActiveNewsBlackout } from './newsTrading/blackout'
import { getCalendarEventsCached } from './newsTrading/calendarProvider'
import { isNewsTradingEnabled } from './newsTrading/settings'
import { deriveManualStopsWithClamp, resolvePredefinedSlPips, resolvePredefinedTpPips } from './manualPlanning/manualStops'
import { usesPredefinedStops } from './manualPlanning/manualStops'
import { lastPositiveParsedTpPrice } from './manualPlanning/parsedEntry'
import type { ChannelKeywords, ManualSettings, ParsedSignal } from './manualPlanning/types'
import type { SignalRow } from './tradeExecutor'
import { isBenignOrderModifyError } from './orderModifyBenign'
import { captureDeferredBusinessFailure } from './observability/deferredBusinessEvents'
import { resolvePostFillIsBuy } from './postFillSide'
import { writeExecutionLog } from './observability/executionLog'
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
  api: FxsocketBrokerClient
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
/**
 * Record a post-fill stop/take-profit change. This path previously wrote no row
 * at all, which is why a wrong take-profit could persist unexplained (incident
 * 2026-10-07). Audit only — never fails the trade.
 */
async function recordPostFillStopsChange(
  args: ApplyPostFillFollowUpArgs,
  payload: Record<string, unknown>,
  status: 'success' | 'failed' | 'skipped',
): Promise<void> {
  await writeExecutionLog(args.supabase, {
    user_id: args.signal.user_id,
    signal_id: args.signal.id,
    broker_account_id: args.broker.id,
    action: 'post_fill_stops_modify',
    status,
    request_payload: payload as unknown as Record<string, unknown>,
  })
}
async function applyPipAndChannelStops(args: ApplyPostFillFollowUpArgs): Promise<void> {
  const {
    api, uuid, signal, parsed, broker, channelKeywords, symbol, params, filledLegs,
    plannedBrokerTp, hasPartialTpSchedule,
  } = args
  const manual = (broker.manual_settings ?? {}) as ManualSettings
  const isMulti = (manual.trade_style ?? 'single') === 'multi'
  // Multi legs already carry per-bucket TPs; flattening to tp[0] here was wrong.
  // Still stamp Override signal SL/TP from *this* fill when those settings are on.
  const multiPredefinedSl = isMulti && resolvePredefinedSlPips(manual) != null
  const multiPredefinedTp = isMulti && resolvePredefinedTpPips(manual) != null
  if (isMulti && !multiPredefinedSl && !multiPredefinedTp) {
    return
  }
  const reverse = manual.reverse_signal === true

  for (const leg of filledLegs) {
    const entry = leg.entryPrice
    if (entry == null || !Number.isFinite(entry) || entry <= 0) continue
    if (!Number.isFinite(leg.ticket) || leg.ticket <= 0) continue
    const isBuy = resolvePostFillIsBuy({
      direction: leg.direction,
      parsedAction: parsed.action,
      reverse,
    })

    let plannerParsed: ParsedSignal = { ...parsed }
    if (
      !isMulti
      && signal.channel_id
      && shouldMergeChannelParamsForEntry(plannerParsed)
      && !shouldPreferParsedStopsOnEntry(plannerParsed)
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
    // `leg.openTp` is what the order was actually placed with: the customer's
    // chosen single target, or the planner's rung. Recomputing it from the
    // signal ladder replaced that choice with the deepest level (incident
    // 2026-10-07). Only an explicit TP pip override may replace an existing
    // take-profit; otherwise recompute only when the order went out with none.
    const openTp = Number(leg.openTp)
    const allowTpReplace = resolvePredefinedTpPips(manual) != null || !(openTp > 0)
    let stopSource = 'unchanged'
    if (isMulti) {
      stopSource = multiPredefinedSl || multiPredefinedTp ? 'multi_predefined_from_fill' : 'multi_unchanged'
      const derived = deriveManualStopsWithClamp({
        parsed: plannerParsed,
        manual,
        channelKeywords,
        resolvedSymbol: symbol,
        ctx,
        entryAnchor: entry,
        isBuy,
      })
      if (multiPredefinedSl && derived.finalSl != null) targetSl = derived.roundPrice(derived.finalSl)
      if (multiPredefinedTp && derived.finalTps.length) {
        const existing = Number(leg.openTp)
        const picked = Number.isFinite(existing) && existing > 0
          ? derived.finalTps.reduce((best, tp) => (
            Math.abs(tp - existing) < Math.abs(best - existing) ? tp : best
          ), derived.finalTps[0]!)
          : derived.finalTps[0]!
        targetTp = derived.roundPrice(picked)
      }
    } else if (hasPartialTpSchedule && plannedBrokerTp != null && plannedBrokerTp > 0) {
      stopSource = 'planned_partial_tp'
      targetTp = plannedBrokerTp
    } else if (usesPredefinedStops(manual)) {
      stopSource = 'predefined_stops_from_fill'
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
      if (allowTpReplace && derived.finalTps.length) {
        const lastTp = derived.finalTps[derived.finalTps.length - 1] ?? derived.finalTps[0]
        targetTp = derived.roundPrice(lastTp)
      }
    } else if (shouldMergeChannelParamsForEntry(plannerParsed)) {
      stopSource = 'channel_merge'
      if (plannerParsed.sl != null) targetSl = plannerParsed.sl
      if (allowTpReplace) {
        const lastTp = lastPositiveParsedTpPrice(plannerParsed)
        if (lastTp != null) targetTp = lastTp
      }
    }

    const stripped = stripInvalidStopsForSide({
      stoploss: Number(targetSl) || 0,
      takeprofit: (isMulti && !multiPredefinedTp) ? 0 : (Number(targetTp) || 0),
      referencePrice: entry,
      isBuy,
    })
    const newSl = stripped.stoploss > 0 ? stripped.stoploss : null
    const newTp = (isMulti && !multiPredefinedTp)
      ? leg.openTp
      : (stripped.takeprofit > 0 ? stripped.takeprofit : null)
    const slChanged = newSl != null && newSl !== leg.openSl
    const tpChanged = newTp != null && newTp !== leg.openTp && (!isMulti || multiPredefinedTp)
    if (!slChanged && !tpChanged) continue
    const changePayload = {
      symbol,
      side: isBuy ? 'buy' : 'sell',
      ticket: leg.ticket,
      trade_id: leg.tradeRowId,
      stop_source: stopSource,
      entry_price: entry,
      from_sl: leg.openSl,
      to_sl: slChanged ? newSl : leg.openSl,
      from_tp: leg.openTp,
      to_tp: tpChanged ? newTp : leg.openTp,
      sl_changed: slChanged,
      tp_changed: tpChanged,
    }
    try {
      const modifyArgs: { ticket: number; stoploss?: number | null; takeprofit?: number | null } = {
        ticket: leg.ticket,
      }
      if (slChanged) modifyArgs.stoploss = newSl
      if (tpChanged) modifyArgs.takeprofit = newTp
      await api.orderModify(uuid, modifyArgs)
      if (leg.tradeRowId) {
        const patch: { sl?: number | null; tp?: number | null } = {}
        if (slChanged) patch.sl = newSl
        if (tpChanged) patch.tp = newTp
        if (Object.keys(patch).length > 0) {
          await args.supabase
            .from('trades')
            .update(patch)
            .eq('id', leg.tradeRowId)
        }
      }
      await recordPostFillStopsChange(args, changePayload, 'success')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (isBenignOrderModifyError(msg)) {
        await recordPostFillStopsChange(args, { ...changePayload, error: msg }, 'skipped')
        continue
      }
      await recordPostFillStopsChange(args, { ...changePayload, error: msg }, 'failed')
      console.warn(
        `[postFillFollowUp] OrderModify stops failed signal=${signal.id} ticket=${leg.ticket}: ${msg}`,
      )
      captureDeferredBusinessFailure({
        category: 'management',
        event: slChanged && !tpChanged ? 'stop_loss_update_failed' : tpChanged && !slChanged ? 'take_profit_update_failed' : 'deferred_trade_follow_up_failed',
        severity: 'error',
        reasonCode: slChanged && !tpChanged ? 'POST_FILL_SL_UPDATE_FAILED' : tpChanged && !slChanged ? 'POST_FILL_TP_UPDATE_FAILED' : 'POST_FILL_STOPS_UPDATE_FAILED',
        message: 'Post-fill stop update failed after broker entry success',
        userImpact: 'partial',
        operation: 'post_fill_stop_update',
        err,
        context: {
          user_id: signal.user_id,
          signal_id: signal.id,
          channel_id: signal.channel_id,
          broker_account_id: broker.id,
          trade_id: leg.tradeRowId,
          symbol,
          side: isBuy ? 'buy' : 'sell',
          extra: {
            broker_ticket_present: true,
            stop_loss_targeted: slChanged,
            take_profit_targeted: tpChanged,
            failed_count: 1,
          },
        },
      })
    }
  }
}

/** Run deferred management after live market fill. */
export async function applyPostFillFollowUp(args: ApplyPostFillFollowUpArgs): Promise<void> {
  const { hooks, signal, parsed, broker, symbol } = args
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
        await writeExecutionLog(args.supabase, {
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
