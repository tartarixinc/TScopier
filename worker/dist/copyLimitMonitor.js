"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CopyLimitMonitor = void 0;
const copyLimitEvaluate_1 = require("./copyLimitEvaluate");
const copyLimitMetrics_1 = require("./copyLimitMetrics");
const copyLimitTypes_1 = require("./copyLimitTypes");
const channelTradingConfig_1 = require("./channelTradingConfig");
const TICK_MS = 60000;
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
            .select('id,user_id,metaapi_account_id,platform,last_balance,last_equity,is_active')
            .in('id', brokerIds)
            .eq('is_active', true);
        if (brokerErr) {
            console.error('[copyLimitMonitor] broker select failed:', brokerErr.message);
            return;
        }
        const brokerById = new Map((brokers ?? []).map(b => [b.id, b]));
        for (const row of activeRows) {
            const broker = brokerById.get(row.broker_account_id);
            if (!broker?.metaapi_account_id)
                continue;
            const channelId = (0, channelTradingConfig_1.normalizeChannelUuid)(row.channel_id);
            if (!channelId)
                continue;
            const config = (0, copyLimitTypes_1.normalizeCopyLimits)(row.manual_settings?.copy_limits);
            const profileTz = await this.resolveUserTimezone(broker.user_id);
            const timeZone = (0, copyLimitEvaluate_1.resolveCopyLimitTimezone)(config, profileTz);
            const referenceEquity = (0, copyLimitMetrics_1.resolveReferenceEquity)(broker.last_equity, broker.last_balance);
            if (referenceEquity <= 0)
                continue;
            let state = (0, copyLimitTypes_1.normalizeCopyLimitState)(row.copy_limit_state);
            const pnlByPeriod = new Map();
            const loadPnl = async (period) => {
                const key = period;
                if (!pnlByPeriod.has(key)) {
                    pnlByPeriod.set(key, await (0, copyLimitMetrics_1.buildChannelPnlSnapshot)({
                        supabase: this.supabase,
                        brokerAccountId: broker.id,
                        channelId,
                        metaapiAccountId: broker.metaapi_account_id,
                        platform: broker.platform,
                        period,
                        timeZone,
                    }));
                }
                return pnlByPeriod.get(key);
            };
            const primaryPeriod = config.profit_targets.find(t => t.enabled)?.period
                ?? config.max_risks.find(r => r.enabled)?.period
                ?? 'daily';
            const primaryPnl = await loadPnl(primaryPeriod);
            state = (0, copyLimitEvaluate_1.updatePeriodSnapshots)({
                state,
                config,
                pnl: primaryPnl,
                referenceEquity,
                timeZone,
            });
            const breaches = [];
            for (const period of new Set([
                ...config.profit_targets.filter(t => t.enabled).map(t => t.period),
                ...(config.max_risk_enabled
                    ? config.max_risks.filter(r => r.enabled).map(r => r.period)
                    : []),
            ])) {
                const pnl = await loadPnl(period);
                const peak = Math.max((0, copyLimitEvaluate_1.peakChannelPnlForPeriod)(state, period, timeZone), pnl.totalPnl);
                const periodMaxRisks = config.max_risks.filter(r => r.enabled && r.period === period);
                const subset = {
                    ...config,
                    profit_targets: config.profit_targets.filter(t => t.enabled && t.period === period),
                    max_risk_enabled: config.max_risk_enabled && periodMaxRisks.length > 0,
                    max_risks: periodMaxRisks,
                };
                breaches.push(...(0, copyLimitEvaluate_1.evaluateCopyLimitBreaches)({
                    config: subset,
                    state,
                    pnl,
                    referenceEquity,
                    peakChannelPnl: peak,
                    timeZone,
                }));
            }
            if (breaches.length) {
                state = (0, copyLimitEvaluate_1.mergeBreachesIntoState)(state, breaches);
                console.log(`[copyLimitMonitor] limit hit broker=${broker.id} channel=${channelId}`
                    + ` breaches=${breaches.map(b => b.pauseKey).join(',')}`);
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
