import type { SupabaseClient } from '@supabase/supabase-js'
import { hasMetatraderApiConfigured } from './metatraderapi'
import { apiForMetaapiAccount, loadPlatformByMetaapiId, type PlatformByMetaapiId } from './mtApiByAccount'
import {
  cancelSignalEntryRowAtBroker,
  findClosedRowForTicket,
  findOpenedRowByTicket,
  isLikelyMarketPositionRow,
  isPendingEntryRow,
  markSignalEntryFilled,
  markSignalEntryGoneFromBroker,
  rawOrderTicket,
  type SignalEntryPendingRow,
} from './signalEntryPendingHelpers'

const TICK_MS = 2_000
const MISSING_BEFORE_ASSUME_GONE = 6

type MonitorRow = SignalEntryPendingRow & {
  entry_price: number
  cancel_requested_at: string | null
  expires_at: string | null
  partial_tp_plan?: unknown
}

function parsePartialTpPlan(raw: unknown): Array<{ tpIdx: number; triggerPrice: number; closeLots: number }> | null {
  if (!Array.isArray(raw)) return null
  const out: Array<{ tpIdx: number; triggerPrice: number; closeLots: number }> = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const tpIdx = Number(o.tpIdx ?? o.tp_idx)
    const triggerPrice = Number(o.triggerPrice ?? o.trigger_price)
    const closeLots = Number(o.closeLots ?? o.close_lots)
    if (!Number.isFinite(tpIdx) || !Number.isFinite(triggerPrice) || !Number.isFinite(closeLots)) continue
    out.push({ tpIdx, triggerPrice, closeLots })
  }
  return out.length ? out : null
}

function extractOpenPrice(raw: Record<string, unknown>): number | null {
  const num = (v: unknown): number | undefined => {
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string' && v.trim()) {
      const n = Number(v)
      return Number.isFinite(n) ? n : undefined
    }
    return undefined
  }
  const px = num(raw.openPrice ?? raw.OpenPrice ?? raw.price ?? raw.Price ?? raw.priceOpen ?? raw.PriceOpen)
  return px != null && px > 0 ? px : null
}

/**
 * Polls broker + DB for "Use Signal Entry Price" limit orders: applies requested
 * cancels (basket flat), detects fills / manual deletes, and updates `trades`.
 */
export class SignalEntryPendingMonitor {
  private timer: NodeJS.Timeout | null = null
  private platformByUuid: PlatformByMetaapiId = new Map()
  private ticking = false
  /** row id → consecutive ticks where ticket was absent from /OpenedOrders */
  private missingStreak = new Map<string, number>()

  constructor(private readonly supabase: SupabaseClient) {}

