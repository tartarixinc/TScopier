"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NewsTradingMonitor = void 0;
const blackout_1 = require("./newsTrading/blackout");
const calendarProvider_1 = require("./newsTrading/calendarProvider");
const settings_1 = require("./newsTrading/settings");
const fxsocketClient_1 = require("./fxsocketClient");
const mtApiByAccount_1 = require("./mtApiByAccount");
const channelTradingConfig_1 = require("./channelTradingConfig");
const copierPause_1 = require("./copierPause");
const TICK_MS = 60000;
class NewsTradingMonitor {
    constructor(supabase) {
        this.supabase = supabase;
        this.timer = null;
        this.ticking = false;
        /** brokerId|eventId → closed at ms */
        this.closedForEvent = new Map();
    }
    start() {
        if (this.timer)
            return;
        if (!(0, fxsocketClient_1.hasFxsocketConfigured)()) {
            console.warn('[newsTradingMonitor] MT API not configured — monitor disabled');
            return;
        }
        this.timer = setInterval(() => {
            if (this.ticking)
                return;
            this.ticking = true;
            this.tick()
                .catch(err => {
                console.error('[newsTradingMonitor] tick error:', err instanceof Error ? err.message : String(err));
            })
                .finally(() => { this.ticking = false; });
        }, TICK_MS);
        console.log(`[newsTradingMonitor] started (interval=${TICK_MS}ms)`);
    }
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
    async tick() {
        const events = await (0, calendarProvider_1.getCalendarEventsCached)();
        if (!events.length)
            return;
        const { data, error } = await this.supabase
            .from('broker_accounts')
            .select('id,user_id,fxsocket_account_id,metaapi_account_id,platform,manual_settings,channel_trading_configs,copier_mode,ai_settings,is_active')
            .eq('is_active', true)
            .not('fxsocket_account_id', 'is', null);
        if (error) {
            console.error('[newsTradingMonitor] broker select failed:', error.message);
            return;
        }
        const brokers = (data ?? []);
        if (!brokers.length)
            return;
        const platformByUuid = await (0, mtApiByAccount_1.loadPlatformByFxsocketId)(this.supabase, brokers.map(b => (0, mtApiByAccount_1.brokerSessionId)(b)));
        const now = new Date();
        this.pruneClosedMap(now);
        for (const broker of brokers) {
            if ((0, copierPause_1.isUserCopierPausedCached)(broker.user_id))
                continue;
            const uuid = (0, mtApiByAccount_1.brokerSessionId)(broker);
            if (!uuid)
                continue;
            const api = (0, mtApiByAccount_1.apiForFxsocketAccount)(platformByUuid, uuid);
            if (!api)
                continue;
            const { data: trades, error: tradeErr } = await this.supabase
                .from('trades')
                .select('id,user_id,broker_account_id,metaapi_order_id,symbol,signal_id')
                .eq('broker_account_id', broker.id)
                .eq('status', 'open');
            if (tradeErr) {
                console.warn(`[newsTradingMonitor] trades select failed broker=${broker.id}: ${tradeErr.message}`);
                continue;
            }
            const openTrades = (trades ?? []);
            if (!openTrades.length)
                continue;
            const signalIds = [...new Set(openTrades.map(t => t.signal_id).filter(Boolean))];
            const channelBySignal = new Map();
            if (signalIds.length) {
                const { data: signals } = await this.supabase
                    .from('signals')
                    .select('id, channel_id')
                    .in('id', signalIds);
                for (const row of signals ?? []) {
                    channelBySignal.set(row.id, row.channel_id ?? null);
                }
            }
            const triggersByChannel = new Map();
            const getTriggers = (channelId) => {
                const key = channelId ?? '__legacy__';
                if (!triggersByChannel.has(key)) {
                    const resolved = (0, channelTradingConfig_1.resolveChannelTradingConfig)(broker, channelId);
                    const manual = resolved.manual_settings;
                    if ((0, settings_1.isNewsTradingEnabled)(manual)) {
                        triggersByChannel.set(key, []);
                    }
                    else {
                        triggersByChannel.set(key, (0, blackout_1.findPreNewsCloseTriggers)(events, manual, now));
                    }
                }
                return triggersByChannel.get(key) ?? [];
            };
            const eventsToProcess = new Map();
            for (const trade of openTrades) {
                const channelId = trade.signal_id ? (channelBySignal.get(trade.signal_id) ?? null) : null;
                for (const trigger of getTriggers(channelId)) {
                    eventsToProcess.set(trigger.id, trigger);
                }
            }
            if (!eventsToProcess.size)
                continue;
            for (const event of eventsToProcess.values()) {
                const dedupeKey = `${broker.id}|${event.id}`;
                if (this.closedForEvent.has(dedupeKey))
                    continue;
                const toClose = openTrades.filter(trade => {
                    const channelId = trade.signal_id ? (channelBySignal.get(trade.signal_id) ?? null) : null;
                    return getTriggers(channelId).some(t => t.id === event.id);
                });
                if (!toClose.length) {
                    this.closedForEvent.set(dedupeKey, now.getTime());
                    continue;
                }
                let closed = 0;
                for (const t of toClose) {
                    const ticket = Number(t.metaapi_order_id);
                    if (!Number.isFinite(ticket) || ticket <= 0)
                        continue;
                    try {
                        await api.orderClose(uuid, { ticket });
                        await this.supabase
                            .from('trades')
                            .update({ status: 'closed', closed_at: new Date().toISOString() })
                            .eq('id', t.id);
                        closed += 1;
                    }
                    catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        console.warn(`[newsTradingMonitor] close failed trade=${t.id} broker=${broker.id}: ${msg}`);
                    }
                }
                if (closed > 0) {
                    console.log(`[newsTradingMonitor] pre-news close broker=${broker.id} event=${event.event} closed=${closed}`);
                    try {
                        await this.supabase.from('trade_execution_logs').insert({
                            user_id: broker.user_id,
                            broker_account_id: broker.id,
                            action: 'news_pre_close',
                            status: 'success',
                            request_payload: {
                                event_id: event.id,
                                event: event.event,
                                currency: event.currency,
                                closed_trades: closed,
                            },
                        });
                    }
                    catch {
                        // best-effort
                    }
                }
                this.closedForEvent.set(dedupeKey, now.getTime());
            }
        }
    }
    pruneClosedMap(now) {
        const cutoff = now.getTime() - 6 * 60 * 60000;
        for (const [k, t] of this.closedForEvent) {
            if (t < cutoff)
                this.closedForEvent.delete(k);
        }
    }
}
exports.NewsTradingMonitor = NewsTradingMonitor;
