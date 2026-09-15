import {
  isBrokerDisconnectedMessage,
  isOrderOpTimedOutMessage,
  FxsocketBrokerClient,
  MtOperation,
} from '../fxsocketClient'
import { isMtBridgeGlitchMessage } from '../brokerConnectError'
import type { ChannelKeywords, ManualSettings, PlannerResult, VirtualPendingLeg } from '../manualPlanner'
import {
  autoManagementTradeSnapshot,
  normalizeAutoBeConfig,
  resolveAutoBeTpHitTriggerPrice,
} from '../autoManagement'
import { stripInvalidStopsForSide } from '../channelActiveTradeParams'
import { isInvalidStopsError } from '../orderModifySafe'
import { humanizeOrderSendError, tradeFailureReasonFromBrokerMessage } from '../brokerTradeError'
import { trailingTradeRowSnapshot } from '../trailingStop'
import { applyPostFillFollowUp, type PostFillTradeLeg } from '../postFillFollowUp'
import type { TradeExecutorContext } from './context'
import { clampOrderStops, isBuySideOp, resolveBurstFillAnchor, type Leg } from './helpers'
import type { BrokerRow, ParsedSignal, SendOrderOutcome, SignalRow, SymbolCacheEntry, SymbolMappingResult } from './types'
import { isV2 } from '../engine/executionMode'
import { getFxClient, toMtPlatform } from '../engine/fxClient'
import type { FxOpenOrder } from '../engine/fxContract'
import { SKIP_REASON_ENTRY_NOT_OPENED } from '../manualPlanner'
import { materializeBrokerRangePendingLegs } from './materializeBrokerRangePendingLegs'
import type { PreparedEntry } from './entryPrepare'
import {
  buildPipelineCorrelation,
  emitPipelineEvent,
  setPipelineTimestamp,
} from '../pipelineTimestamps'
import { ensureSignalRow, isSignalFkViolation } from '../ensureSignalRow'
import { captureWorkerWarning } from '../observability/sentry'
import {
  addBusinessBreadcrumb,
  captureBusinessIssue,
  classifyBrokerFailureReason,
} from '../observability/businessEvents'
import { captureDeferredBusinessFailure } from '../observability/deferredBusinessEvents'
import { collapseIdenticalImmediateLegs } from './collapseIdenticalImmediateLegs'

export { collapseIdenticalImmediateLegs }

/** Normalized broker fill shape shared by the v1 client and the v2 fxClient. */
type NormalizedFill = {
  ticket: number
  openPrice: number | null
  stopLoss: number | null
  takeProfit: number | null
  lots: number | null
}

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
  deferBrokerRangePendingMaterialize: boolean
  brokerPendingMode: boolean
  prepAnchor: number | null
  prepAnchorSource: 'signal' | 'quote' | 'fill' | 'unknown'
  virtualPendings: VirtualPendingLeg[]
  plan: PlannerResult
  materializedVirtuals: boolean
  strictBrokerPlaced: boolean
  strictDeferred: boolean
  op: MtOperation
  channelKeywords: ChannelKeywords | null
  baseLot: number
  syncMultiLegTps: boolean
  prep: PreparedEntry
}

