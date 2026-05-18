/**
 * Shared basket SL/TP modify + reconcile job persistence.
 * Used by tradeExecutor (realtime), BasketSlTpReconcileMonitor, and edge sweep.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { MetatraderApiClient, OrderSendArgs } from './metatraderapi'
import type { MergeModifySummary, PerLegStopTarget } from './multiTradeMerge'
import { symbolsCompatibleForBasket } from './basketModFollowUp'

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
  api: MetatraderApiClient,
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
  api: MetatraderApiClient,
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
  const now = new Date().toISOString()
  const { data, error } = await supabase
    .from('trades')
    .update({ status: 'closed', closed_at: now })
    .in('id', tradeIds)
    .eq('status', 'open')
    .select('id')
  if (error) {
    console.warn(`[basketSlTpReconcile] closeStaleOpenTrades failed: ${error.message}`)
    return 0
  }
  return (data ?? []).length
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
  'Open basket existed only in TSCopier (not on the broker); stale legs were closed. Send a new entry to open on MT.'

function stopsAlreadyMatch(
  tr: BasketOpenLeg,
  target: PerLegStopTarget,
  nImmCwe: number,
  legIdx: number,
): boolean {
  if (legIdx < nImmCwe) {
    const tpOk = tr.tp == null || Number(tr.tp) === 0
    if (!tpOk) return false
  } else if (target.takeprofit > 0) {
    const curTp = Number(tr.tp)
    if (!Number.isFinite(curTp) || Math.abs(curTp - target.takeprofit) > 1e-8) return false
  }
  if (target.stoploss > 0) {
    const curSl = Number(tr.sl)
    if (!Number.isFinite(curSl) || Math.abs(curSl - target.stoploss) > 1e-8) return false
  }
  return true
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
      } as unknown as Record<string, unknown>,
    })
  } catch { /* best-effort */ }
}

export async function runBasketLegModifies(args: {
  supabase: SupabaseClient
  api: MetatraderApiClient
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
  nImmCwe: number
  overrideTp: number | null
  strictEntryPrefetch: { bid: number; ask: number } | null
  openedTickets: Set<number> | null
  skipAlreadySynced?: boolean
  alreadyModified?: Set<string>
}): Promise<RunBasketLegModifyResult> {
  const {
    supabase, api, uuid, symbol, direction, baseLot, params,
    signalId, userId, brokerAccountId, familyTrades, perLegTargets,
    nImmCwe, strictEntryPrefetch, openedTickets, skipAlreadySynced, alreadyModified,
  } = args

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

  for (let i = 0; i < familyTrades.length; i++) {
    const tr = familyTrades[i]!
    if (alreadyModified?.has(tr.id)) {
      modifiedTradeIds.push(tr.id)
      summary.modified += 1
      continue
    }
    const target = perLegTargets[i] ?? perLegTargets[perLegTargets.length - 1]
    if (!target) continue

    const legIdx = familyTrades.findIndex(t => t.id === tr.id)
    const cweIdx = legIdx >= 0 ? legIdx : i

    if (skipAlreadySynced && stopsAlreadyMatch(tr, target, nImmCwe, cweIdx)) {
      modifiedTradeIds.push(tr.id)
      summary.modified += 1
      continue
    }

    const ticket = Number(tr.metaapi_order_id)
    if (!Number.isFinite(ticket) || ticket <= 0) {
      summary.skippedNoTicket += 1
      continue
    }

    if (usePreflight && !openedTickets!.has(ticket)) {
      summary.skippedNotOnBroker += 1
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
      legErrors.push(err)
      await logBasketLegModify(supabase, {
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
      continue
    }

    summary.attempted += 1
    let ref = Number(tr.entry_price) || 0
    if (ref <= 0) {
      try {
        const q = strictEntryPrefetch ?? await api.quote(uuid, symbol)
        ref = direction === 'buy' ? q.ask : q.bid
      } catch (err) {
        summary.failed += 1
        const msg = err instanceof Error ? err.message : String(err)
        legErrors.push({
          trade_id: tr.id,
          ticket,
          leg_index: i + 1,
          broker_symbol: tr.symbol,
          target_sl: target.stoploss,
          target_tp: target.takeprofit,
          error: msg,
        })
        await logBasketLegModify(supabase, {
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
        continue
      }
    }

    const sendShape: OrderSendArgs = {
      symbol,
      operation: direction === 'buy' ? 'Buy' : 'Sell',
      volume: roundBasketLot(Number(tr.lot_size) || baseLot, params),
      price: ref,
      stoploss: target.stoploss,
      takeprofit: cweIdx < nImmCwe ? 0 : target.takeprofit,
      slippage: 20,
      comment: `TSCopier:${signalId.slice(0, 8)}:refresh`,
      expertID: 909090,
    }
    const clamped = clampBasketOrderStops(sendShape, params)

    try {
      const modRes = await api.orderModify(uuid, {
        ticket,
        stoploss: clamped.args.stoploss ?? 0,
        takeprofit: clamped.args.takeprofit ?? 0,
      })
      const newSl = modRes.stopLoss ?? clamped.args.stoploss ?? null
      const newTp = modRes.takeProfit ?? clamped.args.takeprofit ?? null
      const cweClose = cweIdx < nImmCwe ? args.overrideTp : null
      await supabase.from('trades').update({
        sl: typeof newSl === 'number' && newSl > 0 ? newSl : null,
        tp: typeof newTp === 'number' && newTp > 0 ? newTp : null,
        cwe_close_price: typeof cweClose === 'number' && cweClose > 0 ? cweClose : null,
      }).eq('id', tr.id)
      modifiedTradeIds.push(tr.id)
      summary.modified += 1
      await logBasketLegModify(supabase, {
        userId,
        signalId,
        brokerAccountId,
        status: 'success',
        tradeId: tr.id,
        ticket,
        legIndex: i + 1,
        brokerSymbol: tr.symbol,
        targetSl: clamped.args.stoploss ?? 0,
        targetTp: clamped.args.takeprofit ?? 0,
      })
    } catch (err) {
      summary.failed += 1
      const msg = err instanceof Error ? err.message : String(err)
      legErrors.push({
        trade_id: tr.id,
        ticket,
        leg_index: i + 1,
        broker_symbol: tr.symbol,
        target_sl: clamped.args.stoploss ?? 0,
        target_tp: clamped.args.takeprofit ?? 0,
        error: msg,
      })
      console.warn(
        `[basketSlTpReconcile] OrderModify failed leg=${i + 1}/${familyTrades.length} trade=${tr.id}: ${msg}`,
      )
      await logBasketLegModify(supabase, {
        userId,
        signalId,
        brokerAccountId,
        status: 'failed',
        tradeId: tr.id,
        ticket,
        legIndex: i + 1,
        brokerSymbol: tr.symbol,
        targetSl: clamped.args.stoploss ?? 0,
        targetTp: clamped.args.takeprofit ?? 0,
        errorMessage: msg,
      })
    }
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
      per_leg_targets: args.perLegTargets,
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
  const legRows = args.familyTrades.map((tr, i) => {
    const target = args.perLegTargets[i] ?? args.perLegTargets[args.perLegTargets.length - 1]
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
