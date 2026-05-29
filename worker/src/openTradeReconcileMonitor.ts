import type { SupabaseClient } from '@supabase/supabase-js'
import { hasMetatraderApiConfigured } from './metatraderapi'
import { apiForMetaapiAccount, loadPlatformByMetaapiId, type PlatformByMetaapiId } from './mtApiByAccount'
import {
  applyShardToQuery,
  hasWorkOnShard,
  monitorActiveIntervalMs,
  monitorIdleIntervalMs,
  startMonitorLoop,
  type MonitorLoopHandle,
} from './monitorIdleGate'
import { reconcileOpenTradesForBroker, type OpenTradeReconcileRow } from './openTradeReconcile'

interface BrokerRow {
  id: string
  metaapi_account_id: string
}

const ACTIVE_MS = monitorActiveIntervalMs('OPEN_TRADE_RECONCILE_TICK_MS', 30_000)
const IDLE_MS = monitorIdleIntervalMs('OPEN_TRADE_RECONCILE_IDLE_MS', 120_000)
const BATCH_LIMIT = 500

export class OpenTradeReconcileMonitor {
  private loop: MonitorLoopHandle | null = null
  private ticking = false
  private platformByUuid: PlatformByMetaapiId = new Map()

  constructor(private readonly supabase: SupabaseClient) {}

  start() {
    if (this.loop) return
    if (!hasMetatraderApiConfigured()) {
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
        .select('id,broker_account_id,metaapi_order_id')
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
      .select('id,metaapi_account_id')
      .in('id', brokerIds)

    if (brokerErr) {
      console.warn(`[openTradeReconcileMonitor] broker load failed: ${brokerErr.message}`)
      return
    }

    const uuids = ((brokers ?? []) as BrokerRow[])
      .map(b => String(b.metaapi_account_id ?? '').trim())
      .filter(uuid => uuid.length > 0 && !uuid.includes('|'))
    this.platformByUuid = await loadPlatformByMetaapiId(this.supabase, uuids)

    let totalClosed = 0
    for (const broker of (brokers ?? []) as BrokerRow[]) {
      const uuid = String(broker.metaapi_account_id ?? '').trim()
      if (!uuid || uuid.includes('|')) continue
      const api = apiForMetaapiAccount(this.platformByUuid, uuid)
      if (!api) continue

      const openForBroker = byBroker.get(broker.id) ?? []
      if (!openForBroker.length) continue

      try {
        try {
          const alive = await api.keepSessionAlive(uuid)
          if (!alive) continue
        } catch {
          continue
        }

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
      }
    }

    if (totalClosed > 0) {
      console.log(`[openTradeReconcileMonitor] tick closed ${totalClosed} stale open trade(s)`)
    }
  }
}
