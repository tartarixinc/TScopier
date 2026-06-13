import type { SupabaseClient } from '@supabase/supabase-js'
import { hasMetatraderApiConfigured } from './metatraderapi'
import { apiForMetaapiAccount, loadPlatformByMetaapiId, type PlatformByMetaapiId } from './mtApiByAccount'
import {
  fetchOpenBrokerTickets,
  loadOpenBasketLegs,
  markBasketReconcileDone,
  parsePerLegTargets,
  reconcileBackoffMs,
  runBasketLegModifies,
  type BasketReconcileJobRow,
  type BasketSymbolParams,
} from './basketSlTpReconcile'
import {
  applyShardToQuery,
  hasWorkOnShard,
  monitorActiveIntervalMs,
  monitorIdleIntervalMs,
  startMonitorLoop,
  type MonitorLoopHandle,
} from './monitorIdleGate'
import { normalizeManualSettingsForExecution } from './manualPlanning/normalizeManualSettings'
import { resolveChannelTradingConfig } from './channelTradingConfig'
import { normalizeSymbolParams } from './metatraderapi'
import { isUserCopierPausedCached } from './copierPause'

const ACTIVE_MS = monitorActiveIntervalMs('BASKET_RECONCILE_TICK_MS', 15_000)
const IDLE_MS = monitorIdleIntervalMs('BASKET_RECONCILE_IDLE_MS', 120_000)
const BATCH_LIMIT = 20
const HOST_ID = `worker-${process.pid}`

export class BasketSlTpReconcileMonitor {
  private loop: MonitorLoopHandle | null = null
  private ticking = false
  private platformByUuid: PlatformByMetaapiId = new Map()

  constructor(private readonly supabase: SupabaseClient) {}

  start() {
    if (this.loop) return
    if (!hasMetatraderApiConfigured()) {
      console.warn('[basketSlTpReconcileMonitor] MT4API_BASIC_USER/PASSWORD missing — disabled')
      return
    }
    this.loop = startMonitorLoop({
      name: 'basketSlTpReconcileMonitor',
      supabase: this.supabase,
      activeIntervalMs: ACTIVE_MS,
      idleIntervalMs: IDLE_MS,
      hasWork: (sb) => {
        const now = new Date().toISOString()
        return hasWorkOnShard(sb, 'basket_reconcile_jobs', q =>
          q.eq('status', 'pending').lte('next_run_at', now),
        )
      },
      tick: () => this.runTick(),
    })
    console.log(`[basketSlTpReconcileMonitor] started active=${ACTIVE_MS}ms idle=${IDLE_MS}ms`)
  }

  stop() {
    this.loop?.stop()
    this.loop = null
  }

  getLoopHandle(): MonitorLoopHandle | null {
    return this.loop
  }

