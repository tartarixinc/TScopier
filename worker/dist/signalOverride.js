"use strict";
/**
 * Per-signal user SL/TP overrides (Manage Signals). Mirror of src/lib/signalOverride.ts.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseUserOverride = parseUserOverride;
exports.mergeSignalUserOverride = mergeSignalUserOverride;
exports.effectiveParsedFromSignalRow = effectiveParsedFromSignalRow;
exports.applyUserOverrideToSignalRow = applyUserOverrideToSignalRow;
function positiveLevel(v) {
    const n = typeof v === 'number' ? v : Number(v ?? 0);
    return Number.isFinite(n) && n > 0 ? n : null;
}
function normalizeTpLevels(tp) {
    if (!Array.isArray(tp))
        return [];
    return tp.filter((t) => positiveLevel(t) != null);
}
function emptyParsed() {
    return {
        action: 'ignore',
        symbol: null,
        entry_price: null,
        entry_zone_low: null,
        entry_zone_high: null,
        sl: null,
        tp: null,
        lot_size: null,
    };
}
function parseUserOverride(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return null;
    const row = raw;
    const sl = row.sl === null || row.sl === undefined ? undefined : positiveLevel(row.sl);
    const tp = row.tp === undefined ? undefined : normalizeTpLevels(row.tp);
    const entry = row.entry === null || row.entry === undefined ? undefined : positiveLevel(row.entry);
    const updated_at = typeof row.updated_at === 'string' ? row.updated_at : undefined;
    if (sl === undefined && tp === undefined && entry === undefined && !updated_at)
        return null;
    return { sl, tp, entry, updated_at };
}
function mergeSignalUserOverride(parsed, override, opts) {
    const base = parsed
        ? { ...parsed, tp: parsed.tp ? [...parsed.tp] : parsed.tp }
        : emptyParsed();
    if (!override)
        return base;
    const hasSl = positiveLevel(base.sl) != null;
    const hasTp = normalizeTpLevels(base.tp).length > 0;
    const overlay = opts?.overlay === true;
    if (overlay || override.sl != null) {
        if (override.sl != null)
            base.sl = override.sl;
        else if (override.sl === null && overlay)
            base.sl = null;
    }
    else if (!hasSl && override.sl != null) {
        base.sl = override.sl;
    }
    if (overlay || (override.tp != null && override.tp.length > 0)) {
        if (override.tp != null && override.tp.length > 0)
            base.tp = [...override.tp];
        else if (override.tp != null && overlay)
            base.tp = [];
    }
    else if (!hasTp && override.tp != null && override.tp.length > 0) {
        base.tp = [...override.tp];
    }
    if (override.entry != null || (override.entry === null && overlay)) {
        base.entry_price = override.entry ?? null;
    }
    return base;
}
function effectiveParsedFromSignalRow(signal) {
    return mergeSignalUserOverride(signal.parsed_data, parseUserOverride(signal.user_override), {
        overlay: true,
    });
}
function applyUserOverrideToSignalRow(row) {
    const override = parseUserOverride(row.user_override);
    if (!override)
        return row;
    return {
        ...row,
        parsed_data: mergeSignalUserOverride(row.parsed_data, override, { overlay: true }),
    };
}
