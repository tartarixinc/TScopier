/**
 * Shared basket SL/TP modify + reconcile job persistence.
 * Used by tradeExecutor (realtime), BasketSlTpReconcileMonitor, and edge sweep.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { FxsocketBrokerClient, OrderSendArgs } from './fxsocketClient'
import type { MergeModifySummary, PerLegStopTarget } from './multiTradeMerge'
import { expandPerLegTargetsToCount } from './manualPlanning/tpBucketDistribution'
import type { ManualTpLot } from './manualPlanning/types'
import { symbolsCompatibleForBasket } from './basketModFollowUp'
import { stripInvalidStopsForSide } from './channelActiveTradeParams'
import { isMtBridgeGlitchMessage } from './brokerConnectError'
import { isBenignOrderModifyError, stopsAlreadyMatchDb } from './orderModifyBenign'
import { isSlMoreProtective } from './basketEffectiveStops'
import { mgmtLegConcurrency, parallelMap } from './parallelPool'
import { buildBasketRefreshComment } from './tradeComment'

export type BasketSymbolParams = {
  digits?: number
  point: number
  minLot: number
  lotStep: number
  contractSize: number | null
  stopsLevel: number
  freezeLevel: number
}

export type BasketOpenLeg = {
  id: string
  signal_id: string
  metaapi_order_id: string | null
  opened_at: string
  lot_size: number
  sl: number | null
  tp: number | null
  entry_price: number | null
  direction: string
  symbol: string
}

export type LegModifyError = {
  trade_id: string
  ticket: number
  leg_index: number
  broker_symbol: string
  target_sl: number
  target_tp: number
  error: string
  skip_reason?: string
}

export type RunBasketLegModifyResult = {
  summary: MergeModifySummary & { skippedNotOnBroker: number }
  legErrors: LegModifyError[]
  modifiedTradeIds: string[]
}

export type BasketReconcileJobRow = {
  id: string
  user_id: string
  broker_account_id: string
  anchor_signal_id: string
  source_signal_id: string
  channel_id: string | null
  symbol: string
  direction: 'buy' | 'sell'
  per_leg_targets: PerLegStopTarget[] | null
  virtual_pendings_snapshot: unknown
  n_imm_cwe: number
  override_tp: number | null
  status: string
  attempts: number
  max_attempts: number
  next_run_at: string
  locked_at: string | null
  locked_by: string | null
  last_error: string | null
}

function isBuySideOp(op: string): boolean {
  return op === 'Buy' || op === 'BuyLimit' || op === 'BuyStop' || op === 'BuyStopLimit'
}

export function clampBasketOrderStops(
  args: OrderSendArgs,
  params: BasketSymbolParams | null,
): { args: OrderSendArgs; adjustments: string[] } {
  const adjustments: string[] = []
  if (!params) return { args, adjustments }
  const point = Number(params.point) || 0
  const stopsLevel = Number(params.stopsLevel) || 0
  const freezeLevel = Number(params.freezeLevel) || 0
  if (point <= 0) return { args, adjustments }
  const minLevel = Math.max(stopsLevel, freezeLevel)
  const minDist = (minLevel + 2) * point
  const ref = Number(args.price) || 0
  if (ref <= 0 || minDist <= 0) return { args, adjustments }
  const digits = Math.max(0, Math.min(8, Number(params.digits) || 5))
  const round = (v: number): number => Number(v.toFixed(digits))
  const isBuy = isBuySideOp(String(args.operation))
  let sl = Number(args.stoploss) || 0
  let tp = Number(args.takeprofit) || 0
  const original = { sl, tp }
  if (isBuy) {
    if (sl > 0 && ref - sl < minDist) sl = round(ref - minDist)
    if (tp > 0 && tp - ref < minDist) tp = round(ref + minDist)
  } else {
    if (sl > 0 && sl - ref < minDist) sl = round(ref + minDist)
    if (tp > 0 && ref - tp < minDist) tp = round(ref - minDist)
  }
  if (sl !== original.sl) adjustments.push(`sl ${original.sl} → ${sl}`)
  if (tp !== original.tp) adjustments.push(`tp ${original.tp} → ${tp}`)
  if (adjustments.length === 0) return { args, adjustments }
  return { args: { ...args, stoploss: sl, takeprofit: tp }, adjustments }
}

export function roundBasketLot(volume: number, params: BasketSymbolParams | null): number {
  const step = params?.lotStep ?? 0.01
  const min = params?.minLot ?? 0.01
  const rounded = Math.round(volume / step) * step
  return Math.max(min, +rounded.toFixed(2))
}

function ingestBrokerTickets(orders: unknown[]): Set<number> {
  const tickets = new Set<number>()
  for (const raw of orders ?? []) {
    if (!raw || typeof raw !== 'object') continue
    const o = raw as Record<string, unknown>
    const ticket = Number(o.ticket ?? o.Ticket ?? o.orderId ?? o.OrderID ?? 0)
    if (Number.isFinite(ticket) && ticket > 0) tickets.add(ticket)
  }
  return tickets
}

/** Tickets currently open on the broker account (from /OpenedOrders). */
export async function fetchOpenBrokerTickets(
  api: FxsocketBrokerClient,
  uuid: string,
): Promise<Set<number>> {
  try {
    const orders = await api.openedOrders(uuid)
    return ingestBrokerTickets(orders)
  } catch {
    /* caller treats empty set as "skip preflight" */
    return new Set()
  }
}

