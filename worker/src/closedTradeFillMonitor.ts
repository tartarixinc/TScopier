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
  FillAttempts,
  classifyFillOutcome,
  extractClosedTradeFillsByTicket,
  historyCoverage,
  historyWindow,
  missingFillFilter,
  nextClosedFillCursor,
  planClosedTradeUpdates,
  tallyBrokerBatch,
  type ClosedFillCursor,
  type ClosedTradeFillRow,
} from './closedTradeFill'

type BrokerRow = {
  id: string
  provider?: string | null
  mtapi_session_id?: string | null
  fxsocket_account_id?: string | null
  metaapi_account_id?: string | null
}

// Env names are kept as CLOSED_TRADE_CLOSE_PRICE_* for deployment
// compatibility; the monitor now backfills both close_price and profit.
const ACTIVE_MS = monitorActiveIntervalMs('CLOSED_TRADE_CLOSE_PRICE_TICK_MS', 60_000)
const IDLE_MS = monitorIdleIntervalMs('CLOSED_TRADE_CLOSE_PRICE_IDLE_MS', 300_000)
const BATCH_LIMIT = 50
const HISTORY_PAGE_SIZE = 500
const MAX_HISTORY_PAGES = 40
const LOOKBACK_MS = 365 * 24 * 60 * 60 * 1000
const FXSOCKET_HISTORY_TIMEOUT_MS = 90_000

/**
 * Backfills `trades.close_price` and `trades.profit` from broker order
 * history for closed trades that are missing either value. Every close path
 * in the worker marks the row closed without the fill or the realized
 * profit, and broker history is the source of record here: on MTAPI it is
 * the same OrderHistory endpoint the dashboard's closed list reads, while on
 * FxSocket the dashboard list uses position history and this monitor reads
 * OrderHistory deals — see `resolveMtStoredProfit` for the exact difference.
 * One writer here documents the exit level and P/L for all close paths at
 * once — including rows closed before those columns existed, and rows
 * written before this monitor persisted profit. Runs sharded, idempotent
 * (only rows with a null column are selected, the batch reports that
 * nullity, and each write is guarded on exactly the columns it carries),
 * and only within a 365-day window so permanently unmatched tickets cannot
 * wedge the queue after they age out.
 *
 * Batches walk newest-first but carry a keyset cursor past the oldest row
 * of the previous batch, so permanently unfillable rows (stranded broker,
 * vanished ticket) rotate out of the way instead of pinning the head of
 * the queue; the cursor resets whenever a batch is not full. Rows that
 * still yield nothing after a few attempts are dropped from the batch by
 * the attempt ledger, so the loop stops paying for history reads it cannot
 * turn into progress.
 */
export class ClosedTradeFillMonitor {
  private loop: MonitorLoopHandle | null = null
  private ticking = false
  private platformByUuid: PlatformByFxsocketId = new Map()
  /** Position of the oldest row in the last processed batch (null = start from newest). Compound on (closed_at, id) — see `ClosedFillCursor`. */
  private cursor: ClosedFillCursor | null = null
  /** Rows whose broker history yielded nothing on the last few ticks; they
   * stay selected in the DB but are dropped from the batch so the tick stops
   * re-reading history for them. */
  private readonly attempts = new FillAttempts()
  private exhaustedWarned = false
  private lastPending = 0
  private lastSkipped = 0
  private lastRejections = ''
  private capWarnedBrokers = new Set<string>()

  constructor(private readonly supabase: SupabaseClient) {}

  start() {
    if (this.loop) return
    this.loop = startMonitorLoop({
      name: 'closedTradeFillMonitor',
      supabase: this.supabase,
      activeIntervalMs: ACTIVE_MS,
      idleIntervalMs: IDLE_MS,
      hasWork: sb => this.hasWork(sb),
      tick: () => this.runTick(),
    })
    console.log(`[closedTradeFillMonitor] started active=${ACTIVE_MS}ms idle=${IDLE_MS}ms`)
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
      q
        .or(missingFillFilter())
        .eq('status', 'closed')
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
    const builder = this.supabase
      .from('trades')
      .select('id,broker_account_id,metaapi_order_id,broker_position_ticket,closed_at,close_price,profit')
      .or(missingFillFilter(this.cursor))
      .eq('status', 'closed')
      .not('broker_account_id', 'is', null)
      .not('metaapi_order_id', 'is', null)
      .neq('metaapi_order_id', '')
      .gte('closed_at', since)
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
      console.warn(`[closedTradeFillMonitor] select failed: ${error.message}`)
      return
    }

