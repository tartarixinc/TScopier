"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeChannelUuid = normalizeChannelUuid;
exports.normalizeChannelTradingConfigsMap = normalizeChannelTradingConfigsMap;
exports.resolveChannelConfigEntry = resolveChannelConfigEntry;
exports.healChannelTradingConfigsMap = healChannelTradingConfigsMap;
exports.buildDefaultChannelTradingConfig = buildDefaultChannelTradingConfig;
exports.channelManualSettingsComplete = channelManualSettingsComplete;
exports.isMinimalSeedManualSettings = isMinimalSeedManualSettings;
exports.storedPerChannelConfigComplete = storedPerChannelConfigComplete;
exports.channelConfigReadyForExecution = channelConfigReadyForExecution;
exports.resolveChannelTradingConfig = resolveChannelTradingConfig;
exports.withChannelTradingConfig = withChannelTradingConfig;
const normalizeManualSettings_1 = require("./manualPlanning/normalizeManualSettings");
const brokerChannelFilter_1 = require("./brokerChannelFilter");
const copyLimitTypes_1 = require("./copyLimitTypes");
const effectiveBrokerBalance_1 = require("./effectiveBrokerBalance");
function brokerAccountBalance(broker) {
    const bal = (0, effectiveBrokerBalance_1.resolveBrokerTotalBalance)(broker) ?? 0;
    return bal > 0 ? bal : null;
}
function normalizeChannelUuid(id) {
    const s = String(id ?? '').trim();
    return s ? s.toLowerCase() : null;
}
function normalizeChannelTradingConfigsMap(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return {};
    const out = {};
    for (const [channelId, value] of Object.entries(raw)) {
        const key = normalizeChannelUuid(channelId);
        if (!key || !value || typeof value !== 'object' || Array.isArray(value))
            continue;
        const row = value;
        const mode = row.copier_mode;
        out[key] = {
            copier_mode: mode === 'ai' || mode === 'manual' ? mode : undefined,
            manual_settings: row.manual_settings && typeof row.manual_settings === 'object'
                ? row.manual_settings
                : undefined,
            ai_settings: row.ai_settings && typeof row.ai_settings === 'object'
                ? row.ai_settings
                : undefined,
            copy_limit_state: row.copy_limit_state && typeof row.copy_limit_state === 'object'
                ? (0, copyLimitTypes_1.normalizeCopyLimitState)(row.copy_limit_state)
                : undefined,
        };
    }
    return out;
}
function resolveChannelConfigEntry(configs, channelId) {
    const key = normalizeChannelUuid(channelId);
    if (!key)
        return undefined;
    if (configs[key])
        return configs[key];
    for (const [k, v] of Object.entries(configs)) {
        if (k.toLowerCase() === key)
            return v;
    }
    return undefined;
}
function mergeHealedChannelManualSettings(existing, brokerFallback, defaultManual, accountBalance) {
    const base = channelManualSettingsComplete(brokerFallback) ? brokerFallback : defaultManual;
    const partial = existing && typeof existing === 'object' && !Array.isArray(existing)
        && !isMinimalSeedManualSettings(existing)
        ? existing
        : {};
    return (0, normalizeManualSettings_1.normalizeManualSettingsForExecution)({
        ...base,
        ...partial,
    }, { accountBalance });
}
function healChannelTradingConfigsMap(broker) {
    const configs = { ...normalizeChannelTradingConfigsMap(broker.channel_trading_configs) };
    const linkedIds = (0, brokerChannelFilter_1.normalizeSignalChannelIds)(broker.signal_channel_ids);
    const multiChannel = linkedIds.length > 1;
    const balance = brokerAccountBalance(broker);
    const brokerFallbackManual = (0, normalizeManualSettings_1.normalizeManualSettingsForExecution)(broker.manual_settings, { accountBalance: balance });
    const defaultManual = (0, normalizeManualSettings_1.normalizeManualSettingsForExecution)(buildDefaultChannelTradingConfig().manual_settings);
    const fallbackMode = (broker.copier_mode ?? 'manual');
    // broker.manual_settings mirrors the last channel saved in Account Configuration —
    // never use it to heal other linked channels or lot/style bleed across providers.
    const healBrokerFallback = multiChannel ? defaultManual : brokerFallbackManual;
    for (const channelId of linkedIds) {
        const key = normalizeChannelUuid(channelId);
        if (!key)
            continue;
        if (storedPerChannelConfigComplete(configs, key))
            continue;
        const existing = resolveChannelConfigEntry(configs, key);
        const manual = mergeHealedChannelManualSettings(existing?.manual_settings, healBrokerFallback, defaultManual, balance);
        if (!channelManualSettingsComplete(manual)) {
            console.warn(`[channelTradingConfig] healed incomplete per-channel config for ${key}`
                + ' — open Account Configuration, set lot + Single/Multi, Save');
        }
        else if (!existing?.manual_settings || !channelManualSettingsComplete(existing.manual_settings)) {
            console.warn(`[channelTradingConfig] healed missing per-channel config for ${key}`
                + (multiChannel
                    ? ' from defaults — re-save Account Configuration for this channel'
                    : ' from broker manual_settings / defaults — re-save Account Configuration for this channel'));
        }
        configs[key] = {
            copier_mode: existing?.copier_mode ?? fallbackMode,
            manual_settings: manual,
            ai_settings: (existing?.ai_settings ?? broker.ai_settings ?? {}),
            copy_limit_state: existing?.copy_limit_state,
        };
    }
    return configs;
}
function buildDefaultChannelTradingConfig() {
    return {
        copier_mode: 'manual',
        manual_settings: (0, normalizeManualSettings_1.normalizeManualSettingsForExecution)({
            fixed_lot: 0.01,
            trade_style: 'single',
            risk_mode: 'fixed_lot',
        }),
        ai_settings: {},
    };
}
/** Per-channel manual_settings must include fixed_lot and trade_style before execution. */
function channelManualSettingsComplete(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return false;
    const normalized = (0, normalizeManualSettings_1.normalizeManualSettingsForExecution)(raw);
    const lot = Number(normalized.fixed_lot);
    const style = normalized.trade_style;
    return Number.isFinite(lot) && lot > 0 && (style === 'single' || style === 'multi');
}
/**
 * Migration/connect paths persist a tiny default row ({ fixed_lot: 0.01, trade_style: single, … })
 * that looks "complete" but was never configured in the UI. Treat as incomplete so broker
 * manual_settings can heal it.
 */
