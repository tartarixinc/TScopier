"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BasketSlTpReconcileMonitor = void 0;
const metatraderapi_1 = require("./metatraderapi");
const mtApiByAccount_1 = require("./mtApiByAccount");
const basketSlTpReconcile_1 = require("./basketSlTpReconcile");
const normalizeManualSettings_1 = require("./manualPlanning/normalizeManualSettings");
const metatraderapi_2 = require("./metatraderapi");
const TICK_INTERVAL_MS = Math.min(60000, Math.max(5000, Number(process.env.BASKET_RECONCILE_TICK_MS ?? 15000)));
const BATCH_LIMIT = 20;
const HOST_ID = `worker-${process.pid}`;
class BasketSlTpReconcileMonitor {
    constructor(supabase) {
        this.supabase = supabase;
        this.timer = null;
        this.ticking = false;
        this.platformByUuid = new Map();
    }
    start() {
        if (this.timer)
            return;
        if (!(0, metatraderapi_1.hasMetatraderApiConfigured)()) {
            console.warn('[basketSlTpReconcileMonitor] MT4API_BASIC_USER/PASSWORD missing — disabled');
            return;
        }
        this.timer = setInterval(() => {
            if (this.ticking)
                return;
            this.ticking = true;
            this.tick()
                .catch(err => console.error('[basketSlTpReconcileMonitor] tick failed:', err))
                .finally(() => { this.ticking = false; });
        }, TICK_INTERVAL_MS);
        this.timer.unref?.();
        console.log(`[basketSlTpReconcileMonitor] started interval=${TICK_INTERVAL_MS}ms`);
    }
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
    async tick() {
        const now = new Date().toISOString();
        const { data: jobs, error } = await this.supabase
            .from('basket_reconcile_jobs')
            .select('*')
            .eq('status', 'pending')
            .lte('next_run_at', now)
            .order('next_run_at', { ascending: true })
            .limit(BATCH_LIMIT);
        if (error) {
            console.warn(`[basketSlTpReconcileMonitor] select failed: ${error.message}`);
            return;
        }
        for (const raw of (jobs ?? [])) {
            if (raw.attempts >= raw.max_attempts) {
                await this.supabase
                    .from('basket_reconcile_jobs')
                    .update({ status: 'failed', updated_at: new Date().toISOString() })
                    .eq('id', raw.id);
                continue;
            }
            await this.processJob(raw);
        }
    }
    async processJob(job) {
        const { data: claimed, error: claimErr } = await this.supabase
            .from('basket_reconcile_jobs')
            .update({
            status: 'claimed',
            locked_at: new Date().toISOString(),
            locked_by: HOST_ID,
            attempts: job.attempts + 1,
            updated_at: new Date().toISOString(),
        })
            .eq('id', job.id)
            .eq('status', 'pending')
            .select('*')
            .maybeSingle();
        if (claimErr || !claimed)
            return;
        const row = claimed;
        const { data: broker } = await this.supabase
            .from('broker_accounts')
            .select('id,user_id,metaapi_account_id,platform,default_lot_size,manual_settings')
            .eq('id', row.broker_account_id)
            .maybeSingle();
        if (!broker?.metaapi_account_id) {
            await this.releaseJob(row.id, 'broker not found', row.attempts);
            return;
        }
        const uuid = broker.metaapi_account_id;
        if (uuid.includes('|')) {
            await this.releaseJob(row.id, 'invalid metaapi uuid', row.attempts);
            return;
        }
        this.platformByUuid = await (0, mtApiByAccount_1.loadPlatformByMetaapiId)(this.supabase, [uuid]);
        const api = (0, mtApiByAccount_1.apiForMetaapiAccount)(this.platformByUuid, uuid);
        if (!api) {
            await this.releaseJob(row.id, 'MT API not configured', row.attempts);
            return;
        }
        try {
            const alive = await api.keepSessionAlive(uuid);
            if (!alive) {
                await this.releaseJob(row.id, 'broker session not connected', row.attempts);
                return;
            }
        }
        catch (err) {
            await this.releaseJob(row.id, err.message, row.attempts);
            return;
        }
        const familyTrades = await (0, basketSlTpReconcile_1.loadOpenBasketLegs)(this.supabase, row.broker_account_id, row.anchor_signal_id, row.symbol);
        if (!familyTrades.length) {
            await (0, basketSlTpReconcile_1.markBasketReconcileDone)(this.supabase, row.id);
            return;
        }
        const perLegTargets = (0, basketSlTpReconcile_1.parsePerLegTargets)(row.per_leg_targets);
        if (!perLegTargets.length) {
            await this.releaseJob(row.id, 'empty per_leg_targets', row.attempts);
            return;
        }
        let params = null;
        try {
            const sp = await api.symbolParams(uuid, row.symbol);
            const n = (0, metatraderapi_2.normalizeSymbolParams)(sp);
            params = {
                digits: n.digits ?? 5,
                point: n.point ?? 0.00001,
                minLot: n.minLot ?? 0.01,
                lotStep: n.lotStep ?? 0.01,
                contractSize: n.contractSize ?? null,
                stopsLevel: n.stopsLevel ?? 0,
                freezeLevel: n.freezeLevel ?? 0,
            };
        }
        catch { /* optional */ }
        const openedTickets = await (0, basketSlTpReconcile_1.fetchOpenBrokerTickets)(api, uuid);
        const baseLot = Number(broker.default_lot_size ?? 0.01);
        const manual = (0, normalizeManualSettings_1.normalizeManualSettingsForExecution)(broker.manual_settings);
        const { data: anchorSig } = await this.supabase
            .from('signals')
            .select('parsed_data')
            .eq('id', row.anchor_signal_id)
            .maybeSingle();
        const anchorParsed = anchorSig?.parsed_data;
        const signalTps = Array.isArray(anchorParsed?.tp)
            ? anchorParsed.tp.filter((t) => typeof t === 'number' && Number.isFinite(t) && t > 0)
            : [];
        const { summary, legErrors } = await (0, basketSlTpReconcile_1.runBasketLegModifies)({
            supabase: this.supabase,
            api,
            uuid,
            symbol: row.symbol,
            direction: row.direction,
            baseLot,
            params,
            signalId: row.source_signal_id,
            userId: row.user_id,
            brokerAccountId: row.broker_account_id,
            familyTrades,
            perLegTargets,
            signalTps,
            tpLots: manual.tp_lots,
            nImmCwe: row.n_imm_cwe ?? 0,
            overrideTp: row.override_tp,
            strictEntryPrefetch: null,
            openedTickets,
            skipAlreadySynced: true,
        });
        const mergeFailed = summary.modified < summary.openLegs;
        const partialMsg = mergeFailed
            ? `Reconcile: ${summary.modified}/${summary.openLegs} legs`
                + (summary.failed > 0 ? `; ${summary.failed} broker errors` : '')
            : null;
        try {
            await this.supabase.from('trade_execution_logs').insert({
                user_id: row.user_id,
                signal_id: row.source_signal_id,
                broker_account_id: row.broker_account_id,
                action: 'basket_reconcile_tick',
                status: mergeFailed ? 'failed' : 'success',
                error_message: partialMsg,
                request_payload: {
                    job_id: row.id,
                    anchor_signal_id: row.anchor_signal_id,
                    ...summary,
                    leg_errors: legErrors.slice(0, 5),
                },
            });
        }
        catch { /* best-effort */ }
        if (!mergeFailed) {
            await (0, basketSlTpReconcile_1.markBasketReconcileDone)(this.supabase, row.id);
            await this.supabase
                .from('signals')
                .update({ status: 'executed' })
                .eq('id', row.source_signal_id)
                .eq('status', 'parsed');
            return;
        }
        if (row.attempts >= row.max_attempts) {
            await this.supabase
                .from('basket_reconcile_jobs')
                .update({
                status: 'failed',
                last_error: partialMsg,
                locked_at: null,
                locked_by: null,
                updated_at: new Date().toISOString(),
            })
                .eq('id', row.id);
            return;
        }
        const backoff = (0, basketSlTpReconcile_1.reconcileBackoffMs)(row.attempts);
        await this.supabase
            .from('basket_reconcile_jobs')
            .update({
            status: 'pending',
            last_error: partialMsg,
            next_run_at: new Date(Date.now() + backoff).toISOString(),
            locked_at: null,
            locked_by: null,
            updated_at: new Date().toISOString(),
        })
            .eq('id', row.id);
    }
    async releaseJob(jobId, err, attempts) {
        const backoff = (0, basketSlTpReconcile_1.reconcileBackoffMs)(attempts);
        await this.supabase
            .from('basket_reconcile_jobs')
            .update({
            status: 'pending',
            last_error: err,
            next_run_at: new Date(Date.now() + backoff).toISOString(),
            locked_at: null,
            locked_by: null,
            updated_at: new Date().toISOString(),
        })
            .eq('id', jobId);
    }
}
exports.BasketSlTpReconcileMonitor = BasketSlTpReconcileMonitor;
