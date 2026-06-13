import {
  clearChannelActiveTradeParamsWhenFlat,
  symbolsForChannelParamsPersist,
  upsertChannelActiveTradeParams,
  type ChannelActiveTradeParams
} from '../channelActiveTradeParams'
import { isChannelManagementBlocked, isPendingCancelBlocked, normalizeChannelMessageFiltersMap } from '../channelMessageFilters'
import {
  cweInstructionGroupKey,
  loadFiredRangeLayeringTickets,
  parseCweInstructionGroupKey,
  selectImmediateLegsForCweInstruction,
} from '../closeWorseEntries'
import { tryBrokerFallbackClose } from '../managementBrokerClose'
import { applyMgmtModifyToBasketGroups } from '../managementModifyBaskets'
import { loadRangePendingLegsInMgmtScope, pendingLegsToCancelScopes, updateRangePendingLegsForManagement } from '../managementPendingLegs'
import {
  explicitMgmtSymbol,
  isReplyScopedManagement,
  loadOpenTradesForChannelWideCwe,
  loadOpenTradesForManagement,
  resolveChannelModifyTargets,
  type MgmtTradeRow
} from '../managementScope'
import { type ManualSettings } from '../manualPlanner'
import { hasMetatraderApiConfigured, type MetatraderApiClient } from '../metatraderapi'
import { resolveLatestOpenBasketAnchor } from '../multiTradeMerge'
import { isBenignOrderModifyError } from '../orderModifyBenign'
import { patchActiveRangePendingLegStops } from '../rangePendingLadderSync'
import { type TradeExecutorContext } from './context'
import { isMtUuid } from './helpers'
import {
  type BrokerRow,
  type ParsedSignal,
  type RangePendingCancelScope,
  type SignalRow
} from './types'

interface CloseVerificationResult {
  confirmed: boolean
  reason?: string
  attempts: number
}

async function closeWithVerification(
  api: MetatraderApiClient,
  uuid: string,
  ticket: number,
  opts: { maxAttempts?: number; slippageEscalation?: number } = {},
): Promise<CloseVerificationResult> {
  const maxAttempts = opts.maxAttempts ?? 2
  const slippageStep = opts.slippageEscalation ?? 50

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const slippage = 20 + (attempt - 1) * slippageStep
    const result = await api.orderClose(uuid, { ticket, slippage })

    if (result.state && /^(rejected|cancelled|expired)/i.test(result.state)) {
      if (attempt >= maxAttempts) {
        return { confirmed: false, reason: `orderClose state=${result.state}`, attempts: attempt }
      }
      await new Promise(r => setTimeout(r, 300))
      continue
    }

    await new Promise(r => setTimeout(r, 400))

    let stillOpen = false
    try {
      const openOrders = await api.openedOrders(uuid)
      for (const raw of openOrders ?? []) {
        if (!raw || typeof raw !== 'object') continue
        const o = raw as Record<string, unknown>
        const t = Number(o.ticket ?? o.Ticket ?? o.orderId ?? o.OrderID ?? 0)
        if (t === ticket) { stillOpen = true; break }
      }
    } catch {
      return { confirmed: true, attempts: attempt }
    }

    if (!stillOpen) {
      return { confirmed: true, attempts: attempt }
    }

    if (attempt >= maxAttempts) {
      return { confirmed: false, reason: 'ticket still open after orderClose + verification', attempts: attempt }
    }
    await new Promise(r => setTimeout(r, 300))
  }
  return { confirmed: false, reason: 'exhausted attempts', attempts: maxAttempts }
}