    const rows = (data ?? []) as ClosedTradeFillRow[]
    if (!rows.length) {
      this.cursor = null
      this.lastPending = 0
      this.lastSkipped = 0
      this.lastRejections = ''
      return
    }

    // Rows that already came back without a fill on several ticks are dropped
    // from the batch (the keyset cursor still walks past them, so they do not
    // pin the head of the queue) — otherwise a stranded ticket keeps costing a
    // broker history read on every active tick until it ages out.
    const todo = this.attempts.pending(rows)
    if (!todo.length) {
      if (!this.exhaustedWarned) {
        console.log(
          `[closedTradeFillMonitor] ${rows.length} selected row(s) already attempted without a fill; skipping history reads (tracked=${this.attempts.tracked})`,
        )
        this.exhaustedWarned = true
      }
      this.cursor = nextClosedFillCursor(rows, BATCH_LIMIT)
      return
    }
    this.exhaustedWarned = false

    const byBroker = new Map<string, ClosedTradeFillRow[]>()
    for (const row of todo) {
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
      console.warn(`[closedTradeFillMonitor] broker load failed: ${brokerErr.message}`)
      return
    }

    const brokerRows = (brokers ?? []) as BrokerRow[]
    const responded = new Set(brokerRows.map(b => b.id))
    const uuids = brokerRows.map(b => brokerSessionId(b)).filter(uuid => uuid.length > 0)
    this.platformByUuid = await loadPlatformByFxsocketId(this.supabase, uuids)

