import { symbolsCompatibleForBasket } from '../../basketModFollowUp'
import { type BasketOpenLeg } from '../../basketSlTpReconcile'
import { parsedSignalHasExplicitStops } from '../../channelActiveTradeParams'
import { isChannelSlTpUpdateBlocked, normalizeChannelMessageFiltersMap } from '../../channelMessageFilters'
import {
  parsedHasExplicitEntryAnchor,
  signalEntryPriceStrictEnabled,
  type ChannelKeywords,
  type ManualSettings
} from '../../manualPlanner'
import { hasMetatraderApiConfigured, MtOperation } from '../../metatraderapi'
import {
  legacyMergeLinkingEnabled,
  filterSignalIdsByChannel,
  resolveOpenBasketAnchorForSameSignal,
  resolveOpenBasketAnchorForParameterFollowUp,
  shouldRouteAsBasketParameterRefresh
} from '../../multiTradeMerge'
import { MERGE_IMPLICIT_CHANNEL_BUNDLE_MS } from '../../signalMergeLink'
import { parsedHasReEnterIntent } from '../../signalPriceInference'
import { type TradeExecutorContext } from '../context'
import {
  type BrokerRow,
  type MergeOutcome,
  type ParsedSignal,
  type SignalRow,
  type SymbolCacheEntry
} from '../types'
import { reconcileGhostBasketLegs, loadMergeSignalForLinking, resolveBasketMergeLinkContext } from './helpers'
import { applyBasketSlTpRefresh } from './slTpRefresh'

