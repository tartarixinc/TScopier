import type { SupabaseClient } from '@supabase/supabase-js'
import type { FxsocketBrokerClient } from './fxsocketClient'
import { apiForFxsocketAccount, brokerSessionId, loadPlatformByFxsocketId, type PlatformByFxsocketId } from './mtApiByAccount'
import {
  applyShardToQuery,
  hasWorkOnShard,
  monitorActiveIntervalMs,
  monitorIdleIntervalMs,
  startMonitorLoop,
  type MonitorLoopHandle,
} from './monitorIdleGate'
import {
  closePriceKeysetFilter,
  extractClosePricesByTicket,
  historyWindow,
  nextClosePriceCursor,
  planClosePriceUpdates,
  tallyBrokerBatch,
  type ClosePriceCursor,
  type ClosedTradeClosePriceRow,
} from './closedTradeClosePrice'

type BrokerRow = {
  id: string
  provider?: string | null
  mtapi_session_id?: string | null
  fxsocket_account_id?: string | null
  metaapi_account_id?: string | null
}

const ACTIVE_MS = monitorActiveIntervalMs('CLOSED_TRADE_CLOSE_PRICE_TICK_MS', 60_000)
const IDLE_MS = monitorIdleIntervalMs('CLOSED_TRADE_CLOSE_PRICE_IDLE_MS', 300_000)
const BATCH_LIMIT = 50
const HISTORY_PAGE_SIZE = 500
const MAX_HISTORY_PAGES = 40
const LOOKBACK_MS = 365 * 24 * 60 * 60 * 1000
const FXSOCKET_HISTORY_TIMEOUT_MS = 90_000

/**
 * Backfills `trades.close_price` from broker order history for closed
 * trades that are missing it. Every close path in the worker marks the row
 * closed without the fill price, and broker history is the authoritative
 * source (same rows the dashboard reads), so one writer here documents the
 * exit level for all close paths at once — including rows closed before
 * this column existed. Runs sharded, idempotent (`.is('close_price', null)`
 * on every write), and only within a 365-day window so permanently
 * unmatched tickets cannot wedge the queue after they age out.
 *
 * Batches walk newest-first but carry a keyset cursor past the oldest row
 * of the previous batch, so permanently unfillable rows (stranded broker,
 * vanished ticket) rotate out of the way instead of pinning the head of
 * the queue; the cursor resets whenever a batch is not full.
 */
export class ClosedTradeClosePriceMonitor {
  private loop: MonitorLoopHandle | null = null
  private ticking = false
  private platformByUuid: PlatformByFxsocketId = new Map()
  /** Position of the oldest row in the last processed batch (null = start from newest). Compound on (closed_at, id) — see `ClosePriceCursor`. */
  private cursor: ClosePriceCursor | null = null
  private lastUnmatched = 0
  private lastSkipped = 0
  private capWarnedBrokers = new Set<string>()

  constructor(private readonly supabase: SupabaseClient) {}

  start() {
    if (this.loop) return
    this.loop = startMonitorLoop({
      name: 'closedTradeClosePriceMonitor',
      supabase: this.supabase,
      activeIntervalMs: ACTIVE_MS,
      idleIntervalMs: IDLE_MS,
      hasWork: sb => this.hasWork(sb),
      tick: () => this.runTick(),
    })
    console.log(`[closedTradeClosePriceMonitor] started active=${ACTIVE_MS}ms idle=${IDLE_MS}ms`)
  }

  stop() {
    this.loop?.stop()
    this.loop = null
  }

  getLoopHandle(): MonitorLoopHandle | null {
    return this.loop
  }