/** Same as fetchOpenBrokerTickets but propagates API errors (for ghost-basket reconcile). */
export async function fetchOpenBrokerTicketsStrict(
  api: FxsocketBrokerClient,
  uuid: string,
): Promise<Set<number>> {
  const orders = await api.openedOrders(uuid)
  return ingestBrokerTickets(orders)
}

export function classifyGhostBasketLegs(
  familyTrades: BasketOpenLeg[],
  brokerTickets: Set<number>,
): { onBroker: BasketOpenLeg[]; ghost: BasketOpenLeg[] } {
  const onBroker: BasketOpenLeg[] = []
  const ghost: BasketOpenLeg[] = []
  for (const tr of familyTrades) {
    const ticket = Number(tr.metaapi_order_id)
    if (!Number.isFinite(ticket) || ticket <= 0) {
      ghost.push(tr)
      continue
    }
    if (brokerTickets.has(ticket)) onBroker.push(tr)
    else ghost.push(tr)
  }
  return { onBroker, ghost }
}

/** Mark DB open legs closed when they are absent from the broker (manual close / expired session). */
export async function closeStaleOpenTrades(
  supabase: SupabaseClient,
  tradeIds: string[],
): Promise<number> {
  if (!tradeIds.length) return 0

  const { data: targets, error: loadErr } = await supabase
    .from('trades')
    .select('id,signal_id,broker_account_id')
    .in('id', tradeIds)
    .eq('status', 'open')
  if (loadErr) {
    console.warn(`[basketSlTpReconcile] closeStaleOpenTrades load failed: ${loadErr.message}`)
    return 0
  }
  const rows = (targets ?? []) as Array<{ id: string; signal_id: string; broker_account_id: string }>
  if (!rows.length) return 0

  const now = new Date().toISOString()
  const { data, error } = await supabase
    .from('trades')
    .update({ status: 'closed', closed_at: now })
    .in('id', rows.map(r => r.id))
    .eq('status', 'open')
    .select('id')
  if (error) {
    console.warn(`[basketSlTpReconcile] closeStaleOpenTrades failed: ${error.message}`)
    return 0
  }

  const closed = (data ?? []).length
  if (closed > 0) {
    const { purgeRangePendingLegsForBaskets } = await import('./rangePendingLegDelete')
    await purgeRangePendingLegsForBaskets(
      supabase,
      rows.map(r => ({ signalId: r.signal_id, brokerAccountId: r.broker_account_id })),
      'basket_flat',
    )
  }
  return closed
}

export async function markBasketReconcileDoneForAnchor(
  supabase: SupabaseClient,
  brokerAccountId: string,
  anchorSignalId: string,
): Promise<void> {
  const { data: existingJob } = await supabase
    .from('basket_reconcile_jobs')
    .select('id')
    .eq('broker_account_id', brokerAccountId)
    .eq('anchor_signal_id', anchorSignalId)
    .maybeSingle()
  if (existingJob?.id) {
    await markBasketReconcileDone(supabase, existingJob.id as string)
  }
}

