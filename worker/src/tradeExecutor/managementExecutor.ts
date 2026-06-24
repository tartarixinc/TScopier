import {
  clearChannelActiveTradeParamsWhenFlat,
  symbolsForChannelParamsPersist,
  upsertChannelActiveTradeParams,
  type ChannelActiveTradeParams
} from '../channelActiveTradeParams'
import { resolveChannelTradingConfig } from '../channelTradingConfig'
import {
  breakevenStopLossForSymbol,
  clampBreakevenModifyStops,
  isSlAtOrBeyondBreakeven,
} from '../autoManagement'
import { signalPipPrice } from '../signalPip'
import { isChannelManagementBlocked, isPendingCancelBlocked, normalizeChannelMessageFiltersMap } from '../channelMessageFilters'
import {
  cweInstructionGroupKey,
  loadFiredRangeLayeringTickets,
  parseCweInstructionGroupKey,
  referencePriceForDirection,
  selectImmediateLegsForCweInstruction,
  selectWorseImmediateLegsForCweInstruction,
} from '../closeWorseEntries'
import { tryBrokerFallbackClose, cancelChannelBrokerPendingOrders } from '../managementBrokerClose'
import { extractOpenOrderFromBrokerRaw } from '../managementBrokerClose'
import { closeWithVerification } from '../managementClose'
import { findOpenedRowByTicket, readBrokerOrderStopLoss } from '../signalEntryPendingHelpers'
import { applyMgmtModifyToBasketGroups } from '../managementModifyBaskets'
import {
  allChannelModifySymbolBuckets,
  applyChannelStopsToBaskets,
  ensureChannelModifyScope,
  groupLegsByBrokerSignal,
  logMgmtModifyBrokerSummaries,
  mgmtRowsToStopLegs,
  mgmtUseChannelStopApply,
  type ChannelStopApplyResult,
} from '../channelStopApply'
import type { MgmtExecOptions, MgmtExecResult } from '../mgmtExecOptions'
import { loadRangePendingLegsInMgmtScope, pendingLegsToCancelScopes, updateRangePendingLegsForManagement } from '../managementPendingLegs'
import {
  explicitMgmtSymbol,
  expandMgmtRowsToFullBaskets,
  isReplyScopedManagement,
  loadOpenTradesForChannelWideCwe,
  loadOpenTradesForManagement,
  resolveChannelModifyTargets,
  type MgmtTradeRow
} from '../managementScope'
import { type ManualSettings } from '../manualPlanner'
import { hasFxsocketConfigured } from '../fxsocketClient'
import { upsertBasketReconcileJob, type BasketOpenLeg } from '../basketSlTpReconcile'
import { findStaleBasketKeys, upsertBasketSlTpTarget } from '../basketTargetStore'
import type { PerLegStopTarget } from '../multiTradeMerge'
import { resolveLatestOpenBasketAnchor } from '../multiTradeMerge'
import { isBenignOrderModifyError } from '../orderModifyBenign'
import { modifyLegSlTpWithFallback } from '../orderModifySafe'
import { mgmtLegConcurrency, mgmtVerifyAfterModify, parallelMap } from '../parallelPool'
import { patchActiveRangePendingLegStops } from '../rangePendingLadderSync'
import { symbolsCompatibleForBasket } from '../basketModFollowUp'
import { type TradeExecutorContext } from './context'
import { brokerHasLinkedSession, brokerSessionUuid, isMtUuid } from './helpers'
import {
  type BrokerRow,
  type ParsedSignal,
  type RangePendingCancelScope,
  type SignalRow
} from './types'

function mgmtCloseOpts(liveMgmtFast: boolean) {
  return { maxAttempts: 2, slippageEscalation: 50, liveFast: liveMgmtFast }
}

