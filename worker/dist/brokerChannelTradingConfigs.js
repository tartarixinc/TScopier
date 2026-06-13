"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.channelTradingConfigsMapFromRows = channelTradingConfigsMapFromRows;
exports.mergeChannelTradingConfigsFromTable = mergeChannelTradingConfigsFromTable;
exports.fetchBrokerChannelTradingConfigRows = fetchBrokerChannelTradingConfigRows;
exports.fetchBrokerChannelTradingConfigRow = fetchBrokerChannelTradingConfigRow;
exports.applyBrokerChannelTradingConfigRow = applyBrokerChannelTradingConfigRow;
exports.fetchFreshBrokerForChannel = fetchFreshBrokerForChannel;
const channelTradingConfig_1 = require("./channelTradingConfig");
const copyLimitTypes_1 = require("./copyLimitTypes");
const BROKER_CHANNEL_TRADING_CONFIG_SELECT = 'broker_account_id,channel_id,copier_mode,manual_settings,ai_settings,copy_limit_state';
function ensurePersistedManualSettings(settings) {
    const schemaVersion = Number(settings.schema_version ?? 1);
    return {
        ...settings,
        schema_version: Number.isFinite(schemaVersion) && schemaVersion > 0 ? schemaVersion : 1,
    };
}
function channelTradingConfigsMapFromRows(rows) {
    const out = {};
    for (const row of rows) {
        const key = (0, channelTradingConfig_1.normalizeChannelUuid)(row.channel_id);
        if (!key)
            continue;
        out[key] = {
            copier_mode: row.copier_mode === 'ai' ? 'ai' : 'manual',
            manual_settings: ensurePersistedManualSettings(row.manual_settings && typeof row.manual_settings === 'object'
                ? row.manual_settings
                : {}),
            ai_settings: row.ai_settings && typeof row.ai_settings === 'object' ? row.ai_settings : {},
            copy_limit_state: (0, copyLimitTypes_1.normalizeCopyLimitState)(row.copy_limit_state),
        };
    }
    return out;
}
function mergeChannelTradingConfigsFromTable(jsonbConfigs, tableRows) {
    const fromTable = channelTradingConfigsMapFromRows(tableRows);
    const jsonbMap = (0, channelTradingConfig_1.normalizeChannelTradingConfigsMap)(jsonbConfigs);
    return { ...jsonbMap, ...fromTable };
}
async function fetchBrokerChannelTradingConfigRows(supabase, brokerAccountIds) {
    if (!brokerAccountIds.length)
        return [];
    const { data, error } = await supabase
        .from('broker_channel_trading_configs')
        .select(BROKER_CHANNEL_TRADING_CONFIG_SELECT)
        .in('broker_account_id', brokerAccountIds);
    if (error) {
        console.error('[brokerChannelTradingConfigs] fetch failed:', error.message);
        return [];
    }
    return (data ?? []);
}
/** Latest per-channel row — table wins over stale `broker_accounts.channel_trading_configs`. */
async function fetchBrokerChannelTradingConfigRow(supabase, brokerAccountId, channelId) {
    const key = (0, channelTradingConfig_1.normalizeChannelUuid)(channelId);
    if (!key)
        return null;
    const { data, error } = await supabase
        .from('broker_channel_trading_configs')
        .select(BROKER_CHANNEL_TRADING_CONFIG_SELECT)
        .eq('broker_account_id', brokerAccountId)
        .eq('channel_id', key)
        .maybeSingle();
    if (error) {
        console.warn(`[brokerChannelTradingConfigs] fetch row failed broker=${brokerAccountId} channel=${key}: ${error.message}`);
        return null;
    }
    return (data ?? null);
}
function applyBrokerChannelTradingConfigRow(broker, configRow) {
    return {
        ...broker,
        channel_trading_configs: mergeChannelTradingConfigsFromTable(broker.channel_trading_configs, [configRow]),
    };
}
/**
 * Merge the persisted per-channel table row into a cached broker before execution.
 * UI saves land in `broker_channel_trading_configs` without touching `broker_accounts`,
 * so the in-memory cache can miss `range_trading` / leg caps until restart.
 */
async function fetchFreshBrokerForChannel(supabase, broker, channelId) {
    if (!channelId)
        return broker;
    const row = await fetchBrokerChannelTradingConfigRow(supabase, broker.id, channelId);
    if (!row)
        return broker;
    return applyBrokerChannelTradingConfigRow(broker, row);
}
