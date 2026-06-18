"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CopyLimitMonitor = void 0;
const copyLimitEvaluate_1 = require("./copyLimitEvaluate");
const copyLimitMetrics_1 = require("./copyLimitMetrics");
const copyLimitFlatten_1 = require("./copyLimitFlatten");
const copyLimitTypes_1 = require("./copyLimitTypes");
const channelTradingConfig_1 = require("./channelTradingConfig");
const copierPause_1 = require("./copierPause");
const mtApiByAccount_1 = require("./mtApiByAccount");
const TICK_MS = 30000;
class CopyLimitMonitor {
    constructor(supabase) {
        this.supabase = supabase;
        this.timer = null;
        this.ticking = false;
        this.userTimezoneCache = new Map();
    }
    start() {
        if (this.timer)
            return;
        this.timer = setInterval(() => {
            if (this.ticking)
                return;
            this.ticking = true;
            this.tick()
                .catch(err => {
                console.error('[copyLimitMonitor] tick error:', err instanceof Error ? err.message : String(err));
            })
                .finally(() => { this.ticking = false; });
        }, TICK_MS);
        this.timer.unref?.();
        console.log(`[copyLimitMonitor] started (interval=${TICK_MS}ms)`);
    }
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
    async resolveUserTimezone(userId) {
        const cached = this.userTimezoneCache.get(userId);
        if (cached)
            return cached;
        const { data } = await this.supabase
            .from('user_profiles')
            .select('timezone')
            .eq('user_id', userId)
            .maybeSingle();
        const tz = String(data?.timezone ?? 'UTC').trim() || 'UTC';
        this.userTimezoneCache.set(userId, tz);
        return tz;
    }
    async tick() {
        const { data: configRows, error } = await this.supabase
            .from('broker_channel_trading_configs')
            .select('broker_account_id,channel_id,manual_settings,copy_limit_state');
        if (error) {
            console.error('[copyLimitMonitor] config select failed:', error.message);
            return;
        }
        const rows = (configRows ?? []);
        const activeRows = rows.filter(row => {
            const limits = (0, copyLimitTypes_1.normalizeCopyLimits)(row.manual_settings?.copy_limits);
            return (0, copyLimitEvaluate_1.copyLimitsActive)(limits);
        });
        if (!activeRows.length)
            return;
        const brokerIds = [...new Set(activeRows.map(r => r.broker_account_id))];
        const { data: brokers, error: brokerErr } = await this.supabase
            .from('broker_accounts')
            .select('id,user_id,fxsocket_account_id,metaapi_account_id,platform,last_balance,last_equity,is_active')
            .in('id', brokerIds)
            .eq('is_active', true);
        if (brokerErr) {
            console.error('[copyLimitMonitor] broker select failed:', brokerErr.message);
            return;
        }
        const brokerById = new Map((brokers ?? []).map(b => [b.id, b]));
        for (const row of activeRows) {
            const broker = brokerById.get(row.broker_account_id);
            if (!broker)
                continue;
            const sessionId = (0, mtApiByAccount_1.brokerSessionId)(broker);
            if (!sessionId)
                continue;
            if ((0, copierPause_1.isUserCopierPausedCached)(broker.user_id))
                continue;
            const channelId = (0, channelTradingConfig_1.normalizeChannelUuid)(row.channel_id);
            if (!channelId)
                continue;
            const config = (0, copyLimitTypes_1.normalizeCopyLimits)(row.manual_settings?.copy_limits);
            const profileTz = await this.resolveUserTimezone(broker.user_id);
            const timeZone = (0, copyLimitEvaluate_1.resolveCopyLimitTimezone)(config, profileTz);
            const fallbackEquity = (0, copyLimitMetrics_1.resolveReferenceEquity)(broker.last_equity, broker.last_balance);
            if (fallbackEquity <= 0)
                continue;
            const currentEquity = await (0, copyLimitMetrics_1.fetchLiveAccountEquity)(sessionId, broker.platform, fallbackEquity, { lastBalance: broker.last_balance });
            if (currentEquity <= 0)
                continue;
            let state = (0, copyLimitTypes_1.normalizeCopyLimitState)(row.copy_limit_state);
            state = (0, copyLimitEvaluate_1.updatePeriodSnapshots)({
                state,
                config,
                currentEquity,
                timeZone,
            });
            const breaches = [];
            for (const period of new Set([
                ...config.profit_targets.filter(t => t.enabled).map(t => t.period),
                ...(config.max_risk_enabled
                    ? config.max_risks.filter(r => r.enabled).map(r => r.period)
                    : []),
            ])) {
                const equity = (0, copyLimitEvaluate_1.periodEquitySnapshot)(state, period, currentEquity, timeZone);
                const periodMaxRisks = config.max_risks.filter(r => r.enabled && r.period === period);
                const subset = {
                    ...config,
                    profit_targets: config.profit_targets.filter(t => t.enabled && t.period === period),
                    max_risk_enabled: config.max_risk_enabled && periodMaxRisks.length > 0,
                    max_risks: periodMaxRisks,
                };
                // Channel-scoped P/L (realized + live floating) as a secondary trigger —
                // fires the limit even when the account-equity delta lags or is skewed.
                const channelSnapshot = await (0, copyLimitMetrics_1.buildChannelPnlSnapshot)({
                    supabase: this.supabase,
                    brokerAccountId: broker.id,
                    channelId,
                    metaapiAccountId: sessionId,
                    platform: broker.platform,
                    period,
                    timeZone,
                });
                breaches.push(...(0, copyLimitEvaluate_1.evaluateCopyLimitBreaches)({
                    config: subset,
                    state,
                    equity,
                    timeZone,
                    channelPnl: channelSnapshot.totalPnl,
                }));
            }
            // Drop pauses whose rule was edited/removed since the breach (e.g. the
            // user raised the profit target); still-breaching rules are re-added
            // below with their current fingerprint.
            state = (0, copyLimitEvaluate_1.reconcilePausedKeysWithConfig)(state, config, new Set(breaches.map(b => b.pauseKey)));
            if (breaches.length) {
                const prevPaused = new Set(state.paused_period_keys);
                const flattened = new Set(state.flattened_pause_keys ?? []);
                const newlyPaused = breaches.filter(b => !prevPaused.has(b.pauseKey));
                state = (0, copyLimitEvaluate_1.mergeBreachesIntoState)(state, breaches);
                const shouldFlatten = newlyPaused.some(b => !flattened.has(b.pauseKey));
                if (shouldFlatten) {
                    const flattenReason = newlyPaused[0].reason;
                    await (0, copyLimitFlatten_1.flattenChannelTradesForCopyLimit)({
                        supabase: this.supabase,
                        userId: broker.user_id,
                        brokerAccountId: broker.id,
                        metaapiAccountId: sessionId,
                        platform: broker.platform,
                        channelId,
                        reason: flattenReason,
                    });
                    state = {
                        ...state,
                        flattened_pause_keys: [
                            ...new Set([
                                ...(state.flattened_pause_keys ?? []),
                                ...newlyPaused.map(b => b.pauseKey),
                            ]),
                        ],
                    };
                }
                console.log(`[copyLimitMonitor] limit hit broker=${broker.id} channel=${channelId}`
                    + ` equity=${currentEquity.toFixed(2)}`
                    + ` breaches=${breaches.map(b => b.pauseKey).join(',')}`
                    + ` flattened=${shouldFlatten}`);
            }
            const { error: updErr } = await this.supabase
                .from('broker_channel_trading_configs')
                .update({ copy_limit_state: state })
                .eq('broker_account_id', row.broker_account_id)
                .eq('channel_id', row.channel_id);
            if (updErr) {
                console.warn(`[copyLimitMonitor] state update failed: ${updErr.message}`);
            }
        }
    }
}
exports.CopyLimitMonitor = CopyLimitMonitor;