export async function tryParameterFollowUpMergeModifyOnly(ctx: TradeExecutorContext, args: {
    signal: SignalRow
    parsed: ParsedSignal
    broker: BrokerRow
    channelKeywords: ChannelKeywords | null
    baseLot: number
    params: SymbolCacheEntry | null
    symbol: string
    uuid: string
    strictEntryPrefetch: { bid: number; ask: number } | null
    commentPrefix: string
    sameSignalRefresh?: boolean
  }): Promise<MergeOutcome> {
    const {
      signal, parsed, broker, channelKeywords, baseLot, params, symbol, uuid,
      strictEntryPrefetch, commentPrefix,
    } = args
    if (!hasMetatraderApiConfigured()) return { handled: false }
    if (parsedHasReEnterIntent(parsed)) return { handled: false }
    if (!shouldRouteAsBasketParameterRefresh(parsed) && args.sameSignalRefresh !== true) {
      return { handled: false }
    }
    const api = ctx.apiFor(broker)
    if (!api) return { handled: false }

    if (isChannelSlTpUpdateBlocked(
      normalizeChannelMessageFiltersMap(broker.channel_message_filters),
      signal.channel_id,
      parsed,
    )) {
      void ctx.supabase.from('trade_execution_logs').insert({
        user_id: signal.user_id,
        signal_id: signal.id,
        broker_account_id: broker.id,
        action: 'merge_routed_modify_only',
        status: 'skipped',
        request_payload: {
          skip_reason: 'channel_filter_ignored',
          channel_id: signal.channel_id,
          symbol,
        } as unknown as Record<string, unknown>,
      }).then(() => undefined, () => undefined)
      return { handled: true, success: false }
    }

    const a = String(parsed.action ?? '').toLowerCase()
    if (a !== 'buy' && a !== 'sell') return { handled: false }
    const direction = a === 'buy' ? 'buy' : 'sell'
    const sameSignalRefresh = args.sameSignalRefresh === true

    let anchor = sameSignalRefresh
      ? await resolveOpenBasketAnchorForSameSignal(ctx.supabase, {
          userId: signal.user_id,
          brokerAccountId: broker.id,
          signalId: signal.id,
          brokerSymbol: symbol,
          signalSymbol: parsed.symbol,
          direction,
          channelId: signal.channel_id,
        })
      : null
    if (!anchor) {
      anchor = await resolveOpenBasketAnchorForParameterFollowUp(ctx.supabase, {
        userId: signal.user_id,
        brokerAccountId: broker.id,
        brokerSymbol: symbol,
        signalSymbol: parsed.symbol,
        direction,
        channelId: signal.channel_id,
      }, {
        currentSignalId: signal.id,
        currentSignalCreatedAt: signal.created_at ?? null,
      })
    }
    if (!anchor) {
      // Fire-and-forget: this is a diagnostic-only log on the live-entry hot
      // path; awaiting it adds ~50–150 ms to send_plan_ms for no functional
      // benefit. Errors are tolerated silently (best-effort).
      void ctx.supabase.from('trade_execution_logs').insert({
        user_id: signal.user_id,
        signal_id: signal.id,
        broker_account_id: broker.id,
        action: 'merge_routed_modify_only',
        status: 'skipped',
        request_payload: {
          skip_reason: 'parameter_follow_up_no_open_basket',
          symbol,
          direction,
          channel_id: signal.channel_id,
        } as unknown as Record<string, unknown>,
      }).then(() => undefined, () => undefined)
      return { handled: false }
    }

    const openLegDeadline = Date.now() + 3_000
    while (Date.now() < openLegDeadline) {
      const { count } = await ctx.supabase
        .from('trades')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', signal.user_id)
        .eq('broker_account_id', broker.id)
        .eq('signal_id', anchor.anchorSignalId)
        .eq('status', 'open')
        .eq('direction', direction)
      if ((count ?? 0) > 0) break
      await new Promise(resolve => setTimeout(resolve, 150))
    }

    const mergeSignal = await loadMergeSignalForLinking(ctx, signal)
    const link = await resolveBasketMergeLinkContext(ctx, {
      mergeSignal,
      anchorSignalId: anchor.anchorSignalId,
      newestTradeOpenedAt: anchor.newestOpenedAt,
      parsed,
    })
    // Parameter follow-up (modify-only) must be explicitly linked by reply/thread/parent.
    // Exception: when add_new_trades_to_existing=false, the strategy is "single slot";
    // a same-direction signal carrying explicit stops should refresh that live slot.
    const manual = (broker.manual_settings ?? {}) as ManualSettings
    const sameSignalRevision =
      sameSignalRefresh && anchor.anchorSignalId === signal.id
    const allowUnlinkedRefresh =
      sameSignalRevision
      || (manual.add_new_trades_to_existing === false && parsedSignalHasExplicitStops(parsed))
      || link.parameterRefreshSameChannel
      || (link.implicitBundleWithinTightWindow && link.implicitSameChannelBundle && parsedSignalHasExplicitStops(parsed))
    if (!sameSignalRevision) {
      if (!link.replyOk && !link.threadLinksAnchor && !link.parentLinksAnchor && !allowUnlinkedRefresh) {
        void ctx.supabase.from('trade_execution_logs').insert({
          user_id: signal.user_id,
          signal_id: signal.id,
          broker_account_id: broker.id,
          action: 'merge_routed_modify_only',
          status: 'skipped',
          request_payload: {
            skip_reason: 'parameter_follow_up_requires_explicit_link',
            symbol,
            direction,
            channel_id: signal.channel_id,
            anchor_signal_id: anchor.anchorSignalId,
            dt_ms: link.dtMs,
          } as unknown as Record<string, unknown>,
        }).then(() => undefined, () => undefined)
        return { handled: false }
      }
      if (!link.isLinked) {
        void ctx.supabase.from('trade_execution_logs').insert({
          user_id: signal.user_id,
          signal_id: signal.id,
          broker_account_id: broker.id,
          action: 'merge_routed_modify_only',
          status: 'skipped',
          request_payload: {
            skip_reason: 'parameter_follow_up_not_linked',
            symbol,
            direction,
            channel_id: signal.channel_id,
            anchor_signal_id: anchor.anchorSignalId,
            dt_ms: link.dtMs,
          } as unknown as Record<string, unknown>,
        }).then(() => undefined, () => undefined)
        return { handled: false }
      }
    }

    console.log(
      `[tradeExecutor] merge_anchor_selected signal=${signal.id} broker=${broker.id}`
      + ` anchor=${anchor.anchorSignalId} symbol=${symbol} direction=${direction}`,
    )

    try {
      await ctx.supabase.from('trade_execution_logs').insert({
        user_id: signal.user_id,
        signal_id: signal.id,
        broker_account_id: broker.id,
        action: 'merge_anchor_selected',
        status: 'success',
        request_payload: {
          anchor_signal_id: anchor.anchorSignalId,
          symbol,
          direction,
          channel_id: signal.channel_id,
          newest_opened_at: anchor.newestOpenedAt,
        } as unknown as Record<string, unknown>,
      })
    } catch { /* best-effort */ }

    const { data: anchorFamilyRows } = await ctx.supabase
      .from('trades')
      .select('id,signal_id,metaapi_order_id,opened_at,lot_size,sl,tp,entry_price,direction,symbol')
      .eq('broker_account_id', broker.id)
      .eq('signal_id', anchor.anchorSignalId)
      .eq('status', 'open')
      .order('opened_at', { ascending: true })
      .limit(500)
    const anchorFamily = ((anchorFamilyRows ?? []) as BasketOpenLeg[]).filter(tr =>
      symbolsCompatibleForBasket(parsed.symbol ?? symbol, tr.symbol)
      || symbolsCompatibleForBasket(symbol, tr.symbol),
    )
    const ghostCheck = await reconcileGhostBasketLegs(ctx, {
      signal,
      broker,
      uuid,
      anchorSignalId: anchor.anchorSignalId,
      symbol,
      familyTrades: anchorFamily,
    })
    if (ghostCheck.isGhostBasket) {
      return { handled: false }
    }

    const outcome = await applyBasketSlTpRefresh(ctx, {
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
      anchorSignalId: anchor.anchorSignalId,
      direction,
      logAction: 'merge_routed_modify_only',
      sameSignalRefresh: args.sameSignalRefresh === true,
      mergeLinkMeta: {
        reply_chain: link.replyOk,
        within_time_window: link.withinWindow,
        parent_links_anchor: link.parentLinksAnchor,
        thread_links_anchor: link.threadLinksAnchor,
        implicit_bundle_within_tight_window: link.implicitBundleWithinTightWindow,
        implicit_same_channel_bundle: link.implicitSameChannelBundle,
        parameter_refresh_same_channel: link.parameterRefreshSameChannel,
        same_signal_refresh: sameSignalRevision,
        implicit_bundle_dt_ms: link.dtMs,
        merge_implicit_tight_window_ms: MERGE_IMPLICIT_CHANNEL_BUNDLE_MS,
        legacy_merge_linking: legacyMergeLinkingEnabled(),
      },
    })
    return { handled: true, success: outcome.success }
  }

