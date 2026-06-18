"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isMtUuid = isMtUuid;
exports.brokerSessionUuid = brokerSessionUuid;
exports.brokerHasLinkedSession = brokerHasLinkedSession;
exports.parseSymbolToTradeList = parseSymbolToTradeList;
exports.applySymbolMapping = applySymbolMapping;
exports.isMt5OnlyOperation = isMt5OnlyOperation;
exports.isExcluded = isExcluded;
exports.operationFor = operationFor;
exports.computeLot = computeLot;
exports.roundLot = roundLot;
exports.isBuySideOp = isBuySideOp;
exports.clampOrderStops = clampOrderStops;
exports.computeCweTp = computeCweTp;
exports.triggerPriceFor = triggerPriceFor;
exports.virtualPendingTriggerAllowed = virtualPendingTriggerAllowed;
exports.brokerOrderOpenMs = brokerOrderOpenMs;
const manualPlanner_1 = require("../manualPlanner");
const signalEntryRange_1 = require("../manualPlanning/signalEntryRange");
const mtApiByAccount_1 = require("../mtApiByAccount");
const effectiveBrokerBalance_1 = require("../effectiveBrokerBalance");
function isMtUuid(s) {
    if (!s)
        return false;
    const v = s.trim();
    if (!v || v.includes('|'))
        return false;
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}
/** FxSocket terminal UUID from broker_accounts (fxsocket_account_id). */
function brokerSessionUuid(broker) {
    const id = (0, mtApiByAccount_1.brokerSessionId)(broker);
    return isMtUuid(id) ? id : null;
}
function brokerHasLinkedSession(broker) {
    return brokerSessionUuid(broker) != null;
}
function parseSymbolToTradeList(value) {
    if (!value || !value.trim())
        return [];
    return value
        .split(/[,;\s]+/)
        .map(s => s.trim().toUpperCase())
        .filter(s => s.length > 0);
}
function applySymbolMapping(raw, broker) {
    const m = (broker.manual_settings ?? {});
    const upper = raw.toUpperCase();
    const explicitMap = m.symbol_mapping?.[upper];
    const hasExplicitMap = explicitMap != null && String(explicitMap).trim() !== '';
    const mapped = (hasExplicitMap ? String(explicitMap) : upper).toUpperCase();
    const prefix = (m.symbol_prefix ?? '').toUpperCase();
    const suffix = (m.symbol_suffix ?? '').toUpperCase();
    const userDecorated = hasExplicitMap || prefix.length > 0 || suffix.length > 0;
    const allowed = parseSymbolToTradeList(m.symbol_to_trade);
    return {
        symbol: `${prefix}${mapped}${suffix}`,
        whitelist: allowed,
        userDecorated,
    };
}
const MT5_ONLY_OPERATIONS = new Set(['BuyStopLimit', 'SellStopLimit']);
function isMt5OnlyOperation(op) {
    return MT5_ONLY_OPERATIONS.has(op);
}
function isExcluded(symbol, broker) {
    const upper = symbol.trim().toUpperCase();
    if (!upper)
        return false;
    const m = (broker.manual_settings ?? {});
    const list = (m.symbols_exclude ?? []).map(s => String(s).toUpperCase());
    return list.includes(upper);
}
function operationFor(action, signal) {
    const a = action.toLowerCase();
    const hasEntry = (0, manualPlanner_1.parsedHasExplicitEntryAnchor)(signal);
    if (a === 'buy')
        return hasEntry ? 'BuyLimit' : 'Buy';
    if (a === 'sell')
        return hasEntry ? 'SellLimit' : 'Sell';
    return null;
}
function computeLot(broker, signal) {
    const mode = broker.copier_mode ?? 'ai';
    if (mode === 'manual') {
        const m = (broker.manual_settings ?? {});
        if (m.risk_mode === 'dynamic_balance_percent') {
            const pct = Number(m.dynamic_balance_percent ?? 1);
            const bal = (0, effectiveBrokerBalance_1.resolveBrokerTotalBalance)(broker) ?? 0;
            if (bal > 0 && pct > 0) {
                return Math.max(0.01, +(bal * (pct / 100) / 1000).toFixed(2));
            }
        }
        if (typeof signal.lot_size === 'number' && signal.lot_size > 0)
            return signal.lot_size;
        return Math.max(0.01, Number(m.fixed_lot ?? broker.default_lot_size ?? 0.01));
    }
    const ai = (broker.ai_settings ?? {});
    const ref = Number(ai.reference_equity ?? 1000);
    const bal = (0, effectiveBrokerBalance_1.resolveBrokerTotalBalance)(broker) ?? ref;
    const base = Number(ai.fallback_lot ?? broker.default_lot_size ?? 0.01);
    const scaled = ref > 0 ? base * (bal / ref) : base;
    const min = Number(ai.min_lot ?? 0.01);
    const max = Number(ai.max_lot ?? 100);
    const final = Math.max(min, Math.min(max, scaled));
    return +final.toFixed(2);
}
function roundLot(volume, params) {
    if (!params)
        return Math.max(0.01, +volume.toFixed(2));
    const step = params.lotStep || 0.01;
    const min = params.minLot || step;
    const max = params.maxLot || 100;
    const rounded = Math.max(min, Math.min(max, Math.round(volume / step) * step));
    return +rounded.toFixed(2);
}
function isBuySideOp(op) {
    return op === 'Buy' || op === 'BuyLimit' || op === 'BuyStop' || op === 'BuyStopLimit';
}
function clampOrderStops(args, params) {
    const adjustments = [];
    if (!params)
        return { args, adjustments };
    const point = Number(params.point) || 0;
    const stopsLevel = Number(params.stopsLevel) || 0;
    const freezeLevel = Number(params.freezeLevel) || 0;
    if (point <= 0)
        return { args, adjustments };
    const minLevel = Math.max(stopsLevel, freezeLevel);
    const minDist = (minLevel + 2) * point;
    const ref = Number(args.price) || 0;
    if (ref <= 0 || minDist <= 0)
        return { args, adjustments };
    const digits = Math.max(0, Math.min(8, Number(params.digits) || 5));
    const round = (v) => Number(v.toFixed(digits));
    const isBuy = isBuySideOp(String(args.operation));
    let sl = Number(args.stoploss) || 0;
    let tp = Number(args.takeprofit) || 0;
    const original = { sl, tp };
    if (isBuy) {
        if (sl > 0 && ref - sl < minDist)
            sl = round(ref - minDist);
        if (tp > 0 && tp - ref < minDist)
            tp = round(ref + minDist);
    }
    else {
        if (sl > 0 && sl - ref < minDist)
            sl = round(ref + minDist);
        if (tp > 0 && ref - tp < minDist)
            tp = round(ref - minDist);
    }
    if (sl !== original.sl)
        adjustments.push(`sl ${original.sl} → ${sl}`);
    if (tp !== original.tp)
        adjustments.push(`tp ${original.tp} → ${tp}`);
    if (adjustments.length === 0)
        return { args, adjustments };
    return { args: { ...args, stoploss: sl, takeprofit: tp }, adjustments };
}
function computeCweTp(plan, anchor, params) {
    if (!plan.closeWorseEntries || plan.pip == null || plan.isBuy == null)
        return null;
    if (anchor == null || !Number.isFinite(anchor) || anchor <= 0)
        return null;
    const digits = Math.max(0, Math.min(8, Number(params?.digits) || 5));
    const point = Number(params?.point) || 0;
    const stopsLevel = Number(params?.stopsLevel) || 0;
    const freezeLevel = Number(params?.freezeLevel) || 0;
    const safe = Math.max(stopsLevel, freezeLevel);
    const minStopDistance = safe > 0 && point > 0 ? (safe + 2) * point : 0;
    return (0, manualPlanner_1.computeCwOverrideTp)({
        policy: plan.closeWorseEntries,
        anchor,
        isBuy: plan.isBuy,
        pip: plan.pip,
        digits,
        minStopDistance,
    });
}
function triggerPriceFor(leg, anchor, digits) {
    const dir = leg.isBuy ? -1 : 1;
    const px = anchor + dir * leg.stepIdx * leg.stepPriceOffset;
    const d = Math.max(0, Math.min(8, Math.floor(digits)));
    return Number(px.toFixed(d));
}
/** Whether a virtual range leg should be persisted (broker stops zone + signal entry zone). */
function virtualPendingTriggerAllowed(args) {
    if (args.signalRangeBoundary != null
        && !(0, signalEntryRange_1.virtualLegTriggerAllowed)({
            trigger: args.triggerPrice,
            boundary: args.signalRangeBoundary,
            isBuy: args.isBuy,
        })) {
        return false;
    }
    if (args.stopsZoneLo != null && args.stopsZoneHi != null
        && args.triggerPrice > args.stopsZoneLo && args.triggerPrice < args.stopsZoneHi) {
        return false;
    }
    return true;
}
function brokerOrderOpenMs(o) {
    const candidates = [
        o.timeSetup,
        o.TimeSetup,
        o.setupTime,
        o.SetupTime,
        o.time,
        o.Time,
        o.openTime,
        o.OpenTime,
        o.created,
        o.Created,
    ];
    for (const c of candidates) {
        if (typeof c === 'number' && Number.isFinite(c) && c > 0) {
            return c > 1e12 ? c : c * 1000;
        }
        if (typeof c === 'string' && c.trim()) {
            const p = Date.parse(c);
            if (Number.isFinite(p))
                return p;
        }
    }
    return null;
}
