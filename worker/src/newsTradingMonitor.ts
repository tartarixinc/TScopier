import type { SupabaseClient } from '@supabase/supabase-js'
import { findPreNewsCloseTriggers } from './newsTrading/blackout'
import { getCalendarEventsCached } from './newsTrading/calendarProvider'
import { isNewsTradingEnabled, type ScheduleFilterSettings } from './newsTrading/settings'
import { hasFxsocketConfigured } from './fxsocketClient'
import { apiForFxsocketAccount, brokerSessionId, loadPlatformByFxsocketId } from './mtApiByAccount'
import { resolveChannelTradingConfig } from './channelTradingConfig'
import { isUserCopierPausedCached } from './copierPause'

interface BrokerRow {
  id: string
  user_id: string
  fxsocket_account_id: string | null
  metaapi_account_id: string | null
  platform: string
  manual_settings: Record<string, unknown> | null
  channel_trading_configs: Record<string, unknown> | null
  copier_mode: string | null
  ai_settings: Record<string, unknown> | null
  is_active: boolean
}

interface OpenTradeRow {
  id: string
  user_id: string
  broker_account_id: string | null
  metaapi_order_id: string | null
  symbol: string
  signal_id: string | null
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
    if (!hasFxsocketConfigured()) {
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
      .select('id,user_id,fxsocket_account_id,metaapi_account_id,platform,manual_settings,channel_trading_configs,copier_mode,ai_settings,is_active')
      .eq('is_active', true)
      .not('fxsocket_account_id', 'is', null)
    if (error) {
      console.error('[newsTradingMonitor] broker select failed:', error.message)
      return
    }

    const brokers = (data ?? []) as BrokerRow[]
    if (!brokers.length) return

    const platformByUuid = await loadPlatformByFxsocketId(
      this.supabase,
      brokers.map(b => brokerSessionId(b)),
    )

    const now = new Date()
    this.pruneClosedMap(now)

    for (const broker of brokers) {
      if (isUserCopierPausedCached(broker.user_id)) continue

      const uuid = brokerSessionId(broker)
      if (!uuid) continue
      const api = apiForFxsocketAccount(platformByUuid, uuid)
      if (!api) continue

      const { data: trades, error: tradeErr } = await this.supabase
        .from('trades')
        .select('id,user_id,broker_account_id,metaapi_order_id,symbol,signal_id')
        .eq('broker_account_id', broker.id)
        .eq('status', 'open')
      if (tradeErr) {
        console.warn(`[newsTradingMonitor] trades select failed broker=${broker.id}: ${tradeErr.message}`)
        continue
      }

      const openTrades = (trades ?? []) as OpenTradeRow[]
      if (!openTrades.length) continue

      const signalIds = [...new Set(openTrades.map(t => t.signal_id).filter(Boolean))] as string[]
      const channelBySignal = new Map<string, string | null>()
      if (signalIds.length) {
        const { data: signals } = await this.supabase
          .from('signals')
          .select('id, channel_id')
          .in('id', signalIds)
        for (const row of signals ?? []) {
          channelBySignal.set(row.id as string, (row.channel_id as string | null) ?? null)
        }
      }

      const triggersByChannel = new Map<string, ReturnType<typeof findPreNewsCloseTriggers>>()
      const getTriggers = (channelId: string | null) => {
        const key = channelId ?? '__legacy__'
        if (!triggersByChannel.has(key)) {
          const resolved = resolveChannelTradingConfig(broker, channelId)
          const manual = resolved.manual_settings as ScheduleFilterSettings
          if (isNewsTradingEnabled(manual)) {
            triggersByChannel.set(key, [])
          } else {
            triggersByChannel.set(key, findPreNewsCloseTriggers(events, manual, now))
          }
        }
        return triggersByChannel.get(key) ?? []
      }

      const eventsToProcess = new Map<string, typeof events[number]>()
      for (const trade of openTrades) {
        const channelId = trade.signal_id ? (channelBySignal.get(trade.signal_id) ?? null) : null
        for (const trigger of getTriggers(channelId)) {
          eventsToProcess.set(trigger.id, trigger)
        }
      }
      if (!eventsToProcess.size) continue

      for (const event of eventsToProcess.values()) {
        const dedupeKey = `${broker.id}|${event.id}`
        if (this.closedForEvent.has(dedupeKey)) continue

        const toClose = openTrades.filter(trade => {
          const channelId = trade.signal_id ? (channelBySignal.get(trade.signal_id) ?? null) : null
          return getTriggers(channelId).some(t => t.id === event.id)
        })
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