export const GHOST_BASKET_CLOSED_USER_MESSAGE =
  'Open basket existed only in TScopier (not on the broker); stale legs were closed. Send a new entry to open on MT.'

function stopsAlreadyMatch(
  tr: BasketOpenLeg,
  target: PerLegStopTarget,
  nImmCwe: number,
  legIdx: number,
): boolean {
  return stopsAlreadyMatchDb(tr, target, nImmCwe, legIdx)
}

export async function logBasketLegModify(
  supabase: SupabaseClient,
  args: {
    userId: string
    signalId: string
    brokerAccountId: string
    status: 'success' | 'failed' | 'skipped'
    tradeId: string
    ticket: number
    legIndex: number
    brokerSymbol: string
    targetSl: number
    targetTp: number
    errorMessage?: string | null
    skipReason?: string | null
    /** Range-basket TP rebalance — suppress per-leg noise in channel worker UI. */
    internalRebalance?: boolean
  },
): Promise<void> {
  try {
    await supabase.from('trade_execution_logs').insert({
      user_id: args.userId,
      signal_id: args.signalId,
      broker_account_id: args.brokerAccountId,
      action: 'basket_leg_modify',
      status: args.status,
      error_message: args.errorMessage ?? args.skipReason ?? null,
      request_payload: {
        trade_id: args.tradeId,
        ticket: args.ticket,
        leg_index: args.legIndex,
        broker_symbol: args.brokerSymbol,
        target_sl: args.targetSl,
        target_tp: args.targetTp,
        skip_reason: args.skipReason ?? null,
        internal_rebalance: args.internalRebalance === true,
      } as unknown as Record<string, unknown>,
    })
  } catch { /* best-effort */ }
}