export async function sendImmediateLegs(input: SendImmediateLegsInput): Promise<SendOrderOutcome> {
  const {
    ctx, signal, parsed, broker, manual, api, uuid, symbol, requestedSymbol, mapping, params,
    legs, liveEntryFast, pipelineT0, strictEntryPrefetch, channelDelayMs, channelDelaySkipped,
    deferVirtualAnchor, deferBrokerRangePendingMaterialize, brokerPendingMode,
    prepAnchor, prepAnchorSource, virtualPendings, plan, materializedVirtuals, strictBrokerPlaced,
    strictDeferred, op, channelKeywords, baseLot, syncMultiLegTps, prep,
  } = input

  if (legs.length === 0) {
    // No immediates — virtual range ladder and/or broker strict-entry pending.
    return (materializedVirtuals || strictBrokerPlaced)
      ? { openedOrMerged: true, channelDelayMs, channelDelaySkipped }
      : {
        channelDelayMs,
        channelDelaySkipped,
        failureReason: SKIP_REASON_ENTRY_NOT_OPENED,
      }
  }

  // Drop identical full-lot clones only (not granular multi/range legs).
  const collapsed = collapseIdenticalImmediateLegs(legs, { baseLot })
  const workingLegs = collapsed.legs
  if (collapsed.collapsed > 0) {
    console.warn(
      `[tradeExecutor] duplicate_leg_collapsed removed=${collapsed.collapsed}`
      + ` kept=${workingLegs.length} signal=${signal.id} broker=${broker.id}`,
    )
    try {
      await ctx.supabase.from('trade_execution_logs').insert({
        user_id: signal.user_id,
        signal_id: signal.id,
        broker_account_id: broker.id,
        action: 'duplicate_leg_collapsed',
        status: 'info',
        request_payload: {
          removed: collapsed.collapsed,
          kept: workingLegs.length,
        } as unknown as Record<string, unknown>,
      })
    } catch { /* best-effort */ }
  }

  if (manual.trade_style !== 'multi' && workingLegs.length > 1) {
    console.error(
      `[tradeExecutor] single_style_multi_leg_blocked ${workingLegs.length} legs`
      + ` signal=${signal.id} broker=${broker.id}`,
    )
    try {
      await ctx.supabase.from('trade_execution_logs').insert({
        user_id: signal.user_id,
        signal_id: signal.id,
        broker_account_id: broker.id,
        action: 'single_style_multi_leg_blocked',
        status: 'failed',
        request_payload: { leg_count: workingLegs.length } as unknown as Record<string, unknown>,
        error_message: `single trade_style refused ${workingLegs.length} immediate legs`,
      })
    } catch { /* best-effort */ }
    return {
      channelDelayMs,
      channelDelaySkipped,
      failureReason: 'single_style_multi_leg_blocked',
    }
  }

  const sendLegs = workingLegs

  const totalCount = sendLegs.length
  const orderLogContext: Record<string, unknown> = {
    signal_symbol: parsed.symbol ?? null,
    trade_symbol: requestedSymbol,
  }
  if (mapping.whitelist.length > 0) {
    orderLogContext.allowed_symbols = mapping.whitelist
  }

  const filledLegs: PostFillTradeLeg[] = []
  let lastSendError: string | null = null

  // v2 entries fire PROTECTED-at-send through the strict fxClient (bounded timeout,
  // strict retcode, no blind 3x retries) instead of the old client. One pre-burst
  // OpenedOrders snapshot powers ambiguous-send adoption so retries never duplicate.
  const useV2 = isV2({ brokerAccountId: broker.id, userId: signal.user_id })
  const v2Platform = toMtPlatform(broker.platform)
  const v2Snapshot: FxOpenOrder[] = useV2
    ? await getFxClient().openedOrders(uuid, v2Platform).catch(() => [])
    : []

  const sendLeg = async (leg: Leg): Promise<boolean> => {
    let args = leg.args
    const isBuyLeg = isBuySideOp(String(args.operation))
    const isMarket = args.operation === 'Buy' || args.operation === 'Sell'
    if (isMarket && (!args.price || args.price <= 0) && (strictEntryPrefetch || api)) {
      try {
        const q = strictEntryPrefetch ?? await api!.quote(uuid, symbol)
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
    let sendArgs = args
    const plannedSl = Number(args.stoploss) || 0
    const plannedTp = Number(args.takeprofit) || 0
    const t0 = Date.now()
    if (liveEntryFast && signal.pipeline_ts && signal.pipeline_ts.t_first_broker_send == null) {
      setPipelineTimestamp(signal.pipeline_ts, 'broker_request_started_at', t0)
    } else if (signal.pipeline_ts && signal.pipeline_ts.broker_request_started_at == null) {
      setPipelineTimestamp(signal.pipeline_ts, 'broker_request_started_at', t0)
    }

    let stopsFallback = false
    let result: NormalizedFill | null = null
    let lastAttemptError: string
    let correlation = buildPipelineCorrelation({
      userId: signal.user_id,
      signalId: signal.id,
      channelId: signal.channel_id,
      telegramMessageId: signal.telegram_message_id,
      brokerAccountId: broker.id,
      executionAttemptId: `${signal.id}:${broker.id}:${leg.idx}:1`,
      brokerRequestId: `${signal.id}:${broker.id}:${leg.idx}`,
      dispatchSource: signal.dispatch_source,
    })

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const attemptNo = attempt + 1
        correlation = buildPipelineCorrelation({
          userId: signal.user_id,
          signalId: signal.id,
          channelId: signal.channel_id,
          telegramMessageId: signal.telegram_message_id,
          brokerAccountId: broker.id,
          executionAttemptId: `${signal.id}:${broker.id}:${leg.idx}:${attemptNo}`,
          brokerRequestId: `${signal.id}:${broker.id}:${leg.idx}`,
          dispatchSource: signal.dispatch_source,
        })
        if (useV2) {
          const sendPromise = getFxClient().orderSend(
            uuid,
            v2Platform,
            {
              symbol: sendArgs.symbol,
              operation: sendArgs.operation,
              volume: sendArgs.volume,
              price: Number(sendArgs.price) > 0 ? Number(sendArgs.price) : undefined,
              stopLoss: Number(sendArgs.stoploss) > 0 ? Number(sendArgs.stoploss) : undefined,
              takeProfit: Number(sendArgs.takeprofit) > 0 ? Number(sendArgs.takeprofit) : undefined,
              comment: sendArgs.comment,
              slippage: sendArgs.slippage,
              expertId: sendArgs.expertID,
            },
            { anchorSignalId: signal.id, legIndex: leg.idx, preSnapshot: v2Snapshot },
          )
          emitPipelineEvent({
            event: 'broker_request_started',
            correlation,
            timestamps: signal.pipeline_ts,
            outcome: 'started',
            path: 'fxsocket_v2',
            extra: {
              symbol: sendArgs.symbol,
              operation: sendArgs.operation,
              leg: leg.idx + 1,
              total: totalCount,
              attempt: attemptNo,
            },
          }, { deferLog: true })
          addBusinessBreadcrumb({
            category: 'broker',
            event: 'broker_request_started',
            context: {
              user_id: signal.user_id,
              signal_id: signal.id,
              channel_id: signal.channel_id,
              telegram_message_id: signal.telegram_message_id,
              broker_account_id: broker.id,
              execution_attempt_id: correlation.execution_attempt_id,
              broker_request_id: correlation.broker_request_id,
              symbol: sendArgs.symbol,
              operation: sendArgs.operation,
              execution_mechanism: useV2 ? 'fxsocket_v2' : 'fxsocket_v1',
              retry_attempt: attemptNo,
              user_impact: 'none',
            },
          })
          const r = await sendPromise
          if (!r.ok || !r.ticket) throw new Error(r.message || `v2 order_send rejected (${r.retcodeName})`)
          result = {
            ticket: r.ticket,
            openPrice: r.price,
            stopLoss: Number(sendArgs.stoploss) > 0 ? Number(sendArgs.stoploss) : null,
            takeProfit: Number(sendArgs.takeprofit) > 0 ? Number(sendArgs.takeprofit) : null,
            lots: r.volume ?? sendArgs.volume,
          }
        } else {
          const sendPromise = api.orderSend(uuid, sendArgs)
          emitPipelineEvent({
            event: 'broker_request_started',
            correlation,
            timestamps: signal.pipeline_ts,
            outcome: 'started',
            path: 'fxsocket_v1',
            extra: {
              symbol: sendArgs.symbol,
              operation: sendArgs.operation,
              leg: leg.idx + 1,
              total: totalCount,
              attempt: attemptNo,
            },
          }, { deferLog: true })
          addBusinessBreadcrumb({
            category: 'broker',
            event: 'broker_request_started',
            context: {
              user_id: signal.user_id,
              signal_id: signal.id,
              channel_id: signal.channel_id,
              telegram_message_id: signal.telegram_message_id,
              broker_account_id: broker.id,
              execution_attempt_id: correlation.execution_attempt_id,
              broker_request_id: correlation.broker_request_id,
              symbol: sendArgs.symbol,
              operation: sendArgs.operation,
              execution_mechanism: useV2 ? 'fxsocket_v2' : 'fxsocket_v1',
              retry_attempt: attemptNo,
              user_impact: 'none',
            },
          })
          const raw = await sendPromise
          result = {
            ticket: raw.ticket,
            openPrice: raw.openPrice ?? null,
            stopLoss: raw.stopLoss ?? null,
            takeProfit: raw.takeProfit ?? null,
            lots: raw.lots ?? null,
          }
        }
        break
      } catch (err) {
        setPipelineTimestamp(signal.pipeline_ts ?? (signal.pipeline_ts = {}), 'broker_response_received_at', Date.now())
        lastAttemptError = humanizeOrderSendError(
          err instanceof Error ? err.message : String(err),
          sendArgs.symbol,
        )
        const hasStops = (Number(sendArgs.stoploss) || 0) > 0 || (Number(sendArgs.takeprofit) || 0) > 0
        if (attempt === 0 && isInvalidStopsError(lastAttemptError) && hasStops) {
          console.warn(
            `[tradeExecutor] retry without stops signal=${signal.id} broker=${broker.id} leg=${leg.idx + 1}/${totalCount}`
            + ` reason="${lastAttemptError}" (sl=${sendArgs.stoploss} tp=${sendArgs.takeprofit})`,
          )
          sendArgs = { ...sendArgs, stoploss: 0, takeprofit: 0 }
          stopsFallback = true
          continue
        }
        lastSendError = lastAttemptError
        if (isBrokerDisconnectedMessage(lastAttemptError) && !isMtBridgeGlitchMessage(lastAttemptError)) {
          await ctx.markBrokerSessionDown(broker, uuid, lastAttemptError)
        }
        console.error(
          `[tradeExecutor] OrderSend failed signal=${signal.id} broker=${broker.id} leg=${leg.idx + 1}/${totalCount} op=${sendArgs.operation} price=${sendArgs.price ?? 0}:`,
          lastAttemptError,
        )
        if (isOrderOpTimedOutMessage(lastAttemptError)) {
          captureBusinessIssue({
            category: 'broker',
            event: 'broker_order_ambiguous',
            severity: 'error',
            reasonCode: 'BROKER_TIMEOUT',
            message: 'Broker OrderSend timed out; outcome requires reconciliation',
            userImpact: 'manual_review_required',
            fingerprint: ['broker_order_ambiguous', 'order_send', 'BROKER_TIMEOUT', useV2 ? 'fxsocket_v2' : 'fxsocket_v1'],
            context: {
              user_id: signal.user_id,
              signal_id: signal.id,
              channel_id: signal.channel_id,
              telegram_message_id: signal.telegram_message_id,
              broker_account_id: broker.id,
              execution_attempt_id: correlation.execution_attempt_id,
              broker_request_id: correlation.broker_request_id,
              dispatch_source: signal.dispatch_source,
              stage: 'order_send',
              retry_attempt: attempt + 1,
              symbol: sendArgs.symbol,
              operation: sendArgs.operation,
              execution_mechanism: useV2 ? 'fxsocket_v2' : 'fxsocket_v1',
              extra: {
                path: useV2 ? 'fxsocket_v2' : 'fxsocket_v1',
                operation: sendArgs.operation,
                symbol: sendArgs.symbol,
                leg: leg.idx + 1,
                total: totalCount,
              },
            },
          })
        } else {
          const reasonCode = classifyBrokerFailureReason(lastAttemptError)
          captureBusinessIssue({
            category: 'trade',
            event: reasonCode === 'INSUFFICIENT_MARGIN'
              ? 'trade_copy_failed'
              : reasonCode === 'BROKER_SYMBOL_NOT_FOUND'
                ? 'trade_copy_blocked'
                : 'broker_order_rejected',
            severity: reasonCode === 'BROKER_RATE_LIMITED' ? 'warning' : 'error',
            reasonCode,
            message: reasonCode === 'BROKER_SYMBOL_NOT_FOUND'
              ? `Broker does not offer ${sendArgs.symbol} — symbol not in broker inventory`
              : 'Broker rejected trade copy order',
            userImpact: 'failed',
            context: {
              user_id: signal.user_id,
              signal_id: signal.id,
              channel_id: signal.channel_id,
              telegram_message_id: signal.telegram_message_id,
              broker_account_id: broker.id,
              execution_attempt_id: correlation.execution_attempt_id,
              broker_request_id: correlation.broker_request_id,
              dispatch_source: signal.dispatch_source,
              stage: 'order_send',
              retry_attempt: attempt + 1,
              symbol: sendArgs.symbol,
              operation: sendArgs.operation,
              execution_mechanism: useV2 ? 'fxsocket_v2' : 'fxsocket_v1',
              extra: {
                leg: leg.idx + 1,
                total: totalCount,
                stable_broker_reason: reasonCode,
              },
            },
          })
        }
        const tradeFailure = tradeFailureReasonFromBrokerMessage(lastAttemptError, {
          requestedSymbol,
          brokerSymbol: sendArgs.symbol,
          operation: sendArgs.operation,
        })
        await ctx.supabase.from('trade_execution_logs').insert({
          user_id: signal.user_id,
          signal_id: signal.id,
          broker_account_id: broker.id,
          action: 'order_send',
          status: 'failed',
          request_payload: {
            ...sendArgs,
            ...orderLogContext,
            ...(tradeFailure
              ? {
                reason_code: tradeFailure.reasonCode,
                trade_failure: tradeFailure,
              }
              : {}),
          } as unknown as Record<string, unknown>,
          error_message: lastAttemptError,
        })
        emitPipelineEvent({
          event: isOrderOpTimedOutMessage(lastAttemptError) ? 'execution_ambiguous' : 'broker_request_failed',
          correlation,
          timestamps: signal.pipeline_ts,
          outcome: 'failed',
          path: useV2 ? 'fxsocket_v2' : 'fxsocket_v1',
          error_code: lastAttemptError.slice(0, 120),
          extra: {
            symbol: sendArgs.symbol,
            operation: sendArgs.operation,
            leg: leg.idx + 1,
            total: totalCount,
          },
        })
        return false
      }
    }

    if (!result) return false

    const latencyMs = Date.now() - t0
    if (liveEntryFast && signal.pipeline_ts) {
      setPipelineTimestamp(signal.pipeline_ts, 'broker_response_received_at', Date.now())
      setPipelineTimestamp(signal.pipeline_ts, 'broker_execution_confirmed_at', Date.now())
    } else if (signal.pipeline_ts) {
      setPipelineTimestamp(signal.pipeline_ts, 'broker_response_received_at', Date.now())
      setPipelineTimestamp(signal.pipeline_ts, 'broker_execution_confirmed_at', Date.now())
    }
    emitPipelineEvent({
      event: 'broker_request_succeeded',
      correlation,
      timestamps: signal.pipeline_ts,
      outcome: 'success',
      path: useV2 ? 'fxsocket_v2' : 'fxsocket_v1',
      extra: {
        broker_ticket: result.ticket,
        symbol: sendArgs.symbol,
        operation: sendArgs.operation,
        leg: leg.idx + 1,
        total: totalCount,
        latency_ms: latencyMs,
        stops_fallback: stopsFallback || undefined,
      },
    })
    console.log(
      `[tradeExecutor] OrderSend ok signal=${signal.id} broker=${broker.id} ticket=${result.ticket} leg=${leg.idx + 1}/${totalCount}`
      + ` price=${sendArgs.price ?? 0} ${latencyMs}ms v2=${useV2}${stopsFallback ? ' stops_fallback' : ''}`,
    )

    const isBuy = !sendArgs.operation.toLowerCase().includes('sell')
    const entryPx = result.openPrice ?? sendArgs.price ?? null
    const openSl = stopsFallback ? (plannedSl > 0 ? plannedSl : null) : (result.stopLoss ?? sendArgs.stoploss ?? null)
    const openTp = stopsFallback ? (plannedTp > 0 ? plannedTp : null) : (result.takeProfit ?? sendArgs.takeprofit ?? null)
    const trailCols = trailingTradeRowSnapshot(
      manual,
      entryPx,
      openSl,
    )
    const autoBeCols = autoManagementTradeSnapshot(manual, entryPx, openSl, {
      tpHitTriggerPrice: leg.autoBeTpHitTriggerPrice
        ?? resolveAutoBeTpHitTriggerPrice({
          tpIndex: normalizeAutoBeConfig(manual)?.tpIndex ?? 1,
          partialTps: leg.partialTps,
          brokerTp: openTp,
        }),
    })
    const tradeRowPayload = {
      user_id: signal.user_id,
      signal_id: signal.id,
      telegram_channel_id: signal.channel_id,
      broker_account_id: broker.id,
      metaapi_order_id: result.ticket != null ? String(result.ticket) : null,
      symbol: sendArgs.symbol,
      direction: isBuy ? 'buy' : 'sell',
      entry_price: entryPx,
      sl: openSl,
      tp: openTp,
      lot_size: result.lots ?? sendArgs.volume,
      status: sendArgs.operation.includes('Limit') || sendArgs.operation.includes('Stop') ? 'pending' : 'open',
      opened_at: new Date().toISOString(),
      cwe_close_price: leg.cweClosePrice ?? null,
      ...trailCols,
      ...autoBeCols,
    }
    const filledLeg: PostFillTradeLeg = {
      tradeRowId: null,
      ticket: result.ticket,
      symbol: sendArgs.symbol,
      direction: isBuy ? 'buy' : 'sell',
      entryPrice: entryPx,
      openSl: openSl != null ? Number(openSl) : null,
      openTp: openTp != null ? Number(openTp) : null,
    }

    const persistPostFillDb = async (tradeRowId: string | null) => {
      if (tradeRowId && leg.partialTps && leg.partialTps.length > 0) {
        const partialRows = leg.partialTps.map(p => ({
          trade_id: tradeRowId,
          signal_id: signal.id,
          user_id: signal.user_id,
          broker_account_id: broker.id,
          metaapi_account_id: uuid,
          symbol: sendArgs.symbol,
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
          captureWorkerWarning(partialErr, {
            subsystem: 'persistence',
            operation: 'partial_tp_persist_failed',
            errorCode: 'PARTIAL_TP_PERSIST_FAILED',
            fingerprint: ['persistence', 'PARTIAL_TP_PERSIST_FAILED', 'post_fill'],
            context: {
              user_id: signal.user_id,
              signal_id: signal.id,
              broker_account_id: broker.id,
              stage: 'post_fill_persistence',
              extra: { trade_row_id: tradeRowId },
            },
          })
        }
      }
      if (prep.layeringRuntime?.onImmediateFill) {
        try {
          await prep.layeringRuntime.onImmediateFill({
            entryPrice: entryPx,
            lot: result.lots ?? sendArgs.volume,
            tradeRowId,
            ticket: result.ticket ?? null,
          })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          await ctx.supabase.from('trade_execution_logs').insert({
            user_id: signal.user_id,
            signal_id: signal.id,
            broker_account_id: broker.id,
            action: 'layering_first_fill_activation',
            status: 'reconciliation_required',
            request_payload: {
              broker_ticket_present: result.ticket != null,
              trade_row_id_present: tradeRowId != null,
              symbol: sendArgs.symbol,
              operation: sendArgs.operation,
            } as unknown as Record<string, unknown>,
            error_message: message,
          })
          captureBusinessIssue({
            category: 'layering',
            event: 'layering_plan_activation_failed',
            severity: 'error',
            reasonCode: 'LAYERING_FIRST_FILL_ACTIVATION_FAILED',
            message: 'Broker accepted entry but first-fill layer activation failed',
            userImpact: 'manual_review_required',
            context: {
              user_id: signal.user_id,
              signal_id: signal.id,
              channel_id: signal.channel_id,
              broker_account_id: broker.id,
              trade_id: tradeRowId,
              symbol: sendArgs.symbol,
              operation: sendArgs.operation,
              layering_mode: prep.layeringRuntime.mode,
              extra: {
                broker_ticket_present: result.ticket != null,
                trade_row_id_present: tradeRowId != null,
              },
            },
          })
          throw err
        }
      }
      const logRow = {
        user_id: signal.user_id,
        signal_id: signal.id,
        broker_account_id: broker.id,
        action: 'order_send',
        status: 'success',
        request_payload: {
          ...sendArgs,
          ...orderLogContext,
          ...(stopsFallback ? { stops_fallback: true } : {}),
        } as unknown as Record<string, unknown>,
        response_payload: {
          ticket: result.ticket,
          latency_ms: latencyMs,
          pipeline_ms: pipelineT0 != null ? Date.now() - pipelineT0 : undefined,
          leg: leg.idx + 1,
          total: totalCount,
        },
      }
      const { error: logErr } = await ctx.supabase.from('trade_execution_logs').insert(logRow)
      if (logErr) {
        console.error(
          `[tradeExecutor] order_send log INSERT failed signal=${signal.id} broker=${broker.id} ticket=${result.ticket}: ${logErr.message}`,
        )
        if (isSignalFkViolation(logErr.message)) {
          const ensured = await ensureSignalRow(ctx.supabase, {
            id: signal.id,
            user_id: signal.user_id,
            channel_id: signal.channel_id,
            status: signal.status || 'parsed',
            parsed_data: (signal.parsed_data ?? null) as Record<string, unknown> | null,
            telegram_message_id: signal.telegram_message_id ?? null,
            reply_to_message_id: signal.reply_to_message_id ?? null,
            parent_signal_id: signal.parent_signal_id,
            is_modification: signal.is_modification,
            raw_message: '',
          })
          if (ensured.ok) {
            const { error: retryLogErr } = await ctx.supabase.from('trade_execution_logs').insert(logRow)
            if (retryLogErr) {
              console.error(
                `[tradeExecutor] order_send log retry failed signal=${signal.id} ticket=${result.ticket}: ${retryLogErr.message}`,
              )
            }
          }
        }
      }
    }

    const insertTradeRowWithFkRetry = async (): Promise<string | null> => {
      const first = await ctx.supabase
        .from('trades')
        .insert(tradeRowPayload)
        .select('id')
        .maybeSingle()
      if (!first.error) {
        return (first.data as { id?: string } | null)?.id ?? null
      }
      console.error(
        `[tradeExecutor] trades INSERT failed signal=${signal.id} broker=${broker.id} ticket=${result.ticket}: ${first.error.message}`,
      )
      captureBusinessIssue({
        category: 'persistence',
        event: 'broker_success_persistence_failed',
        severity: 'error',
        reasonCode: 'BROKER_SUCCESS_DB_FAILURE',
        message: 'Broker accepted order but trade row persistence failed',
        userImpact: 'manual_review_required',
        fingerprint: ['broker_success_persistence_failed', 'trades_insert', 'BROKER_SUCCESS_DB_FAILURE'],
        context: {
          user_id: signal.user_id,
          signal_id: signal.id,
          channel_id: signal.channel_id,
          telegram_message_id: signal.telegram_message_id,
          broker_account_id: broker.id,
          stage: 'post_broker_success_persistence',
          extra: {
            broker_ticket_present: result.ticket != null,
            leg: leg.idx + 1,
            total: totalCount,
            symbol: sendArgs.symbol,
          },
        },
      })
      if (!isSignalFkViolation(first.error.message)) return null
      const ensured = await ensureSignalRow(ctx.supabase, {
        id: signal.id,
        user_id: signal.user_id,
        channel_id: signal.channel_id,
        status: signal.status || 'parsed',
        parsed_data: (signal.parsed_data ?? null) as Record<string, unknown> | null,
        telegram_message_id: signal.telegram_message_id ?? null,
        reply_to_message_id: signal.reply_to_message_id ?? null,
        parent_signal_id: signal.parent_signal_id,
        is_modification: signal.is_modification,
        raw_message: '',
      })
      if (!ensured.ok) {
        console.error(
          `[tradeExecutor] ensureSignalRow after trades FK fail signal=${signal.id}: ${ensured.error ?? 'unknown'}`,
        )
        return null
      }
      const retry = await ctx.supabase
        .from('trades')
        .insert(tradeRowPayload)
        .select('id')
        .maybeSingle()
      if (retry.error) {
        console.error(
          `[tradeExecutor] trades INSERT retry failed signal=${signal.id} broker=${broker.id} ticket=${result.ticket}: ${retry.error.message}`,
        )
        captureBusinessIssue({
          category: 'persistence',
          event: 'broker_success_persistence_failed',
          severity: 'error',
          reasonCode: 'BROKER_SUCCESS_DB_FAILURE',
          message: 'Broker accepted order but trade row persistence retry failed',
          userImpact: 'manual_review_required',
          fingerprint: ['broker_success_persistence_failed', 'trades_insert_retry', 'BROKER_SUCCESS_DB_FAILURE'],
          context: {
            user_id: signal.user_id,
            signal_id: signal.id,
            channel_id: signal.channel_id,
            telegram_message_id: signal.telegram_message_id,
            broker_account_id: broker.id,
            stage: 'post_broker_success_persistence_retry',
            symbol: sendArgs.symbol,
            extra: { broker_ticket_present: result.ticket != null },
          },
        })
        return null
      }
      console.warn(
        `[tradeExecutor] trades INSERT recovered after ensureSignalRow signal=${signal.id} ticket=${result.ticket}`,
      )
      return (retry.data as { id?: string } | null)?.id ?? null
    }

    if (liveEntryFast && prep.layeringRuntime?.onImmediateFill) {
      filledLeg.tradeRowId = await insertTradeRowWithFkRetry()
      filledLegs.push(filledLeg)
      await persistPostFillDb(filledLeg.tradeRowId)
      if (signal.pipeline_ts) {
        setPipelineTimestamp(signal.pipeline_ts, 'execution_state_persisted_at', Date.now())
      }
    } else if (liveEntryFast) {
      filledLegs.push(filledLeg)
      void (async () => {
        const tradeRowId = await insertTradeRowWithFkRetry()
        filledLeg.tradeRowId = tradeRowId
        await persistPostFillDb(tradeRowId)
        if (signal.pipeline_ts) {
          setPipelineTimestamp(signal.pipeline_ts, 'execution_state_persisted_at', Date.now())
        }
      })().catch(err => {
        console.error(
          `[tradeExecutor] post-fill persist failed signal=${signal.id} broker=${broker.id} ticket=${result.ticket}:`,
          err instanceof Error ? err.message : String(err),
        )
        captureDeferredBusinessFailure({
          category: 'persistence',
          event: 'broker_success_persistence_failed',
          severity: 'error',
          reasonCode: 'BROKER_SUCCESS_DB_FAILURE',
          message: 'Broker accepted order but deferred trade persistence failed',
          userImpact: 'manual_review_required',
          operation: 'post_fill_background_persistence',
          err,
          fingerprint: ['broker_success_persistence_failed', 'post_fill_background', 'BROKER_SUCCESS_DB_FAILURE'],
          context: {
            user_id: signal.user_id,
            signal_id: signal.id,
            channel_id: signal.channel_id,
            telegram_message_id: signal.telegram_message_id,
            broker_account_id: broker.id,
            broker_request_id: `${signal.id}:${broker.id}:${leg.idx}`,
            trade_id: filledLeg.tradeRowId,
            symbol: sendArgs.symbol,
            side: isBuy ? 'buy' : 'sell',
            execution_mechanism: useV2 ? 'fxsocket_v2' : 'fxsocket_v1',
            extra: {
              broker_ticket_present: result.ticket != null,
              leg: leg.idx + 1,
              total: totalCount,
            },
          },
        })
      })
    } else {
      filledLeg.tradeRowId = await insertTradeRowWithFkRetry()
      filledLegs.push(filledLeg)
      await persistPostFillDb(filledLeg.tradeRowId)
      if (signal.pipeline_ts) {
        setPipelineTimestamp(signal.pipeline_ts, 'execution_state_persisted_at', Date.now())
      }
    }
    return true
  }

  // All immediates fan out in parallel. Virtual pendings are already
  // persisted; the worker monitor + edge sweep will fire them on trigger.
  const sendResults = await Promise.allSettled(sendLegs.map(sendLeg))

  let materializedBrokerPendings = materializedVirtuals
  if (deferBrokerRangePendingMaterialize && brokerPendingMode && virtualPendings.length > 0 && api) {
    const fillAnchor = resolveBurstFillAnchor(
      filledLegs.map(l => l.entryPrice),
      plan.isBuy !== false,
    )
    let anchor = fillAnchor ?? prepAnchor
    let anchorSource: 'signal' | 'quote' | 'fill' | 'unknown' = fillAnchor != null
      ? 'fill'
      : prepAnchorSource
    if ((anchor == null || anchor <= 0) && strictEntryPrefetch) {
      const isBuyLeg = !op.toLowerCase().includes('sell')
      anchor = isBuyLeg ? strictEntryPrefetch.ask : strictEntryPrefetch.bid
      anchorSource = 'quote'
    }
    const runBrokerMaterialize = async () => {
      if (anchor == null || !Number.isFinite(anchor) || anchor <= 0) {
        console.warn(
          `[tradeExecutor] deferred broker range pending: no anchor signal=${signal.id} broker=${broker.id}`,
        )
        return false
      }
      return materializeBrokerRangePendingLegs(
        ctx,
        prep,
        strictBrokerPlaced,
        { anchor, anchorSource },
      )
    }
    if (liveEntryFast) {
      void runBrokerMaterialize().catch(err => {
        console.error(
          `[tradeExecutor] deferred broker range pending failed signal=${signal.id} broker=${broker.id}:`,
          err,
        )
        captureDeferredBusinessFailure({
          category: 'layering',
          event: 'layering_materialization_failed',
          severity: 'error',
          reasonCode: 'BROKER_PENDING_MATERIALIZATION_FAILED',
          message: 'Deferred broker-pending layer materialization failed after entry success',
          userImpact: 'partial',
          operation: 'deferred_broker_pending_materialize',
          err,
          context: {
            user_id: signal.user_id,
            signal_id: signal.id,
            channel_id: signal.channel_id,
            telegram_message_id: signal.telegram_message_id,
            broker_account_id: broker.id,
            symbol,
            side: plan.isBuy === false ? 'sell' : 'buy',
            execution_mechanism: 'broker_pending_order',
            layering_mode: plan.rangeLayering?.rangeLayeringType ?? 'pending_order',
            extra: {
              targeted_count: virtualPendings.length,
              successful_count: 0,
              failed_count: virtualPendings.length,
              anchor_source: anchorSource,
            },
          },
        })
      })
      materializedBrokerPendings = true
    } else {
      materializedBrokerPendings = await runBrokerMaterialize()
    }
  }

  if (deferVirtualAnchor && virtualPendings.length > 0 && api && !brokerPendingMode) {
    const fillAnchor = resolveBurstFillAnchor(
      filledLegs.map(l => l.entryPrice),
      plan.isBuy !== false,
    )
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
      fillAnchor,
    }).catch(err => {
      console.error(
        `[tradeExecutor] deferred virtual pending failed signal=${signal.id} broker=${broker.id}:`,
        err,
      )
      captureDeferredBusinessFailure({
        category: 'layering',
        event: 'layering_materialization_failed',
        severity: 'error',
        reasonCode: 'VIRTUAL_MATERIALIZATION_FAILED',
        message: 'Deferred virtual layer materialization failed after entry success',
        userImpact: 'partial',
        operation: 'deferred_virtual_pending_materialize',
        err,
        context: {
          user_id: signal.user_id,
          signal_id: signal.id,
          channel_id: signal.channel_id,
          telegram_message_id: signal.telegram_message_id,
          broker_account_id: broker.id,
          symbol,
          side: plan.isBuy === false ? 'sell' : 'buy',
          execution_mechanism: 'virtual_pending_monitor',
          layering_mode: plan.rangeLayering?.rangeLayeringType ?? 'virtual_pending',
          extra: {
            targeted_count: virtualPendings.length,
            successful_count: 0,
            failed_count: virtualPendings.length,
          },
        },
      })
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
      captureDeferredBusinessFailure({
        category: 'trade',
        event: 'post_fill_follow_up_failed',
        severity: 'error',
        reasonCode: 'POST_FILL_FOLLOW_UP_FAILED',
        message: 'Deferred post-fill SL/TP follow-up failed after entry success',
        userImpact: 'partial',
        operation: 'post_fill_follow_up',
        err,
        context: {
          user_id: signal.user_id,
          signal_id: signal.id,
          channel_id: signal.channel_id,
          telegram_message_id: signal.telegram_message_id,
          broker_account_id: broker.id,
          symbol,
          side: op.toLowerCase().includes('sell') ? 'sell' : 'buy',
          execution_mechanism: useV2 ? 'fxsocket_v2' : 'fxsocket_v1',
          extra: {
            targeted_count: filledLegs.length,
            broker_database_state_may_disagree: true,
          },
        },
      })
    })
  }
  const anyImmediateOpened = sendResults.some(
    r => r.status === 'fulfilled' && r.value === true,
  )
  const rejectedSendReason = sendResults
    .find((r): r is PromiseRejectedResult => r.status === 'rejected')
    ?.reason
  if (rejectedSendReason != null) {
    lastSendError = humanizeOrderSendError(
      rejectedSendReason instanceof Error ? rejectedSendReason.message : String(rejectedSendReason),
      symbol,
    )
  }
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
        captureDeferredBusinessFailure({
          category: 'management',
          event: 'basket_tp_sync_failed',
          severity: 'error',
          reasonCode: 'BASKET_TP_SYNC_FAILED',
          message: 'Deferred multi-leg take-profit synchronization failed after entry success',
          userImpact: 'partial',
          operation: 'sync_multi_basket_leg_take_profits',
          err,
          context: {
            user_id: signal.user_id,
            signal_id: signal.id,
            channel_id: signal.channel_id,
            telegram_message_id: signal.telegram_message_id,
            broker_account_id: broker.id,
            symbol,
            side: op.toLowerCase().includes('sell') ? 'sell' : 'buy',
            extra: {
              targeted_count: sendLegs.length,
              successful_count: null,
              failed_count: null,
            },
          },
        })
      })
    } else {
      await ctx.syncMultiBasketLegTakeProfits(syncArgs)
    }
  }
  if (virtualPendings.length > 0 && !anyImmediateOpened && !strictDeferred) {
    const { deleteRangePendingLegsForBasket } = await import('../rangePendingLegDelete')
    const rowsCancelled = await deleteRangePendingLegsForBasket(
      ctx.supabase,
      { signalId: signal.id, brokerAccountId: broker.id },
      'orphan_no_immediate_fills',
    )
    if (rowsCancelled > 0) {
      console.warn(
        `[tradeExecutor] stripped range pendings (zero successful immediates) signal=${signal.id} broker=${broker.id} rows=${rowsCancelled}`,
      )
    } else {
      console.warn(
        `[tradeExecutor] no range pendings stripped signal=${signal.id} broker=${broker.id}`,
      )
    }
  }
  const openedOrMerged = anyImmediateOpened || materializedBrokerPendings || strictBrokerPlaced
  return {
    openedOrMerged,
    channelDelayMs,
    channelDelaySkipped,
    ...(!openedOrMerged
      ? { failureReason: lastSendError ?? SKIP_REASON_ENTRY_NOT_OPENED }
      : {}),
  }
}