function normBasketSymbolKey(sym: string): string {
  return String(sym ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

function mgmtRowToBasketLegForReconcile(row: MgmtTradeRow): BasketOpenLeg {
  return {
    id: row.id,
    signal_id: row.signal_id,
    metaapi_order_id: row.metaapi_order_id,
    opened_at: row.opened_at ?? '',
    lot_size: row.lot_size,
    sl: row.sl,
    tp: row.tp,
    entry_price: row.entry_price,
    direction: row.direction,
    symbol: row.symbol,
  }
}

async function finalizeMgmtSignal(ctx: TradeExecutorContext, signalId: string): Promise<void> {
  try {
    const { error: sigErr } = await ctx.supabase
      .from('signals')
      .update({ status: 'executed' })
      .eq('id', signalId)
      .eq('status', 'parsed')
    if (sigErr) {
      console.warn(`[tradeExecutor] mgmt signal finalize failed id=${signalId}: ${sigErr.message}`)
    }
  } catch {
    // best-effort
  }
}

/** Pending/range cancel + broker straggler sweep — safe after open legs are closed. */
function deferMgmtCloseCleanup(args: {
  ctx: TradeExecutorContext
  signal: SignalRow
  parsed: ParsedSignal
  brokers: BrokerRow[]
  brokerAccountIds: string[]
  byBroker: Map<string, BrokerRow>
  cancelledPendingScopes: Set<string>
  liveMgmtFast: boolean
  onPendingCancelled?: (n: number) => void
  onBrokerStragglersClosed?: (n: number) => void
}): void {
  void (async () => {
    const {
      ctx,
      signal,
      parsed,
      brokers,
      brokerAccountIds,
      byBroker,
      cancelledPendingScopes,
      liveMgmtFast,
      onPendingCancelled,
      onBrokerStragglersClosed,
    } = args
    if (!signal.channel_id) return
    try {
      if (cancelledPendingScopes.size > 0) {
        const scopes = Array.from(cancelledPendingScopes)
          .map(enc => JSON.parse(enc) as RangePendingCancelScope)
          .filter(scope => {
            const broker = byBroker.get(scope.brokerAccountId)
            if (!broker) return false
            return !isPendingCancelBlocked(
              normalizeChannelMessageFiltersMap(broker.channel_message_filters),
              signal.channel_id,
            )
          })
        if (scopes.length > 0) {
          await ctx.cancelRangePendingLegsForScopes(signal.user_id, signal.id, scopes, 'signal_closed')
        }
      }
      const pendingCancelled = await cancelChannelBrokerPendingOrders({
        supabase: ctx.supabase,
        userId: signal.user_id,
        channelId: signal.channel_id,
        brokerAccountIds,
        apiFor: uuid => {
          for (const broker of brokers) {
            if (brokerSessionUuid(broker) === uuid) return ctx.apiFor(broker)
          }
          return null
        },
        reason: 'signal_closed',
      })
      if (pendingCancelled > 0) {
        onPendingCancelled?.(pendingCancelled)
        console.log(
          `[tradeExecutor] mgmt deferred cancelled ${pendingCancelled} broker pendings signal=${signal.id}`,
        )
      }
      const channelMeta = await ctx.getChannelMeta(signal.channel_id)
      let brokerClosed = 0
      await Promise.allSettled(brokers.map(async broker => {
        const api = ctx.apiFor(broker)
        const uuid = brokerSessionUuid(broker)
        if (!api || !uuid || uuid.includes('|')) return
        const one = await tryBrokerFallbackClose({
          supabase: ctx.supabase,
          api,
          signal,
          parsed,
          brokers: [broker],
          channelDisplayName: channelMeta.commentSlug,
          channelUsername: null,
          closeWithVerification: (a, u, ticket) =>
            closeWithVerification(a, u, ticket, mgmtCloseOpts(liveMgmtFast)),
        })
        brokerClosed += one.closed
      }))
      if (brokerClosed > 0) {
        onBrokerStragglersClosed?.(brokerClosed)
        console.log(
          `[tradeExecutor] mgmt deferred broker sweep closed ${brokerClosed} stragglers signal=${signal.id}`,
        )
      }
    } catch (err) {
      console.warn(
        `[tradeExecutor] mgmt deferred close cleanup failed signal=${signal.id}:`,
        err instanceof Error ? err.message : err,
      )
    }
  })()
}

function emptyMgmtResult(parallelism = 1): MgmtExecResult {
  return { legsTotal: 0, legsParallelism: parallelism }
}

function isUnknownTicketError(message: string): boolean {
  const m = message.toLowerCase()
  return (
    /\bunknown ticket\b/.test(m)
    || /\binvalid ticket\b/.test(m)
    || /\bticket\b.*\bnot found\b/.test(m)
    || /\bno such order\b/.test(m)
  )
}

function isRetryableBreakevenError(message: string): boolean {
  const m = message.toLowerCase()
  return (
    /order rejected/.test(m)
    || /trade context busy/.test(m)
    || /off quotes/.test(m)
    || /requote/.test(m)
    || /timeout/.test(m)
    || /temporary/.test(m)
    || /too many requests/.test(m)
    || /verify failed/.test(m)
  )
}

async function sleepMs(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

function readOrderOpenPrice(raw: unknown): number | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  for (const key of ['openPrice', 'OpenPrice', 'price', 'Price', 'priceOpen', 'PriceOpen']) {
    const v = o[key]
    const n = typeof v === 'number' ? v : Number(v)
    if (Number.isFinite(n) && n > 0) return n
  }
  return null
}

async function resolveMgmtEntryPrice(args: {
  trade: MgmtTradeRow
  api: ReturnType<TradeExecutorContext['apiFor']>
  uuid: string
  ticket: number
}): Promise<number> {
  const fromDb = Number(args.trade.entry_price) || 0
  if (fromDb > 0) return fromDb
  if (!args.api) throw new Error('breakeven skipped: missing entry price on trade row')
  const rawOrders = await args.api.openedOrders(args.uuid).catch(() => [])
  const order = findRawOrderByTicket(rawOrders ?? [], args.ticket)
  const fromBroker = order ? readOrderOpenPrice(order) : null
  if (fromBroker != null && fromBroker > 0) return fromBroker
  throw new Error('breakeven skipped: missing entry price on trade row')
}

function findRawOrderByTicket(rawOrders: unknown[], ticket: number): unknown | null {
  return findOpenedRowByTicket(rawOrders, ticket)
}

async function verifyBreakevenApplied(args: {
  api: NonNullable<TradeExecutorContext['apiFor'] extends (...x: any[]) => infer R ? R : never>
  uuid: string
  ticket: number
  expectedSl: number
  isBuy: boolean
  pipPrice: number
  /** When /OpenedOrders omits SL, trust OrderModify response if present. */
  confirmSl?: number | null
  /** Reuse a pre-fetched OpenedOrders snapshot to avoid a per-leg broker read. */
  ordersSnapshot?: unknown[] | null
}): Promise<{ ok: boolean; reason?: string }> {
  const { api, uuid, ticket, expectedSl, isBuy, pipPrice, confirmSl, ordersSnapshot } = args
  const rawOrders = ordersSnapshot ?? await api.openedOrders(uuid)
  const order = findRawOrderByTicket(rawOrders ?? [], ticket)
  if (!order) return { ok: false, reason: 'verify failed: ticket missing from opened orders' }
  const sl = readBrokerOrderStopLoss(order)
    ?? (confirmSl != null && Number.isFinite(confirmSl) && confirmSl > 0 ? confirmSl : null)
  if (sl == null) return { ok: false, reason: 'verify failed: broker did not return stop loss' }
  if (isSlAtOrBeyondBreakeven(isBuy, sl, expectedSl, pipPrice)) return { ok: true }
  return { ok: false, reason: `verify failed: broker SL=${sl} expected BE=${expectedSl}` }
}

function resolveReconciledTicketForTrade(
  trade: MgmtTradeRow,
  rawOrders: unknown[],
  excludeTickets: ReadonlySet<number> = new Set(),
): number | null {
  const storedTicket = Number(trade.metaapi_order_id)
  const expectedDir = String(trade.direction).toLowerCase() === 'buy'
  const expectedLots = Number.isFinite(Number(trade.lot_size)) ? Number(trade.lot_size) : null
  const expectedEntry = Number.isFinite(Number(trade.entry_price)) ? Number(trade.entry_price) : null
  const candidates = rawOrders
    .map(extractOpenOrderFromBrokerRaw)
    .filter((o): o is NonNullable<ReturnType<typeof extractOpenOrderFromBrokerRaw>> => o != null)
    .filter(o => symbolsCompatibleForBasket(trade.symbol, o.symbol))
    .filter(o => o.isBuy === expectedDir)
    .filter(o => !excludeTickets.has(o.ticket))

  if (!candidates.length) return null

  if (Number.isFinite(storedTicket) && storedTicket > 0 && !excludeTickets.has(storedTicket)) {
    const storedMatch = candidates.find(o => o.ticket === storedTicket)
    if (storedMatch) return storedTicket
  }

  candidates.sort((a, b) => {
    const lotScoreA = expectedLots == null ? 0 : Math.abs((a.lots || 0) - expectedLots)
    const lotScoreB = expectedLots == null ? 0 : Math.abs((b.lots || 0) - expectedLots)
    if (lotScoreA !== lotScoreB) return lotScoreA - lotScoreB
    const entryA = Number.isFinite(Number((a as { openPrice?: number }).openPrice))
      ? Number((a as { openPrice?: number }).openPrice)
      : null
    const entryB = Number.isFinite(Number((b as { openPrice?: number }).openPrice))
      ? Number((b as { openPrice?: number }).openPrice)
      : null
    const entryScoreA = expectedEntry != null && entryA != null ? Math.abs(entryA - expectedEntry) : 0
    const entryScoreB = expectedEntry != null && entryB != null ? Math.abs(entryB - expectedEntry) : 0
    if (entryScoreA !== entryScoreB) return entryScoreA - entryScoreB
    return b.ticket - a.ticket
  })
  return candidates[0]?.ticket ?? null
}

export async function logSendSkipped(ctx: TradeExecutorContext, 
    signal: SignalRow,
    broker: BrokerRow,
    reason: string,
    extra: Record<string, unknown>,
  ): Promise<void> {
    if (reason === 'broker_session_not_connected') {
      const uuid = brokerSessionUuid(broker)
      if (uuid) {
        await ctx.markBrokerSessionDown(broker, uuid, 'broker_session_not_connected')
      }
    }
    try {
      await ctx.supabase.from('trade_execution_logs').insert({
        user_id: signal.user_id,
        signal_id: signal.id,
        broker_account_id: broker.id,
        action: 'order_send',
        status: 'skipped',
        request_payload: { skip_reason: reason, ...extra } as unknown as Record<string, unknown>,
      })
    } catch {
      // Logging failure is non-fatal.
    }
  }

export async function skipMgmtSignal(ctx: TradeExecutorContext, signalId: string, reason: string): Promise<void> {
    try {
      await ctx.supabase
        .from('signals')
        .update({ status: 'skipped', skip_reason: reason })
        .eq('id', signalId)
        .eq('status', 'parsed')
    } catch { /* best-effort */ }
  }

async function logBrokerMgmtSkip(
  ctx: TradeExecutorContext,
  signal: SignalRow,
  brokerId: string,
  reason: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  try {
    await ctx.supabase.from('trade_execution_logs').insert({
      user_id: signal.user_id,
      signal_id: signal.id,
      broker_account_id: brokerId,
      action: 'mgmt_skip',
      status: 'skipped',
      request_payload: { skip_reason: reason, ...extra } as unknown as Record<string, unknown>,
    })
  } catch { /* best-effort */ }
}

async function skipMgmtSignalWithLog(
  ctx: TradeExecutorContext,
  signal: SignalRow,
  reason: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  await skipMgmtSignal(ctx, signal.id, reason)
  try {
    await ctx.supabase.from('trade_execution_logs').insert({
      user_id: signal.user_id,
      signal_id: signal.id,
      broker_account_id: null,
      action: 'mgmt_skip',
      status: 'skipped',
      request_payload: { skip_reason: reason, ...extra } as unknown as Record<string, unknown>,
    })
  } catch { /* best-effort */ }
}

export async function applyManagement(
  ctx: TradeExecutorContext,
  signal: SignalRow,
  parsed: ParsedSignal,
  brokers: BrokerRow[],
  mgmtOpts?: MgmtExecOptions,
): Promise<MgmtExecResult> {
    const liveMgmtFast = mgmtOpts?.liveMgmtFast === true
    const legConcurrency = liveMgmtFast ? mgmtLegConcurrency() : 1
    let legsTotal = 0
    if (!hasFxsocketConfigured()) {
      await skipMgmtSignalWithLog(ctx, signal, 'broker_api_not_configured', {
        action: String(parsed.action ?? '').toLowerCase(),
      })
      return emptyMgmtResult(legConcurrency)
    }

    const brokerAccountIds = brokers.map(b => b.id)
    const replyScoped = isReplyScopedManagement(signal)
    const symbolFromText = explicitMgmtSymbol(parsed)
    let mgmtSymbolHint: string | null = symbolFromText
    let basketAnchorId: string | null = null
    let rows: MgmtTradeRow[] = []
    let modifyApplyResult: ChannelStopApplyResult | null = null

    if (replyScoped && signal.parent_signal_id) {
      let symbolHint: string | null = symbolFromText
      let parentParsed: ParsedSignal | null = null
      try {
        const { data: ps } = await ctx.supabase
          .from('signals')
          .select('parsed_data')
          .eq('id', signal.parent_signal_id)
          .maybeSingle()
        const p = (ps as { parsed_data?: ParsedSignal | null } | null)?.parsed_data
        parentParsed = p ?? null
        const fromParent = p?.symbol != null && String(p.symbol).trim() ? String(p.symbol).trim() : null
        if (!symbolHint && fromParent) symbolHint = fromParent
        if (symbolHint) mgmtSymbolHint = symbolHint
      } catch {
        // best-effort
      }

      basketAnchorId = signal.parent_signal_id
      const { count: parentOpenCount } = await ctx.supabase
        .from('trades')
        .select('id', { count: 'exact', head: true })
        .eq('signal_id', signal.parent_signal_id)
        .in('broker_account_id', brokerAccountIds)
        .in('status', ['open', 'pending'])
      if ((parentOpenCount ?? 0) === 0) {
        const mgmtAction = String(parsed.action ?? '').toLowerCase()
        let mgmtDir: 'buy' | 'sell' | null = mgmtAction === 'buy' || mgmtAction === 'sell'
          ? mgmtAction
          : null
        if (!mgmtDir && parentParsed) {
          const parentAction = String(parentParsed.action ?? '').toLowerCase()
          if (parentAction === 'buy' || parentAction === 'sell') mgmtDir = parentAction
        }
        const symForResolve = symbolHint?.trim() ?? ''
        if (mgmtDir && symForResolve && signal.channel_id && brokerAccountIds[0]) {
          const latest = await resolveLatestOpenBasketAnchor(ctx.supabase, {
            userId: signal.user_id,
            brokerAccountId: brokerAccountIds[0]!,
            brokerSymbol: symForResolve,
            signalSymbol: symForResolve,
            direction: mgmtDir,
            channelId: signal.channel_id,
          })
          if (latest) basketAnchorId = latest.anchorSignalId
        }
        if (!basketAnchorId || basketAnchorId === signal.parent_signal_id) {
          basketAnchorId = await ctx.resolveBasketAnchorSignalIdForOpenTrades({
            userId: signal.user_id,
            brokerAccountIds,
            channelId: signal.channel_id,
            parentSignalId: signal.parent_signal_id,
            symbolHint,
          })
        }
      }
      if (!basketAnchorId) {
        if (String(parsed.action ?? '').toLowerCase() !== 'close_worse_entries') {
          await skipMgmtSignalWithLog(ctx, signal, 'mgmt_no_open_trades_db', { scope: 'reply_basket' })
          return emptyMgmtResult(legConcurrency)
        }
      } else {
        const { data } = await ctx.supabase
          .from('trades')
          .select(
            'id,signal_id,broker_account_id,metaapi_order_id,symbol,direction,lot_size,status,sl,tp,entry_price,opened_at,cwe_close_price',
          )
          .eq('signal_id', basketAnchorId)
          .in('broker_account_id', brokerAccountIds)
          .in('status', ['open', 'pending'])
          .order('opened_at', { ascending: true })
          .limit(500)
        rows = (data ?? []) as MgmtTradeRow[]
      }
    } else {
      if (!signal.channel_id) {
        await skipMgmtSignalWithLog(ctx, signal, 'mgmt_no_open_trades_db', { scope: 'no_channel' })
        return emptyMgmtResult(legConcurrency)
      }
      const actionPre = String(parsed.action ?? '').toLowerCase()
      let channelRows = actionPre === 'close_worse_entries'
        ? await loadOpenTradesForChannelWideCwe(ctx.supabase, {
          userId: signal.user_id,
          channelId: signal.channel_id,
          brokerAccountIds,
          symbolFilter: symbolFromText,
        })
        : mgmtUseChannelStopApply() && actionPre === 'modify'
          ? await ensureChannelModifyScope(ctx.supabase, {
            userId: signal.user_id,
            channelId: signal.channel_id,
            brokerAccountIds,
            symbolFilter: symbolFromText,
          })
          : await loadOpenTradesForManagement(ctx.supabase, {
            userId: signal.user_id,
            channelId: signal.channel_id,
            brokerAccountIds,
            symbolFilter: symbolFromText,
          })
      if (
        actionPre === 'modify'
        && !symbolFromText
        && channelRows.length > 0
      ) {
        channelRows = mgmtUseChannelStopApply()
          ? allChannelModifySymbolBuckets(channelRows)
          : resolveChannelModifyTargets(channelRows, parsed)
      }
      rows = channelRows
      basketAnchorId = rows[0]?.signal_id ?? null
    }

    const byBroker = new Map(brokers.map(b => [b.id, b]))
    const action = String(parsed.action).toLowerCase()

    if (action === 'modify' && rows.length > 0) {
      rows = await expandMgmtRowsToFullBaskets(ctx.supabase, {
        userId: signal.user_id,
        rows,
      })
      basketAnchorId = rows[0]?.signal_id ?? basketAnchorId
    }

    if (
      (action === 'close' || action === 'breakeven' || action === 'partial_profit' || action === 'partial_breakeven')
      && rows.length > 0
    ) {
      rows = await expandMgmtRowsToFullBaskets(ctx.supabase, {
        userId: signal.user_id,
        rows,
      })
      basketAnchorId = rows[0]?.signal_id ?? basketAnchorId
    }

    if (
      action === 'close_worse_entries'
      && !rows.length
      && signal.channel_id
    ) {
      rows = await loadOpenTradesForChannelWideCwe(ctx.supabase, {
        userId: signal.user_id,
        channelId: signal.channel_id,
        brokerAccountIds,
        symbolFilter: mgmtSymbolHint,
      })
    }

    const cancelledPendingScopes = new Set<string>()

    const pendingLegs = await loadRangePendingLegsInMgmtScope(ctx.supabase, {
      userId: signal.user_id,
      brokerAccountIds,
      channelId: replyScoped ? null : signal.channel_id,
      basketSignalId: replyScoped ? basketAnchorId : null,
      symbolFilter: symbolFromText,
    })

    if (action === 'close') {
      for (const scope of pendingLegsToCancelScopes(pendingLegs)) {
        cancelledPendingScopes.add(JSON.stringify(scope satisfies RangePendingCancelScope))
      }
      const earlyScopes = Array.from(cancelledPendingScopes)
        .map(enc => JSON.parse(enc) as RangePendingCancelScope)
        .filter(scope => {
          const broker = byBroker.get(scope.brokerAccountId)
          if (!broker) return false
          return !isPendingCancelBlocked(
            normalizeChannelMessageFiltersMap(broker.channel_message_filters),
            signal.channel_id,
          )
        })
      if (earlyScopes.length && !(liveMgmtFast && action === 'close')) {
        await ctx.cancelRangePendingLegsForScopes(signal.user_id, signal.id, earlyScopes, 'signal_closed')
      }
    }

    const sanitizeLevel = (v: number | null | undefined): number => {
      const n = typeof v === 'number' ? v : Number(v ?? 0)
      return Number.isFinite(n) && n > 0 ? n : 0
    }
    const hasNewSl = typeof parsed.sl === 'number' && Number.isFinite(parsed.sl) && parsed.sl > 0
    const parsedTpLevels = (parsed.tp ?? []).filter(
      (t): t is number => typeof t === 'number' && Number.isFinite(t) && t > 0,
    )
    const hasNewTp = parsedTpLevels.length > 0

    const mgmtCtx = { hasNewSl, hasNewTp }

    if (action === 'close_worse_entries') {
      if (!rows.length) {
        await skipMgmtSignalWithLog(ctx, signal, 'mgmt_no_open_trades_db', { action: 'close_worse_entries' })
        return emptyMgmtResult(legConcurrency)
      }
      const eligibleBrokers = brokers.filter(
        b => !isChannelManagementBlocked(
          normalizeChannelMessageFiltersMap(b.channel_message_filters),
          signal.channel_id,
          action,
          mgmtCtx,
        ),
      )
      if (!eligibleBrokers.length) {
        await skipMgmtSignalWithLog(ctx, signal, 'channel_filter_ignored', { action: 'close_worse_entries' })
        return emptyMgmtResult(legConcurrency)
      }
      const eligibleIds = new Set(eligibleBrokers.map(b => b.id))
      const eligibleRows = rows.filter(r => eligibleIds.has(r.broker_account_id))
      if (!eligibleRows.length) {
        await skipMgmtSignalWithLog(ctx, signal, 'cwe_no_eligible_broker_trades', {
          action: 'close_worse_entries',
          loaded_rows: rows.length,
        })
        return emptyMgmtResult(legConcurrency)
      }
      const eligibleByBroker = new Map(eligibleBrokers.map(b => [b.id, b]))
      const cweResult = await ctx.applyCloseWorseEntriesInstruction(
        signal,
        parsed,
        eligibleRows,
        eligibleByBroker,
        mgmtOpts,
      )
      return cweResult
    }

    if (!rows.length && !pendingLegs.length) {
      if (action === 'close' && signal.channel_id) {
        const channelMeta = await ctx.getChannelMeta(signal.channel_id)
        let brokerClosed = 0
        await Promise.allSettled(brokers.map(async broker => {
          const api = ctx.apiFor(broker)
          const uuid = brokerSessionUuid(broker)
          if (!api || !uuid || uuid.includes('|')) return
          const one = await tryBrokerFallbackClose({
            supabase: ctx.supabase,
            api,
            signal,
            parsed,
            brokers: [broker],
            channelDisplayName: channelMeta.commentSlug,
            channelUsername: null,
            closeWithVerification: (a, u, ticket) =>
              closeWithVerification(a, u, ticket, mgmtCloseOpts(liveMgmtFast)),
          })
          brokerClosed += one.closed
        }))
        legsTotal += brokerClosed
        if (brokerClosed > 0) {
          try {
            await ctx.supabase
              .from('signals')
              .update({ status: 'executed' })
              .eq('id', signal.id)
              .eq('status', 'parsed')
          } catch { /* best-effort */ }
          return { legsTotal, legsParallelism: legConcurrency }
        }
      }

      let skipReason = action === 'modify' && !symbolFromText && !replyScoped
        ? 'mgmt_ambiguous_modify'
        : 'mgmt_no_open_trades_broker'
      if (
        action === 'close'
        && symbolFromText
        && signal.channel_id
      ) {
        const unfiltered = await loadOpenTradesForManagement(ctx.supabase, {
          userId: signal.user_id,
          channelId: signal.channel_id,
          brokerAccountIds,
          symbolFilter: null,
        })
        if (unfiltered.length > 0) skipReason = 'mgmt_no_open_trades_symbol'
        else skipReason = 'mgmt_no_open_trades_broker'
      } else if (action !== 'modify' || symbolFromText || replyScoped) {
        skipReason = 'mgmt_no_open_trades_db'
      }
      await skipMgmtSignalWithLog(ctx, signal, skipReason, {
        action,
        symbol_filter: symbolFromText,
        reply_scoped: replyScoped,
      })
      return emptyMgmtResult(legConcurrency)
    }

    if (action === 'close' && !rows.length && pendingLegs.length) {
      const scopes = Array.from(cancelledPendingScopes)
        .map(enc => JSON.parse(enc) as RangePendingCancelScope)
        .filter(scope => {
          const broker = byBroker.get(scope.brokerAccountId)
          if (!broker) return false
          return !isPendingCancelBlocked(
            normalizeChannelMessageFiltersMap(broker.channel_message_filters),
            signal.channel_id,
          )
        })
      if (scopes.length) {
        await ctx.cancelRangePendingLegsForScopes(signal.user_id, signal.id, scopes, 'signal_closed')
      }
      try {
        await ctx.supabase
          .from('signals')
          .update({ status: 'executed' })
          .eq('id', signal.id)
          .eq('status', 'parsed')
      } catch { /* best-effort */ }
      return emptyMgmtResult(legConcurrency)
    }

    const rowsByBrokerSignal = new Map<string, MgmtTradeRow[]>()
    for (const tr of rows) {
      const key = `${tr.broker_account_id}|${tr.signal_id}`
      const list = rowsByBrokerSignal.get(key) ?? []
      list.push(tr)
      rowsByBrokerSignal.set(key, list)
    }

    const eligibleTrades = rows.filter(tr => {
      const broker = byBroker.get(tr.broker_account_id)
      if (!broker || !brokerHasLinkedSession(broker)) return false
      if (isChannelManagementBlocked(
        normalizeChannelMessageFiltersMap(broker.channel_message_filters),
        signal.channel_id,
        action,
        mgmtCtx,
      )) {
        return false
      }
      const ticket = Number(tr.metaapi_order_id)
      return Number.isFinite(ticket) && ticket > 0
    })
    if (action === 'close' || action === 'breakeven' || action === 'partial_profit' || action === 'partial_breakeven') {
      legsTotal += eligibleTrades.length
    }

    /** Most protective breakeven SL applied per symbol — persisted to channel memory after mgmt. */
    const channelBreakevenSlBySymbol = new Map<string, { sl: number; isBuy: boolean }>()
    /** Breakeven leg-level outcome tracking for the reconcile fallback + memory gating. */
    const breakevenAppliedTradeIds = new Set<string>()
    const breakevenSlByTradeId = new Map<string, number>()
    const breakevenFailedSymbolKeys = new Set<string>()
    let breakevenNeedsRetry = false
    // Breakeven: one OpenedOrders snapshot per broker session + pre-assigned
    // distinct tickets per leg, so legs run in parallel race-free (no shared
    // ticket-exclusion map mutated mid-flight).
    const breakevenOrdersByUuid = new Map<string, unknown[]>()
    const breakevenAssignedTicket = new Map<string, number>()
    const breakevenExcludeByTradeId = new Map<string, Set<number>>()
    const prepareBreakevenTickets = async (): Promise<void> => {
      const byUuid = new Map<string, MgmtTradeRow[]>()
      for (const trade of eligibleTrades) {
        const broker = byBroker.get(trade.broker_account_id)
        const u = broker ? brokerSessionUuid(broker) : null
        if (!u) continue
        const list = byUuid.get(u) ?? []
        list.push(trade)
        byUuid.set(u, list)
      }
      await Promise.all([...byUuid.entries()].map(async ([u, legs]) => {
        const broker = byBroker.get(legs[0]!.broker_account_id)
        const api = broker ? ctx.apiFor(broker) : null
        if (!api) return
        const raw = (await api.openedOrders(u).catch(() => [])) ?? []
        breakevenOrdersByUuid.set(u, raw)
        const used = new Set<number>()
        for (const leg of legs) {
          const reconciled = resolveReconciledTicketForTrade(leg, raw, used)
          const stored = Number(leg.metaapi_order_id)
          const ticket = reconciled ?? (Number.isFinite(stored) && stored > 0 ? stored : null)
          if (ticket != null) {
            breakevenAssignedTicket.set(leg.id, ticket)
            used.add(ticket)
          }
        }
        // Each leg's exclude set = the other legs' assigned tickets (immutable).
        for (const leg of legs) {
          const mine = breakevenAssignedTicket.get(leg.id)
          const excl = new Set<number>()
          for (const t of used) if (t !== mine) excl.add(t)
          breakevenExcludeByTradeId.set(leg.id, excl)
        }
      }))
    }

    const processTrade = async (trade: MgmtTradeRow): Promise<void> => {
      const broker = byBroker.get(trade.broker_account_id)
      if (!broker || !brokerHasLinkedSession(broker)) return
      if (isChannelManagementBlocked(
        normalizeChannelMessageFiltersMap(broker.channel_message_filters),
        signal.channel_id,
        action,
        mgmtCtx,
      )) {
        return
      }
      const uuid = brokerSessionUuid(broker)!
      const ticket = Number(trade.metaapi_order_id)
      if (!Number.isFinite(ticket) || ticket <= 0) return
      let effectiveTicket = ticket
      let ticketReconciledFrom: number | null = null
      const api = ctx.apiFor(broker)
      if (!api) return

      try {
        if (action === 'close') {
          const maxAttempts = liveMgmtFast ? 1 : 3
          let closeConfirmed = false
          let lastCloseReason: string | undefined
          for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            const closeResult = await closeWithVerification(
              api,
              uuid,
              effectiveTicket,
              mgmtCloseOpts(liveMgmtFast),
            )
            if (closeResult.confirmed) {
              closeConfirmed = true
              break
            }
            lastCloseReason = closeResult.reason
            const rawOrders = await api.openedOrders(uuid).catch(() => [])
            const reconciledTicket = resolveReconciledTicketForTrade(
              trade,
              rawOrders ?? [],
              new Set(),
            )
            if (reconciledTicket && reconciledTicket !== effectiveTicket) {
              ticketReconciledFrom = ticketReconciledFrom ?? effectiveTicket
              effectiveTicket = reconciledTicket
              continue
            }
            if (attempt < maxAttempts && isUnknownTicketError(lastCloseReason ?? '')) {
              await sleepMs(250 * attempt)
              continue
            }
            break
          }
          if (!closeConfirmed) {
            throw new Error(
              lastCloseReason ?? 'orderClose succeeded but ticket still open on broker',
            )
          }
          await ctx.supabase.from('trades').update({
            status: 'closed',
            closed_at: new Date().toISOString(),
            ...(ticketReconciledFrom != null ? { metaapi_order_id: String(effectiveTicket) } : {}),
          }).eq('id', trade.id)
          if (signal.channel_id) {
            await clearChannelActiveTradeParamsWhenFlat(ctx.supabase, {
              userId: signal.user_id,
              channelId: signal.channel_id,
              symbolHint: trade.symbol,
            })
          }
          cancelledPendingScopes.add(JSON.stringify({
            signalId: trade.signal_id,
            brokerAccountId: trade.broker_account_id,
            symbol: trade.symbol,
          } satisfies RangePendingCancelScope))
        } else if (action === 'partial_profit' || action === 'partial_breakeven') {
          const fraction = typeof parsed.partial_close_fraction === 'number' && parsed.partial_close_fraction > 0
            ? Math.min(0.95, parsed.partial_close_fraction)
            : 0.5
          const lots = +(trade.lot_size * fraction).toFixed(2)
          await api.orderClose(uuid, { ticket, lots })
          const remaining = Math.max(0, +(trade.lot_size - lots).toFixed(2))
          if (remaining < 0.0001) {
            await ctx.supabase.from('trades').update({
              status: 'closed',
              closed_at: new Date().toISOString(),
              lot_size: 0,
            }).eq('id', trade.id)
            if (signal.channel_id) {
              await clearChannelActiveTradeParamsWhenFlat(ctx.supabase, {
                userId: signal.user_id,
                channelId: signal.channel_id,
                symbolHint: trade.symbol,
              })
            }
          } else {
            await ctx.supabase.from('trades').update({ lot_size: remaining }).eq('id', trade.id)
          }
        } else if (action === 'breakeven') {
          // Tickets were pre-reconciled once from a single OpenedOrders snapshot;
          // use the pre-assigned ticket (no per-leg broker read here).
          const excludeTickets = breakevenExcludeByTradeId.get(trade.id) ?? new Set<number>()
          const snapshotOrders = breakevenOrdersByUuid.get(uuid) ?? null
          const upfrontTicket = breakevenAssignedTicket.get(trade.id)
            ?? resolveReconciledTicketForTrade(trade, snapshotOrders ?? [], excludeTickets)
          if (upfrontTicket && upfrontTicket !== effectiveTicket) {
            ticketReconciledFrom = effectiveTicket
            effectiveTicket = upfrontTicket
          }
          let entry = sanitizeLevel(trade.entry_price)
          if (entry <= 0) {
            entry = sanitizeLevel(await resolveMgmtEntryPrice({
              trade,
              api,
              uuid,
              ticket: effectiveTicket,
            }))
            if (entry > 0) {
              await ctx.supabase.from('trades').update({ entry_price: entry }).eq('id', trade.id)
            }
          }
          if (entry <= 0) {
            throw new Error('breakeven skipped: missing entry price on trade row')
          }
          const manual = resolveChannelTradingConfig(broker, signal.channel_id).manual_settings
          const isBuy = String(trade.direction).toLowerCase() === 'buy'
          const brokerSymbol = await ctx.resolveBrokerSymbolForLiveEntry(uuid, trade.symbol).catch(() => trade.symbol)
          const symEntry = (await ctx.getSymbolParams(uuid, brokerSymbol).catch(() => null))
            ?? (brokerSymbol.toUpperCase() !== trade.symbol.toUpperCase()
              ? await ctx.getSymbolParams(uuid, trade.symbol).catch(() => null)
              : null)
          const digits = symEntry?.digits
          const pipPrice = signalPipPrice(brokerSymbol)
          let beSl = breakevenStopLossForSymbol({
            isBuy,
            entryPrice: entry,
            manual,
            symbol: brokerSymbol,
            digits,
          })
          let modifyTp = sanitizeLevel(trade.tp)
          try {
            const q = await api.quote(uuid, brokerSymbol)
            const refPrice = isBuy ? q.bid : q.ask
            const clamped = clampBreakevenModifyStops({
              isBuy,
              stoploss: beSl,
              takeprofit: modifyTp,
              referencePrice: refPrice,
              point: symEntry?.point ?? 0,
              digits: digits ?? 5,
              stopsLevel: symEntry?.stopsLevel ?? 0,
              freezeLevel: symEntry?.freezeLevel ?? 0,
            })
            beSl = clamped.stoploss
            modifyTp = clamped.takeprofit
          } catch {
            /* quote optional; use computed breakeven SL */
          }
          breakevenSlByTradeId.set(trade.id, beSl)
          const verifyAfter = mgmtVerifyAfterModify()
          const maxAttempts = 3
          let lastErr: unknown = null
          for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            try {
              // Pre-verify against the pre-fetched snapshot (no extra broker read).
              const preVerify = await verifyBreakevenApplied({
                api,
                uuid,
                ticket: effectiveTicket,
                expectedSl: beSl,
                isBuy,
                pipPrice,
                ordersSnapshot: snapshotOrders ?? undefined,
              })
              if (preVerify.ok) {
                lastErr = null
                break
              }
              // SL-first with split fallback: the breakeven SL is the protective
              // stop and must land even if the (best-effort) TP is invalid.
              const safe = await modifyLegSlTpWithFallback(api, uuid, effectiveTicket, beSl, modifyTp)
              if (!safe.ok || (beSl > 0 && !safe.slApplied)) {
                throw new Error(safe.error ?? 'OrderModify failed')
              }
              const modRes = (safe.result ?? {}) as { stopLoss?: number | null }
              // Post-modify broker re-verify is off by default for speed; the
              // reconcile monitor re-checks broker SL and re-applies on drift.
              if (verifyAfter) {
                const verify = await verifyBreakevenApplied({
                  api,
                  uuid,
                  ticket: effectiveTicket,
                  expectedSl: beSl,
                  isBuy,
                  pipPrice,
                  confirmSl: modRes.stopLoss ?? beSl,
                })
                if (!verify.ok) throw new Error(verify.reason ?? 'verify failed')
              }
              lastErr = null
              break
            } catch (err) {
              lastErr = err
              const msg = err instanceof Error ? err.message : String(err)
              // Re-reconcile from the pre-fetched snapshot + this leg's immutable
              // exclude set (other legs' tickets) — race-free under parallelism.
              if (isUnknownTicketError(msg)) {
                const reconciledTicket = resolveReconciledTicketForTrade(trade, snapshotOrders ?? [], excludeTickets)
                if (reconciledTicket && reconciledTicket !== effectiveTicket) {
                  ticketReconciledFrom = effectiveTicket
                  effectiveTicket = reconciledTicket
                  continue
                }
              }
              if (attempt < maxAttempts && isRetryableBreakevenError(msg)) {
                await sleepMs(250 * attempt)
                continue
              }
              break
            }
          }
          if (lastErr) throw lastErr
          await ctx.supabase
            .from('trades')
            .update({
              sl: beSl,
              ...(ticketReconciledFrom != null ? { metaapi_order_id: String(effectiveTicket) } : {}),
            })
            .eq('id', trade.id)
          breakevenAppliedTradeIds.add(trade.id)
          const symKey = trade.symbol
          const prev = channelBreakevenSlBySymbol.get(symKey)
          if (!prev) {
            channelBreakevenSlBySymbol.set(symKey, { sl: beSl, isBuy })
          } else {
            channelBreakevenSlBySymbol.set(symKey, {
              sl: isBuy ? Math.max(prev.sl, beSl) : Math.min(prev.sl, beSl),
              isBuy,
            })
          }
        } else if (action === 'modify') {
          return
        }
        await ctx.supabase.from('trade_execution_logs').insert({
          user_id: signal.user_id,
          signal_id: signal.id,
          broker_account_id: broker.id,
          action: `mgmt_${action}`,
          status: 'success',
          request_payload: {
            ticket: effectiveTicket,
            action,
            basket_anchor_signal_id: trade.signal_id,
            mgmt_scope: replyScoped ? 'reply_basket' : 'channel',
            mgmt_parent_signal_id: signal.parent_signal_id,
            ticket_reconciled_from: ticketReconciledFrom ?? undefined,
          },
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        let benign = isBenignOrderModifyError(msg)
        if (benign && action === 'breakeven') {
          let entry = sanitizeLevel(trade.entry_price)
          if (entry <= 0) {
            try {
              entry = sanitizeLevel(await resolveMgmtEntryPrice({
                trade,
                api,
                uuid,
                ticket: effectiveTicket,
              }))
            } catch {
              entry = 0
            }
          }
          if (entry > 0) {
            const manual = resolveChannelTradingConfig(broker, signal.channel_id).manual_settings
            const isBuy = String(trade.direction).toLowerCase() === 'buy'
            const brokerSymbol = await ctx.resolveBrokerSymbolForLiveEntry(uuid, trade.symbol).catch(() => trade.symbol)
            const digits = (await ctx.getSymbolParams(uuid, brokerSymbol).catch(() => null))?.digits
            const beSl = breakevenStopLossForSymbol({
              isBuy,
              entryPrice: entry,
              manual,
              symbol: brokerSymbol,
              digits,
            })
            const verify = await verifyBreakevenApplied({
              api,
              uuid,
              ticket: effectiveTicket,
              expectedSl: beSl,
              isBuy,
              pipPrice: signalPipPrice(brokerSymbol),
            }).catch(() => ({ ok: false as const }))
            benign = verify.ok
          } else {
            benign = false
          }
        }
        if (action === 'breakeven') {
          if (benign) {
            breakevenAppliedTradeIds.add(trade.id)
          } else {
            breakevenFailedSymbolKeys.add(normBasketSymbolKey(trade.symbol))
          }
        }
        await ctx.supabase.from('trade_execution_logs').insert({
          user_id: signal.user_id,
          signal_id: signal.id,
          broker_account_id: broker.id,
          action: `mgmt_${action}`,
          status: benign ? 'success' : 'failed',
          request_payload: {
            ticket: effectiveTicket,
            action,
            basket_anchor_signal_id: trade.signal_id,
            mgmt_scope: replyScoped ? 'reply_basket' : 'channel',
            mgmt_parent_signal_id: signal.parent_signal_id,
            already_synced: benign || undefined,
            ticket_reconciled_from: ticketReconciledFrom ?? undefined,
          },
          error_message: benign ? null : msg,
        })
      }
    }

    // Breakeven reconcile fallback: any eligible leg that did not verify at
    // breakeven gets a basket_reconcile_job (per broker + anchor) so the basket
    // SL converges on later monitor ticks — mirroring the modify path. Without
    // this, a partial breakeven on a multi-leg basket was silently final.
    const enqueueBreakevenReconcileFallback = async (): Promise<void> => {
      const failed = eligibleTrades.filter(t => {
        const ticket = Number(t.metaapi_order_id)
        return Number.isFinite(ticket) && ticket > 0 && !breakevenAppliedTradeIds.has(t.id)
      })
      if (!failed.length) return
      breakevenNeedsRetry = true

      const groups = new Map<string, MgmtTradeRow[]>()
      for (const t of failed) {
        const key = `${t.broker_account_id}|${t.signal_id}`
        const list = groups.get(key) ?? []
        list.push(t)
        groups.set(key, list)
      }

      for (const [key, legs] of groups) {
        const [brokerId, anchorSignalId] = key.split('|')
        if (!brokerId || !anchorSignalId) continue
        const broker = byBroker.get(brokerId)
        if (!broker) continue
        const symbol = legs[0]!.symbol
        const direction = String(legs[0]!.direction).toLowerCase().includes('sell') ? 'sell' : 'buy'
        const familyTrades: BasketOpenLeg[] = legs.map(mgmtRowToBasketLegForReconcile)
        const perLegTargets: PerLegStopTarget[] = legs.map(t => ({
          stoploss: breakevenSlByTradeId.get(t.id) ?? sanitizeLevel(t.sl),
          takeprofit: sanitizeLevel(t.tp),
        }))
        await upsertBasketReconcileJob(ctx.supabase, {
          userId: signal.user_id,
          brokerAccountId: brokerId,
          anchorSignalId,
          sourceSignalId: signal.id,
          channelId: signal.channel_id,
          symbol,
          direction,
          perLegTargets,
          familyTrades,
          signalTps: [],
          tpLots: ((broker.manual_settings ?? {}) as ManualSettings).tp_lots,
          virtualPendingsSnapshot: null,
          nImmCwe: 0,
          overrideTp: null,
          lastError: `Breakeven partial: ${failed.length} leg(s) did not verify at breakeven`,
        })
      }
      console.warn(
        `[tradeExecutor] breakeven partial — ${failed.length} leg(s) queued for reconcile signal=${signal.id}`,
      )
    }

    if (action === 'breakeven') {
      // Pre-reconcile each leg to a distinct ticket from a single OpenedOrders
      // snapshot per broker, so legs can run in parallel without racing on a
      // shared ticket-exclusion map (the old serial-per-session bottleneck).
      await prepareBreakevenTickets()
      if (eligibleTrades.length > 1) {
        await Promise.allSettled(
          await parallelMap(eligibleTrades, legConcurrency, trade => processTrade(trade)),
        )
      } else {
        for (const trade of eligibleTrades) {
          await processTrade(trade)
        }
      }
      await enqueueBreakevenReconcileFallback()
    } else if (liveMgmtFast && eligibleTrades.length > 1) {
      await Promise.allSettled(
        await parallelMap(eligibleTrades, legConcurrency, trade => processTrade(trade)),
      )
    } else {
      await Promise.allSettled(eligibleTrades.map(trade => processTrade(trade)))
    }

    if (action === 'close' && liveMgmtFast && signal.channel_id) {
      await finalizeMgmtSignal(ctx, signal.id)
      deferMgmtCloseCleanup({
        ctx,
        signal,
        parsed,
        brokers,
        brokerAccountIds,
        byBroker,
        cancelledPendingScopes,
        liveMgmtFast,
        onPendingCancelled: n => { legsTotal += n },
        onBrokerStragglersClosed: n => { legsTotal += n },
      })
      return { legsTotal, legsParallelism: legConcurrency }
    }

    if (action === 'modify' && (hasNewSl || hasNewTp)) {
      // One-shot staleness gate: if a basket already recorded a NEWER instruction
      // (a later signal created_at) than this modify, applying this late-processed
      // modify would push a stale SL/TP that the reconcile loop would then have to
      // revert — the visible SL "conflict". Skip those baskets; the authoritative
      // per-basket target already holds the newer value.
      const staleBasketKeys = await findStaleBasketKeys(
        ctx.supabase,
        rowsByBrokerSignal.keys(),
        signal.created_at,
      )
      for (const key of staleBasketKeys) {
        const [brokerId, anchorSignalId] = key.split('|')
        if (!brokerId || !anchorSignalId) continue
        await logBrokerMgmtSkip(ctx, signal, brokerId, 'mgmt_stale_instruction', {
          anchor_signal_id: anchorSignalId,
          signal_created_at: signal.created_at ?? null,
        })
      }

      for (const [key, brokerRows] of rowsByBrokerSignal) {
        if (staleBasketKeys.has(key)) continue
        legsTotal += brokerRows.filter(r => {
          const ticket = Number(r.metaapi_order_id)
          return Number.isFinite(ticket) && ticket > 0
        }).length
      }

      if (mgmtUseChannelStopApply()) {
        const stopLegs = mgmtRowsToStopLegs(rows)
        const fullRowsByBrokerSignalStop = groupLegsByBrokerSignal(stopLegs)
        const rowsByBrokerSignalStop = staleBasketKeys.size
          ? new Map([...fullRowsByBrokerSignalStop].filter(([k]) => !staleBasketKeys.has(k)))
          : fullRowsByBrokerSignalStop

        for (const broker of brokers) {
          // Use the unfiltered grouping so a basket skipped only for staleness is
          // not mislabeled as "no open trades".
          const hasBasket = [...fullRowsByBrokerSignalStop.keys()].some(k => k.startsWith(`${broker.id}|`))
          if (!hasBasket) {
            if (!brokerHasLinkedSession(broker)) {
              await logBrokerMgmtSkip(ctx, signal, broker.id, 'no_broker_session')
            } else {
              await logBrokerMgmtSkip(ctx, signal, broker.id, 'mgmt_no_open_trades_broker', {
                channel_id: signal.channel_id,
              })
            }
          }
        }

        if (rowsByBrokerSignalStop.size > 0) {
          modifyApplyResult = await applyChannelStopsToBaskets({
            supabase: ctx.supabase,
            apiFor: broker => ctx.apiFor(broker as BrokerRow),
            userId: signal.user_id,
            channelId: signal.channel_id,
            signalId: signal.id,
            brokersById: byBroker,
            rowsByBrokerSignal: rowsByBrokerSignalStop,
            hasNewSl,
            hasNewTp,
            parsedSl: hasNewSl ? (parsed.sl as number) : null,
            parsedTpLevels,
            verifyOnBroker: true,
          })
          await logMgmtModifyBrokerSummaries(ctx.supabase, signal.user_id, signal.id, modifyApplyResult.brokers)
          legsTotal += modifyApplyResult.totalModified
        }
      } else {
        const mgmtRowsForApply = staleBasketKeys.size
          ? new Map([...rowsByBrokerSignal].filter(([k]) => !staleBasketKeys.has(k)))
          : rowsByBrokerSignal
        if (mgmtRowsForApply.size > 0) {
          await applyMgmtModifyToBasketGroups({
            supabase: ctx.supabase,
            apiFor: broker => ctx.apiFor(broker as BrokerRow),
            signal: {
              id: signal.id,
              user_id: signal.user_id,
              channel_id: signal.channel_id,
            },
            parsed,
            rowsByBrokerSignal: mgmtRowsForApply,
            brokersById: byBroker,
            hasNewSl,
            hasNewTp,
            parsedTpLevels,
            liveMgmtFast,
          })
        }
      }
    }

    if (
      (action === 'modify' || action === 'breakeven' || action === 'partial_breakeven')
      && pendingLegs.length
      && (hasNewSl || hasNewTp || action === 'breakeven' || action === 'partial_breakeven')
    ) {
      const tpLotsByBroker = new Map(
        brokers.map(b => [b.id, ((b.manual_settings ?? {}) as ManualSettings).tp_lots]),
      )
      const breakevenManualByBroker = new Map(
        brokers.map(b => [
          b.id,
          resolveChannelTradingConfig(b, signal.channel_id).manual_settings as ManualSettings,
        ]),
      )
      const pendingUpdated = await updateRangePendingLegsForManagement({
        supabase: ctx.supabase,
        parsed,
        pendingLegs,
        openTrades: rows,
        tpLotsByBroker,
        breakevenManualByBroker,
        action,
        hasNewSl,
        hasNewTp,
        parsedTpLevels,
      })
      if (pendingUpdated > 0) {
        console.log(
          `[tradeExecutor] mgmt updated ${pendingUpdated} range_pending_legs signal=${signal.id} action=${action}`,
        )
      }
    }

    if (
      action === 'modify'
      && signal.channel_id
      && (hasNewSl || hasNewTp)
    ) {
      const symbols = symbolsForChannelParamsPersist({
        symbolFromText,
        tradeSymbols: rows.map(r => r.symbol),
        pendingSymbols: pendingLegs.map(l => l.symbol),
      })
      await upsertChannelActiveTradeParams(ctx.supabase, {
        userId: signal.user_id,
        channelId: signal.channel_id,
        symbols,
        stoploss: hasNewSl ? (parsed.sl as number) : null,
        tpLevels: hasNewTp ? parsedTpLevels : undefined,
        replace: true,
      })
      // Record the latest adjustment as the authoritative per-basket target so
      // new layers + reconcile use it (single source of truth, latest wins).
      for (const [basketKey, brokerRows] of rowsByBrokerSignal) {
        const [brokerId, anchorSignalId] = basketKey.split('|')
        if (!brokerId || !anchorSignalId) continue
        await upsertBasketSlTpTarget(ctx.supabase, {
          userId: signal.user_id,
          brokerAccountId: brokerId,
          anchorSignalId,
          channelId: signal.channel_id,
          symbol: brokerRows[0]?.symbol ?? symbols[0] ?? 'UNKNOWN',
          stoploss: hasNewSl ? (parsed.sl as number) : null,
          tpLevels: hasNewTp ? parsedTpLevels : null,
          source: 'adjust',
          instructionAt: signal.created_at,
        })
      }
      if (pendingLegs.length > 0) {
        const tpLotsByBroker = new Map(
          brokers.map(b => [b.id, ((b.manual_settings ?? {}) as ManualSettings).tp_lots]),
        )
        const mgmtChannelParams: ChannelActiveTradeParams = {
          symbol: symbols[0] ?? symbolFromText ?? pendingLegs[0]!.symbol,
          stoploss: hasNewSl ? (parsed.sl as number) : null,
          tpLevels: hasNewTp ? parsedTpLevels : [],
        }
        const scopes = new Map<string, { signalId: string; brokerAccountId: string; symbol: string }>()
        for (const leg of pendingLegs) {
          scopes.set(`${leg.signal_id}|${leg.broker_account_id}|${leg.symbol}`, {
            signalId: leg.signal_id,
            brokerAccountId: leg.broker_account_id,
            symbol: leg.symbol,
          })
        }
        let pendingPatched = 0
        for (const scope of scopes.values()) {
          pendingPatched += await patchActiveRangePendingLegStops({
            supabase: ctx.supabase,
            scope,
            stoploss: hasNewSl ? (parsed.sl as number) : null,
            channelParams: mgmtChannelParams,
            tpLots: tpLotsByBroker.get(scope.brokerAccountId),
            plannedRangeLegs: pendingLegs.filter(
              l => l.signal_id === scope.signalId && l.broker_account_id === scope.brokerAccountId,
            ).length,
          })
        }
        if (pendingPatched > 0) {
          console.log(
            `[tradeExecutor] mgmt patched ${pendingPatched} range_pending_legs from adjust signal=${signal.id}`,
          )
        }
      }
    }

    if (
      action === 'breakeven'
      && signal.channel_id
      && channelBreakevenSlBySymbol.size > 0
    ) {
      const symbols = symbolsForChannelParamsPersist({
        symbolFromText,
        tradeSymbols: rows.map(r => r.symbol),
        pendingSymbols: pendingLegs.map(l => l.symbol),
      })
      // Only persist "at breakeven" to channel memory for symbols where every
      // eligible leg verified. Otherwise pending ladder legs would inherit a
      // breakeven SL the open legs never actually reached (split-basket state).
      // Failed symbols are healed by the reconcile fallback instead.
      const symbolBreakevenOk = (sym: string): boolean =>
        !breakevenFailedSymbolKeys.has(normBasketSymbolKey(sym))
      let bestSl = 0
      let bestIsBuy = true
      for (const sym of symbols) {
        if (!symbolBreakevenOk(sym)) continue
        const hit = channelBreakevenSlBySymbol.get(sym)
        if (!hit) continue
        if (bestSl <= 0) {
          bestSl = hit.sl
          bestIsBuy = hit.isBuy
        } else {
          bestSl = bestIsBuy ? Math.max(bestSl, hit.sl) : Math.min(bestSl, hit.sl)
        }
      }
      if (bestSl <= 0) {
        for (const [sym, hit] of channelBreakevenSlBySymbol) {
          if (!symbolBreakevenOk(sym)) continue
          if (bestSl <= 0) {
            bestSl = hit.sl
            bestIsBuy = hit.isBuy
          } else {
            bestSl = hit.isBuy ? Math.max(bestSl, hit.sl) : Math.min(bestSl, hit.sl)
          }
        }
      }
      if (bestSl > 0) {
        await upsertChannelActiveTradeParams(ctx.supabase, {
          userId: signal.user_id,
          channelId: signal.channel_id,
          symbols,
          stoploss: bestSl,
          replace: false,
        })
        // Record breakeven as the authoritative per-basket target (SL only —
        // merge keeps the existing TP ladder). Only for baskets whose symbol
        // verified at breakeven.
        for (const [basketKey, brokerRows] of rowsByBrokerSignal) {
          const [brokerId, anchorSignalId] = basketKey.split('|')
          if (!brokerId || !anchorSignalId) continue
          const basketSymbol = brokerRows[0]?.symbol ?? symbols[0] ?? 'UNKNOWN'
          if (!symbolBreakevenOk(basketSymbol)) continue
          await upsertBasketSlTpTarget(ctx.supabase, {
            userId: signal.user_id,
            brokerAccountId: brokerId,
            anchorSignalId,
            channelId: signal.channel_id,
            symbol: basketSymbol,
            stoploss: bestSl,
            source: 'breakeven',
            instructionAt: signal.created_at,
          })
        }
      }
    }

    if (action === 'close' && cancelledPendingScopes.size > 0 && !liveMgmtFast) {
      const scopes = Array.from(cancelledPendingScopes)
        .map(enc => JSON.parse(enc) as RangePendingCancelScope)
        .filter(scope => {
          const broker = byBroker.get(scope.brokerAccountId)
          if (!broker) return false
          return !isPendingCancelBlocked(
            normalizeChannelMessageFiltersMap(broker.channel_message_filters),
            signal.channel_id,
          )
        })
      if (scopes.length > 0) {
        await ctx.cancelRangePendingLegsForScopes(signal.user_id, signal.id, scopes, 'signal_closed')
      }
    }

    if (action === 'close' && signal.channel_id && !liveMgmtFast) {
      const pendingCancelled = await cancelChannelBrokerPendingOrders({
        supabase: ctx.supabase,
        userId: signal.user_id,
        channelId: signal.channel_id,
        brokerAccountIds,
        apiFor: uuid => {
          for (const broker of brokers) {
            if (brokerSessionUuid(broker) === uuid) return ctx.apiFor(broker)
          }
          return null
        },
        reason: 'signal_closed',
      })
      if (pendingCancelled > 0) {
        legsTotal += pendingCancelled
        console.log(
          `[tradeExecutor] mgmt cancelled ${pendingCancelled} broker pendings signal=${signal.id}`,
        )
      }

      const channelMeta = await ctx.getChannelMeta(signal.channel_id)
      let brokerClosed = 0
      await Promise.allSettled(brokers.map(async broker => {
        const api = ctx.apiFor(broker)
        const uuid = brokerSessionUuid(broker)
        if (!api || !uuid || uuid.includes('|')) return
        const one = await tryBrokerFallbackClose({
          supabase: ctx.supabase,
          api,
          signal,
          parsed,
          brokers: [broker],
          channelDisplayName: channelMeta.commentSlug,
          channelUsername: null,
          closeWithVerification: (a, u, ticket) =>
            closeWithVerification(a, u, ticket, mgmtCloseOpts(liveMgmtFast)),
        })
        brokerClosed += one.closed
      }))
      if (brokerClosed > 0) {
        legsTotal += brokerClosed
        console.log(
          `[tradeExecutor] mgmt broker sweep closed ${brokerClosed} stragglers signal=${signal.id}`,
        )
      }
    }

    // Management messages do not insert `trades` with `signal_id = this row`,
    // so `sweep()` never skips them via the "trade already exists" guard.
    // Flip off `parsed` after one dispatch so we never double-apply the same
    // Close half / breakeven / modify intent on every 15s tick.
    const modifyNeedsRetry = action === 'modify'
      && (hasNewSl || hasNewTp)
      && mgmtUseChannelStopApply()
      && modifyApplyResult != null
      && !modifyApplyResult.allFullySynced

    if (modifyNeedsRetry) {
      console.warn(
        `[tradeExecutor] mgmt modify partial — leaving signal parsed for reconcile`
        + ` signal=${signal.id} modified=${modifyApplyResult!.totalModified}`
        + ` failed=${modifyApplyResult!.totalFailed}`,
      )
    } else if (breakevenNeedsRetry) {
      console.warn(
        `[tradeExecutor] mgmt breakeven partial — leaving signal parsed for reconcile signal=${signal.id}`,
      )
    } else {
      await finalizeMgmtSignal(ctx, signal.id)
    }
    return { legsTotal, legsParallelism: legConcurrency }
  }

export async function applyCloseWorseEntriesInstruction(ctx: TradeExecutorContext,
    signal: SignalRow,
    parsed: ParsedSignal,
    rows: Array<{
      id: string
      signal_id?: string | null
      broker_account_id: string
      metaapi_order_id: string | null
      symbol: string
      direction: string
      lot_size: number
      status: string
      entry_price: number | null
      cwe_close_price?: number | null
    }>,
    byBroker: Map<string, BrokerRow>,
    mgmtOpts?: MgmtExecOptions,
  ): Promise<MgmtExecResult> {
    const liveMgmtFast = mgmtOpts?.liveMgmtFast === true
    const legConcurrency = liveMgmtFast ? mgmtLegConcurrency() : 1
    let legsTotal = 0

    if (!hasFxsocketConfigured()) {
      await skipMgmtSignalWithLog(ctx, signal, 'broker_api_not_configured', { action: 'close_worse_entries' })
      return emptyMgmtResult(legConcurrency)
    }

    const openRows = rows.filter(r => r.status === 'open')
    if (!openRows.length) {
      await skipMgmtSignalWithLog(ctx, signal, 'cwe_no_open_trades', { action: 'close_worse_entries' })
      return emptyMgmtResult(legConcurrency)
    }

    const groups = new Map<string, typeof openRows>()
    for (const t of openRows) {
      const key = cweInstructionGroupKey(t)
      const list = groups.get(key) ?? []
      list.push(t)
      groups.set(key, list)
    }

    const groupOutcomes = await Promise.allSettled(Array.from(groups.entries()).map(async ([key, groupTrades]): Promise<{ closed: number; eligible: number }> => {
      const parsedKey = parseCweInstructionGroupKey(key)
      if (!parsedKey) return { closed: 0, eligible: 0 }
      const { brokerId, symbol } = parsedKey
      const broker = byBroker.get(brokerId)
      if (!broker || !brokerHasLinkedSession(broker)) return { closed: 0, eligible: 0 }

      const manual = (broker.manual_settings ?? {}) as ManualSettings
      if (manual.trade_style !== 'multi') {
        await ctx.supabase.from('trade_execution_logs').insert({
          user_id: signal.user_id,
          signal_id: signal.id,
          broker_account_id: broker.id,
          action: 'mgmt_close_worse_entries',
          status: 'skipped',
          request_payload: {
            reason: 'cwe_requires_multi_trade',
            trade_style: manual.trade_style ?? 'single',
          },
        })
        return { closed: 0, eligible: 0 }
      }

      const uuid = brokerSessionUuid(broker)!
      const api = ctx.apiFor(broker)
      if (!api) {
        await ctx.supabase.from('trade_execution_logs').insert({
          user_id: signal.user_id,
          signal_id: signal.id,
          broker_account_id: broker.id,
          action: 'mgmt_close_worse_entries',
          status: 'skipped',
          request_payload: { reason: 'cwe_broker_api_unavailable', symbol },
        })
        return { closed: 0, eligible: 0 }
      }

      const signalIds = [
        ...new Set(
          groupTrades
            .map(t => String(t.signal_id ?? '').trim())
            .filter(Boolean),
        ),
      ]
      const layeringTickets = await loadFiredRangeLayeringTickets(ctx.supabase, {
        signalIds,
        brokerAccountId: brokerId,
        symbol,
      })

      const cwePips = Math.max(0, Number(manual.close_worse_entries_pips ?? 30))
      const pipSize = signalPipPrice(symbol)
      let referencePrice: number | null = null
      if (cwePips > 0 && pipSize > 0) {
        try {
          const brokerSymbol = await ctx.resolveBrokerSymbolForLiveEntry(uuid, symbol).catch(() => symbol)
          const q = await api.quote(uuid, brokerSymbol)
          referencePrice = referencePriceForDirection(parsedKey.direction, q.bid, q.ask)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          await ctx.supabase.from('trade_execution_logs').insert({
            user_id: signal.user_id,
            signal_id: signal.id,
            broker_account_id: broker.id,
            action: 'mgmt_close_worse_entries',
            status: 'skipped',
            request_payload: {
              reason: 'cwe_quote_unavailable',
              symbol,
              error: msg.slice(0, 200),
            },
          })
          return { closed: 0, eligible: 0 }
        }
      }

      const toClose = referencePrice != null && cwePips > 0
        ? selectWorseImmediateLegsForCweInstruction({
          trades: groupTrades,
          layeringTickets,
          referencePrice,
          pips: cwePips,
          pipSize,
        })
        : selectImmediateLegsForCweInstruction(groupTrades, layeringTickets)
      let groupClosed = 0
      legsTotal += toClose.length

      console.log(
        `[tradeExecutor] cwe instruction signal=${signal.id} broker=${broker.id} symbol=${symbol}`
        + ` mode=instruction_immediate_within_pips matched=${toClose.length}/${groupTrades.length}`
        + ` layering_tickets=${layeringTickets.size} pips=${cwePips}`
        + (referencePrice != null ? ` ref=${referencePrice}` : ''),
      )

      if (!toClose.length) {
        await ctx.supabase.from('trade_execution_logs').insert({
          user_id: signal.user_id,
          signal_id: signal.id,
          broker_account_id: broker.id,
          action: 'mgmt_close_worse_entries',
          status: 'skipped',
          request_payload: {
            mode: 'instruction_immediate_within_pips',
            reason: groupTrades.length > 0 ? 'cwe_no_immediates_within_pips' : 'cwe_no_open_immediates',
            open_legs: groupTrades.length,
            layering_tickets_excluded: layeringTickets.size,
            cwe_pips: cwePips,
            reference_price: referencePrice,
            symbol,
          },
        })
        return { closed: 0, eligible: 0 }
      }

      const closeOneLeg = async (trade: typeof toClose[number]): Promise<number> => {
        const ticket = Number(trade.metaapi_order_id)
        if (!Number.isFinite(ticket) || ticket <= 0) return 0
        try {
          const closeResult = await closeWithVerification(api, uuid, ticket, mgmtCloseOpts(liveMgmtFast))
          if (!closeResult.confirmed) {
            throw new Error(closeResult.reason ?? 'cwe orderClose: ticket still open')
          }
          await ctx.supabase
            .from('trades')
            .update({
              status: 'closed',
              closed_at: new Date().toISOString(),
              cwe_close_price: null,
            })
            .eq('id', trade.id)
          if (signal.channel_id) {
            await clearChannelActiveTradeParamsWhenFlat(ctx.supabase, {
              userId: signal.user_id,
              channelId: signal.channel_id,
              symbolHint: trade.symbol,
            })
          }
          await ctx.supabase.from('trade_execution_logs').insert({
            user_id: signal.user_id,
            signal_id: signal.id,
            broker_account_id: broker.id,
            action: 'mgmt_close_worse_entries',
            status: 'success',
            request_payload: {
              mode: 'instruction_immediate_within_pips',
              ticket,
              symbol,
              direction: trade.direction,
              entry_price: trade.entry_price,
              layering_tickets_excluded: layeringTickets.size,
            },
          })
          return 1
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          const benign = /not\s+found|already\s+closed|invalid\s+ticket|no\s+such\s+order/i.test(msg)
          if (benign) {
            await ctx.supabase
              .from('trades')
              .update({
                status: 'closed',
                closed_at: new Date().toISOString(),
                cwe_close_price: null,
              })
              .eq('id', trade.id)
            if (signal.channel_id) {
              await clearChannelActiveTradeParamsWhenFlat(ctx.supabase, {
                userId: signal.user_id,
                channelId: signal.channel_id,
                symbolHint: trade.symbol,
              })
            }
            return 1
          }
          await ctx.supabase.from('trade_execution_logs').insert({
            user_id: signal.user_id,
            signal_id: signal.id,
            broker_account_id: broker.id,
            action: 'mgmt_close_worse_entries',
            status: 'failed',
            request_payload: {
              mode: 'instruction_immediate_within_pips',
              ticket,
              symbol,
              entry_price: trade.entry_price,
            },
            error_message: msg,
          })
          return 0
        }
      }

      const closeResults = liveMgmtFast && toClose.length > 1
        ? await parallelMap(toClose, legConcurrency, trade => closeOneLeg(trade))
        : await Promise.all(toClose.map(trade => closeOneLeg(trade)))
      groupClosed = closeResults.reduce((sum, n) => sum + n, 0)
      return { closed: groupClosed, eligible: toClose.length }
    }))

    let closedCount = 0
    let eligibleCloseCount = 0
    for (const outcome of groupOutcomes) {
      if (outcome.status !== 'fulfilled') continue
      closedCount += outcome.value.closed
      eligibleCloseCount += outcome.value.eligible
    }

    if (closedCount > 0) {
      try {
        const { error: sigErr } = await ctx.supabase
          .from('signals')
          .update({ status: 'executed' })
          .eq('id', signal.id)
          .eq('status', 'parsed')
        if (sigErr) {
          console.warn(`[tradeExecutor] cwe instruction finalize failed id=${signal.id}: ${sigErr.message}`)
        }
      } catch {
        // best-effort
      }
      return { legsTotal, legsParallelism: legConcurrency }
    }

    const skipReason = eligibleCloseCount > 0
      ? 'cwe_close_failed'
      : 'cwe_no_open_immediates'
    await skipMgmtSignalWithLog(ctx, signal, skipReason, {
      action: 'close_worse_entries',
      open_legs: openRows.length,
      eligible_close_legs: eligibleCloseCount,
    })
    return { legsTotal, legsParallelism: legConcurrency }
  }
