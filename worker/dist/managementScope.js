"use strict";
/**
 * Scope resolution for channel management instructions (close half, modify SL, etc.).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isReplyScopedManagement = isReplyScopedManagement;
exports.explicitMgmtSymbol = explicitMgmtSymbol;
exports.mgmtHasPriceLevels = mgmtHasPriceLevels;
exports.filterTradesBySymbolFilter = filterTradesBySymbolFilter;
exports.filterTradesByPlausibleMgmtLevels = filterTradesByPlausibleMgmtLevels;
exports.resolveNewestOpenSymbolTrades = resolveNewestOpenSymbolTrades;
exports.loadOpenTradesForManagement = loadOpenTradesForManagement;
exports.resolveChannelModifyTargets = resolveChannelModifyTargets;
const basketModFollowUp_1 = require("./basketModFollowUp");
const signalPip_1 = require("./signalPip");
const tradableSymbol_1 = require("./tradableSymbol");
const MAX_PLAUSIBLE_PIPS = 500;
function isReplyScopedManagement(signal) {
    return Boolean(String(signal.reply_to_message_id ?? '').trim());
}
/** Symbol from instruction text only — never inherit from a parent signal. */
function explicitMgmtSymbol(parsed) {
    return (0, tradableSymbol_1.sanitizeParsedSymbol)(parsed.symbol);
}
function mgmtHasPriceLevels(parsed) {
    const hasSl = typeof parsed.sl === 'number' && Number.isFinite(parsed.sl) && parsed.sl > 0;
    const hasTp = (parsed.tp ?? []).some(t => typeof t === 'number' && Number.isFinite(t) && t > 0);
    return hasSl || hasTp;
}
function tradeMatchesSymbolFilter(trade, symbolFilter) {
    return (0, basketModFollowUp_1.symbolsCompatibleForBasket)(symbolFilter, trade.symbol);
}
function filterTradesBySymbolFilter(trades, symbolFilter) {
    const sym = symbolFilter?.trim();
    if (!sym)
        return trades;
    return trades.filter(t => tradeMatchesSymbolFilter(t, sym));
}
function normSymbolKey(sym) {
    return String(sym ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}
/** Bucket open legs by compatible broker symbol. */
function groupTradesBySymbolBucket(trades) {
    const buckets = new Map();
    for (const tr of trades) {
        const key = normSymbolKey(tr.symbol);
        let hit = null;
        for (const existing of buckets.keys()) {
            if ((0, basketModFollowUp_1.symbolsCompatibleForBasket)(existing, tr.symbol)) {
                hit = existing;
                break;
            }
        }
        const k = hit ?? key;
        const list = buckets.get(k) ?? [];
        list.push(tr);
        buckets.set(k, list);
    }
    return buckets;
}
function referencePriceForBucket(rows) {
    for (const r of rows) {
        const ep = r.entry_price;
        if (typeof ep === 'number' && Number.isFinite(ep) && ep > 0)
            return ep;
    }
    return null;
}
function levelPlausibleForBucket(rows, parsed) {
    const ref = referencePriceForBucket(rows);
    if (ref == null)
        return false;
    const sample = rows[0];
    const pip = (0, signalPip_1.signalPipPrice)(sample?.symbol ?? parsed.symbol ?? 'EURUSD');
    if (!(pip > 0))
        return false;
    const maxDist = MAX_PLAUSIBLE_PIPS * pip;
    const isBuy = rows.every(r => String(r.direction).toLowerCase() === 'buy');
    const isSell = rows.every(r => String(r.direction).toLowerCase() === 'sell');
    if (!isBuy && !isSell)
        return false;
    const sl = typeof parsed.sl === 'number' && parsed.sl > 0 ? parsed.sl : null;
    const tp0 = (parsed.tp ?? []).find(t => typeof t === 'number' && t > 0);
    const levelOk = (level, kind) => {
        if (Math.abs(level - ref) > maxDist)
            return false;
        if (isBuy) {
            if (kind === 'sl')
                return level < ref;
            return level > ref;
        }
        if (kind === 'sl')
            return level > ref;
        return level < ref;
    };
    if (sl != null && !levelOk(sl, 'sl'))
        return false;
    if (tp0 != null && !levelOk(tp0, 'tp'))
        return false;
    return sl != null || tp0 != null;
}
/**
 * Keep trades whose symbol bucket can accept the parsed SL/TP levels.
 * Returns empty when no bucket matches.
 */
function filterTradesByPlausibleMgmtLevels(trades, parsed) {
    if (!trades.length || !mgmtHasPriceLevels(parsed))
        return [];
    const buckets = groupTradesBySymbolBucket(trades);
    const matched = [];
    for (const [, rows] of buckets) {
        if (levelPlausibleForBucket(rows, parsed)) {
            matched.push(...rows);
        }
    }
    return matched;
}
/** When plausibility fails, apply to the symbol of the most recently opened leg. */
function resolveNewestOpenSymbolTrades(trades) {
    if (!trades.length)
        return [];
    let newest = null;
    let newestTs = 0;
    for (const tr of trades) {
        const ts = tr.opened_at ? new Date(tr.opened_at).getTime() : 0;
        if (!newest || ts >= newestTs) {
            newest = tr;
            newestTs = ts;
        }
    }
    if (!newest)
        return [];
    const anchorSym = newest.symbol;
    return trades.filter(t => (0, basketModFollowUp_1.symbolsCompatibleForBasket)(anchorSym, t.symbol));
}
async function loadOpenTradesForManagement(supabase, args) {
    const { userId, channelId, brokerAccountIds } = args;
    if (!channelId || !brokerAccountIds.length)
        return [];
    const { data: channelSignals } = await supabase
        .from('signals')
        .select('id')
        .eq('user_id', userId)
        .eq('channel_id', channelId)
        .limit(5000);
    const signalIds = (channelSignals ?? []).map((r) => r.id);
    const { data: byChannelCol } = await supabase
        .from('trades')
        .select('id,signal_id,broker_account_id,metaapi_order_id,symbol,direction,lot_size,status,sl,tp,entry_price,opened_at,cwe_close_price')
        .eq('user_id', userId)
        .in('broker_account_id', brokerAccountIds)
        .eq('status', 'open')
        .eq('telegram_channel_id', channelId)
        .order('opened_at', { ascending: true })
        .limit(500);
    const { data: bySignalId } = signalIds.length
        ? await supabase
            .from('trades')
            .select('id,signal_id,broker_account_id,metaapi_order_id,symbol,direction,lot_size,status,sl,tp,entry_price,opened_at,cwe_close_price')
            .eq('user_id', userId)
            .in('broker_account_id', brokerAccountIds)
            .eq('status', 'open')
            .in('signal_id', signalIds)
            .order('opened_at', { ascending: true })
            .limit(500)
        : { data: [] };
    const merged = new Map();
    for (const row of [...(byChannelCol ?? []), ...(bySignalId ?? [])]) {
        merged.set(row.id, row);
    }
    let rows = [...merged.values()];
    rows = filterTradesBySymbolFilter(rows, args.symbolFilter);
    return rows;
}
/** Channel-wide modify without explicit symbol: plausibility first, then newest symbol. */
function resolveChannelModifyTargets(trades, parsed) {
    const plausible = filterTradesByPlausibleMgmtLevels(trades, parsed);
    if (plausible.length)
        return plausible;
    return resolveNewestOpenSymbolTrades(trades);
}
