"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveCopyLimitTimezone = resolveCopyLimitTimezone;
exports.copyLimitsActive = copyLimitsActive;
exports.equityDelta = equityDelta;
exports.evaluateCopyLimitBreaches = evaluateCopyLimitBreaches;
exports.updatePeriodSnapshots = updatePeriodSnapshots;
exports.mergeBreachesIntoState = mergeBreachesIntoState;
exports.reconcilePausedKeysWithConfig = reconcilePausedKeysWithConfig;
exports.isChannelCopyLimitPaused = isChannelCopyLimitPaused;
exports.periodEquitySnapshot = periodEquitySnapshot;
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
function equityDelta(equity) {
    return equity.currentEquity - equity.periodStartEquity;
}
function profitTargetHit(rule, equity, channelPnl) {
    if (!rule.enabled || rule.value <= 0)
        return false;
    const delta = equityDelta(equity);
    if (rule.value_type === 'amount') {
        if (delta >= rule.value)
            return true;
        return channelPnl != null && channelPnl >= rule.value;
    }
    if (equity.periodStartEquity <= 0)
        return false;
    if ((delta / equity.periodStartEquity) * 100 >= rule.value)
        return true;
    return channelPnl != null
        && (channelPnl / equity.periodStartEquity) * 100 >= rule.value;
}
function maxRiskHit(rule, equity, channelPnl) {
    if (!rule.enabled || rule.value <= 0)
        return false;
    const delta = equityDelta(equity);
    if (rule.value_type === 'amount') {
        if (delta <= -rule.value)
            return true;
        return channelPnl != null && channelPnl <= -rule.value;
    }
    if (equity.periodStartEquity <= 0)
        return false;
    const drawdown = Math.max(0, equity.peakEquity - equity.currentEquity);
    if ((drawdown / equity.periodStartEquity) * 100 >= rule.value)
        return true;
    return channelPnl != null
        && channelPnl < 0
        && (-channelPnl / equity.periodStartEquity) * 100 >= rule.value;
}
function evaluateCopyLimitBreaches(args) {
    const at = args.at ?? new Date();
    const breaches = [];
    if (args.config.profit_targets_enabled) {
        for (const rule of args.config.profit_targets) {
            if (!profitTargetHit(rule, args.equity, args.channelPnl))
                continue;
            const pk = (0, copyLimitPeriods_1.periodKeyFor)(rule.period, args.timeZone, at);
            breaches.push({
                kind: 'profit',
                reason: 'channel_profit_target_hit',
                pauseKey: (0, copyLimitTypes_1.pauseKey)('profit', rule.period, pk, rule.id),
                ruleId: rule.id,
                fingerprint: (0, copyLimitTypes_1.ruleFingerprint)(rule),
            });
        }
    }
    if (args.config.max_risk_enabled) {
        for (const rule of args.config.max_risks) {
            if (!maxRiskHit(rule, args.equity, args.channelPnl))
                continue;
            const pk = (0, copyLimitPeriods_1.periodKeyFor)(rule.period, args.timeZone, at);
            breaches.push({
                kind: 'risk',
                reason: 'channel_max_risk_hit',
                pauseKey: (0, copyLimitTypes_1.pauseKey)('risk', rule.period, pk, rule.id),
                ruleId: rule.id,
                fingerprint: (0, copyLimitTypes_1.ruleFingerprint)(rule),
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
        const periodStart = prev?.reference_equity && prev.reference_equity > 0
            ? prev.reference_equity
            : args.currentEquity;
        const peak = Math.max(prev?.peak_equity ?? args.currentEquity, args.currentEquity);
        periods[storageKey] = {
            period_key: pk,
            reference_equity: periodStart,
            peak_equity: peak,
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
    const flattened_pause_keys = (0, copyLimitPeriods_1.pruneExpiredPauseKeys)(args.state.flattened_pause_keys ?? [], args.timeZone, at);
    const pause_rule_fingerprints = pickFingerprints(args.state.pause_rule_fingerprints, new Set([...paused_period_keys, ...flattened_pause_keys]));
    return { paused_period_keys, flattened_pause_keys, pause_rule_fingerprints, periods };
}
function pickFingerprints(fingerprints, keys) {
    const out = {};
    for (const [key, fp] of Object.entries(fingerprints ?? {})) {
        if (keys.has(key))
            out[key] = fp;
    }
    return out;
}
function mergeBreachesIntoState(state, breaches) {
    const set = new Set(state.paused_period_keys);
    const fingerprints = { ...(state.pause_rule_fingerprints ?? {}) };
    for (const b of breaches) {
        set.add(b.pauseKey);
        if (b.fingerprint)
            fingerprints[b.pauseKey] = b.fingerprint;
    }
    return { ...state, paused_period_keys: [...set], pause_rule_fingerprints: fingerprints };
}
function ruleForPauseKey(config, key) {
    const parts = key.split(':');
    const kind = parts[0];
    const period = parts[1];
    if (!kind || !period)
        return null;
    const list = kind === 'risk'
        ? (config.max_risk_enabled ? config.max_risks : [])
        : (config.profit_targets_enabled ? config.profit_targets : []);
    const ruleId = period === 'overall' ? parts[2] : parts[3];
    const rule = ruleId
        ? list.find(r => r.id === ruleId)
        : list.find(r => r.period === period && r.enabled);
    if (!rule || !rule.enabled || rule.value <= 0)
        return null;
    return rule;
}
/**
 * Drop pause keys that no longer correspond to the current config:
 *   - the rule (or its whole section) was deleted or disabled, or
 *   - the rule's thresholds changed since the breach (fingerprint mismatch) —
 *     e.g. the user raised the profit target / max loss, or
 *   - legacy pauses without a recorded fingerprint, when `currentBreachKeys`
 *     is provided (worker path with live equity) and the rule is not
 *     currently breaching.
 *
 * Pauses for unchanged, still-valid rules stay sticky until the period resets.
 */
function reconcilePausedKeysWithConfig(state, config, currentBreachKeys) {
    const fingerprints = state.pause_rule_fingerprints ?? {};
    const kept = state.paused_period_keys.filter(key => {
        const rule = ruleForPauseKey(config, key);
        if (!rule)
            return false;
        const recorded = fingerprints[key];
        if (recorded)
            return recorded === (0, copyLimitTypes_1.ruleFingerprint)(rule);
        if (currentBreachKeys)
            return currentBreachKeys.has(key);
        return true;
    });
    if (kept.length === state.paused_period_keys.length)
        return state;
    const keptSet = new Set(kept);
    return {
        ...state,
        paused_period_keys: kept,
        flattened_pause_keys: (state.flattened_pause_keys ?? []).filter(k => keptSet.has(k)),
        pause_rule_fingerprints: pickFingerprints(state.pause_rule_fingerprints, keptSet),
    };
}
function isChannelCopyLimitPaused(args) {
    if (!copyLimitsActive(args.config))
        return null;
    const rawState = args.state ?? { paused_period_keys: [], periods: {} };
    // Ignore pauses from rules that were since edited/removed — e.g. the user
    // raised the profit target after it was hit.
    const state = reconcilePausedKeysWithConfig(rawState, args.config);
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
function periodEquitySnapshot(state, period, currentEquity, timeZone, at = new Date()) {
    const pk = (0, copyLimitPeriods_1.periodKeyFor)(period, timeZone, at);
    const storageKey = (0, copyLimitPeriods_1.periodStorageKey)(period, pk);
    const snap = state.periods[storageKey];
    const periodStartEquity = snap?.reference_equity && snap.reference_equity > 0
        ? snap.reference_equity
        : currentEquity;
    const peakEquity = Math.max(snap?.peak_equity ?? currentEquity, currentEquity);
    return { currentEquity, periodStartEquity, peakEquity };
}
