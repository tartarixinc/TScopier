import {
  hasMetatraderApiConfigured,
  isBrokerDisconnectedMessage,
  MT_SESSION_EXPIRED_HINT,
  MetatraderApiClient,
  MtOperation,
  OrderSendArgs,
} from '../metatraderapi'
import {
  clampPendingExpiryHours,
  parsedHasExplicitEntryAnchor,
  planManualOrders,
  resolvedParsedEntryPrice,
  resolvedParsedEntryZone,
  signalEntryPriceStrictEnabled,
  SKIP_REASON_SIGNAL_ENTRY_REQUIRED,
  strictSignalEntryQuoteAllowsImmediate,
  lastPositiveParsedTpPrice,
  type ChannelKeywords,
  type ManualSettings,
  type ParsedSignal as PlannerParsedSignal,
  type PlannerResult,
  type VirtualPendingLeg,
} from '../manualPlanner'
import { findActiveNewsBlackout } from '../newsTrading/blackout'
import { getCalendarEventsCached } from '../newsTrading/calendarProvider'
import { isNewsTradingEnabled } from '../newsTrading/settings'
import { shouldRouteAsBasketParameterRefresh } from '../multiTradeMerge'
import { parsedHasReEnterIntent } from '../signalPriceInference'
import {
  applyChannelParamsToVirtualPendingList,
  parsedSignalHasExplicitStops,
  refreshChannelParamsFromSignal,
  resolveEntryChannelStops,
  shouldPreferSignalStopsOverChannelMemory,
  type ChannelActiveTradeParams,
} from '../channelActiveTradeParams'
import { buildTscopierCommentPrefix } from '../tradeComment'
import type { TradeExecutorContext } from './context'
import { applySymbolMapping, computeCweTp, computeLot, isExcluded, isMt5OnlyOperation, roundLot, type Leg } from './helpers'
import type {
  BrokerRow,
  ParsedSignal,
  SendOrderOutcome,
  SignalRow,
  SymbolCacheEntry,
  SymbolMappingResult,
} from './types'

export type EntryArgs = {
  signal: SignalRow
  parsed: ParsedSignal
  op: MtOperation
  broker: BrokerRow
  channelKeywords: ChannelKeywords | null
  pipelineT0?: number
  sendOpts?: { liveEntryFast?: boolean; commentPrefix?: string; messageEditOnly?: boolean }
}

export type PreparedEntry = {
  ctx: TradeExecutorContext
  signal: SignalRow
  parsed: ParsedSignal
  broker: BrokerRow
  manual: ManualSettings
  api: MetatraderApiClient
  uuid: string
  symbol: string
  requestedSymbol: string
  mapping: SymbolMappingResult
  params: SymbolCacheEntry | null
  liveEntryFast: boolean
  pipelineT0?: number
  strictEntryPrefetch: { bid: number; ask: number } | null
  commentPrefix: string
  channelDelayMs: number
  channelDelaySkipped: boolean
  plan: PlannerResult
  capped: OrderSendArgs[]
  virtualPendings: VirtualPendingLeg[]
  legs: Leg[]
  deferVirtualAnchor: boolean
  strictDeferred: boolean
  op: MtOperation
  channelKeywords: ChannelKeywords | null
  baseLot: number
  anchor: number | null
  anchorSource: 'signal' | 'quote' | 'unknown'
  isManual: boolean
}

export type PrepareEntryResult =
  | { ok: false; outcome: SendOrderOutcome }
  | { ok: true; prep: PreparedEntry }

