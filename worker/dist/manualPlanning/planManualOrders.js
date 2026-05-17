"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.planManualOrders = planManualOrders;
const manualStops_1 = require("./manualStops");
const executionShape_1 = require("./executionShape");
const manualSettings_1 = require("./manualSettings");
const parsedEntry_1 = require("./parsedEntry");
const planMultiManualOrders_1 = require("./planMultiManualOrders");
const planSingleManualOrders_1 = require("./planSingleManualOrders");
function withinTimeWindow(start, end, now) {
    const toMinutes = (s) => {
        const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
        if (!m)
            return null;
        const h = Number(m[1]);
        const mm = Number(m[2]);
        if (!Number.isFinite(h) || !Number.isFinite(mm))
            return null;
        return h * 60 + mm;
    };
    const s = toMinutes(start);
    const e = toMinutes(end);
    if (s == null || e == null)
        return true;
    const cur = now.getHours() * 60 + now.getMinutes();
    if (s <= e)
        return cur >= s && cur <= e;
    return cur >= s || cur <= e;
}
/** Build the order plan. Returns an empty plan with skip_reason when filtered out. */
function planManualOrders(args) {
    const { parsed, resolvedSymbol, baseOperation, manual, channelKeywords, manualLot, ctx, commentPrefix, expertId, slippage, } = args;
    const now = ctx.now ?? new Date();
    const delay_ms = Math.max(0, Number(channelKeywords?.additional?.delay_msec ?? 0) | 0);
    if (manual.days_filter_enabled) {
        const allowed = (manual.trade_days ?? [0, 1, 2, 3, 4, 5, 6]).map(Number);
        if (!allowed.includes(now.getDay())) {
            return { orders: [], skip_reason: 'filtered_day', delay_ms };
        }
    }
    if (manual.time_filter_enabled && manual.trade_start_time && manual.trade_end_time) {
        if (!withinTimeWindow(manual.trade_start_time, manual.trade_end_time, now)) {
            return { orders: [], skip_reason: 'filtered_time', delay_ms };
        }
    }
    if ((0, manualSettings_1.signalEntryPriceStrictEnabled)(manual) && !(0, parsedEntry_1.parsedHasExplicitEntryAnchor)(parsed)) {
        return { orders: [], skip_reason: parsedEntry_1.SKIP_REASON_SIGNAL_ENTRY_REQUIRED, delay_ms };
    }
    let entry = (0, parsedEntry_1.resolvedParsedEntryPrice)(parsed);
    if (entry == null) {
        const z = (0, parsedEntry_1.resolvedParsedEntryZone)(parsed);
        if (z) {
            const prefer = channelKeywords?.additional?.prefer_entry ?? 'first_price';
            entry = prefer === 'last_price' ? z.hi : z.lo;
        }
    }
    const entryOk = entry != null && Number.isFinite(entry) && entry > 0;
    const entryAnchorFromSignal = entryOk ? entry : null;
    const effectiveReverse = manual.reverse_signal === true && (0, manualStops_1.reverseSignalGateSatisfied)(manual, entryAnchorFromSignal);
    const opSplit = effectiveReverse ? (0, executionShape_1.flipOperation)(baseOperation) : baseOperation;
    const isBuy = opSplit.startsWith('Buy');
    let entryAnchor = entryAnchorFromSignal;
    if (entryAnchor == null
        && (manual.use_predefined_sl_pips === true || manual.use_predefined_tp_pips === true)) {
        const ask = ctx.liveAsk;
        const bid = ctx.liveBid;
        if (isBuy && typeof ask === 'number' && Number.isFinite(ask) && ask > 0)
            entryAnchor = ask;
        else if (!isBuy && typeof bid === 'number' && Number.isFinite(bid) && bid > 0)
            entryAnchor = bid;
    }
    const { pipQuote, pip, finalSl, finalTps, minStopDist, roundPrice } = (0, manualStops_1.deriveManualStopsWithClamp)({
        parsed,
        manual,
        channelKeywords,
        resolvedSymbol,
        ctx,
        entryAnchor,
        isBuy,
    });
    const manualStrict = (0, manualSettings_1.signalEntryPriceStrictEnabled)(manual);
    const hasExplicitEntry = (0, parsedEntry_1.parsedHasExplicitEntryAnchor)(parsed);
    const { orderBase, expirationFields, strictEntry } = (0, executionShape_1.resolveOpExecAndStrict)({
        opSplit,
        isBuy,
        entryAnchor,
        manualStrict,
        hasExplicitEntry,
        roundPrice,
        resolvedSymbol,
        commentPrefix,
        expertId,
        slippage,
        now,
        pendingExpiryRaw: manual.pending_expiry_hours,
    });
    const tradeStyle = manual.trade_style === 'multi' ? 'multi' : 'single';
    const singleShared = {
        orderBase,
        expirationFields,
        strictEntry,
        manualLot,
        finalSl,
        finalTps,
        manual,
        ctx,
        delay_ms,
        entryAnchor,
        isBuy,
        pip,
        pipQuote,
        roundPrice,
    };
    if (tradeStyle !== 'multi') {
        return (0, planSingleManualOrders_1.planSingleManualOrders)(singleShared);
    }
    return (0, planMultiManualOrders_1.planMultiManualOrders)({
        ...singleShared,
        commentPrefix,
        expertId,
        slippage,
        minStopDist,
        buildSingleOrder: planSingleManualOrders_1.planSingleManualOrders,
    });
}
