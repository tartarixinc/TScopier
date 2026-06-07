"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_MANUAL_TP_LOTS = void 0;
exports.sanitizeTpLots = sanitizeTpLots;
exports.normalizeManualSettingsForExecution = normalizeManualSettingsForExecution;
/** Default Targets % rows — keep aligned with AccountConfigPage `DEFAULT_MANUAL_TP_LOTS`. */
exports.DEFAULT_MANUAL_TP_LOTS = [
    { label: 'TP1', lot: 0.01, percent: 50, enabled: true },
    { label: 'TP2', lot: 0.01, percent: 30, enabled: true },
    { label: 'TP3', lot: 0.01, percent: 20, enabled: true },
];
function splitIntEqual(count, total) {
    if (count <= 0)
        return [];
    const base = Math.floor(total / count);
    const rem = total - base * count;
    return Array.from({ length: count }, (_, i) => base + (i < rem ? 1 : 0));
}
function sumEnabledTpPercents(rows) {
    return rows.reduce((s, r) => s + (r.enabled ? Math.max(0, Number(r.percent) || 0) : 0), 0);
}
/** Disabled rows show 0%; percents clamped to 0..100 — matches AccountConfig `sanitizeTpLots`. */
function sanitizeTpLots(rows) {
    return rows.map(r => ({
        ...r,
        lot: r.lot ?? 0.01,
        percent: r.enabled ? Math.max(0, Math.min(100, Math.round(Number(r.percent) || 0))) : 0,
    }));
}
/**
 * Normalize `manual_settings` from DB for execution (Targets %, leg %, range).
 * Mirrors `normalizeManualSettings` in AccountConfigPage — without UI-only fields.
 */
function normalizeManualSettingsForExecution(raw) {
    const j = raw && typeof raw === 'object' ? raw : {};
    const tpLotsRaw = Array.isArray(j.tp_lots) ? j.tp_lots : exports.DEFAULT_MANUAL_TP_LOTS;
    const tpLots = tpLotsRaw.map((x, i) => {
        const row = x && typeof x === 'object' ? x : {};
        const pct = Number(row.percent);
        return {
            label: String(row.label ?? `TP${i + 1}`),
            lot: Number(row.lot ?? 0.01) || 0.01,
            percent: Number.isFinite(pct) && pct > 0 ? pct : 0,
            enabled: row.enabled !== false,
        };
    });
    const legPctRaw = Number(j.multi_trade_leg_percent);
    const legPct = Number.isFinite(legPctRaw) && legPctRaw > 0 ? Math.min(100, legPctRaw) : 5;
    const readNumber = (key, fallback) => {
        const v = Number(j[key]);
        return Number.isFinite(v) ? v : fallback;
    };
    const tpSanitized = sanitizeTpLots(tpLots);
    let tpFinal = tpSanitized;
    if (sumEnabledTpPercents(tpSanitized) === 0) {
        const enabledCount = tpSanitized.filter(r => r.enabled).length;
        if (enabledCount > 0) {
            const parts = splitIntEqual(enabledCount, 100);
            let k = 0;
            tpFinal = tpSanitized.map(r => r.enabled ? { ...r, percent: parts[k++] ?? 0 } : { ...r, percent: 0 });
        }
    }
    const rangePercent = Math.max(0, Math.min(100, readNumber('range_percent', 50)));
    const rangeStepPips = Math.max(0, readNumber('range_step_pips', 3));
    const rangeDistancePips = Math.max(0, readNumber('range_distance_pips', 30));
    const predefinedTpPips = Array.isArray(j.predefined_tp_pips)
        ? j.predefined_tp_pips.map(Number).filter(Number.isFinite)
        : [20, 40, 60];
    const singleTpTargetRaw = String(j.single_tp_target ?? 'farthest').toLowerCase();
    const singleTpTarget = singleTpTargetRaw === 'tp1'
        ? 'tp1'
        : singleTpTargetRaw === 'tp2'
            ? 'tp2'
            : singleTpTargetRaw === 'tp3'
                ? 'tp3'
                : 'farthest';
    return {
        ...j,
        multi_trade_leg_percent: legPct,
        range_percent: rangePercent,
        range_step_pips: rangeStepPips,
        range_distance_pips: rangeDistancePips,
        tp_lots: tpFinal,
        single_tp_target: singleTpTarget,
        predefined_tp_pips: predefinedTpPips,
        use_signal_entry_price: j.use_signal_entry_price === true,
        trade_style: j.trade_style === 'multi' ? 'multi' : 'single',
        range_trading: j.range_trading === true,
        range_layer_till_close: j.range_layer_till_close === true,
        close_worse_entries: j.close_worse_entries === true,
        close_worse_entries_pips: Math.max(0, readNumber('close_worse_entries_pips', 30)),
        use_predefined_sl_pips: j.use_predefined_sl_pips === true,
        use_predefined_tp_pips: j.use_predefined_tp_pips === true,
        add_new_trades_to_existing: j.add_new_trades_to_existing !== false,
    };
}
