import type { SupabaseClient } from '@supabase/supabase-js'
import { hasMetatraderApiConfigured, getMetatraderApi, mtPlatformFrom } from './metatraderapi'

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
export class BrokerConnectionMonitor {
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false
  private readonly failStreak = new Map<string, number>()

  constructor(private readonly supabase: SupabaseClient) {}

  start() {
    if (this.timer) return
    const intervalMs = Math.max(
      60_000,
      Number(process.env.BROKER_RECONNECT_INTERVAL_MS ?? 300_000) || 300_000,
    )
    void this.tick()
    this.timer = setInterval(() => {
      void this.tick()
    }, intervalMs)
    this.timer.unref?.()
    console.log(`[brokerConnection] started (every ${intervalMs}ms)`)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private clientFor(platform: string) {
    return getMetatraderApi(mtPlatformFrom(platform))
  }

  private async tick() {
    if (!hasMetatraderApiConfigured()) return
    if (this.running) return
    this.running = true
    try {
      const { data, error } = await this.supabase
        .from('broker_accounts')
        .select('id,platform,metaapi_account_id,connection_status')
        .eq('is_active', true)
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
        const alive = await api.keepSessionAlive(uuid!)
        if (alive) {
          this.failStreak.delete(row.id)
          if (row.connection_status !== 'connected') {
            await this.supabase
              .from('broker_accounts')
              .update({ connection_status: 'connected' })
              .eq('id', row.id)
          }
          ok++
        } else {
          const streak = (this.failStreak.get(row.id) ?? 0) + 1
          this.failStreak.set(row.id, streak)
          failed++
          if (streak >= 2 && row.connection_status !== 'error') {
            console.warn(`[brokerConnection] session down broker=${row.id} (streak=${streak})`)
            await this.supabase
              .from('broker_accounts')
              .update({ connection_status: 'error' })
              .eq('id', row.id)
          }
        }
      }
      if (ok > 0 || failed > 0) {
        console.log(`[brokerConnection] tick: ${ok} alive, ${failed} down`)
      }
    } finally {
      this.running = false
    }
  }
}
