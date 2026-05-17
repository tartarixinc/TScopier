"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NewsTradingMonitor = void 0;
const blackout_1 = require("./newsTrading/blackout");
const calendarProvider_1 = require("./newsTrading/calendarProvider");
const settings_1 = require("./newsTrading/settings");
const metatraderapi_1 = require("./metatraderapi");
const mtApiByAccount_1 = require("./mtApiByAccount");
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
        if (!(0, metatraderapi_1.hasMetatraderApiConfigured)()) {
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
            .select('id,user_id,metaapi_account_id,platform,manual_settings,is_active')
            .eq('is_active', true)
            .not('metaapi_account_id', 'is', null);
        if (error) {
            console.error('[newsTradingMonitor] broker select failed:', error.message);
            return;
        }
        const brokers = (data ?? []);
        const newsBrokers = brokers.filter(b => {
            const manual = (b.manual_settings ?? {});
            return !(0, settings_1.isNewsTradingEnabled)(manual);
        });
        if (!newsBrokers.length)
            return;
        const platformByUuid = await (0, mtApiByAccount_1.loadPlatformByMetaapiId)(this.supabase, newsBrokers.map(b => String(b.metaapi_account_id ?? '')));
        const now = new Date();
        this.pruneClosedMap(now);
        for (const broker of newsBrokers) {
            const manual = (broker.manual_settings ?? {});
            const triggers = (0, blackout_1.findPreNewsCloseTriggers)(events, manual, now);
            if (!triggers.length)
                continue;
            const uuid = broker.metaapi_account_id;
            const api = (0, mtApiByAccount_1.apiForMetaapiAccount)(platformByUuid, uuid);
            if (!api)
                continue;
            for (const event of triggers) {
                const dedupeKey = `${broker.id}|${event.id}`;
                if (this.closedForEvent.has(dedupeKey))
                    continue;
                const { data: trades, error: tradeErr } = await this.supabase
                    .from('trades')
                    .select('id,user_id,broker_account_id,metaapi_order_id,symbol')
                    .eq('broker_account_id', broker.id)
                    .eq('status', 'open');
                if (tradeErr) {
                    console.warn(`[newsTradingMonitor] trades select failed broker=${broker.id}: ${tradeErr.message}`);
                    continue;
                }
                const toClose = (trades ?? []);
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