export async function tryMergeSignalIntoExistingOpenTrade(ctx: TradeExecutorContext, args: {
    signal: SignalRow
    parsed: ParsedSignal
    op: MtOperation
    broker: BrokerRow
    channelKeywords: ChannelKeywords | null
    baseLot: number
    params: SymbolCacheEntry | null
    symbol: string
    uuid: string
    strictEntryPrefetch: { bid: number; ask: number } | null
    commentPrefix: string
  }): Promise<MergeOutcome> {
    const {
      signal, parsed, op, broker, channelKeywords, baseLot, params, symbol, uuid,
      strictEntryPrefetch, commentPrefix,
    } = args
    if (!hasMetatraderApiConfigured()) return { handled: false }
    const api = ctx.apiFor(broker)
    if (!api) return { handled: false }
    if (parsedHasReEnterIntent(parsed)) return { handled: false }
    const manual = (broker.manual_settings ?? {}) as ManualSettings
    if (manual.add_new_trades_to_existing !== true) return { handled: false }
    if (signalEntryPriceStrictEnabled(manual) && !parsedHasExplicitEntryAnchor(parsed)) {
      return { handled: false }
    }

    const a = String(parsed.action ?? '').toLowerCase()
    if (a !== 'buy' && a !== 'sell') return { handled: false }
    const direction = a === 'buy' ? 'buy' : 'sell'

    const mergeSignal = await loadMergeSignalForLinking(ctx, signal)

    const { data: openDesc, error: openErr } = await ctx.supabase
      .from('trades')
      .select('id,signal_id,metaapi_order_id,opened_at,lot_size,sl,tp,entry_price,direction')
      .eq('broker_account_id', broker.id)
      .eq('symbol', symbol)
      .eq('status', 'open')
      .eq('direction', direction)
      .order('opened_at', { ascending: false })
      .limit(64)
    if (openErr || !openDesc?.length) return { handled: false }

    type OpenLeg = (typeof openDesc)[0]
    let channelOpenLegs = openDesc as OpenLeg[]
    if (signal.channel_id) {
      const allowedSignalIds = await filterSignalIdsByChannel(
        ctx.supabase,
        signal.user_id,
        signal.channel_id,
        channelOpenLegs.map(t => t.signal_id).filter(Boolean),
      )
      channelOpenLegs = channelOpenLegs.filter(t => allowedSignalIds.has(t.signal_id))
    }
    if (!channelOpenLegs.length) return { handled: false }

    channelOpenLegs.sort(
      (a, b) => new Date(b.opened_at).getTime() - new Date(a.opened_at).getTime(),
    )
    const newest = channelOpenLegs[0] as OpenLeg
    const anchorSignalId = newest.signal_id
    if (!anchorSignalId) return { handled: false }

    const familyTrades = channelOpenLegs
      .filter(t => t.signal_id === anchorSignalId)
      .sort((a, b) => new Date(a.opened_at).getTime() - new Date(b.opened_at).getTime())
    if (!familyTrades.length) return { handled: false }

    const ghostCheck = await reconcileGhostBasketLegs(ctx, {
      signal,
      broker,
      uuid,
      anchorSignalId,
      symbol,
      familyTrades: familyTrades as BasketOpenLeg[],
    })
    if (ghostCheck.isGhostBasket) return { handled: false }

    const link = await resolveBasketMergeLinkContext(ctx, {
      mergeSignal,
      anchorSignalId,
      newestTradeOpenedAt: newest.opened_at,
      parsed,
    })
    if (!link.isLinked) {
      console.warn(
        `[tradeExecutor] merge not linked signal=${signal.id} broker=${broker.id} symbol=${symbol}`
        + ` reply=${link.replyOk} window=${link.withinWindow} thread=${link.threadLinksAnchor}`
        + ` implicit=${link.implicitSameChannelBundle} paramRefresh=${link.parameterRefreshSameChannel}`
        + ` dt_ms=${link.dtMs}`,
      )
      return { handled: false }
    }

    const refresh = await applyBasketSlTpRefresh(ctx, {
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
      anchorSignalId,
      direction,
      logAction: 'signal_merge_into_open_trade',
      mergeLinkMeta: {
        reply_chain: link.replyOk,
        within_time_window: link.withinWindow,
        parent_links_anchor: link.parentLinksAnchor,
        has_reply_to_telegram: Boolean(String(mergeSignal.reply_to_message_id ?? '').trim()),
        thread_links_anchor: link.threadLinksAnchor,
        implicit_bundle_within_tight_window: link.implicitBundleWithinTightWindow,
        implicit_same_channel_bundle: link.implicitSameChannelBundle,
        parameter_refresh_same_channel: link.parameterRefreshSameChannel,
        implicit_bundle_dt_ms: link.dtMs,
        merge_implicit_tight_window_ms: MERGE_IMPLICIT_CHANNEL_BUNDLE_MS,
        legacy_merge_linking: legacyMergeLinkingEnabled(),
      },
    })
    return { handled: true, success: refresh.success }
  }