export async function runBasketLegModifies(args: {
  supabase: SupabaseClient
  api: FxsocketBrokerClient
  uuid: string
  symbol: string
  direction: 'buy' | 'sell'
  baseLot: number
  params: BasketSymbolParams | null
  signalId: string
  userId: string
  brokerAccountId: string
  familyTrades: BasketOpenLeg[]
  perLegTargets: PerLegStopTarget[]
  /** Parsed signal TP ladder; used when perLegTargets is shorter than open legs. */
  signalTps?: number[]
  tpLots?: ManualTpLot[] | null
  nImmCwe: number
  overrideTp: number | null
  strictEntryPrefetch: { bid: number; ask: number } | null
  openedTickets: Set<number> | null
  skipAlreadySynced?: boolean
  alreadyModified?: Set<string>
  /** Live Telegram mgmt: parallel leg modifies, no inter-leg gap. */
  liveMgmtFast?: boolean
  /** Range-basket TP rebalance — tag per-leg logs for UI suppression. */
  internalRebalance?: boolean
  /** When set, internal rebalance must not revert legs to anchor SL below this value. */
  effectiveStoploss?: number
  /** When false, refresh OrderSend comments are left empty. */
  orderCommentsEnabled?: boolean
  /** Channel/user explicit SL/TP — apply targets as given (allow tighten; use live quote for side checks). */
  explicitChannelTargets?: boolean
}): Promise<RunBasketLegModifyResult> {
  const {
    supabase, api, uuid, symbol, direction, baseLot, params,
    signalId, userId, brokerAccountId, familyTrades, perLegTargets: rawTargets,
    signalTps, tpLots, nImmCwe, strictEntryPrefetch, openedTickets, skipAlreadySynced, alreadyModified,
    liveMgmtFast, internalRebalance, effectiveStoploss,
    orderCommentsEnabled, explicitChannelTargets,
  } = args

  const parsedTps = (signalTps ?? []).filter(t => typeof t === 'number' && Number.isFinite(t) && t > 0)
  const perLegTargets = expandPerLegTargetsToCount({
    targets: rawTargets,
    openLegCount: familyTrades.length,
    finalTps: parsedTps.length
      ? parsedTps
      : rawTargets.map(t => t.takeprofit).filter(tp => tp > 0),
    tpLots,
  }) as PerLegStopTarget[]

  const summary: MergeModifySummary & { skippedNotOnBroker: number } = {
    openLegs: familyTrades.length,
    attempted: 0,
    modified: 0,
    failed: 0,
    skippedNoTicket: 0,
    skippedNotOnBroker: 0,
  }
  const legErrors: LegModifyError[] = []
  const modifiedTradeIds: string[] = []
  const usePreflight = openedTickets != null && openedTickets.size >= 0
  const liveFast = liveMgmtFast === true
  const legModifyGapMs = liveFast
    ? 0
    : internalRebalance === true
      ? Math.max(80, Number(process.env.RANGE_REBALANCE_LEG_GAP_MS ?? 120) || 120)
      : Math.max(0, Number(process.env.BASKET_LEG_MODIFY_GAP_MS ?? 50) || 0)
  const logLegModify = (
    legArgs: Omit<Parameters<typeof logBasketLegModify>[1], 'internalRebalance'>,
  ) => logBasketLegModify(supabase, {
    ...legArgs,
    internalRebalance: internalRebalance === true,
  })

  type LegOutcome = {
    modifiedId?: string
    legError?: LegModifyError
    attempted: number
    modified: number
    failed: number
    skippedNoTicket: number
    skippedNotOnBroker: number
  }
  const noopOutcome = (): LegOutcome => ({
    attempted: 0,
    modified: 0,
    failed: 0,
    skippedNoTicket: 0,
    skippedNotOnBroker: 0,
  })

  const processLeg = async (i: number): Promise<LegOutcome> => {
    const tr = familyTrades[i]!
    if (alreadyModified?.has(tr.id)) {
      return { ...noopOutcome(), modifiedId: tr.id, modified: 1 }
    }
    const target = perLegTargets[i]
    if (!target) return noopOutcome()

    const legIdx = familyTrades.findIndex(t => t.id === tr.id)
    const cweIdx = legIdx >= 0 ? legIdx : i

    if (skipAlreadySynced && stopsAlreadyMatch(tr, target, nImmCwe, cweIdx)) {
      return { ...noopOutcome(), modifiedId: tr.id, modified: 1 }
    }

    const ticket = Number(tr.metaapi_order_id)
    if (!Number.isFinite(ticket) || ticket <= 0) {
      return { ...noopOutcome(), skippedNoTicket: 1 }
    }

    if (usePreflight && !openedTickets!.has(ticket)) {
      const err: LegModifyError = {
        trade_id: tr.id,
        ticket,
        leg_index: i + 1,
        broker_symbol: tr.symbol,
        target_sl: target.stoploss,
        target_tp: cweIdx < nImmCwe ? 0 : target.takeprofit,
        error: 'ticket not in OpenedOrders',
        skip_reason: 'skipped_not_on_broker',
      }
      await logLegModify({
        userId,
        signalId,
        brokerAccountId,
        status: 'skipped',
        tradeId: tr.id,
        ticket,
        legIndex: i + 1,
        brokerSymbol: tr.symbol,
        targetSl: target.stoploss,
        targetTp: cweIdx < nImmCwe ? 0 : target.takeprofit,
        skipReason: 'skipped_not_on_broker',
      })
      return { ...noopOutcome(), legError: err, skippedNotOnBroker: 1 }
    }

    let ref = Number(tr.entry_price) || 0
    try {
      const q = strictEntryPrefetch ?? await api.quote(uuid, symbol)
      const marketRef = direction === 'buy' ? q.bid : q.ask
      if (Number.isFinite(marketRef) && marketRef > 0) {
        ref = explicitChannelTargets === true ? marketRef : (ref > 0 ? ref : marketRef)
      }
    } catch {
      /* fall back to entry ref below */
    }
    if (ref <= 0) {
      try {
        const q = strictEntryPrefetch ?? await api.quote(uuid, symbol)
        ref = direction === 'buy' ? q.ask : q.bid
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const legErr: LegModifyError = {
          trade_id: tr.id,
          ticket,
          leg_index: i + 1,
          broker_symbol: tr.symbol,
          target_sl: target.stoploss,
          target_tp: target.takeprofit,
          error: msg,
        }
        await logLegModify({
          userId,
          signalId,
          brokerAccountId,
          status: 'failed',
          tradeId: tr.id,
          ticket,
          legIndex: i + 1,
          brokerSymbol: tr.symbol,
          targetSl: target.stoploss,
          targetTp: target.takeprofit,
          errorMessage: msg,
        })
        return { ...noopOutcome(), legError: legErr, attempted: 1, failed: 1 }
      }
    }

    let stoploss = target.stoploss
    let takeprofit = cweIdx < nImmCwe ? 0 : target.takeprofit
    const stripped = stripInvalidStopsForSide({
      stoploss,
      takeprofit,
      referencePrice: ref,
      isBuy: direction === 'buy',
    })
    if (stripped.stripped.length) {
      stoploss = stripped.stoploss
      takeprofit = stripped.takeprofit
      if (stoploss <= 0 && takeprofit <= 0) {
        const err: LegModifyError = {
          trade_id: tr.id,
          ticket,
          leg_index: i + 1,
          broker_symbol: tr.symbol,
          target_sl: target.stoploss,
          target_tp: target.takeprofit,
          error: 'wrong_side_sl',
          skip_reason: 'wrong_side_sl',
        }
        await logLegModify({
          userId,
          signalId,
          brokerAccountId,
          status: 'skipped',
          tradeId: tr.id,
          ticket,
          legIndex: i + 1,
          brokerSymbol: tr.symbol,
          targetSl: target.stoploss,
          targetTp: target.takeprofit,
          skipReason: 'wrong_side_sl',
        })
        return { ...noopOutcome(), legError: err, attempted: 1, failed: 1 }
      }
    }

    const sendShape: OrderSendArgs = {
      symbol,
      operation: direction === 'buy' ? 'Buy' : 'Sell',
      volume: roundBasketLot(Number(tr.lot_size) || baseLot, params),
      price: ref,
      stoploss,
      takeprofit,
      slippage: 20,
      comment: buildBasketRefreshComment(signalId, { order_comments_enabled: orderCommentsEnabled }),
      expertID: 909090,
    }
    const clamped = clampBasketOrderStops(sendShape, params)
    let modSl = clamped.args.stoploss ?? 0
    let modTp = clamped.args.takeprofit ?? 0
    if (modTp <= 0 && nImmCwe === 0) {
      const curTp = Number(tr.tp)
      if (Number.isFinite(curTp) && curTp > 0) modTp = curTp
    }
    if (modSl <= 0) {
      const curSl = Number(tr.sl)
      if (Number.isFinite(curSl) && curSl > 0) modSl = curSl
    }
    if (modSl > 0 && explicitChannelTargets !== true) {
      const curSl = Number(tr.sl)
      if (Number.isFinite(curSl) && curSl > 0 && isSlMoreProtective(curSl, modSl, direction === 'buy')) {
        modSl = curSl
      }
    }
    if (modSl <= 0 && modTp <= 0) {
      const err: LegModifyError = {
        trade_id: tr.id,
        ticket,
        leg_index: i + 1,
        broker_symbol: tr.symbol,
        target_sl: target.stoploss,
        target_tp: target.takeprofit,
        error: 'no_stops_to_apply',
        skip_reason: 'no_stops_to_apply',
      }
      await logLegModify({
        userId,
        signalId,
        brokerAccountId,
        status: 'skipped',
        tradeId: tr.id,
        ticket,
        legIndex: i + 1,
        brokerSymbol: tr.symbol,
        targetSl: target.stoploss,
        targetTp: target.takeprofit,
        skipReason: 'no_stops_to_apply',
      })
      return { ...noopOutcome(), legError: err, attempted: 1, failed: 1 }
    }

    try {
      const modRes = await api.orderModify(uuid, {
        ticket,
        stoploss: modSl,
        takeprofit: modTp,
      })
      const newSl = modRes.stopLoss ?? modSl ?? null
      const newTp = modRes.takeProfit ?? modTp ?? null
      const cweClose = cweIdx < nImmCwe ? args.overrideTp : null
      await supabase.from('trades').update({
        sl: typeof newSl === 'number' && newSl > 0 ? newSl : null,
        tp: typeof newTp === 'number' && newTp > 0 ? newTp : null,
        cwe_close_price: typeof cweClose === 'number' && cweClose > 0 ? cweClose : null,
      }).eq('id', tr.id)
      await logLegModify({
        userId,
        signalId,
        brokerAccountId,
        status: 'success',
        tradeId: tr.id,
        ticket,
        legIndex: i + 1,
        brokerSymbol: tr.symbol,
        targetSl: modSl,
        targetTp: modTp,
      })
      return { ...noopOutcome(), modifiedId: tr.id, attempted: 1, modified: 1 }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (isBenignOrderModifyError(msg)) {
        await logLegModify({
          userId,
          signalId,
          brokerAccountId,
          status: 'skipped',
          tradeId: tr.id,
          ticket,
          legIndex: i + 1,
          brokerSymbol: tr.symbol,
          targetSl: modSl,
          targetTp: modTp,
          skipReason: 'already_synced_on_broker',
        })
        return { ...noopOutcome(), modifiedId: tr.id, attempted: 1, modified: 1 }
      }
      const legErr: LegModifyError = {
        trade_id: tr.id,
        ticket,
        leg_index: i + 1,
        broker_symbol: tr.symbol,
        target_sl: modSl,
        target_tp: modTp,
        error: msg,
      }
      console.warn(
        `[basketSlTpReconcile] OrderModify failed leg=${i + 1}/${familyTrades.length} trade=${tr.id}: ${msg}`,
      )
      await logLegModify({
        userId,
        signalId,
        brokerAccountId,
        status: 'failed',
        tradeId: tr.id,
        ticket,
        legIndex: i + 1,
        brokerSymbol: tr.symbol,
        targetSl: modSl,
        targetTp: modTp,
        errorMessage: msg,
      })
      return { ...noopOutcome(), legError: legErr, attempted: 1, failed: 1 }
    }
  }

  const legIndices = familyTrades.map((_, idx) => idx)
  let legOutcomes: LegOutcome[]
  if (liveFast && familyTrades.length > 1) {
    legOutcomes = await parallelMap(legIndices, mgmtLegConcurrency(), idx => processLeg(idx))
  } else {
    legOutcomes = []
    for (let i = 0; i < familyTrades.length; i++) {
      if (i > 0 && legModifyGapMs > 0) {
        await new Promise(resolve => setTimeout(resolve, legModifyGapMs))
      }
      legOutcomes.push(await processLeg(i))
    }
  }

  for (const o of legOutcomes) {
    summary.attempted += o.attempted
    summary.modified += o.modified
    summary.failed += o.failed
    summary.skippedNoTicket += o.skippedNoTicket
    summary.skippedNotOnBroker += o.skippedNotOnBroker
    if (o.modifiedId) modifiedTradeIds.push(o.modifiedId)
    if (o.legError) legErrors.push(o.legError)
  }

  const stillMissingTicket = familyTrades.filter(tr => {
    const t = Number(tr.metaapi_order_id)
    return !Number.isFinite(t) || t <= 0
  }).length
  summary.skippedNoTicket = stillMissingTicket
  summary.failed = Math.max(
    0,
    familyTrades.length - summary.modified - stillMissingTicket - summary.skippedNotOnBroker,
  )

  return { summary, legErrors, modifiedTradeIds }
}