  start() {
    if (this.timer) return
    if (!hasMetatraderApiConfigured()) {
      console.warn('[signalEntryPendingMonitor] MT4API_BASIC_USER/PASSWORD missing — signal entry pending monitor disabled')
      return
    }
    this.timer = setInterval(() => {
      if (this.ticking) return
      this.ticking = true
      this.tick()
        .catch(err => console.error('[signalEntryPendingMonitor] tick failed:', err))
        .finally(() => { this.ticking = false })
    }, TICK_MS)
    this.timer.unref?.()
    console.log(`[signalEntryPendingMonitor] started interval=${TICK_MS}ms`)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private async tick(): Promise<void> {
    if (!hasMetatraderApiConfigured()) return

    const { data, error } = await this.supabase
      .from('signal_entry_pending_orders')
      .select(
        'id,signal_id,user_id,broker_account_id,metaapi_account_id,symbol,trade_id,broker_ticket,is_buy,entry_price,cancel_requested_at,expires_at,partial_tp_plan',
      )
      .eq('status', 'broker_pending')
      .limit(200)
    if (error) {
      console.error('[signalEntryPendingMonitor] select failed:', error.message)
      return
    }
    const rows = (data ?? []) as MonitorRow[]
    if (!rows.length) {
      this.missingStreak.clear()
      return
    }

    this.platformByUuid = await loadPlatformByMetaapiId(
      this.supabase,
      rows.map(r => r.metaapi_account_id),
    )

    const nowMs = Date.now()
    const expiredIds = new Set<string>()
    for (const r of rows) {
      if (!r.expires_at) continue
      const t = Date.parse(r.expires_at)
      if (Number.isFinite(t) && t <= nowMs) expiredIds.add(r.id)
    }
    const cancelRows = rows.filter(r => !expiredIds.has(r.id) && r.cancel_requested_at)
    const watchRows = rows.filter(r => !expiredIds.has(r.id) && !r.cancel_requested_at)

    for (const row of rows) {
      if (!expiredIds.has(row.id)) continue
      const api = apiForMetaapiAccount(this.platformByUuid, row.metaapi_account_id)
      if (api) await cancelSignalEntryRowAtBroker(this.supabase, api, row, 'expired')
    }

    for (const row of cancelRows) {
      const api = apiForMetaapiAccount(this.platformByUuid, row.metaapi_account_id)
      if (api) await cancelSignalEntryRowAtBroker(this.supabase, api, row, 'cancel_requested')
    }

    const byAccount = new Map<string, MonitorRow[]>()
    for (const r of watchRows) {
      const k = r.metaapi_account_id
      const list = byAccount.get(k) ?? []
      list.push(r)
      byAccount.set(k, list)
    }

    for (const [uuid, group] of byAccount) {
      const api = apiForMetaapiAccount(this.platformByUuid, uuid)
      if (!api) continue
      let opened: unknown[] = []
      try {
        opened = await api.openedOrders(uuid)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[signalEntryPendingMonitor] /OpenedOrders failed account=${uuid}: ${msg}`)
        continue
      }

      const needClosed: MonitorRow[] = []
      for (const row of group) {
        const ticket = Number(row.broker_ticket)
        if (!Number.isFinite(ticket) || ticket <= 0) continue

        const hit = findOpenedRowByTicket(opened, ticket)
        if (hit) {
          if (isPendingEntryRow(hit)) {
            this.missingStreak.delete(row.id)
            continue
          }
          // Do not infer a fill from ambiguous rows (would mark trade open, insert
          // partial_tp_legs, then partialTpMonitor can /OrderClose the pending ticket).
          if (!isLikelyMarketPositionRow(hit)) {
            this.missingStreak.delete(row.id)
            continue
          }
          const px = extractOpenPrice(hit)
          if (px != null) {
            this.missingStreak.delete(row.id)
            const posTicket = rawOrderTicket(hit)
            await markSignalEntryFilled(this.supabase, row, px, {
              partialTpPlan: parsePartialTpPlan(row.partial_tp_plan),
              brokerPositionTicket: posTicket > 0 ? String(posTicket) : undefined,
            })
            continue
          }
        }

        needClosed.push(row)
      }

      let closed: unknown[] = []
      if (needClosed.length) {
        try {
          closed = await api.closedOrders(uuid)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.warn(`[signalEntryPendingMonitor] /ClosedOrders failed account=${uuid}: ${msg}`)
        }
      }

      for (const row of needClosed) {
        const ticket = Number(row.broker_ticket)
        const c = findClosedRowForTicket(closed, ticket)
        if (c) {
          const st = (c.state ?? '').toLowerCase()
          if (st.includes('cancel') || st.includes('reject')) {
            this.missingStreak.delete(row.id)
            await markSignalEntryGoneFromBroker(
              this.supabase,
              row,
              `closed_state=${c.state ?? 'unknown'}`,
            )
            continue
          }
          const px = c.openPrice
          if (px != null && px > 0) {
            this.missingStreak.delete(row.id)
            await markSignalEntryFilled(this.supabase, row, px, {
              partialTpPlan: parsePartialTpPlan(row.partial_tp_plan),
              brokerPositionTicket:
                c.brokerTicket != null && c.brokerTicket > 0 ? String(c.brokerTicket) : undefined,
            })
            continue
          }
        }

        const streak = (this.missingStreak.get(row.id) ?? 0) + 1
        this.missingStreak.set(row.id, streak)
        if (streak >= MISSING_BEFORE_ASSUME_GONE) {
          this.missingStreak.delete(row.id)
          await markSignalEntryGoneFromBroker(
            this.supabase,
            row,
            'pending_order_absent_from_opened_orders',
          )
        }
      }
    }

    const active = new Set(watchRows.map(r => r.id))
    for (const k of this.missingStreak.keys()) {
      if (!active.has(k)) this.missingStreak.delete(k)
    }
  }
}