function isMinimalSeedManualSettings(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return true;
    const row = raw;
    if ('schema_version' in row)
        return false;
    if (row.copy_limits != null && typeof row.copy_limits === 'object')
        return false;
    if (!channelManualSettingsComplete(row))
        return true;
    const keys = Object.keys(row).filter(k => row[k] !== undefined && row[k] !== null);
    if (keys.length > 4)
        return false;
    const lot = Number(row.fixed_lot);
    const style = row.trade_style;
    const risk = row.risk_mode;
    return lot === 0.01 && style === 'single' && (risk === 'fixed_lot' || risk == null);
}
function storedPerChannelConfigComplete(configs, channelId) {
    const entry = resolveChannelConfigEntry(configs, channelId);
    if (!entry)
        return false;
    if (isMinimalSeedManualSettings(entry.manual_settings))
        return false;
    return channelManualSettingsComplete(entry.manual_settings);
}
function channelConfigReadyForExecution(broker, channelId) {
    const normalizedChannelId = normalizeChannelUuid(channelId);
    if (!normalizedChannelId) {
        return { ready: true, source: 'unlinked' };
    }
    const linked = (0, brokerChannelFilter_1.normalizeSignalChannelIds)(broker.signal_channel_ids);
    const linkedNormalized = linked.map(id => normalizeChannelUuid(id)).filter(Boolean);
    if (!linkedNormalized.includes(normalizedChannelId)) {
        return { ready: true, source: 'unlinked' };
    }
    const healed = healChannelTradingConfigsMap(broker);
    const entry = resolveChannelConfigEntry(healed, normalizedChannelId);
    if (!entry) {
        return { ready: false, reason: 'channel_config_missing', channelId: normalizedChannelId };
    }
    if (!channelManualSettingsComplete(entry.manual_settings)) {
        return { ready: false, reason: 'channel_config_incomplete', channelId: normalizedChannelId };
    }
    return { ready: true, source: 'per_channel' };
}
function resolveChannelTradingConfig(broker, channelId) {
    const fallbackMode = (broker.copier_mode ?? 'manual');
    const balance = brokerAccountBalance(broker);
    const fallbackManual = (0, normalizeManualSettings_1.normalizeManualSettingsForExecution)(broker.manual_settings, { accountBalance: balance });
    const fallbackAi = (broker.ai_settings ?? {});
    if (!channelId) {
        return {
            copier_mode: fallbackMode,
            manual_settings: fallbackManual,
            ai_settings: fallbackAi,
            config_source: 'unlinked',
        };
    }
    const configs = healChannelTradingConfigsMap(broker);
    const channelConfig = resolveChannelConfigEntry(configs, channelId);
    const ready = channelConfigReadyForExecution(broker, channelId);
    if (ready.ready && ready.source === 'per_channel' && channelConfig) {
        return {
            copier_mode: channelConfig.copier_mode ?? fallbackMode,
            manual_settings: (0, normalizeManualSettings_1.normalizeManualSettingsForExecution)(channelConfig.manual_settings, { accountBalance: balance }),
            ai_settings: (channelConfig.ai_settings ?? fallbackAi),
            config_source: 'per_channel',
        };
    }
    if (ready.ready && ready.source === 'unlinked') {
        return {
            copier_mode: fallbackMode,
            manual_settings: fallbackManual,
            ai_settings: fallbackAi,
            config_source: 'broker_fallback',
        };
    }
    // Linked channel without complete per-channel config — caller must skip execution.
    return {
        copier_mode: fallbackMode,
        manual_settings: fallbackManual,
        ai_settings: fallbackAi,
        config_source: 'broker_fallback',
    };
}
function withChannelTradingConfig(broker, channelId) {
    const resolved = resolveChannelTradingConfig(broker, channelId);
    return {
        ...broker,
        copier_mode: resolved.copier_mode,
        manual_settings: resolved.manual_settings,
        ai_settings: resolved.ai_settings,
    };
}
