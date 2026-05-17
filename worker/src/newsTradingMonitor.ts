import type { SupabaseClient } from '@supabase/supabase-js'
import { findPreNewsCloseTriggers } from './newsTrading/blackout'
import { getCalendarEventsCached } from './newsTrading/calendarProvider'
import { isNewsTradingEnabled, type ScheduleFilterSettings } from './newsTrading/settings'
import { hasMetatraderApiConfigured } from './metatraderapi'
import { apiForMetaapiAccount, loadPlatformByMetaapiId } from './mtApiByAccount'

interface BrokerRow {
  id: string
  user_id: string
  metaapi_account_id: string
  platform: string
  manual_settings: Record<string, unknown> | null
  is_active: boolean
}

interface OpenTradeRow {
  id: string
  user_id: string
  broker_account_id: string | null
  metaapi_order_id: string | null
  symbol: string
}

const TICK_MS = 60_000

export class NewsTradingMonitor {
  private timer: NodeJS.Timeout | null = null
  private ticking = false
  /** brokerId|eventId → closed at ms */
  private closedForEvent = new Map<string, number>()

  constructor(private readonly supabase: SupabaseClient) {}

  start() {
    if (this.timer) return
    if (!hasMetatraderApiConfigured()) {
      console.warn('[newsTradingMonitor] MT API not configured — monitor disabled')
      return
    }
    this.timer = setInterval(() => {
      if (this.ticking) return
      this.ticking = true
      this.tick()
        .catch(err => {
          console.error('[newsTradingMonitor] tick error:', err instanceof Error ? err.message : String(err))
        })
        .finally(() => { this.ticking = false })
    }, TICK_MS)
    console.log(`[newsTradingMonitor] started (interval=${TICK_MS}ms)`)
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private async tick(): Promise<void> {
    const events = await getCalendarEventsCached()
    if (!events.length) return

    const { data, error } = await this.supabase
      .from('broker_accounts')
      .select('id,user_id,metaapi_account_id,platform,manual_settings,is_active')
      .eq('is_active', true)
      .not('metaapi_account_id', 'is', null)
    if (error) {
      console.error('[newsTradingMonitor] broker select failed:', error.message)
      return
    }

    const brokers = (data ?? []) as BrokerRow[]
    const newsBrokers = brokers.filter(b => {
      const manual = (b.manual_settings ?? {}) as ScheduleFilterSettings
      return !isNewsTradingEnabled(manual)
    })
    if (!newsBrokers.length) return

    const platformByUuid = await loadPlatformByMetaapiId(
      this.supabase,
      newsBrokers.map(b => String(b.metaapi_account_id ?? '')),
    )

    const now = new Date()
    this.pruneClosedMap(now)

    for (const broker of newsBrokers) {
      const manual = (broker.manual_settings ?? {}) as ScheduleFilterSettings
      const triggers = findPreNewsCloseTriggers(events, manual, now)
      if (!triggers.length) continue

      const uuid = broker.metaapi_account_id
      const api = apiForMetaapiAccount(platformByUuid, uuid)
      if (!api) continue

      for (const event of triggers) {
        const dedupeKey = `${broker.id}|${event.id}`
        if (this.closedForEvent.has(dedupeKey)) continue

        const { data: trades, error: tradeErr } = await this.supabase
          .from('trades')
          .select('id,user_id,broker_account_id,metaapi_order_id,symbol')
          .eq('broker_account_id', broker.id)
          .eq('status', 'open')
        if (tradeErr) {
          console.warn(`[newsTradingMonitor] trades select failed broker=${broker.id}: ${tradeErr.message}`)
          continue
        }

        const toClose = (trades ?? []) as OpenTradeRow[]
        if (!toClose.length) {
          this.closedForEvent.set(dedupeKey, now.getTime())
          continue
        }

        let closed = 0
        for (const t of toClose) {
          const ticket = Number(t.metaapi_order_id)
          if (!Number.isFinite(ticket) || ticket <= 0) continue
          try {
            await api.orderClose(uuid, { ticket })
            await this.supabase
              .from('trades')
              .update({ status: 'closed', closed_at: new Date().toISOString() })
              .eq('id', t.id)
            closed += 1
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            console.warn(`[newsTradingMonitor] close failed trade=${t.id} broker=${broker.id}: ${msg}`)
          }
        }

        if (closed > 0) {
          console.log(
            `[newsTradingMonitor] pre-news close broker=${broker.id} event=${event.event} closed=${closed}`,
          )
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
              } as unknown as Record<string, unknown>,
            })
          } catch {
            // best-effort
          }
        }
        this.closedForEvent.set(dedupeKey, now.getTime())
      }
    }
  }

  private pruneClosedMap(now: Date): void {
    const cutoff = now.getTime() - 6 * 60 * 60_000
    for (const [k, t] of this.closedForEvent) {
      if (t < cutoff) this.closedForEvent.delete(k)
    }
  }
}
