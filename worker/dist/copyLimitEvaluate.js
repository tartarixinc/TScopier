"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveCopyLimitTimezone = resolveCopyLimitTimezone;
exports.copyLimitsActive = copyLimitsActive;
exports.evaluateCopyLimitBreaches = evaluateCopyLimitBreaches;
exports.updatePeriodSnapshots = updatePeriodSnapshots;
exports.mergeBreachesIntoState = mergeBreachesIntoState;
exports.isChannelCopyLimitPaused = isChannelCopyLimitPaused;
exports.peakChannelPnlForPeriod = peakChannelPnlForPeriod;
const copyLimitPeriods_1 = require("./copyLimitPeriods");
const copyLimitTypes_1 = require("./copyLimitTypes");
function resolveCopyLimitTimezone(config, profileTimezone) {
    if (config.timezone_mode === 'custom' && config.timezone?.trim()) {
        return config.timezone.trim();
    }
    return profileTimezone?.trim() || 'UTC';
}
function copyLimitsActive(config) {
    if (!config)
        return false;
    const profitOn = config.profit_targets_enabled
        && config.profit_targets.some(t => t.enabled && t.value > 0);
    const riskOn = config.max_risk_enabled
        && config.max_risks.some(t => t.enabled && t.value > 0);
    return profitOn || riskOn;
}
function profitTargetHit(rule, pnl, referenceEquity) {
    if (!rule.enabled || rule.value <= 0)
        return false;
    if (rule.value_type === 'amount') {
        return pnl.totalPnl >= rule.value;
    }
    if (referenceEquity <= 0)
        return false;
    return (pnl.totalPnl / referenceEquity) * 100 >= rule.value;
}
function maxRiskHit(rule, pnl, referenceEquity, peakChannelPnl) {
    if (!rule.enabled || rule.value <= 0)
        return false;
    if (rule.value_type === 'amount') {
        return pnl.totalPnl <= -rule.value;
    }
    if (referenceEquity <= 0)
        return false;
    const drawdown = Math.max(0, peakChannelPnl - pnl.totalPnl);
    return (drawdown / referenceEquity) * 100 >= rule.value;
}
function evaluateCopyLimitBreaches(args) {
    const at = args.at ?? new Date();
    const breaches = [];
    if (args.config.profit_targets_enabled) {
        for (const rule of args.config.profit_targets) {
            if (!profitTargetHit(rule, args.pnl, args.referenceEquity))
                continue;
            const pk = (0, copyLimitPeriods_1.periodKeyFor)(rule.period, args.timeZone, at);
            breaches.push({
                kind: 'profit',
                reason: 'channel_profit_target_hit',
                pauseKey: (0, copyLimitTypes_1.pauseKey)('profit', rule.period, pk, rule.id),
                ruleId: rule.id,
            });
        }
    }
    if (args.config.max_risk_enabled) {
        for (const rule of args.config.max_risks) {
            if (!maxRiskHit(rule, args.pnl, args.referenceEquity, args.peakChannelPnl))
                continue;
            const pk = (0, copyLimitPeriods_1.periodKeyFor)(rule.period, args.timeZone, at);
            breaches.push({
                kind: 'risk',
                reason: 'channel_max_risk_hit',
                pauseKey: (0, copyLimitTypes_1.pauseKey)('risk', rule.period, pk, rule.id),
                ruleId: rule.id,
            });
        }
    }
    return breaches;
}
function updatePeriodSnapshots(args) {
    const at = args.at ?? new Date();
    const periods = { ...args.state.periods };
    const periodKinds = ['daily', 'weekly', 'monthly', 'overall'];
    const touchPeriod = (period) => {
        const pk = (0, copyLimitPeriods_1.periodKeyFor)(period, args.timeZone, at);
        const storageKey = (0, copyLimitPeriods_1.periodStorageKey)(period, pk);
        const prev = periods[storageKey];
        const peak = Math.max(prev?.peak_channel_pnl ?? args.pnl.totalPnl, args.pnl.totalPnl);
        periods[storageKey] = {
            period_key: pk,
            reference_equity: prev?.reference_equity && prev.reference_equity > 0
                ? prev.reference_equity
                : args.referenceEquity,
            peak_channel_pnl: peak,
            last_evaluated_at: at.toISOString(),
        };
    };
    if (args.config.profit_targets_enabled) {
        for (const rule of args.config.profit_targets) {
            if (rule.enabled)
                touchPeriod(rule.period);
        }
    }
    if (args.config.max_risk_enabled) {
        for (const rule of args.config.max_risks) {
            if (rule.enabled)
                touchPeriod(rule.period);
        }
    }
    for (const period of periodKinds) {
        const pk = (0, copyLimitPeriods_1.periodKeyFor)(period, args.timeZone, at);
        const storageKey = (0, copyLimitPeriods_1.periodStorageKey)(period, pk);
        if (!periods[storageKey])
            continue;
        const currentPk = periods[storageKey]?.period_key;
        if (currentPk && currentPk !== pk) {
            delete periods[storageKey];
        }
    }
    const paused_period_keys = (0, copyLimitPeriods_1.pruneExpiredPauseKeys)(args.state.paused_period_keys, args.timeZone, at);
    return { paused_period_keys, periods };
}
function mergeBreachesIntoState(state, breaches) {
    const set = new Set(state.paused_period_keys);
    for (const b of breaches)
        set.add(b.pauseKey);
    return { ...state, paused_period_keys: [...set] };
}
function isChannelCopyLimitPaused(args) {
    if (!copyLimitsActive(args.config))
        return null;
    const state = args.state ?? { paused_period_keys: [], periods: {} };
    const at = args.at ?? new Date();
    const active = (0, copyLimitPeriods_1.pruneExpiredPauseKeys)(state.paused_period_keys, args.timeZone, at);
    if (!active.length)
        return null;
    const key = active[0];
    if (key.startsWith('risk:')) {
        return { kind: 'risk', reason: 'channel_max_risk_hit', pauseKey: key };
    }
    return { kind: 'profit', reason: 'channel_profit_target_hit', pauseKey: key };
}
function peakChannelPnlForPeriod(state, period, timeZone, at = new Date()) {
    const pk = (0, copyLimitPeriods_1.periodKeyFor)(period, timeZone, at);
    const storageKey = (0, copyLimitPeriods_1.periodStorageKey)(period, pk);
    return state.periods[storageKey]?.peak_channel_pnl ?? 0;
}
