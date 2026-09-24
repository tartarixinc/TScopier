import type { SupabaseClient } from '@supabase/supabase-js'
import { hasFxsocketConfigured } from './fxsocketClient'
import { apiForFxsocketAccount, brokerSessionId, loadPlatformByFxsocketId, type PlatformByFxsocketId } from './mtApiByAccount'
import {
  applyShardToQuery,
  hasWorkOnShard,
  monitorActiveIntervalMs,
  monitorIdleIntervalMs,
  startMonitorLoop,
  type MonitorLoopHandle,
} from './monitorIdleGate'
import { reconcileOpenTradesForBroker, type OpenTradeReconcileRow } from './openTradeReconcile'
import { captureBusinessIssue } from './observability/businessEvents'
import { availableRemoteBrokers, type RemoteBrokerState } from './brokerRemoteAvailability'

interface BrokerRow extends RemoteBrokerState {
  id: string
  fxsocket_account_id: string | null
  metaapi_account_id: string | null
}

const ACTIVE_MS = monitorActiveIntervalMs('OPEN_TRADE_RECONCILE_TICK_MS', 30_000)
const IDLE_MS = monitorIdleIntervalMs('OPEN_TRADE_RECONCILE_IDLE_MS', 120_000)
const BATCH_LIMIT = 500

export class OpenTradeReconcileMonitor {
  private loop: MonitorLoopHandle | null = null
  private ticking = false
  private platformByUuid: PlatformByFxsocketId = new Map()

  constructor(private readonly supabase: SupabaseClient) {}

  start() {
    if (this.loop) return
    if (!hasFxsocketConfigured()) {
      console.warn('[openTradeReconcileMonitor] MT4API_BASIC_USER/PASSWORD missing — disabled')
      return
    }
    this.loop = startMonitorLoop({
      name: 'openTradeReconcileMonitor',
      supabase: this.supabase,
      activeIntervalMs: ACTIVE_MS,
      idleIntervalMs: IDLE_MS,
      hasWork: sb => hasWorkOnShard(sb, 'trades', q => q.eq('status', 'open')),
      tick: () => this.runTick(),
    })
    console.log(`[openTradeReconcileMonitor] started active=${ACTIVE_MS}ms idle=${IDLE_MS}ms`)
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
    const tradesQ = await applyShardToQuery(
      this.supabase,
      this.supabase
        .from('trades')
        .select('id,signal_id,broker_account_id,metaapi_order_id')
        .eq('status', 'open')
        .not('broker_account_id', 'is', null)
        .limit(BATCH_LIMIT),
    )
    if (!tradesQ) return

    const { data, error } = await tradesQ
    if (error) {
      console.warn(`[openTradeReconcileMonitor] select failed: ${error.message}`)
      return
    }

    const rows = (data ?? []) as OpenTradeReconcileRow[]
    if (!rows.length) return

    const byBroker = new Map<string, OpenTradeReconcileRow[]>()
    for (const row of rows) {
      const brokerId = row.broker_account_id
      if (!brokerId) continue
      const list = byBroker.get(brokerId) ?? []
      list.push(row)
      byBroker.set(brokerId, list)
    }

    const brokerIds = [...byBroker.keys()]
    const { data: brokers, error: brokerErr } = await this.supabase
      .from('broker_accounts')
      .select('id,fxsocket_account_id,metaapi_account_id,fxsocket_status,connection_status,terminal_connected,trade_allowed')
      .in('id', brokerIds)

    if (brokerErr) {
      console.warn(`[openTradeReconcileMonitor] broker load failed: ${brokerErr.message}`)
      return
    }

    const availableBrokers = availableRemoteBrokers((brokers ?? []) as BrokerRow[])
    const uuids = availableBrokers
      .map(b => brokerSessionId(b))
      .filter(uuid => uuid.length > 0)
    this.platformByUuid = await loadPlatformByFxsocketId(this.supabase, uuids)

    let totalClosed = 0
    for (const broker of availableBrokers) {
      const uuid = brokerSessionId(broker)
      if (!uuid) continue
      const api = apiForFxsocketAccount(this.platformByUuid, uuid)
      if (!api) continue

      const openForBroker = byBroker.get(broker.id) ?? []
      if (!openForBroker.length) continue

      try {
        const closed = await reconcileOpenTradesForBroker(
          this.supabase,
          api,
          uuid,
          openForBroker,
        )
        if (closed > 0) {
          totalClosed += closed
          console.log(
            `[openTradeReconcileMonitor] closed ${closed} stale open trade(s) broker=${broker.id}`,
          )
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[openTradeReconcileMonitor] reconcile failed broker=${broker.id}: ${msg}`)
        captureBusinessIssue({
          category: 'reconciliation',
          event: 'reconciliation_failed',
          severity: 'warning',
          reasonCode: 'OPEN_TRADE_RECONCILE_FAILED',
          message: 'Open trade reconciliation failed for broker account',
          userImpact: 'manual_review_required',
          fingerprint: ['reconciliation_failed', 'open_trade_reconcile', 'OPEN_TRADE_RECONCILE_FAILED'],
          context: {
            broker_account_id: broker.id,
            stage: 'open_trade_reconcile',
            operation: 'open_trade_reconcile',
            extra: { tracked_open_trades: openForBroker.length },
          },
        })
      }
    }

    if (totalClosed > 0) {
      console.log(`[openTradeReconcileMonitor] tick closed ${totalClosed} stale open trade(s)`)
    }
  }
}
