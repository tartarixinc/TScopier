"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.barsToMidPoints = barsToMidPoints;
exports.quotesToMidPoints = quotesToMidPoints;
exports.simulateTradeOnSeries = simulateTradeOnSeries;
function barsToMidPoints(bars) {
    return bars.map((b) => ({
        ts: b.t,
        bid: b.l,
        ask: b.h,
        mid: (b.o + b.c) / 2,
    }));
}
function quotesToMidPoints(quotes) {
    return quotes
        .filter((q) => Number.isFinite(q.bid_price) && Number.isFinite(q.ask_price))
        .map((q) => ({
        ts: Math.floor(q.participant_timestamp / 1000000),
        bid: q.bid_price,
        ask: q.ask_price,
        mid: (q.bid_price + q.ask_price) / 2,
    }))
        .sort((a, b) => a.ts - b.ts);
}
function executionPrice(direction, side, p) {
    if (direction === "buy")
        return side === "entry" ? p.ask : p.bid;
    return side === "entry" ? p.bid : p.ask;
}
function hitLevel(direction, level, p, kind) {
    if (direction === "buy") {
        if (kind === "tp")
            return p.ask >= level;
        return p.bid <= level;
    }
    if (kind === "tp")
        return p.bid <= level;
    return p.ask >= level;
}
function simulateTradeOnSeries(signal, series, strategy, lotSize, pipValuePerLot = 10) {
    const base = {
        signalId: signal.signalId,
        channelId: signal.channelId,
        symbol: signal.symbol,
        direction: signal.direction,
        signalAt: signal.signalAt,
        entryPrice: signal.entryPrice,
        sl: signal.sl,
        tpLevels: [...signal.tpLevels],
        lotSize,
        outcome: "no_data",
        tpsHit: 0,
        exitPrice: null,
        closedAt: null,
        pnl: 0,
        pnlR: null,
        mfe: 0,
        mae: 0,
        details: {},
    };
    if (!series.length || signal.tpLevels.length === 0 && signal.sl == null) {
        base.outcome = "skipped";
        return base;
    }
    const signalMs = signal.signalAt.getTime();
    const window = series.filter((p) => p.ts >= signalMs - 60000);
    if (!window.length)
        return base;
    let entryIdx = window.findIndex((p) => p.ts >= signalMs);
    if (entryIdx < 0)
        entryIdx = 0;
    const entryPx = signal.entryPrice > 0
        ? signal.entryPrice
        : executionPrice(signal.direction, "entry", window[entryIdx]);
    let sl = signal.sl;
    let tps = [...signal.tpLevels].sort((a, b) => signal.direction === "buy" ? a - b : b - a);
    let tpIdx = 0;
    let beActive = false;
    let remainingFraction = 1;
    let realizedPnl = 0;
    let mfe = 0;
    let mae = 0;
    let lastTs = null;
    const riskDistance = sl != null ? Math.abs(entryPx - sl) : null;
    const partialFrac = strategy.partialClosePerTp > 0
        ? Math.min(1, strategy.partialClosePerTp)
        : (tps.length > 0 ? 1 / tps.length : 1);
    for (let i = entryIdx; i < window.length; i++) {
        const p = window[i];
        lastTs = p.ts;
        const mark = executionPrice(signal.direction, "exit", p);
        const move = signal.direction === "buy" ? mark - entryPx : entryPx - mark;
        mfe = Math.max(mfe, move);
        mae = Math.max(mae, -move);
        const levels = [];
        if (sl != null)
            levels.push({ kind: beActive ? "be" : "sl", price: beActive ? entryPx : sl });
        if (tpIdx < tps.length)
            levels.push({ kind: "tp", price: tps[tpIdx] });
        const order = strategy.intrabarPriority === "tp_first"
            ? ["tp", "sl", "be"]
            : ["sl", "be", "tp"];
        for (const kind of order) {
            const lvl = levels.find((l) => l.kind === kind);
            if (!lvl)
                continue;
            if (!hitLevel(signal.direction, lvl.price, p, kind === "tp" ? "tp" : "sl"))
                continue;
            if (kind === "tp") {
                const closeFrac = Math.min(remainingFraction, partialFrac);
                const legPnl = moveAtPrice(signal.direction, entryPx, lvl.price, closeFrac, lotSize, pipValuePerLot);
                realizedPnl += legPnl;
                remainingFraction -= closeFrac;
                tpIdx += 1;
                base.tpsHit = tpIdx;
                if (strategy.breakevenAfterTp > 0 && tpIdx >= strategy.breakevenAfterTp) {
                    beActive = true;
                    sl = entryPx;
                }
                if (tpIdx >= tps.length) {
                    return finalize(base, outcomeFromTps(base.tpsHit, tps.length, beActive), lvl.price, p.ts, realizedPnl, riskDistance, mfe, mae, { beActive });
                }
                if (remainingFraction <= 0.001) {
                    return finalize(base, "all_tp_hit", lvl.price, p.ts, realizedPnl, riskDistance, mfe, mae, {});
                }
                break;
            }
            if (kind === "sl" || kind === "be") {
                const out = beActive || kind === "be"
                    ? (base.tpsHit > 0 ? "tp_then_be" : "breakeven")
                    : (base.tpsHit >= 1 ? "tp1_then_sl" : "sl_before_tp");
                const closePnl = moveAtPrice(signal.direction, entryPx, lvl.price, remainingFraction, lotSize, pipValuePerLot);
                return finalize(base, out, lvl.price, p.ts, realizedPnl + closePnl, riskDistance, mfe, mae, { beActive });
            }
        }
    }
    base.outcome = "open";
    base.mfe = mfe;
    base.mae = mae;
    base.pnl = realizedPnl;
    if (lastTs)
        base.details.lastMarkTs = lastTs;
    return base;
}
function outcomeFromTps(hit, total, beActive) {
    if (hit >= total)
        return "all_tp_hit";
    if (beActive && hit > 0)
        return "tp_then_be";
    return "tp1_then_sl";
}
function moveAtPrice(direction, entry, exit, fraction, lot, pipValue) {
    const pts = direction === "buy" ? exit - entry : entry - exit;
    return pts * lot * pipValue * 100 * fraction;
}
function finalize(base, outcome, exitPrice, closedMs, pnl, riskDistance, mfe, mae, details) {
    return {
        ...base,
        outcome,
        exitPrice,
        closedAt: new Date(closedMs),
        pnl,
        pnlR: riskDistance && riskDistance > 0
            ? pnl / (riskDistance * base.lotSize * 10)
            : null,
        mfe,
        mae,
        details: { ...base.details, ...details },
    };
}