  private async runTick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      await this.tick()
    } finally {
      this.ticking = false
    }
  }

  private async tick(): Promise<void> {
    const now = new Date().toISOString()
    const { data: jobs, error } = await this.supabase
      .from('basket_reconcile_jobs')
      .select('*')
      .eq('status', 'pending')
      .lte('next_run_at', now)
      .order('next_run_at', { ascending: true })
      .limit(BATCH_LIMIT)

    if (error) {
      console.warn(`[basketSlTpReconcileMonitor] select failed: ${error.message}`)
      return
    }

    for (const raw of (jobs ?? []) as BasketReconcileJobRow[]) {
      if (raw.attempts >= raw.max_attempts) {
        await this.supabase
          .from('basket_reconcile_jobs')
          .update({ status: 'failed', updated_at: new Date().toISOString() })
          .eq('id', raw.id)
        continue
      }
      await this.processJob(raw)
    }
  }

  private async processJob(job: BasketReconcileJobRow): Promise<void> {
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
      .maybeSingle()

    if (claimErr || !claimed) return

    const row = claimed as BasketReconcileJobRow
    const { data: broker } = await this.supabase
      .from('broker_accounts')
      .select('id,user_id,metaapi_account_id,platform,default_lot_size,manual_settings,channel_trading_configs,copier_mode,ai_settings')
      .eq('id', row.broker_account_id)
      .maybeSingle()

    if (!broker?.metaapi_account_id) {
      await this.releaseJob(row.id, 'broker not found', row.attempts)
      return
    }

    if (isUserCopierPausedCached(String(broker.user_id ?? ''))) {
      await this.releaseJob(row.id, 'copier paused', row.attempts)
      return
    }

    const uuid = broker.metaapi_account_id as string
    if (uuid.includes('|')) {
      await this.releaseJob(row.id, 'invalid metaapi uuid', row.attempts)
      return
    }

    this.platformByUuid = await loadPlatformByMetaapiId(this.supabase, [uuid])
    const api = apiForMetaapiAccount(this.platformByUuid, uuid)
    if (!api) {
      await this.releaseJob(row.id, 'MT API not configured', row.attempts)
      return
    }

    try {
      const alive = await api.keepSessionAlive(uuid)
      if (!alive) {
        await this.releaseJob(row.id, 'broker session not connected', row.attempts)
        return
      }
    } catch (err) {
      await this.releaseJob(row.id, (err as Error).message, row.attempts)
      return
    }

    const familyTrades = await loadOpenBasketLegs(
      this.supabase,
      row.broker_account_id,
      row.anchor_signal_id,
      row.symbol,
    )

    if (!familyTrades.length) {
      await markBasketReconcileDone(this.supabase, row.id)
      return
    }

    const perLegTargets = parsePerLegTargets(row.per_leg_targets)
    if (!perLegTargets.length) {
      await this.releaseJob(row.id, 'empty per_leg_targets', row.attempts)
      return
    }

    let params: BasketSymbolParams | null = null
    try {
      const sp = await api.symbolParams(uuid, row.symbol)
      const n = normalizeSymbolParams(sp)
      params = {
        digits: n.digits ?? 5,
        point: n.point ?? 0.00001,
        minLot: n.minLot ?? 0.01,
        lotStep: n.lotStep ?? 0.01,
        contractSize: n.contractSize ?? null,
        stopsLevel: n.stopsLevel ?? 0,
        freezeLevel: n.freezeLevel ?? 0,
      }
    } catch { /* optional */ }

    const openedTickets = await fetchOpenBrokerTickets(api, uuid)
    const baseLot = Number(broker.default_lot_size ?? 0.01)
    const { data: anchorSig } = await this.supabase
      .from('signals')
      .select('parsed_data, channel_id')
      .eq('id', row.anchor_signal_id)
      .maybeSingle()
    const anchorParsed = (anchorSig as { parsed_data?: { tp?: number[] }; channel_id?: string | null } | null)?.parsed_data
    const anchorChannelId = (anchorSig as { channel_id?: string | null } | null)?.channel_id ?? null
    const manual = normalizeManualSettingsForExecution(
      resolveChannelTradingConfig(
        broker as Parameters<typeof resolveChannelTradingConfig>[0],
        anchorChannelId,
      ).manual_settings,
    )
    const signalTps = Array.isArray(anchorParsed?.tp)
      ? anchorParsed.tp.filter(
          (t): t is number => typeof t === 'number' && Number.isFinite(t) && t > 0,
        )
      : []
    const { summary, legErrors } = await runBasketLegModifies({
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
    })

    const mergeFailed = summary.modified < summary.openLegs
    const partialMsg = mergeFailed
      ? `Reconcile: ${summary.modified}/${summary.openLegs} legs`
        + (summary.failed > 0 ? `; ${summary.failed} broker errors` : '')
      : null

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
        } as unknown as Record<string, unknown>,
      })
    } catch { /* best-effort */ }

    if (!mergeFailed) {
      await markBasketReconcileDone(this.supabase, row.id)
      await this.supabase
        .from('signals')
        .update({ status: 'executed' })
        .eq('id', row.source_signal_id)
        .eq('status', 'parsed')
      return
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
        .eq('id', row.id)
      return
    }

    const backoff = reconcileBackoffMs(row.attempts)
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
      .eq('id', row.id)
  }

  private async releaseJob(jobId: string, err: string, attempts: number): Promise<void> {
    const backoff = reconcileBackoffMs(attempts)
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
      .eq('id', jobId)
  }
}