/** Fill missing symbol for re-enter posts that omit instrument name. */
async function resolveReEnterSymbolFromChannel(
  ctx: TradeExecutorContext,
  signal: SignalRow,
  broker: BrokerRow,
  parsed: ParsedSignal,
): Promise<ParsedSignal> {
  if (!parsedHasReEnterIntent(parsed)) return parsed
  if (parsed.symbol?.trim()) return parsed
  if (!signal.channel_id) return parsed

  const direction = String(parsed.action ?? '').toLowerCase()
  if (direction !== 'buy' && direction !== 'sell') return parsed

  const { data: openTrades, error } = await ctx.supabase
    .from('trades')
    .select('symbol, signal_id, opened_at')
    .eq('user_id', signal.user_id)
    .eq('broker_account_id', broker.id)
    .eq('status', 'open')
    .eq('direction', direction)
    .order('opened_at', { ascending: false })
    .limit(100)
  if (error || !openTrades?.length) return parsed

  const signalIds = [...new Set(
    (openTrades as { signal_id: string }[]).map(r => r.signal_id).filter(Boolean),
  )]
  if (!signalIds.length) return parsed

  const { data: sigRows } = await ctx.supabase
    .from('signals')
    .select('id, channel_id')
    .in('id', signalIds)
  const channelSignalIds = new Set(
    ((sigRows ?? []) as { id: string; channel_id: string | null }[])
      .filter(s => s.channel_id === signal.channel_id)
      .map(s => s.id),
  )
  if (!channelSignalIds.size) return parsed

  const symbols = new Set<string>()
  for (const row of openTrades as { symbol: string; signal_id: string }[]) {
    if (!channelSignalIds.has(row.signal_id)) continue
    const sym = row.symbol?.trim()
    if (sym) symbols.add(sym)
  }
  if (symbols.size !== 1) {
    if (symbols.size > 1) {
      await ctx.logSendSkipped(signal, broker, 're_enter_ambiguous_channel_symbols', {
        symbols: [...symbols],
        channel_id: signal.channel_id,
      })
    }
    return parsed
  }

  const resolvedSymbol = [...symbols][0]!
  return { ...parsed, symbol: resolvedSymbol }
}