export function reconcileBackoffMs(attempts: number): number {
  const base = Number(process.env.BASKET_RECONCILE_BACKOFF_MS ?? 15_000)
  const capped = Math.min(base * Math.pow(2, Math.min(attempts, 4)), 300_000)
  return capped
}

export async function upsertBasketReconcileJob(
  supabase: SupabaseClient,
  args: {
    userId: string
    brokerAccountId: string
    anchorSignalId: string
    sourceSignalId: string
    channelId: string | null
    symbol: string
    direction: 'buy' | 'sell'
    perLegTargets: PerLegStopTarget[]
    familyTrades: BasketOpenLeg[]
    /** Parsed TP ladder from anchor signal; used to expand targets when leg count grows. */
    signalTps?: number[]
    tpLots?: ManualTpLot[] | null
    virtualPendingsSnapshot?: unknown
    nImmCwe: number
    overrideTp: number | null
    lastError: string | null
  },
): Promise<string | null> {
  const maxAttempts = Math.min(
    120,
    Math.max(6, Number(process.env.BASKET_RECONCILE_MAX_ATTEMPTS ?? 48)),
  )
  const parsedTps = (args.signalTps ?? []).filter(t => typeof t === 'number' && Number.isFinite(t) && t > 0)
  const storedTargets = expandPerLegTargetsToCount({
    targets: args.perLegTargets,
    openLegCount: Math.max(args.familyTrades.length, args.perLegTargets.length),
    finalTps: parsedTps.length
      ? parsedTps
      : args.perLegTargets.map(t => t.takeprofit).filter(tp => tp > 0),
    tpLots: args.tpLots,
  })

  const { data: job, error: jobErr } = await supabase
    .from('basket_reconcile_jobs')
    .upsert({
      user_id: args.userId,
      broker_account_id: args.brokerAccountId,
      anchor_signal_id: args.anchorSignalId,
      source_signal_id: args.sourceSignalId,
      channel_id: args.channelId,
      symbol: args.symbol,
      direction: args.direction,
      per_leg_targets: storedTargets,
      virtual_pendings_snapshot: args.virtualPendingsSnapshot ?? null,
      n_imm_cwe: args.nImmCwe,
      override_tp: args.overrideTp,
      status: 'pending',
      max_attempts: maxAttempts,
      next_run_at: new Date().toISOString(),
      last_error: args.lastError,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'broker_account_id,anchor_signal_id' })
    .select('id')
    .single()

  if (jobErr || !job?.id) {
    console.warn(`[basketSlTpReconcile] upsert job failed: ${jobErr?.message ?? 'no id'}`)
    return null
  }

  const jobId = job.id as string
  const expandedTargets = expandPerLegTargetsToCount({
    targets: storedTargets,
    openLegCount: args.familyTrades.length,
    finalTps: parsedTps.length
      ? parsedTps
      : storedTargets.map(t => t.takeprofit).filter(tp => tp > 0),
    tpLots: args.tpLots,
  })
  const legRows = args.familyTrades.map((tr, i) => {
    const target = expandedTargets[i]
    const ticket = Number(tr.metaapi_order_id)
    return {
      trade_id: tr.id,
      job_id: jobId,
      leg_index: i,
      ticket: Number.isFinite(ticket) && ticket > 0 ? ticket : null,
      desired_sl: target?.stoploss ?? null,
      desired_tp: target?.takeprofit ?? null,
    }
  })

  if (legRows.length > 0) {
    const { error: legErr } = await supabase.from('basket_reconcile_legs').upsert(legRows, {
      onConflict: 'trade_id',
    })
    if (legErr) {
      console.warn(`[basketSlTpReconcile] upsert legs failed: ${legErr.message}`)
    }
  }

  return jobId
}

