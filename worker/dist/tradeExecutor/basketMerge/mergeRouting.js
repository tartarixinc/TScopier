"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.tryParameterFollowUpMergeModifyOnly = tryParameterFollowUpMergeModifyOnly;
exports.tryMergeSignalIntoExistingOpenTrade = tryMergeSignalIntoExistingOpenTrade;
const basketModFollowUp_1 = require("../../basketModFollowUp");
const channelActiveTradeParams_1 = require("../../channelActiveTradeParams");
const channelMessageFilters_1 = require("../../channelMessageFilters");
const manualPlanner_1 = require("../../manualPlanner");
const metatraderapi_1 = require("../../metatraderapi");
const multiTradeMerge_1 = require("../../multiTradeMerge");
const signalMergeLink_1 = require("../../signalMergeLink");
const signalPriceInference_1 = require("../../signalPriceInference");
const helpers_1 = require("./helpers");
const slTpRefresh_1 = require("./slTpRefresh");
async function tryParameterFollowUpMergeModifyOnly(ctx, args) {
    const { signal, parsed, broker, channelKeywords, baseLot, params, symbol, uuid, strictEntryPrefetch, commentPrefix, } = args;
    if (!(0, metatraderapi_1.hasMetatraderApiConfigured)())
        return { handled: false };
    if ((0, signalPriceInference_1.parsedHasReEnterIntent)(parsed))
        return { handled: false };
    if (!(0, multiTradeMerge_1.shouldRouteAsBasketParameterRefresh)(parsed) && args.messageEditOnly !== true) {
        return { handled: false };
    }
    const api = ctx.apiFor(broker);
    if (!api)
        return { handled: false };
    if ((0, channelMessageFilters_1.isChannelSlTpUpdateBlocked)((0, channelMessageFilters_1.normalizeChannelMessageFiltersMap)(broker.channel_message_filters), signal.channel_id, parsed)) {
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
            },
        }).then(() => undefined, () => undefined);
        return { handled: true, success: false };
    }
    const a = String(parsed.action ?? '').toLowerCase();
    if (a !== 'buy' && a !== 'sell')
        return { handled: false };
    const direction = a === 'buy' ? 'buy' : 'sell';
    const messageEditOnly = args.messageEditOnly === true;
    let anchor = messageEditOnly
        ? await (0, multiTradeMerge_1.resolveOpenBasketAnchorForMessageEdit)(ctx.supabase, {
            userId: signal.user_id,
            brokerAccountId: broker.id,
            signalId: signal.id,
            brokerSymbol: symbol,
            signalSymbol: parsed.symbol,
            direction,
            channelId: signal.channel_id,
        })
        : null;
    if (!anchor) {
        anchor = await (0, multiTradeMerge_1.resolveOpenBasketAnchorForParameterFollowUp)(ctx.supabase, {
            userId: signal.user_id,
            brokerAccountId: broker.id,
            brokerSymbol: symbol,
            signalSymbol: parsed.symbol,
            direction,
            channelId: signal.channel_id,
        }, {
            currentSignalId: signal.id,
            currentSignalCreatedAt: signal.created_at ?? null,
        });
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
            },
        }).then(() => undefined, () => undefined);
        return { handled: false };
    }
    const openLegDeadline = Date.now() + 3000;
    while (Date.now() < openLegDeadline) {
        const { count } = await ctx.supabase
            .from('trades')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', signal.user_id)
            .eq('broker_account_id', broker.id)
            .eq('signal_id', anchor.anchorSignalId)
            .eq('status', 'open')
            .eq('direction', direction);
        if ((count ?? 0) > 0)
            break;
        await new Promise(resolve => setTimeout(resolve, 150));
    }
    const mergeSignal = await (0, helpers_1.loadMergeSignalForLinking)(ctx, signal);
    const link = await (0, helpers_1.resolveBasketMergeLinkContext)(ctx, {
        mergeSignal,
        anchorSignalId: anchor.anchorSignalId,
        newestTradeOpenedAt: anchor.newestOpenedAt,
        parsed,
    });
    // Parameter follow-up (modify-only) must be explicitly linked by reply/thread/parent.
    // Exception: when add_new_trades_to_existing=false, the strategy is "single slot";
    // a same-direction signal carrying explicit stops should refresh that live slot.
    const manual = (broker.manual_settings ?? {});
    const sameSignalMessageEdit = messageEditOnly && anchor.anchorSignalId === signal.id;
    const allowUnlinkedRefresh = sameSignalMessageEdit
        || (manual.add_new_trades_to_existing === false && (0, channelActiveTradeParams_1.parsedSignalHasExplicitStops)(parsed))
        || link.parameterRefreshSameChannel
        || (link.implicitBundleWithinTightWindow && link.implicitSameChannelBundle && (0, channelActiveTradeParams_1.parsedSignalHasExplicitStops)(parsed));
    if (!sameSignalMessageEdit) {
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
                },
            }).then(() => undefined, () => undefined);
            return { handled: false };
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
                },
            }).then(() => undefined, () => undefined);
            return { handled: false };
        }
    }
    console.log(`[tradeExecutor] merge_anchor_selected signal=${signal.id} broker=${broker.id}`
        + ` anchor=${anchor.anchorSignalId} symbol=${symbol} direction=${direction}`);
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
            },
        });
    }
    catch { /* best-effort */ }
    const { data: anchorFamilyRows } = await ctx.supabase
        .from('trades')
        .select('id,signal_id,metaapi_order_id,opened_at,lot_size,sl,tp,entry_price,direction,symbol')
        .eq('broker_account_id', broker.id)
        .eq('signal_id', anchor.anchorSignalId)
        .eq('status', 'open')
        .order('opened_at', { ascending: true })
        .limit(500);
    const anchorFamily = (anchorFamilyRows ?? []).filter(tr => (0, basketModFollowUp_1.symbolsCompatibleForBasket)(parsed.symbol ?? symbol, tr.symbol)
        || (0, basketModFollowUp_1.symbolsCompatibleForBasket)(symbol, tr.symbol));
    const ghostCheck = await (0, helpers_1.reconcileGhostBasketLegs)(ctx, {
        signal,
        broker,
        uuid,
        anchorSignalId: anchor.anchorSignalId,
        symbol,
        familyTrades: anchorFamily,
    });
    if (ghostCheck.isGhostBasket) {
        return { handled: false };
    }
    const outcome = await (0, slTpRefresh_1.applyBasketSlTpRefresh)(ctx, {
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
        messageEditOnly: args.messageEditOnly === true,
        mergeLinkMeta: {
            reply_chain: link.replyOk,
            within_time_window: link.withinWindow,
            parent_links_anchor: link.parentLinksAnchor,
            thread_links_anchor: link.threadLinksAnchor,
            implicit_bundle_within_tight_window: link.implicitBundleWithinTightWindow,
            implicit_same_channel_bundle: link.implicitSameChannelBundle,
            parameter_refresh_same_channel: link.parameterRefreshSameChannel,
            message_edit_same_signal: sameSignalMessageEdit,
            implicit_bundle_dt_ms: link.dtMs,
            merge_implicit_tight_window_ms: signalMergeLink_1.MERGE_IMPLICIT_CHANNEL_BUNDLE_MS,
            legacy_merge_linking: (0, multiTradeMerge_1.legacyMergeLinkingEnabled)(),
        },
    });
    return { handled: true, success: outcome.success };
}
async function tryMergeSignalIntoExistingOpenTrade(ctx, args) {
    const { signal, parsed, op, broker, channelKeywords, baseLot, params, symbol, uuid, strictEntryPrefetch, commentPrefix, } = args;
    if (!(0, metatraderapi_1.hasMetatraderApiConfigured)())
        return { handled: false };
    const api = ctx.apiFor(broker);
    if (!api)
        return { handled: false };
    if ((0, signalPriceInference_1.parsedHasReEnterIntent)(parsed))
        return { handled: false };
    const manual = (broker.manual_settings ?? {});
    if (manual.add_new_trades_to_existing !== true)
        return { handled: false };
    if ((0, manualPlanner_1.signalEntryPriceStrictEnabled)(manual) && !(0, manualPlanner_1.parsedHasExplicitEntryAnchor)(parsed)) {
        return { handled: false };
    }
    const a = String(parsed.action ?? '').toLowerCase();
    if (a !== 'buy' && a !== 'sell')
        return { handled: false };
    const direction = a === 'buy' ? 'buy' : 'sell';
    const mergeSignal = await (0, helpers_1.loadMergeSignalForLinking)(ctx, signal);
    const { data: openDesc, error: openErr } = await ctx.supabase
        .from('trades')
        .select('id,signal_id,metaapi_order_id,opened_at,lot_size,sl,tp,entry_price,direction')
        .eq('broker_account_id', broker.id)
        .eq('symbol', symbol)
        .eq('status', 'open')
        .eq('direction', direction)
        .order('opened_at', { ascending: false })
        .limit(64);
    if (openErr || !openDesc?.length)
        return { handled: false };
    let channelOpenLegs = openDesc;
    if (signal.channel_id) {
        const allowedSignalIds = await (0, multiTradeMerge_1.filterSignalIdsByChannel)(ctx.supabase, signal.user_id, signal.channel_id, channelOpenLegs.map(t => t.signal_id).filter(Boolean));
        channelOpenLegs = channelOpenLegs.filter(t => allowedSignalIds.has(t.signal_id));
    }
    if (!channelOpenLegs.length)
        return { handled: false };
    channelOpenLegs.sort((a, b) => new Date(b.opened_at).getTime() - new Date(a.opened_at).getTime());
    const newest = channelOpenLegs[0];
    const anchorSignalId = newest.signal_id;
    if (!anchorSignalId)
        return { handled: false };
    const familyTrades = channelOpenLegs
        .filter(t => t.signal_id === anchorSignalId)
        .sort((a, b) => new Date(a.opened_at).getTime() - new Date(b.opened_at).getTime());
    if (!familyTrades.length)
        return { handled: false };
    const ghostCheck = await (0, helpers_1.reconcileGhostBasketLegs)(ctx, {
        signal,
        broker,
        uuid,
        anchorSignalId,
        symbol,
        familyTrades: familyTrades,
    });
    if (ghostCheck.isGhostBasket)
        return { handled: false };
    const link = await (0, helpers_1.resolveBasketMergeLinkContext)(ctx, {
        mergeSignal,
        anchorSignalId,
        newestTradeOpenedAt: newest.opened_at,
        parsed,
    });
    if (!link.isLinked) {
        console.warn(`[tradeExecutor] merge not linked signal=${signal.id} broker=${broker.id} symbol=${symbol}`
            + ` reply=${link.replyOk} window=${link.withinWindow} thread=${link.threadLinksAnchor}`
            + ` implicit=${link.implicitSameChannelBundle} paramRefresh=${link.parameterRefreshSameChannel}`
            + ` dt_ms=${link.dtMs}`);
        return { handled: false };
    }
    const refresh = await (0, slTpRefresh_1.applyBasketSlTpRefresh)(ctx, {
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
            merge_implicit_tight_window_ms: signalMergeLink_1.MERGE_IMPLICIT_CHANNEL_BUNDLE_MS,
            legacy_merge_linking: (0, multiTradeMerge_1.legacyMergeLinkingEnabled)(),
        },
    });
    return { handled: true, success: refresh.success };
}