export async function prepareEntryExecution(
  ctx: TradeExecutorContext,
  args: EntryArgs,
): Promise<PrepareEntryResult> {
  const { signal, op, broker, channelKeywords, pipelineT0, sendOpts } = args
  let parsed = args.parsed
  parsed = await resolveReEnterSymbolFromChannel(ctx, signal, broker, parsed)
  if (parsedHasReEnterIntent(parsed) && !parsed.symbol?.trim()) {
    await ctx.logSendSkipped(signal, broker, 're_enter_missing_symbol_context', {
      channel_id: signal.channel_id,
    })
    return { ok: false, outcome: {} }
  }
  const liveEntryFast = sendOpts?.liveEntryFast === true
  const commentPrefix = sendOpts?.commentPrefix ?? buildTscopierCommentPrefix(signal.id)
  if (!hasMetatraderApiConfigured()) return { ok: false, outcome: {} }
  const api = ctx.apiFor(broker)
  if (!api) return { ok: false, outcome: {} }
  const uuid = broker.metaapi_account_id!
  const signalSymbol = (parsed.symbol ?? '').trim()
  if (isExcluded(signalSymbol, broker)) {
    await ctx.logSendSkipped(signal, broker, 'symbol_exempted_from_trading', {
      signal_symbol: parsed.symbol ?? null,
      reason: 'symbols_exclude',
    })
    return { ok: false, outcome: {} }
  }

  const mapping = applySymbolMapping(parsed.symbol!, broker)

  if (broker.platform === 'MT4' && isMt5OnlyOperation(op)) {
    await ctx.logSendSkipped(signal, broker, 'mt4_unsupported_operation', { operation: op })
    return { ok: false, outcome: { finalizeSkipReason: 'mt4_unsupported_operation' } }
  }

  // Whitelist mode: when the user listed multiple symbols, only let signals
  // matching one of them through. Skip the signal otherwise.
  if (mapping.whitelist.length > 0) {
    const sig = (parsed.symbol ?? '').toUpperCase()
    if (!mapping.whitelist.includes(sig)) {
      await ctx.logSendSkipped(signal, broker, 'symbol_exempted_from_trading', {
        signal_symbol: parsed.symbol ?? null,
        allowed: mapping.whitelist,
      })
      return { ok: false, outcome: {} }
    }
  }

  const requestedSymbol = mapping.symbol

  const isManual = (broker.copier_mode ?? 'ai') === 'manual'
  const manual = (broker.manual_settings ?? {}) as ManualSettings

  const needsQuotePrefetch =
    isManual
    && signalEntryPriceStrictEnabled(manual)
    && parsedHasExplicitEntryAnchor(parsed)

  const stampOnResolve = liveEntryFast && !!signal.pipeline_ts
  const sessionPromise = (liveEntryFast
    ? ctx.ensureBrokerSessionLiveFast(api, uuid, broker)
    : ctx.ensureBrokerSession(api, uuid, broker, { force: true })
  ).then(r => {
    if (stampOnResolve && signal.pipeline_ts && signal.pipeline_ts.t_session_resolved == null) {
      signal.pipeline_ts.t_session_resolved = Date.now()
    }
    return r
  })
  const resolveOpts = { userDecorated: mapping.userDecorated }
  const symbolPromise = (liveEntryFast
    ? ctx.resolveBrokerSymbolForLiveEntry(uuid, requestedSymbol, resolveOpts)
    : ctx.resolveBrokerSymbol(uuid, requestedSymbol, resolveOpts)
  ).then(r => {
    if (stampOnResolve && signal.pipeline_ts && signal.pipeline_ts.t_symbol_resolved == null) {
      signal.pipeline_ts.t_symbol_resolved = Date.now()
    }
    return r
  })
  const [sessionOk, symbol] = await Promise.all([
    sessionPromise,
    symbolPromise,
  ])
  let params = await ctx.getSymbolParams(uuid, symbol).catch(() => null)
  if (stampOnResolve && signal.pipeline_ts && signal.pipeline_ts.t_params_resolved == null) {
    signal.pipeline_ts.t_params_resolved = Date.now()
  }
  if (liveEntryFast && signal.pipeline_ts && signal.pipeline_ts.t_send_caches_resolved == null) {
    signal.pipeline_ts.t_send_caches_resolved = Date.now()
  }
  if (!sessionOk) {
    await ctx.logSendSkipped(signal, broker, 'broker_session_not_connected', {
      symbol: requestedSymbol,
      metaapi_account_id: uuid,
      hint: MT_SESSION_EXPIRED_HINT,
    })
    return { ok: false, outcome: {} }
  }
  if (symbol.toUpperCase() !== requestedSymbol.toUpperCase()) {
    console.log(`[tradeExecutor] symbol resolved broker=${broker.id} ${requestedSymbol} → ${symbol}`)
  } else if (mapping.userDecorated && !params) {
    console.warn(
      `[tradeExecutor] user-decorated symbol params missing broker=${broker.id} symbol=${symbol}`,
    )
  }
  const baseLot = roundLot(computeLot(broker, parsed), params)

  let strictEntryPrefetch: { bid: number; ask: number } | null = null
  if (needsQuotePrefetch) {
    try {
      strictEntryPrefetch = await api.quote(uuid, symbol)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(
        `[tradeExecutor] /Quote prefetch failed ${symbol} signal=${signal.id} broker=${broker.id}: ${msg}`,
      )
    }
  }

  // Basket SL/TP refresh — always before OrderSend (not deferred to post-fill).
  let basketRefreshSucceeded = false
  if (isManual && shouldRouteAsBasketParameterRefresh(parsed)) {
    const messageEditOnly = sendOpts?.messageEditOnly === true
    const paramOutcome = await ctx.tryParameterFollowUpMergeModifyOnly({
      signal,
      parsed,
      broker,
      channelKeywords,
      baseLot,
      params,
      symbol,
      uuid,
      strictEntryPrefetch,
      commentPrefix,
      messageEditOnly,
    })
    if (messageEditOnly) {
      return {
        ok: false,
        outcome: {
          openedOrMerged: paramOutcome.handled === true && paramOutcome.success === true,
        },
      }
    }
    if (paramOutcome.handled && paramOutcome.success) {
      basketRefreshSucceeded = true
      return { ok: false, outcome: { openedOrMerged: true } }
    }
    if (paramOutcome.handled) {
      return { ok: false, outcome: { openedOrMerged: false } }
    }
  }

  // Stack-into-basket — before OrderSend on every path (not post-fill only).
  if (
    isManual
    && manual.add_new_trades_to_existing === true
    && !basketRefreshSucceeded
  ) {
    const mergeOutcome = await ctx.tryMergeSignalIntoExistingOpenTrade({
      signal,
      parsed,
      op,
      broker,
      channelKeywords,
      baseLot,
      params,
      symbol,
      uuid,
      strictEntryPrefetch,
      commentPrefix,
    })
    if (mergeOutcome.handled && mergeOutcome.success) {
      return { ok: false, outcome: { openedOrMerged: true } }
    }
  }

  if (!liveEntryFast) {
    if (isManual && manual.add_new_trades_to_existing === false && !parsedSignalHasExplicitStops(parsed)) {
      await ctx.logSendSkipped(signal, broker, 'explicit_stops_required_when_add_to_existing_off', { symbol })
      return { ok: false, outcome: { finalizeSkipReason: 'explicit_stops_required_when_add_to_existing_off' } }
    }

    if (isManual && manual.close_on_opposite_signal === true) {
      await ctx.closeOppositeDirectionTrades(signal, parsed, broker, symbol)
    }

    if (isManual && manual.add_new_trades_to_existing === false) {
      const already = await ctx.hasOpenTradeForSymbol(broker.id, symbol)
      if (already) {
        await ctx.logSendSkipped(signal, broker, 'add_new_trades_to_existing=false', { symbol })
        return { ok: false, outcome: { finalizeSkipReason: 'add_new_trades_to_existing=false' } }
      }
    }

    const newsPreFill = String(process.env.EXECUTOR_NEWS_BLACKOUT_PRE_FILL ?? 'false').toLowerCase()
    if (
      (newsPreFill === '1' || newsPreFill === 'true' || newsPreFill === 'yes')
      && isManual
      && !isNewsTradingEnabled(manual)
    ) {
      const events = await getCalendarEventsCached()
      const blackout = findActiveNewsBlackout(events, manual, symbol)
      if (blackout) {
        await ctx.logSendSkipped(signal, broker, 'filtered_news', {
          symbol,
          phase: blackout.phase,
          event: blackout.event.event,
          currency: blackout.event.currency,
        })
        return { ok: false, outcome: {} }
      }
    }
  }

  // Build the order list. In AI mode we keep the original single-order shape;
  // manual mode delegates to the planner so filters / multi-TP / pip-derived
  // SL & TP / pending expiry / reverse all apply consistently.
  let mergedChannelParams = false
  let entryChannelParams: ChannelActiveTradeParams | null = null
  let channelParamsRefreshedFromSignal = false
  let plan: PlannerResult
  if (isManual) {
    const rpe = resolvedParsedEntryPrice(parsed)
    const rzo = resolvedParsedEntryZone(parsed)
    let plannerParsed: PlannerParsedSignal = {
      action: parsed.action,
      symbol: parsed.symbol,
      entry_price: rpe,
      entry_zone_low: rzo?.lo ?? parsed.entry_zone_low,
      entry_zone_high: rzo?.hi ?? parsed.entry_zone_high,
      sl: parsed.sl,
      tp: parsed.tp,
      lot_size: parsed.lot_size,
      open_tp: parsed.open_tp,
      partial_close_fraction: parsed.partial_close_fraction,
      raw_instruction: parsed.raw_instruction,
    }
    if (signal.channel_id) {
      if (!liveEntryFast) {
        const resolved = await resolveEntryChannelStops(ctx.supabase, {
          userId: signal.user_id,
          channelId: signal.channel_id,
          brokerAccountId: broker.id,
          symbol,
          plannerParsed,
          signalId: signal.id,
        })
        plannerParsed = resolved.plannerParsed
        mergedChannelParams = resolved.mergedChannelParams
        entryChannelParams = resolved.channelParams
        channelParamsRefreshedFromSignal = parsedSignalHasExplicitStops(plannerParsed)
      } else if (parsedSignalHasExplicitStops(plannerParsed)) {
        entryChannelParams = await refreshChannelParamsFromSignal(ctx.supabase, {
          userId: signal.user_id,
          channelId: signal.channel_id,
          symbol,
          plannerParsed,
        })
        channelParamsRefreshedFromSignal = entryChannelParams != null
      }
    }
    plan = planManualOrders({
      parsed: plannerParsed,
      resolvedSymbol: symbol,
      baseOperation: op,
      manual,
      channelKeywords,
      manualLot: baseLot,
      ctx: {
        point: params?.point ?? 0.00001,
        digits: params?.digits ?? 5,
        minLot: params?.minLot ?? 0.01,
        lotStep: params?.lotStep ?? 0.01,
        contractSize: params?.contractSize ?? null,
        stopsLevel: params?.stopsLevel ?? 0,
        freezeLevel: params?.freezeLevel ?? 0,
        defaultLot: Number(broker.default_lot_size ?? 0.01),
        lastBalance: broker.last_balance ?? null,
        liveBid: strictEntryPrefetch?.bid,
        liveAsk: strictEntryPrefetch?.ask,
      },
      commentPrefix,
      expertId: 909090,
      slippage: 20,
    })
  } else {
    plan = {
      orders: [{
        symbol,
        operation: op,
        volume: baseLot,
        price: resolvedParsedEntryPrice(parsed) ?? 0,
        stoploss: parsed.sl ?? 0,
        takeprofit: parsed.tp?.[0] ?? 0,
        slippage: 20,
        comment: commentPrefix,
        expertID: 909090,
      }],
      delay_ms: 0,
    }
  }

  if (plan.orders.length === 0) {
    await ctx.logSendSkipped(signal, broker, plan.skip_reason ?? 'filtered', { symbol })
    const entryStrict =
      isManual && plan.skip_reason === SKIP_REASON_SIGNAL_ENTRY_REQUIRED
    return { ok: false, outcome: entryStrict ? { signalEntryRequiredSkip: true } : {} }
  }

  if (plan.fallback_reason) {
    // Non-fatal: the planner had to soften its strategy (e.g. multi → single because
    // the per-leg target was below minLot). Surface the reason in worker logs and
    // also persist it for the trades UI.
    console.warn(
      `[tradeExecutor] plan_fallback signal=${signal.id} broker=${broker.id} symbol=${symbol} reason=${plan.fallback_reason}`,
    )
    try {
      await ctx.supabase.from('trade_execution_logs').insert({
        user_id: signal.user_id,
        signal_id: signal.id,
        broker_account_id: broker.id,
        action: 'plan_fallback',
        status: 'success',
        request_payload: {
          reason: plan.fallback_reason,
          manual_lot: baseLot,
          target_leg: +(baseLot * ((Number(manual.multi_trade_leg_percent ?? 5)) / 100)).toFixed(4),
          min_lot: params?.minLot ?? null,
          lot_step: params?.lotStep ?? null,
          stops_level: params?.stopsLevel ?? null,
          freeze_level: params?.freezeLevel ?? null,
          symbol,
        } as unknown as Record<string, unknown>,
      })
    } catch {
      // Logging failure is non-fatal.
    }
  }

  const channelDelayMs = Math.max(0, plan.delay_ms)
  const channelDelaySkipped = liveEntryFast && channelDelayMs > 0
  if (channelDelayMs > 0) {
    if (liveEntryFast) {
      console.log(
        `[tradeExecutor] live fast: skipping channel delay_msec=${channelDelayMs} signal=${signal.id} broker=${broker.id}`,
      )
    } else {
      await new Promise(resolve => setTimeout(resolve, Math.min(channelDelayMs, 30_000)))
    }
  }

  // Hard cap: planner already respects 500; this is a final guard rail.
  const capped = plan.orders.slice(0, 500)
  if (capped.length < plan.orders.length) {
    console.warn(
      `[tradeExecutor] capped immediate legs ${plan.orders.length} → ${capped.length} signal=${signal.id} broker=${broker.id}`,
    )
  }
  let virtualPendings = (plan.virtualPendings ?? []).slice(0, 500)
  const totalPlannedLegCount = capped.length + virtualPendings.length
  if (
    virtualPendings.length > 0
    && signal.channel_id
    && entryChannelParams
    && (
      channelParamsRefreshedFromSignal
      || !shouldPreferSignalStopsOverChannelMemory(parsed)
    )
  ) {
    virtualPendings = applyChannelParamsToVirtualPendingList(
      virtualPendings,
      entryChannelParams,
      capped.length,
      manual.tp_lots,
      totalPlannedLegCount,
    )
  }

  const already = await ctx.manualDispatchAlreadyMaterialized(signal.id, broker.id)
  if (already) {
    console.warn(
      `[tradeExecutor] skip duplicate entry dispatch signal=${signal.id} broker=${broker.id}`,
    )
    return { ok: false, outcome: { openedOrMerged: true } }
  }

  // ── Strict signal entry (post-delay live quote) ───────────────────────
  // Buy: immediate market only when ask ≤ entry; else one virtual pending at entry.
  // Sell: immediate only when bid ≥ entry; else virtual at entry. Quote failure → defer.
  let strictDeferred = false
  if (isManual && plan.strictEntry && api) {
    const se = plan.strictEntry
    const pipTol = Math.max(0, Number(manual.signal_entry_pip_tolerance ?? 0))
    const pipSize = plan.pip ?? params?.point ?? 0.00001
    try {
      const q = strictEntryPrefetch ?? await api.quote(uuid, symbol)
      strictEntryPrefetch = q
      strictDeferred = !strictSignalEntryQuoteAllowsImmediate({
        isBuy: se.isBuy,
        entryPrice: se.entryPrice,
        bid: q.bid,
        ask: q.ask,
        tolerancePips: pipTol,
        pipSize,
      })
      if (strictDeferred) {
        console.log(
          `[tradeExecutor] strict entry deferred signal=${signal.id} broker=${broker.id} symbol=${symbol}`
          + ` entry=${se.entryPrice} isBuy=${se.isBuy} bid=${q.bid} ask=${q.ask}`,
        )
      }
    } catch (err) {
      strictDeferred = true
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(
        `[tradeExecutor] strict entry /Quote failed; deferring to broker pending signal=${signal.id} broker=${broker.id} symbol=${symbol}: ${msg}`,
      )
    }
  }

  const effectiveCapped = strictDeferred ? [] : capped

  if (!strictDeferred && plan.strictEntry) {
    for (const o of effectiveCapped) {
      if (o.operation === 'Buy' || o.operation === 'Sell') {
        o.price = 0
      }
    }
  }

  // Build immediate legs with rounded volumes. Immediates already carry the
  // planner's intended entry price (signal entry or zero for true market orders).
  //
  // The planner only ever emits a single-trade `partialTps` schedule when
  // `capped.length === 1` (single mode → one order). We attach it to that
  // single leg so the post-INSERT path can fan out the partials.
  const volumeRounded = effectiveCapped.map(o => ({ ...o, volume: roundLot(o.volume, params) }))
  let legs: Leg[] = volumeRounded.map((args, idx) => ({
    args,
    idx,
    ...(idx === 0 && plan.partialTps?.length ? { partialTps: plan.partialTps } : {}),
  }))

  // Single trade style: one broker order only (partials ride on partial_tp_legs).
  if (isManual && manual.trade_style !== 'multi' && legs.length > 1) {
    console.warn(
      `[tradeExecutor] single trade_style capping legs ${legs.length}→1 signal=${signal.id} broker=${broker.id}`,
    )
    legs = legs.slice(0, 1)
  }

  // ── Anchor resolution ────────────────────────────────────────────────
  // Priority: parsed signal entry → live /Quote (Ask for buy, Bid for sell).
  // Needed whenever we have virtual pendings to persist (so we can compute
  // trigger prices) OR Close-Worse-Entries is on (so we can compute the
  // single override TP). Strict broker pendings use the signal entry as the
  // clamp reference — no extra quote solely for that path.
  // The Quote is a ~50-150ms GET that we issue BEFORE sending immediates so every
  // leg + every virtual trigger sees the same deterministic reference price.
  // Live fast + immediate legs: defer virtual-only anchor work until after OrderSend.
  const deferVirtualAnchor = liveEntryFast
    && legs.length > 0
    && virtualPendings.length > 0
    && !plan.closeWorseEntries
  const needsAnchor = !deferVirtualAnchor
    && (virtualPendings.length > 0 || !!plan.closeWorseEntries)
  let anchor: number | null = plan.anchor?.value ?? plan.strictEntry?.entryPrice ?? null
  let anchorSource: 'signal' | 'quote' | 'unknown' = plan.anchor?.source ?? 'unknown'
  if (needsAnchor && (anchor == null || anchor <= 0)) {
    const parsedEntry = resolvedParsedEntryPrice(parsed)
    if (parsedEntry != null && parsedEntry > 0) {
      anchor = parsedEntry
      anchorSource = 'signal'
    } else if (api && !liveEntryFast) {
    try {
      const q = strictEntryPrefetch ?? await api.quote(uuid, symbol)
      if (!strictEntryPrefetch) strictEntryPrefetch = q
      anchor = plan.isBuy === false ? q.bid : q.ask
      anchorSource = 'quote'
      console.log(
        `[tradeExecutor] quote anchor signal=${signal.id} broker=${broker.id} symbol=${symbol} bid=${q.bid} ask=${q.ask} anchor=${anchor}`,
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(
        `[tradeExecutor] /Quote failed for ${symbol} signal=${signal.id} broker=${broker.id}: ${msg}`,
      )
    }
    } else if (api && liveEntryFast) {
      try {
        const q = strictEntryPrefetch ?? await api.quote(uuid, symbol)
        if (!strictEntryPrefetch) strictEntryPrefetch = q
        anchor = plan.isBuy === false ? q.bid : q.ask
        anchorSource = 'quote'
      } catch {
        /* virtual ladder may drop without anchor */
      }
    }
  }

  // Apply Close-Worse-Entries to immediate legs. As of May-12 this is a *worker-managed* close: the
  // broker never sees the threshold as a takeprofit (which produced
  // "Invalid stops" rejections whenever the basket was already in profit or
  // inside the stops/freeze zone). Instead we:
  //   1. Set takeprofit = 0 on the CWE-tagged leg's broker order so only
  //      the SL rides (the bucket TP is intentionally dropped — the user
  //      wants these worse entries to be exited by CWE, not by TP1/TP2/TP3).
  //   2. Stamp `cweClosePrice` on the leg / pending so the post-INSERT path
  //      writes it into `trades.cwe_close_price` / `range_pending_legs.cwe_close_price`.
  //   3. The new `cweCloseMonitor` polls /Quote and fires /OrderClose on
  //      every CWE-tagged open trade once the threshold is crossed.
  const overrideTp = computeCweTp(plan, anchor, params)
  if (overrideTp != null && plan.closeWorseEntries) {
    const nImm = Math.max(0, Math.min(legs.length, plan.closeWorseEntries.immediates))
    for (let i = 0; i < nImm; i++) {
      legs[i] = {
        ...legs[i]!,
        args: {
          ...legs[i]!.args,
          takeprofit: 0,
          comment: `${legs[i]!.args.comment ?? ''}.cw`,
        },
        cweClosePrice: overrideTp,
      }
    }
  }

  if (isManual) {
    // One-line plan summary so it's obvious whether Range Trading / CWE are
    // actually firing, and at which anchor. Helps debug "settings not applying".
    const point = Number(params?.point) || 0
    const stopsLevel = Number(params?.stopsLevel) || 0
    const freezeLevel = Number(params?.freezeLevel) || 0
    const pipValue = plan.pipQuote?.pipValuePerStdLot
    const contractSize = plan.pipQuote?.contractSize
    const quoteCcy = plan.pipQuote?.quoteCurrency ?? ''
    const partialCount = plan.partialTps?.length ?? 0
    console.log(
      `[tradeExecutor] manual plan signal=${signal.id} broker=${broker.id} symbol=${symbol}`
      + ` style=${manual.trade_style ?? 'single'} legs=${legs.length + virtualPendings.length}`
      + ` (immediate=${legs.length}, virtual_pending=${virtualPendings.length}${partialCount > 0 ? `, partial_tp=${partialCount}` : ''})`
      + ` rangeOn=${manual.range_trading === true} cwOn=${!!plan.closeWorseEntries}`
      + (overrideTp != null ? ` cweClose=${overrideTp}` : '')
      + ` pip=${plan.pip ?? 'n/a'}`
      + (pipValue != null ? ` pipValue=${pipValue.toFixed(4)}${quoteCcy ? '_' + quoteCcy : ''}/lot` : '')
      + (contractSize != null ? ` contractSize=${contractSize}` : '')
      + ` anchorSource=${anchorSource} anchor=${anchor ?? 'n/a'}`
      + ` stops_level=${stopsLevel} freeze_level=${freezeLevel} point=${point}`
      + (plan.fallback_reason ? ` fallback=${plan.fallback_reason}` : ''),
    )
  }


  return {
    ok: true,
    prep: {
      ctx,
      signal,
      parsed,
      broker,
      manual,
      api,
      uuid,
      symbol,
      requestedSymbol,
      mapping,
      params,
      liveEntryFast,
      pipelineT0,
      strictEntryPrefetch,
      commentPrefix,
      channelDelayMs,
      channelDelaySkipped,
      plan,
      capped,
      virtualPendings,
      legs,
      deferVirtualAnchor,
      strictDeferred,
      op,
      channelKeywords,
      baseLot,
      anchor,
      anchorSource,
      isManual,
    },
  }
}