export async function markBasketReconcileDone(
  supabase: SupabaseClient,
  jobId: string,
): Promise<void> {
  await supabase
    .from('basket_reconcile_jobs')
    .update({
      status: 'done',
      last_error: null,
      locked_at: null,
      locked_by: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', jobId)
  await supabase.from('basket_reconcile_legs').delete().eq('job_id', jobId)
}

export async function loadOpenBasketLegs(
  supabase: SupabaseClient,
  brokerAccountId: string,
  anchorSignalId: string,
  symbolHint: string,
): Promise<BasketOpenLeg[]> {
  const { data, error } = await supabase
    .from('trades')
    .select('id,signal_id,metaapi_order_id,opened_at,lot_size,sl,tp,entry_price,direction,symbol')
    .eq('broker_account_id', brokerAccountId)
    .eq('signal_id', anchorSignalId)
    .eq('status', 'open')
    .order('opened_at', { ascending: true })
    .limit(500)
  if (error) return []
  return ((data ?? []) as BasketOpenLeg[]).filter(tr =>
    symbolsCompatibleForBasket(symbolHint, tr.symbol),
  )
}

export function parsePerLegTargets(raw: unknown): PerLegStopTarget[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map(row => {
      if (!row || typeof row !== 'object') return null
      const o = row as Record<string, unknown>
      return {
        stoploss: Number(o.stoploss) || 0,
        takeprofit: Number(o.takeprofit) || 0,
      }
    })
    .filter((x): x is PerLegStopTarget => x != null)
}
