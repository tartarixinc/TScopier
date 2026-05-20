import type { SupabaseClient } from '@supabase/supabase-js'
import { hasMetatraderApiConfigured, getMetatraderApi, mtPlatformFrom } from './metatraderapi'
import { writeBrokerConnectionStatus } from './brokerConnectionStatus'
import {
  applyShardToQuery,
  hasWorkOnShard,
  monitorActiveIntervalMs,
  monitorIdleIntervalMs,
  startMonitorLoop,
  type MonitorLoopHandle,
} from './monitorIdleGate'

function isMtUuid(s: string | null | undefined): boolean {
  if (!s) return false
  const v = s.trim()
  if (!v || v.includes('|')) return false
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
}

interface BrokerRow {
  id: string
  platform: string
  metaapi_account_id: string | null
  connection_status: string | null
}

/**
 * Keeps MetatraderAPI sessions alive with lightweight CheckConnect pings.
 * Only calls ConnectByToken when the session is down; avoids flipping status on transient blips.
 */
const RECONNECT_ACTIVE_MS = monitorActiveIntervalMs(
  'BROKER_RECONNECT_INTERVAL_MS',
  Math.max(60_000, Number(process.env.BROKER_RECONNECT_INTERVAL_MS ?? 300_000) || 300_000),
)
const RECONNECT_IDLE_MS = monitorIdleIntervalMs('BROKER_RECONNECT_IDLE_MS', 300_000)

export class BrokerConnectionMonitor {
  private reconnectLoop: MonitorLoopHandle | null = null
  private readonly failStreak = new Map<string, number>()

  constructor(private readonly supabase: SupabaseClient) {}

  start() {
    // Keepalive pings run in TradeExecutor.sessionHeartbeatTick (in-memory broker cache).
    // This monitor only handles reconnect sweeps and connection_status updates.
    if (!this.reconnectLoop) {
      this.reconnectLoop = startMonitorLoop({
        name: 'brokerConnectionReconnect',
        supabase: this.supabase,
        activeIntervalMs: RECONNECT_ACTIVE_MS,
        idleIntervalMs: RECONNECT_IDLE_MS,
        hasWork: sb => hasWorkOnShard(sb, 'broker_accounts', q => q.eq('is_active', true)),
        tick: () => this.reconnectTick(),
      })
      console.log(`[brokerConnection] reconnect sweep active=${RECONNECT_ACTIVE_MS}ms idle=${RECONNECT_IDLE_MS}ms`)
    }
  }

  stop() {
    this.reconnectLoop?.stop()
    this.reconnectLoop = null
  }

  getLoopHandles(): MonitorLoopHandle[] {
    return [this.reconnectLoop].filter(Boolean) as MonitorLoopHandle[]
  }

  private clientFor(platform: string) {
    return getMetatraderApi(mtPlatformFrom(platform))
  }

  private async reconnectTick() {
    if (!hasMetatraderApiConfigured()) return
    const brokersQ = await applyShardToQuery(
      this.supabase,
      this.supabase
        .from('broker_accounts')
        .select('id,platform,metaapi_account_id,connection_status')
        .eq('is_active', true),
    )
    if (!brokersQ) return
    const { data, error } = await brokersQ
    if (error) {
      console.warn('[brokerConnection] load brokers failed:', error.message)
      return
    }
    const rows = (data ?? []) as BrokerRow[]
    let ok = 0
    let failed = 0
    for (const row of rows) {
      const uuid = row.metaapi_account_id?.trim()
      if (!isMtUuid(uuid)) continue
      const api = this.clientFor(row.platform)
      if (!api) continue
      const ready = await api.verifyTradingReady(uuid!)
      if (ready) {
        this.failStreak.delete(row.id)
        ok++
      } else {
        const streak = (this.failStreak.get(row.id) ?? 0) + 1
        this.failStreak.set(row.id, streak)
        failed++
        if (streak >= 2 && row.connection_status !== 'error') {
          console.warn(`[brokerConnection] session down broker=${row.id} (streak=${streak})`)
          await writeBrokerConnectionStatus(this.supabase, row.id, 'error')
        }
      }
    }
    if (ok > 0 || failed > 0) {
      console.log(`[brokerConnection] tick: ${ok} alive, ${failed} down`)
    }
  }
}