    let filled = 0
    let pending = 0
    let writeErrors = 0
    let skipped = 0
    const rejections: Record<string, number> = {}
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
        const { rows: historyRows, covers } = await this.fetchHistory(
          broker.id,
          api,
          uuid,
          provider,
          window,
        )
        const fills = extractClosedTradeFillsByTicket(historyRows, 'trades', provider, rejections)
        const updateById = new Map(
          planClosedTradeUpdates(tradesForBroker, fills).map(u => [u.id, u] as const),
        )
        let updateErrors = 0
        let cleared = 0
        for (const trade of tradesForBroker) {
          const readable = covers(trade)
          const update = updateById.get(trade.id)
          if (!update) {
            // No fill planned for this trade: one strike only if this read
            // says it could have seen it (not empty, not truncated, trade
            // inside the covered range) — an unproven "nothing found" must
            // not cost the row its P/L for good, and is charged to the
            // much larger uncovered budget instead so it still ages out.
            if (readable) this.attempts.miss(trade.id)
            else this.attempts.uncovered(trade.id)
            continue
          }
          const patch: Record<string, number> = {}
          if (update.close_price !== undefined) patch.close_price = update.close_price
          if (update.profit !== undefined) patch.profit = update.profit
          // The guard names exactly the columns being written (ANDed): a
          // column that is already set is never rewritten, whoever set it.
          let write = this.supabase.from('trades').update(patch).eq('id', trade.id)
          if (update.close_price !== undefined) write = write.is('close_price', null)
          if (update.profit !== undefined) write = write.is('profit', null)
          const { data: updatedRows, error: updateErr } = await write.select('id')
          if (updateErr) {
            console.warn(`[closedTradeFillMonitor] update failed trade=${trade.id}: ${updateErr.message}`)
            updateErrors += 1
            continue
          }
          const landed = (updatedRows ?? []).length > 0
          const outcome = classifyFillOutcome(trade, update, landed, readable)
          if (outcome === 'miss') {
            this.attempts.miss(trade.id)
          } else if (outcome === 'retry') {
            // Nothing written and the read could not have seen the fill:
            // charged to the uncovered budget, never to `missLimit`.
            this.attempts.uncovered(trade.id)
          } else if (outcome === 'hit') {
            // A column was written but the row still needs another —
            // progress, so the row gets a full fresh budget.
            this.attempts.hit(trade.id)
          } else {
            this.attempts.hit(trade.id)
            cleared += 1
          }
        }
        const tally = tallyBrokerBatch(tradesForBroker.length, cleared, updateErrors)
        filled += tally.filled
        pending += tally.pending
        writeErrors += tally.errors
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[closedTradeFillMonitor] history read failed broker=${broker.id}: ${msg}`)
        skipped += tradesForBroker.length
      }
    }
    for (const [brokerId, list] of byBroker) {
      if (!responded.has(brokerId)) skipped += list.length
    }

    // Gate reasons are logged only when their mix changes: MTAPI echoes open
    // positions into OrderHistory, so `no-close-time` is a standing rejection
    // worth seeing but not worth a line per tick — a sudden jump in any
    // reason is the canary for a gate that has started rejecting real fills.
    const rejSummary = Object.entries(rejections)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([reason, count]) => `${reason}:${count}`)
      .join(' ')
    if (
      filled > 0 ||
      pending !== this.lastPending ||
      skipped !== this.lastSkipped ||
      rejSummary !== this.lastRejections
    ) {
      console.log(
        `[closedTradeFillMonitor] fills filled=${filled} pending=${pending} errors=${writeErrors} skipped=${skipped} batch=${rows.length}${
          rejSummary ? ` rejected=${rejSummary}` : ''
        }`,
      )
    }
    this.lastPending = pending
    this.lastSkipped = skipped
    this.lastRejections = rejSummary

    this.cursor = nextClosedFillCursor(rows, BATCH_LIMIT)
  }

  /**
   * Broker history covering the batch window, plus `covers(trade)`: whether
   * this read can PROVE anything about a given trade. The monitor may only
   * count a miss (`FillAttempts`) for a trade the read covers — every other
   * case leaves the row for a later tick, because a wrongly counted miss
   * drops the row after `missLimit` ticks and its P/L is then never written.
   * `covers` is false when the read returned nothing (a bridge answering
   * `200 []` while its session is still syncing proves nothing about any
   * individual trade), when a deadline cut the walk, when the 40-page cap
   * left the trade's close time in the unread region, or when no row
   * established a usable boundary. FxSocket returns the whole list in one
   * call (with the edge's 90s budget, not the client's 30s default — the
   * window can span a year); MTAPI is read through the paginated endpoint,
   * pages walked NEWEST-first (same as the edge's `orderHistory` pagination)
   * so a deadline cut keeps the most recent rows — the ones the newest-first
   * batch is actually working on — and page 0's probe rows are reused when
   * page 0 is inside the window (it is the oldest page, already paid for).
   */
  private async fetchHistory(
    brokerId: string,
    api: FxsocketBrokerClient,
    sessionId: string,
    provider: string,
    window: { from: string; to: string },
  ): Promise<{ rows: unknown[]; covers: (trade: ClosedTradeFillRow) => boolean }> {
    if (provider !== 'mtapi') {
      const rows = await api.orderHistory(sessionId, window.from, window.to, FXSOCKET_HISTORY_TIMEOUT_MS)
      // Single call for the whole window — only an empty response (a bridge
      // syncing) is refused a verdict, and `historyCoverage` handles that.
      return { rows, covers: historyCoverage(rows) }
    }

    const first = await api.orderHistoryPage(sessionId, window.from, window.to, 0, HISTORY_PAGE_SIZE)
    const pagesCount = Math.max(1, Math.floor(first.pagesCount) || 1)
    const start = Math.max(0, pagesCount - MAX_HISTORY_PAGES)
    if (start > 0 && !this.capWarnedBrokers.has(brokerId)) {
      this.capWarnedBrokers.add(brokerId)
      console.warn(
        `[closedTradeFillMonitor] history capped at ${MAX_HISTORY_PAGES}/${pagesCount} pages broker=${brokerId}`,
      )
    }
    const rows: unknown[] = []
    if (start === 0) rows.push(...first.orders)
    const deadline = Date.now() + 90_000
    const newestPage = pagesCount - 1
    let deadlineHit = false
    for (let page = newestPage; page >= Math.max(1, start); page -= 1) {
      // Always attempt the newest page once, even if the probe burned the
      // budget — the newest rows matter most; check the deadline after it.
      if (page !== newestPage && Date.now() >= deadline) {
        console.warn(
          `[closedTradeFillMonitor] history read deadline hit broker=${brokerId} kept=${rows.length} pages=${page}/${pagesCount}`,
        )
        deadlineHit = true
        break
      }
      const next = await api.orderHistoryPage(sessionId, window.from, window.to, page, HISTORY_PAGE_SIZE)
      rows.push(...next.orders)
    }
    return {
      rows,
      covers: historyCoverage(rows, { deadlineHit, pageCapEngaged: start > 0 }),
    }
  }
}
