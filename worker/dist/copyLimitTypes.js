"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_COPY_LIMIT_STATE = exports.DEFAULT_COPY_LIMITS = void 0;
exports.ruleFingerprint = ruleFingerprint;
exports.normalizeCopyLimits = normalizeCopyLimits;
exports.normalizeCopyLimitState = normalizeCopyLimitState;
exports.pauseKey = pauseKey;
/** Identity of a rule's thresholds — changing any of these invalidates old pauses. */
function ruleFingerprint(rule) {
    return `${rule.period}|${rule.value_type}|${rule.value}`;
}
exports.DEFAULT_COPY_LIMITS = {
    profit_targets_enabled: false,
    profit_targets: [],
    max_risk_enabled: false,
    max_risks: [],
    timezone_mode: 'profile',
};
exports.DEFAULT_COPY_LIMIT_STATE = {
    paused_period_keys: [],
    periods: {},
};
function normalizeCopyLimits(raw) {
    const j = raw && typeof raw === 'object' ? raw : {};
    const profitTargets = Array.isArray(j.profit_targets)
        ? j.profit_targets
            .map((row, idx) => {
            const r = row && typeof row === 'object' ? row : {};
            const value = Number(r.value);
            const period = String(r.period ?? 'daily');
            const valueType = String(r.value_type ?? 'amount');
            const validPeriod = ['daily', 'weekly', 'monthly', 'overall'].includes(period)
                ? period
                : 'daily';
            const validType = valueType === 'percent' ? 'percent' : 'amount';
            return {
                id: String(r.id ?? `pt-${idx}`),
                enabled: r.enabled !== false,
                period: validPeriod,
                value_type: validType,
                value: Number.isFinite(value) && value > 0 ? value : 0,
            };
        })
            .filter(r => r.value > 0)
        : [];
    const parseMaxRiskRow = (row, idx) => {
        const r = row && typeof row === 'object' ? row : {};
        const value = Number(r.value);
        const period = String(r.period ?? 'daily');
        const valueType = String(r.value_type ?? 'amount');
        const validPeriod = ['daily', 'weekly', 'monthly', 'overall'].includes(period)
            ? period
            : 'daily';
        const validType = valueType === 'percent' ? 'percent' : 'amount';
        return {
            id: String(r.id ?? `mr-${idx}`),
            enabled: r.enabled !== false,
            period: validPeriod,
            value_type: validType,
            value: Number.isFinite(value) && value > 0 ? value : 0,
        };
    };
    let maxRisks = Array.isArray(j.max_risks)
        ? j.max_risks.map((row, idx) => parseMaxRiskRow(row, idx)).filter(r => r.value > 0)
        : [];
    if (!maxRisks.length && j.max_risk && typeof j.max_risk === 'object') {
        const legacy = parseMaxRiskRow(j.max_risk, 0);
        if (legacy.value > 0) {
            maxRisks = [{ ...legacy, id: legacy.id === 'mr-0' ? 'mr-legacy' : legacy.id }];
        }
    }
    const tzMode = String(j.timezone_mode ?? 'profile');
    return {
        profit_targets_enabled: j.profit_targets_enabled === true,
        profit_targets: profitTargets,
        max_risk_enabled: j.max_risk_enabled === true && maxRisks.length > 0,
        max_risks: maxRisks,
        timezone_mode: tzMode === 'custom' ? 'custom' : 'profile',
        timezone: typeof j.timezone === 'string' && j.timezone.trim() ? j.timezone.trim() : undefined,
    };
}
function normalizeCopyLimitState(raw) {
    const j = raw && typeof raw === 'object' ? raw : {};
    const paused = Array.isArray(j.paused_period_keys)
        ? j.paused_period_keys.map(k => String(k)).filter(Boolean)
        : [];
    const periods = {};
    if (j.periods && typeof j.periods === 'object') {
        for (const [key, val] of Object.entries(j.periods)) {
            if (!val || typeof val !== 'object')
                continue;
            const row = val;
            const ref = Number(row.reference_equity);
            const peakEquity = Number(row.peak_equity);
            const legacyPeakPnl = Number(row.peak_channel_pnl);
            const peak = Number.isFinite(peakEquity) && peakEquity > 0
                ? peakEquity
                : (Number.isFinite(legacyPeakPnl) && legacyPeakPnl > 0 ? legacyPeakPnl : ref);
            periods[key] = {
                period_key: String(row.period_key ?? key),
                reference_equity: Number.isFinite(ref) ? ref : 0,
                peak_equity: Number.isFinite(peak) ? peak : 0,
                last_evaluated_at: String(row.last_evaluated_at ?? ''),
            };
        }
    }
    const flattened = Array.isArray(j.flattened_pause_keys)
        ? j.flattened_pause_keys.map(k => String(k)).filter(Boolean)
        : [];
    const fingerprints = {};
    if (j.pause_rule_fingerprints && typeof j.pause_rule_fingerprints === 'object') {
        for (const [key, val] of Object.entries(j.pause_rule_fingerprints)) {
            if (typeof val === 'string' && val)
                fingerprints[key] = val;
        }
    }
    return {
        paused_period_keys: paused,
        flattened_pause_keys: flattened,
        pause_rule_fingerprints: fingerprints,
        periods,
    };
}
function pauseKey(kind, period, periodKey, ruleId) {
    if (period === 'overall') {
        return ruleId ? `${kind}:overall:${ruleId}` : `${kind}:overall`;
    }
    return `${kind}:${period}:${periodKey}${ruleId ? `:${ruleId}` : ''}`;
}