  private hasWork(sb: SupabaseClient): Promise<boolean> {
    const since = new Date(Date.now() - LOOKBACK_MS).toISOString()
    return hasWorkOnShard(sb, 'trades', q =>
      q.eq('status', 'closed')
        .is('close_price', null)
        .not('broker_account_id', 'is', null)
        .not('metaapi_order_id', 'is', null)
        .neq('metaapi_order_id', '')
        .gte('closed_at', since),
    )
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
    const since = new Date(Date.now() - LOOKBACK_MS).toISOString()
    let builder = this.supabase
      .from('trades')
      .select('id,broker_account_id,metaapi_order_id,closed_at')
      .eq('status', 'closed')
      .is('close_price', null)
      .not('broker_account_id', 'is', null)
      .not('metaapi_order_id', 'is', null)
      .neq('metaapi_order_id', '')
      .gte('closed_at', since)
    if (this.cursor) {
      builder = builder.or(closePriceKeysetFilter(this.cursor))
    }
    const query = await applyShardToQuery(
      this.supabase,
      builder
        .order('closed_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(BATCH_LIMIT),
    )
    if (!query) return

    const { data, error } = await query
    if (error) {
      console.warn(`[closedTradeClosePriceMonitor] select failed: ${error.message}`)
      return
    }

    const rows = (data ?? []) as ClosedTradeClosePriceRow[]
    if (!rows.length) {
      this.cursor = null
      this.lastUnmatched = 0
      this.lastSkipped = 0
      return
    }

    const byBroker = new Map<string, ClosedTradeClosePriceRow[]>()
    for (const row of rows) {
      if (!row.broker_account_id) continue
      const list = byBroker.get(row.broker_account_id) ?? []
      list.push(row)
      byBroker.set(row.broker_account_id, list)
    }

    const brokerIds = [...byBroker.keys()]
    const { data: brokers, error: brokerErr } = await this.supabase
      .from('broker_accounts')
      .select('id,provider,mtapi_session_id,fxsocket_account_id,metaapi_account_id')
      .in('id', brokerIds)
    if (brokerErr) {
      console.warn(`[closedTradeClosePriceMonitor] broker load failed: ${brokerErr.message}`)
      return
    }

    const brokerRows = (brokers ?? []) as BrokerRow[]
    const responded = new Set(brokerRows.map(b => b.id))
    const uuids = brokerRows.map(b => brokerSessionId(b)).filter(uuid => uuid.length > 0)
    this.platformByUuid = await loadPlatformByFxsocketId(this.supabase, uuids)

    let filled = 0
    let unmatched = 0
    let skipped = 0
    for (const broker of brokerRows) {
      const tradesForBroker = byBroker.get(broker.id) ?? []
      if (!tradesForBroker.length) continue

      const uuid = brokerSessionId(broker)
      if (!uuid) {
        skipped += tradesForBroker.length
        continue
      }
      const api = apiForFxsocketAccount(this.platformByUuid, uuid)
      if (!api) {
        skipped += tradesForBroker.length
        continue
      }
      const provider = broker.provider == null || broker.provider === '' ? 'fxsocket' : broker.provider

      try {
        const window = historyWindow(tradesForBroker)
        const historyRows = await this.fetchHistory(broker.id, api, uuid, provider, window)
        const prices = extractClosePricesByTicket(historyRows, 'trades', provider)
        const updates = planClosePriceUpdates(tradesForBroker, prices)
        let updateErrors = 0
        let confirmed = 0
        for (const update of updates) {
          const { data: updatedRows, error: updateErr } = await this.supabase
            .from('trades')
            .update({ close_price: update.close_price })
            .eq('id', update.id)
            .is('close_price', null)
            .select('id')
          if (updateErr) {
            console.warn(`[closedTradeClosePriceMonitor] update failed trade=${update.id}: ${updateErr.message}`)
            updateErrors += 1
            continue
          }
          if ((updatedRows ?? []).length > 0) confirmed += 1
        }
        const tally = tallyBrokerBatch(tradesForBroker.length, updates.length, confirmed, updateErrors)
        filled += tally.filled
        unmatched += tally.unmatched
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[closedTradeClosePriceMonitor] history read failed broker=${broker.id}: ${msg}`)
        skipped += tradesForBroker.length
      }
    }
    for (const [brokerId, list] of byBroker) {
      if (!responded.has(brokerId)) skipped += list.length
    }

    if (filled > 0 || unmatched !== this.lastUnmatched || skipped !== this.lastSkipped) {
      console.log(
        `[closedTradeClosePriceMonitor] close_price filled=${filled} unmatched=${unmatched} skipped=${skipped} batch=${rows.length}`,
      )
    }
    this.lastUnmatched = unmatched
    this.lastSkipped = skipped

    this.cursor = nextClosePriceCursor(rows, BATCH_LIMIT)
  }

  /**
   * Broker history covering the batch window. FxSocket returns the whole
   * list in one call (with the edge's 90s budget, not the client's 30s
   * default — the window can span a year); MTAPI may truncate, so it is
   * read through the paginated endpoint. Pages are walked NEWEST-first
   * (same as the edge's `orderHistory` pagination) so a deadline cut keeps
   * the most recent rows — the ones the newest-first batch is actually
   * working on — and page 0's probe rows are reused when page 0 is inside
   * the window (it is the oldest page, already paid for).
   */
  private async fetchHistory(
    brokerId: string,
    api: FxsocketBrokerClient,
    sessionId: string,
    provider: string,
    window: { from: string; to: string },
  ): Promise<unknown[]> {
    if (provider !== 'mtapi') {
      return await api.orderHistory(sessionId, window.from, window.to, FXSOCKET_HISTORY_TIMEOUT_MS)
    }

    const first = await api.orderHistoryPage(sessionId, window.from, window.to, 0, HISTORY_PAGE_SIZE)
    const pagesCount = Math.max(1, Math.floor(first.pagesCount) || 1)
    const start = Math.max(0, pagesCount - MAX_HISTORY_PAGES)
    if (start > 0 && !this.capWarnedBrokers.has(brokerId)) {
      this.capWarnedBrokers.add(brokerId)
      console.warn(
        `[closedTradeClosePriceMonitor] history capped at ${MAX_HISTORY_PAGES}/${pagesCount} pages broker=${brokerId}`,
      )
    }
    const rows: unknown[] = []
    if (start === 0) rows.push(...first.orders)
    const deadline = Date.now() + 90_000
    const newestPage = pagesCount - 1
    for (let page = newestPage; page >= Math.max(1, start); page -= 1) {
      // Always attempt the newest page once, even if the probe burned the
      // budget — the newest rows matter most; check the deadline after it.
      if (page !== newestPage && Date.now() >= deadline) {
        console.warn(
          `[closedTradeClosePriceMonitor] history read deadline hit broker=${brokerId} kept=${rows.length} pages=${page}/${pagesCount}`,
        )
        break
      }
      const next = await api.orderHistoryPage(sessionId, window.from, window.to, page, HISTORY_PAGE_SIZE)
      rows.push(...next.orders)
    }
    return rows
  }
}
