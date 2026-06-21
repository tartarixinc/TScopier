"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Live broker E2E probe: DB state + optional MT quote + auto-BE dry-run math.
 * Usage: cd worker && npx ts-node -r dotenv/config src/diagnostics/liveBrokerE2eCheck.ts
 */
require("dotenv/config");
const supabase_js_1 = require("@supabase/supabase-js");
const autoManagement_1 = require("../autoManagement");
const manualStops_1 = require("../manualPlanning/manualStops");
const signalPip_1 = require("../signalPip");
const fxsocketClient_1 = require("../fxsocketClient");
const mtApiByAccount_1 = require("../mtApiByAccount");
const supabase = (0, supabase_js_1.createClient)(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
async function main() {
    console.log('=== Live broker E2E check ===\n');
    console.log('MT API configured:', (0, fxsocketClient_1.hasFxsocketConfigured)());
    console.log('Supabase:', process.env.SUPABASE_URL?.replace(/https?:\/\//, '').split('/')[0]);
    const { data: brokers, error: bErr } = await supabase
        .from('broker_accounts')
        .select('id,user_id,platform,is_active,connection_status,copier_mode,fxsocket_account_id,metaapi_account_id,manual_settings,channel_trading_configs')
        .eq('is_active', true)
        .eq('connection_status', 'connected');
    if (bErr)
        throw bErr;
    console.log('\nConnected brokers:', brokers?.length ?? 0);
    let channelPreSl = 0;
    let channelPreTp = 0;
    let channelAutoBe = 0;
    for (const b of brokers ?? []) {
        const ms = (b.manual_settings ?? {});
        const cfgs = (b.channel_trading_configs ?? {});
        for (const cfg of Object.values(cfgs)) {
            const cms = cfg?.manual_settings ?? {};
            if (cms.use_predefined_sl_pips === true)
                channelPreSl++;
            if (cms.use_predefined_tp_pips === true)
                channelPreTp++;
            const mode = String(cms.move_sl_to_entry_after_mode ?? 'none');
            if (mode !== 'none' && mode !== '')
                channelAutoBe++;
        }
        console.log(`- ${b.id.slice(0, 8)} ${b.platform} channels=${Object.keys(cfgs).length} brokerAutoBe=${ms.move_sl_to_entry_after_mode ?? 'none'}`);
    }
    console.log(`Channel configs enabled: predefined SL=${channelPreSl}, TP=${channelPreTp}, autoBe=${channelAutoBe}`);
    const since7d = new Date(Date.now() - 7 * 86400000).toISOString();
    for (const action of ['auto_be', 'auto_be_half', 'trailing_stop', 'basket_leg_modify']) {
        const { count } = await supabase
            .from('trade_execution_logs')
            .select('id', { count: 'exact', head: true })
            .eq('action', action)
            .gte('created_at', since7d);
        console.log(`Logs 7d ${action}:`, count ?? 0);
    }
    const { data: autoTrades } = await supabase
        .from('trades')
        .select('id,broker_account_id,telegram_channel_id,symbol,direction,entry_price,sl,tp,lot_size,auto_be_mode,auto_be_trigger_value,auto_be_offset_pips,auto_be_risk_sl,auto_be_applied_at,opened_at')
        .eq('status', 'open')
        .not('auto_be_mode', 'is', null)
        .is('auto_be_applied_at', null)
        .order('opened_at', { ascending: false })
        .limit(10);
    console.log('\nOpen trades awaiting auto-BE:', autoTrades?.length ?? 0);
    if (!(0, fxsocketClient_1.hasFxsocketConfigured)()) {
        console.log('\nSKIP MT quote / trigger dry-run — MT4API_BASIC_USER/PASSWORD not set locally.');
        console.log('Deploy trade_mgmt worker with MT API creds to apply auto-BE on open trades.');
        return;
    }
    const brokerById = new Map((brokers ?? []).map(b => [b.id, b]));
    const uuids = [...new Set((brokers ?? []).map(b => (0, mtApiByAccount_1.brokerSessionId)(b)).filter(Boolean))];
    const platformByUuid = await (0, mtApiByAccount_1.loadPlatformByFxsocketId)(supabase, uuids);
    for (const trade of autoTrades ?? []) {
        const broker = brokerById.get(trade.broker_account_id ?? '');
        const uuid = broker ? (0, mtApiByAccount_1.brokerSessionId)(broker) : '';
        if (!uuid)
            continue;
        const api = (0, mtApiByAccount_1.apiForFxsocketAccount)(platformByUuid, uuid);
        if (!api) {
            console.log(`  ${trade.symbol} ${trade.direction}: no API client for ${uuid.slice(0, 8)}`);
            continue;
        }
        try {
            const q = await api.quote(uuid, trade.symbol);
            const isBuy = trade.direction === 'buy';
            const entry = Number(trade.entry_price);
            const pip = (0, signalPip_1.signalPipPrice)(trade.symbol);
            const mode = String(trade.auto_be_mode);
            const triggerMet = (0, autoManagement_1.isAutoBeTriggerMet)({
                mode,
                triggerValue: Number(trade.auto_be_trigger_value ?? 10),
                tpIndex: 1,
                isBuy,
                entryPrice: entry,
                riskSl: trade.auto_be_risk_sl != null ? Number(trade.auto_be_risk_sl) : null,
                bid: q.bid,
                ask: q.ask,
                pipPrice: pip,
                pipValuePerLot: pip * Number(trade.lot_size ?? 0.01),
                partialTpFiredIndices: [],
                partialTpTriggers: [],
                brokerTp: trade.tp != null ? Number(trade.tp) : null,
            });
            const profitPips = isBuy
                ? (q.bid - entry) / pip
                : (entry - q.ask) / pip;
            console.log(`  ${trade.symbol} ${trade.direction} entry=${entry} sl=${trade.sl} mode=${mode}`
                + ` trigger=${trade.auto_be_trigger_value} profitPips=${profitPips.toFixed(1)} met=${triggerMet}`);
        }
        catch (err) {
            console.log(`  ${trade.symbol}: quote failed — ${err instanceof Error ? err.message : err}`);
        }
    }
    // Predefined stops dry-run on sample XAUUSD buy @ 4500
    const sampleBroker = brokers?.find(b => Object.keys((b.channel_trading_configs ?? {})).length > 0);
    if (sampleBroker) {
        const cfgs = (sampleBroker.channel_trading_configs ?? {});
        const first = Object.entries(cfgs).find(([, c]) => c.manual_settings?.use_predefined_sl_pips === true || c.manual_settings?.use_predefined_tp_pips === true);
        if (first) {
            const [, cfg] = first;
            const manual = cfg.manual_settings ?? {};
            const derived = (0, manualStops_1.deriveManualStopsWithClamp)({
                parsed: { action: 'buy', symbol: 'XAUUSD', sl: 4490, tp: [4510], entry_price: null },
                manual: manual,
                channelKeywords: null,
                resolvedSymbol: 'XAUUSD',
                ctx: { point: 0.01, digits: 2, minLot: 0.01, lotStep: 0.01, contractSize: 100, stopsLevel: 0, freezeLevel: 0, defaultLot: 0.01, lastBalance: null },
                entryAnchor: 4500,
                isBuy: true,
            });
            console.log('\nPredefined stops dry-run (entry=4500 buy):', {
                finalSl: derived.finalSl,
                finalTps: derived.finalTps,
            });
        }
    }
}
main().catch(err => {
    console.error(err);
    process.exit(1);
});