export async function logSendSkipped(ctx: TradeExecutorContext, 
    signal: SignalRow,
    broker: BrokerRow,
    reason: string,
    extra: Record<string, unknown>,
  ): Promise<void> {
    if (reason === 'broker_session_not_connected') {
      const uuid = broker.metaapi_account_id
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

export async function applyManagement(ctx: TradeExecutorContext, signal: SignalRow, parsed: ParsedSignal, brokers: BrokerRow[]): Promise<void> {
    if (!hasMetatraderApiConfigured()) {
      await skipMgmtSignalWithLog(ctx, signal, 'broker_api_not_configured', {
        action: String(parsed.action ?? '').toLowerCase(),
      })
      return
    }

    const brokerAccountIds = brokers.map(b => b.id)
    const replyScoped = isReplyScopedManagement(signal)
    const symbolFromText = explicitMgmtSymbol(parsed)
    let mgmtSymbolHint: string | null = symbolFromText
    let basketAnchorId: string | null = null
    let rows: MgmtTradeRow[] = []

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
          return
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
        return
      }
      const actionPre = String(parsed.action ?? '').toLowerCase()
      let channelRows = actionPre === 'close_worse_entries'
        ? await loadOpenTradesForChannelWideCwe(ctx.supabase, {
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
        channelRows = resolveChannelModifyTargets(channelRows, parsed)
      }
      rows = channelRows
      basketAnchorId = rows[0]?.signal_id ?? null
    }

    const byBroker = new Map(brokers.map(b => [b.id, b]))
    const action = String(parsed.action).toLowerCase()

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
      if (earlyScopes.length) {
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
        return
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
        return
      }
      const eligibleIds = new Set(eligibleBrokers.map(b => b.id))
      const eligibleRows = rows.filter(r => eligibleIds.has(r.broker_account_id))
      if (!eligibleRows.length) {
        await skipMgmtSignalWithLog(ctx, signal, 'cwe_no_eligible_broker_trades', {
          action: 'close_worse_entries',
          loaded_rows: rows.length,
        })
        return
      }
      const eligibleByBroker = new Map(eligibleBrokers.map(b => [b.id, b]))
      await ctx.applyCloseWorseEntriesInstruction(signal, parsed, eligibleRows, eligibleByBroker)
      return
    }

    if (!rows.length && !pendingLegs.length) {
      if (action === 'close' && signal.channel_id) {
        const channelMeta = await ctx.getChannelMeta(signal.channel_id)
        let brokerClosed = 0
        await Promise.allSettled(brokers.map(async broker => {
          const api = ctx.apiFor(broker)
          const uuid = broker.metaapi_account_id
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
              closeWithVerification(a, u, ticket, { maxAttempts: 2, slippageEscalation: 50 }),
          })
          brokerClosed += one.closed
        }))
        if (brokerClosed > 0) {
          try {
            await ctx.supabase
              .from('signals')
              .update({ status: 'executed' })
              .eq('id', signal.id)
              .eq('status', 'parsed')
          } catch { /* best-effort */ }
          return
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
      return
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
      return
    }

    const rowsByBrokerSignal = new Map<string, MgmtTradeRow[]>()
    for (const tr of rows) {
      const key = `${tr.broker_account_id}|${tr.signal_id}`
      const list = rowsByBrokerSignal.get(key) ?? []
      list.push(tr)
      rowsByBrokerSignal.set(key, list)
    }

    await Promise.allSettled(rows.map(async trade => {
      const broker = byBroker.get(trade.broker_account_id)
      if (!broker || !isMtUuid(broker.metaapi_account_id)) return
      if (isChannelManagementBlocked(
        normalizeChannelMessageFiltersMap(broker.channel_message_filters),
        signal.channel_id,
        action,
        mgmtCtx,
      )) {
        return
      }
      const uuid = broker.metaapi_account_id!
      const ticket = Number(trade.metaapi_order_id)
      if (!Number.isFinite(ticket) || ticket <= 0) return
      const api = ctx.apiFor(broker)
      if (!api) return

      try {
        if (action === 'close') {
          const closeResult = await closeWithVerification(api, uuid, ticket, { maxAttempts: 2, slippageEscalation: 50 })
          if (!closeResult.confirmed) {
            throw new Error(
              closeResult.reason ?? 'orderClose succeeded but ticket still open on broker',
            )
          }
          await ctx.supabase.from('trades').update({ status: 'closed', closed_at: new Date().toISOString() }).eq('id', trade.id)
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
          const entry = sanitizeLevel(trade.entry_price)
          if (entry > 0) {
            await api.orderModify(uuid, {
              ticket,
              stoploss: entry,
              takeprofit: sanitizeLevel(trade.tp),
            })
            await ctx.supabase.from('trades').update({ sl: entry }).eq('id', trade.id)
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
            ticket,
            action,
            basket_anchor_signal_id: trade.signal_id,
            mgmt_scope: replyScoped ? 'reply_basket' : 'channel',
            mgmt_parent_signal_id: signal.parent_signal_id,
          },
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const benign = isBenignOrderModifyError(msg)
        await ctx.supabase.from('trade_execution_logs').insert({
          user_id: signal.user_id,
          signal_id: signal.id,
          broker_account_id: broker.id,
          action: `mgmt_${action}`,
          status: benign ? 'success' : 'failed',
          request_payload: {
            ticket,
            action,
            basket_anchor_signal_id: trade.signal_id,
            mgmt_scope: replyScoped ? 'reply_basket' : 'channel',
            mgmt_parent_signal_id: signal.parent_signal_id,
            already_synced: benign || undefined,
          },
          error_message: benign ? null : msg,
        })
      }
    }))

    if (action === 'modify' && (hasNewSl || hasNewTp)) {
      await applyMgmtModifyToBasketGroups({
        supabase: ctx.supabase,
        apiFor: broker => ctx.apiFor(broker as BrokerRow),
        signal: {
          id: signal.id,
          user_id: signal.user_id,
          channel_id: signal.channel_id,
        },
        parsed,
        rowsByBrokerSignal,
        brokersById: byBroker,
        hasNewSl,
        hasNewTp,
        parsedTpLevels,
      })
    }

    if (
      (action === 'modify' || action === 'breakeven' || action === 'partial_breakeven')
      && pendingLegs.length
      && (hasNewSl || hasNewTp || action === 'breakeven' || action === 'partial_breakeven')
    ) {
      const tpLotsByBroker = new Map(
        brokers.map(b => [b.id, ((b.manual_settings ?? {}) as ManualSettings).tp_lots]),
      )
      const pendingUpdated = await updateRangePendingLegsForManagement({
        supabase: ctx.supabase,
        parsed,
        pendingLegs,
        openTrades: rows,
        tpLotsByBroker,
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

    if (action === 'close' && cancelledPendingScopes.size > 0) {
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

    // Management messages do not insert `trades` with `signal_id = this row`,
    // so `sweep()` never skips them via the "trade already exists" guard.
    // Flip off `parsed` after one dispatch so we never double-apply the same
    // Close half / breakeven / modify intent on every 15s tick.
    try {
      const { error: sigErr } = await ctx.supabase
        .from('signals')
        .update({ status: 'executed' })
        .eq('id', signal.id)
        .eq('status', 'parsed')
      if (sigErr) {
        console.warn(`[tradeExecutor] mgmt signal finalize failed id=${signal.id}: ${sigErr.message}`)
      }
    } catch {
      // best-effort
    }
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
  ): Promise<void> {
    if (!hasMetatraderApiConfigured()) {
      await skipMgmtSignalWithLog(ctx, signal, 'broker_api_not_configured', { action: 'close_worse_entries' })
      return
    }

    const openRows = rows.filter(r => r.status === 'open')
    if (!openRows.length) {
      await skipMgmtSignalWithLog(ctx, signal, 'cwe_no_open_trades', { action: 'close_worse_entries' })
      return
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
      if (!broker || !isMtUuid(broker.metaapi_account_id)) return { closed: 0, eligible: 0 }

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

      const uuid = broker.metaapi_account_id!
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
      const toClose = selectImmediateLegsForCweInstruction(groupTrades, layeringTickets)
      let groupClosed = 0

      console.log(
        `[tradeExecutor] cwe instruction signal=${signal.id} broker=${broker.id} symbol=${symbol}`
        + ` mode=instruction_immediate_only matched=${toClose.length}/${groupTrades.length}`
        + ` layering_tickets=${layeringTickets.size}`,
      )

      if (!toClose.length) {
        await ctx.supabase.from('trade_execution_logs').insert({
          user_id: signal.user_id,
          signal_id: signal.id,
          broker_account_id: broker.id,
          action: 'mgmt_close_worse_entries',
          status: 'skipped',
          request_payload: {
            mode: 'instruction_immediate_only',
            reason: groupTrades.length > 0 ? 'cwe_all_legs_layering_or_no_ticket' : 'cwe_no_open_immediates',
            open_legs: groupTrades.length,
            layering_tickets_excluded: layeringTickets.size,
            symbol,
          },
        })
        return { closed: 0, eligible: 0 }
      }

      for (const trade of toClose) {
        const ticket = Number(trade.metaapi_order_id)
        if (!Number.isFinite(ticket) || ticket <= 0) continue
        try {
          const closeResult = await closeWithVerification(api, uuid, ticket, { maxAttempts: 2, slippageEscalation: 50 })
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
              mode: 'instruction_immediate_only',
              ticket,
              symbol,
              direction: trade.direction,
              entry_price: trade.entry_price,
              layering_tickets_excluded: layeringTickets.size,
            },
          })
          groupClosed += 1
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
            groupClosed += 1
          } else {
            await ctx.supabase.from('trade_execution_logs').insert({
              user_id: signal.user_id,
              signal_id: signal.id,
              broker_account_id: broker.id,
              action: 'mgmt_close_worse_entries',
              status: 'failed',
              request_payload: {
                mode: 'instruction_immediate_only',
                ticket,
                symbol,
                entry_price: trade.entry_price,
              },
              error_message: msg,
            })
          }
        }
      }
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
      return
    }

    const skipReason = eligibleCloseCount > 0
      ? 'cwe_close_failed'
      : 'cwe_no_open_immediates'
    await skipMgmtSignalWithLog(ctx, signal, skipReason, {
      action: 'close_worse_entries',
      open_legs: openRows.length,
      eligible_close_legs: eligibleCloseCount,
    })
  }
